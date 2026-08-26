import { describe, it, expect } from "vitest";
import { deriveKeyRef, buildResolvedModels } from "./models";
import { patchCodexConfigToml, renderCodexModelsJson } from "./codex";
import { patchReasonixProvider, patchReasonixServeAuth } from "./reasonix";
import { patchDshProvider, patchDshDefaultModel, removeDshDeepseekSection, removeDshOtherProviders, upsertDshCredentialYaml } from "./dsh";

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

  it("deepseek-v4-flash-vision-exp 按 flash 同规格 + 图像输入", () => {
    const [m] = buildResolvedModels(["deepseek-v4-flash-vision-exp"]);
    expect(m.name).toBe("DeepSeek V4 Flash Vision (Exp)");
    expect(m.contextWindow).toBe(1000000);
    expect(m.maxTokens).toBe(384000);
    expect(m.reasoning).toBe(true);
    expect(m.input).toEqual(["text", "image"]);
    expect(m.cost).toEqual({ input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 });
    expect(m.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: "high", xhigh: "max" });
    expect(m.compat.thinkingFormat).toBe("deepseek");
    expect(m.compat.requiresReasoningContentOnAssistantMessages).toBe(true);
  });
});

describe("patchCodexConfigToml", () => {
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

  it("默认模型段", () => {
    const r = patchDshDefaultModel("", "axon", "deepseek-v4-flash");
    expect(r.text).toContain("agent-default-model:");
    expect(r.text).toContain("provider: axon");
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

  it("removeDshDeepseekSection 删除废弃段", () => {
    const yaml = [
      "llm-pi-ai:",
      "  providers:",
      "    axon:",
      "      baseURL: https://a",
      "",
      "llm-deepseek:",
      "  apiKeyEnv: AXON_API_KEY",
      "  baseURL: https://x",
      "  models: []",
      "",
    ].join("\n");
    const r = removeDshDeepseekSection(yaml);
    expect(r.removed).toBe(true);
    expect(r.text).not.toContain("llm-deepseek:");
    expect(r.text).toContain("llm-pi-ai:");
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
