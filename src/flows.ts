// 高层编排:把 core/ 纯逻辑 + bridge/ I/O 组合成用户可触发的流程。

import * as bridge from "./bridge";
import { AGENT_CLIS } from "./core/agents";
import { buildResolvedModels, deriveKeyRef, isDeepseekModel, type ResolvedModel } from "./core/models";
import { generateToken, timestamp } from "./core/util";
import { patchCodexConfigToml, renderCodexModelsJson, parseCodexStatus } from "./core/codex";
import { patchReasonixProvider, patchReasonixServeAuth, parseReasonixStatus } from "./core/reasonix";
import { patchDshProvider, patchDshDefaultModel, removeDshDeepseekSection, removeDshOtherProviders, upsertDshCredentialYaml, parseDshStatus, type DshModelEntry } from "./core/dsh";
import { patchOmpModelsYml, patchOmpConfigYml, parseOmpStatus, ompBaseUrl } from "./core/omp";
import {
  compareAgentConfig,
  extractClaudeProvider,
  extractCodexProvider,
  extractDshProvider,
  extractOmpProvider,
  extractPiProvider,
  extractReasonixProvider,
  type AgentConfigCheck,
} from "./core/agent-config";

export type FlowResult = {
  changes: string[];
  lines: string[];
};

/** 默认模型选择:配置的优先;否则优先网关内常见的 deepseek-v4-flash,再退回第一个。 */
function pickDefaultModel(modelIds: string[], configured?: string): string {
  if (configured) return configured;
  if (modelIds.includes("deepseek-v4-flash")) return "deepseek-v4-flash";
  return modelIds[0] ?? "";
}

export async function testConnection(baseUrl: string, apiKey: string): Promise<bridge.ModelInfo[]> {
  return await bridge.fetchModels(baseUrl, apiKey);
}

/** 检测 agent CLI 安装位置:先 PATH,再各官方安装方式的常见目录。 */
export async function detectAgentCli(tool: string): Promise<string | null> {
  const info = AGENT_CLIS[tool];
  if (!info) return await bridge.detectCli(tool);
  return await bridge.detectCliIn(info.bin, info.dirs);
}

/** 检测某 agent 的配置文件里是否存在本 app 写入、且 baseUrl/Key 一致的 provider。 */
export async function detectAgentConfig(tool: string, cfg: bridge.AppConfig): Promise<AgentConfigCheck> {
  const home = await bridge.homeDir();
  const codexH = await bridge.codexHome();
  const reasonixH = await bridge.reasonixHome();
  const dshH = await bridge.dshHome();
  const claudeH = await bridge.joinPath(home, ".claude");
  const piH = await bridge.joinPath(home, ".pi", "agent");
  const ompH = await bridge.joinPath(home, ".omp", "agent");
  let wantUrl = cfg.baseUrl;
  let found;
  switch (tool) {
    case "claude": {
      const settingsPath = await bridge.joinPath(claudeH, "settings.json");
      found = extractClaudeProvider(await bridge.readFileOrEmpty(settingsPath));
      // Claude 写的是 Anthropic 端点(自动推导或手填),比对目标用该端点
      wantUrl = cfg.anthropicBaseUrl || (cfg.baseUrl ? deriveAnthropicUrl(cfg.baseUrl) : "");
      break;
    }
    case "codex": {
      const configPath = await bridge.joinPath(codexH, "config.toml");
      found = extractCodexProvider(await bridge.readFileOrEmpty(configPath), cfg.provider);
      break;
    }
    case "reasonix": {
      const configPath = await bridge.joinPath(reasonixH, "config.toml");
      const envPath = await bridge.joinPath(reasonixH, ".env");
      found = extractReasonixProvider(await bridge.readFileOrEmpty(configPath), await bridge.readFileOrEmpty(envPath), cfg.provider);
      break;
    }
    case "dsh": {
      const settingsPath = await bridge.joinPath(dshH, "settings.yaml");
      const credPath = await bridge.joinPath(dshH, ".credentials.yaml");
      found = extractDshProvider(await bridge.readFileOrEmpty(settingsPath), await bridge.readFileOrEmpty(credPath), cfg.provider);
      break;
    }
    case "pi": {
      const modelsPath = await bridge.joinPath(piH, "models.json");
      found = extractPiProvider(await bridge.readFileOrEmpty(modelsPath), cfg.provider);
      break;
    }
    case "omp": {
      const modelsPath = await bridge.joinPath(ompH, "models.yml");
      found = extractOmpProvider(await bridge.readFileOrEmpty(modelsPath), cfg.provider);
      wantUrl = ompBaseUrl(cfg.baseUrl); // omp 配置按官方指南去 /v1
      break;
    }
    default:
      return { state: "missing", baseUrl: null, keyMatches: false };
  }
  return compareAgentConfig({ baseUrl: wantUrl, apiKey: cfg.apiKey }, found);
}

function toDshEntries(models: ResolvedModel[]): DshModelEntry[] {
  return models.map((m) => {
    const entry: DshModelEntry = { id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning };
    if (m.name && m.name !== m.id) entry.name = m.name;
    if (m.thinkingLevelMap) {
      let efforts: Record<string, string | null> = {};
      if (m.reasoning && isDeepseekModel(m.id)) {
        // dsh(pi-ai) 的 DeepSeek 权威 reasoningEfforts:最高档用 max(非 xhigh),
        // flash 额外支持 low。与 pi 的 xhigh 体系不同,需单独映射,否则
        // dsh 默认请求 max 档时映射为 null,网关返回 400 INVALID_REQUEST。
        efforts = dshDeepseekEfforts(m.id);
      } else {
        for (const [level, wire] of Object.entries(m.thinkingLevelMap)) {
          if (level !== "off" && typeof wire === "string" && wire.length > 0) efforts[level] = wire;
        }
      }
      if (Object.keys(efforts).length > 0) entry.reasoningEfforts = efforts;
    }
    if (m.input?.includes("image")) entry.input = m.input;
    return entry;
  });
}

/** dsh(pi-ai) 内置目录的 DeepSeek 权威 reasoningEfforts(参考 @earendil-works/pi-ai deepseek 目录)。 */
export function dshDeepseekEfforts(id: string): Record<string, string> {
  if (id === "deepseek-v4-flash") return { low: "low", high: "high", max: "max" };
  return { high: "high", max: "max" };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export async function configureCodex(cfg: bridge.AppConfig, modelIds: string[]): Promise<FlowResult> {
  const home = await bridge.codexHome();
  const configPath = await bridge.joinPath(home, "config.toml");
  const modelsPath = await bridge.joinPath(home, "models.json");
  const resolved = buildResolvedModels(modelIds);

  const cfgText = await bridge.readFileOrEmpty(configPath);
  const patched = patchCodexConfigToml(cfgText, {
    providerName: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    defaultModel: pickDefaultModel(resolved.map((m) => m.id), cfg.defaultModel),
    modelsJsonPath: modelsPath,
  });

  const written = await bridge.writeWithBackup(configPath, patched.text);
  // 保留现有 models.json 里非当前 provider 的条目(兼容用户已有模型)
  const existingModels = await bridge.readFileOrEmpty(modelsPath);
  const modelsJson = renderCodexModelsJson(resolved, cfg.provider, existingModels);
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
  const s = parseCodexStatus(await bridge.readFileOrEmpty(configPath), await bridge.readFileOrEmpty(modelsPath), {
    configExists: await bridge.exists(configPath),
    authJsonExists: await bridge.exists(authPath),
  });
  const cli = await detectAgentCli("codex");
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

  const cfgText = await bridge.readFileOrEmpty(configPath);
  const patched = patchReasonixProvider(cfgText, {
    providerName: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKeyEnv,
    modelIds: resolved.map((m) => m.id),
    defaultModel: pickDefaultModel(resolved.map((m) => m.id), cfg.defaultModel),
    modelContexts,
  });

  const written = await bridge.writeWithBackup(configPath, patched.text);
  const envText = await bridge.readFileOrEmpty(envPath);
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
  const cfgText = await bridge.readFileOrEmpty(configPath);
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
  const cfgText = await bridge.readFileOrEmpty(configPath);
  const patched = patchReasonixServeAuth(cfgText, "none");
  if (patched.changes.length === 0) return { changes: [], lines: ["鉴权已处于关闭状态,无需修改"] };
  const written = await bridge.writeWithBackup(configPath, patched.text);
  return { changes: patched.changes, lines: [`已关闭鉴权(${patched.changes.join(", ")})`, `写入: ${written.path}`] };
}

export async function reasonixStatus(cfg: bridge.AppConfig): Promise<string[]> {
  const home = await bridge.reasonixHome();
  const configPath = await bridge.joinPath(home, "config.toml");
  const envPath = await bridge.joinPath(home, ".env");
  const s = parseReasonixStatus(await bridge.readFileOrEmpty(configPath), await bridge.readFileOrEmpty(envPath), cfg.provider);
  const cli = await detectAgentCli("reasonix");
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
  const defaultModel = pickDefaultModel(resolved.map((m) => m.id), cfg.defaultModel);

  let settingsText = await bridge.readFileOrEmpty(settingsPath);
  const cleanup: string[] = [];
  // 清理旧版遗留:废弃的 llm-deepseek 段 + 改 provider 名后残留的旧 provider 路由
  const rmDs = removeDshDeepseekSection(settingsText);
  if (rmDs.removed) {
    settingsText = rmDs.text;
    cleanup.push("移除废弃的 llm-deepseek 段");
  }
  const rmProv = removeDshOtherProviders(settingsText, cfg.provider);
  if (rmProv.removed.length > 0) {
    settingsText = rmProv.text;
    cleanup.push(`清理旧 provider 路由: ${rmProv.removed.join(", ")}`);
  }

  // 所有模型(含 DeepSeek)统一走 llm-pi-ai 的 hand-declared route(对齐 dsh 官方
  // acme-gateway 示例):DeepSeek 模型靠 reasoningEfforts + compat.thinkingFormat
  // 声明推理能力与 DeepSeek 方言,私有网关 URL 认不出方言所以必须显式声明。
  const entries = toDshEntries(resolved);
  const p1 = patchDshProvider(settingsText, {
    providerName: cfg.provider,
    displayName: cfg.displayName || cfg.provider,
    apiKeyEnv,
    baseUrl: cfg.baseUrl,
    models: entries,
  });
  const p2 = patchDshDefaultModel(p1.text, cfg.provider, defaultModel);
  const allChanges = [...cleanup, ...p1.changes, ...p2.changes];

  const written = await bridge.writeWithBackup(settingsPath, p2.text);
  const credText = await bridge.readFileOrEmpty(credPath);
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
  const s = parseDshStatus(await bridge.readFileOrEmpty(settingsPath), await bridge.readFileOrEmpty(credPath), cfg.provider, apiKeyEnv);
  const cli = await detectAgentCli("dsh");
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

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

import { deriveAnthropicUrl, formatClaudeModel, patchClaudeSettings, parseClaudeStatus } from "./core/claude";
import { patchPiModelsJson, patchPiSettings, parsePiStatus } from "./core/pi";

export type ClaudeRoleSelection = {
  main: string;
  haiku: string;
  sonnet: string;
  opus: string;
  fable: string;
  subagent: string;
};

/** 读取当前 ~/.claude/settings.json 的角色模型(去掉 [1m]/[200k] 后缀),用于弹窗默认值。 */
export async function getClaudeCurrentRoles(): Promise<ClaudeRoleSelection | null> {
  const home = await bridge.homeDir();
  const settingsPath = await bridge.joinPath(home, ".claude", "settings.json");
  const s = parseClaudeStatus(await bridge.readFileOrEmpty(settingsPath));
  if (!s.model && !s.haikuModel && !s.sonnetModel && !s.opusModel && !s.fableModel && !s.subagentModel) {
    return null;
  }
  const strip = (v: string | null): string => (v ? v.replace(/\[[^\]]*\]$/, "") : "");
  return {
    main: strip(s.model),
    haiku: strip(s.haikuModel),
    sonnet: strip(s.sonnetModel),
    opus: strip(s.opusModel),
    fable: strip(s.fableModel),
    subagent: strip(s.subagentModel),
  };
}

export async function configureClaude(cfg: bridge.AppConfig, roles: ClaudeRoleSelection): Promise<FlowResult> {
  const home = await bridge.homeDir();
  const settingsPath = await bridge.joinPath(home, ".claude", "settings.json");
  // 每个角色的模型按真实上下文窗口加官方后缀([1m]/[200k])
  const fmt = (id: string): string => {
    const cw = buildResolvedModels(id ? [id] : [])[0]?.contextWindow ?? 0;
    return formatClaudeModel(id, cw);
  };
  const mainCw = buildResolvedModels([roles.main])[0]?.contextWindow ?? 0;
  const anthropicBaseUrl = cfg.anthropicBaseUrl || deriveAnthropicUrl(cfg.baseUrl);
  const patched = patchClaudeSettings(await bridge.readFileOrEmpty(settingsPath), {
    anthropicBaseUrl,
    apiKey: cfg.apiKey,
    mainModel: fmt(roles.main),
    roles: {
      haiku: fmt(roles.haiku),
      sonnet: fmt(roles.sonnet),
      opus: fmt(roles.opus),
      fable: fmt(roles.fable),
      subagent: fmt(roles.subagent),
    },
    // 主模型 <200k 无后缀时用全局兜底;否则后缀已足够,不设以免冲突
    maxContextTokens: mainCw > 0 && mainCw < 200_000 ? mainCw : undefined,
  });
  const written = await bridge.writeWithBackup(settingsPath, patched.text);
  const lines = [
    `settings.json: ${written.path}`,
    `  ${patched.changes.join(", ") || "无变化"}`,
    `Anthropic 端点: ${anthropicBaseUrl}`,
  ];
  if (written.backup) lines.push(`备份: ${written.backup}`);
  return { changes: patched.changes, lines };
}

export async function claudeStatus(): Promise<string[]> {
  const home = await bridge.homeDir();
  const settingsPath = await bridge.joinPath(home, ".claude", "settings.json");
  const s = parseClaudeStatus(await bridge.readFileOrEmpty(settingsPath));
  const cli = await detectAgentCli("claude");
  return [
    `Claude 配置: ${settingsPath}`,
    `settings.json: ${s.settingsExists ? "存在" : "缺失"}`,
    `ANTHROPIC_BASE_URL: ${s.baseUrl ?? "(未设置)"}`,
    `ANTHROPIC_AUTH_TOKEN: ${s.authTokenSet ? "已设置" : "未设置"}`,
    `ANTHROPIC_MODEL: ${s.model ?? "(未设置)"}`,
    `claude CLI: ${cli ?? "未检测到"}`,
  ];
}

// ---------------------------------------------------------------------------
// pi agent
// ---------------------------------------------------------------------------

export async function configurePi(cfg: bridge.AppConfig, modelIds: string[]): Promise<FlowResult> {
  const home = await bridge.homeDir();
  const piDir = await bridge.joinPath(home, ".pi", "agent");
  const modelsPath = await bridge.joinPath(piDir, "models.json");
  const settingsPath = await bridge.joinPath(piDir, "settings.json");
  const resolved = buildResolvedModels(modelIds);
  const defaultModel = pickDefaultModel(resolved.map((m) => m.id), cfg.defaultModel);

  const p1 = patchPiModelsJson(await bridge.readFileOrEmpty(modelsPath), {
    providerName: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    models: resolved,
  });
  const p2 = patchPiSettings(await bridge.readFileOrEmpty(settingsPath), cfg.provider, defaultModel);
  const allChanges = [...p1.changes, ...p2.changes];
  const w1 = await bridge.writeWithBackup(modelsPath, p1.text);
  const w2 = await bridge.writeWithBackup(settingsPath, p2.text);

  const lines = [
    `models.json: ${w1.path}`,
    `  ${p1.changes.join(", ") || "无变化"}`,
    `settings.json: ${w2.path}`,
    `  ${p2.changes.join(", ") || "无变化"}`,
    `默认模型: ${cfg.provider}/${defaultModel}(Pi 内用 /model 切换,重启 Pi 生效)`,
  ];
  if (w1.backup) lines.push(`备份: ${w1.backup}`);
  return { changes: allChanges, lines };
}

export async function piStatus(cfg: bridge.AppConfig): Promise<string[]> {
  const home = await bridge.homeDir();
  const piDir = await bridge.joinPath(home, ".pi", "agent");
  const modelsPath = await bridge.joinPath(piDir, "models.json");
  const settingsPath = await bridge.joinPath(piDir, "settings.json");
  const s = parsePiStatus(await bridge.readFileOrEmpty(modelsPath), await bridge.readFileOrEmpty(settingsPath), cfg.provider);
  return [
    `Pi 配置: ${piDir}`,
    `models.json: ${s.modelsExists ? "存在" : "缺失"}`,
    `provider ${cfg.provider}: ${s.providerConfigured ? `已配置(${s.providerModels} 个模型, baseURL=${s.providerBaseUrl})` : "未配置"}`,
    `settings.json: ${s.settingsExists ? "存在" : "缺失"}`,
    `defaultProvider: ${s.defaultProvider ?? "(未设置)"}`,
    `defaultModel: ${s.defaultModel ?? "(未设置)"}`,
  ];
}

// ---------------------------------------------------------------------------
// Oh My Pi (omp)
// ---------------------------------------------------------------------------

export async function configureOmp(cfg: bridge.AppConfig, modelIds: string[]): Promise<FlowResult> {
  const home = await bridge.homeDir();
  const ompDir = await bridge.joinPath(home, ".omp", "agent");
  const modelsPath = await bridge.joinPath(ompDir, "models.yml");
  const configPath = await bridge.joinPath(ompDir, "config.yml");
  const resolved = buildResolvedModels(modelIds);
  const defaultModel = pickDefaultModel(resolved.map((m) => m.id), cfg.defaultModel);

  const p1 = patchOmpModelsYml(await bridge.readFileOrEmpty(modelsPath), {
    providerName: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    models: resolved,
  });
  const written = await bridge.writeWithBackup(modelsPath, p1.text);

  const p2 = patchOmpConfigYml(await bridge.readFileOrEmpty(configPath), cfg.provider, defaultModel);
  const cfgWritten = await bridge.writeWithBackup(configPath, p2.text);

  const deepseekCount = resolved.filter((m) => isDeepseekModel(m.id)).length;
  const lines = [
    `models.yml: ${written.path}`,
    `  ${p1.changes.join(", ") || "无变化"}`,
    `config.yml: ${cfgWritten.path}`,
    `  ${p2.changes.join(", ") || "无变化"}`,
  ];
  if (deepseekCount > 0) lines.push(`DeepSeek 模型 ${deepseekCount} 个:已应用官方特配(thinking 等级 + 完整 compat 块)`);
  lines.push(`使用: omp --model ${cfg.provider}/${defaultModel}`);
  if (written.backup) lines.push(`备份: ${written.backup}`);
  return { changes: [...p1.changes, ...p2.changes], lines };
}

export async function ompStatus(cfg: bridge.AppConfig): Promise<string[]> {
  const home = await bridge.homeDir();
  const ompDir = await bridge.joinPath(home, ".omp", "agent");
  const modelsPath = await bridge.joinPath(ompDir, "models.yml");
  const configPath = await bridge.joinPath(ompDir, "config.yml");
  const s = parseOmpStatus(await bridge.readFileOrEmpty(modelsPath), await bridge.readFileOrEmpty(configPath), cfg.provider);
  const cli = await detectAgentCli("omp");
  return [
    `omp 配置目录: ${ompDir}`,
    `models.yml: ${s.modelsExists ? "存在" : "缺失"}`,
    `provider ${cfg.provider}: ${s.providerConfigured ? `已配置(${s.providerModels} 个模型, baseUrl=${s.providerBaseUrl})` : "未配置"}`,
    `config.yml: ${s.configExists ? "存在" : "缺失"}`,
    `modelRoles.default: ${s.defaultRole ?? "(未设置)"}`,
    `omp CLI: ${cli ?? "未检测到"}`,
  ];
}

// ---------------------------------------------------------------------------
// 备份还原(所有工具)
// ---------------------------------------------------------------------------

export type BackupInfo = { path: string; name: string; size: number; mtimeMs: number };
export type RestoreTarget = { id: string; label: string; path: string };

/** 各工具可还原的文件目标。 */
export async function getRestoreTargets(tool: string): Promise<RestoreTarget[]> {
  const home = await bridge.homeDir();
  const codexH = await bridge.codexHome();
  const reasonixH = await bridge.reasonixHome();
  const dshH = await bridge.dshHome();
  const claudeH = await bridge.joinPath(home, ".claude");
  const piH = await bridge.joinPath(home, ".pi", "agent");
  switch (tool) {
    case "codex":
      return [
        { id: "codex-config", label: "Codex config.toml", path: await bridge.joinPath(codexH, "config.toml") },
        { id: "codex-models", label: "Codex models.json", path: await bridge.joinPath(codexH, "models.json") },
      ];
    case "reasonix":
      return [{ id: "reasonix-config", label: "Reasonix config.toml", path: await bridge.joinPath(reasonixH, "config.toml") }];
    case "dsh":
      return [{ id: "dsh-settings", label: "dsh settings.yaml", path: await bridge.joinPath(dshH, "settings.yaml") }];
    case "claude":
      return [{ id: "claude-settings", label: "Claude settings.json", path: await bridge.joinPath(claudeH, "settings.json") }];
    case "pi":
      return [
        { id: "pi-models", label: "Pi models.json", path: await bridge.joinPath(piH, "models.json") },
        { id: "pi-settings", label: "Pi settings.json", path: await bridge.joinPath(piH, "settings.json") },
      ];
    case "omp":
      {
        const ompH = await bridge.joinPath(home, ".omp", "agent");
        return [
          { id: "omp-models", label: "omp models.yml", path: await bridge.joinPath(ompH, "models.yml") },
          { id: "omp-config", label: "omp config.yml", path: await bridge.joinPath(ompH, "config.yml") },
        ];
      }
    default:
      return [];
  }
}

/** 列出某目标文件的所有备份(.bak-*),按时间倒序。 */
export async function listBackups(targetPath: string): Promise<BackupInfo[]> {
  const dir = bridge.dirnamePath(targetPath);
  const base = bridge.basenamePath(targetPath);
  const files = await bridge.readDir(dir);
  const out: BackupInfo[] = [];
  for (const f of files) {
    if (f.isFile && f.name.startsWith(`${base}.bak-`)) {
      out.push({ path: await bridge.joinPath(dir, f.name), name: f.name, size: f.size, mtimeMs: f.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 用备份覆盖目标:当前文件先备份为 .bak-pre-restore-<ts>。 */
export async function restoreBackup(targetPath: string, backupPath: string): Promise<{ path: string; backup?: string }> {
  const content = await bridge.readFile(backupPath);
  return await applyBackupContent(targetPath, content);
}

/** 用指定内容覆盖目标(查看/编辑弹窗的「应用」用):当前文件先备份为 .bak-pre-restore-<ts>。 */
export async function applyBackupContent(targetPath: string, content: string): Promise<{ path: string; backup?: string }> {
  let backup: string | undefined;
  const current = await bridge.readFileOrEmpty(targetPath);
  if (current) {
    backup = `${targetPath}.bak-pre-restore-${timestamp()}`;
    await bridge.writeFile(backup, current);
  }
  await bridge.writeFile(targetPath, content);
  return { path: targetPath, backup };
}

/** 重命名备份文件(同目录内),目标已存在时报错。返回新路径。 */
export async function renameBackup(oldPath: string, newName: string): Promise<string> {
  const dir = bridge.dirnamePath(oldPath);
  const newPath = await bridge.joinPath(dir, newName);
  if (await bridge.exists(newPath)) throw new Error("同名文件已存在");
  await bridge.renameFile(oldPath, newPath);
  return newPath;
}

// ---------------------------------------------------------------------------
// Doubao 过滤(全局开关,默认开启;参考插件 CODEX_EXCLUDED_MODELS 团队排除名单)
// ---------------------------------------------------------------------------

/** 是否为 Doubao 系模型。 */
export function isDoubaoModel(id: string): boolean {
  return /doubao/i.test(id);
}

/** 按开关过滤模型列表。 */
export function filterDoubao(models: string[], exclude: boolean): string[] {
  return exclude ? models.filter((id) => !isDoubaoModel(id)) : models;
}
