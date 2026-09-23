import { describe, expect, it } from "vitest";
import {
  activateProfile,
  addProfile,
  activeProfile,
  DEFAULT_CONFIG,
  emptyProfile,
  migrateAppConfig,
  newProfileId,
  removeProfile,
  serializeAppConfig,
  syncActiveProfile,
  type AppConfig,
} from "./appconfig";
import { BACKUP_KEEP_AUTO, isAutoBackupName, pickStaleAutoBackups } from "./backup";
import { contentHash } from "./util";

describe("migrateAppConfig(旧版单 provider 配置迁移)", () => {
  it("顶层字段迁移为一个 profile,模型列表与代理设置保留", () => {
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
    expect(cfg.profiles).toHaveLength(1);
    expect(cfg.activeProfileId).toBe("p1");
    expect(cfg.baseUrl).toBe("https://gw.example/v1");
    expect(cfg.apiKey).toBe("sk-old");
    expect(cfg.defaultModel).toBe("deepseek-v4-pro");
    expect(cfg.models).toEqual([{ id: "m1", ownedBy: "vendor" }]);
    expect(cfg.excludeDoubao).toBe(false);
    expect(cfg.codexProxy).toEqual({ enabled: false, port: 18000 });
    expect(activeProfile(cfg).baseUrl).toBe("https://gw.example/v1");
  });

  it("空/损坏配置回落到默认 profile,不抛错", () => {
    for (const bad of [null, undefined, {}, "nope", { profiles: "x" }]) {
      const cfg = migrateAppConfig(bad);
      expect(cfg.profiles).toHaveLength(1);
      expect(cfg.provider).toBe("axon");
      expect(cfg.excludeDoubao).toBe(true);
      expect(cfg.codexProxy).toEqual({ enabled: true, port: 17321 });
    }
  });

  it("profiles 结构原样读取,activeProfileId 失配时回落到第一个;重 id 去重", () => {
    const cfg = migrateAppConfig({
      activeProfileId: "gone",
      excludeDoubao: true,
      codexProxy: { enabled: true, port: 17321 },
      profiles: [
        { id: "a", provider: "axon", displayName: "A", baseUrl: "https://a.example/v1", apiKey: "ka", anthropicBaseUrl: "", defaultModel: "", codexListed: ["m1"], codexKnown: ["m1", "m2"] },
        { id: "a", provider: "gw2", displayName: "B", baseUrl: "https://b.example/v1", apiKey: "kb", anthropicBaseUrl: "", defaultModel: "" },
      ],
    });
    expect(cfg.profiles.map((p) => p.id)).toEqual(["a", "p1"]); // 重 id 换成未占用的最小可用 id
    expect(cfg.activeProfileId).toBe("a");
    expect(cfg.baseUrl).toBe("https://a.example/v1");
    expect(activeProfile(cfg).codexListed).toEqual(["m1"]);
    expect(activeProfile(cfg).codexKnown).toEqual(["m1", "m2"]);
  });
});

describe("profile 切换/增删(顶层字段 = 激活 profile 视图)", () => {
  const twoProfiles = (): AppConfig =>
    migrateAppConfig({
      activeProfileId: "p1",
      profiles: [
        { id: "p1", provider: "axon", displayName: "公司", baseUrl: "https://a.example/v1", apiKey: "ka", anthropicBaseUrl: "", defaultModel: "", models: [{ id: "m1" }] },
        { id: "p2", provider: "axon", displayName: "自建", baseUrl: "https://b.example/v1", apiKey: "kb", anthropicBaseUrl: "", defaultModel: "m2" },
      ],
    });

  it("激活另一个 profile:顶层字段切换,表单改动写回原 profile", () => {
    const cfg = twoProfiles();
    const edited: AppConfig = { ...cfg, apiKey: "ka-new" }; // 表单改动(readFields 的效果)
    const switched = activateProfile(edited, "p2");
    expect(switched.baseUrl).toBe("https://b.example/v1");
    expect(switched.defaultModel).toBe("m2");
    expect(switched.activeProfileId).toBe("p2");
    expect(switched.profiles.find((p) => p.id === "p1")?.apiKey).toBe("ka-new"); // 改动没有丢
    expect(switched.profiles.find((p) => p.id === "p2")?.apiKey).toBe("kb");
  });

  it("落盘 schema 只存 profiles,顶层字段写入激活 profile", () => {
    const cfg = syncActiveProfile({ ...twoProfiles(), apiKey: "ka2", models: [{ id: "m1" }, { id: "m3" }] });
    const out = serializeAppConfig(cfg) as { profiles: Array<Record<string, unknown>>; activeProfileId: string; excludeDoubao: boolean };
    expect(Object.keys(out).sort()).toEqual(["activeProfileId", "codexProxy", "excludeDoubao", "profiles"]);
    expect(out.activeProfileId).toBe("p1");
    expect(out.profiles[0].apiKey).toBe("ka2");
    expect(out.profiles[0].models).toEqual([{ id: "m1" }, { id: "m3" }]);
    expect(out.profiles[1].apiKey).toBe("kb");
  });

  it("新建 profile 后激活;id 递增且不重复", () => {
    const cfg = twoProfiles();
    expect(newProfileId(cfg.profiles)).toBe("p3");
    const added = addProfile(cfg, emptyProfile("p3", "axon", "备用"));
    expect(added.activeProfileId).toBe("p3");
    expect(added.profiles).toHaveLength(3);
    expect(added.baseUrl).toBe(""); // 新 profile 表单为空
  });

  it("删除激活 profile 后落到剩余第一个;删最后一个回到默认空 profile", () => {
    const cfg = twoProfiles();
    const afterP1 = removeProfile(activateProfile(cfg, "p1"), "p1");
    expect(afterP1.activeProfileId).toBe("p2");
    expect(afterP1.baseUrl).toBe("https://b.example/v1");
    const last = removeProfile(afterP1, "p2");
    expect(last.profiles).toHaveLength(1);
    expect(last.baseUrl).toBe("");
    expect(last.provider).toBe(DEFAULT_CONFIG.provider);
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
        mtimeMs: 1000 + i, // i 越大越新
      })),
    ];
    const stale = pickStaleAutoBackups(files, "config.toml");
    expect(stale).toHaveLength(3);
    expect(stale.map((f) => f.mtimeMs).sort((a, b) => a - b)).toEqual([1000, 1001, 1002]);
    expect(stale.some((f) => f.name === "config.toml.bak-manual")).toBe(false);
    // 保留数之内不清理
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
