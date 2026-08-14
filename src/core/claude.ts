// Claude Code 配置:写入 ~/.claude/settings.json 的 env 块(cc-switch 同款方式)。
// 纯函数,不做文件 I/O。

export type ClaudeConfigInput = {
  /** Anthropic 兼容端点(如 http://host/api/anthropic)。 */
  anthropicBaseUrl: string;
  apiKey: string;
  /** 默认模型(同时用于 ANTHROPIC_MODEL 与 DEFAULT_*_MODEL 映射)。 */
  model: string;
  /** 模型真实上下文窗口;写入 CLAUDE_CODE_MAX_CONTEXT_TOKENS,避免 Claude Code 对未知模型按 200k 假设。 */
  contextWindow?: number;
};

/** 从 OpenAI 兼容 base_url 推导 Anthropic 端点:/api/v1 → /api/anthropic。 */
export function deriveAnthropicUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v1")) return trimmed.replace(/\/api\/v1$/, "") + "/api/anthropic";
  if (trimmed.endsWith("/v1")) return trimmed.replace(/\/v1$/, "") + "/api/anthropic";
  return trimmed + "/api/anthropic";
}

/** 合并写 ~/.claude/settings.json 的 env 块(保留 permissions 等其它键)。 */
export function patchClaudeSettings(text: string, input: ClaudeConfigInput): { text: string; changes: string[] } {
  let doc: Record<string, unknown>;
  try {
    doc = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error("~/.claude/settings.json 不是合法 JSON,请手动检查后重试");
  }
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error("settings.json 顶层必须是对象");

  const env = (doc.env ?? {}) as Record<string, unknown>;
  const changes: string[] = [];
  const set = (k: string, v: string): void => {
    if (env[k] !== v) {
      env[k] = v;
      changes.push(`${k} = ${v}`);
    }
  };
  set("ANTHROPIC_BASE_URL", input.anthropicBaseUrl);
  set("ANTHROPIC_AUTH_TOKEN", input.apiKey);
  set("ANTHROPIC_MODEL", input.model);
  set("ANTHROPIC_DEFAULT_HAIKU_MODEL", input.model);
  set("ANTHROPIC_DEFAULT_SONNET_MODEL", input.model);
  set("ANTHROPIC_DEFAULT_OPUS_MODEL", input.model);
  set("ANTHROPIC_DEFAULT_FABLE_MODEL", input.model);
  set("CLAUDE_CODE_SUBAGENT_MODEL", input.model);
  // 未知模型时 Claude Code 默认按 200k 假设并告警;写入真实窗口即可消除。
  if (input.contextWindow && input.contextWindow > 0) {
    set("CLAUDE_CODE_MAX_CONTEXT_TOKENS", String(input.contextWindow));
  }
  doc.env = env;

  return { text: JSON.stringify(doc, null, 2) + "\n", changes };
}

export type ClaudeStatus = {
  settingsExists: boolean;
  baseUrl: string | null;
  authTokenSet: boolean;
  model: string | null;
  sonnetModel: string | null;
};

/** 从 settings.json 文本解析 Claude 状态(纯)。 */
export function parseClaudeStatus(text: string): ClaudeStatus {
  let env: Record<string, unknown> = {};
  try {
    const doc = JSON.parse(text) as { env?: Record<string, unknown> };
    env = doc.env ?? {};
  } catch {
    // 非法/缺失
  }
  const get = (k: string): string | null => {
    const v = env[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    settingsExists: text.trim().length > 0,
    baseUrl: get("ANTHROPIC_BASE_URL"),
    authTokenSet: Boolean(get("ANTHROPIC_AUTH_TOKEN")),
    model: get("ANTHROPIC_MODEL"),
    sonnetModel: get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
  };
}
