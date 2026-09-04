/**
 * env-loader — 从 ~/.config/pi/env 加载用户 API key 等环境变量。
 *
 * 文件格式（shell export 语法）：
 *   export JINA_API_KEY="xxx"
 *   export BRAVE_API_KEY="xxx"
 *
 * 规则：
 *   - 已存在于 process.env 的变量不覆盖（shell 显式传入优先）
 *   - 静默忽略文件不存在或解析错误
 */
import type { ExtensionAPI } from "@anthropic-ai/claude-code";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ENV_FILE = path.join(os.homedir(), ".config/secrets/api-keys.env");
// 匹配: export KEY="value" / export KEY='value' / export KEY=value
const LINE_RE = /^export\s+(\w+)=["']?(.+?)["']?\s*$/;

export function loadPiEnv(): void {
  try {
    const content = readFileSync(ENV_FILE, "utf8");
    let loaded = 0;
    for (const line of content.split("\n")) {
      const m = line.trim().match(LINE_RE);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2];
        loaded++;
      }
    }
    if (loaded > 0) {
      console.error(`[env-loader] loaded ${loaded} var(s) from ${ENV_FILE}`);
    }
  } catch {
    // 文件不存在或权限问题 — 静默跳过
  }
}

export default function envLoader(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    loadPiEnv();
  });
}
