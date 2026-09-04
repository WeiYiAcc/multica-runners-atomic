/**
 * Role extension for pi-coding-agent
 *
 * Manages system-prompt-based roles from ~/.pi/agent/roles/*.md
 * Compatible with aichat's role convention (-r, --role, --list-roles).
 *
 * Commands:
 *   /role            → list available roles
 *   /role <name>     → activate a role
 *   /role clear      → deactivate current role
 *   /role reload     → reload current role from disk
 *   /role edit [name] → open a role in multi-line editor
 *   /role delete <name> → delete a role file
 */

import type { ExtensionAPI, BeforeAgentStartEventResult } from "@mariozechner/pi-coding-agent"
import { readFile, readdir, writeFile, mkdir, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const ROLES_DIR = join(homedir(), ".omp", "agent", "roles")
const CONFIG_PATH = join(homedir(), ".omp", "agent", "extensions", "role.json")
const CUSTOM_TYPE = "role-state"

interface RoleState {
  role: string | null
  content: string | null
}

interface RoleConfig {
  defaultRole?: string
}

/** Load role config (defaultRole etc.) */
function loadRoleConfig(): RoleConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(require("node:fs").readFileSync(CONFIG_PATH, "utf-8")) as RoleConfig
    }
  } catch {}
  return {}
}

export default function (pi: ExtensionAPI) {
  let activeRole: string | null = null
  let activeContent: string | null = null
  let cachedRoles: string[] = []

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Load all available role names from the roles directory */
  async function loadRoleList(): Promise<string[]> {
    if (!existsSync(ROLES_DIR)) return []
    try {
      const files = await readdir(ROLES_DIR)
      return files
        .filter(f => f.endsWith(".md"))
        .map(f => f.replace(/\.md$/, ""))
        .sort()
    } catch {
      return []
    }
  }

  /** Read a role file by name */
  async function readRole(name: string): Promise<string | null> {
    const rolePath = join(ROLES_DIR, `${name}.md`)
    if (!existsSync(rolePath)) return null
    try {
      return await readFile(rolePath, "utf-8")
    } catch {
      return null
    }
  }

  /** Update status bar to show active role */
  function setStatus(ctx: { ui: { setStatus(k: string, v: string | undefined): void } }) {
    ctx.ui.setStatus("role", activeRole ? `👤 ${activeRole}` : undefined)
  }

  // ── Session state persistence ──────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Refresh cached role list on session start
    cachedRoles = await loadRoleList()

    // Restore active role from session entries
    // Walk backward through entries to find the most recent role-state entry
    const entries = ctx.sessionManager.getEntries()
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.type === "custom" && "customType" in entry && entry.customType === CUSTOM_TYPE) {
        const data = entry.data as RoleState | undefined
        if (data?.role) {
          activeRole = data.role
          activeContent = data.content ?? null
          break
        }
      }
    }

    // If no role active, check for defaultRole in config
    if (!activeRole) {
      const config = loadRoleConfig()
      if (config.defaultRole) {
        const content = await readRole(config.defaultRole)
        if (content) {
          activeRole = config.defaultRole
          activeContent = content
          pi.appendEntry(CUSTOM_TYPE, { role: activeRole, content } as RoleState)
        }
      }
    }

    setStatus(ctx)
  })

  // ── Inject role into system prompt before each LLM call ─────────────────

  pi.on("before_agent_start", async (event, _ctx): Promise<BeforeAgentStartEventResult | void> => {
    if (!activeRole || !activeContent) return

    // Append role content to system prompt with clear separator
    return {
      systemPrompt: event.systemPrompt + "\n\n---\n\n" + activeContent,
    }
  })

  // ── Command: /role ──────────────────────────────────────────────────────

  pi.registerCommand("role", {
    description: "Manage roles (system prompts): /role [list|clear|reload|edit|delete|<name>]",

    // Tab completion from cached role list
    getArgumentCompletions: (prefix) =>
      cachedRoles
        .filter(r => r.startsWith(prefix))
        .map(r => ({ label: r, value: r })),

    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? "list"

      // ── list ────────────────────────────────────────────────────────────────
      if (sub === "list") {
        cachedRoles = await loadRoleList()
        if (cachedRoles.length === 0) {
          ctx.ui.notify(
            `No roles found.\n\nCreate .md files in:\n  ${ROLES_DIR}\n\nExample:\n  /role edit myrole`,
            "info",
          )
          return
        }

        const lines = cachedRoles.map(r => {
          const marker = r === activeRole ? "  ◀ ACTIVE" : ""
          return `  • ${r}${marker}`
        })

        ctx.ui.notify(
          [`Roles (${cachedRoles.length}):`, "", ...lines, "", `Use: /role <name>  to activate`].join("\n"),
          "info",
        )
        return
      }

      // ── clear ───────────────────────────────────────────────────────────────
      if (sub === "clear") {
        const prev = activeRole
        activeRole = null
        activeContent = null
        pi.appendEntry(CUSTOM_TYPE, { role: null, content: null } as RoleState)
        setStatus(ctx)
        ctx.ui.notify(prev ? `✓ Role '${prev}' deactivated` : "No active role", "info")
        return
      }

      // ── reload ──────────────────────────────────────────────────────────────
      if (sub === "reload") {
        if (!activeRole) {
          ctx.ui.notify("No active role to reload", "error")
          return
        }

        const content = await readRole(activeRole)
        if (!content) {
          ctx.ui.notify(`Role file not found: ${activeRole}.md`, "error")
          return
        }

        activeContent = content
        pi.appendEntry(CUSTOM_TYPE, { role: activeRole, content } as RoleState)
        ctx.ui.notify(`✓ Role '${activeRole}' reloaded from disk`, "success")
        return
      }

      // ── edit ────────────────────────────────────────────────────────────────
      if (sub === "edit") {
        const target = parts[1] ?? activeRole
        if (!target) {
          ctx.ui.notify("Usage: /role edit <name>  (or activate a role first)", "error")
          return
        }

        const existing = (await readRole(target)) ?? ""
        const result = await ctx.ui.editor(`Edit role: ${target}`, existing)
        if (result === undefined) {
          ctx.ui.notify("Cancelled", "info")
          return
        }

        // Ensure roles directory exists
        try {
          await mkdir(ROLES_DIR, { recursive: true })
          await writeFile(join(ROLES_DIR, `${target}.md`), result, "utf-8")
        } catch (err) {
          ctx.ui.notify(`Failed to save role: ${err instanceof Error ? err.message : "Unknown error"}`, "error")
          return
        }

        // Reload the roles cache
        cachedRoles = await loadRoleList()

        // If editing the active role, update in memory too
        if (target === activeRole) {
          activeContent = result
          pi.appendEntry(CUSTOM_TYPE, { role: activeRole, content: result } as RoleState)
        }

        ctx.ui.notify(`✓ Role '${target}' saved to disk`, "success")
        return
      }

      // ── delete ──────────────────────────────────────────────────────────────
      if (sub === "delete") {
        const target = parts[1]
        if (!target) {
          ctx.ui.notify("Usage: /role delete <name>", "error")
          return
        }

        const rolePath = join(ROLES_DIR, `${target}.md`)
        if (!existsSync(rolePath)) {
          ctx.ui.notify(`Role '${target}' not found`, "error")
          return
        }

        try {
          await unlink(rolePath)
        } catch (err) {
          ctx.ui.notify(`Failed to delete: ${err instanceof Error ? err.message : "Unknown error"}`, "error")
          return
        }

        // If deleting the active role, deactivate it
        if (target === activeRole) {
          activeRole = null
          activeContent = null
          pi.appendEntry(CUSTOM_TYPE, { role: null, content: null } as RoleState)
          setStatus(ctx)
        }

        cachedRoles = await loadRoleList()
        ctx.ui.notify(`✓ Role '${target}' deleted`, "success")
        return
      }

      // ── activate <name> ─────────────────────────────────────────────────────
      const name = sub
      const content = await readRole(name)

      if (content === null) {
        cachedRoles = await loadRoleList()
        if (cachedRoles.length > 0) {
          ctx.ui.notify(
            `Role '${name}' not found.\n\nAvailable roles:\n  ${cachedRoles.join("\n  ")}`,
            "error",
          )
        } else {
          ctx.ui.notify(
            `Role '${name}' not found.\n\nCreate a role:\n  /role edit ${name}`,
            "error",
          )
        }
        return
      }

      activeRole = name
      activeContent = content
      pi.appendEntry(CUSTOM_TYPE, { role: name, content } as RoleState)
      setStatus(ctx)
      ctx.ui.notify(`✓ Role '${name}' activated`, "success")
    },
  })
}
