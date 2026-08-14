// 配置一致性检测:从各 agent 官方配置文件里提取本 app 写入的 provider 的
// baseUrl / apiKey,与当前网关配置比对。纯函数,不做文件 I/O。

import { escapeRegExp, findKeyInRegion, lineAfter, blockBodyEnd, unquoteYaml } from "./util";
import { locateProviderBlock } from "./dsh";

export type FoundProvider = { baseUrl: string | null; apiKey: string | null };

export type AgentConfigCheck = {
  /** ok=baseUrl 与 Key 完全一致;stale=provider 存在但 baseUrl/Key 不一致;missing=未找到 provider。 */
  state: "ok" | "stale" | "missing";
  /** 配置文件里检测到的 baseUrl(展示用)。 */
  baseUrl: string | null;
  keyMatches: boolean;
};

/** 归一化 URL(忽略末尾斜杠)。 */
function normUrl(u: string): string {
  return u.trim().replace(/\/+$/, "");
}

/** 比对检测结果与当前网关配置。 */
export function compareAgentConfig(want: { baseUrl: string; apiKey: string }, found: FoundProvider): AgentConfigCheck {
  if (!want.baseUrl || found.baseUrl === null) return { state: "missing", baseUrl: found.baseUrl, keyMatches: false };
  const keyMatches = found.apiKey !== null && found.apiKey === want.apiKey;
  const ok = normUrl(found.baseUrl) === normUrl(want.baseUrl) && keyMatches;
  return { state: ok ? "ok" : "stale", baseUrl: found.baseUrl, keyMatches };
}

/** 从 YAML 块体文本抓取标量。 */
function grabYaml(body: string, key: string): string | null {
  const m = body.match(new RegExp(`^ *${escapeRegExp(key)}: *(.*)$`, "m"));
  return m ? unquoteYaml(m[1]) : null;
}

/** 从 TOML 块体文本抓取双引号字符串键。 */
function grabToml(body: string, key: string): string | null {
  return body.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// 各工具配置提取
// ---------------------------------------------------------------------------

/** Claude:~/.claude/settings.json 的 env 端点/Token。 */
export function extractClaudeProvider(settingsText: string): FoundProvider {
  try {
    const env = (JSON.parse(settingsText) as { env?: Record<string, unknown> }).env ?? {};
    return {
      baseUrl: typeof env.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL ? env.ANTHROPIC_BASE_URL : null,
      apiKey: typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN ? env.ANTHROPIC_AUTH_TOKEN : null,
    };
  } catch {
    return { baseUrl: null, apiKey: null };
  }
}

/** Codex:~/.codex/config.toml 的 [model_providers.<name>] 段。 */
export function extractCodexProvider(cfgText: string, providerName: string): FoundProvider {
  const re = new RegExp(`^\\[model_providers\\.${escapeRegExp(providerName)}\\]\\s*$[\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, "m");
  const block = cfgText.match(re)?.[0] ?? "";
  return {
    baseUrl: grabToml(block, "base_url"),
    apiKey: grabToml(block, "experimental_bearer_token"),
  };
}

/** Reasonix:config.toml 的 [[providers]] 块(按 name 匹配)+ .env 里 api_key_env 的值。 */
export function extractReasonixProvider(cfgText: string, envText: string, providerName: string): FoundProvider {
  const blockRe = /^\[\[providers\]\]\s*$/gm;
  const found: FoundProvider = { baseUrl: null, apiKey: null };
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(cfgText)) !== null) {
    const start = m.index;
    const end = cfgText.indexOf("[[providers]]", start + m[0].length);
    const block = cfgText.slice(start, end === -1 ? cfgText.length : end);
    if (!new RegExp(`^name\\s*=\\s*"${escapeRegExp(providerName)}"`, "m").test(block)) continue;
    found.baseUrl = grabToml(block, "base_url");
    const envKey = grabToml(block, "api_key_env");
    if (envKey) {
      const em = envText.match(new RegExp(`^(?:export\\s+)?${escapeRegExp(envKey)}\\s*=\\s*(".*"|\\S+)\\s*$`, "m"));
      if (em) {
        try {
          found.apiKey = JSON.parse(em[1]); // 本 app 用 JSON.stringify 写入
        } catch {
          found.apiKey = em[1];
        }
      }
    }
    break;
  }
  return found;
}

/** dsh:settings.yaml 的 llm-pi-ai.providers.<name> 段 + .credentials.yaml 的 Key 值。 */
export function extractDshProvider(settingsText: string, credText: string, providerName: string): FoundProvider {
  const block = locateProviderBlock(settingsText, providerName);
  if (!block) return { baseUrl: null, apiKey: null };
  const body = settingsText.slice(block.bodyStart, block.bodyEnd);
  const envKey = grabYaml(body, "apiKeyEnv");
  const rawKey = envKey ? credText.match(new RegExp(`^${escapeRegExp(envKey)}: *(.*)$`, "m"))?.[1]?.trim() : null;
  return {
    baseUrl: grabYaml(body, "baseURL"),
    apiKey: rawKey ? unquoteYaml(rawKey) : null,
  };
}

/** Pi:~/.pi/agent/models.json 的 providers.<name>。 */
export function extractPiProvider(modelsText: string, providerName: string): FoundProvider {
  try {
    const doc = JSON.parse(modelsText) as { providers?: Record<string, { baseUrl?: string; apiKey?: string }> };
    const p = doc.providers?.[providerName];
    return {
      baseUrl: typeof p?.baseUrl === "string" && p.baseUrl ? p.baseUrl : null,
      apiKey: typeof p?.apiKey === "string" && p.apiKey ? p.apiKey : null,
    };
  } catch {
    return { baseUrl: null, apiKey: null };
  }
}

/** omp:~/.omp/agent/models.yml 的 providers.<name>。 */
export function extractOmpProvider(modelsText: string, providerName: string): FoundProvider {
  const prov = findKeyInRegion(modelsText, 0, modelsText.length, "providers", 0);
  if (!prov) return { baseUrl: null, apiKey: null };
  const provBodyStart = lineAfter(modelsText, prov.end);
  const provBodyEnd = blockBodyEnd(modelsText, provBodyStart, prov.indent, modelsText.length);
  const p = findKeyInRegion(modelsText, provBodyStart, provBodyEnd, providerName);
  if (!p) return { baseUrl: null, apiKey: null };
  const bodyStart = lineAfter(modelsText, p.end);
  const bodyEnd = blockBodyEnd(modelsText, bodyStart, p.indent, provBodyEnd);
  const body = modelsText.slice(bodyStart, bodyEnd);
  return { baseUrl: grabYaml(body, "baseUrl"), apiKey: grabYaml(body, "apiKey") };
}
