// 应用自身配置(多 Provider profile):迁移 / 激活 / 增删 / 落盘序列化,纯函数无 I/O。
// 内存中的 AppConfig 顶层字段始终等于「当前激活 profile」的字段(各流程直接读顶层),
// 落盘则序列化为 { profiles, activeProfileId, excludeDoubao, codexProxy }:profile 是唯一数据源。

export type ConfigModelRow = { id: string; ownedBy?: string };

export type ProviderProfile = {
  id: string;
  /** 写入各工具的 provider 路由名。 */
  provider: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  /** Anthropic 兼容端点(Claude 用);留空时自动从 baseUrl 推导。 */
  anthropicBaseUrl: string;
  /** 该网关的默认模型;留空时按模型列表自动挑选。 */
  defaultModel: string;
  /** 上次拉取到的模型列表:按 profile 保存,切回该网关时立即恢复展示。 */
  models?: ConfigModelRow[];
  /** Codex 可见模型选择(visibility="list"):每个 profile 独立记忆,切换网关不互相覆盖。 */
  codexListed?: string[];
  /** 做出上述选择时的完整模型列表:其后网关新增的模型仍会触发「超上限挑选」。 */
  codexKnown?: string[];
};

export type AppConfig = {
  // 以下字段 = 当前激活 profile 的视图(内存便利字段,落盘时写入对应 profile)
  provider: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  anthropicBaseUrl: string;
  defaultModel: string;
  models?: ConfigModelRow[];
  profiles: ProviderProfile[];
  activeProfileId: string;
  /** 全局过滤 Doubao 系模型(默认开启,生成配置不含 doubao)。 */
  excludeDoubao: boolean;
  /** Codex Responses 转换代理(网关 /responses 对部分模型如 gpt-5.6 转换不可用时开启)。 */
  codexProxy?: { enabled: boolean; port: number };
};

export function emptyProfile(id: string, provider = "axon", displayName = "Axon"): ProviderProfile {
  return { id, provider, displayName, baseUrl: "", apiKey: "", anthropicBaseUrl: "", defaultModel: "" };
}

/** profile 的字段视图(铺到 AppConfig 顶层用)。 */
function fieldsOf(p: ProviderProfile): Omit<AppConfig, "profiles" | "activeProfileId" | "excludeDoubao" | "codexProxy"> {
  const out: Omit<AppConfig, "profiles" | "activeProfileId" | "excludeDoubao" | "codexProxy"> = {
    provider: p.provider,
    displayName: p.displayName,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    anthropicBaseUrl: p.anthropicBaseUrl,
    defaultModel: p.defaultModel,
  };
  if (p.models) out.models = p.models;
  return out;
}

const DEFAULT_PROFILE = emptyProfile("p1");

export const DEFAULT_CONFIG: AppConfig = {
  ...fieldsOf(DEFAULT_PROFILE),
  profiles: [DEFAULT_PROFILE],
  activeProfileId: DEFAULT_PROFILE.id,
  excludeDoubao: true,
  codexProxy: { enabled: true, port: 17321 },
};

/** 深拷贝一份配置(默认配置是模块级单例,避免就地修改污染)。 */
export function cloneConfig(cfg: AppConfig): AppConfig {
  return { ...cfg, profiles: cfg.profiles.map((p) => ({ ...p, models: p.models?.map((m) => ({ ...m })), codexListed: p.codexListed ? [...p.codexListed] : undefined, codexKnown: p.codexKnown ? [...p.codexKnown] : undefined })) };
}

/** 生成未被占用的 profile id(p1/p2/…,稳定可读,便于对照 config.json 排障)。 */
export function newProfileId(profiles: ProviderProfile[]): string {
  const ids = new Set(profiles.map((p) => p.id));
  let n = 1;
  while (ids.has(`p${n}`)) n++;
  return `p${n}`;
}

/** 当前激活 profile(profiles 至少有一个,见 migrateAppConfig/removeProfile)。 */
export function activeProfile(cfg: AppConfig): ProviderProfile {
  return cfg.profiles.find((p) => p.id === cfg.activeProfileId) ?? cfg.profiles[0];
}

/** 顶层字段 → 激活 profile(落盘前调用;保证表单改动写回所属 profile)。 */
export function syncActiveProfile(cfg: AppConfig): AppConfig {
  const active = activeProfile(cfg);
  const next: ProviderProfile = {
    ...active,
    provider: cfg.provider,
    displayName: cfg.displayName,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    anthropicBaseUrl: cfg.anthropicBaseUrl,
    defaultModel: cfg.defaultModel,
  };
  if (cfg.models) next.models = cfg.models;
  else delete next.models;
  return { ...cfg, profiles: cfg.profiles.map((p) => (p.id === active.id ? next : p)) };
}

/** 激活指定 profile:顶层字段换成该 profile 的字段(其余 profile 先同步保存)。 */
export function activateProfile(cfg: AppConfig, id: string): AppConfig {
  const synced = syncActiveProfile(cfg);
  const target = synced.profiles.find((p) => p.id === id);
  if (!target) return synced;
  return { ...synced, ...fieldsOf(target), activeProfileId: target.id };
}

/** 新增 profile 并激活(表单切到新 profile 的字段视图)。 */
export function addProfile(cfg: AppConfig, profile: ProviderProfile): AppConfig {
  const synced = syncActiveProfile(cfg);
  return { ...synced, profiles: [...synced.profiles, profile], ...fieldsOf(profile), activeProfileId: profile.id };
}

/** 删除 profile(删到最后一个时重置为默认空 profile,保证始终有激活项)。 */
export function removeProfile(cfg: AppConfig, id: string): AppConfig {
  const synced = syncActiveProfile(cfg);
  const rest = synced.profiles.filter((p) => p.id !== id);
  if (rest.length === 0) {
    const fresh = emptyProfile(newProfileId([]));
    return { ...DEFAULT_CONFIG, profiles: [fresh], activeProfileId: fresh.id };
  }
  const next = synced.activeProfileId === id ? rest[0] : activeProfile({ ...synced, profiles: rest });
  return { ...synced, profiles: rest, ...fieldsOf(next), activeProfileId: next.id };
}

function cleanProfile(p: ProviderProfile): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: p.id,
    provider: p.provider,
    displayName: p.displayName,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    anthropicBaseUrl: p.anthropicBaseUrl,
    defaultModel: p.defaultModel,
  };
  if (p.models) out.models = p.models;
  if (p.codexListed && p.codexListed.length > 0) out.codexListed = p.codexListed;
  if (p.codexKnown && p.codexKnown.length > 0) out.codexKnown = p.codexKnown;
  return out;
}

/** 落盘 schema:profiles 为单一数据源,顶层不再冗余保存字段视图。 */
export function serializeAppConfig(cfg: AppConfig): Record<string, unknown> {
  const synced = syncActiveProfile(cfg);
  const out: Record<string, unknown> = {
    profiles: synced.profiles.map(cleanProfile),
    activeProfileId: synced.activeProfileId,
    excludeDoubao: synced.excludeDoubao,
  };
  if (synced.codexProxy) out.codexProxy = { enabled: synced.codexProxy.enabled, port: synced.codexProxy.port };
  return out;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return list.length > 0 ? list : undefined;
}

function normalizeProfile(src: Record<string, unknown>, fallbackId: string): ProviderProfile {
  const provider = asString(src.provider) || "axon";
  const out: ProviderProfile = {
    id: asString(src.id) || fallbackId,
    provider,
    displayName: asString(src.displayName) || provider,
    baseUrl: asString(src.baseUrl),
    apiKey: asString(src.apiKey),
    anthropicBaseUrl: asString(src.anthropicBaseUrl),
    defaultModel: asString(src.defaultModel),
  };
  const models = Array.isArray(src.models) ? src.models : null;
  if (models) {
    const rows: ConfigModelRow[] = [];
    for (const m of models) {
      if (!m || typeof m !== "object") continue;
      const row = m as Record<string, unknown>;
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      rows.push(typeof row.ownedBy === "string" ? { id: row.id, ownedBy: row.ownedBy } : { id: row.id });
    }
    if (rows.length > 0) out.models = rows;
  }
  out.codexListed = asStringList(src.codexListed);
  out.codexKnown = asStringList(src.codexKnown);
  return out;
}

/**
 * 读取(含旧版单 provider 配置迁移):profiles 缺失时把顶层字段迁移为一个 profile,
 * 旧 config.json 里的 baseUrl / apiKey / 模型列表原样保留,用户无感升级。
 */
export function migrateAppConfig(parsed: unknown): AppConfig {
  const src = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const rawProfiles = Array.isArray(src.profiles) ? src.profiles.filter((p) => p && typeof p === "object") : [];
  const seen = new Set<string>();
  const profiles: ProviderProfile[] = [];
  rawProfiles.forEach((p, i) => {
    const prof = normalizeProfile(p as Record<string, unknown>, `p${i + 1}`);
    if (seen.has(prof.id)) prof.id = newProfileId(profiles); // 手改配置可能重 id:保证唯一
    seen.add(prof.id);
    profiles.push(prof);
  });
  if (profiles.length === 0) profiles.push(normalizeProfile(src, "p1"));

  const active = profiles.find((p) => p.id === asString(src.activeProfileId)) ?? profiles[0];
  const proxy = (src.codexProxy && typeof src.codexProxy === "object" ? src.codexProxy : {}) as Record<string, unknown>;
  return {
    ...fieldsOf(active),
    profiles,
    activeProfileId: active.id,
    excludeDoubao: typeof src.excludeDoubao === "boolean" ? src.excludeDoubao : true,
    codexProxy: {
      enabled: typeof proxy.enabled === "boolean" ? proxy.enabled : true,
      port: typeof proxy.port === "number" && proxy.port > 0 ? proxy.port : 17321,
    },
  };
}
