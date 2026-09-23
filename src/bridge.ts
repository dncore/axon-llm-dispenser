// Tauri 桥接层:把 core/ 纯逻辑需要的 I/O 映射到 Rust 命令,并封装应用自身配置。
// 注意:路径操作(join/home_dir/config_dir)一律走自定义命令,不用 tauri-plugin-path,
// 避免 ACL 权限配置问题。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { contentHash, timestamp } from "./core/util";
import { migrateAppConfig, serializeAppConfig, type AppConfig } from "./core/appconfig";

// 应用配置结构(多 Provider profile)见 core/appconfig.ts;此处仅做 I/O 与再导出。
export { DEFAULT_CONFIG } from "./core/appconfig";
export type { AppConfig, ProviderProfile } from "./core/appconfig";

// ---------------------------------------------------------------------------
// 基础 invoke 封装
// ---------------------------------------------------------------------------

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/** 读文件,不存在/失败时返回空串(用于可选配置文件)。 */
export async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path);
  } catch {
    return "";
  }
}

export function writeFile(path: string, content: string, mode?: number): Promise<void> {
  return invoke("write_file", { path, content, mode: mode ?? null });
}

export function chmod(path: string, mode: number): Promise<void> {
  return invoke("chmod", { path, mode });
}

export function renameFile(from: string, to: string): Promise<void> {
  return invoke("rename_file", { from, to });
}

export function deleteFile(path: string): Promise<void> {
  return invoke("delete_file", { path });
}

/** 按扩展名校验配置格式(JSON/TOML/YAML),格式错误时 reject。 */
export function validateConfig(path: string, content: string): Promise<void> {
  return invoke("validate_config", { path, content });
}

export function exists(path: string): Promise<boolean> {
  return invoke<boolean>("exists", { path });
}

export type DirEntry = { name: string; isFile: boolean; size: number; mtimeMs: number };

export function readDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("read_dir", { path });
}

export function mkdir(path: string, recursive = true): Promise<void> {
  return invoke("mkdir", { path, recursive });
}

export function detectCli(name: string): Promise<string | null> {
  return invoke<string | null>("detect_cli", { name });
}

/** 检测 CLI:先 PATH,再候选目录(支持 ~ 前缀与 glob 通配)。 */
export function detectCliIn(name: string, dirs: string[]): Promise<string | null> {
  return invoke<string | null>("detect_cli_in", { name, dirs });
}

// ---------------------------------------------------------------------------
// agent 升级/安装(agent_update 模块)
// ---------------------------------------------------------------------------

export type AgentUpdateEntry = { name: string; path: string | null };
export type InstallMethod = { id: string; label: string; command: string };

export type AgentUpdateStatus = {
  name: string;
  label: string;
  installed: boolean;
  path: string | null;
  manager: string | null;
  version: string | null;
  latest: string | null;
  updateAvailable: boolean;
  installMethods: InstallMethod[];
};

/** 检查各 agent 版本与可升级状态(前端传入已检测到的二进制路径)。 */
export function agentCheck(entries: AgentUpdateEntry[]): Promise<AgentUpdateStatus[]> {
  return invoke<AgentUpdateStatus[]>("agent_check", { entries });
}

/** 逐个升级(按各 agent 现有安装方式),日志经 agent-update-log 事件实时推送。 */
export function agentUpdate(entries: AgentUpdateEntry[]): Promise<unknown> {
  return invoke("agent_update", { entries });
}

/** 按官方安装方式安装 agent。 */
export function agentInstall(name: string, methodId: string): Promise<void> {
  return invoke("agent_install", { name, methodId });
}

/** 仅更新 Pi 扩展(packages;pi update --extensions),不更新 pi 本体,日志经 agent-update-log 实时推送。 */
export function piExtensionsUpdate(piPath: string): Promise<void> {
  return invoke("pi_extensions_update", { piPath });
}

/** 订阅升级/安装日志流;返回取消订阅函数(浏览器环境无事件时为空实现)。 */
export async function onAgentUpdateLog(cb: (line: string) => void): Promise<() => void> {
  try {
    return await listen<string>("agent-update-log", (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

export type ModelInfo = { id: string; ownedBy?: string };

export function fetchModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("fetch_models", { baseUrl, apiKey });
}

// ---------------------------------------------------------------------------
// Codex Responses 转换代理
// ---------------------------------------------------------------------------

export type CodexProxyInfo = {
  running: boolean;
  port?: number;
  pid?: number;
  upstream?: string;
  pattern?: string;
  /** 代理进程监听的地址列表(如 127.0.0.1 + ::1,或本机 LAN IP)。 */
  bindIps?: string[];
  /** 写入 Codex 配置的 base_url 主机名:localhost(默认) | 127.0.0.1 | LAN IP。 */
  codexHost?: string;
  /** 检测到系统/环境代理劫持本地连接时的提示。 */
  hijackWarning?: string;
};

export type CodexProxyStartResult = {
  port: number;
  pid: number;
  upstream: string;
  pattern: string;
  codexHost: string;
  /** 代理 GET /models 直接回放的本地模型目录路径(可空)。 */
  modelsJsonPath?: string;
  /** 检测到系统/环境代理劫持时的提示(含自动兜底说明)。 */
  hijackWarning?: string;
};

/** 启动/复用代理进程(独立常驻),返回实际端口与 codex 主机名。
 * modelsJsonPath 指本地 models.json(Codex 内部目录 schema):设置后代理的 GET /models
 * 直接回放它,保证桌面端模型切换器能列出全部网关模型(网关标准 OpenAI 列表无法被
 * Codex ModelsResponse 解析,会导致列表只剩内置 gpt 模型)。 */
export function proxyStart(port: number, upstreamBaseUrl: string, convertPattern: string, modelsJsonPath?: string): Promise<CodexProxyStartResult> {
  return invoke<CodexProxyStartResult>("proxy_start", { port, upstreamBaseUrl, convertPattern, modelsJsonPath });
}

export function proxyStatus(): Promise<CodexProxyInfo> {
  return invoke<CodexProxyInfo>("proxy_status");
}

export function proxyStop(): Promise<void> {
  return invoke("proxy_stop");
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

export function appVersion(): Promise<string> {
  return invoke<string>("app_version");
}

export type AppUpdateInfo = { current: string; latest: string; url: string; updateAvailable: boolean };

/** 查询 GitHub Releases 最新版本,与当前 App 版本比对。 */
export function appCheckUpdate(): Promise<AppUpdateInfo> {
  return invoke<AppUpdateInfo>("check_update");
}

/** macOS:执行 brew upgrade axon-llm-dispenser(流式日志)。Windows 请用打开下载页。 */
export function appUpdateMacos(): Promise<void> {
  return invoke("update_macos");
}

export function homeDir(): Promise<string> {
  return invoke<string>("home_dir");
}

export function appConfigDir(): Promise<string> {
  return invoke<string>("config_dir");
}

export async function joinPath(...parts: string[]): Promise<string> {
  return invoke<string>("path_join", { parts });
}

export function dirnamePath(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p : p.slice(0, i);
}

/** 取文件名部分(兼容 / 与 \\)。 */
export function basenamePath(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

export async function home(): Promise<string> {
  return await homeDir();
}

export async function appConfigFile(): Promise<string> {
  return await joinPath(await appConfigDir(), "config.json");
}

export async function codexHome(): Promise<string> {
  return await joinPath(await homeDir(), ".codex");
}

export async function reasonixHome(): Promise<string> {
  return await joinPath(await homeDir(), ".reasonix");
}

export async function dshHome(): Promise<string> {
  return await joinPath(await homeDir(), ".dsh");
}

export async function grokHome(): Promise<string> {
  return await joinPath(await homeDir(), ".grok");
}

/** OpenCode 全局配置目录(xdg config:跨平台均为 ~/.config/opencode——xdg-basedir 5.x 无平台分支)。 */
export async function opencodeHome(): Promise<string> {
  return await joinPath(await homeDir(), ".config", "opencode");
}

/** OpenCode 数据目录(xdg data:跨平台均为 ~/.local/share/opencode),auth.json 所在。 */
export async function opencodeDataHome(): Promise<string> {
  return await joinPath(await homeDir(), ".local", "share", "opencode");
}

// ---------------------------------------------------------------------------
// 应用自身配置
// ---------------------------------------------------------------------------

/** 读取应用配置(旧版单 provider 的 config.json 自动迁移为一个 profile)。 */
export async function loadAppConfig(): Promise<AppConfig> {
  try {
    const path = await appConfigFile();
    const raw = await readFile(path);
    if (!raw.trim()) return migrateAppConfig(null);
    return migrateAppConfig(JSON.parse(raw));
  } catch {
    return migrateAppConfig(null);
  }
}

/** 保存应用配置:先把顶层字段(表单)写回激活 profile,再按 profiles schema 落盘。 */
export async function saveAppConfig(cfg: AppConfig): Promise<string> {
  const path = await appConfigFile();
  // Rust write_file 会自动创建父目录
  await writeFile(path, JSON.stringify(serializeAppConfig(cfg), null, 2) + "\n", 0o600);
  return path;
}

// ---------------------------------------------------------------------------
// 文件写入辅助
// ---------------------------------------------------------------------------

// 写入指纹:记录本 app 上次写入各文件的内容指纹,用于「不重复备份自己的产物」。
// (频繁切换 provider 时被覆盖的往往就是上一次 app 自己写的内容,原始备份早已存在,
//  而外部手改过的内容一定会被备份,不会丢。)

type WriteState = Record<string, string>;
let writeStateCache: WriteState | null = null;

async function writeStateFile(): Promise<string> {
  return await joinPath(await appConfigDir(), "write-state.json");
}

async function loadWriteState(): Promise<WriteState> {
  if (writeStateCache) return writeStateCache;
  try {
    const raw = await readFile(await writeStateFile());
    const parsed = JSON.parse(raw) as unknown;
    writeStateCache = parsed && typeof parsed === "object" ? (parsed as WriteState) : {};
  } catch {
    writeStateCache = {};
  }
  return writeStateCache;
}

async function recordWrite(path: string, content: string): Promise<void> {
  const state = await loadWriteState();
  state[path] = contentHash(content);
  try {
    await writeFile(await writeStateFile(), JSON.stringify(state, null, 2) + "\n", 0o600);
  } catch {
    // 记录失败仅影响下次备份判断(退化为照常备份),不阻断写入
  }
}

/**
 * 写文件(只备份非密钥文件)。备份规则:
 * - 文件不存在(首次写入)→ 无需备份;
 * - 当前内容 == 本 app 上次写入的内容 → 不新建备份(原始/上次外部改动前的备份已保留);
 * - 其余(外部改动过)→ 先备份为 .bak-<时间戳>,再写入。
 * 返回 backup(新备份路径)/ backupSkipped(内容为本 app 产物故未备份),供日志说明。
 */
export async function writeWithBackup(path: string, content: string, mode?: number): Promise<{ path: string; backup?: string; backupSkipped?: boolean }> {
  let backup: string | undefined;
  let backupSkipped = false;
  if (await exists(path)) {
    const existing = await readFile(path);
    if (existing !== content) {
      const state = await loadWriteState();
      if (state[path] === contentHash(existing)) {
        backupSkipped = true;
      } else {
        backup = `${path}.bak-${timestamp()}`;
        await writeFile(backup, existing);
      }
    }
  }
  await writeFile(path, content, mode);
  await recordWrite(path, content);
  return { path, backup, backupSkipped };
}

/** 写密钥文件(不备份),固定 0600。 */
export async function writeSecret(path: string, content: string): Promise<string> {
  await writeFile(path, content, 0o600);
  await chmod(path, 0o600);
  return path;
}

/** 在 .env 风格文本中 upsert 一个 key(用于 Reasonix .env)。 */
export function upsertEnvKey(text: string, key: string, value: string): { text: string; changed: boolean } {
  const line = `${key}=${JSON.stringify(value)}`;
  const re = new RegExp(`^(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  if (re.test(text)) {
    const next = text.replace(re, line);
    return { text: next, changed: next !== text };
  }
  return { text: (text.trim() ? text.replace(/\s+$/, "") + "\n" : "") + line + "\n", changed: true };
}
