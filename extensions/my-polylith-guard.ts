/**
 * my-polylith-guard.ts — Polylith architecture guard for Python and TypeScript
 *
 * Intercepts write/edit tool results and runs ast-grep to check if the written
 * file violates Polylith rules. If a violation is detected, injects a warning
 * into the next turn's system prompt so the AI self-corrects.
 *
 * Rules enforced (mirrors Clojure poly check errors):
 *   Error 101: Must import via interface, not internal modules (core/impl/utils)
 *   base → base: bases must not import other bases
 *   component → base: components must not import bases
 *   base deep import: bases must use index.ts to reference components
 *
 * Tools:
 *   - ast-grep: AST-based lint (TypeScript + Python)
 *     TypeScript: .ast-grep/sgconfig.yml in ariadne-fact
 *     Python:     .ast-grep/sgconfig.yml in subsidy-2026 / transport-subsidy-2026
 *   - poly check: brick dependency completeness (Python workspaces)
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
  ToolResultEventResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// ── Violation types ──────────────────────────────────────────────────────────

interface Violation {
  file: string;
  rule: string;
  detail: string;
}

// ── Pending violations (cleared after injection) ─────────────────────────────

let pendingViolations: Violation[] = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPolylithFile(filePath: string): boolean {
  return /\.(py|ts|tsx|clj|cljs|cljc)$/.test(filePath);
}

function isInBases(filePath: string): boolean {
  return /[/\\]bases[/\\]/.test(filePath);
}

function isInComponents(filePath: string): boolean {
  return /[/\\]components[/\\]/.test(filePath);
}

function isInLib(filePath: string): boolean {
  return /[/\\]lib[/\\]/.test(filePath);
}

/**
 * Find the nearest .ast-grep/sgconfig.yml walking up from filePath.
 */
function findAstGrepConfig(filePath: string): string | null {
  let dir = dirname(filePath);
  for (let i = 0; i < 8; i++) {
    const cfg = join(dir, ".ast-grep", "sgconfig.yml");
    if (existsSync(cfg)) return cfg;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Run ast-grep scan on a single file using the nearest sgconfig.yml.
 * Returns violations parsed from ast-grep output.
 */
function runAstGrep(filePath: string): Violation[] {
  const config = findAstGrepConfig(filePath);
  if (!config) return [];

  try {
    execSync(
      `ast-grep scan --config "${config}" "${filePath}" 2>/dev/null`,
      { encoding: "utf8", timeout: 10000 }
    );
    return []; // exit 0 = no violations
  } catch (err: any) {
    // exit 1 = violations found, parse stdout
    const output: string = err.stdout ?? "";
    const violations: Violation[] = [];

    // Parse ast-grep output: "error[rule-id]: message\n  ┌─ file:line:col"
    const ruleRe = /error\[([^\]]+)\]:\s*(.+)/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(output)) !== null) {
      violations.push({
        file: filePath,
        rule: m[1].trim(),
        detail: m[2].trim(),
      });
    }
    return violations;
  }
}

/**
 * Check that a component directory (lib/<name>/ or components/<name>/src/)
 * has an index.ts (TS) or interface.py (Python) file.
 * Only triggers when writing a file inside that component.
 */
function checkMissingIndex(filePath: string): Violation[] {
  const dir = dirname(filePath);

  // TypeScript: lib/<component>/ must have index.ts
  if (isInLib(filePath) && filePath.endsWith(".ts")) {
    // Walk up to the component root (first dir under lib/)
    const libMatch = filePath.match(/[/\\]lib[/\\]([^/\\]+)/);
    if (libMatch) {
      const componentDir = filePath.substring(0, filePath.indexOf(libMatch[0]) + libMatch[0].length);
      const indexPath = join(componentDir, "index.ts");
      if (!existsSync(indexPath)) {
        return [{
          file: filePath,
          rule: "polylith-missing-index-ts",
          detail: `component 目录 ${componentDir} 缺少 index.ts interface 文件`,
        }];
      }
    }
  }

  // Python: components/<name>/src/<ns>/<name>/interface.py must exist
  if (isInComponents(filePath) && filePath.endsWith(".py")) {
    const compMatch = filePath.match(/[/\\]components[/\\]([^/\\]+)[/\\]src[/\\]/);
    if (compMatch) {
      const srcDir = filePath.substring(0, filePath.indexOf(compMatch[0]) + compMatch[0].length);
      // Find the interface.py by walking the namespace dirs
      const interfaceGlob = join(srcDir, "**", "interface.py");
      try {
        const result = execSync(`find "${srcDir}" -name "interface.py" -maxdepth 3 2>/dev/null`, {
          encoding: "utf8",
          timeout: 3000,
        }).trim();
        if (!result) {
          return [{
            file: filePath,
            rule: "polylith-missing-interface-py",
            detail: `component ${compMatch[1]} 缺少 interface.py`,
          }];
        }
      } catch {
        // find failed, skip
      }
    }
  }

  return [];
}

/**
 * Run poly check in the nearest Python workspace (has workspace.toml).
 * Returns violations if any bricks are missing.
 */
function runPolyCheck(filePath: string): Violation[] {
  if (!filePath.endsWith(".py")) return [];

  let dir = dirname(filePath);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "workspace.toml"))) {
      try {
        execSync(`cd "${dir}" && uv run poly check 2>&1`, {
          encoding: "utf8",
          timeout: 15000,
        });
        return [];
      } catch (err: any) {
        const output: string = err.stdout ?? err.stderr ?? "";
        if (output.includes("Cannot locate")) {
          return [{
            file: filePath,
            rule: "poly-check-missing-brick",
            detail: output.trim(),
          }];
        }
        return [];
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

// ── Main check dispatcher ────────────────────────────────────────────────────

function checkFile(filePath: string): Violation[] {
  if (!isPolylithFile(filePath)) return [];
  if (!isInBases(filePath) && !isInComponents(filePath) && !isInLib(filePath)) return [];

  const violations: Violation[] = [];
  violations.push(...runAstGrep(filePath));
  violations.push(...runPolyCheck(filePath));
  violations.push(...checkMissingIndex(filePath));
  return violations;
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── workspace.json 一致性检查（session 开始时） ──────────────────────────
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> => {
    // 先做 workspace.json 一致性检查
    const workspaceJsonWarning = checkWorkspaceJsonConsistency();

    // 再做 pending violations 注入
    let warning = "";

    if (workspaceJsonWarning) {
      warning += workspaceJsonWarning;
    }

    if (pendingViolations.length > 0) {
      const viols = pendingViolations.splice(0);
      const lines = viols.map(v =>
        `- **${v.rule}** in \`${v.file}\`\n  ${v.detail}`
      );

      warning += [
        "\n\n---",
        "## ⚠️ Polylith Architecture Violations Detected",
        "",
        "The following violations were found in files you just wrote:",
        "",
        ...lines,
        "",
        "**Fix required before continuing:**",
        "- `bases/` (TS) and `bases/` (Python) must only contain CLI glue — call components, no business logic",
        "- All business logic must live in `components/` (Python) or `lib/` (TypeScript)",
        "- Import via `interface.py` (Python) or `index.ts` (TypeScript), never internal modules",
        "- `bases/` must not import other `bases/`",
        "- `components/` must not import `bases/`",
        "",
        "Run `ast-grep scan --config .ast-grep/sgconfig.yml` to verify fixes.",
        "---",
      ].join("\n");
    }

    if (warning) {
      return { systemPrompt: event.systemPrompt + warning };
    }
  });

  // Intercept write/edit tool results
  pi.on("tool_result", async (event: ToolResultEvent, _ctx: ExtensionContext): Promise<ToolResultEventResult | void> => {
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const filePath: string | undefined = (event.input as any).path;
    if (!filePath) return;

    const violations = checkFile(filePath);
    if (violations.length > 0) {
      pendingViolations.push(...violations);
    }
  });
}

// ── workspace.json 一致性检查 ────────────────────────────────────────────────

function checkWorkspaceJsonConsistency(): string | null {
  const cwd = process.cwd();
  const wsPath = join(cwd, "workspace.json");
  if (!existsSync(wsPath)) return null;

  try {
    const ws = JSON.parse(require("fs").readFileSync(wsPath, "utf8"));
    const missing: string[] = [];

    // 检查 components
    if (ws.components && typeof ws.components === "object") {
      for (const [name, filePath] of Object.entries(ws.components)) {
        const fullPath = join(cwd, filePath as string);
        if (!existsSync(fullPath)) {
          missing.push(`component "${name}" → ${filePath}`);
        }
      }
    }

    // 检查 bases
    if (Array.isArray(ws.bases)) {
      for (const base of ws.bases) {
        if (base.path) {
          const fullPath = join(cwd, base.path);
          if (!existsSync(fullPath)) {
            missing.push(`base "${base.name}" → ${base.path}`);
          }
        }
      }
    }

    if (missing.length === 0) return null;

    return [
      "\n\n---",
      "## ⚠️ workspace.json 引用了不存在的文件",
      "",
      "以下 workspace.json 条目指向的文件不存在：",
      "",
      ...missing.map(m => `- ${m}`),
      "",
      "**请立即修复**：从 workspace.json 中移除这些条目，或恢复对应文件。",
      "---",
    ].join("\n");
  } catch {
    return null;
  }
}
