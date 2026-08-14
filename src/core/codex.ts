// Codex CLI 配置:纯文本变换(幂等,string in → string out)。
// 只依赖注入的路径参数,不做任何文件 I/O。

import type { ResolvedModel } from "./models";
import { escapeRegExp } from "./util";

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
  // 末尾判断用「其后无任何字符」的负向先行断言表示文件末尾,不能用 $——
  // $ 在 m 模式下会匹配任意换行前,导致 lazy 匹配在表头处就结束,替换时旧 body 残留形成重复 key。
  const re = new RegExp(`^\\[model_providers\\.${escapeRegExp(name)}\\]\\s*$[\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, "m");
  if (re.test(text)) {
    const next = text.replace(re, block);
    return { text: next, changed: next !== text };
  }
  return { text: text.replace(/\s+$/, "") + "\n\n" + block, changed: true };
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
  return {
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
    supported_reasoning_levels: [],
    supports_images: m.input.includes("image"),
    supports_parallel_tool_calls: true,
    supports_reasoning_summaries: false,
    supports_tools: true,
    truncation_policy: { limit: cw, mode: "tokens" },
    visibility: "list",
  };
}

/** 生成 codex models.json 内容(所有模型 visibility=list)。 */
export function renderCodexModelsJson(models: ResolvedModel[], providerName: string): string {
  const entries = models.map((m, i) => buildCodexEntry(m, providerName, 20 + i));
  return JSON.stringify({ models: entries }, null, 2) + "\n";
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
