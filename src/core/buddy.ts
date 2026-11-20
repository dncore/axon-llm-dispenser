// WorkBuddy / CodeBuddy 自定义模型配置(models.json)。
//
// 官方格式(CodeBuddy 文档「models.json 配置指南」):
//   用户级 ~/.codebuddy/models.json、项目级 <workspace>/.codebuddy/models.json;
//   { "models": [ { id, name, vendor, apiKey, maxInputTokens, maxOutputTokens,
//                   url(完整 chat/completions 地址), supportsToolCall, supportsImages,
//                   supportsReasoning } ], "availableModels": [id…] }
//   availableModels 缺省/空 = 下拉显示全部;非空 = 只显示列出的 id。
//
// WorkBuddy 用同一套条目 schema,但存储层(ModelsJsonStorage)把文件写成**裸数组**;
// 读取时两种顶层形态都接受(Array.isArray(v) ? v : v.models)。因此:
//   - 新文件按各自形态生成(WorkBuddy 数组 / CodeBuddy 信封);
//   - 已有文件保形写回,不擅自改顶层形态。
//
// 条目还有两个官方文档未列、但客户端自己会写的字段(WorkBuddy「自定义模型」表单 /
// cli.mjs 的 deriveReasoningCapabilities 已核实):
//   - thinkingLevelMap:{ off|minimal|low|medium|high|xhigh|max → 线上档位名|null }
//     xhigh/max 必须显式给值才算可用,null = 该档不可用;
//   - reasoning:{ defaultEffort?, supportedEfforts[], canDisableThinking? }
//     由 thinkingLevelMap 推导:supportedEfforts = 去掉 off 的可用档,
//     canDisableThinking = off 档可用。
//   不写这两项时客户端按「除 xhigh/max 外全档可用」推断,会给不支持关思考的模型
//   开放 off 档(网关侧表现为 400/REFUSAL)。故这里按模型表原样写入。

import type { ResolvedModel, ThinkingLevel, ThinkingValue } from "./models";

/** 被管理的两个客户端。 */
export type BuddyKind = "workbuddy" | "codebuddy";

/** 顶层形态:裸数组(WorkBuddy 自写) / 对象信封(CodeBuddy 文档格式)。 */
export type BuddyShape = "array" | "envelope";

/** 客户端自己的思考档位顺序(cli.mjs: off, minimal, low, medium, high, xhigh, max)。 */
const BUDDY_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type BuddyReasoning = {
  supportedEfforts: string[];
  canDisableThinking: boolean;
};

/** 一个 models.json 条目(字段顺序与官方 schema 一致,url 为完整 chat/completions 地址)。 */
export type BuddyModelEntry = {
  id: string;
  name: string;
  vendor: string;
  apiKey?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  url: string;
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  useCustomProtocol?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingValue>>;
  reasoning?: BuddyReasoning;
  /** 客户端可能写入的其它字段(disabled/tags/local/temperature…):合并时原样保留。 */
  [key: string]: unknown;
};

/** 网关 base → 条目 url:客户端要求完整 /chat/completions 地址(裸 base 会被它自动补全)。 */
export function chatCompletionsUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "") + "/chat/completions";
}

/** 条目 url → base(去掉结尾 /chat/completions),用于配置一致性比对。 */
export function stripChatCompletions(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  return url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/**
 * 按客户端自己的算法推导 reasoning 子对象(cli.mjs 的 deriveReasoningCapabilities):
 * - 非推理模型(thinkingLevelMap 缺失或模型 reasoning=false)→ 不写;
 * - 某档映射为 null → 该档不可用;xhigh/max 必须显式给值才算可用;
 * - canDisableThinking = off 档可用。
 */
export function deriveBuddyReasoning(
  map: Partial<Record<ThinkingLevel, ThinkingValue>> | undefined,
  reasoning: boolean,
): BuddyReasoning | undefined {
  if (!reasoning || !map) return undefined;
  const usable = BUDDY_LEVELS.filter((level) => {
    const wire = map[level];
    if (wire === null) return false;
    if (level === "xhigh" || level === "max") return wire !== undefined;
    return true;
  });
  return {
    supportedEfforts: usable.filter((l) => l !== "off"),
    canDisableThinking: usable.includes("off"),
  };
}

/** 由模型元数据构造一条条目(auth 可留空 = 只更新模型字段时保留原值)。 */
export function buildBuddyEntry(
  m: ResolvedModel,
  vendor: string,
  url: string,
  apiKey: string,
): BuddyModelEntry {
  const entry: BuddyModelEntry = {
    id: m.id,
    name: m.name && m.name !== m.id ? m.name : m.id,
    vendor,
    maxInputTokens: m.contextWindow,
    maxOutputTokens: m.maxTokens,
    url,
    supportsToolCall: true,
    supportsImages: m.input.includes("image"),
    supportsReasoning: m.reasoning,
  };
  if (apiKey) entry.apiKey = apiKey;
  if (m.thinkingLevelMap && Object.keys(m.thinkingLevelMap).length > 0) entry.thinkingLevelMap = { ...m.thinkingLevelMap };
  const reasoning = deriveBuddyReasoning(m.thinkingLevelMap, m.reasoning);
  if (reasoning) entry.reasoning = reasoning;
  return entry;
}

// ---------------------------------------------------------------------------
// 解析 / 序列化(保形)
// ---------------------------------------------------------------------------

export type BuddyFile = {
  shape: BuddyShape;
  /** 信封形态的顶层对象(数组形态时为 null)。 */
  envelope: Record<string, unknown> | null;
  entries: BuddyModelEntry[];
};

/** 解析 models.json:空文本 = 新文件;非法 JSON 抛错(与 pi 的 models.json 处理一致)。 */
export function parseBuddyFile(text: string, kind: BuddyKind, path: string): BuddyFile {
  const shape: BuddyShape = kind === "workbuddy" ? "array" : "envelope";
  if (!text.trim()) return { shape, envelope: shape === "envelope" ? {} : null, entries: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (Array.isArray(parsed)) {
    return { shape: "array", envelope: null, entries: parsed.filter(isEntry) };
  }
  if (parsed && typeof parsed === "object") {
    const doc = parsed as Record<string, unknown>;
    const list = Array.isArray(doc.models) ? doc.models : [];
    return { shape: "envelope", envelope: doc, entries: list.filter(isEntry) };
  }
  throw new Error(`${path} 顶层既不是数组也不是对象`);
}

function isEntry(v: unknown): v is BuddyModelEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && e.id.length > 0;
}

/** 按原形态序列化(2 空格缩进 + 结尾换行,与客户端一致)。 */
export function serializeBuddyFile(file: BuddyFile): string {
  if (file.shape === "array") return JSON.stringify(file.entries, null, 2) + "\n";
  const envelope: Record<string, unknown> = {};
  // models 放最前,其余顶层键原序保留
  envelope.models = file.entries;
  for (const [k, v] of Object.entries(file.envelope ?? {})) {
    if (k !== "models") envelope[k] = v;
  }
  return JSON.stringify(envelope, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// 写入 / 仅刷新模型
// ---------------------------------------------------------------------------

export type BuddyPatchInput = {
  kind: BuddyKind;
  /** 归属标记:本工具写入条目的 vendor(客户端把它当「供应商」展示名)。 */
  vendor: string;
  baseUrl: string;
  apiKey: string;
  models: ResolvedModel[];
  path: string;
};

export type BuddyPatchResult = {
  text: string;
  changes: string[];
  /** 同 id 已被外来条目占用而跳过的模型(不覆盖用户配置)。 */
  skipped: string[];
  /** 本次写入后属于本工具的条目数。 */
  managed: number;
};

/**
 * 生成/更新 models.json:
 * - 本工具条目(vendor 匹配)按 id 合并:已存在的只覆盖管理字段,条目内其它键保留;
 * - 网关已下架的条目(vendor 匹配但 id 不在列表)移除;
 * - 同 id 的外来条目**跳过并计数**(官方 SmartMerge 是覆盖语义,但那是用户手写的配置,
 *   这里不静默覆盖);
 * - CodeBuddy 信封的 availableModels:已存在且非空时追加缺失的新 id(空/缺省 = 显示全部,不动);
 * - 顶层形态保形(WorkBuddy 新文件写裸数组,CodeBuddy 写信封)。
 */
export function patchBuddyModels(text: string, input: BuddyPatchInput): BuddyPatchResult {
  const file = parseBuddyFile(text, input.kind, input.path);
  const liveIds = new Set(input.models.map((m) => m.id));
  const url = chatCompletionsUrl(input.baseUrl);

  const ours = file.entries.filter((e) => e.vendor === input.vendor);
  const foreignIds = new Set(file.entries.filter((e) => e.vendor !== input.vendor).map((e) => e.id));
  const stale = ours.filter((e) => !liveIds.has(e.id));
  const staleIds = new Set(stale.map((e) => e.id));

  const skipped: string[] = [];
  const next: BuddyModelEntry[] = [];
  let added = 0;
  let updated = 0;

  for (const entry of file.entries) {
    if (entry.vendor === input.vendor && staleIds.has(entry.id)) continue; // 下架移除
    next.push(entry);
  }

  for (const m of input.models) {
    const own = ours.find((e) => e.id === m.id);
    const fresh = buildBuddyEntry(m, input.vendor, url, input.apiKey);
    if (own) {
      // 覆盖管理字段,保留条目内的其它键(disabled/tags/temperature…);值没变则不计「更新」
      const idx = next.findIndex((e) => e.vendor === input.vendor && e.id === m.id);
      const merged = { ...own, ...fresh };
      if (JSON.stringify(merged) !== JSON.stringify(own)) updated++;
      next[idx] = merged;
      continue;
    }
    if (foreignIds.has(m.id)) {
      skipped.push(m.id);
      continue;
    }
    next.push(fresh);
    added++;
  }

  const changes: string[] = [];
  if (added > 0) changes.push(`新增 ${added} 个模型条目`);
  if (updated > 0) changes.push(`更新 ${updated} 个模型条目`);
  if (stale.length > 0) changes.push(`移除 ${stale.length} 个已下架条目`);
  if (skipped.length > 0) {
    changes.push(`跳过 ${skipped.length} 个同 id 外来条目(${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""})`);
  }

  // CodeBuddy 的 availableModels:只在「已存在且非空」时追加,避免把用户的过滤列表清空
  if (input.kind === "codebuddy" && file.envelope) {
    const avail = file.envelope.availableModels;
    if (Array.isArray(avail) && avail.length > 0) {
      const have = new Set(avail.filter((x): x is string => typeof x === "string"));
      const missing = input.models.map((m) => m.id).filter((id) => !have.has(id));
      if (missing.length > 0) {
        file.envelope.availableModels = [...(avail as string[]), ...missing];
        changes.push(`availableModels 追加 ${missing.length} 个 id`);
      }
    }
  }

  const managed = next.filter((e) => e.vendor === input.vendor).length;
  return {
    text: serializeBuddyFile({ shape: file.shape, envelope: file.envelope, entries: next }),
    changes,
    skipped,
    managed,
  };
}

/**
 * 「仅更新模型列表」:只合并模型字段,url / apiKey 一律沿用文件里的现值(不传新值)。
 * 未接入(没有本工具条目)时 managed=0,调用方据此跳过。
 */
export function patchBuddyModelList(text: string, input: BuddyPatchInput): BuddyPatchResult {
  const file = parseBuddyFile(text, input.kind, input.path);
  const ours = file.entries.filter((e) => e.vendor === input.vendor);
  if (ours.length === 0) {
    return { text, changes: [], skipped: [], managed: 0 };
  }
  // 刷新场景:保留每条的 url/apiKey(取本工具条目的现值)
  const src = ours[0];
  return patchBuddyModels(text, {
    ...input,
    baseUrl: stripChatCompletions(typeof src.url === "string" ? src.url : null) ?? input.baseUrl,
    apiKey: typeof src.apiKey === "string" ? src.apiKey : input.apiKey,
  });
}

// ---------------------------------------------------------------------------
// 状态 / 一致性检测(纯解析)
// ---------------------------------------------------------------------------

export type BuddyStatus = {
  exists: boolean;
  shape: BuddyShape | null;
  managed: number;
  baseUrl: string | null;
  apiKeySet: boolean;
  /** 明文密钥(仅用于 maskToken 展示)。 */
  apiKey: string | null;
  availableModels: number | null;
  /** 同 id 外来条目数(会盖住本工具条目,状态里提示)。 */
  foreignSameId: number;
};

export function parseBuddyStatus(text: string, vendor: string): BuddyStatus {
  let file: BuddyFile;
  try {
    file = parseBuddyFile(text, "codebuddy", "models.json"); // kind 只影响空文件形态,解析两形态都认
  } catch {
    return { exists: text.trim().length > 0, shape: null, managed: 0, baseUrl: null, apiKeySet: false, apiKey: null, availableModels: null, foreignSameId: 0 };
  }
  const ours = file.entries.filter((e) => e.vendor === vendor);
  const first = ours[0];
  const apiKey = typeof first?.apiKey === "string" && first.apiKey ? first.apiKey : null;
  const avail = file.envelope?.availableModels;
  return {
    exists: text.trim().length > 0,
    shape: text.trim() ? file.shape : null,
    managed: ours.length,
    baseUrl: stripChatCompletions(typeof first?.url === "string" ? first.url : null),
    apiKeySet: apiKey !== null,
    apiKey,
    availableModels: Array.isArray(avail) ? avail.length : null,
    foreignSameId: ours.filter((e) => file.entries.some((o) => o.vendor !== vendor && o.id === e.id)).length,
  };
}

/** 配置一致性:本工具条目里第一条的 base/Key(与 compareAgentConfig 对齐)。 */
export function extractBuddyProvider(text: string, vendor: string): { baseUrl: string | null; apiKey: string | null } {
  try {
    const file = parseBuddyFile(text, "codebuddy", "models.json");
    const first = file.entries.find((e) => e.vendor === vendor);
    return {
      baseUrl: stripChatCompletions(typeof first?.url === "string" ? first.url : null),
      apiKey: typeof first?.apiKey === "string" && first.apiKey ? first.apiKey : null,
    };
  } catch {
    return { baseUrl: null, apiKey: null };
  }
}
