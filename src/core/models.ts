// 模型元数据:KNOWN_MODELS(已知模型精确规格)+ inferFromId(正则推断兜底)。
// 数据来自通用模型规格(DeepSeek/Qwen/GLM/Kimi/MiniMax/Claude/GPT/Gemini 等),
// 不包含任何公司/网关专属信息。

export type InputType = "text" | "image";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingValue = string | null;

export type CompatConfig = {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  thinkingFormat?: "deepseek" | "qwen";
  requiresReasoningContentOnAssistantMessages?: boolean;
  reasoningEffortMap?: Record<string, string>;
};

export type ModelMeta = {
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  input?: InputType[];
  name?: string;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingValue>>;
  compat?: CompatConfig;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export type ResolvedModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: InputType[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingValue>>;
  compat: CompatConfig;
};

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_COMPAT: CompatConfig = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
};

const KNOWN_MODELS: Record<string, ModelMeta> = {
  // ---- DeepSeek ----
  "deepseek-chat": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true } },
  "deepseek-coder": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true } },
  "deepseek-v3": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true } },
  "deepseek-v3-0324": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true } },
  "deepseek-v3.2": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true } },
  "deepseek-r1": { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } } },
  "deepseek-r1-0528": { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } } },
  "deepseek-reasoner": { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } } },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", contextWindow: 1000000, maxTokens: 384000, reasoning: true, cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 }, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } } },
  "deepseek-v4-flash": { name: "DeepSeek V4 Flash", contextWindow: 1000000, maxTokens: 384000, reasoning: true, cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 }, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } } },
  "deepseek-v3.1-terminus": { contextWindow: 128000, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } } },

  // ---- Qwen ----
  "qwen-max": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen-plus": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen-turbo": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen-long": { contextWindow: 10000000, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen-coder-plus": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen-coder-turbo": { contextWindow: 131072, maxTokens: 8192, reasoning: false, compat: { thinkingFormat: "qwen" } },
  "qwen2.5-72b": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen2.5-32b": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen2.5-14b": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen2.5-7b": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-235b-a22b": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-32b": { contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-14b": { contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-8b": { contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-coder-plus": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-coder-flash": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-max": { contextWindow: 262144, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.6-flash": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.7-max": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.7-plus": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.8-max": { name: "Qwen 3.8 Max Preview", contextWindow: 983616, maxTokens: 131072, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" }, thinkingLevelMap: { off: null } },
  "qwen3-30b-a3b": { name: "Qwen3-30B-A3B (MoE)", contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwq-32b": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.5-flash": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.5-plus": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.6-plus": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen-lastest": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qvq-max": { contextWindow: 32768, maxTokens: 8192, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" } },
  "qwen-vl-max": { contextWindow: 32768, maxTokens: 8192, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" } },
  "qwen-vl-plus": { contextWindow: 32768, maxTokens: 8192, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" } },

  // ---- GLM ----
  "glm-4-plus": { contextWindow: 200000, maxTokens: 8192, reasoning: false },
  "glm-4-air": { contextWindow: 200000, maxTokens: 8192, reasoning: false },
  "glm-4-flash": { contextWindow: 200000, maxTokens: 8192, reasoning: false },
  "glm-4-long": { contextWindow: 1000000, maxTokens: 8192, reasoning: false },
  "glm-4-airx": { contextWindow: 200000, maxTokens: 8192, reasoning: false },
  "glm-4-flashx": { contextWindow: 200000, maxTokens: 8192, reasoning: false },
  "glm-4v-plus": { contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text", "image"] },
  "glm-4v-flash": { contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text", "image"] },
  "glm-4.6v": { contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text", "image"] },
  "glm-4.7": { contextWindow: 200000, maxTokens: 131072, reasoning: true },
  "glm-5": { contextWindow: 200000, maxTokens: 131072, reasoning: true },
  "glm-5.1": { contextWindow: 200000, maxTokens: 131072, reasoning: true },
  "glm-5.2": { contextWindow: 1000000, maxTokens: 131072, reasoning: true },
  "glm-lastest": { contextWindow: 1000000, maxTokens: 131072, reasoning: true },

  // ---- Doubao (ByteDance) ----
  "doubao-pro-256k": { contextWindow: 256000, maxTokens: 16384, reasoning: false },
  "doubao-pro-128k": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
  "doubao-pro-32k": { contextWindow: 32768, maxTokens: 16384, reasoning: false },
  "doubao-lite-128k": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
  "doubao-lite-32k": { contextWindow: 32768, maxTokens: 16384, reasoning: false },
  "doubao-1.5-pro-256k": { contextWindow: 256000, maxTokens: 16384, reasoning: true },
  "doubao-1.5-pro-32k": { contextWindow: 32768, maxTokens: 16384, reasoning: true },
  "doubao-1.5-lite-32k": { contextWindow: 32768, maxTokens: 16384, reasoning: true },
  "doubao-1.5-vision-pro-32k": { contextWindow: 32768, maxTokens: 16384, reasoning: true, input: ["text", "image"] },
  "Doubao-Seed-2.0-Code": { contextWindow: 256000, maxTokens: 16384, reasoning: false },
  "Doubao-Seed-2.0-lite": { contextWindow: 256000, maxTokens: 16384, reasoning: false },
  "Doubao-Seed-2.0-pro": { contextWindow: 256000, maxTokens: 16384, reasoning: false },

  // ---- Moonshot / Kimi ----
  "moonshot-v1-8k": { contextWindow: 8192, maxTokens: 8192, reasoning: false },
  "moonshot-v1-32k": { contextWindow: 32768, maxTokens: 8192, reasoning: false },
  "moonshot-v1-128k": { contextWindow: 128000, maxTokens: 8192, reasoning: false },
  "kimi-k2": { contextWindow: 256000, maxTokens: 8192, reasoning: false },
  "kimi-k2.5": { contextWindow: 256000, maxTokens: 8192, reasoning: true },
  "kimi-k2.6": { contextWindow: 256000, maxTokens: 8192, reasoning: true },
  "kimi-k2.7-code": { contextWindow: 256000, maxTokens: 96000, reasoning: true },
  "kimi-lastest": { contextWindow: 256000, maxTokens: 96000, reasoning: true },
  "kimi-k3": { name: "Kimi K3 (Moonshot 旗舰)", contextWindow: 1048576, maxTokens: 128000, reasoning: true, input: ["text", "image"], cost: { input: 21, output: 108, cacheRead: 2.1, cacheWrite: 0 }, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" } },

  // ---- MiniMax ----
  "abab6.5s-chat": { contextWindow: 245760, maxTokens: 16384, reasoning: false },
  "abab7-chat-preview": { contextWindow: 245760, maxTokens: 16384, reasoning: false },
  "minimax-m1": { contextWindow: 245760, maxTokens: 16384, reasoning: false },
  "MiMo-V2.5": { contextWindow: 204800, maxTokens: 32768, reasoning: true },
  "MiMo-V2.5-Pro": { name: "MiMo V2.5 Pro (Xiaomi 旗舰)", contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
  "MiniMax-M2.5": { contextWindow: 204800, maxTokens: 32768, reasoning: true },
  "MiniMax-M2.7": { contextWindow: 204800, maxTokens: 32768, reasoning: true },
  "MiniMax-M2.7-highspeed": { contextWindow: 204800, maxTokens: 32768, reasoning: true },
  "MiniMax-M3": { name: "MiniMax M3", contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
  "MiniMax-lastest": { contextWindow: 1000000, maxTokens: 32768, reasoning: true },

  // ---- Anthropic Claude ----
  "claude-3-opus-20240229": { contextWindow: 200000, maxTokens: 4096, reasoning: false, input: ["text", "image"] },
  "claude-3.5-sonnet-20241022": { contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text", "image"] },
  "claude-3.5-haiku-20241022": { contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text", "image"] },
  "claude-3.7-sonnet-20250219": { contextWindow: 200000, maxTokens: 8192, reasoning: true, input: ["text", "image"] },
  "claude-4-sonnet-20250514": { contextWindow: 200000, maxTokens: 16384, reasoning: true, input: ["text", "image"] },
  "claude-haiku-4.5": { contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
  "claude-sonnet-4-6": { contextWindow: 1000000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
  "claude-opus-4-6": { contextWindow: 1000000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
  "claude-4.8-opus": { contextWindow: 1000000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
  "claude-sonnet-5": { contextWindow: 1000000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },

  // ---- OpenAI ----
  "gpt-4o": { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text", "image"] },
  "gpt-4o-mini": { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text", "image"] },
  "gpt-4.1": { contextWindow: 1000000, maxTokens: 32768, reasoning: false, input: ["text", "image"] },
  "gpt-4.1-mini": { contextWindow: 1000000, maxTokens: 32768, reasoning: false, input: ["text", "image"] },
  "o4-mini": { contextWindow: 200000, maxTokens: 100000, reasoning: true, input: ["text", "image"] },
  "o3": { contextWindow: 200000, maxTokens: 100000, reasoning: true, input: ["text", "image"] },
  "gpt-5.6-luna": { contextWindow: 400000, maxTokens: 100000, reasoning: true, input: ["text", "image"] },
  "gpt-5.6-terra": { contextWindow: 400000, maxTokens: 100000, reasoning: true, input: ["text", "image"] },

  // ---- Google Gemini ----
  "gemini-2.5-pro-preview": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  "gemini-2.5-flash": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  "gemini-3.1-pro-preview": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  "gemini-3.5-flash": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"] },

  // ---- Tencent Hunyuan ----
  "hy3-preview": { contextWindow: 262144, maxTokens: 16384, reasoning: false },
  "hy3": { contextWindow: 262144, maxTokens: 16384, reasoning: false },

  // ---- StepFun ----
  "step-3.7-flash": { name: "Step 3.7 Flash (StepFun)", contextWindow: 262144, maxTokens: 262144, reasoning: true, input: ["text", "image"], cost: { input: 1.44, output: 8.28, cacheRead: 0.29, cacheWrite: 0 }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" } },

  // ---- Gitee AI ----
  "gitee-ai-deepseek-v3": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true } },
  "gitee-ai-deepseek-r1": { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } } },

  // ---- 网关路由伪模型 ----
  "Recommend": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
};

interface InferredMeta {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingValue>>;
  compat: CompatConfig;
  input: InputType[];
  contextWindow: number;
  maxTokens: number;
}

function inferFromId(id: string): InferredMeta {
  const lower = id.toLowerCase();
  const isVision = /vl|vision|glm-4v|glm-4\.\d+v|qvq/i.test(lower) || /claude|gemini|gpt-4o|o\d/i.test(lower);

  if (/deepseek.*r1|deepseek-reasoner/i.test(lower)) {
    return {
      reasoning: true,
      compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } },
      input: isVision ? ["text", "image"] : ["text"],
      contextWindow: 131072,
      maxTokens: 32768,
    };
  }
  if (/deepseek/i.test(lower)) {
    return { reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true }, input: isVision ? ["text", "image"] : ["text"], contextWindow: 128000, maxTokens: 8192 };
  }
  if (/qwen/i.test(lower)) {
    return { reasoning: true, compat: { thinkingFormat: "qwen" }, input: isVision ? ["text", "image"] : ["text"], contextWindow: 1000000, maxTokens: 65536 };
  }
  if (/kimi/i.test(lower)) {
    return { reasoning: true, compat: {}, input: isVision ? ["text", "image"] : ["text"], contextWindow: 256000, maxTokens: 96000 };
  }
  if (/glm/i.test(lower)) {
    return { reasoning: false, compat: {}, input: isVision ? ["text", "image"] : ["text"], contextWindow: 200000, maxTokens: 8192 };
  }
  if (/doubao/i.test(lower)) {
    return { reasoning: /1\.5/i.test(lower), compat: {}, input: isVision ? ["text", "image"] : ["text"], contextWindow: 256000, maxTokens: 16384 };
  }
  if (/claude|gpt|gemini|o\d/i.test(lower)) {
    return { reasoning: /sonnet-4|o\d|o4/i.test(lower), compat: {}, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384 };
  }
  return { reasoning: false, compat: {}, input: ["text"], contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS };
}

function mergeCompat(...parts: Array<CompatConfig | undefined>): CompatConfig {
  return Object.assign({}, DEFAULT_COMPAT, ...parts);
}

function resolveModel(id: string): ResolvedModel {
  const known = KNOWN_MODELS[id];
  const inferred = inferFromId(id);
  const reasoning = known?.reasoning ?? inferred.reasoning ?? false;
  const thinkingLevelMap = known?.thinkingLevelMap ?? inferred.thinkingLevelMap;
  const modelCompat = mergeCompat(inferred.compat, known?.compat);
  const input: InputType[] = known?.input ?? inferred.input ?? ["text"];
  const contextWindow = known?.contextWindow ?? inferred.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = known?.maxTokens ?? inferred.maxTokens ?? DEFAULT_MAX_TOKENS;
  const name = known?.name ?? id;

  return {
    id,
    name,
    reasoning,
    input,
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    thinkingLevelMap,
    compat: modelCompat,
  };
}

/** 把模型 id 列表解析为完整元数据(已知模型精确规格,未知模型按 id 正则推断)。 */
export function buildResolvedModels(ids: string[]): ResolvedModel[] {
  return ids.map((id) => resolveModel(id)).sort((a, b) => a.id.localeCompare(b.id));
}

/** 由 provider 名派生凭据环境变量名(对齐 dsh 官方 deriveKeyRef 规则)。 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
