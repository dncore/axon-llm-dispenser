// Tauri 桥接层:把 core/ 纯逻辑需要的 I/O 映射到 Rust 命令,并封装应用自身配置。

import { invoke } from "@tauri-apps/api/core";
import { appConfigDir, homeDir, join } from "@tauri-apps/api/path";
import { timestamp } from "./core/util";

export type AppConfig = {
  provider: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
};

const DEFAULT_CONFIG: AppConfig = {
  provider: "axon",
  displayName: "Axon",
  baseUrl: "",
  apiKey: "",
  defaultModel: "",
};

// ---------------------------------------------------------------------------
// 基础 invoke 封装
// ---------------------------------------------------------------------------

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export function writeFile(path: string, content: string, mode?: number): Promise<void> {
  return invoke("write_file", { path, content, mode: mode ?? null });
}

export function chmod(path: string, mode: number): Promise<void> {
  return invoke("chmod", { path, mode });
}

export function exists(path: string): Promise<boolean> {
  return invoke<boolean>("exists", { path });
}

export function mkdir(path: string, recursive = true): Promise<void> {
  return invoke("mkdir", { path, recursive });
}

export function detectCli(name: string): Promise<string | null> {
  return invoke<string | null>("detect_cli", { name });
}

export function fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
  return invoke<string[]>("fetch_models", { baseUrl, apiKey });
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export async function home(): Promise<string> {
  return await homeDir();
}

export async function joinPath(...parts: string[]): Promise<string> {
  return await join(...parts);
}

export async function appConfigFile(): Promise<string> {
  return await join(await appConfigDir(), "config.json");
}

export async function codexHome(): Promise<string> {
  return await join(await homeDir(), ".codex");
}

export async function reasonixHome(): Promise<string> {
  return await join(await homeDir(), ".reasonix");
}

export async function dshHome(): Promise<string> {
  return await join(await homeDir(), ".dsh");
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
