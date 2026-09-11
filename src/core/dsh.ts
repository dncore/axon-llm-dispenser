// DeepSeek Harness (dsh) 配置:官方 settings.yaml + .credentials.yaml。
// 纯文本变换(缩进感知的 YAML 块补丁),不做文件 I/O。

import {
  applyTextOps,
  blockBodyEnd,
  escapeRegExp,
  findKeyInRegion,
  headerHasInlineContent,
  lineAfter,
  planManagedKeyUpserts,
  preserveTrailingBlanks,
  scanYamlListItems,
  trailingBlankStart,
  yamlQuote,
  unquoteYaml,
  type ManagedKey,
  type TextOp,
} from "./util";

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

/** 模型条目的管理子键(reasoningEfforts/input 不适用时移除,避免残留旧元数据)。 */
function modelItemManagedKeys(itemIndent: number, m: DshModelEntry): ManagedKey[] {
  const sp = " ".repeat(itemIndent + 2);
  // reasoningEfforts:对齐 dsh 官方(off 空值 + 非 off 档位),off 用空值声明
  // 「选 Off 时发送 nothing」;其余档位 key=可选级别, value=wire 拼写。
  let effortLines: string[] | null = null;
  if (m.reasoning && m.reasoningEfforts) {
    const nonOff = Object.entries(m.reasoningEfforts)
      .filter(([level, wire]) => level !== "off" && typeof wire === "string" && wire.length > 0)
      .sort(([a], [b]) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
    if (nonOff.length > 0) {
      effortLines = [`${sp}reasoningEfforts:`, `${sp}  off:`];
      for (const [level, wire] of nonOff) {
        effortLines.push(`${sp}  ${level}: ${yamlQuote(wire as string)}`);
      }
    }
  }
  return [
    { key: "name", lines: m.name && m.name !== m.id ? [`${sp}name: ${yamlQuote(m.name)}`] : null },
    { key: "contextWindow", lines: [`${sp}contextWindow: ${m.contextWindow}`] },
    { key: "maxTokens", lines: [`${sp}maxTokens: ${m.maxTokens}`] },
    { key: "reasoningEfforts", lines: effortLines, block: true },
    { key: "input", lines: m.input && m.input.includes("image") ? [`${sp}input: [text, image]`] : null },
  ];
}

/** 渲染单个模型条目(itemIndent 为 `- id:` 行的缩进)。 */
function renderModelItemLines(itemIndent: number, m: DshModelEntry): string[] {
  const out = [`${" ".repeat(itemIndent)}- id: ${yamlQuote(m.id)}`];
  for (const k of modelItemManagedKeys(itemIndent, m)) {
    if (k.lines) out.push(...k.lines);
  }
  return out;
}

/** 渲染 `models:` 键行 + 全部条目(provider 缩进;条目缩进 +4)。 */
function renderModelsLines(providerIndent: number, models: DshModelEntry[]): string[] {
  const out = [`${" ".repeat(providerIndent + 2)}models:`];
  for (const m of models) out.push(...renderModelItemLines(providerIndent + 4, m));
  return out;
}

/** provider 块标量键(displayName / apiKeyEnv / api / baseURL)。 */
function providerScalarKeys(indent: number, opts: DshProviderInput): ManagedKey[] {
  const sp = " ".repeat(indent + 2);
  return [
    { key: "displayName", lines: [`${sp}displayName: ${yamlQuote(opts.displayName)}`] },
    { key: "apiKeyEnv", lines: [`${sp}apiKeyEnv: ${yamlQuote(opts.apiKeyEnv)}`] },
    { key: "api", lines: [`${sp}api: openai-completions`] },
    { key: "baseURL", lines: [`${sp}baseURL: ${yamlQuote(opts.baseUrl)}`] },
  ];
}

/** DeepSeek 方言静态键(compat 子块 + route 级 reasoning)。
 *  route 级 reasoning:部署默认思考档位。缺省时请求不带 reasoningEffort,
 *  pi-ai 的 thinkingFormat=deepseek 分支不发 thinking 开关,模型走非思考模式、
 *  不返回 reasoning_content,多轮工具调用后网关 400。axon 对所有网关无条件写入。 */
function providerStaticKeys(indent: number): ManagedKey[] {
  const pad = (n: number) => " ".repeat(indent + n);
  return [
    { key: "compat", lines: [`${pad(2)}compat:`, `${pad(4)}thinkingFormat: deepseek`], block: true },
    { key: "reasoning", lines: [`${pad(2)}reasoning: high`] },
  ];
}

function renderProviderBlock(indent: number, opts: DshProviderInput): string[] {
  const out = [`${" ".repeat(indent)}${opts.providerName}:`];
  for (const k of [...providerScalarKeys(indent, opts), ...providerStaticKeys(indent)]) {
    if (k.lines) out.push(...k.lines);
  }
  out.push(...renderModelsLines(indent, opts.models));
  return out;
}

/** 定位 llm-pi-ai.providers.<name> 块;返回其表头行与体区间。 */
export function locateDshProviderBlock(
  text: string,
  providerName: string,
): { headerStart: number; headerEnd: number; bodyStart: number; bodyEnd: number; indent: number } | null {
  const NS = "llm-pi-ai";
  const llm = findKeyInRegion(text, 0, text.length, NS, 0);
  if (!llm) return null;
  const llmBodyStart = lineAfter(text, llm.end);
  const llmBodyEnd = blockBodyEnd(text, llmBodyStart, llm.indent, text.length);
  const prov = findKeyInRegion(text, llmBodyStart, llmBodyEnd, "providers");
  if (!prov) return null;
  const provBodyStart = lineAfter(text, prov.end);
  const provBodyEnd = blockBodyEnd(text, provBodyStart, prov.indent, llmBodyEnd);
  const provider = findKeyInRegion(text, provBodyStart, provBodyEnd, providerName);
  if (!provider) return null;
  const bodyStart = lineAfter(text, provider.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, provider.indent, provBodyEnd);
  return { headerStart: provider.start, headerEnd: provider.end, bodyStart, bodyEnd, indent: provider.indent };
}

type DshModelsMerge = { ops: TextOp[]; added: number; removed: number };

/** 在 provider 块内按 id 合并 models 列表:已有条目只 upsert 管理子键(用户键保留),
 *  远端已不存在的条目删除,新条目按字母序插入。models 键缺失/内联时整块写入。 */
function planDshModelsMerge(
  text: string,
  providerBody: { start: number; end: number },
  providerIndent: number,
  models: DshModelEntry[],
): DshModelsMerge {
  const modelsKey = findKeyInRegion(text, providerBody.start, providerBody.end, "models", providerIndent + 2);
  if (!modelsKey || headerHasInlineContent(text, modelsKey.start, modelsKey.end)) {
    const block = renderModelsLines(providerIndent, models).join("\n") + "\n";
    const op: TextOp = modelsKey
      ? { start: modelsKey.start, end: lineAfter(text, modelsKey.end), replacement: block }
      : { start: providerBody.start, end: providerBody.start, replacement: block };
    return { ops: [op], added: modelsKey ? 0 : models.length, removed: 0 };
  }
  const listStart = lineAfter(text, modelsKey.end);
  const listEnd = blockBodyEnd(text, listStart, modelsKey.indent, providerBody.end);
  const items = scanYamlListItems(text, listStart, listEnd);
  const byId = new Map(items.map((it) => [it.id, it]));
  const wanted = new Set(models.map((m) => m.id));
  const mergeOps: TextOp[] = [];
  const deletes: TextOp[] = [];
  const inserts: TextOp[] = [];
  let removed = 0;
  for (const it of items) {
    if (wanted.has(it.id)) continue;
    deletes.push({ start: it.start, end: it.end, replacement: preserveTrailingBlanks(text, it) });
    removed++;
  }
  for (const m of models) {
    const it = byId.get(m.id);
    if (!it) continue;
    mergeOps.push(
      ...planManagedKeyUpserts(
        text,
        { start: it.bodyStart, end: it.end },
        { separator: ":", indent: it.indent + 2, keys: modelItemManagedKeys(it.indent, m) },
      ),
    );
  }
  const fresh = models.filter((m) => !byId.has(m.id)).sort((a, b) => a.id.localeCompare(b.id));
  let added = 0;
  if (fresh.length > 0) {
    const itemIndent = items[0]?.indent ?? providerIndent + 4;
    const anchors = new Map<number, string[]>();
    for (const m of fresh) {
      const idx = items.findIndex((it) => it.id.localeCompare(m.id) > 0);
      let pos = idx >= 0 ? items[idx].start : trailingBlankStart(text, listStart, listEnd);
      // 锚点若落在被删除条目的区间内,收拢到删除区间起点(同点删除先于插入,顺序稳定)
      for (const d of deletes) {
        if (pos > d.start && pos < d.end) {
          pos = d.start;
          break;
        }
      }
      const lines = anchors.get(pos) ?? [];
      lines.push(...renderModelItemLines(itemIndent, m));
      anchors.set(pos, lines);
      added++;
    }
    for (const [pos, lines] of anchors) {
      inserts.push({ start: pos, end: pos, replacement: lines.join("\n") + "\n" });
    }
  }
  // 顺序:同位置时删除先于插入(applyTextOps 对同 start 保持数组顺序)
  return { ops: [...mergeOps, ...deletes, ...inserts], added, removed };
}

/** 应用已有 provider 块的管理键合并:scalarKeys(可为 null)+ 静态键 + models 列表。 */
function applyDshProviderMerge(
  text: string,
  providerBody: { start: number; end: number },
  providerIndent: number,
  models: DshModelEntry[],
  scalarKeys: ManagedKey[] | null,
): string {
  const keyOps = planManagedKeyUpserts(text, providerBody, {
    separator: ":",
    indent: providerIndent + 2,
    keys: [...(scalarKeys ?? []), ...providerStaticKeys(providerIndent)],
  });
  const merge = planDshModelsMerge(text, providerBody, providerIndent, models);
  return applyTextOps(text, [...keyOps, ...merge.ops]);
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
  // 4) 已有块:只 upsert 管理键(models 按 id 合并),块内用户键与注释原样保留
  const next = applyDshProviderMerge(
    text,
    { start: bodyStart, end: bodyEnd },
    provider.indent,
    opts.models,
    providerScalarKeys(provider.indent, opts),
  );
  return { text: next, changes: next === text ? [] : [`providers.${opts.providerName} 已更新(${modelCount} 个模型)`] };
}

/**
 * 「仅更新模型列表」:只刷新既有 provider 块的 models 列表(条目按 id 合并),
 * displayName / apiKeyEnv / baseURL / 静态方言键等一概不动。
 * 块不存在时 providerFound=false,由调用方提示先跑「配置」。
 */
export function patchDshProviderModels(
  text: string,
  opts: { providerName: string; models: DshModelEntry[] },
): { text: string; changes: string[]; providerFound: boolean } {
  const provider = locateDshProviderBlock(text, opts.providerName);
  if (!provider) return { text, changes: [], providerFound: false };
  const next = applyDshProviderMerge(
    text,
    { start: provider.bodyStart, end: provider.bodyEnd },
    provider.indent,
    opts.models,
    null,
  );
  const changes: string[] = [];
  if (next !== text) changes.push(`models 已更新(${opts.models.length} 个模型)`);
  return { text: next, changes, providerFound: true };
}

/** 在 settings.yaml 中 upsert 顶层 `agent-default-model:` 段。
 * 该段由 dsh 设置界面管理(用户可在 UI 里选择默认 provider/model 与
 * reasoningEffort):dsh 已配置时 axon 不覆盖,避免改掉用户选择、丢失
 * 已有字段;仅当缺失(或空段)时才写入指向本网关的默认值。 */
export function patchDshDefaultModel(text: string, provider: string, model: string): { text: string; changes: string[] } {
  const NS = "agent-default-model";
  const block = findKeyInRegion(text, 0, text.length, NS, 0);
  if (block && headerHasInlineContent(text, block.start, block.end)) throw new Error(`${NS}: 使用内联样式(flow style),请手动编辑 settings.yaml`);
  if (block) {
    const bodyStart = lineAfter(text, block.end);
    const bodyEnd = blockBodyEnd(text, bodyStart, block.indent, text.length);
    // dsh 已配置(块体非空):尊重用户选择,不覆盖
    if (text.slice(bodyStart, bodyEnd).trim().length > 0) return { text, changes: [] };
    // 空段(仅 `agent-default-model:`):补默认值
    const section = `  provider: ${yamlQuote(provider)}\n  model: ${yamlQuote(model)}\n`;
    const next = text.slice(0, bodyStart) + section + text.slice(bodyEnd);
    return { text: next, changes: [`${NS}: 空段补默认(provider=${provider}, model=${model})`] };
  }
  const section = `${NS}:\n  provider: ${yamlQuote(provider)}\n  model: ${yamlQuote(model)}\n`;
  const next = (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + section;
  return { text: next, changes: [`新建 ${NS}: 段(provider=${provider}, model=${model})`] };
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
  const childKeyRe = new RegExp(`^${escapeRegExp(pad)}${escapeRegExp(key)}:(?:[ \t].*)?$`, "m");
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
