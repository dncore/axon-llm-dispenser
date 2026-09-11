// Codex CLI 配置:纯文本变换(幂等,string in → string out)。
// 只依赖注入的路径参数,不做任何文件 I/O。

import type { ResolvedModel } from "./models";
import { applyTextOps, escapeRegExp, planManagedKeyUpserts } from "./util";

/** Codex 目录 reasoning effort 预设(实测网关对所有模型接受 low/high/max;不含 none,
 * 因 claude 系 / gemini-3.7-flash / grok-4.6 拒收 none→400,且 none 在转换层不发送)。 */
export const CODX_REASONING_LEVELS = [
  { effort: "low", description: "Low" },
  { effort: "high", description: "High" },
  { effort: "max", description: "Max" },
];

/** Codex Responses 转换代理:默认监听端口。 */
export const CODX_PROXY_DEFAULT_PORT = 17321;
/** 需要走 Responses→Chat 转换的模型匹配串(Rust 侧按大小写不敏感子串匹配)。
 * 静态规则由当前网关卡预探测生成(2026-08-27):网关对这些模型的原生 /responses
 * 不可用(502/参数错误),chat/completions 可用;其余模型(qwen 系/hy3/MiniMax/
 * deepseek-v4-pro/kimi-k2.7-code 等)原生 responses 可用,走透传。 */
export const CODX_PROXY_CONVERT_PATTERN =
  "gpt-5.6|glm|kimi-k2.6|kimi-k3|kimi-lastest|step-3.7|MiMo|grok-4.6|claude-sonnet-5|claude-opus-5|gemini-3|deepseek-v4-flash";

/** 转换代理的 base_url 主机与端口(Codex 配置指向它)。默认 localhost 天然绕过系统/环境代理劫持;
 * 被劫持且 localhost 不可达时,Rust 侧自动改用本机 LAN IP 并返回 codexHost。 */
export function codexProxyBaseUrl(port: number, host = "localhost"): string {
  return `http://${host}:${port}/api/v1`;
}

/** 模型列表里是否存在需要走转换代理的模型(按 | 分隔的规则子串匹配,与 Rust 端一致)。 */
export function codexProxyNeeded(modelIds: string[]): boolean {
  const patterns = CODX_PROXY_CONVERT_PATTERN.toLowerCase()
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return modelIds.some((id) => {
    const ml = id.toLowerCase();
    return patterns.some((p) => ml.includes(p));
  });
}

export type CodexConfigInput = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  /** models.json 的绝对路径(用于写顶层 model_catalog_json)。 */
  modelsJsonPath: string;
};

function upsertKey(text: string, key: string, value: string): { text: string; changed: boolean } {
  const line = `${key} = ${JSON.stringify(value)}`;
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (re.test(text)) {
    const next = text.replace(re, line);
    return { text: next, changed: next !== text };
  }
  return { text: line + "\n" + text, changed: true };
}

function upsertProviderSection(
  text: string,
  name: string,
  kv: Record<string, string | boolean>,
): { text: string; changed: boolean } {
  const body = Object.entries(kv)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join("\n");
  const block = `[model_providers.${name}]\n${body}\n`;
  const headerRe = new RegExp(`^\\[model_providers\\.${escapeRegExp(name)}\\]\\s*$`, "m");
  const header = headerRe.exec(text);
  if (!header || header.index === undefined) {
    return { text: text.replace(/\s+$/, "") + "\n\n" + block, changed: true };
  }
  // 只 upsert 本段的键,段内用户自己加的键与注释原样保留(不再整段重写)。
  const headerLineEnd = text.indexOf("\n", header.index);
  const bodyStart = headerLineEnd === -1 ? text.length : headerLineEnd + 1;
  const nextHeader = /^\[/m.exec(text.slice(bodyStart));
  const bodyEnd = nextHeader ? bodyStart + nextHeader.index : text.length;
  const ops = planManagedKeyUpserts(
    text,
    { start: bodyStart, end: bodyEnd },
    {
      separator: "=",
      indent: 0,
      keys: Object.entries(kv).map(([k, v]) => ({ key: k, lines: [`${k} = ${JSON.stringify(v)}`] })),
    },
  );
  const next = applyTextOps(text, ops);
  return { text: next, changed: next !== text };
}

/** 生成/更新 codex config.toml 的 provider 配置(文本级修改,幂等)。 */
export function patchCodexConfigToml(text: string, input: CodexConfigInput): { text: string; changes: string[] } {
  const changes: string[] = [];
  let out = text;
  const { providerName, baseUrl, apiKey, defaultModel, modelsJsonPath } = input;

  const provider = upsertKey(out, "model_provider", providerName);
  out = provider.text;
  if (provider.changed) changes.push(`model_provider = ${providerName}`);

  if (defaultModel && !/^model\s*=.*$/m.test(out)) {
    const model = upsertKey(out, "model", defaultModel);
    out = model.text;
    if (model.changed) changes.push(`model = ${defaultModel}`);
  }

  // 顶层 model_catalog_json 必须写:codex-cli 不写它就读不到 models.json。
  const catalog = upsertKey(out, "model_catalog_json", modelsJsonPath);
  out = catalog.text;
  if (catalog.changed) changes.push(`model_catalog_json = ${modelsJsonPath}`);

  // requires_openai_auth 必须为 false:置 true 时 Codex 强制去 auth.json 找凭据。
  const section = upsertProviderSection(out, providerName, {
    name: providerName,
    base_url: baseUrl,
    wire_api: "responses",
    requires_openai_auth: false,
    experimental_bearer_token: apiKey,
  });
  out = section.text;
  if (section.changed) changes.push(`[model_providers.${providerName}] updated`);

  return { text: out, changes };
}

function buildCodexEntry(m: ResolvedModel, providerName: string, priority: number) {
  const cw = m.contextWindow || 128000;
  const entry: Record<string, unknown> = {
    base_instructions: "",
    context_window: cw,
    description: `${providerName}: ${m.name} — openai-compatible gateway`,
    display_name: m.name,
    experimental_supported_tools: [],
    max_context_window: cw,
    priority,
    shell_type: "shell_command",
    slug: m.id,
    support_verbosity: false,
    supported_in_api: true,
    // effort 档位一律填充(桌面端 effort 下拉依据;low/high/max 为实测可用档,不含
    // none)。不做 reasoning 条件化:axon 面向任意网关,模型表推断不到的 ID 一律
    // 落到非推理,条件化会误伤未知模型;端点/上游不支持的档位由转换代理做映射兼容。
    supported_reasoning_levels: CODX_REASONING_LEVELS.map((x) => ({ ...x })),
    supports_images: m.input.includes("image"),
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: false,
    supports_tools: true,
    truncation_policy: { limit: cw, mode: "tokens" },
    // 网关模型一律关掉 Responses Lite:Codex 内置目录对 gpt-5.6 系硬编码
    // use_responses_lite=true,会把工具定义塞进请求 input[0].additional_tools,
    // 自建网关翻译成 Chat Completions 时误当 messages[0].content 的 content item,
    // 上游只认标准 tools 参数 → 400/500 → 网关汇总 502。显式 false 强制标准请求。
    use_responses_lite: false,
    visibility: "list",
  };
  // GPT-5.6 家族额外关掉内置 code_mode_only / multi_agent v2(同样只在局域网网关后端可用,
  // 自建 OpenAI 兼容网关不支持 → 解除工具模式与多智能体相关请求形状)。
  if (/gpt-5\.6/i.test(m.id)) {
    entry.tool_mode = "direct";
    entry.multi_agent_version = null;
  }
  return entry;
}

type CodexCatalogPlan = {
  kept: unknown[];
  entries: Record<string, unknown>[];
  added: string[];
  removed: string[];
};

/**
 * 规划 models.json 目录内容:
 * - 本 provider 条目按 description 前缀(`${providerName}: `)归属;已不在模型列表的自家条目移除;
 * - 非本 provider 条目(不含可识别 slug 的、或描述前缀不匹配的)原样保留(兼容用户已有模型目录);
 * - opts.preserveExisting(仅更新模型列表):既有 slug 沿用其 visibility/description,其余字段随模型表刷新。
 */
function planCodexCatalog(
  models: ResolvedModel[],
  providerName: string,
  existingJson: string | undefined,
  opts?: { preserveExisting?: boolean },
): CodexCatalogPlan {
  const newIds = new Set(models.map((m) => m.id));
  const prevSlugs = new Set<string>();
  const prevBySlug = new Map<string, Record<string, unknown>>();
  const kept: unknown[] = [];
  const removed: string[] = [];
  if (existingJson && existingJson.trim()) {
    try {
      const data = JSON.parse(existingJson) as { models?: Array<Record<string, unknown>> };
      for (const m of data.models ?? []) {
        const slug = typeof m.slug === "string" && m.slug.length > 0 ? m.slug : null;
        if (!slug) {
          kept.push(m);
          continue;
        }
        prevSlugs.add(slug);
        const ours = typeof m.description === "string" && m.description.startsWith(`${providerName}: `);
        if (newIds.has(slug)) {
          prevBySlug.set(slug, m);
          continue;
        }
        if (ours) {
          removed.push(slug);
          continue;
        }
        kept.push(m);
      }
    } catch {
      // 现有目录损坏/非法,忽略
    }
  }
  const added: string[] = [];
  const entries = models.map((m, i) => {
    const e: Record<string, unknown> = buildCodexEntry(m, providerName, 20 + i);
    if (!prevSlugs.has(m.id)) added.push(m.id);
    const prev = prevBySlug.get(m.id);
    if (prev && opts?.preserveExisting) {
      if (typeof prev.visibility === "string") e.visibility = prev.visibility;
      if (typeof prev.description === "string") e.description = prev.description;
    }
    return e;
  });
  return { kept, entries, added, removed };
}

/** 生成 codex models.json 内容(所有模型 visibility=list)。 */
export function renderCodexModelsJson(models: ResolvedModel[], providerName: string, existingJson?: string): string {
  const plan = planCodexCatalog(models, providerName, existingJson);
  return JSON.stringify({ models: [...plan.kept, ...plan.entries] }, null, 2) + "\n";
}

export type CodexCatalogResult = {
  text: string;
  changes: string[];
  added: string[];
  removed: string[];
  /** 生成内容与现有文件一致(刷新流程据此跳过写入)。 */
  unchanged: boolean;
};

/**
 * 「仅更新模型列表」用:只生成 models.json 文本与变更摘要(不写盘,不碰 config.toml)。
 * 既有条目沿用其 visibility/description;自家下架条目移除;非本 provider 条目原样保留。
 */
export function patchCodexCatalog(
  models: ResolvedModel[],
  providerName: string,
  existingJson: string,
): CodexCatalogResult {
  const plan = planCodexCatalog(models, providerName, existingJson, { preserveExisting: true });
  const text = JSON.stringify({ models: [...plan.kept, ...plan.entries] }, null, 2) + "\n";
  const unchanged = text === existingJson;
  const changes: string[] = [];
  if (!unchanged) {
    if (plan.added.length > 0) changes.push(`新增 ${plan.added.length} 个模型`);
    if (plan.removed.length > 0) changes.push(`移除 ${plan.removed.length} 个下架条目(${plan.removed.slice(0, 6).join(", ")}${plan.removed.length > 6 ? " …" : ""})`);
    if (plan.kept.length > 0) changes.push(`保留非本 provider 条目 ${plan.kept.length} 条`);
    if (changes.length === 0) changes.push(`模型元数据已更新(${models.length} 个模型)`);
  }
  return { text, changes, added: plan.added, removed: plan.removed, unchanged };
}

export type CodexStatus = {
  configExists: boolean;
  authJsonExists: boolean;
  requiresOpenaiAuth: boolean;
  modelCatalogJson: string | null;
  modelCatalogJsonExists: boolean;
  provider: string | null;
  model: string | null;
  providerConfigured: boolean;
  catalogCount: number;
  catalogList: number;
  catalogHide: number;
};

/** 从 config.toml / models.json / auth.json 文本解析 codex 状态(纯)。 */
export function parseCodexStatus(
  cfgText: string,
  catalogText: string,
  opts: { configExists: boolean; authJsonExists: boolean },
): CodexStatus {
  let catalog = { count: 0, list: 0, hide: 0 };
  try {
    const data = JSON.parse(catalogText) as { models?: Array<{ visibility?: string }> };
    const models = data.models ?? [];
    catalog = {
      count: models.length,
      list: models.filter((m) => m.visibility === "list").length,
      hide: models.filter((m) => m.visibility === "hide").length,
    };
  } catch {
    // missing / invalid
  }
  const modelCatalogJson = cfgText.match(/^model_catalog_json\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  return {
    configExists: opts.configExists,
    authJsonExists: opts.authJsonExists,
    requiresOpenaiAuth: /^requires_openai_auth\s*=\s*true\s*$/m.test(cfgText),
    modelCatalogJson,
    modelCatalogJsonExists: modelCatalogJson ? opts.configExists && modelCatalogJson.length > 0 : false,
    provider: cfgText.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    model: cfgText.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    providerConfigured: /^\[model_providers\.[A-Za-z0-9._-]+\]\s*$/m.test(cfgText),
    catalogCount: catalog.count,
    catalogList: catalog.list,
    catalogHide: catalog.hide,
  };
}
