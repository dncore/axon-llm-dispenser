import { describe, expect, it } from "vitest";
import { cloneConfig, DEFAULT_CONFIG, DEFAULT_PROVIDER_NAME, migrateAppConfig, rememberProvider, serializeAppConfig } from "./appconfig";
import { BACKUP_KEEP_AUTO, isAutoBackupName, pickStaleAutoBackups } from "./backup";
import { contentHash } from "./util";

describe("migrateAppConfig", () => {
  it("更早的单套配置:顶层字段直接沿用,knownProviders 含默认名", () => {
    const cfg = migrateAppConfig({
      provider: "axon",
      displayName: "Axon",
      baseUrl: "https://gw.example/v1",
      apiKey: "sk-old",
      defaultModel: "deepseek-v4-pro",
      anthropicBaseUrl: "https://gw.example/api/anthropic",
      excludeDoubao: false,
      codexProxy: { enabled: false, port: 18000 },
      models: [{ id: "m1", ownedBy: "vendor" }],
    });
    expect(cfg.provider).toBe("axon");
    expect(cfg.baseUrl).toBe("https://gw.example/v1");
    expect(cfg.defaultModel).toBe("deepseek-v4-pro");
    expect(cfg.models).toEqual([{ id: "m1", ownedBy: "vendor" }]);
    expect(cfg.excludeDoubao).toBe(false);
    expect(cfg.codexProxy).toEqual({ enabled: false, port: 18000 });
    expect(cfg.codexAccount).toBe("custom"); // 默认自建网关
    expect(cfg.knownProviders).toContain(DEFAULT_PROVIDER_NAME);
  });

  it("多 Provider 配置:收敛到激活那套,其余名字进 knownProviders(供残留清理)", () => {
    const cfg = migrateAppConfig({
      profiles: [
        { id: "p1", provider: "axon", displayName: "Axon", baseUrl: "https://a.example/v1", apiKey: "k1", anthropicBaseUrl: "", defaultModel: "" },
        { id: "p2", provider: "magene", displayName: "magene", baseUrl: "https://b.example/v1", apiKey: "k2", anthropicBaseUrl: "", defaultModel: "gpt-6-luna", models: [{ id: "gpt-6-luna" }], codexListed: ["gpt-6-luna"], codexKnown: ["gpt-6-luna", "qwen3.8-flash"] },
        { id: "p3", provider: "powerding", displayName: "powerding", baseUrl: "https://c.example/v1", apiKey: "k3", anthropicBaseUrl: "", defaultModel: "" },
      ],
      activeProfileId: "p2",
      excludeDoubao: true,
      codexProxy: { enabled: true, port: 17321 },
    });
    // 收敛到 p2
    expect(cfg.provider).toBe("magene");
    expect(cfg.baseUrl).toBe("https://b.example/v1");
    expect(cfg.apiKey).toBe("k2");
    expect(cfg.defaultModel).toBe("gpt-6-luna");
    expect(cfg.models).toEqual([{ id: "gpt-6-luna" }]);
    // 可见集合记忆从激活项带过来(原按 profile 存)
    expect(cfg.codexListed).toEqual(["gpt-6-luna"]);
    expect(cfg.codexKnown).toEqual(["gpt-6-luna", "qwen3.8-flash"]);
    // 所有旧名字都记下:改名/删配置后仍能认出并清理自家产物
    expect(cfg.knownProviders).toEqual(expect.arrayContaining(["axon", "magene", "powerding"]));
    expect(cfg.knownProviders).toContain(DEFAULT_PROVIDER_NAME);
  });

  it("激活项缺失时取第一个 profile;knownProviders 保留已记录的名字", () => {
    const cfg = migrateAppConfig({
      profiles: [{ id: "px", provider: "gw-a", displayName: "gw-a", baseUrl: "", apiKey: "", anthropicBaseUrl: "", defaultModel: "" }],
      activeProfileId: "不存在",
      knownProviders: ["old-name"],
    });
    expect(cfg.provider).toBe("gw-a");
    expect(cfg.knownProviders).toEqual(expect.arrayContaining(["gw-a", "old-name", DEFAULT_PROVIDER_NAME]));
  });

  it("空配置/坏数据 → 默认值", () => {
    for (const bad of [null, undefined, {}, { profiles: "x" }, 42]) {
      const cfg = migrateAppConfig(bad as unknown);
      expect(cfg.provider).toBe(DEFAULT_PROVIDER_NAME);
      expect(cfg.baseUrl).toBe("");
      expect(cfg.excludeDoubao).toBe(true);
      expect(cfg.codexProxy).toEqual({ enabled: true, port: 17321 });
      expect(cfg.codexAccount).toBe("custom");
    }
  });

  it("codexAccount 只认 official,其余一律 custom", () => {
    expect(migrateAppConfig({ codexAccount: "official" }).codexAccount).toBe("official");
    expect(migrateAppConfig({ codexAccount: "OFFICIAL" }).codexAccount).toBe("custom");
    expect(migrateAppConfig({ codexAccount: "custom" }).codexAccount).toBe("custom");
  });
});

describe("serializeAppConfig", () => {
  it("落盘只含单套字段,且 provider 名自动进 knownProviders", () => {
    const cfg = migrateAppConfig({ provider: "新网关", baseUrl: "https://gw/v1", apiKey: "k", knownProviders: ["axon"] });
    const out = serializeAppConfig(cfg);
    expect(out.provider).toBe("新网关");
    expect(out.knownProviders).toEqual(["axon", "新网关"]);
    expect(out.codexAccount).toBe("custom");
    expect(out).not.toHaveProperty("profiles");
    expect(out).not.toHaveProperty("activeProfileId");
    expect(out).not.toHaveProperty("codexListed"); // 空记忆不落盘
    // 落盘 → 再读回:等价(除 provider 名已记入 known)
    const round = migrateAppConfig(out);
    expect(round.baseUrl).toBe("https://gw/v1");
    expect(round.knownProviders).toEqual(["axon", "新网关"]);
  });

  it("空字符串 provider 名不写进 knownProviders", () => {
    const cfg = { ...migrateAppConfig({}), provider: "", knownProviders: [] };
    const out = serializeAppConfig(cfg);
    expect(out.knownProviders).toEqual([]);
    expect(out.provider).toBe("");
  });
});

describe("rememberProvider", () => {
  it("只增不减且去重(改名后旧名保留)", () => {
    let cfg = migrateAppConfig({});
    cfg = rememberProvider(cfg, "gw-a");
    cfg = rememberProvider(cfg, "gw-b");
    cfg = rememberProvider(cfg, "gw-a");
    expect(cfg.knownProviders).toEqual([DEFAULT_PROVIDER_NAME, "gw-a", "gw-b"]);
    // 未显式传名时用当前 provider
    const next = rememberProvider({ ...cfg, provider: "gw-c" });
    expect(next.knownProviders).toContain("gw-c");
    // 空名忽略
    expect(rememberProvider(cfg, "  ").knownProviders).toEqual(cfg.knownProviders);
  });
});

describe("cloneConfig", () => {
  it("深拷贝:改副本不影响原配置(默认配置是模块级单例)", () => {
    const cfg = cloneConfig({ ...DEFAULT_CONFIG, models: [{ id: "m1" }], codexListed: ["m1"], knownProviders: ["axon"] });
    cfg.models![0].id = "changed";
    cfg.codexListed!.push("m2");
    cfg.knownProviders.push("other");
    expect(DEFAULT_CONFIG.models).toBeUndefined();
    expect(cfg.codexListed).toEqual(["m1", "m2"]);
    expect(cfg.knownProviders).toEqual(["axon", "other"]);
  });
});

describe("备份分类与清理(自动备份轮转,手动重命名不动)", () => {
  it("识别自动备份名(现行时间戳 / 还原前快照 / 旧版带短横线)", () => {
    expect(isAutoBackupName("config.toml", "config.toml.bak-20260827015755")).toBe(true);
    expect(isAutoBackupName("config.toml", "config.toml.bak-20260810-172613")).toBe(true);
    expect(isAutoBackupName("models.json", "models.json.bak-pre-restore-20260827015755")).toBe(true);
    // 手动重命名 / 其它文件 / 非备份名:不参与自动清理
    expect(isAutoBackupName("config.toml", "config.toml.bak-mcp-disable")).toBe(false);
    expect(isAutoBackupName("config.toml", "config.toml.bak")).toBe(false);
    expect(isAutoBackupName("config.toml", "models.json.bak-20260827015755")).toBe(false);
    expect(isAutoBackupName("config.toml", "config.toml.20260827015755")).toBe(false);
  });

  it("按时间保留最近 N 个,返回更早的自动备份;手动命名的不在清单里", () => {
    const files = [
      { name: "config.toml.bak-manual", mtimeMs: 1 },
      ...Array.from({ length: BACKUP_KEEP_AUTO + 3 }, (_, i) => ({
        name: `config.toml.bak-2026082701${String(i).padStart(2, "0")}00`,
        mtimeMs: 1000 + i,
      })),
    ];
    const stale = pickStaleAutoBackups(files, "config.toml");
    expect(stale).toHaveLength(3);
    expect(stale.map((f) => f.mtimeMs).sort((a, b) => a - b)).toEqual([1000, 1001, 1002]);
    expect(stale.some((f) => f.name === "config.toml.bak-manual")).toBe(false);
    expect(pickStaleAutoBackups(files.slice(1, 5), "config.toml")).toEqual([]);
  });
});

describe("contentHash(写入指纹)", () => {
  it("同内容同指纹,差一个字符即不同;UTF-8 中文稳定", () => {
    expect(contentHash("a = 1\n")).toBe(contentHash("a = 1\n"));
    expect(contentHash("a = 1\n")).not.toBe(contentHash("a = 2\n"));
    expect(contentHash("中文配置")).toBe(contentHash("中文配置"));
    expect(contentHash("")).toBe(contentHash(""));
    expect(contentHash("中文配置")).not.toBe(contentHash("中文配罟"));
  });
});
