import { describe, it, expect } from "vitest";
import { deriveKeyRef, buildResolvedModels } from "./models";
import { patchCodexConfigToml, renderCodexModelsJson } from "./codex";
import { patchReasonixProvider, patchReasonixServeAuth } from "./reasonix";
import { patchDshProvider, patchDshDefaultModel, upsertDshCredentialYaml } from "./dsh";

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
  it("空文件创建 llm-pi-ai.providers.<name>,不写 off", () => {
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
    expect(r.text).not.toContain("off:");
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
});

import { deriveAnthropicUrl, patchClaudeSettings, parseClaudeStatus } from "./claude";
import { patchPiModelsJson, patchPiSettings, parsePiStatus } from "./pi";

describe("claude", () => {
  it("推导 Anthropic 端点", () => {
    expect(deriveAnthropicUrl("http://host:8080/api/v1")).toBe("http://host:8080/api/anthropic");
    expect(deriveAnthropicUrl("https://gw.example/v1")).toBe("https://gw.example/api/anthropic");
    expect(deriveAnthropicUrl("https://gw.example/base")).toBe("https://gw.example/base/api/anthropic");
  });

  it("合并 env 到 settings.json,保留其它键", () => {
    const r = patchClaudeSettings('{"permissions":{"allow":["Bash(ls *)"]}}', {
      anthropicBaseUrl: "http://host/api/anthropic",
      apiKey: "sk-x",
      model: "m1",
    });
    const doc = JSON.parse(r.text) as { permissions: unknown; env: Record<string, string> };
    expect(doc.permissions).toEqual({ allow: ["Bash(ls *)"] });
    expect(doc.env.ANTHROPIC_BASE_URL).toBe("http://host/api/anthropic");
    expect(doc.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-x");
    expect(doc.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("m1");
  });

  it("状态解析", () => {
    const s = parseClaudeStatus('{"env":{"ANTHROPIC_BASE_URL":"http://h","ANTHROPIC_AUTH_TOKEN":"t","ANTHROPIC_MODEL":"m"}}');
    expect(s.baseUrl).toBe("http://h");
    expect(s.authTokenSet).toBe(true);
    expect(s.model).toBe("m");
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
