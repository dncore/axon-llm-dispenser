// 模型元数据:KNOWN_MODELS(已知模型精确规格)+ inferFromId(正则推断兜底)。
// 数据来自通用模型规格(DeepSeek/Qwen/GLM/Kimi/MiniMax/Claude/GPT/Gemini 等),
// KNOWN_MODELS 表段本身不包含任何公司/网关专属信息;网关侧已知缺陷的请求形状修正
// 单独放在表段之外的「网关兼容层」(见 GATEWAY_OVERLAYS),不受 canonical gist 同步覆盖。

export type InputType = "text" | "image";
/** pi 的实际档位集(含 max;见 @earendil-works/pi-coding-agent ThinkingLevelMapSchema)。
 * canonical gist 表只允许前 6 档(scripts/sync-model-meta.mjs 的 levels 校验),max 档
 * 目前只有下面的网关兼容层会写 —— 少一档就意味着该档请求省略 reasoning_effort。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
  /** 官方已下架:列举场景排除,查找场景保留 */
  deprecated?: boolean;
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

// @model-meta:begin — 由 scripts/sync-model-meta.mjs 从 canonical gist 生成,勿手改
// canonical: gist b8931f4c @ 31842f55 · 143 models
const KNOWN_MODELS: Record<string, ModelMeta> = {
  "deepseek-chat": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true }, deprecated: true },
  "deepseek-coder": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true }, deprecated: true },
  "deepseek-v3": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true }, deprecated: true },
  "deepseek-v3-0324": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true }, deprecated: true },
  "deepseek-v3.2": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true }, deprecated: true },
  "deepseek-r1": { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } }, deprecated: true },
  "deepseek-r1-0528": { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } }, deprecated: true },
  "deepseek-reasoner": { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } }, deprecated: true },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", contextWindow: 1000000, maxTokens: 384000, reasoning: true, cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 }, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } }, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } },
  "deepseek-v4-flash": { name: "DeepSeek V4 Flash", contextWindow: 1000000, maxTokens: 384000, reasoning: true, cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 }, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } }, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } },
  "deepseek-v4-flash-vision-exp": { name: "DeepSeek V4 Flash Vision (Exp)", contextWindow: 1000000, maxTokens: 384000, reasoning: true, input: ["text", "image"], cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 }, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } }, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } },
  "deepseek-v4-pro-0813": { name: "DeepSeek V4 Pro (0813)", contextWindow: 1000000, maxTokens: 384000, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { low: "low", high: "high", xhigh: "max" } }, thinkingLevelMap: { minimal: null, low: "low", medium: "high", high: "high", xhigh: "max" }, cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 } },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", contextWindow: 1000000, maxTokens: 384000, reasoning: true, input: ["text", "image"], compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { low: "low", high: "high", xhigh: "max" } }, thinkingLevelMap: { minimal: null, low: "low", medium: "high", high: "high", xhigh: "max" }, cost: { input: 0.14, output: 0.56, cacheRead: 0.003, cacheWrite: 0 } },
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
  "qwen3-235b-a22b": { contextWindow: 131072, maxTokens: 16384, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-32b": { contextWindow: 32768, maxTokens: 16384, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-14b": { contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-8b": { contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-coder-plus": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-coder-flash": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3-max": { contextWindow: 262144, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.6-flash": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.7-max": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.7-plus": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.7-flash": { contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" } },
  "qwen3.8-max": { name: "Qwen 3.8 Max Preview", contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" }, thinkingLevelMap: { off: null } },
  "qwen3.8-flash": { name: "Qwen3.8 Flash", contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text"], cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 }, compat: { thinkingFormat: "qwen" } },
  "qwen3-30b-a3b": { name: "Qwen3-30B-A3B (MoE)", contextWindow: 131072, maxTokens: 16384, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwq-32b": { contextWindow: 131072, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.5-flash": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.5-plus": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen3.6-plus": { contextWindow: 1000000, maxTokens: 65536, reasoning: true, compat: { thinkingFormat: "qwen" } },
  "qwen-lastest": { name: "Qwen 3.8 Max Preview", contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" }, thinkingLevelMap: { off: null } },
  "qvq-max": { contextWindow: 32768, maxTokens: 8192, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" } },
  "qwen-vl-max": { contextWindow: 32768, maxTokens: 8192, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" } },
  "qwen-vl-plus": { contextWindow: 32768, maxTokens: 8192, reasoning: true, input: ["text", "image"], compat: { thinkingFormat: "qwen" } },
  "glm-4": { contextWindow: 131072, maxTokens: 8192, reasoning: false, deprecated: true },
  "glm-4-plus": { contextWindow: 200000, maxTokens: 8192, reasoning: false, deprecated: true },
  "glm-4-air": { contextWindow: 200000, maxTokens: 8192, reasoning: false, deprecated: true },
  "glm-4-flash": { contextWindow: 200000, maxTokens: 8192, reasoning: false },
  "glm-4-long": { contextWindow: 1000000, maxTokens: 4096, reasoning: false },
  "glm-4-airx": { contextWindow: 200000, maxTokens: 8192, reasoning: false, deprecated: true },
  "glm-4-flashx": { contextWindow: 200000, maxTokens: 8192, reasoning: false },
  "glm-4v-plus": { contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text", "image"], deprecated: true },
  "glm-4v-flash": { contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text", "image"] },
  "glm-4.6v": { contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ["text", "image"] },
  "glm-4.7": { contextWindow: 200000, maxTokens: 131072, reasoning: true },
  "glm-5": { contextWindow: 200000, maxTokens: 131072, reasoning: true },
  "glm-5.1": { contextWindow: 200000, maxTokens: 131072, reasoning: true },
  "glm-5.2": { contextWindow: 1048576, maxTokens: 131072, reasoning: true, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" } },
  "glm-5.3": { contextWindow: 1048576, maxTokens: 131072, reasoning: true, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" } },
  "glm-5.3-flash": { name: "GLM-5.3 Flash", contextWindow: 1048576, maxTokens: 131072, reasoning: true, input: ["text", "image"], cost: { input: 0.8, output: 2.8, cacheRead: 0, cacheWrite: 0 }, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" } },
  "glm-lastest": { contextWindow: 1048576, maxTokens: 131072, reasoning: true, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" } },
  "doubao-pro": { contextWindow: 128000, maxTokens: 16384, reasoning: true },
  "doubao-lite": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
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
  "moonshot-v1-8k": { contextWindow: 8192, maxTokens: 8192, reasoning: false, deprecated: true },
  "moonshot-v1-32k": { contextWindow: 32768, maxTokens: 8192, reasoning: false, deprecated: true },
  "moonshot-v1-128k": { contextWindow: 128000, maxTokens: 8192, reasoning: false, deprecated: true },
  "kimi-k2": { contextWindow: 262144, maxTokens: 8192, reasoning: false, deprecated: true },
  "kimi-k2.5": { contextWindow: 262144, maxTokens: 8192, reasoning: true, deprecated: true },
  "kimi-k2.6": { contextWindow: 262144, maxTokens: 8192, reasoning: true },
  "kimi-k2.7-code": { contextWindow: 262144, maxTokens: 96000, reasoning: true, name: "Kimi K2.7 Code" },
  "kimi-k2.8": { name: "Kimi K2.8 Preview", contextWindow: 1048576, maxTokens: 32768, reasoning: true, input: ["text", "image"], compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" } },
  "kimi-lastest": { name: "Kimi K3 (Moonshot 旗舰)", contextWindow: 1048576, maxTokens: 128000, reasoning: true, input: ["text", "image"], cost: { input: 21, output: 108, cacheRead: 2.1, cacheWrite: 0 }, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" } },
  "kimi-k3": { name: "Kimi K3 (Moonshot 旗舰)", contextWindow: 1048576, maxTokens: 128000, reasoning: true, input: ["text", "image"], cost: { input: 21, output: 108, cacheRead: 2.1, cacheWrite: 0 }, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" } },
  "abab6.5s-chat": { contextWindow: 245760, maxTokens: 16384, reasoning: false },
  "abab7-chat-preview": { contextWindow: 245760, maxTokens: 16384, reasoning: false },
  "minimax-m1": { contextWindow: 245760, maxTokens: 16384, reasoning: false },
  "MiMo-V2.5": { contextWindow: 204800, maxTokens: 32768, reasoning: true },
  "MiMo-V2.5-Pro": { name: "MiMo V2.5 Pro (Xiaomi 旗舰)", contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
  "mimo-v2.6-pro": { name: "MiMo V2.6 Pro (Xiaomi 旗舰)", contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text", "image"] },
  "mimo-v2.6-flash": { contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text", "image"] },
  "MiniMax-M2.5": { contextWindow: 204800, maxTokens: 32768, reasoning: true },
  "MiniMax-M2.7": { contextWindow: 204800, maxTokens: 32768, reasoning: true },
  "MiniMax-M2.7-highspeed": { contextWindow: 204800, maxTokens: 32768, reasoning: true },
  "MiniMax-M3": { name: "MiniMax M3", contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
  "MiniMax-M3.1-Flash": { name: "MiniMax M3.1 Flash", contextWindow: 1000000, maxTokens: 524288, reasoning: true, input: ["text", "image"], compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max" } },
  "MiniMax-lastest": { name: "MiniMax M3", contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
  "claude-3-opus-20240229": { contextWindow: 200000, maxTokens: 4096, reasoning: false, input: ["text", "image"], deprecated: true },
  "claude-3.5-sonnet-20241022": { contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text", "image"], deprecated: true },
  "claude-3.5-haiku-20241022": { contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text", "image"], deprecated: true },
  "claude-3.7-sonnet-20250219": { contextWindow: 200000, maxTokens: 8192, reasoning: true, input: ["text", "image"], deprecated: true },
  "claude-4-sonnet-20250514": { contextWindow: 200000, maxTokens: 16384, reasoning: true, input: ["text", "image"], deprecated: true },
  "claude-haiku-4.5": { contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
  "claude-sonnet-4-6": { contextWindow: 1000000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
  "claude-opus-4-6": { contextWindow: 1000000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
  "claude-4.8-opus": { contextWindow: 1000000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
  "claude-sonnet-5": { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"], name: "Claude Sonnet 5" },
  "claude-opus-5": { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  "claude-haiku-5.5": { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  "claude-sonnet-5.5": { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  "claude-opus-5.5": { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  "gpt-4o": { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text", "image"] },
  "gpt-4o-mini": { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text", "image"] },
  "gpt-4.1": { contextWindow: 1000000, maxTokens: 32768, reasoning: false, input: ["text", "image"] },
  "gpt-4.1-mini": { contextWindow: 1000000, maxTokens: 32768, reasoning: false, input: ["text", "image"] },
  "o4-mini": { contextWindow: 200000, maxTokens: 100000, reasoning: true, input: ["text", "image"], deprecated: true },
  "o3": { contextWindow: 200000, maxTokens: 100000, reasoning: true, input: ["text", "image"], deprecated: true },
  "gpt-5.6-luna": { contextWindow: 400000, maxTokens: 100000, reasoning: true, input: ["text", "image"] },
  "gpt-5.6-terra": { contextWindow: 400000, maxTokens: 100000, reasoning: true, input: ["text", "image"] },
  "gpt-5.6-sol": { contextWindow: 1050000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
  "gpt-6-luna": { contextWindow: 1050000, maxTokens: 128000, reasoning: true, input: ["text", "image"], cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, compat: { maxTokensField: "max_completion_tokens" } },
  "gpt-6-sol": { contextWindow: 1050000, maxTokens: 128000, reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, compat: { maxTokensField: "max_completion_tokens" } },
  "gpt-6.1-sol": { contextWindow: 1050000, maxTokens: 128000, reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, compat: { maxTokensField: "max_completion_tokens" } },
  "gemini-2.5-pro-preview": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  "gemini-2.5-flash": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  "gemini-3.1-pro-preview": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  "gemini-3.5-flash": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
  "gemini-3.6-flash": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high" } },
  "gemini-3.7-flash": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" } },
  "gemini-3.8-flash": { contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high" } },
  "grok-4.6": { name: "Grok 4.6 (xAI)", contextWindow: 500000, maxTokens: 500000, reasoning: true, input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" } },
  "grok-4.7": { name: "Grok 4.7 (xAI)", contextWindow: 500000, maxTokens: 500000, reasoning: true, input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }, compat: { supportsReasoningEffort: true }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" } },
  "hy3-preview": { contextWindow: 262144, maxTokens: 16384, reasoning: false },
  "hy3": { contextWindow: 262144, maxTokens: 16384, reasoning: false },
  "hy4": { contextWindow: 262144, maxTokens: 16384, reasoning: false },
  "step-3.7-flash": { name: "Step 3.7 Flash (StepFun)", contextWindow: 262144, maxTokens: 262144, reasoning: true, input: ["text", "image"], cost: { input: 1.44, output: 8.28, cacheRead: 0.29, cacheWrite: 0 }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" } },
  "step-5-preview": { name: "Step 5 Preview (StepFun)", contextWindow: 1048576, maxTokens: 65536, reasoning: true, input: ["text", "image"], cost: { input: 7, output: 20, cacheRead: 0.35, cacheWrite: 0 }, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" } },
  "deepseek-v3.1-terminus": { contextWindow: 128000, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } }, deprecated: true },
  "gitee-ai-deepseek-v3": { contextWindow: 128000, maxTokens: 8192, reasoning: false, compat: { requiresReasoningContentOnAssistantMessages: true } },
  "gitee-ai-deepseek-r1": { contextWindow: 131072, maxTokens: 32768, reasoning: true, compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" } } },
  "Recommend": { contextWindow: 128000, maxTokens: 16384, reasoning: false },
};
// @model-meta:end

// ---------------------------------------------------------------------------
// 网关兼容层:canonical gist 表(@model-meta 表段)只记模型官方规格,这里放
// 「某模型经某网关渠道实测后的请求形状修正」。它不是模型规格,所以不入 canonical、
// 不参与 sync:models / check:models;渠道或网关修好后删掉对应条目即回到原生行为。
// ---------------------------------------------------------------------------

export type GatewayOverlay = {
  /** 修正理由 + 实测证据 + 失效条件。改这条必须连证据一起更新,否则后人无法判断能否删。 */
  reason: string;
  compat?: CompatConfig;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, ThinkingValue>>;
  /** 该修正是「全档位强制关思考」:模型在本网关带工具时拿不到思考输出。
   * 标记出来供 UI 提示与默认模型挑选跳过(别再让用户以为它是常规推理模型)。 */
  thinkingDisabled?: boolean;
};

/** 只按精确 id 匹配:正则误伤一个模型的思考档位,比漏配一条更难排查。 */
const GATEWAY_OVERLAYS: Record<string, GatewayOverlay> = {
  "gpt-6-luna": {
    reason:
      "迈金网关 gpt-6-luna 的 shim 保留:该 id 只接受 none/low/medium/high/xhigh 五个档位" +
      "(发 minimal 或 max → 400「Unsupported value: 'reasoning_effort' does not support 'minimal' with this model」)," +
      "所以档位表把 minimal 落成 low、xhigh 原样保留,不给客户端发被拒的值。" +
      "历史:2026-09-24/29 实测 tools×effort 互斥、省略即 400,tools 回合必须显式发 none,本条曾把**所有**档位映射成 none;" +
      "2026-10-10 复测该互斥已不成立(带 tools 时 none/low/high/省略均为 200 且出 finish_reason=tool_calls)," +
      "因此去掉「全档位 none」与 thinkingDisabled —— 该模型在带工具的回合现在**能正常思考**," +
      "不再需要(也不应该)在配置层把用户选的档位改写成关思考。" +
      "采样参数仍由代理/客户端侧按 id 规则处理(temperature 只接受默认 1、top_p 时好时坏,见 src-tauri 的 gpt6_caps)," +
      "不进本表。失效条件:上游把 minimal/max 也接受后可删除本条。",
    compat: { supportsReasoningEffort: true },
    // 7 档全写:漏掉某一档 = 该档请求不带 reasoning_effort,而带工具的回合需要显式档位。
    thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" },
  },
  // Sol 与 luna 相反:这一族**拒收** none。实测 2026-10-10(每个形状 4 次,带 function tool):
  //   - reasoning_effort="none" → 4/4 400「GPT-6: gpt-6.1-sol reasoning effort must be low,
  //     medium, high, xhigh, or max」;
  //   - 省略该参数 → gpt-6-sol 3/4 400(同一请求第二个渠道又 200,即渠道间不一致);
  //   - 显式 "low" → 4/4 200 出 tool_calls;
  //   - 带 tools 时 temperature/top_p → 4/4 400(不带工具时两者都收)。
  // 所以配置里必须让客户端**恒发**一个 low..max 的档位:off/minimal 落到底限 low(该 id
  // 没有真正的「关思考」档,发 none 只会 400),并且不能带采样参数(采样参数由代理/客户端
  // 侧剥,见 src-tauri 的 gpt6_caps)。
  // 失效条件:上游给该族补上 none 档、或渠道统一后,删除本条即回到 canonical 形状。
  "gpt-6-sol": {
    reason:
      "迈金网关 gpt-6-sol(owned_by 七牛,错误信息显示实际由 gpt-6.1-sol 后端服务)带 function tools 时拒收 " +
      "reasoning_effort=\"none\"(400「must be low, medium, high, xhigh, or max」),省略该参数也不稳(4 次里 3 次 400);" +
      "带 tools 时 temperature/top_p 一律 400。可用形状 = 显式 low..max 档位 + 不带采样参数。" +
      "实测 2026-10-10;失效条件:上游补上 none 档或渠道统一后删除本条。",
    compat: { supportsReasoningEffort: true },
    thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  },
  "gpt-6.1-sol": {
    reason:
      "同 gpt-6-sol(同一后端,行为一致):带 function tools 拒收 reasoning_effort=\"none\"、拒收 " +
      "temperature/top_p,省略 effort 在部分渠道 400;可用形状 = 显式 low..max 档位 + 不带采样参数。" +
      "实测 2026-10-10;失效条件:上游补上 none 档或渠道统一后删除本条。",
    compat: { supportsReasoningEffort: true },
    thinkingLevelMap: { off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  },
};

/** 某模型是否命中网关兼容层(供日志/摘要说明「思考档被强制改写」及其原因)。 */
export function gatewayOverlayFor(id: string): GatewayOverlay | undefined {
  return GATEWAY_OVERLAYS[id];
}

/** 该模型是否被兼容层强制关思考(UI 标注「无思考」、自动默认模型跳过它)。 */
export function gatewayThinkingDisabled(id: string): boolean {
  return GATEWAY_OVERLAYS[id]?.thinkingDisabled === true;
}

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

  const model: ResolvedModel = {
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
  applyGatewayOverlay(model);
  return model;
}

/** 就地套用网关兼容修正(compat 逐键覆盖;档位表合并后覆盖,保证不漏档)。 */
function applyGatewayOverlay(model: ResolvedModel): void {
  const overlay = GATEWAY_OVERLAYS[model.id];
  if (!overlay) return;
  if (overlay.compat) model.compat = mergeCompat(model.compat, overlay.compat);
  if (overlay.thinkingLevelMap) {
    model.thinkingLevelMap = { ...model.thinkingLevelMap, ...overlay.thinkingLevelMap };
  }
}

/** 把模型 id 列表解析为完整元数据(已知模型精确规格,未知模型按 id 正则推断)。 */
export function buildResolvedModels(ids: string[]): ResolvedModel[] {
  return ids.map((id) => resolveModel(id)).sort((a, b) => a.id.localeCompare(b.id));
}

/** id 是否命中 KNOWN_MODELS(未命中 = 元数据走 fallback 推断,列表标 "new")。 */
export function isKnownModel(id: string): boolean {
  return id in KNOWN_MODELS;
}

/** 是否为 DeepSeek 系模型(pi/omp 走 DeepSeek 官方特配)。 */
export function isDeepseekModel(id: string): boolean {
  return /deepseek/i.test(id);
}

/** 由 provider 名派生凭据环境变量名(对齐 dsh 官方 deriveKeyRef 规则)。 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
