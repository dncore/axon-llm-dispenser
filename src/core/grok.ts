// Grok(grok CLI)配置管理:通过 [model_providers.<name>] + 每模型 [model.<id>] 块
// 把任意 OpenAI 兼容网关接入 grok。配置位于 <grok home>/config.toml(默认 ~/.grok)。
//
// 鉴权形态:API Key 写入 [model_providers.<name>].api_key(明文,与 Codex 分支
// experimental_bearer_token 同一先例)。官方文档推荐 env_key,但 grok 不加载
// home 级 .env,env_key 依赖 shell 环境变量不持久,故弃用。
// grok 鉴权优先级:per-model api_key/env_key > 会话 token > XAI_API_KEY,
// 因此已 grok login 的用户无需 logout——自定义模型全走网关 key,官方 grok 模型
// 继续走官方通道(混合模式,/model 随时切换)。
//
// ⚠️ TOML 点号陷阱:含点号的模型 ID 必须用引号键 [model."glm-5.3"]——裸键
// [model.glm-5.3] 会被 TOML 解析成嵌套表,模型直接不可用(实测 "unknown model id")。
//
// 移植自 pi-agent-dispenser lib/grok-build.ts(纯函数部分,I/O 在 flows/bridge)。

import {
  applyTextOps,
  escapeRegExp,
  maskToken,
  planManagedKeyUpserts,
  preserveTrailingBlanks,
  type ManagedKey,
  type TextOp,
} from "./util";

export type GrokModel = {
  id: string;
  contextWindow: number;
  maxTokens: number;
};

export type GrokPatchInput = {
  providerName: string;
  /** 展示名后缀(写入每个模型块的 name,如 "Axon")。 */
  label: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  models: GrokModel[];
};

// ---------------------------------------------------------------------------
// TOML 文本补丁(纯函数)
// ---------------------------------------------------------------------------

/** 段落正文结束位:遇到下一表头或 EOF;但截掉正文尾部的空行,只保留最后一个换行
 *  (否则整段替换会连带吃掉表头间的空行,破坏幂等)。 */
function sectionBodyEnd(text: string, bodyStart: number, bodyEnd: number): number {
  let cursor = bodyEnd;
  while (cursor > bodyStart && text.charCodeAt(cursor - 1) === 10) cursor--;
  if (cursor === bodyEnd) return bodyEnd; // 尾部无换行——原样
  return Math.min(cursor + 1, bodyEnd);
}

/** 定位表头并返回其正文区间(bodyStart 在表头行后,bodyEnd 为下一表头或 EOF,含尾部一个换行)。 */
function locateSection(text: string, headerRe: RegExp): { bodyStart: number; bodyEnd: number } | null {
  const m = text.match(headerRe);
  if (!m || m.index === undefined) return null;
  const lineEnd = text.indexOf("\n", m.index);
  const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
  const rest = text.slice(bodyStart);
  const nextHeader = rest.match(/^\s*\[/m);
  const bodyEnd = nextHeader ? bodyStart + nextHeader.index! : text.length;
  return { bodyStart, bodyEnd: sectionBodyEnd(text, bodyStart, bodyEnd) };
}

/** TOML 表头键:非裸键(如含点号的 "glm-5.3")必须加引号,否则点被解析成嵌套表。 */
function tomlKey(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : JSON.stringify(id);
}

const MODEL_HEADER_RE = /^\[model\.([^\]]+)\]\s*$/gm;
const MODELS_SECTION_RE = /^\[models\]\s*$/m;

type ModelBlock = {
  key: string;
  provider: string | null;
  start: number;
  bodyStart: number;
  bodyEnd: number;
};

/** 扫描全部 [model.<key>] 块:键去引号,provider 为其体内 model_provider 值(无则 null)。 */
function scanModelBlocks(text: string): ModelBlock[] {
  const blocks: ModelBlock[] = [];
  for (const m of text.matchAll(MODEL_HEADER_RE)) {
    if (m.index === undefined) continue;
    const rawKey = m[1]!.trim();
    let key: string;
    if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
      try {
        key = JSON.parse(rawKey) as string;
      } catch {
        continue; // 非法引号键——跳过,不做任何处理
      }
    } else {
      key = rawKey;
    }
    const lineEnd = text.indexOf("\n", m.index);
    const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
    const rest = text.slice(bodyStart);
    const nextHeader = rest.match(/^\s*\[/m);
    const bodyEnd = sectionBodyEnd(text, bodyStart, nextHeader ? bodyStart + nextHeader.index! : text.length);
    const body = text.slice(bodyStart, bodyEnd);
    const provider = body.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    blocks.push({ key, provider, start: m.index, bodyStart, bodyEnd });
  }
  return blocks;
}

/** 一个模型块的管理键(model/id 为身份行;max_completion_tokens 为 0 时移除)。 */
function modelBlockManagedKeys(m: GrokModel, label: string, providerName: string): ManagedKey[] {
  return [
    { key: "model", lines: [`model = ${JSON.stringify(m.id)}`] },
    { key: "name", lines: [`name = ${JSON.stringify(`${m.id} (${label})`)}`] },
    { key: "model_provider", lines: [`model_provider = ${JSON.stringify(providerName)}`] },
    { key: "context_window", lines: [`context_window = ${m.contextWindow}`] },
    { key: "max_completion_tokens", lines: m.maxTokens > 0 ? [`max_completion_tokens = ${m.maxTokens}`] : null },
  ];
}

/** [model_providers.<name>] 段的管理键。 */
function providerSectionKeys(baseUrl: string, apiKey: string): ManagedKey[] {
  return [
    { key: "base_url", lines: [`base_url = ${JSON.stringify(baseUrl)}`] },
    { key: "api_backend", lines: [`api_backend = "chat_completions"`] },
    { key: "api_key", lines: [`api_key = ${JSON.stringify(apiKey)}`] },
  ];
}

/** 一个模型块的规范文本(含表头,尾随换行)。 */
function renderModelBlock(m: GrokModel, label: string, providerName: string): string {
  const lines = [`[model.${tomlKey(m.id)}]`];
  for (const k of modelBlockManagedKeys(m, label, providerName)) if (k.lines) lines.push(...k.lines);
  return lines.join("\n") + "\n";
}

type GrokModelBlocksResult = { text: string; changes: string[] };

/**
 * 按 id 合并模型块:自有块只 upsert 管理键(块内用户键保留),陈旧自有块移除,
 * 新块追加(同 key 属于其他 provider 的块保留并跳过,避免 TOML 重复段)。
 */
function applyGrokModelBlocks(
  text: string,
  providerName: string,
  label: string,
  sorted: GrokModel[],
): GrokModelBlocksResult {
  const changes: string[] = [];
  const blocks = scanModelBlocks(text);
  const liveIds = new Set(sorted.map((m) => m.id));
  const ours = blocks.filter((b) => b.provider === providerName);
  const stale = ours.filter((b) => !liveIds.has(b.key));
  const sameKeyUserBlocks = sorted.filter((m) =>
    blocks.some((b) => b.key === m.id && b.provider !== null && b.provider !== providerName),
  );

  const ops: TextOp[] = [];
  for (const b of stale) {
    ops.push({
      start: b.start,
      end: b.bodyEnd,
      replacement: preserveTrailingBlanks(text, { bodyStart: b.bodyStart, end: b.bodyEnd }),
    });
  }
  for (const m of sorted) {
    const own = ours.find((b) => b.key === m.id);
    if (!own) continue;
    ops.push(
      ...planManagedKeyUpserts(
        text,
        { start: own.bodyStart, end: own.bodyEnd },
        { separator: "=", indent: 0, keys: modelBlockManagedKeys(m, label, providerName) },
      ),
    );
  }
  let out = applyTextOps(text, ops);

  const appended = sorted.filter((m) => !blocks.some((b) => b.key === m.id));
  if (appended.length > 0) {
    out = out.replace(/\s+$/, "") + "\n\n" + appended.map((m) => renderModelBlock(m, label, providerName)).join("\n");
    changes.push(`写入 ${appended.length} 个模型块([model.<id>],含 context_window)`);
  }
  if (stale.length > 0) changes.push(`移除 ${stale.length} 个陈旧模型块(已不在网关模型列表)`);
  if (sameKeyUserBlocks.length > 0) {
    changes.push(`跳过 ${sameKeyUserBlocks.length} 个模型(如 ${sameKeyUserBlocks[0].id}):config 已有同 key 其他 provider 块,保留用户配置`);
  }
  return { text: out, changes };
}

/**
 * 生成/更新 grok config.toml:
 * - [model_providers.<name>] 块:base_url + api_backend(chat_completions)+ api_key(明文,同 Codex 先例);
 *   只 upsert 这三个管理键,段内用户键保留
 * - [models].default = 默认模型(段内其他键保留;缺段时追加)
 * - 每个网关模型一个 [model.<id>] 块(含点号 ID 自动加引号键),model_provider 指向本 provider,
 *   带上 context_window / max_completion_tokens;已有自有块只改管理键,块内用户键保留
 * - 只接管 model_provider 属于本 provider 的块:陈旧块移除;key 相同但属于用户的块保留并跳过
 *   (避免 TOML 重复段);其他 [model.*] 块与顶层键原样不动
 */
export function patchGrokConfigToml(
  text: string,
  input: GrokPatchInput,
): { text: string; changes: string[] } {
  const { providerName, label, baseUrl, apiKey, defaultModel, models } = input;
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length === 0) return { text, changes: [] };

  const changes: string[] = [];
  const providerRe = escapeRegExp(providerName);
  const liveIds = new Set(sorted.map((m) => m.id));

  // 1) 模型块:按 id 合并/新增/移除
  const merged = applyGrokModelBlocks(text, providerName, label, sorted);
  let out = merged.text;

  // 2) [model_providers.<name>] 块:已有段只 upsert 管理键,段内用户键保留
  const providerSection = locateSection(out, new RegExp(`^\\[model_providers\\.${providerRe}\\]\\s*$`, "m"));
  if (providerSection) {
    const next = applyTextOps(
      out,
      planManagedKeyUpserts(
        out,
        { start: providerSection.bodyStart, end: providerSection.bodyEnd },
        { separator: "=", indent: 0, keys: providerSectionKeys(baseUrl, apiKey) },
      ),
    );
    if (next !== out) {
      changes.push(`[model_providers.${providerName}] 已更新(base_url + api_key)`);
      out = next;
    }
  } else {
    const providerBody = providerSectionKeys(baseUrl, apiKey).map((k) => k.lines![0]).join("\n") + "\n";
    out = (out.trim() ? out.replace(/\s+$/, "") + "\n\n" : "") + `[model_providers.${providerName}]\n${providerBody}`;
    changes.push(`[model_providers.${providerName}] 已新增(base_url + api_key)`);
  }

  // [models].default:段内 upsert,缺段时追加
  const def = defaultModel && liveIds.has(defaultModel) ? defaultModel : sorted[0].id;
  const modelsSection = locateSection(out, MODELS_SECTION_RE);
  const defaultLine = `default = ${JSON.stringify(def)}`;
  const defaultKeyRe = /^default\s*=.*$/m;
  if (modelsSection) {
    const body = out.slice(modelsSection.bodyStart, modelsSection.bodyEnd);
    if (!defaultKeyRe.test(body)) {
      out = out.slice(0, modelsSection.bodyStart) + defaultLine + "\n" + out.slice(modelsSection.bodyStart);
      changes.push(`默认模型 = "${def}"`);
    } else if (new RegExp(`^default\\s*=\\s*${JSON.stringify(def)}\\s*$`, "m").test(body)) {
      // 已有且一致——无变化
    } else {
      out = out.slice(0, modelsSection.bodyStart) + body.replace(defaultKeyRe, defaultLine) + out.slice(modelsSection.bodyEnd);
      changes.push(`默认模型 = "${def}"`);
    }
  } else {
    out = (out.trim() ? out.replace(/\s+$/, "") + "\n\n" : "") + `[models]\n${defaultLine}\n`;
    changes.push(`默认模型 = "${def}"`);
  }

  changes.push(...merged.changes);
  return { text: out, changes };
}

/**
 * 「仅更新模型列表」:只合并 [model.<id>] 块;provider 段(base_url/api_key)与
 * [models] 其他键一概不动。仅当 [models].default 指向的模型已不在新列表时修正。
 * 未接入(无 [model_providers.<name>] 段)时 providerFound=false。
 */
export function patchGrokModels(
  text: string,
  input: { providerName: string; label: string; models: GrokModel[] },
): { text: string; changes: string[]; providerFound: boolean } {
  const providerRe = escapeRegExp(input.providerName);
  const providerFound = locateSection(text, new RegExp(`^\\[model_providers\\.${providerRe}\\]\\s*$`, "m")) !== null;
  if (!providerFound) return { text, changes: [], providerFound: false };

  const sorted = [...input.models].sort((a, b) => a.id.localeCompare(b.id));
  if (sorted.length === 0) return { text, changes: [], providerFound: true };
  const liveIds = new Set(sorted.map((m) => m.id));
  const merged = applyGrokModelBlocks(text, input.providerName, input.label, sorted);
  let out = merged.text;
  const changes = [...merged.changes];

  const modelsSection = locateSection(out, MODELS_SECTION_RE);
  if (modelsSection) {
    const body = out.slice(modelsSection.bodyStart, modelsSection.bodyEnd);
    const current = body.match(/^default\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    if (current && !liveIds.has(current)) {
      const def = sorted[0].id;
      out = out.slice(0, modelsSection.bodyStart) + body.replace(/^default\s*=.*$/m, `default = ${JSON.stringify(def)}`) + out.slice(modelsSection.bodyEnd);
      changes.push(`默认模型 = "${def}"(原 "${current}" 已不在列表)`);
    }
  }
  return { text: out, changes, providerFound: true };
}

// ---------------------------------------------------------------------------
// 状态诊断(纯解析;CLI/home/auth.json 检测在 flows 层)
// ---------------------------------------------------------------------------

export type GrokStatus = {
  configExists: boolean;
  providerConfigured: boolean;
  providerBaseUrl: string | null;
  providerApiKeySet: boolean;
  providerApiKeyMasked: string | null;
  providerModels: number;
  defaultModel: string | null;
};

/** 从 grok config.toml 文本解析 provider 状态(只读诊断)。 */
export function parseGrokStatus(cfgText: string, providerName: string): GrokStatus {
  const providerRe = escapeRegExp(providerName);

  const providerBlock = locateSection(cfgText, new RegExp(`^\\[model_providers\\.${providerRe}\\]\\s*$`, "m"));
  const providerBody = providerBlock ? cfgText.slice(providerBlock.bodyStart, providerBlock.bodyEnd) : "";
  const apiKey = providerBody.match(/^api_key\s*=\s*"([^"]*)"/m)?.[1] ?? null;
  const modelsSection = locateSection(cfgText, MODELS_SECTION_RE);
  const modelsBody = modelsSection ? cfgText.slice(modelsSection.bodyStart, modelsSection.bodyEnd) : "";

  return {
    configExists: cfgText.trim() !== "",
    providerConfigured: Boolean(providerBlock),
    providerBaseUrl: providerBody.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    providerApiKeySet: Boolean(apiKey),
    providerApiKeyMasked: apiKey ? maskToken(apiKey) : null,
    providerModels: scanModelBlocks(cfgText).filter((b) => b.provider === providerName).length,
    defaultModel: modelsBody.match(/^default\s*=\s*"([^"]+)"/m)?.[1] ?? null,
  };
}
