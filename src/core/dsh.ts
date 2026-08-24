// DeepSeek Harness (dsh) 配置:官方 settings.yaml + .credentials.yaml。
// 纯文本变换(缩进感知的 YAML 块补丁),不做文件 I/O。

import { blockBodyEnd, escapeRegExp, findKeyInRegion, headerHasInlineContent, lineAfter, yamlQuote, unquoteYaml } from "./util";

/** 写入 dsh 模型目录的单个模型条目。 */
export type DshModelEntry = {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  /** pi-ai 思考等级 → 线上拼写;仅含非 off 等级(off 是 always-on 哨兵,不写入)。 */
  reasoningEfforts?: Record<string, string | null>;
  input?: string[];
};

// ---------------------------------------------------------------------------
// settings.yaml 补丁
// ---------------------------------------------------------------------------

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type DshProviderInput = {
  providerName: string;
  displayName: string;
  apiKeyEnv: string;
  baseUrl: string;
  models: DshModelEntry[];
};

function renderProviderChildren(indent: number, opts: DshProviderInput): string[] {
  const pad = (n: number) => " ".repeat(indent + n);
  const out: string[] = [];
  out.push(`${pad(2)}displayName: ${yamlQuote(opts.displayName)}`);
  out.push(`${pad(2)}apiKeyEnv: ${yamlQuote(opts.apiKeyEnv)}`);
  out.push(`${pad(2)}api: openai-completions`);
  out.push(`${pad(2)}baseURL: ${yamlQuote(opts.baseUrl)}`);
  out.push(`${pad(2)}compat:`);
  out.push(`${pad(4)}thinkingFormat: deepseek`);
  // route 级 reasoning:部署默认思考档位。缺省时请求不带 reasoningEffort,
  // pi-ai 的 thinkingFormat=deepseek 分支不发 thinking 开关,模型走非思考模式、
  // 不返回 reasoning_content,多轮工具调用后网关 400。
  out.push(`${pad(2)}reasoning: high`);
  out.push(`${pad(2)}models:`);
  for (const m of opts.models) {
    out.push(`${pad(4)}- id: ${yamlQuote(m.id)}`);
    if (m.name && m.name !== m.id) out.push(`${pad(6)}name: ${yamlQuote(m.name)}`);
    out.push(`${pad(6)}contextWindow: ${m.contextWindow}`);
    out.push(`${pad(6)}maxTokens: ${m.maxTokens}`);
    // reasoningEfforts:对齐 dsh 官方(off 空值 + 非 off 档位),off 用空值声明
    // 「选 Off 时发送 nothing」;其余档位 key=可选级别, value=wire 拼写。
    if (m.reasoning && m.reasoningEfforts) {
      const nonOff = Object.entries(m.reasoningEfforts)
        .filter(([level, wire]) => level !== "off" && typeof wire === "string" && wire.length > 0)
        .sort(([a], [b]) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
      if (nonOff.length > 0) {
        out.push(`${pad(6)}reasoningEfforts:`);
        out.push(`${pad(8)}off:`);
        for (const [level, wire] of nonOff) {
          out.push(`${pad(8)}${level}: ${yamlQuote(wire as string)}`);
        }
      }
    }
    if (m.input && m.input.includes("image")) out.push(`${pad(6)}input: [text, image]`);
  }
  return out;
}

function renderProviderBlock(indent: number, opts: DshProviderInput): string[] {
  const header = " ".repeat(indent) + opts.providerName + ":";
  return [header, ...renderProviderChildren(indent, opts)];
}

/** 在 settings.yaml 中 upsert llm-pi-ai.providers.<name> 段(官方配置规范)。 */
export function patchDshProvider(text: string, opts: DshProviderInput): { text: string; changes: string[] } {
  const modelCount = opts.models.length;
  const NS = "llm-pi-ai";
  const PROVIDERS_KEY = "providers";

  const llm = findKeyInRegion(text, 0, text.length, NS, 0);
  if (!llm) {
    const block = `${NS}:\n  ${PROVIDERS_KEY}:\n` + renderProviderBlock(4, opts).join("\n") + "\n";
    const next = (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block;
    return { text: next, changes: [`新建 ${NS}: 段(providers.${opts.providerName},${modelCount} 个模型)`] };
  }
  if (headerHasInlineContent(text, llm.start, llm.end)) throw new Error(`${NS}: 使用内联样式(flow style),请手动编辑 settings.yaml`);
  const llmBodyStart = lineAfter(text, llm.end);
  const llmBodyEnd = blockBodyEnd(text, llmBodyStart, llm.indent, text.length);

  const prov = findKeyInRegion(text, llmBodyStart, llmBodyEnd, PROVIDERS_KEY);
  let provIndent = llm.indent + 2;
  let provBodyStart = llmBodyStart;
  let provBodyEnd = llmBodyEnd;
  if (!prov) {
    const block = " ".repeat(provIndent) + PROVIDERS_KEY + ":\n" + renderProviderBlock(provIndent + 2, opts).join("\n") + "\n";
    const next = text.slice(0, llmBodyStart) + block + text.slice(llmBodyStart);
    return { text: next, changes: [`${NS}: 段新增 providers.${opts.providerName}(${modelCount} 个模型)`] };
  }
  if (headerHasInlineContent(text, prov.start, prov.end)) throw new Error(`providers: 使用内联样式(flow style),请手动编辑 settings.yaml`);
  provIndent = prov.indent;
  provBodyStart = lineAfter(text, prov.end);
  provBodyEnd = blockBodyEnd(text, provBodyStart, provIndent, llmBodyEnd);

  const provider = findKeyInRegion(text, provBodyStart, provBodyEnd, opts.providerName);
  if (!provider) {
    const block = renderProviderBlock(provIndent + 2, opts).join("\n") + "\n";
    const next = text.slice(0, provBodyStart) + block + text.slice(provBodyStart);
    return { text: next, changes: [`providers 段新增 ${opts.providerName}(${modelCount} 个模型)`] };
  }
  if (headerHasInlineContent(text, provider.start, provider.end)) throw new Error(`providers.${opts.providerName}: 使用内联样式(flow style),请手动编辑 settings.yaml`);
  const bodyStart = lineAfter(text, provider.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, provider.indent, provBodyEnd);
  const children = renderProviderChildren(provider.indent, opts);
  const next = text.slice(0, bodyStart) + children.join("\n") + "\n" + text.slice(bodyEnd);
  return { text: next, changes: next === text ? [] : [`providers.${opts.providerName} 已更新(${modelCount} 个模型)`] };
}

/** 在 settings.yaml 中 upsert 顶层 `agent-default-model:` 段。 */
export function patchDshDefaultModel(text: string, provider: string, model: string): { text: string; changes: string[] } {
  const NS = "agent-default-model";
  const block = findKeyInRegion(text, 0, text.length, NS, 0);
  if (!block) {
    const section = `${NS}:\n  provider: ${yamlQuote(provider)}\n  model: ${yamlQuote(model)}\n`;
    const next = (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + section;
    return { text: next, changes: [`新建 ${NS}: 段(provider=${provider}, model=${model})`] };
  }
  if (headerHasInlineContent(text, block.start, block.end)) throw new Error(`${NS}: 使用内联样式(flow style),请手动编辑 settings.yaml`);
  const bodyStart = lineAfter(text, block.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, block.indent, text.length);
  const body = `  provider: ${yamlQuote(provider)}\n  model: ${yamlQuote(model)}\n`;
  const next = text.slice(0, bodyStart) + body + text.slice(bodyEnd);
  return { text: next, changes: next === text ? [] : [`${NS} 已更新(provider=${provider}, model=${model})`] };
}

/** 删除 llm-pi-ai.providers 下除 target 外的所有 provider 路由(改 provider 名后清理旧路由残留)。 */
export function removeDshOtherProviders(text: string, target: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const NS = "llm-pi-ai";
  const llm = findKeyInRegion(text, 0, text.length, NS, 0);
  if (!llm) return { text, removed };
  const llmBodyStart = lineAfter(text, llm.end);
  const llmBodyEnd = blockBodyEnd(text, llmBodyStart, llm.indent, text.length);
  const prov = findKeyInRegion(text, llmBodyStart, llmBodyEnd, "providers");
  if (!prov) return { text, removed };
  const provBodyStart = lineAfter(text, prov.end);
  const provBodyEnd = blockBodyEnd(text, provBodyStart, prov.indent, llmBodyEnd);

  // providers 下每个子路由块:key 行缩进 = prov.indent + 2
  const childIndent = prov.indent + 2;
  const blocks: { name: string; start: number; end: number }[] = [];
  let pos = provBodyStart;
  while (pos < provBodyEnd) {
    const lineEnd = text.indexOf("\n", pos);
    const lineEndSafe = lineEnd === -1 ? provBodyEnd : lineEnd;
    const line = text.slice(pos, lineEndSafe);
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (content.length > 0 && !content.startsWith("#") && indent === childIndent && content.endsWith(":")) {
      const name = content.slice(0, -1).trim();
      const bodyStart = lineAfter(text, lineEndSafe);
      const bodyEnd = blockBodyEnd(text, bodyStart, indent, provBodyEnd);
      blocks.push({ name, start: pos, end: bodyEnd });
      pos = bodyEnd;
    } else {
      pos = lineEndSafe === provBodyEnd ? provBodyEnd : lineEndSafe + 1;
    }
  }

  // 从后往前删(避免偏移),只删非 target 的
  let out = text;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.name !== target) {
      out = out.slice(0, b.start) + out.slice(b.end);
      removed.push(b.name);
    }
  }
  return { text: out, removed };
}

/** 删除废弃的 `llm-deepseek` 段(新版不再生成,清理旧版遗留)。 */
export function removeDshDeepseekSection(text: string): { text: string; removed: boolean } {
  const NS = "llm-deepseek";
  const block = findKeyInRegion(text, 0, text.length, NS, 0);
  if (!block) return { text, removed: false };
  const bodyStart = lineAfter(text, block.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, block.indent, text.length);
  // 连同前面的空行一起删,避免留下孤立空行
  const next = text.slice(0, block.start).replace(/\n{2,}$/, "\n") + text.slice(bodyEnd);
  return { text: next, removed: true };
}

// ---------------------------------------------------------------------------
// .credentials.yaml 补丁
// ---------------------------------------------------------------------------

/** 在 .credentials.yaml 中 upsert 一个凭据。兼容两种格式:
 *  - 顶层裸 `KEY: value`(dsh 官方默认);
 *  - 顶层 `refs:` 包裹(`refs:\n  KEY: value`,部分 dsh 版本),此时把 key 缩进写到 refs 之下,与已有层级对齐。
 * 若顶层已有该 key(旧版错位写法),会把它移到 refs 之下。 */
export function upsertDshCredentialYaml(text: string, key: string, value: string): { text: string; changed: boolean } {
  if (!value) throw new Error("凭据值不能为空(dsh 规范拒绝空字符串)");
  const refs = findKeyInRegion(text, 0, text.length, "refs", 0);
  if (refs && !headerHasInlineContent(text, refs.start, refs.end)) {
    return upsertDshCredentialInRefs(text, refs, key, value);
  }
  // 顶层裸 key(官方格式)
  const line = `${key}: ${yamlQuote(value)}`;
  const keyRe = new RegExp(`^${escapeRegExp(key)}:(?:[ \t].*)?$`, "m");
  if (keyRe.test(text)) {
    const next = text.replace(keyRe, line);
    return { text: next, changed: next !== text };
  }
  return { text: (text.trim() ? text.replace(/\s+$/, "") + "\n" : "") + line + "\n", changed: true };
}

/** 把凭据写进顶层 `refs:` 块:key 缩进到 refs 子项层级(通常 2 空格)。 */
function upsertDshCredentialInRefs(
  text: string,
  refs: { start: number; end: number; indent: number },
  key: string,
  value: string,
): { text: string; changed: boolean } {
  const bodyStart = lineAfter(text, refs.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, refs.indent, text.length);
  const childIndent = refs.indent + 2;
  const pad = " ".repeat(childIndent);
  const childLine = `${pad}${key}: ${yamlQuote(value)}`;
  const bodyText = text.slice(bodyStart, bodyEnd);

  // 在 refs 块体内 upsert
  const childKeyRe = new RegExp(`^${escapeRegExp(pad)}${escapeRegExp(key)}:`, "m");
  let newBody: string;
  if (childKeyRe.test(bodyText)) {
    newBody = bodyText.replace(childKeyRe, childLine);
  } else {
    const trimmed = bodyText.trim();
    newBody = trimmed ? `${bodyText.replace(/\s+$/, "")}\n${childLine}\n` : `${childLine}\n`;
  }

  // 移除顶层(错位)的旧写法,再拼回
  const topKeyRe = new RegExp(`^${escapeRegExp(key)}:(?:[ \t].*)?$\\n?`, "m");
  const before = text.slice(0, bodyStart).replace(topKeyRe, "");
  const after = text.slice(bodyEnd).replace(topKeyRe, "");

  const next = before + newBody + after;
  return { text: next, changed: next !== text };
}

// ---------------------------------------------------------------------------
// 状态诊断
// ---------------------------------------------------------------------------

/** 定位 settings.yaml 中 llm-pi-ai.providers.<name> 块体范围(供补丁与配置检测共用)。 */
export function locateProviderBlock(text: string, providerName: string): { bodyStart: number; bodyEnd: number } | null {
  const llm = findKeyInRegion(text, 0, text.length, "llm-pi-ai", 0);
  if (!llm) return null;
  const llmBodyStart = lineAfter(text, llm.end);
  const llmBodyEnd = blockBodyEnd(text, llmBodyStart, llm.indent, text.length);
  const prov = findKeyInRegion(text, llmBodyStart, llmBodyEnd, "providers");
  if (!prov) return null;
  const provBodyStart = lineAfter(text, prov.end);
  const provBodyEnd = blockBodyEnd(text, provBodyStart, prov.indent, llmBodyEnd);
  const p = findKeyInRegion(text, provBodyStart, provBodyEnd, providerName);
  if (!p) return null;
  const bodyStart = lineAfter(text, p.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, p.indent, provBodyEnd);
  return { bodyStart, bodyEnd };
}

export type DshStatus = {
  settingsExists: boolean;
  credentialsExists: boolean;
  providerConfigured: boolean;
  providerDisplayName: string | null;
  providerApiKeyEnv: string | null;
  providerBaseUrl: string | null;
  providerModels: number;
  providerThinkingFormat: string | null;
  credentialStored: boolean;
  defaultModelProvider: string | null;
  defaultModelModel: string | null;
};

/** 从 settings.yaml / .credentials.yaml 文本解析 dsh 状态(纯)。 */
export function parseDshStatus(settingsText: string, credText: string, providerName: string, apiKeyEnv: string): DshStatus {
  const block = locateProviderBlock(settingsText, providerName);
  const body = block ? settingsText.slice(block.bodyStart, block.bodyEnd) : "";
  const grab = (re: RegExp): string | null => {
    const m = body.match(re);
    return m ? unquoteYaml(m[1]) : null;
  };
  const dm = findKeyInRegion(settingsText, 0, settingsText.length, "agent-default-model", 0);
  const dmBody = dm ? settingsText.slice(lineAfter(settingsText, dm.end), blockBodyEnd(settingsText, lineAfter(settingsText, dm.end), dm.indent, settingsText.length)) : "";

  return {
    settingsExists: settingsText.length > 0,
    credentialsExists: credText.length > 0,
    providerConfigured: Boolean(block),
    providerDisplayName: grab(/^ *displayName: *(.*)$/m),
    providerApiKeyEnv: grab(/^ *apiKeyEnv: *(.*)$/m),
    providerBaseUrl: grab(/^ *baseURL: *(.*)$/m),
    providerModels: (body.match(/^ *- id:/gm) ?? []).length,
    providerThinkingFormat: grab(/^ *thinkingFormat: *(.*)$/m),
    credentialStored: new RegExp(`^\\s*${escapeRegExp(apiKeyEnv)}:`).test(credText),
    defaultModelProvider: dmBody.match(/^ *provider: *(.*)$/m)?.[1]?.trim() ?? null,
    defaultModelModel: dmBody.match(/^ *model: *(.*)$/m)?.[1]?.trim() ?? null,
  };
}
