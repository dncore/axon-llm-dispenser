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

/** Codex 客户端模型选择器可见条目上限(visibility="list")。超过该数量,客户端渲染的模型
 * 列表布局会挤压错乱;Codex 官方内置目录也只保留 5 条可见(list)+ 4 条 hide。
 * 上限之外的模型一律写 visibility="hide":不出现在选择器,但仍留在目录里,
 * 仍可用 codex -m <slug> / 作默认模型。 */
export const CODX_MAX_LISTED_MODELS = 8;

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
  /** 本次写入 models.json 的模型 id 集合:顶层 model 不在其中(切换网关后旧模型失效)时改写为默认模型。 */
  modelIds?: string[];
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

  // model 跟随 provider:键缺失时写入默认模型;已存在但不在本次写入的模型列表里
  // (切换网关后旧模型已失效)时改写为默认模型;仍在列表内则保留(尊重用户在 Codex 里的选择)。
  const currentModel = out.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const staleModel = currentModel !== null && !!defaultModel && (input.modelIds?.length ?? 0) > 0 && !input.modelIds!.includes(currentModel);
  if (defaultModel && (currentModel === null || staleModel)) {
    const model = upsertKey(out, "model", defaultModel);
    out = model.text;
    if (model.changed) {
      changes.push(staleModel ? `model: ${currentModel} → ${defaultModel}(旧模型不在新网关模型列表)` : `model = ${defaultModel}`);
    }
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
  /** 本 provider 条目中可见 / 隐藏的数量。 */
  visible: number;
  hidden: number;
};

export type CodexListedPlan = {
  /** 计划写入的可见集合(已按上限截断)。 */
  listed: string[];
  /** 期望可见数(既有可见 + 目录新增);> 上限即需用户挑选。 */
  desired: number;
  /** 期望可见数超上限,需用户挑选(UI 弹选择框)。 */
  needsChoice: boolean;
  /** 既有 models.json 中与模型列表同 slug 的可见条目(文件顺序)。 */
  current: string[];
  /** 计算预选时用的默认模型(供 UI 标注;与写入 config.toml 的一致)。 */
  defaultModel: string;
};

/**
 * 规划「哪些模型在 Codex 客户端可见」(visibility="list",数量上限 cap):
 * - 既有目录里同 slug 的可见条目沿用(即用户上次的选择,provider 改名也不丢);
 * - 目录里没有的新条目默认希望可见(与旧行为一致:新模型自动出现在选择器);
 * - 二者合计超过上限时 needsChoice=true,listed 为按上限截断的预选集合(默认模型置首);
 * - 名额只算与模型列表同 slug 的条目:目录里其它来源的条目保持原样,不占名额也不被改写。
 */
export function planCodexListed(
  models: ResolvedModel[],
  existingJson?: string,
  opts?: { defaultModel?: string; cap?: number },
): CodexListedPlan {
  const cap = opts?.cap ?? CODX_MAX_LISTED_MODELS;
  const ids = models.map((m) => m.id);
  const idSet = new Set(ids);
  const known = new Set<string>();
  const current: string[] = [];
  if (existingJson && existingJson.trim()) {
    try {
      const data = JSON.parse(existingJson) as { models?: Array<Record<string, unknown>> };
      for (const m of data.models ?? []) {
        const slug = typeof m.slug === "string" && m.slug.length > 0 ? m.slug : null;
        if (!slug) continue;
        known.add(slug);
        // 与模型列表同 slug 的既有条目即沿用其可见性(含 provider 改名前的旧条目,改名不该重置用户选择);
        // visibility 缺失视为 list(与 Codex 内置目录一致),显式 hide 的保持隐藏
        if (idSet.has(slug) && m.visibility !== "hide") current.push(slug);
      }
    } catch {
      // 现有目录损坏/非法:按无既有目录处理
    }
  }
  const fresh = ids.filter((id) => !known.has(id));
  const wants = [...current, ...fresh];
  const dflt = opts?.defaultModel ?? "";
  // 默认模型置首:只在需要截断时影响预选,不影响 desired
  const ordered = dflt && wants.includes(dflt) ? [dflt, ...wants.filter((id) => id !== dflt)] : wants;
  return { listed: ordered.slice(0, Math.max(0, cap)), desired: wants.length, needsChoice: wants.length > cap, current, defaultModel: dflt };
}

/**
 * 规划 models.json 目录内容:
 * - 本 provider 条目按 description 前缀(`${providerName}: `)归属;已不在模型列表的自家条目移除;
 *   opts.ownProviders 传入本 app 其它 profile 的 provider 名:它们写的条目同属本 app(切换
 *   provider 名后旧条目不该继续留在选择器里),一并按下架处理;
 * - 非本 app 条目(不含可识别 slug 的、或描述前缀不匹配的)原样保留(兼容用户已有模型目录);
 * - opts.preserveExisting(仅更新模型列表):既有 slug 沿用其 description,其余字段随模型表刷新;
 * - opts.listed:可见集合(visibility="list"),其余自家条目写 hide;缺省按 planCodexListed 推导(带上限)。
 */
function planCodexCatalog(
  models: ResolvedModel[],
  providerName: string,
  existingJson: string | undefined,
  opts?: { preserveExisting?: boolean; listed?: string[]; ownProviders?: string[] },
): CodexCatalogPlan {
  const newIds = new Set(models.map((m) => m.id));
  const ownNames = new Set<string>([providerName, ...(opts?.ownProviders ?? [])]);
  const isOurs = (desc: unknown): boolean => {
    if (typeof desc !== "string") return false;
    const i = desc.indexOf(": "); // provider 名校验不含空格,首个 ": " 即前缀边界
    return i > 0 && ownNames.has(desc.slice(0, i));
  };
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
        const ours = isOurs(m.description);
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
  const listed = new Set(opts?.listed ?? planCodexListed(models, existingJson).listed);
  const added: string[] = [];
  const entries = models.map((m, i) => {
    const e: Record<string, unknown> = buildCodexEntry(m, providerName, 20 + i);
    // 可见性由 listed 决定:上限外的自家条目一律 hide(条目仍保留,可用作默认模型/CLI 指定)
    e.visibility = listed.has(m.id) ? "list" : "hide";
    if (!prevSlugs.has(m.id)) added.push(m.id);
    const prev = prevBySlug.get(m.id);
    if (prev && opts?.preserveExisting) {
      if (typeof prev.description === "string") e.description = prev.description;
    }
    return e;
  });
  const visible = entries.filter((e) => e.visibility === "list").length;
  return { kept, entries, added, removed, visible, hidden: entries.length - visible };
}

/** 生成 codex models.json 内容(listed 之外的自家条目写 hide,上限默认 CODX_MAX_LISTED_MODELS)。 */
export function renderCodexModelsJson(
  models: ResolvedModel[],
  providerName: string,
  existingJson?: string,
  listed?: string[],
  ownProviders?: string[],
): string {
  const plan = planCodexCatalog(models, providerName, existingJson, { listed, ownProviders });
  return JSON.stringify({ models: [...plan.kept, ...plan.entries] }, null, 2) + "\n";
}

export type CodexCatalogResult = {
  text: string;
  changes: string[];
  added: string[];
  removed: string[];
  /** 本 provider 条目中可见 / 隐藏的数量。 */
  visible: number;
  hidden: number;
  /** 生成内容与现有文件一致(刷新流程据此跳过写入)。 */
  unchanged: boolean;
};

/**
 * 「仅更新模型列表」用:只生成 models.json 文本与变更摘要(不写盘,不碰 config.toml)。
 * 既有条目沿用其 description;自家下架条目移除;非本 provider 条目原样保留。
 * listed 之外的自家条目写 hide(可见数量按 CODX_MAX_LISTED_MODELS 上限)。
 */
export function patchCodexCatalog(
  models: ResolvedModel[],
  providerName: string,
  existingJson: string,
  listed?: string[],
  ownProviders?: string[],
): CodexCatalogResult {
  const plan = planCodexCatalog(models, providerName, existingJson, { preserveExisting: true, listed, ownProviders });
  const text = JSON.stringify({ models: [...plan.kept, ...plan.entries] }, null, 2) + "\n";
  const unchanged = text === existingJson;
  const changes: string[] = [];
  if (!unchanged) {
    if (plan.added.length > 0) changes.push(`新增 ${plan.added.length} 个模型`);
    if (plan.removed.length > 0) changes.push(`移除 ${plan.removed.length} 个下架条目(${plan.removed.slice(0, 6).join(", ")}${plan.removed.length > 6 ? " …" : ""})`);
    if (plan.kept.length > 0) changes.push(`保留非本 provider 条目 ${plan.kept.length} 条`);
    changes.push(`可见 ${plan.visible} 个(上限 ${CODX_MAX_LISTED_MODELS})/ 隐藏 ${plan.hidden} 个`);
  }
  return { text, changes, added: plan.added, removed: plan.removed, visible: plan.visible, hidden: plan.hidden, unchanged };
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
