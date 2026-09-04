/**
 * but-auto-commit.ts — pi extension
 *
 * Mimics jj native workflow: auto-commit at turn_end when files are mutated.
 * Uses GitButler CLI (`but`) for commits + oplog snapshots.
 * Replaces pi-rewind's temporary git refs with proper commits.
 *
 * After each commit, auto-pushes, creates a PR via `but pr`, and immediately
 * merges via `gh pr merge`. Requires `but config forge auth` for PR creation
 * and `gh auth` for merge (gracefully degrades to push-only if unavailable).
 *
 * Supports cross-repo commits: tracks actual file paths and commits to
 * each involved but workspace separately.
 *
 * Commit message format (jj-forklift style):
 *   [SLOP(model-id)] <conventional-commit-type>: <prompt excerpt>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname, basename } from "node:path";
import { copyFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";

const execFileAsync = promisify(execFile);

// ============================================================================
// Constants
// ============================================================================

/** Tools that modify the filesystem and warrant a commit */
const MUTATING_TOOLS = new Set(["write", "edit", "ast_edit", "bash"]);

const STATUS_KEY = "but-auto-commit";

const BACKUP_DIR = resolve(process.env.HOME || "/tmp", ".omp/agent/file-backups");

/**
 * Extract absolute file paths mutated by a tool call.
 * Handles both pi-style (`path` field) and omp-style tool schemas:
 *  - write: { path }
 *  - edit (omp hashline): paths live in `[PATH#TAG]` section headers inside `input`
 *  - ast_edit: { paths: string[] } — glob suffixes stripped to their static prefix
 *  - bash: { cwd? } → synthetic marker used only to locate the repo root
 */
export function extractMutatedPaths(
  toolName: string,
  input: unknown,
  sessionCwd: string,
): string[] {
  if (!input || typeof input !== "object") return [];
  const home = process.env.HOME || "";
  const expand = (p: string) => (p.startsWith("~/") ? resolve(home, p.slice(2)) : p);
  const out: string[] = [];

  if ("path" in input && typeof input.path === "string") {
    out.push(resolve(sessionCwd, expand(input.path)));
  }

  if (toolName === "edit" && "input" in input && typeof input.input === "string") {
    for (const m of input.input.matchAll(/^\[([^\]\n#]+)#[0-9A-Za-z]{4}\]\s*$/gm)) {
      out.push(resolve(sessionCwd, expand(m[1])));
    }
  }

  if (toolName === "ast_edit" && "paths" in input && Array.isArray(input.paths)) {
    for (const p of input.paths) {
      if (typeof p !== "string") continue;
      const staticPrefix = p.split(/[*?[{]/, 1)[0];
      if (staticPrefix) out.push(resolve(sessionCwd, expand(staticPrefix)));
    }
  }

  if (toolName === "bash" && "cwd" in input && typeof input.cwd === "string") {
    // Marker path: findRepoRoot() dirnames it, so only the directory matters
    out.push(resolve(sessionCwd, expand(input.cwd), "__cwd__"));
  }

  return out;
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

async function butExec(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("but", args, { cwd, timeout: 15_000 });
    return stdout.trim();
  } catch (err: any) {
    throw new Error(`but ${args[0]} failed: ${err.stderr || err.message}`);
  }
}

/** Find git repo root for a file path. Returns null if not in a git repo. */
async function findRepoRoot(filePath: string): Promise<string | null> {
  const dir = dirname(resolve(filePath));
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Backup a file before mutation if it's not in any git repo */
async function backupFileIfNeeded(absPath: string): Promise<void> {
  // Check if file exists first (new files don't need backup)
  try {
    await access(absPath, constants.R_OK);
  } catch {
    return; // File doesn't exist yet, nothing to back up
  }

  // Check if it's in a git repo
  const root = await findRepoRoot(absPath);
  if (root) return; // In a repo, but-auto-commit or git handles it

  // Not in any repo — backup before modification
  await mkdir(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = basename(absPath);
  const backupPath = resolve(BACKUP_DIR, `${ts}_${name}`);
  try {
    await copyFile(absPath, backupPath);
  } catch {
    // Non-fatal: file might have been deleted between check and copy
  }
}

/** Check if a directory is a but workspace */
async function isButWorkspace(cwd: string): Promise<boolean> {
  try {
    await butExec(["status", "--format", "json"], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if gh CLI is authenticated (GH_TOKEN via sops env, or stored auth).
 * Replaces the GitButler forge-auth check: but's forge token lives in the
 * machine-local keyring (d-bus secret-service) and never syncs across hosts.
 */
async function hasForgeAuth(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("gh", ["auth", "status"], { cwd, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Push a branch, returns true on success */
async function pushBranch(cwd: string): Promise<boolean> {
  try {
    await butExec(["push"], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Create PR via gh and immediately merge it. Returns true on success. */
async function ensurePR(branchName: string, cwd: string): Promise<boolean> {
  try {
    // gh-first: no GitButler forge auth / keyring dependency.
    // --fill uses commit messages; fails harmlessly if the PR already exists.
    await execFileAsync("gh", ["pr", "create", "--fill", "--head", branchName], {
      cwd,
      timeout: 30_000,
    }).catch(() => {});
    // but pr auto-merge requires GitHub Pro; gh merge works on free plan
    await execFileAsync("gh", ["pr", "merge", branchName, "--merge", "--delete-branch"], {
      cwd,
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

interface ButStatus {
  uncommittedChanges: Array<{ cliId: string; filePath: string; changeType: string }>;
  stacks: Array<{
    cliId: string;
    branches: Array<{ cliId: string; name: string }>;
  }>;
}

async function getButStatus(cwd: string): Promise<ButStatus | null> {
  try {
    const raw = await butExec(["status", "--format", "json"], cwd);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function inferCommitType(tools: string[]): string {
  if (tools.some((t) => t.startsWith("write"))) return "feat";
  if (tools.some((t) => t.startsWith("edit"))) return "refactor";
  return "chore";
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // ── State ────────────────────────────────────────────────────────────────
  let sessionCwd = "";
  let sessionCwdIsBut = false;
  let currentPrompt = "";
  let currentTurnIndex = 0;
  let turnHadMutations = false;
  let turnToolDescriptions: string[] = [];
  /** Absolute paths of files mutated this turn */
  let turnMutatedPaths: string[] = [];
  let modelId = "";
  let commitCount = 0;
  let pending: Promise<void> | null = null;
  /** Cache: repo root → is but workspace */
  const workspaceCache = new Map<string, boolean>();
  /** Cache: repo root → forge auth available */
  const forgeCache = new Map<string, boolean>();
  /** Track which repos have had PRs created this session (branch → true) */
  const prCreated = new Map<string, boolean>();

  // ── Session lifecycle ────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    sessionCwdIsBut = await isButWorkspace(sessionCwd);
    workspaceCache.clear();
    if (sessionCwdIsBut) workspaceCache.set(sessionCwd, true);
    commitCount = 0;
    if (ctx.hasUI) updateStatus(ctx);
  });

  // ── Capture prompt for commit labels ─────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    currentPrompt = truncate(String(event.prompt || ""), 40);
    turnToolDescriptions = [];
    turnMutatedPaths = [];
    turnHadMutations = false;
    if (ctx.model) {
      modelId = ctx.model.id || "";
    }
  });

  // ── Track turn index ─────────────────────────────────────────────────────

  pi.on("turn_start", async (event, _ctx) => {
    currentTurnIndex = event.turnIndex;
  });

  // ── Track mutating tools ─────────────────────────────────────────────────

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!MUTATING_TOOLS.has(event.toolName)) return;
    turnHadMutations = true;

    const paths = extractMutatedPaths(event.toolName, event.input, sessionCwd);
    turnMutatedPaths.push(...paths);

    const desc = paths.length > 0 ? `${event.toolName}:${basename(paths[0])}` : event.toolName;
    turnToolDescriptions.push(desc);
  });

  // ── Pre-mutation backup for non-repo files ───────────────────────────────

  pi.on("tool_call", async (event, _ctx) => {
    if (!MUTATING_TOOLS.has(event.toolName)) return;
    for (const absPath of extractMutatedPaths(event.toolName, event.input, sessionCwd)) {
      await backupFileIfNeeded(absPath);
    }
  });

  // ── Auto-commit at turn_end ──────────────────────────────────────────────

  pi.on("turn_end", async (_event, ctx) => {
    if (!turnHadMutations) return;

    if (pending) await pending;

    pending = (async () => {
      try {
        // Group mutated paths by repo root
        const repoFiles = new Map<string, string[]>();

        for (const absPath of turnMutatedPaths) {
          const root = await findRepoRoot(absPath);
          if (!root) continue;

          // Check if this repo is a but workspace (cached)
          if (!workspaceCache.has(root)) {
            workspaceCache.set(root, await isButWorkspace(root));
          }
          if (!workspaceCache.get(root)) continue;

          if (!repoFiles.has(root)) repoFiles.set(root, []);
          repoFiles.get(root)!.push(absPath);
        }

        // If no paths tracked (bash without path), fall back to session cwd
        if (repoFiles.size === 0 && sessionCwdIsBut) {
          repoFiles.set(sessionCwd, []);
        }

        // Commit each workspace
        for (const [repoRoot, files] of repoFiles) {
          const status = await getButStatus(repoRoot);
          if (!status || status.uncommittedChanges.length === 0) continue;

          // Prefer existing branch on the top stack. If no branch exists yet (fresh
          // workspace), synthesize a session-scoped name and let `-c` create it.
          // GitButler skill §115-118 explicitly guarantees: "Creating a new branch
          // with `-c` does not require a prior `but branch` or `but status -fv`".
          const existingBranch = status.stacks?.[0]?.branches?.[0];
          const branchName =
            existingBranch?.name ?? `omp/session-${Date.now().toString(36)}`;
          const branchRef = existingBranch?.cliId ?? branchName;

          // Scope the commit to this turn's files using GitButler's official fast path:
          // `but commit <branch> -c -m "..." --changes <id>,<id>` — atomic stage+commit
          // in one command. `-c` = create branch if missing (no-op if it exists),
          // avoids workspace tree conflicts on renames, and matches the pattern
          // GitButler's own skill teaches to coding agents.
          const turnFiles = new Set(files);
          const toCommit = status.uncommittedChanges.filter((c) =>
            turnFiles.has(resolve(repoRoot, c.filePath)),
          );

          // Build commit message
          const slopTag = `[SLOP(${modelId})]`;
          const commitType = inferCommitType(turnToolDescriptions);
          const promptLabel = currentPrompt || `turn ${currentTurnIndex}`;
          const message = `${slopTag} ${commitType}: ${promptLabel}`;

          if (toCommit.length > 0) {
            const changeIds = toCommit.map((c) => c.cliId).join(",");
            await butExec(
              ["commit", branchRef, "-c", "-m", message, "--changes", changeIds],
              repoRoot,
            );
          } else if (files.length === 0) {
            // Legacy fallback: bash-only turn with no attributable paths — commit all
            await butExec(["commit", branchRef, "-c", "-m", message], repoRoot);
          } else {
            // This turn's tracked files produced no uncommitted changes here
            continue;
          }
          commitCount++;

          // Auto-push + PR + auto-merge (non-blocking on failure)
          const pushed = await pushBranch(repoRoot);
          if (pushed) {
            // Check forge auth (cached per repo)
            if (!forgeCache.has(repoRoot)) {
              forgeCache.set(repoRoot, await hasForgeAuth(repoRoot));
            }
            if (forgeCache.get(repoRoot)) {
              const branchKey = `${repoRoot}:${branchName}`;
              // Create PR + auto-merge (idempotent: subsequent pushes just update the PR)
              if (!prCreated.get(branchKey)) {
                const ok = await ensurePR(branchName, repoRoot);
                if (ok) prCreated.set(branchKey, true);
              }
            }
          }

          // Oplog snapshot (non-critical)
          const snapshotLabel = `turn ${currentTurnIndex}: ${promptLabel}`;
          await butExec(["oplog", "snapshot", "-m", snapshotLabel], repoRoot).catch(() => {});
        }

        if (ctx.hasUI) updateStatus(ctx);
      } catch (err: any) {
        if (ctx.hasUI) {
          ctx.ui.notify(`but auto-commit failed: ${err.message}`, "warning");
        }
      }
    })();

    await pending;
    pending = null;

    turnToolDescriptions = [];
    turnMutatedPaths = [];
    turnHadMutations = false;
  });

  // ── /but-undo command ─────────────────────────────────────────────────────

  pi.registerCommand("but-undo", {
    description: "Undo the last but commit (but undo)",
    handler: async (_args, ctx) => {
      if (!sessionCwdIsBut) {
        ctx.ui.notify("Not a GitButler workspace.", "warning");
        return;
      }
      try {
        await butExec(["undo"], sessionCwd);
        commitCount = Math.max(0, commitCount - 1);
        ctx.ui.notify("Reverted last commit (but undo).", "info");
        if (ctx.hasUI) updateStatus(ctx);
      } catch (err: any) {
        ctx.ui.notify(`but undo failed: ${err.message}`, "error");
      }
    },
  });

  // ── Fork / Tree navigate: interactive only when user-initiated ────────────

  pi.on("session_before_fork", async (_event, ctx) => {
    if (!sessionCwdIsBut) return undefined;
    await butExec(["oplog", "snapshot", "-m", "before-fork"], sessionCwd).catch(() => {});

    // Only prompt when user-initiated (agent is idle), not during pi-context/boomerang
    if (!ctx.isIdle()) return undefined;

    const choice = await (ctx as any).ui.select("File restore on fork:", [
      "Keep current files",
      "Restore all (files + conversation)",
      "Code only (restore files, keep conversation)",
      "Cancel",
    ]);

    if (!choice || choice === "Cancel") return { cancel: true };
    if (choice === "Keep current files") return undefined;

    if (choice === "Restore all (files + conversation)") {
      for (let i = 0; i < commitCount; i++) {
        try { await butExec(["undo"], sessionCwd); } catch { break; }
      }
      commitCount = 0;
      if ((ctx as any).hasUI) updateStatus(ctx);
      (ctx as any).ui.notify("Files + conversation restored.", "info");
      return undefined;
    }

    if (choice === "Code only (restore files, keep conversation)") {
      for (let i = 0; i < commitCount; i++) {
        try { await butExec(["undo"], sessionCwd); } catch { break; }
      }
      commitCount = 0;
      if ((ctx as any).hasUI) updateStatus(ctx);
      (ctx as any).ui.notify("Files restored, conversation unchanged.", "info");
      return { cancel: true };
    }

    return undefined;
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!sessionCwdIsBut) return undefined;
    await butExec(["oplog", "snapshot", "-m", "before-tree-navigate"], sessionCwd).catch(() => {});

    // Only prompt when user-initiated (agent is idle), not during pi-context/boomerang
    if (!ctx.isIdle()) return undefined;

    const choice = await (ctx as any).ui.select("File restore on tree navigate:", [
      "Keep current files",
      "Restore all (files + conversation)",
      "Code only (restore files, keep conversation)",
      "Cancel",
    ]);

    if (!choice || choice === "Cancel") return { cancel: true };
    if (choice === "Keep current files") return undefined;

    // Find the oplog snapshot closest to (but before) the target entry's timestamp
    const targetId = (event as any).preparation?.targetId;
    let restored = false;
    if (targetId) {
      const targetEntry = (ctx as any).sessionManager?.getEntry?.(targetId);
      const targetTs = targetEntry?.timestamp
        ? new Date(targetEntry.timestamp).getTime()
        : null;

      if (targetTs) {
        try {
          const raw = await butExec(["oplog", "list", "--snapshot", "--format", "json"], sessionCwd);
          const snapshots = JSON.parse(raw) as Array<{ id: string; createdAt: number }>;
          // Find latest snapshot before or at target timestamp
          const candidates = snapshots
            .filter((s) => s.createdAt <= targetTs)
            .sort((a, b) => b.createdAt - a.createdAt);
          if (candidates.length > 0) {
            await butExec(["oplog", "restore", candidates[0].id], sessionCwd);
            restored = true;
          }
        } catch {
          // Fall back to undo-all below
        }
      }
    }

    // Fallback: undo all session commits
    if (!restored) {
      for (let i = 0; i < commitCount; i++) {
        try { await butExec(["undo"], sessionCwd); } catch { break; }
      }
    }
    commitCount = 0;
    if ((ctx as any).hasUI) updateStatus(ctx);

    if (choice === "Restore all (files + conversation)") {
      (ctx as any).ui.notify("Files + conversation restored.", "info");
      return undefined; // Let tree navigation proceed
    }

    // Code only: restore files, cancel navigation (keep conversation)
    (ctx as any).ui.notify("Files restored, conversation unchanged.", "info");
    return { cancel: true };
  });

  // ── Status display ───────────────────────────────────────────────────────

  function updateStatus(ctx: any) {
    if (!sessionCwdIsBut && commitCount === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(
      STATUS_KEY,
      commitCount > 0 ? `but: ${commitCount} commit${commitCount === 1 ? "" : "s"}` : "but: idle",
    );
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (pending) await pending;
  });
}
