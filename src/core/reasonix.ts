// Reasonix 配置:[[providers]] 接入 + [serve] 鉴权。纯文本变换,不做文件 I/O。

import { escapeRegExp, maskToken } from "./util";

type ProviderValue = string | string[] | boolean | { raw: string };

function tomlValue(v: ProviderValue): string {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return (v as { raw: string }).raw;
  if (Array.isArray(v)) return `[${v.map((s) => JSON.stringify(s)).join(", ")}]`;
  return JSON.stringify(v);
}

/** 定位表头并返回其正文区间。 */
function locateSection(text: string, headerRe: RegExp): { bodyStart: number; bodyEnd: number } | null {
  const m = headerRe.exec(text);
  if (!m) return null;
  const lineEnd = text.indexOf("\n", m.index);
  const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
  const rest = text.slice(bodyStart);
  const nextHeader = /^\s*\[/m.exec(rest);
  const bodyEnd = nextHeader ? bodyStart + nextHeader.index : text.length;
  return { bodyStart, bodyEnd };
}

function extractSection(text: string, section: string): string | null {
  const loc = locateSection(text, new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "m"));
  return loc ? text.slice(loc.bodyStart, loc.bodyEnd) : null;
}

function upsertInSection(text: string, section: string, key: string, value: string): { text: string; changed: boolean } {
  const loc = locateSection(text, new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "m"));
  if (!loc) return { text, changed: false };
  const body = text.slice(loc.bodyStart, loc.bodyEnd);
  const line = `${key} = ${JSON.stringify(value)}`;
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (keyRe.test(body)) {
    const nextBody = body.replace(keyRe, line);
    if (nextBody === body) return { text, changed: false };
    return { text: text.slice(0, loc.bodyStart) + nextBody + text.slice(loc.bodyEnd), changed: true };
  }
  return { text: text.slice(0, loc.bodyStart) + line + "\n" + text.slice(loc.bodyStart), changed: true };
}

function removeKeyInSection(text: string, section: string, key: string): { text: string; changed: boolean } {
  const loc = locateSection(text, new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "m"));
  if (!loc) return { text, changed: false };
  const body = text.slice(loc.bodyStart, loc.bodyEnd);
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (!keyRe.test(body)) return { text, changed: false };
  const nextBody = body.replace(keyRe, "").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  return { text: text.slice(0, loc.bodyStart) + nextBody + text.slice(loc.bodyEnd), changed: true };
}

/** 生成/更新 config.toml 的 [serve] 鉴权段:token 模式(固定 token)或 none。 */
export function patchReasonixServeAuth(
  text: string,
  mode: "token" | "none",
  token?: string,
): { text: string; changes: string[] } {
  const hasServe = /^\[serve\]\s*$/m.test(text);
  const changes: string[] = [];

  if (mode === "token") {
    if (!token) throw new Error("token 不能为空");
    if (!hasServe) {
      const block = `[serve]\nauth_mode = "token"\ntoken = ${JSON.stringify(token)}\n`;
      return { text: (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block, changes: ["[serve] 段新建:auth_mode = token"] };
    }
    let out = text;
    const r1 = upsertInSection(out, "serve", "auth_mode", "token");
    if (r1.changed) changes.push("auth_mode = token");
    out = r1.text;
    const r2 = upsertInSection(out, "serve", "token", token);
    if (r2.changed) changes.push("token = <新生成,固定复用>");
    out = r2.text;
    return { text: out, changes };
  }

  if (!hasServe) return { text, changes };
  let out = text;
  const r1 = upsertInSection(out, "serve", "auth_mode", "none");
  if (r1.changed) changes.push("auth_mode = none");
  out = r1.text;
  const r2 = removeKeyInSection(out, "serve", "token");
  if (r2.changed) changes.push("token 已移除");
  out = r2.text;
  const r3 = removeKeyInSection(out, "serve", "password_hash");
  if (r3.changed) changes.push("password_hash 已移除");
  out = r3.text;
  return { text: out, changes };
}

/** 在 [[providers]] 数组中按 name 定位块。 */
function findProvidersBlock(text: string, name: string): { start: number; end: number } | null {
  const blockRe = /^\[\[providers\]\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const lineEnd = text.indexOf("\n", m.index);
    const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
    const rest = text.slice(bodyStart);
    const nextHeader = /^\s*\[/m.exec(rest);
    const bodyEnd = nextHeader ? bodyStart + nextHeader.index : text.length;
    const body = text.slice(bodyStart, bodyEnd);
    if (new RegExp(`^name\\s*=\\s*["']${escapeRegExp(name)}["']\\s*$`, "m").test(body)) {
      return { start: bodyStart, end: bodyEnd };
    }
  }
  return null;
}

function upsertProviderBlock(text: string, name: string, kv: Record<string, ProviderValue>): { text: string; changed: boolean } {
  const existing = findProvidersBlock(text, name);
  const body = Object.entries(kv).map(([k, v]) => `${k} = ${tomlValue(v)}`).join("\n");
  if (!existing) {
    const block = "[[providers]]\n" + body + "\n";
    return { text: (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block, changed: true };
  }
  const oldBody = text.slice(existing.start, existing.end);
  const kept: string[] = [];
  for (const line of oldBody.split("\n")) {
    const km = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (km && !(km[1] in kv)) kept.push(line);
  }
  const newBody = [body, kept.join("\n")].filter(Boolean).join("\n") + "\n";
  const next = text.slice(0, existing.start) + newBody + text.slice(existing.end);
  return { text: next, changed: next !== text };
}

function upsertTopLevelKey(text: string, key: string, value: string): { text: string; changed: boolean } {
  const line = `${key} = ${JSON.stringify(value)}`;
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (re.test(text)) {
    const next = text.replace(re, line);
    return { text: next, changed: next !== text };
  }
  return { text: line + "\n" + text, changed: true };
}

export type ReasonixProviderInput = {
  providerName: string;
  baseUrl: string;
  apiKeyEnv: string;
  modelIds: string[];
  defaultModel?: string;
  modelContexts?: Record<string, number>;
};

/** 生成/更新 config.toml 的 provider 块([[providers]])。 */
export function patchReasonixProvider(text: string, input: ReasonixProviderInput): { text: string; changes: string[] } {
  const { providerName, baseUrl, apiKeyEnv, modelIds, defaultModel } = input;
  const sorted = [...modelIds].sort((a, b) => a.localeCompare(b));
  const kv: Record<string, ProviderValue> = {
    name: providerName,
    kind: "openai",
    base_url: baseUrl,
    models: sorted,
  };
  const def = defaultModel && modelIds.includes(defaultModel) ? defaultModel : modelIds[0];
  if (def) kv.default = def;
  kv.api_key_env = apiKeyEnv;

  const knownCtx = input.modelContexts
    ? Object.entries(input.modelContexts).filter(([id]) => sorted.includes(id)).sort(([a], [b]) => a.localeCompare(b))
    : [];
  if (knownCtx.length > 0) {
    const inline = knownCtx.map(([id, cw]) => `${JSON.stringify(id)} = { context_window = ${cw} }`).join(", ");
    kv.model_overrides = { raw: `{ ${inline} }` };
  }

  const existed = Boolean(findProvidersBlock(text, providerName));
  const r = upsertProviderBlock(text, providerName, kv);
  let out = r.text;
  const changes = r.changed
    ? [`${existed ? `[[providers]] ${providerName} 已更新` : `[[providers]] ${providerName} 已新增`}(${sorted.length} 个模型, default=${def ?? "无"}, api_key_env=${apiKeyEnv})`]
    : [];
  if (knownCtx.length > 0 && r.changed) changes.push(`model_overrides 已写入(${knownCtx.length} 个模型的 context_window)`);

  if (!/^default_model\s*=.*$/m.test(out)) {
    const dm = upsertTopLevelKey(out, "default_model", providerName);
    out = dm.text;
    if (dm.changed) changes.push(`default_model = "${providerName}"`);
  }

  const dmVal = out.match(/^default_model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  if (dmVal) {
    const [provPart, modelPart] = dmVal.split("/");
    const valid =
      dmVal === providerName ||
      sorted.includes(dmVal) ||
      Boolean(findProvidersBlock(out, dmVal)) ||
      (modelPart !== undefined && (provPart === providerName ? sorted.includes(modelPart) : Boolean(findProvidersBlock(out, provPart))));
    if (!valid) {
      const fix = upsertTopLevelKey(out, "default_model", providerName);
      out = fix.text;
      if (fix.changed) changes.push(`default_model = "${providerName}"(原 "${dmVal}" 指向不存在)`);
    }
  }

  if (changes.length === 0) return { text, changes: [] };
  return { text: out, changes };
}

export type ReasonixStatus = {
  configExists: boolean;
  authMode: string | null;
  tokenSet: boolean;
  tokenMasked: string | null;
  passwordHashSet: boolean;
  behindProxy: boolean;
  providerConfigured: boolean;
  providerModels: number;
  providerDefault: string | null;
  providerApiKeyEnv: string | null;
  keyInEnvFile: boolean;
};

/** 从 config.toml / .env 文本解析 reasonix 状态(纯)。 */
export function parseReasonixStatus(cfgText: string, envText: string, providerName: string): ReasonixStatus {
  const serve = extractSection(cfgText, "serve");
  const tokenRaw = serve?.match(/^token\s*=\s*"([^"]*)"/m)?.[1] ?? null;
  const authMode = serve?.match(/^auth_mode\s*=\s*"([^"]+)"/m)?.[1] ?? null;

  const block = findProvidersBlock(cfgText, providerName);
  const blockText = block ? cfgText.slice(block.start, block.end) : "";
  const apiKeyEnv = blockText.match(/^api_key_env\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const modelsMatch = blockText.match(/^models\s*=\s*\[(.*?)\]/ms)?.[1];
  const providerModels = modelsMatch ? modelsMatch.split(",").map((s) => s.trim()).filter((s) => s.length > 0).length : 0;

  return {
    configExists: cfgText.length > 0,
    authMode,
    tokenSet: Boolean(tokenRaw),
    tokenMasked: tokenRaw ? maskToken(tokenRaw) : null,
    passwordHashSet: Boolean(serve?.match(/^password_hash\s*=/m)),
    behindProxy: /^behind_proxy\s*=\s*true/m.test(serve ?? ""),
    providerConfigured: Boolean(block),
    providerModels,
    providerDefault: blockText.match(/^default\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    providerApiKeyEnv: apiKeyEnv,
    keyInEnvFile: apiKeyEnv ? new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?${escapeRegExp(apiKeyEnv)}\\s*=`).test(envText) : false,
  };
}
