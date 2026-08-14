// 高层编排:把 core/ 纯逻辑 + bridge/ I/O 组合成用户可触发的流程。

import * as bridge from "./bridge";
import { buildResolvedModels, deriveKeyRef, type ResolvedModel } from "./core/models";
import { generateToken } from "./core/util";
import { patchCodexConfigToml, renderCodexModelsJson, parseCodexStatus } from "./core/codex";
import { patchReasonixProvider, patchReasonixServeAuth, parseReasonixStatus } from "./core/reasonix";
import { patchDshProvider, patchDshDefaultModel, upsertDshCredentialYaml, parseDshStatus, type DshModelEntry } from "./core/dsh";

export type FlowResult = {
  changes: string[];
  lines: string[];
};

export async function testConnection(baseUrl: string, apiKey: string): Promise<string[]> {
  return await bridge.fetchModels(baseUrl, apiKey);
}

function toDshEntries(models: ResolvedModel[]): DshModelEntry[] {
  return models.map((m) => {
    const entry: DshModelEntry = { id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning };
    if (m.name && m.name !== m.id) entry.name = m.name;
    if (m.thinkingLevelMap) {
      const efforts: Record<string, string | null> = {};
      for (const [level, wire] of Object.entries(m.thinkingLevelMap)) {
        if (level !== "off" && typeof wire === "string" && wire.length > 0) efforts[level] = wire;
      }
      if (Object.keys(efforts).length > 0) entry.reasoningEfforts = efforts;
    }
    if (m.input?.includes("image")) entry.input = m.input;
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export async function configureCodex(cfg: bridge.AppConfig, modelIds: string[]): Promise<FlowResult> {
  const home = await bridge.codexHome();
  const configPath = await bridge.joinPath(home, "config.toml");
  const modelsPath = await bridge.joinPath(home, "models.json");
  const resolved = buildResolvedModels(modelIds);

  const cfgText = await bridge.readFile(configPath);
  const patched = patchCodexConfigToml(cfgText, {
    providerName: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    defaultModel: cfg.defaultModel || resolved[0]?.id,
    modelsJsonPath: modelsPath,
  });

  const written = await bridge.writeWithBackup(configPath, patched.text);
  const modelsJson = renderCodexModelsJson(resolved, cfg.provider);
  const modelsWritten = await bridge.writeWithBackup(modelsPath, modelsJson);

  const lines = [
    `config.toml: ${written.path}`,
    `  ${patched.changes.join(", ") || "无变化"}`,
    `models.json: ${modelsWritten.path}(${resolved.length} 个模型)`,
  ];
  if (written.backup) lines.push(`备份: ${written.backup}`);
  return { changes: patched.changes, lines };
}

export async function codexStatus(): Promise<string[]> {
  const home = await bridge.codexHome();
  const configPath = await bridge.joinPath(home, "config.toml");
  const modelsPath = await bridge.joinPath(home, "models.json");
  const authPath = await bridge.joinPath(home, "auth.json");
  const s = parseCodexStatus(await bridge.readFile(configPath), await bridge.readFile(modelsPath), {
    configExists: await bridge.exists(configPath),
    authJsonExists: await bridge.exists(authPath),
  });
  const cli = await bridge.detectCli("codex");
  return [
    `Codex home: ${home}`,
    `config.toml: ${s.configExists ? "存在" : "缺失"}`,
    `auth.json: ${s.authJsonExists ? "存在" : "缺失"}${s.requiresOpenaiAuth ? "(requires_openai_auth=true,风险!)" : ""}`,
    `model_provider: ${s.provider ?? "(未设置)"}`,
    `model: ${s.model ?? "(未设置)"}`,
    `model_catalog_json: ${s.modelCatalogJson ?? "(未设置!)"}`,
    `provider 段: ${s.providerConfigured ? "已配置" : "未配置"}`,
    `models.json: ${s.catalogCount} 条(list ${s.catalogList} / hide ${s.catalogHide})`,
    `codex CLI: ${cli ?? "未检测到"}`,
  ];
}

// ---------------------------------------------------------------------------
// Reasonix
// ---------------------------------------------------------------------------

export async function configureReasonix(cfg: bridge.AppConfig, modelIds: string[]): Promise<FlowResult> {
  const home = await bridge.reasonixHome();
  const configPath = await bridge.joinPath(home, "config.toml");
  const envPath = await bridge.joinPath(home, ".env");
  const apiKeyEnv = deriveKeyRef(cfg.provider);
  const resolved = buildResolvedModels(modelIds);
  const modelContexts: Record<string, number> = {};
  for (const m of resolved) modelContexts[m.id] = m.contextWindow;

  const cfgText = await bridge.readFile(configPath);
  const patched = patchReasonixProvider(cfgText, {
    providerName: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKeyEnv,
    modelIds: resolved.map((m) => m.id),
    defaultModel: cfg.defaultModel || resolved[0]?.id,
    modelContexts,
  });

  const written = await bridge.writeWithBackup(configPath, patched.text);
  const envText = await bridge.readFile(envPath);
  const envPatched = bridge.upsertEnvKey(envText, apiKeyEnv, cfg.apiKey);
  const envWritten = await bridge.writeSecret(envPath, envPatched.text);

  const lines = [
    `config.toml: ${written.path}`,
    `  ${patched.changes.join(", ") || "无变化"}`,
    `凭据: ${envWritten}(${apiKeyEnv}${envPatched.changed ? "" : ",已存在"})`,
  ];
  if (written.backup) lines.push(`备份: ${written.backup}`);
  return { changes: patched.changes, lines };
}

export async function generateReasonixAuth(): Promise<FlowResult> {
  const home = await bridge.reasonixHome();
  const configPath = await bridge.joinPath(home, "config.toml");
  const token = generateToken();
  const cfgText = await bridge.readFile(configPath);
  const patched = patchReasonixServeAuth(cfgText, "token", token);
  const written = await bridge.writeWithBackup(configPath, patched.text);
  const lines = [
    `Token: ${token}`,
    `写入: ${written.path} 的 [serve] 段(auth_mode = "token")`,
    `本机访问: http://127.0.0.1:8787/#token=${token}`,
    `局域网/公网: reasonix serve --addr 0.0.0.0:8787 --token ${token}`,
    `重新生成会覆盖旧 token,旧 token 立即失效`,
  ];
  return { changes: patched.changes, lines };
}

export async function disableReasonixAuth(): Promise<FlowResult> {
  const home = await bridge.reasonixHome();
  const configPath = await bridge.joinPath(home, "config.toml");
  const cfgText = await bridge.readFile(configPath);
  const patched = patchReasonixServeAuth(cfgText, "none");
  if (patched.changes.length === 0) return { changes: [], lines: ["鉴权已处于关闭状态,无需修改"] };
  const written = await bridge.writeWithBackup(configPath, patched.text);
  return { changes: patched.changes, lines: [`已关闭鉴权(${patched.changes.join(", ")})`, `写入: ${written.path}`] };
}

export async function reasonixStatus(cfg: bridge.AppConfig): Promise<string[]> {
  const home = await bridge.reasonixHome();
  const configPath = await bridge.joinPath(home, "config.toml");
  const envPath = await bridge.joinPath(home, ".env");
  const s = parseReasonixStatus(await bridge.readFile(configPath), await bridge.readFile(envPath), cfg.provider);
  const cli = await bridge.detectCli("reasonix");
  return [
    `Reasonix home: ${home}`,
    `config.toml: ${s.configExists ? "存在" : "缺失"}`,
    `[serve] auth_mode: ${s.authMode ?? "(未设置,默认 none)"}`,
    `[serve] token: ${s.tokenSet && s.tokenMasked ? `${s.tokenMasked}(已设置)` : "未设置"}`,
    `provider ${cfg.provider}: ${s.providerConfigured ? `已配置(${s.providerModels} 个模型, default=${s.providerDefault ?? "无"})` : "未配置"}`,
    `  api_key_env: ${s.providerApiKeyEnv ?? "(无)"}`,
    `  API Key 在 .env: ${s.keyInEnvFile ? "是" : "否"}`,
    `reasonix CLI: ${cli ?? "未检测到"}`,
  ];
}

// ---------------------------------------------------------------------------
// DeepSeek Harness (dsh)
// ---------------------------------------------------------------------------

export async function configureDsh(cfg: bridge.AppConfig, modelIds: string[]): Promise<FlowResult> {
  const home = await bridge.dshHome();
  const settingsPath = await bridge.joinPath(home, "settings.yaml");
  const credPath = await bridge.joinPath(home, ".credentials.yaml");
  const apiKeyEnv = deriveKeyRef(cfg.provider);
  const resolved = buildResolvedModels(modelIds);
  const entries = toDshEntries(resolved);
  const defaultModel = cfg.defaultModel || resolved[0]?.id || "";

  const settingsText = await bridge.readFile(settingsPath);
  const p1 = patchDshProvider(settingsText, {
    providerName: cfg.provider,
    displayName: cfg.displayName || cfg.provider,
    apiKeyEnv,
    baseUrl: cfg.baseUrl,
    models: entries,
  });
  const p2 = patchDshDefaultModel(p1.text, cfg.provider, defaultModel);
  const allChanges = [...p1.changes, ...p2.changes];

  const written = await bridge.writeWithBackup(settingsPath, p2.text);
  const credText = await bridge.readFile(credPath);
  const credPatched = upsertDshCredentialYaml(credText, apiKeyEnv, cfg.apiKey);
  const credWritten = await bridge.writeSecret(credPath, credPatched.text);

  const lines = [
    `settings.yaml: ${written.path}`,
    `  ${allChanges.join(", ") || "无变化"}`,
    `凭据: ${credWritten}(${apiKeyEnv}${credPatched.changed ? "" : ",已存在"})`,
    `Web UI: http://127.0.0.1:3080`,
    `启动: npx @deepseek-ai/dsh web`,
  ];
  if (written.backup) lines.push(`备份: ${written.backup}`);
  return { changes: allChanges, lines };
}

export async function dshStatus(cfg: bridge.AppConfig): Promise<string[]> {
  const home = await bridge.dshHome();
  const settingsPath = await bridge.joinPath(home, "settings.yaml");
  const credPath = await bridge.joinPath(home, ".credentials.yaml");
  const apiKeyEnv = deriveKeyRef(cfg.provider);
  const s = parseDshStatus(await bridge.readFile(settingsPath), await bridge.readFile(credPath), cfg.provider, apiKeyEnv);
  const cli = await bridge.detectCli("dsh");
  return [
    `dsh home: ${home}`,
    `settings.yaml: ${s.settingsExists ? "存在" : "缺失"}`,
    `.credentials.yaml: ${s.credentialsExists ? "存在" : "缺失"}`,
    `provider ${cfg.provider}: ${s.providerConfigured ? `已配置(${s.providerModels} 个模型)` : "未配置"}`,
    `  api_key_env: ${s.providerApiKeyEnv ?? "(无)"}`,
    `  baseURL: ${s.providerBaseUrl ?? "(无)"}`,
    `  默认模型: ${s.defaultModelProvider ? `${s.defaultModelProvider}/${s.defaultModelModel ?? ""}` : "(未设置)"}`,
    `  凭据在 .credentials.yaml: ${s.credentialStored ? "是" : "否"}`,
    `dsh CLI: ${cli ?? "未检测到(可用 npx @deepseek-ai/dsh web 启动)"}`,
  ];
}
