// 应用自身配置(单套网关 + Codex 账号模式):迁移 / 序列化,纯函数无 I/O。
// 历史:早期为单套配置;0.5.2x 一度引入「多 Provider profile」,与设计意图(只给 Codex 做
// 「官方账号 / 自建网关」切换)不符,已移除。落盘 schema 见 serializeAppConfig;
// 旧的多 profile config.json 由 migrateAppConfig 自动收敛(见该函数注释)。

export type ConfigModelRow = { id: string; ownedBy?: string };

/** Codex 用哪条路:官方账号(ChatGPT 登录,Codex 自带目录)或本 app 写入的自建网关。 */
export type CodexAccount = "official" | "custom";

export type AppConfig = {
  /** 写入各工具的 provider 路由名。 */
  provider: string;
  /** 展示名(各工具里的 provider 显示名)。 */
  displayName: string;
  baseUrl: string;
  apiKey: string;
  /** Anthropic 兼容端点(Claude 用);留空时自动从 baseUrl 推导。 */
  anthropicBaseUrl: string;
  /** 默认模型;留空时按模型列表自动挑选(见 flows.pickDefaultModel)。 */
  defaultModel: string;
  /** 上次拉取到的模型列表(启动后自动拉取并持久化)。 */
  models?: ConfigModelRow[];
  /** Codex 可见模型选择(visibility="list"):网关新增模型时仍会触发「超上限挑选」。 */
  codexListed?: string[];
  /** 做出上述选择时的完整模型列表。 */
  codexKnown?: string[];
  /** Codex 账号模式:官方账号 / 自建网关(默认)。 */
  codexAccount: CodexAccount;
  /** 本 app 曾用过的 provider 路由名(含已改名的):Codex 目录归属判定用,只增不减。 */
  knownProviders: string[];
  /** 全局过滤 Doubao 系模型(默认开启,生成配置不含 doubao)。 */
  excludeDoubao: boolean;
  /** Codex Responses 转换代理(网关 /responses 对部分模型如 gpt-5.6 转换不可用时开启)。 */
  codexProxy?: { enabled: boolean; port: number };
};

/** 本 app 的默认路由名:即使当前改名,它写下的东西仍属本 app(归属判定与残留清理用)。 */
export const DEFAULT_PROVIDER_NAME = "axon";

export const DEFAULT_CONFIG: AppConfig = {
  provider: DEFAULT_PROVIDER_NAME,
  displayName: "Axon",
  baseUrl: "",
  apiKey: "",
  anthropicBaseUrl: "",
  defaultModel: "",
  codexAccount: "custom",
  knownProviders: [DEFAULT_PROVIDER_NAME],
  excludeDoubao: true,
  codexProxy: { enabled: true, port: 17321 },
};

/** 深拷贝一份配置(默认配置是模块级单例,避免就地修改污染)。 */
export function cloneConfig(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    models: cfg.models?.map((m) => ({ ...m })),
    codexListed: cfg.codexListed ? [...cfg.codexListed] : undefined,
    codexKnown: cfg.codexKnown ? [...cfg.codexKnown] : undefined,
    knownProviders: [...cfg.knownProviders],
    codexProxy: cfg.codexProxy ? { ...cfg.codexProxy } : undefined,
  };
}

/** 记下用过的 provider 名(只增不减:改名后旧名下的产物仍能被认出来并清理)。 */
export function rememberProvider(cfg: AppConfig, name?: string): AppConfig {
  const n = (name ?? cfg.provider).trim();
  if (!n || cfg.knownProviders.includes(n)) return cfg;
  return { ...cfg, knownProviders: [...cfg.knownProviders, n] };
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return list.length > 0 ? list : undefined;
}

function asModelRows(v: unknown): ConfigModelRow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const rows: ConfigModelRow[] = [];
  for (const m of v) {
    if (!m || typeof m !== "object") continue;
    const row = m as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    rows.push(typeof row.ownedBy === "string" ? { id: row.id, ownedBy: row.ownedBy } : { id: row.id });
  }
  return rows.length > 0 ? rows : undefined;
}

/** 落盘 schema:单套配置(顶层字段即唯一数据源)。 */
export function serializeAppConfig(cfg: AppConfig): Record<string, unknown> {
  const remembered = rememberProvider(cfg);
  const out: Record<string, unknown> = {
    provider: remembered.provider,
    displayName: remembered.displayName,
    baseUrl: remembered.baseUrl,
    apiKey: remembered.apiKey,
    anthropicBaseUrl: remembered.anthropicBaseUrl,
    defaultModel: remembered.defaultModel,
    codexAccount: remembered.codexAccount,
    knownProviders: remembered.knownProviders,
    excludeDoubao: remembered.excludeDoubao,
  };
  if (remembered.models) out.models = remembered.models;
  if (remembered.codexListed && remembered.codexListed.length > 0) out.codexListed = remembered.codexListed;
  if (remembered.codexKnown && remembered.codexKnown.length > 0) out.codexKnown = remembered.codexKnown;
  if (remembered.codexProxy) out.codexProxy = { enabled: remembered.codexProxy.enabled, port: remembered.codexProxy.port };
  return out;
}

/**
 * 读取配置(含两种旧格式的迁移):
 * 1) 多 Provider profile(0.5.2x):收敛为「当前激活的那一套」,其余 profile 一并删除——
 *    它们写进 Codex 的目录条目与 provider 段由 flows 的残留清理负责(判定依据在那边);
 *    同时把所有 profile 名记进 knownProviders,避免改名后认不出自家产物。
 * 2) 单套配置(更早):顶层字段即结果。
 */
export function migrateAppConfig(parsed: unknown): AppConfig {
  const src = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

  // 旧多 profile:取激活项(缺失时取第一个)作为唯一配置
  const rawProfiles = Array.isArray(src.profiles) ? src.profiles.filter((p) => p && typeof p === "object") : [];
  const profiles = rawProfiles as Array<Record<string, unknown>>;
  const active =
    profiles.find((p) => asString(p.id) === asString(src.activeProfileId)) ?? profiles[0] ?? (src as Record<string, unknown>);
  const provider = asString(active.provider) || DEFAULT_PROVIDER_NAME;

  const proxy = (src.codexProxy && typeof src.codexProxy === "object" ? src.codexProxy : {}) as Record<string, unknown>;

  // knownProviders:旧 profile 名 + 曾记录过的名字 + 默认名,全部保留
  const known = new Set<string>([DEFAULT_PROVIDER_NAME, provider]);
  for (const p of profiles) {
    const n = asString(p.provider).trim();
    if (n) known.add(n);
  }
  for (const n of asStringList(src.knownProviders) ?? []) known.add(n);

  const cfg: AppConfig = {
    provider,
    displayName: asString(active.displayName) || provider,
    baseUrl: asString(active.baseUrl),
    apiKey: asString(active.apiKey),
    anthropicBaseUrl: asString(active.anthropicBaseUrl),
    defaultModel: asString(active.defaultModel),
    codexAccount: asString(src.codexAccount) === "official" ? "official" : "custom",
    knownProviders: [...known],
    excludeDoubao: typeof src.excludeDoubao === "boolean" ? src.excludeDoubao : true,
    codexProxy: {
      enabled: typeof proxy.enabled === "boolean" ? proxy.enabled : true,
      port: typeof proxy.port === "number" && proxy.port > 0 ? proxy.port : 17321,
    },
  };
  // 可见集合记忆原本按 profile 存:迁移时从激活项带过来
  const listed = asStringList(active.codexListed) ?? asStringList(src.codexListed);
  const knownIds = asStringList(active.codexKnown) ?? asStringList(src.codexKnown);
  if (listed) cfg.codexListed = listed;
  if (knownIds) cfg.codexKnown = knownIds;
  const models = asModelRows(active.models) ?? asModelRows(src.models);
  if (models) cfg.models = models;
  return cfg;
}
