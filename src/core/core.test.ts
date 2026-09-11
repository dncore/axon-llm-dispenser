import { describe, it, expect } from "vitest";
import { deriveKeyRef, buildResolvedModels, isKnownModel } from "./models";
import { patchCodexConfigToml, renderCodexModelsJson, codexProxyBaseUrl, codexProxyNeeded, CODX_PROXY_DEFAULT_PORT } from "./codex";
import { fallbackAutostartChecked } from "./autostart";
import { patchReasonixProvider, patchReasonixServeAuth } from "./reasonix";
import { patchDshProvider, patchDshDefaultModel, removeDshOtherProviders, upsertDshCredentialYaml } from "./dsh";

describe("deriveKeyRef", () => {
  it("大写并去非法字符,追加 _API_KEY", () => {
    expect(deriveKeyRef("axon")).toBe("AXON_API_KEY");
    expect(deriveKeyRef("my-gateway")).toBe("MY_GATEWAY_API_KEY");
    expect(deriveKeyRef("a.b_c")).toBe("A_B_C_API_KEY");
  });
});

describe("buildResolvedModels", () => {
  it("已知模型给精确规格,未知模型走正则推断", () => {
    const [ds] = buildResolvedModels(["deepseek-v4-flash"]);
    expect(ds.contextWindow).toBe(1000000);
    expect(ds.reasoning).toBe(true);

    const [unknown] = buildResolvedModels(["some-gateway-model"]);
    expect(unknown.contextWindow).toBe(128000);
    expect(unknown.reasoning).toBe(false);
  });

  it("isKnownModel 区分表命中与 fallback(列表 new 徽标依据)", () => {
    expect(isKnownModel("deepseek-v4-flash")).toBe(true);
    expect(isKnownModel("Recommend")).toBe(true); // 伪模型路由也在表内
    expect(isKnownModel("some-gateway-model")).toBe(false);
    expect(isKnownModel("qwen3.9-plus-0915")).toBe(false); // 未入库的新版本号
  });

  it("deepseek-v4-flash-vision-exp 按 flash 同规格 + 图像输入", () => {
    const [m] = buildResolvedModels(["deepseek-v4-flash-vision-exp"]);
    expect(m.name).toBe("DeepSeek V4 Flash Vision (Exp)");
    expect(m.contextWindow).toBe(1000000);
    expect(m.maxTokens).toBe(384000);
    expect(m.reasoning).toBe(true);
    expect(m.input).toEqual(["text", "image"]);
    expect(m.cost).toEqual({ input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 });
    expect(m.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: "high", xhigh: "max" });
    expect(m.compat.thinkingFormat).toBe("deepseek");
    expect(m.compat.requiresReasoningContentOnAssistantMessages).toBe(true);
  });

  it("qwen3.8-flash 官方规格: 上下文 1,000,000(阿里系 1M 为精确十进制;983,616 是思考档输入预算非上下文) + 131K 输出", () => {
    const [m] = buildResolvedModels(["qwen3.8-flash"]);
    expect(m.name).toBe("Qwen3.8 Flash");
    expect(m.contextWindow).toBe(1000000);
    expect(m.maxTokens).toBe(131072);
    expect(m.reasoning).toBe(true);
    expect(m.input).toEqual(["text"]);
    expect(m.cost).toEqual({ input: 1, output: 3, cacheRead: 0, cacheWrite: 0 });
    expect(m.thinkingLevelMap).toBeUndefined();
    expect(m.compat.thinkingFormat).toBe("qwen");
  });

  it("glm-5.3-flash 官方规格: 1Mi 上下文(智谱 1M 按二进制口径) + 131K 输出 + 原生多模态", () => {
    const [m] = buildResolvedModels(["glm-5.3-flash"]);
    expect(m.name).toBe("GLM-5.3 Flash");
    expect(m.contextWindow).toBe(1048576);
    expect(m.maxTokens).toBe(131072);
    expect(m.reasoning).toBe(true);
    expect(m.input).toEqual(["text", "image"]);
    expect(m.cost).toEqual({ input: 0.8, output: 2.8, cacheRead: 0, cacheWrite: 0 });
    expect(m.thinkingLevelMap).toEqual({ off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max" });
  });
});

describe("patchCodexConfigToml", () => {
  it("codex 转换代理 helper:base_url 默认 localhost(绕过代理劫持),可指定主机", () => {
    expect(codexProxyBaseUrl(CODX_PROXY_DEFAULT_PORT)).toBe("http://localhost:17321/api/v1");
    expect(codexProxyBaseUrl(18000, "192.168.32.64")).toBe("http://192.168.32.64:18000/api/v1");
    expect(codexProxyNeeded(["openai/gpt-5.6-sol"])).toBe(true);
    expect(codexProxyNeeded(["GPT-5.6-TERRA"])).toBe(true);
    expect(codexProxyNeeded([])).toBe(false);
  });

  it("codex 转换代理静态规则:网关卡 /responses 不可用的模型走转换,原生可用的透传", () => {
    // 转换(chat-only / 网关 responses 损坏):gpt-5.6 / glm / kimi / step / mimo / claude / gemini / deepseek-v4-flash
    for (const id of ["gpt-5.6-luna", "glm-5.3-flash", "glm-5.2", "glm-4.6v", "kimi-k3", "kimi-k2.6", "kimi-lastest", "step-3.7-flash", "MiMo-V2.5", "grok-4.6", "claude-sonnet-5", "claude-opus-5", "gemini-3.7-flash", "gemini-3.1-pro-preview", "deepseek-v4-flash"]) {
      expect(codexProxyNeeded([id])).toBe(true);
    }
    // 透传(原生 responses 可用):qwen 系 / hy3 / MiniMax / deepseek-v4-pro / kimi-k2.7-code / Recommend
    for (const id of ["qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus", "qwen-lastest", "hy3", "MiniMax-M3", "MiniMax-lastest", "deepseek-v4-pro", "kimi-k2.7-code", "Recommend"]) {
      expect(codexProxyNeeded([id])).toBe(false);
    }
    // deepseek-v4-flash 子串同时命中 vision-exp(其 chat 路径可用,统一走转换)
    expect(codexProxyNeeded(["deepseek-v4-flash-vision-exp"])).toBe(true);
  });

  it("空文件创建 provider 段", () => {
    const r = patchCodexConfigToml("", {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-test",
      defaultModel: "deepseek-v4-flash",
      modelsJsonPath: "/home/u/.codex/models.json",
    });
    expect(r.text).toContain('model_provider = "axon"');
    expect(r.text).toContain("[model_providers.axon]");
    expect(r.text).toContain('wire_api = "responses"');
    expect(r.text).toContain("requires_openai_auth = false");
    expect(r.text).toContain('experimental_bearer_token = "sk-test"');
  });

  it("models.json 输出所有模型 visibility=list", () => {
    const models = buildResolvedModels(["deepseek-v4-flash", "kimi-k3"]);
    const json = renderCodexModelsJson(models, "axon");
    const parsed = JSON.parse(json) as { models: Array<{ slug: string; visibility: string }> };
    expect(parsed.models.length).toBe(2);
    expect(parsed.models.every((m) => m.visibility === "list")).toBe(true);
  });

  it("models.json 网关条目关闭 Responses Lite;gpt-5.6 家族额外覆盖内置 code_mode", () => {
    const models = buildResolvedModels(["openai/gpt-5.6-sol", "deepseek-v4-flash"]);
    const json = renderCodexModelsJson(models, "axon");
    const doc = JSON.parse(json) as { models: Array<Record<string, unknown> & { slug: string }> };
    const sol = doc.models.find((m) => m.slug === "openai/gpt-5.6-sol")!;
    const ds = doc.models.find((m) => m.slug === "deepseek-v4-flash")!;
    // 全部网关模型:禁用 Responses Lite,避免工具定义被塞进 messages[].content 的 additional_tools
    expect(sol.use_responses_lite).toBe(false);
    expect(ds.use_responses_lite).toBe(false);
    // gpt-5.6 家族:覆盖 Codex 内置硬编码 tool_mode=code_mode_only / multi_agent v2
    expect(sol.tool_mode).toBe("direct");
    expect(sol.multi_agent_version).toBeNull();
    expect("tool_mode" in ds).toBe(false);
    expect("multi_agent_version" in ds).toBe(false);
    // reasoning effort 预设已填充(桌面端 effort 下拉依据;low/high/max 为实测可用档,
    // 不含 none 以避免 claude/gemini-3.7/grok 拒收 400)。全部模型一律填充,不做
    // reasoning 条件化——未知模型推断为非推理会误伤,兼容由转换代理映射兜底。
    for (const e of [sol, ds]) {
      const levels = (e.supported_reasoning_levels ?? []) as Array<{ effort: string }>;
      expect(levels.map((l) => l.effort)).toEqual(["low", "high", "max"]);
    }
  });
});

describe("patchReasonix", () => {
  it("provider 块 + 鉴权 token", () => {
    const p = patchReasonixProvider("", {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKeyEnv: "AXON_API_KEY",
      modelIds: ["deepseek-v4-flash"],
      defaultModel: "deepseek-v4-flash",
      modelContexts: { "deepseek-v4-flash": 1000000 },
    });
    expect(p.text).toContain('name = "axon"');
    expect(p.text).toContain('kind = "openai"');
    expect(p.text).toContain('default_model = "axon"');

    const auth = patchReasonixServeAuth(p.text, "token", "tok123");
    expect(auth.text).toContain('auth_mode = "token"');
    expect(auth.text).toContain('token = "tok123"');
  });
});

describe("patchDshProvider", () => {
  it("空文件创建 llm-pi-ai.providers.<name>,DeepSeek 带 off 空值声明", () => {
    const r = patchDshProvider("", {
      providerName: "axon",
      displayName: "Axon",
      apiKeyEnv: "AXON_API_KEY",
      baseUrl: "https://gateway.example/v1",
      models: [
        { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000, reasoning: true, reasoningEfforts: { off: null, low: "high", high: "high" } },
        { id: "qwen3.8-max", contextWindow: 983616, maxTokens: 131072, reasoning: true, reasoningEfforts: { off: null } },
      ],
    });
    expect(r.text).toContain("providers:");
    expect(r.text).toContain("axon:");
    expect(r.text).toContain("reasoningEfforts:");
    expect(r.text).toContain("low: high");
    // 对齐 dsh 官方:off 用空值声明「选 Off 时发送 nothing」
    expect(r.text).toContain("off:");
    // 非推理档位齐全的模型(qwen 只有 off)不产生 reasoningEfforts 段
    expect((r.text.match(/reasoningEfforts:/g) ?? []).length).toBe(1);
    // route 级 reasoning:部署默认思考档位,缺省会导致非思考模式、reasoning_content 缺失
    expect(r.text).toContain("reasoning: high");
  });

  it("默认模型段:缺失时创建,dsh 已配置时不覆盖", () => {
    const r = patchDshDefaultModel("", "axon", "deepseek-v4-flash");
    expect(r.text).toContain("agent-default-model:");
    expect(r.text).toContain("provider: axon");
    // dsh 设置界面已配置(含 reasoningEffort 等字段):不覆盖,原样保留
    const existing = "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash-vision-exp\n  reasoningEffort: high\n";
    const r2 = patchDshDefaultModel(existing, "axon", "deepseek-v4-flash");
    expect(r2.text).toBe(existing);
    expect(r2.changes).toEqual([]);
  });

  it("凭据 upsert 用 0600 语义(空值拒绝)", () => {
    const r = upsertDshCredentialYaml("", "AXON_API_KEY", "sk-x");
    expect(r.text).toBe("AXON_API_KEY: sk-x\n");
    expect(() => upsertDshCredentialYaml("", "AXON_API_KEY", "")).toThrow();
  });

  it("凭据 upsert 兼容 refs: 包裹(新增 key 按子项缩进)", () => {
    const existing = "version: 1\nrefs:\n  DEEPSEEK_API_KEY: xxxx\n";
    const r = upsertDshCredentialYaml(existing, "AXON_API_KEY", "user_xxx");
    expect(r.text).toBe("version: 1\nrefs:\n  DEEPSEEK_API_KEY: xxxx\n  AXON_API_KEY: user_xxx\n");
  });

  it("凭据 upsert 修复顶格错位的 key,移到 refs: 之下", () => {
    const existing = "version: 1\nrefs:\n  DEEPSEEK_API_KEY: xxxx\nAXON_API_KEY: user_xxx\n";
    const r = upsertDshCredentialYaml(existing, "AXON_API_KEY", "user_xxx");
    expect(r.text).toBe("version: 1\nrefs:\n  DEEPSEEK_API_KEY: xxxx\n  AXON_API_KEY: user_xxx\n");
  });
  it("凭据 upsert 重复配置 refs 内已存在的 key 时覆盖而非追加", () => {
    const existing = "version: 1\nrefs:\n  AXON_API_KEY: user_xxx\n";
    const r = upsertDshCredentialYaml(existing, "AXON_API_KEY", "user_xxx");
    expect(r.text).toBe("version: 1\nrefs:\n  AXON_API_KEY: user_xxx\n");
    const r2 = upsertDshCredentialYaml(r.text, "AXON_API_KEY", "user_xxx");
    expect(r2.text).toBe("version: 1\nrefs:\n  AXON_API_KEY: user_xxx\n");
  });
});

describe("dsh 清理旧版遗留", () => {
  it("removeDshOtherProviders 只保留 target 路由,删除其它", () => {
    const yaml = [
      "llm-pi-ai:",
      "  providers:",
      "    axon:",
      "      displayName: Axon",
      "      baseURL: https://a",
      "      models: []",
      "    magene:",
      "      displayName: Magene",
      "      baseURL: https://b",
      "      models: []",
      "    other:",
      "      displayName: Other",
      "      baseURL: https://c",
      "      models: []",
      "",
    ].join("\n");
    const r = removeDshOtherProviders(yaml, "axon");
    expect([...r.removed].sort()).toEqual(["magene", "other"]);
    expect(r.text).toContain("axon:");
    expect(r.text).not.toContain("magene:");
    expect(r.text).not.toContain("other:");
  });

});

import { deriveAnthropicUrl, formatClaudeModel, patchClaudeSettings, parseClaudeStatus } from "./claude";
import { patchPiModelsJson, patchPiSettings, parsePiStatus } from "./pi";

describe("claude", () => {
  it("推导 Anthropic 端点", () => {
    expect(deriveAnthropicUrl("http://host:8080/api/v1")).toBe("http://host:8080/api/anthropic");
    expect(deriveAnthropicUrl("https://gw.example/v1")).toBe("https://gw.example/api/anthropic");
    expect(deriveAnthropicUrl("https://gw.example/base")).toBe("https://gw.example/base/api/anthropic");
  });

  it("合并 env 到 settings.json,保留其它键", () => {
    const r = patchClaudeSettings('{"permissions":{"allow":["Bash(ls *)"]},"env":{"ANTHROPIC_SMALL_FAST_MODEL":"old"}}', {
      anthropicBaseUrl: "http://host/api/anthropic",
      apiKey: "sk-x",
      mainModel: "m1[1m]",
      roles: { haiku: "m2[200k]", sonnet: "m3", opus: "m4", fable: "m5", subagent: "m6" },
    });
    const doc = JSON.parse(r.text) as { permissions: unknown; env: Record<string, string> };
    expect(doc.permissions).toEqual({ allow: ["Bash(ls *)"] });
    expect(doc.env.ANTHROPIC_BASE_URL).toBe("http://host/api/anthropic");
    expect(doc.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-x");
    expect(doc.env.ANTHROPIC_MODEL).toBe("m1[1m]");
    expect(doc.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("m2[200k]");
    expect(doc.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("m3");
    expect(doc.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("m5");
    expect(doc.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("m6");
    // 弃用变量被删除;后缀足够时不再写全局 MAX_CONTEXT_TOKENS
    expect("ANTHROPIC_SMALL_FAST_MODEL" in doc.env).toBe(false);
    expect(doc.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it("状态解析", () => {
    const s = parseClaudeStatus('{"env":{"ANTHROPIC_BASE_URL":"http://h","ANTHROPIC_AUTH_TOKEN":"t","ANTHROPIC_MODEL":"m"}}');
    expect(s.baseUrl).toBe("http://h");
    expect(s.authTokenSet).toBe(true);
    expect(s.model).toBe("m");
  });
});

describe("claude 后缀映射", () => {
  it("按真实上下文窗口加官方后缀", () => {
    expect(formatClaudeModel("deepseek-v4-flash", 1000000)).toBe("deepseek-v4-flash[1m]");
    expect(formatClaudeModel("qwen3.8-max", 983616)).toBe("qwen3.8-max[1m]");
    expect(formatClaudeModel("qwen3.8-flash", 983616)).toBe("qwen3.8-flash[1m]");
    expect(formatClaudeModel("glm-5.3-flash", 1000000)).toBe("glm-5.3-flash[1m]");
    expect(formatClaudeModel("glm-5", 200000)).toBe("glm-5[200k]");
    expect(formatClaudeModel("small-model", 128000)).toBe("small-model");
  });

  it("主模型 <200k 无后缀时设置 MAX_CONTEXT_TOKENS 兜底", () => {
    const r = patchClaudeSettings("", {
      anthropicBaseUrl: "http://h",
      apiKey: "k",
      mainModel: "small",
      roles: { haiku: "h", sonnet: "s", opus: "o", fable: "f", subagent: "sa" },
      maxContextTokens: 128000,
    });
    const doc = JSON.parse(r.text) as { env: Record<string, string> };
    expect(doc.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("128000");
  });
});

describe("pi", () => {
  it("合并 providers 到 models.json,保留其它 provider", () => {
    const r = patchPiModelsJson('{"providers":{"ollama":{"baseUrl":"http://x","models":[]}}}', {
      providerName: "axon",
      baseUrl: "https://gw/v1",
      apiKey: "sk-x",
      models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 384000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: {} }],
    });
    const doc = JSON.parse(r.text) as { providers: Record<string, { baseUrl: string; apiKey: string; authHeader: boolean; models: unknown[] }> };
    expect(doc.providers.ollama).toBeDefined();
    expect(doc.providers.axon.baseUrl).toBe("https://gw/v1");
    expect(doc.providers.axon.authHeader).toBe(true);
    expect(doc.providers.axon.models).toHaveLength(1);
  });

  it("settings defaultProvider/defaultModel", () => {
    const r = patchPiSettings('{"defaultProvider":"old"}', "axon", "deepseek-v4-flash");
    const doc = JSON.parse(r.text) as { defaultProvider: string; defaultModel: string };
    expect(doc.defaultProvider).toBe("axon");
    expect(doc.defaultModel).toBe("deepseek-v4-flash");
  });

  it("pi 状态解析", () => {
    const s = parsePiStatus('{"providers":{"axon":{"baseUrl":"https://gw","models":[{}]}}}', '{"defaultProvider":"axon"}', "axon");
    expect(s.providerConfigured).toBe(true);
    expect(s.providerModels).toBe(1);
    expect(s.defaultProvider).toBe("axon");
  });
});

import { isDoubaoModel, filterDoubao, dshDeepseekEfforts } from "../flows";

describe("dsh DeepSeek reasoningEfforts 映射", () => {
  it("对齐 pi-ai 内置目录:max 档(非 xhigh),flash 额外 low", () => {
    // dsh(pi-ai)权威:deepseek-v4-pro = high/max;v4-flash = low/high/max
    expect(dshDeepseekEfforts("deepseek-v4-pro")).toEqual({ high: "high", max: "max" });
    expect(dshDeepseekEfforts("deepseek-v4-flash")).toEqual({ low: "low", high: "high", max: "max" });
    // 不含 xhigh:那是 pi 的体系,dsh 会把 max 档映射成 null → 400
    expect(JSON.stringify(dshDeepseekEfforts("deepseek-v4-pro"))).not.toContain("xhigh");
  });

  it("flash 族前缀匹配:vision-exp 变体拿 low/high/max", () => {
    expect(dshDeepseekEfforts("deepseek-v4-flash-vision-exp")).toEqual({ low: "low", high: "high", max: "max" });
    // 非 flash 前缀不受影响
    expect(dshDeepseekEfforts("deepseek-v4-pro")).toEqual({ high: "high", max: "max" });
  });
});

describe("doubao 过滤", () => {
  it("识别 doubao 系模型(大小写不敏感)", () => {
    expect(isDoubaoModel("Doubao-Seed-2.0-Code")).toBe(true);
    expect(isDoubaoModel("doubao-pro-256k")).toBe(true);
    expect(isDoubaoModel("deepseek-v4-flash")).toBe(false);
  });

  it("开关开启时过滤,关闭时保留", () => {
    const ids = ["deepseek-v4-flash", "Doubao-Seed-2.0-Code", "doubao-pro-256k", "qwen3.8-max"];
    expect(filterDoubao(ids, true)).toEqual(["deepseek-v4-flash", "qwen3.8-max"]);
    expect(filterDoubao(ids, false)).toEqual(ids);
  });
});

describe("codex models.json 保留现有条目", () => {
  it("合并现有非当前 provider 条目", () => {
    const existing = JSON.stringify({
      models: [
        { slug: "gpt-5", display_name: "GPT-5" },
        { slug: "deepseek-v4-flash", display_name: "old-axon-entry" },
      ],
    });
    const json = renderCodexModelsJson(
      [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 384000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: {} }],
      "axon",
      existing,
    );
    const doc = JSON.parse(json) as { models: Array<{ slug: string }> };
    const slugs = doc.models.map((m) => m.slug);
    // gpt-5 保留;deepseek-v4-flash 属于当前 provider 被新条目替换
    expect(slugs).toContain("gpt-5");
    expect(slugs.filter((s) => s === "deepseek-v4-flash")).toHaveLength(1);
    expect(doc.models.find((m) => m.slug === "gpt-5")).toMatchObject({ display_name: "GPT-5" });
  });
});

import { patchOmpModelsYml, patchOmpConfigYml, parseOmpStatus, ompBaseUrl } from "./omp";
import {
  compareAgentConfig,
  extractClaudeProvider,
  extractCodexProvider,
  extractDshProvider,
  extractOmpProvider,
  extractPiProvider,
  extractReasonixProvider,
} from "./agent-config";

describe("omp", () => {
  it("baseUrl 去尾 /v1(官方指南:不带 /v1)", () => {
    expect(ompBaseUrl("https://gateway.example/v1")).toBe("https://gateway.example");
    expect(ompBaseUrl("https://gateway.example/v1/")).toBe("https://gateway.example");
    expect(ompBaseUrl("https://gateway.example")).toBe("https://gateway.example");
  });

  it("DeepSeek 模型带官方 thinking+完整 compat,非 DeepSeek 不带", () => {
    const r = patchOmpModelsYml("", {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-test",
      models: buildResolvedModels(["deepseek-v4-pro", "qwen3.8-max"]),
    });
    expect(r.text).toContain("baseUrl: https://gateway.example");
    expect(r.text).toContain("api: openai-completions");
    expect(r.text).toContain("apiKey: sk-test");
    expect(r.text).toContain("authHeader: true");
    // DeepSeek 条目:thinking 等级锁定 + 三关键 compat 字段 + extraBody
    expect(r.text).toContain("minLevel: high");
    expect(r.text).toContain("maxLevel: xhigh");
    expect(r.text).toContain("mode: effort");
    expect(r.text).toContain("supportsToolChoice: false");
    expect(r.text).toContain("requiresReasoningContentForToolCalls: true");
    expect(r.text).toContain("requiresAssistantContentForToolCalls: true");
    expect(r.text).toContain("type: enabled");
    // 非 DeepSeek 条目不写 compat 块
    const qwenIdx = r.text.indexOf("qwen3.8-max");
    expect(qwenIdx).toBeGreaterThan(-1);
    expect(r.text.slice(qwenIdx)).not.toContain("compat:");
  });

  it("已有其它 provider 时只更新目标段", () => {
    const existing = [
      "providers:",
      "  other:",
      "    baseUrl: https://x",
      "    api: openai-completions",
      "    apiKey: k",
      "    authHeader: true",
      "    models: []",
      "",
    ].join("\n");
    const r = patchOmpModelsYml(existing, {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk-test",
      models: buildResolvedModels(["deepseek-v4-flash"]),
    });
    expect(r.text).toContain("other:");
    expect(r.text).toContain("axon:");
    expect(r.text).toContain("baseUrl: https://x");
  });

  it("config.yml modelRoles.default upsert 与替换", () => {
    const r1 = patchOmpConfigYml("", "axon", "deepseek-v4-flash");
    expect(r1.text).toContain("modelRoles:");
    expect(r1.text).toContain("default: axon/deepseek-v4-flash");
    const r2 = patchOmpConfigYml(r1.text, "axon", "deepseek-v4-pro");
    expect(r2.text).toContain("default: axon/deepseek-v4-pro");
    expect(r2.text).not.toContain("deepseek-v4-flash");
  });

  it("状态解析", () => {
    const models = patchOmpModelsYml("", {
      providerName: "axon",
      baseUrl: "https://gateway.example/v1",
      apiKey: "sk",
      models: buildResolvedModels(["deepseek-v4-pro", "qwen3.8-max"]),
    }).text;
    const cfg = patchOmpConfigYml("", "axon", "deepseek-v4-pro").text;
    const s = parseOmpStatus(models, cfg, "axon");
    expect(s.providerConfigured).toBe(true);
    expect(s.providerBaseUrl).toBe("https://gateway.example");
    expect(s.providerModels).toBe(2);
    expect(s.defaultRole).toBe("axon/deepseek-v4-pro");
  });

  it("pi models.json 对 DeepSeek 应用官方 thinkingLevelMap", () => {
    const r = patchPiModelsJson("", {
      providerName: "axon",
      baseUrl: "https://g/v1",
      apiKey: "sk",
      models: buildResolvedModels(["deepseek-v4-pro"]),
    });
    const doc = JSON.parse(r.text) as { providers: { axon: { models: Array<Record<string, unknown>> } } };
    const m = doc.providers.axon.models[0];
    expect(m.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: "high", xhigh: "max" });
    expect((m.compat as Record<string, unknown>).thinkingFormat).toBe("deepseek");
    expect((m.compat as Record<string, unknown>).requiresReasoningContentOnAssistantMessages).toBe(true);
  });
});

describe("agent 配置一致性检测", () => {
  const want = { baseUrl: "https://gateway.example/v1", apiKey: "sk-test" };

  it("比对:一致 / 不一致 / 缺失", () => {
    expect(compareAgentConfig(want, { baseUrl: "https://gateway.example/v1/", apiKey: "sk-test" }).state).toBe("ok"); // 末尾斜杠归一化
    expect(compareAgentConfig(want, { baseUrl: "https://gateway.example/v1", apiKey: "sk-other" }).state).toBe("stale");
    expect(compareAgentConfig(want, { baseUrl: "https://old.example/v1", apiKey: "sk-test" }).state).toBe("stale");
    expect(compareAgentConfig(want, { baseUrl: null, apiKey: null }).state).toBe("missing");
    expect(compareAgentConfig({ baseUrl: "", apiKey: "" }, { baseUrl: null, apiKey: null }).state).toBe("missing");
  });

  it("claude 提取 settings.json env", () => {
    const f = extractClaudeProvider(JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://g/v1/api/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-test" } }));
    expect(f).toEqual({ baseUrl: "https://g/v1/api/anthropic", apiKey: "sk-test" });
    expect(extractClaudeProvider("bad").baseUrl).toBeNull();
  });

  it("codex 提取 [model_providers.<name>] 段", () => {
    const cfg = [
      'model = "deepseek-v4-flash"',
      "",
      "[model_providers.axon]",
      'name = "axon"',
      'base_url = "https://gateway.example/v1"',
      'experimental_bearer_token = "sk-test"',
      "requires_openai_auth = false",
      "",
      "[model_providers.other]",
      'base_url = "https://x"',
    ].join("\n");
    expect(extractCodexProvider(cfg, "axon")).toEqual({ baseUrl: "https://gateway.example/v1", apiKey: "sk-test" });
    expect(extractCodexProvider(cfg, "nope").baseUrl).toBeNull();
  });

  it("reasonix 提取 [[providers]] 块 + .env 值", () => {
    const cfg = [
      "[[providers]]",
      'name = "other"',
      'base_url = "https://x"',
      "",
      "[[providers]]",
      'name = "axon"',
      'base_url = "https://gateway.example/v1"',
      'api_key_env = "AXON_API_KEY"',
    ].join("\n");
    const env = 'AXON_API_KEY="sk-test"\n';
    expect(extractReasonixProvider(cfg, env, "axon")).toEqual({ baseUrl: "https://gateway.example/v1", apiKey: "sk-test" });
    expect(extractReasonixProvider(cfg, "", "axon").apiKey).toBeNull();
  });

  it("dsh 提取 llm-pi-ai.providers.<name> + 凭据", () => {
    const settings = [
      "llm-pi-ai:",
      "  providers:",
      "    axon:",
      "      displayName: Axon",
      "      apiKeyEnv: AXON_API_KEY",
      "      api: openai-completions",
      "      baseURL: https://gateway.example/v1",
      "      models:",
      '        - id: "m1"',
      "    other:",
      "      baseURL: https://x",
    ].join("\n");
    const cred = "AXON_API_KEY: sk-test\n";
    expect(extractDshProvider(settings, cred, "axon")).toEqual({ baseUrl: "https://gateway.example/v1", apiKey: "sk-test" });
    expect(extractDshProvider(settings, "  AXON_API_KEY: sk-test\n", "axon").apiKey).toBe("sk-test");
    expect(extractDshProvider(settings, "", "other").baseUrl).toBe("https://x");
  });

  it("pi 提取 models.json providers", () => {
    const models = JSON.stringify({ providers: { axon: { baseUrl: "https://gateway.example/v1", apiKey: "sk-test" } } });
    expect(extractPiProvider(models, "axon")).toEqual({ baseUrl: "https://gateway.example/v1", apiKey: "sk-test" });
    expect(extractPiProvider(models, "nope").baseUrl).toBeNull();
  });

  it("omp 提取 models.yml providers", () => {
    const models = [
      "providers:",
      "  axon:",
      "    baseUrl: https://gateway.example",
      "    api: openai-completions",
      "    apiKey: sk-test",
      "    authHeader: true",
      "    models:",
      '      - id: "m1"',
      "  other:",
      "    baseUrl: https://x",
    ].join("\n");
    expect(extractOmpProvider(models, "axon")).toEqual({ baseUrl: "https://gateway.example", apiKey: "sk-test" });
    expect(extractOmpProvider(models, "nope").baseUrl).toBeNull();
  });
});

import { patchOpenCodeConfig, patchOpenCodeAuth, parseOpenCodeStatus } from "./opencode";
import { extractOpenCodeProvider } from "./agent-config";

describe("opencode", () => {
  const base = {
    providerName: "axon",
    displayName: "Axon",
    baseUrl: "https://gateway.example/v1",
    defaultModel: "deepseek-v4-flash",
    models: buildResolvedModels(["deepseek-v4-flash", "qwen3-coder-plus"]),
  };

  it("空文件创建 provider 块 + 顶层 model,模型 key=id", () => {
    const r = patchOpenCodeConfig("", base);
    const doc = JSON.parse(r.text) as {
      provider: Record<string, { name: string; npm: string; options: { baseURL: string }; models: Record<string, { name?: string }> }>;
      model: string;
    };
    expect(doc.provider.axon.name).toBe("Axon");
    expect(doc.provider.axon.npm).toBe("@ai-sdk/openai-compatible");
    expect(doc.provider.axon.options.baseURL).toBe("https://gateway.example/v1");
    expect(Object.keys(doc.provider.axon.models)).toEqual(["deepseek-v4-flash", "qwen3-coder-plus"]);
    expect(doc.provider.axon.models["deepseek-v4-flash"]).toEqual({ name: "DeepSeek V4 Flash" });
    expect(doc.model).toBe("axon/deepseek-v4-flash");
    expect(r.changes.join(",")).toContain("新增 provider axon");
    expect(r.changes.join(",")).toContain("baseURL=https://gateway.example/v1");
  });

  it("保留其它 provider 与顶层键,model 已设时不重复报变更", () => {
    const existing = JSON.stringify({
      model: "other/model",
      provider: { ollama: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:11434/v1" }, models: {} } },
    });
    const r = patchOpenCodeConfig(existing, base);
    const doc = JSON.parse(r.text) as { model: string; provider: Record<string, unknown> };
    expect(doc.provider.ollama).toBeDefined();
    expect(doc.model).toBe("axon/deepseek-v4-flash");
    expect(r.changes.some((c) => c.startsWith("model="))).toBe(true);
  });

  it("幂等:同参数重复应用输出稳定", () => {
    const r1 = patchOpenCodeConfig("", base);
    const r2 = patchOpenCodeConfig(r1.text, base);
    expect(r2.text).toBe(r1.text);
    const a1 = patchOpenCodeAuth("", "axon", "sk-x");
    const a2 = patchOpenCodeAuth(a1.text, "axon", "sk-x");
    expect(a2.text).toBe(a1.text);
  });

  it("auth.json 保留其它条目,同名覆盖 type/key", () => {
    const r = patchOpenCodeAuth(JSON.stringify({ anthropic: { type: "oauth", access: "tok", refresh: "r", expires: 1 } }), "axon", "sk-new");
    const doc = JSON.parse(r.text) as Record<string, { type: string; key?: string; access?: string }>;
    expect(doc.anthropic.type).toBe("oauth"); // 其它条目不动
    expect(doc.axon).toEqual({ type: "api", key: "sk-new" });

    const r2 = patchOpenCodeAuth(r.text, "axon", "sk-rotated");
    const doc2 = JSON.parse(r2.text) as Record<string, { type: string; key: string }>;
    expect(doc2.axon).toEqual({ type: "api", key: "sk-rotated" });
  });

  it("状态解析:provider 模型数、密钥、model", () => {
    const config = patchOpenCodeConfig("", base).text;
    const auth = patchOpenCodeAuth("", "axon", "sk-x").text;
    const s = parseOpenCodeStatus(config, auth, "axon");
    expect(s.configExists).toBe(true);
    expect(s.authExists).toBe(true);
    expect(s.providerConfigured).toBe(true);
    expect(s.providerBaseUrl).toBe("https://gateway.example/v1");
    expect(s.providerModels).toBe(2);
    expect(s.keySet).toBe(true);
    expect(s.model).toBe("axon/deepseek-v4-flash");

    const empty = parseOpenCodeStatus("", "", "axon");
    expect(empty.providerConfigured).toBe(false);
    expect(empty.keySet).toBe(false);
  });

  it("提取一致性检测:opencode.json baseURL + auth.json key", () => {
    const config = patchOpenCodeConfig("", base).text;
    const auth = patchOpenCodeAuth("", "axon", "sk-test").text;
    expect(extractOpenCodeProvider(config, auth, "axon")).toEqual({ baseUrl: "https://gateway.example/v1", apiKey: "sk-test" });
    expect(extractOpenCodeProvider(config, auth, "nope").baseUrl).toBeNull();
    expect(extractOpenCodeProvider("bad json", "bad json", "axon")).toEqual({ baseUrl: null, apiKey: null });
  });
});

// ---------------------------------------------------------------------------
// 开机自启
// ---------------------------------------------------------------------------

describe("fallbackAutostartChecked", () => {
  it("切换失败时回滚到系统真实状态(请求开启但系统仍关闭 → false)", async () => {
    const checked = await fallbackAutostartChecked(true, async () => false);
    expect(checked).toBe(false);
  });

  it("切换失败时回滚到系统真实状态(请求关闭但系统仍开启 → true)", async () => {
    const checked = await fallbackAutostartChecked(false, async () => true);
    expect(checked).toBe(true);
  });

  it("系统查询也失败时维持用户请求值,避免「点了没反应」", async () => {
    const checked = await fallbackAutostartChecked(true, async () => {
      throw new Error("not supported");
    });
    expect(checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// grok (grok CLI)
// ---------------------------------------------------------------------------

import { patchGrokConfigToml, parseGrokStatus, type GrokModel } from "./grok";
import { extractGrokProvider } from "./agent-config";

function grokModel(id: string, overrides?: Partial<GrokModel>): GrokModel {
  return { id, contextWindow: 128000, maxTokens: 8192, ...overrides };
}

const GROK_INPUT = {
  providerName: "axon",
  label: "Axon",
  baseUrl: "https://gateway.example/v1",
  apiKey: "sk-test",
  defaultModel: "glm-5.3",
} as const;

describe("patchGrokConfigToml", () => {
  it("空文件创建 [model_providers.<name>] + [models] default + 模型块(含点号引号键)", () => {
    const r = patchGrokConfigToml("", {
      ...GROK_INPUT,
      models: [
        grokModel("deepseek-v4-flash", { contextWindow: 1000000, maxTokens: 384000 }),
        grokModel("glm-5.3", { contextWindow: 1048576, maxTokens: 131072 }),
      ],
    });
    expect(r.text).toContain("[model_providers.axon]");
    expect(r.text).toContain('base_url = "https://gateway.example/v1"');
    expect(r.text).toContain('api_backend = "chat_completions"');
    expect(r.text).toContain('api_key = "sk-test"');
    expect(r.text).toContain('[models]\ndefault = "glm-5.3"');
    expect(r.text).toContain("[model.deepseek-v4-flash]"); // 无点号 ID 用裸键
    expect(r.text).toContain('[model."glm-5.3"]'); // 含点号 ID 必须引号键(裸键会被 TOML 解析成嵌套表)
    expect(r.text).toContain('model_provider = "axon"');
    expect(r.text).toContain("context_window = 1048576");
    expect(r.text).toContain("max_completion_tokens = 131072");
    expect(r.changes.length).toBe(3);
  });

  it("幂等:重复 patch 输出不变且无变更", () => {
    const input = { ...GROK_INPUT, models: [grokModel("deepseek-v4-flash"), grokModel("glm-5.3")] };
    const r1 = patchGrokConfigToml("", input);
    const r2 = patchGrokConfigToml(r1.text, input);
    expect(r2.text).toBe(r1.text);
    expect(r2.changes).toEqual([]);
  });

  it("default 不在模型列表时回退到字母序第一个模型", () => {
    const r = patchGrokConfigToml("", {
      ...GROK_INPUT,
      defaultModel: "not-in-list",
      models: [grokModel("kimi-k3"), grokModel("glm-5.3")],
    });
    expect(r.text).toContain('default = "glm-5.3"');
  });

  it("模型列表为空时原样返回", () => {
    const r = patchGrokConfigToml("some existing\n", { ...GROK_INPUT, models: [] });
    expect(r.text).toBe("some existing\n");
    expect(r.changes).toEqual([]);
  });

  it("保留 [models] 段其他键、其他 [model.*] 块与顶层注释", () => {
    const existing = [
      "# user config",
      "[models]",
      'web_search = "grok-4.6"',
      "",
      "[model.grok-4.6]",
      "temperature = 0.5",
      "",
    ].join("\n");
    const r = patchGrokConfigToml(existing, {
      ...GROK_INPUT,
      defaultModel: "deepseek-v4-flash",
      models: [grokModel("deepseek-v4-flash")],
    });
    expect(r.text.startsWith("# user config")).toBe(true); // 注释保留
    expect(r.text).toContain('web_search = "grok-4.6"'); // [models] 其他键保留
    expect(r.text).toContain("[model.grok-4.6]"); // 其他 [model.*] 块保留
    expect(r.text).toContain("temperature = 0.5");
    expect(r.text).toContain('default = "deepseek-v4-flash"'); // [models] default 更新
  });

  it("重写自有块并移除陈旧块(网关下架模型)", () => {
    const once = patchGrokConfigToml("", {
      ...GROK_INPUT,
      models: [grokModel("deepseek-v4-flash"), grokModel("glm-5.3"), grokModel("qwen3.8-flash")],
    });
    expect(once.text.match(/\[model\.[^\]]+\]/g)!.length).toBe(3);
    const twice = patchGrokConfigToml(once.text, {
      ...GROK_INPUT,
      models: [grokModel("deepseek-v4-flash"), grokModel("glm-5.3", { contextWindow: 999 })],
    });
    expect(twice.text).not.toContain("qwen3.8-flash"); // 陈旧模型块移除
    expect(twice.text).toContain("context_window = 999"); // 自有块按新元数据重写
    expect(twice.changes.some((c) => c.includes("移除 1 个陈旧模型块"))).toBe(true);
  });

  it("同 key 已存在用户块(非本 provider)时保留并跳过,避免 TOML 重复段", () => {
    const existing = [
      "[model.deepseek-v4-flash]",
      'model = "deepseek-v4-flash"',
      'model_provider = "official"',
      'base_url = "http://localhost:8080/v1"',
      "",
    ].join("\n");
    const r = patchGrokConfigToml(existing, {
      ...GROK_INPUT,
      models: [grokModel("deepseek-v4-flash"), grokModel("glm-5.3")],
    });
    expect(r.text).toContain('base_url = "http://localhost:8080/v1"'); // 用户块保留
    expect(r.text).toContain('model_provider = "axon"'); // 无冲突的 glm-5.3 正常写入
    expect((r.text.match(/\[model\.deepseek-v4-flash\]/g) ?? []).length).toBe(1); // 同 key 块不重复
    expect(r.changes.some((c) => c.includes("跳过 1 个模型"))).toBe(true);
  });

  it("api_key 更换时 provider 块更新,模型块不动", () => {
    const once = patchGrokConfigToml("", { ...GROK_INPUT, models: [grokModel("glm-5.3")] });
    const twice = patchGrokConfigToml(once.text, { ...GROK_INPUT, apiKey: "sk-new", models: [grokModel("glm-5.3")] });
    expect(twice.text).toContain('api_key = "sk-new"');
    expect(twice.changes.length).toBe(1); // 仅 provider 块变更
  });
});

describe("grok 状态与配置提取", () => {
  it("parseGrokStatus:已配置/未配置", () => {
    expect(parseGrokStatus("", "axon").providerConfigured).toBe(false);
    const configured = patchGrokConfigToml("", { ...GROK_INPUT, models: [grokModel("glm-5.3")] });
    const s = parseGrokStatus(configured.text, "axon");
    expect(s.configExists).toBe(true);
    expect(s.providerConfigured).toBe(true);
    expect(s.providerBaseUrl).toBe("https://gateway.example/v1");
    expect(s.providerApiKeySet).toBe(true);
    expect(s.providerApiKeyMasked).toBe("****"); // maskToken:≤10 位全遮
    expect(s.providerModels).toBe(1);
    expect(s.defaultModel).toBe("glm-5.3");
  });

  it("extractGrokProvider:provider 段的 base_url 与 api_key", () => {
    const configured = patchGrokConfigToml("", { ...GROK_INPUT, models: [grokModel("glm-5.3")] });
    const found = extractGrokProvider(configured.text, "axon");
    expect(found.baseUrl).toBe("https://gateway.example/v1");
    expect(found.apiKey).toBe("sk-test");
    expect(extractGrokProvider(configured.text, "other").baseUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 块内合并(只 upsert 管理键)+ 「仅更新模型列表」
// ---------------------------------------------------------------------------

import {
  applyTextOps,
  planManagedKeyUpserts,
  scanYamlListItems,
  type TextOp,
} from "./util";
import { patchCodexCatalog } from "./codex";
import { patchDshProviderModels } from "./dsh";
import { patchOmpModelsList } from "./omp";
import { patchOpenCodeModels } from "./opencode";
import { patchReasonixModels } from "./reasonix";
import { patchGrokModels } from "./grok";

describe("文本原语(区间操作)", () => {
  it("applyTextOps 从后往前应用;同 start 时按输入顺序(删除先于插入)", () => {
    const text = "aaaa\nbbbb\ncccc\n";
    const ops: TextOp[] = [
      { start: 5, end: 10, replacement: "B\n" }, // 替换 bbbb
      { start: 5, end: 5, replacement: "ins\n" }, // 同点插入(应落在替换结果前)
    ];
    expect(applyTextOps(text, ops)).toBe("aaaa\nins\nB\ncccc\n");
    // 从后往前:靠后的操作先应用,靠前的偏移仍有效
    const ops2: TextOp[] = [
      { start: 0, end: 4, replacement: "x" },
      { start: 10, end: 14, replacement: "y" },
    ];
    expect(applyTextOps(text, ops2)).toBe("x\nbbbb\ny\n");
  });

  it("planManagedKeyUpserts:替换/插入/移除(block 连同子块)", () => {
    const yaml = ["a:", "  k: 1", "  sub:", "    x: 1", "  other: 2", ""].join("\n");
    const region = { start: 3, end: yaml.length };
    // 替换标量键行 + 缺失键插入 + 子块移除
    const ops = planManagedKeyUpserts(yaml, region, {
      separator: ":",
      indent: 2,
      keys: [
        { key: "k", lines: ["  k: 9"] },
        { key: "new", lines: ["  new: 3"] },
        { key: "sub", lines: null, block: true },
      ],
    });
    const out = applyTextOps(yaml, ops);
    expect(out).toContain("  k: 9");
    expect(out).toContain("  new: 3");
    expect(out).not.toContain("sub:");
    expect(out).not.toContain("x: 1");
    expect(out).toContain("  other: 2");
  });

  it("scanYamlListItems 按缩进取列表项", () => {
    const text = ["models:", "  - id: a", "    name: A", "  - id: b", "", "next: 1"].join("\n");
    const items = scanYamlListItems(text, 0, text.indexOf("\nnext"));
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(text.slice(items[1].start, items[1].end)).toContain("- id: b");
  });
});

describe("codex provider 段块内合并", () => {
  const input = {
    providerName: "axon",
    baseUrl: "https://new.example/v1",
    apiKey: "sk-new",
    modelsJsonPath: "/home/u/.codex/models.json",
  };

  it("段内用户键与注释保留,管理键更新,幂等", () => {
    const existing = [
      "# 顶层注释",
      "[model_providers.axon]",
      "# 段内注释",
      'name = "axon"',
      'base_url = "https://old.example/v1"',
      "request_max_retries = 3",
      "",
    ].join("\n");
    const r = patchCodexConfigToml(existing, input);
    expect(r.text).toContain("# 段内注释");
    expect(r.text).toContain("request_max_retries = 3");
    expect(r.text).toContain('base_url = "https://new.example/v1"');
    expect(r.text).toContain('experimental_bearer_token = "sk-new"');
    const r2 = patchCodexConfigToml(r.text, input);
    expect(r2.text).toBe(r.text);
    expect(r2.changes).toHaveLength(0);
  });
});

describe("patchCodexCatalog(仅更新模型列表)", () => {
  it("沿用既有可见性与描述,新条目 list,自家下架移除,非本 provider 条目保留;无变化返回 unchanged", () => {
    const existing = JSON.stringify({
      models: [
        { slug: "gpt-5", display_name: "GPT-5", description: "OpenAI 官方" },
        { slug: "m1", description: "axon: Old — openai-compatible gateway", visibility: "hide" },
        { slug: "gone", description: "axon: Gone — openai-compatible gateway" },
      ],
    });
    const models = buildResolvedModels(["m1", "m2"]);
    const r = patchCodexCatalog(models, "axon", existing);
    const doc = JSON.parse(r.text) as { models: Array<Record<string, unknown>> };
    const by = Object.fromEntries(doc.models.map((m) => [m.slug as string, m]));
    expect(by.m1.visibility).toBe("hide");
    expect(by.m1.description).toBe("axon: Old — openai-compatible gateway");
    expect(by.m2.visibility).toBe("list");
    expect(by["gpt-5"]).toBeTruthy();
    expect(by.gone).toBeUndefined();
    expect(r.removed).toEqual(["gone"]);
    expect(r.added).toEqual(["m2"]);
    expect(r.unchanged).toBe(false);
    expect(r.changes.join()).toContain("移除 1 个下架条目");

    const r2 = patchCodexCatalog(models, "axon", r.text);
    expect(r2.unchanged).toBe(true);
    expect(r2.changes).toHaveLength(0);
  });

  it("全量 renderCodexModelsJson 同样移除自家下架条目、保留外来条目", () => {
    const existing = JSON.stringify({
      models: [
        { slug: "gpt-5", display_name: "GPT-5", description: "OpenAI 官方" },
        { slug: "gone", description: "axon: Gone — openai-compatible gateway" },
      ],
    });
    const json = renderCodexModelsJson(buildResolvedModels(["m1"]), "axon", existing);
    const doc = JSON.parse(json) as { models: Array<{ slug: string }> };
    expect(doc.models.map((m) => m.slug)).toEqual(["gpt-5", "m1"]);
  });
});

describe("dsh 块内合并 / 仅更新模型列表", () => {
  const DSH_EXISTING = [
    "agent-default-model:",
    "  provider: deepseek-official",
    "llm-pi-ai:",
    "  providers:",
    "    axon:",
    "      displayName: Axon",
    "      apiKeyEnv: AXON_API_KEY",
    "      api: openai-completions",
    "      baseURL: https://old.example/v1",
    "      # 用户注释",
    "      extraHeaders:",
    "        X-Trace: on",
    "      models:",
    "        - id: deepseek-v4-pro",
    "          contextWindow: 1",
    "          maxTokens: 2",
    "          customFlag: true",
    "        - id: gone-model",
    "          contextWindow: 1",
    "          maxTokens: 1",
    "    other:",
    "      baseURL: https://other.example/v1",
    "",
  ].join("\n");

  const models = [
    { id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000, reasoning: true, reasoningEfforts: { high: "high", max: "max" } },
    { id: "qwen3.8-max", contextWindow: 983616, maxTokens: 131072 },
  ];

  it("models-only:按 id 合并,用户键/注释保留,下架删除,baseURL 不动,幂等", () => {
    const r = patchDshProviderModels(DSH_EXISTING, { providerName: "axon", models });
    expect(r.providerFound).toBe(true);
    expect(r.text).toContain("baseURL: https://old.example/v1");
    expect(r.text).toContain("# 用户注释");
    expect(r.text).toContain("X-Trace: on");
    expect(r.text).toContain("customFlag: true");
    expect(r.text).toContain("contextWindow: 1000000");
    expect(r.text).not.toContain("gone-model");
    expect(r.text).toContain("- id: qwen3.8-max");
    expect(r.text).toContain("other:");
    const r2 = patchDshProviderModels(r.text, { providerName: "axon", models });
    expect(r2.text).toBe(r.text);
    expect(r2.changes).toHaveLength(0);
  });

  it("全量 patch:管理键更新、块内用户键保留,幂等", () => {
    const input = { providerName: "axon", displayName: "New Name", apiKeyEnv: "AXON_API_KEY", baseUrl: "https://new.example/v1", models };
    const r = patchDshProvider(DSH_EXISTING, input);
    expect(r.text).toContain("baseURL: https://new.example/v1");
    expect(r.text).toContain("displayName: New Name");
    expect(r.text).toContain("X-Trace: on");
    expect(r.text).toContain("customFlag: true"); // 保留条目的用户子键不动
    expect(r.text).not.toContain("gone-model"); // 下架条目整体移除
    const r2 = patchDshProvider(r.text, input);
    expect(r2.text).toBe(r.text);
    expect(r2.changes).toHaveLength(0);
  });

  it("未接入时 providerFound=false 且不改文本", () => {
    const text = "llm-pi-ai:\n  providers:\n    other:\n      baseURL: https://x.example/v1\n";
    const r = patchDshProviderModels(text, { providerName: "axon", models });
    expect(r.providerFound).toBe(false);
    expect(r.text).toBe(text);
  });
});

describe("omp 块内合并 / 仅更新模型列表", () => {
  const OMP_EXISTING = [
    "providers:",
    "  others:",
    "    baseUrl: https://other.example/v1",
    "  mygw:",
    "    baseUrl: https://old.example/v1",
    "    api: openai-completions",
    "    apiKey: sk-old",
    "    authHeader: true",
    "    headers:",
    "      X-Trace: on",
    "    models:",
    "      - id: glm-5.3",
    "        reasoning: true",
    "        contextWindow: 1",
    "        maxTokens: 2",
    "        temperature: 0.3",
    "      - id: gone-model",
    "        reasoning: false",
    "        contextWindow: 1",
    "        maxTokens: 1",
    "",
  ].join("\n");

  const models = buildResolvedModels(["glm-5.3", "kimi-k3"]);

  it("models-only:条目按 id 合并,用户键保留,下架删除,apiKey/baseUrl 不动", () => {
    const r = patchOmpModelsList(OMP_EXISTING, { providerName: "mygw", models });
    expect(r.providerFound).toBe(true);
    expect(r.text).toContain("apiKey: sk-old");
    expect(r.text).toContain("baseUrl: https://old.example/v1");
    expect(r.text).toContain("X-Trace: on");
    expect(r.text).toContain("temperature: 0.3");
    expect(r.text).not.toContain("gone-model");
    expect(r.text).toContain("- id: kimi-k3");
    expect(r.text).toContain("others:");
    const r2 = patchOmpModelsList(r.text, { providerName: "mygw", models });
    expect(r2.text).toBe(r.text);
    expect(r2.changes).toHaveLength(0);
  });

  it("全量 patch:baseUrl/apiKey 更新、块内用户键保留", () => {
    const r = patchOmpModelsYml(OMP_EXISTING, {
      providerName: "mygw",
      baseUrl: "https://new.example/v1",
      apiKey: "sk-new",
      models: buildResolvedModels(["glm-5.3"]),
    });
    expect(r.text).toContain("baseUrl: https://new.example");
    expect(r.text).toContain("apiKey: sk-new");
    expect(r.text).toContain("X-Trace: on");
    expect(r.text).toContain("temperature: 0.3");
  });
});

describe("opencode 块内合并 / 仅更新模型列表", () => {
  const EXISTING =
    JSON.stringify(
      {
        model: "other/model",
        theme: "dark",
        provider: {
          mygw: {
            name: "Old Name",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://old.example/v1", headers: { "X-Trace": "on" } },
            models: { "glm-5.3": { name: "GLM", limit: { context: 1 } } },
            customKey: "keep",
          },
        },
      },
      null,
      2,
    ) + "\n";

  it("models-only:只合并 models,条目内用户字段保留,provider 元数据与顶层 model 不动", () => {
    const r = patchOpenCodeModels(EXISTING, { providerName: "mygw", models: buildResolvedModels(["glm-5.3", "kimi-k3"]) });
    expect(r.providerFound).toBe(true);
    const doc = JSON.parse(r.text) as any;
    expect(doc.model).toBe("other/model");
    expect(doc.provider.mygw.name).toBe("Old Name");
    expect(doc.provider.mygw.options.baseURL).toBe("https://old.example/v1");
    expect(doc.provider.mygw.options.headers["X-Trace"]).toBe("on");
    expect(doc.provider.mygw.customKey).toBe("keep");
    expect(doc.provider.mygw.models["glm-5.3"].limit).toEqual({ context: 1 });
    expect(doc.provider.mygw.models["kimi-k3"]).toBeTruthy();
    const r2 = patchOpenCodeModels(r.text, { providerName: "mygw", models: buildResolvedModels(["glm-5.3", "kimi-k3"]) });
    expect(r2.text).toBe(r.text);
  });

  it("全量 patch:provider 对象用户键保留,顶层 model 切换", () => {
    const r = patchOpenCodeConfig(EXISTING, {
      providerName: "mygw",
      displayName: "New Name",
      baseUrl: "https://new.example/v1",
      models: buildResolvedModels(["glm-5.3"]),
      defaultModel: "glm-5.3",
    });
    const doc = JSON.parse(r.text) as any;
    expect(doc.provider.mygw.name).toBe("New Name");
    expect(doc.provider.mygw.customKey).toBe("keep");
    expect(doc.provider.mygw.options.headers["X-Trace"]).toBe("on");
    expect(doc.model).toBe("mygw/glm-5.3");
  });
});

describe("reasonix 块内合并 / 仅更新模型列表", () => {
  const EXISTING = [
    "[[providers]]",
    'name = "axon"',
    "# 用户注释",
    'kind = "openai"',
    'base_url = "https://user-set.example/v1"',
    'models = ["glm-5.3"]',
    'api_key_env = "AXON_API_KEY"',
    'model_overrides = { "glm-5.3" = { context_window = 1, custom = "keep" } }',
    'default = "glm-5.3"',
    'custom_key = "keep"',
    "",
  ].join("\n");

  it("models-only:只改 models 与 model_overrides,其余键与注释保留", () => {
    const r = patchReasonixModels(EXISTING, {
      providerName: "axon",
      modelIds: ["glm-5.3", "kimi-k3"],
      modelContexts: { "glm-5.3": 1048576, "kimi-k3": 256000 },
    });
    expect(r.providerFound).toBe(true);
    expect(r.text).toContain('base_url = "https://user-set.example/v1"');
    expect(r.text).toContain("# 用户注释");
    expect(r.text).toContain('custom_key = "keep"');
    expect(r.text).toContain('models = ["glm-5.3", "kimi-k3"]');
    expect(r.text).toContain('"glm-5.3" = { context_window = 1048576, custom = "keep" }');
    expect(r.text).toContain('"kimi-k3" = { context_window = 256000 }');
    const r2 = patchReasonixModels(r.text, {
      providerName: "axon",
      modelIds: ["glm-5.3", "kimi-k3"],
      modelContexts: { "glm-5.3": 1048576, "kimi-k3": 256000 },
    });
    expect(r2.text).toBe(r.text);
    expect(r2.changes).toHaveLength(0);
  });

  it("未配置时 providerFound=false 且不改文本", () => {
    const text = '[[providers]]\nname = "other"\n';
    const r = patchReasonixModels(text, { providerName: "axon", modelIds: ["m"] });
    expect(r.providerFound).toBe(false);
    expect(r.text).toBe(text);
  });
});

describe("grok 块内合并 / 仅更新模型列表", () => {
  const EXISTING = [
    "# 用户配置",
    "[model_providers.other]",
    'base_url = "https://other.example/v1"',
    "",
    "[model_providers.axon]",
    'base_url = "https://old.example/v1"',
    'api_backend = "chat_completions"',
    'api_key = "sk-old"',
    "user_retry = 5",
    "",
    '[model."glm-5.3"]',
    'model = "glm-5.3"',
    'model_provider = "axon"',
    "temperature = 0.3",
    "context_window = 111",
    "",
    "[models]",
    'default = "glm-5.3"',
    "",
  ].join("\n");

  const models = [
    { id: "glm-5.3", contextWindow: 1048576, maxTokens: 131072 },
    { id: "kimi-k3", contextWindow: 256000, maxTokens: 96000 },
  ];

  it("models-only:模型块按 id 合并,块内用户键保留;provider 段与 api_key 不动", () => {
    const r = patchGrokModels(EXISTING, { providerName: "axon", label: "Axon", models });
    expect(r.providerFound).toBe(true);
    expect(r.text).toContain('base_url = "https://old.example/v1"');
    expect(r.text).toContain('api_key = "sk-old"');
    expect(r.text).toContain("user_retry = 5");
    expect(r.text).toContain("temperature = 0.3");
    expect(r.text).toContain("context_window = 1048576");
    expect(r.text).toContain("[model.kimi-k3]");
    expect(r.text).toContain("# 用户配置");
    const input = { providerName: "axon", label: "Axon", models };
    const r2 = patchGrokModels(r.text, input);
    expect(r2.text).toBe(r.text);
    expect(r2.changes).toHaveLength(0);
  });

  it("models-only:default 指向已下架模型时修正;未接入时 providerFound=false", () => {
    const stale = EXISTING.replace('default = "glm-5.3"', 'default = "gone-model"');
    const r = patchGrokModels(stale, { providerName: "axon", label: "Axon", models: [{ id: "kimi-k3", contextWindow: 1, maxTokens: 1 }] });
    expect(r.text).toContain('default = "kimi-k3"');
    const missing = patchGrokModels("[models]\n", { providerName: "axon", label: "Axon", models });
    expect(missing.providerFound).toBe(false);
    expect(missing.text).toBe("[models]\n");
  });

  it("全量 patch:provider 段用户键保留、模型块用户键保留、陈旧自有块移除", () => {
    const r = patchGrokConfigToml(EXISTING, {
      providerName: "axon",
      label: "Axon",
      baseUrl: "https://new.example/v1",
      apiKey: "sk-new",
      defaultModel: "glm-5.3",
      models: [models[0]],
    });
    expect(r.text).toContain('base_url = "https://new.example/v1"');
    expect(r.text).toContain('api_key = "sk-new"');
    expect(r.text).toContain("user_retry = 5");
    expect(r.text).toContain("temperature = 0.3");
    expect(r.text).toContain("[model_providers.other]");
  });
});
