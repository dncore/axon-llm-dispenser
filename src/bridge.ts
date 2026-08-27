// Tauri 桥接层:把 core/ 纯逻辑需要的 I/O 映射到 Rust 命令,并封装应用自身配置。
// 注意:路径操作(join/home_dir/config_dir)一律走自定义命令,不用 tauri-plugin-path,
// 避免 ACL 权限配置问题。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { timestamp } from "./core/util";

export type AppConfig = {
  provider: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** Anthropic 兼容端点(Claude 用);留空时自动从 baseUrl 推导。 */
  anthropicBaseUrl: string;
  /** 全局过滤 Doubao 系模型(默认开启,生成配置不含 doubao)。 */
  excludeDoubao: boolean;
  /** Codex Responses 转换代理(网关 /responses 对部分模型如 gpt-5.6 转换不可用时开启)。 */
  codexProxy?: { enabled: boolean; port: number };
  /** 上次拉取的模型列表(持久化,避免刷新/升级后模型项丢失)。 */
  models?: { id: string; ownedBy?: string }[];
};

export const DEFAULT_CONFIG: AppConfig = {
  provider: "axon",
  displayName: "Axon",
  baseUrl: "",
  apiKey: "",
  defaultModel: "",
  anthropicBaseUrl: "",
  excludeDoubao: true,
  codexProxy: { enabled: true, port: 17321 },
  models: [],
};

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
  /** 代理实际绑定地址:默认 127.0.0.1。 */
  bindIp?: string;
  /** 检测到系统/环境代理劫持本地回环时的提示。 */
  hijackWarning?: string;
};

export type CodexProxyStartResult = {
  port: number;
  pid: number;
  upstream: string;
  pattern: string;
  bindIp: string;
  /** 检测到系统/环境代理劫持时的提示(含自动兜底说明)。 */
  hijackWarning?: string;
};

/** 启动/复用代理进程(独立常驻),返回实际端口与绑定地址。 */
export function proxyStart(port: number, upstreamBaseUrl: string, convertPattern: string): Promise<CodexProxyStartResult> {
  return invoke<CodexProxyStartResult>("proxy_start", { port, upstreamBaseUrl, convertPattern });
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

export async function loadAppConfig(): Promise<AppConfig> {
  try {
    const path = await appConfigFile();
    const raw = await readFile(path);
    if (!raw.trim()) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      provider: parsed.provider || DEFAULT_CONFIG.provider,
      displayName: parsed.displayName || parsed.provider || DEFAULT_CONFIG.displayName,
      baseUrl: parsed.baseUrl || "",
      apiKey: parsed.apiKey || "",
      defaultModel: parsed.defaultModel || "",
      anthropicBaseUrl: parsed.anthropicBaseUrl || "",
      excludeDoubao: parsed.excludeDoubao ?? true,
      codexProxy: {
        enabled: parsed.codexProxy?.enabled ?? true,
        port: parsed.codexProxy?.port ?? 17321,
      },
      models: Array.isArray(parsed.models) ? parsed.models : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveAppConfig(cfg: AppConfig): Promise<string> {
  const path = await appConfigFile();
  // Rust write_file 会自动创建父目录
  await writeFile(path, JSON.stringify(cfg, null, 2) + "\n", 0o600);
  return path;
}

// ---------------------------------------------------------------------------
// 文件写入辅助
// ---------------------------------------------------------------------------

/** 写文件前先备份原文件为 .bak-<时间戳>(只备份非密钥文件)。返回备份路径或 undefined。 */
export async function writeWithBackup(path: string, content: string, mode?: number): Promise<{ path: string; backup?: string }> {
  let backup: string | undefined;
  if (await exists(path)) {
    const existing = await readFile(path);
    backup = `${path}.bak-${timestamp()}`;
    await writeFile(backup, existing);
  }
  await writeFile(path, content, mode);
  return { path, backup };
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
