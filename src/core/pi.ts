// pi agent 配置:写入 ~/.pi/agent/models.json(providers) + settings.json(defaultProvider/Model)。
// 纯函数,不做文件 I/O。格式参考 pi 官方文档 models.md。

import type { ResolvedModel } from "./models";

export type PiProviderInput = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  /** pi 的 api 协议,默认 openai-completions。 */
  api?: string;
  models: ResolvedModel[];
};

function parseDoc(text: string, path: string): Record<string, unknown> {
  try {
    const doc = text.trim() ? JSON.parse(text) : {};
    if (typeof doc !== "object" || Array.isArray(doc)) throw new Error("顶层必须是对象");
    return doc as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path} 不是合法 JSON: ${e instanceof Error ? e.message : e}`);
  }
}

/** 合并写 ~/.pi/agent/models.json 的 providers.<name>(保留其它 provider)。 */
export function patchPiModelsJson(text: string, input: PiProviderInput): { text: string; changes: string[] } {
  const doc = parseDoc(text, "~/.pi/agent/models.json");
  const providers = (doc.providers ?? {}) as Record<string, unknown>;
  const existing = providers[input.providerName] !== undefined;

  const models = input.models.map((m) => ({
    id: m.id,
    ...(m.name && m.name !== m.id ? { name: m.name } : {}),
    reasoning: m.reasoning,
    input: m.input,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    cost: m.cost,
    ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
    ...(m.compat && Object.keys(m.compat).length > 0 ? { compat: m.compat } : {}),
  }));

  providers[input.providerName] = {
    baseUrl: input.baseUrl,
    api: input.api ?? "openai-completions",
    apiKey: input.apiKey,
    authHeader: true,
    models,
  };
  doc.providers = providers;

  return {
    text: JSON.stringify(doc, null, 2) + "\n",
    changes: [
      `${existing ? "已更新" : "已新增"} providers.${input.providerName}(${models.length} 个模型, api=${input.api ?? "openai-completions"})`,
    ],
  };
}

/** 合并写 ~/.pi/agent/settings.json 的 defaultProvider / defaultModel。 */
export function patchPiSettings(text: string, providerName: string, defaultModel: string): { text: string; changes: string[] } {
  const doc = parseDoc(text, "~/.pi/agent/settings.json");
  const changes: string[] = [];
  if (doc.defaultProvider !== providerName) {
    doc.defaultProvider = providerName;
    changes.push(`defaultProvider = ${providerName}`);
  }
  if (defaultModel && doc.defaultModel !== defaultModel) {
    doc.defaultModel = defaultModel;
    changes.push(`defaultModel = ${defaultModel}`);
  }
  return { text: JSON.stringify(doc, null, 2) + "\n", changes };
}

export type PiStatus = {
  modelsExists: boolean;
  providerConfigured: boolean;
  providerBaseUrl: string | null;
  providerModels: number;
  settingsExists: boolean;
  defaultProvider: string | null;
  defaultModel: string | null;
};

/** 从 models.json / settings.json 文本解析 pi 状态(纯)。 */
export function parsePiStatus(modelsText: string, settingsText: string, providerName: string): PiStatus {
  let providerBaseUrl: string | null = null;
  let providerModels = 0;
  try {
    const doc = JSON.parse(modelsText) as { providers?: Record<string, { baseUrl?: string; models?: unknown[] }> };
    const p = doc.providers?.[providerName];
    providerBaseUrl = typeof p?.baseUrl === "string" && p.baseUrl ? p.baseUrl : null;
    providerModels = Array.isArray(p?.models) ? p.models.length : 0;
  } catch {
    // 缺失/非法
  }
  let defaultProvider: string | null = null;
  let defaultModel: string | null = null;
  try {
    const doc = JSON.parse(settingsText) as { defaultProvider?: string; defaultModel?: string };
    defaultProvider = typeof doc.defaultProvider === "string" ? doc.defaultProvider : null;
    defaultModel = typeof doc.defaultModel === "string" ? doc.defaultModel : null;
  } catch {
    // 缺失/非法
  }
  return {
    modelsExists: modelsText.trim().length > 0,
    providerConfigured: providerBaseUrl !== null,
    providerBaseUrl,
    providerModels,
    settingsExists: settingsText.trim().length > 0,
    defaultProvider,
    defaultModel,
  };
}
