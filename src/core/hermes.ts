// Hermes(~/.hermes/config.yaml)自定义 provider 配置。
//
// 官方格式(hermes-agent docs: integrations/providers.md「Named Custom Providers」,
// 源码 hermes_cli/runtime_provider_custom.py 为准确认):
//   providers:
//     <name>:
//       base_url: https://gateway.example/v1   # api / url 是别名
//       api_key: sk-…                          # 或 key_env / key_cmd
//       transport: chat_completions            # v12 迁移写 transport;手改配置常写 api_mode,两者都认
//       models:
//         <id>:
//           context_length: 1000000
//           supports_vision: true
//   model:
//     provider: <name>
//     default: <id>
//     base_url: ''                               # 切到命名 provider 时清空,端点由 provider 段提供
//
// 只接管 providers.<name> 下的 base_url / api_key / transport(或已有 api_mode) / models
// 与顶层 model.provider / model.default;其余键(extra_body、extra_headers、key_env、
// 用户自己加的键)原样保留。auxiliary 各槽位与 fallback_providers 不动。

import {
  applyTextOps,
  blockBodyEnd,
  escapeRegExp,
  findKeyInRegion,
  headerHasInlineContent,
  lineAfter,
  planManagedKeyUpserts,
  preserveTrailingBlanks,
  unquoteYaml,
  yamlQuote,
  type ManagedKey,
  type TextOp,
} from "./util";

export type HermesModelEntry = {
  id: string;
  contextLength?: number;
  supportsVision?: boolean;
};

export type HermesPatchInput = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  models: HermesModelEntry[];
};

export type HermesPatchResult = {
  text: string;
  changes: string[];
  warnings: string[];
};

type Region = { start: number; end: number; indent: number };

/** providers 块的子键缩进(取第一条非空非注释行的缩进,缺省 2)。 */
function childIndent(text: string, from: number, to: number, fallback = 2): number {
  for (const line of text.slice(from, to).split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return line.length - trimmed.length;
  }
  return fallback;
}

/**
 * 把「空值的内联块头」展开成块写法:`model: ""`(全新安装的官方哨兵)、`providers: {}`、
 * `models: []` 都属于可以安全展开的情形;真有内容的行内写法仍报错要求手动改。
 */
function openEmptyBlockHeader(text: string, region: Region, what: string): string {
  const line = text.slice(region.start, region.end);
  const rest = line.slice(line.indexOf(":") + 1).trim();
  if (rest === "") return text;
  if (rest === '""' || rest === "''" || rest === "{}" || rest === "[]" || rest === "~" || rest === "null") {
    return text.slice(0, region.start) + line.replace(/:[ \t]*.*$/, ":") + text.slice(region.end);
  }
  throw new Error(`config.yaml 的 ${what} 使用了内联写法,请先手动改成块写法再配置`);
}

/** 定位 providers.<name> 条目(含其正文区间);未配置返回 null。 */
function locateProvider(text: string, providerName: string): { entry: Region; bodyStart: number; bodyEnd: number } | null {
  const providers = findKeyInRegion(text, 0, text.length, "providers", 0);
  if (!providers) return null;
  if (headerHasInlineContent(text, providers.start, providers.end)) {
    throw new Error("config.yaml 的 providers: 使用了内联写法,请先手动改成块写法再配置");
  }
  const bodyStart = lineAfter(text, providers.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, providers.indent, text.length);
  const entryIndent = childIndent(text, bodyStart, bodyEnd);
  const entry = findKeyInRegion(text, bodyStart, bodyEnd, providerName, entryIndent);
  if (!entry) return null;
  if (headerHasInlineContent(text, entry.start, entry.end)) {
    throw new Error(`config.yaml 的 providers.${providerName}: 使用了内联写法,请先手动改成块写法再配置`);
  }
  const eStart = lineAfter(text, entry.end);
  const eEnd = blockBodyEnd(text, eStart, entry.indent, bodyEnd);
  return { entry, bodyStart: eStart, bodyEnd: eEnd };
}

type ChildKey = { key: string; start: number };

/** 扫描 [from,to) 内指定缩进的 `key:` 行(去引号,返回原始键名)。 */
function scanChildKeys(text: string, from: number, to: number, indent: number): ChildKey[] {
  const out: ChildKey[] = [];
  const region = text.slice(from, to);
  const re = /^( *)([^#\s][^:\n]*):(?:[ \t]|$)/gm;
  for (const m of region.matchAll(re)) {
    if (m[1].length !== indent) continue;
    out.push({ key: unquoteYaml(m[2].trim()), start: from + m.index! });
  }
  return out;
}

/** 模型 id 作为 YAML 键:含特殊字符时加引号。 */
function yamlKey(id: string): string {
  return /^[A-Za-z0-9_.\-/]+$/.test(id) ? id : yamlQuote(id);
}

/** 一个模型条目块内被管理的子键(现有条目逐键 upsert,不动用户键)。 */
function modelEntryKeys(m: HermesModelEntry, indent: number): ManagedKey[] {
  const pad = " ".repeat(indent);
  const keys: ManagedKey[] = [];
  if (typeof m.contextLength === "number" && m.contextLength > 0) {
    keys.push({ key: "context_length", lines: [`${pad}context_length: ${m.contextLength}`] });
  }
  if (typeof m.supportsVision === "boolean") {
    keys.push({ key: "supports_vision", lines: [`${pad}supports_vision: ${m.supportsVision}`] });
  }
  return keys;
}

/** 一个模型条目块的行(含缩进)。 */
function modelEntryLines(m: HermesModelEntry, indent: number): string[] {
  const pad = " ".repeat(indent);
  return [`${pad}${yamlKey(m.id)}:`, ...modelEntryKeys(m, indent + 2).map((k) => k.lines![0])];
}

/** 整段 provider 条目文本(新建时用)。 */
function renderProviderEntry(input: HermesPatchInput, entryIndent: number, wireKey: string, models: HermesModelEntry[]): string[] {
  const pad = " ".repeat(entryIndent);
  const child = " ".repeat(entryIndent + 2);
  const modelIndent = entryIndent + 4;
  const lines = [
    `${pad}${yamlKey(input.providerName)}:`,
    `${child}base_url: ${yamlQuote(input.baseUrl)}`,
    `${child}api_key: ${yamlQuote(input.apiKey)}`,
    `${child}${wireKey}: chat_completions`,
    `${child}models:`,
  ];
  for (const m of models) lines.push(...modelEntryLines(m, modelIndent));
  return lines;
}

/**
 * 合并 models 子块(条目按 id upsert、条目内用户键保留、下架条目连同子块移除)。
 * 未接入该 provider 时返回 providerFound=false 且文本不变。
 */
function applyModelsBlock(
  text: string,
  providerName: string,
  sorted: HermesModelEntry[],
): { text: string; changes: string[]; providerFound: boolean } {
  let loc = locateProvider(text, providerName);
  if (!loc) return { text, changes: [], providerFound: false };

  const changes: string[] = [];
  const keyIndent = childIndent(text, loc.bodyStart, loc.bodyEnd, loc.entry.indent + 2);
  let out = text;

  // `models: {}` 之类空值内联写法先展开成块写法(文本长度会变,展开后必须重新定位)
  const rawModelsKey = findKeyInRegion(out, loc.bodyStart, loc.bodyEnd, "models", keyIndent);
  if (rawModelsKey && headerHasInlineContent(out, rawModelsKey.start, rawModelsKey.end)) {
    const expanded = openEmptyBlockHeader(out, rawModelsKey, `providers.${providerName}.models:`);
    if (expanded !== out) {
      out = expanded;
      const reloc = locateProvider(out, providerName);
      if (!reloc) return { text: out, changes, providerFound: true };
      loc = reloc;
    }
  }

  const modelsKey = findKeyInRegion(out, loc.bodyStart, loc.bodyEnd, "models", keyIndent);
  if (!modelsKey) {
    const modelIndent = keyIndent + 2;
    const lines = [`${" ".repeat(keyIndent)}models:`, ...sorted.flatMap((m) => modelEntryLines(m, modelIndent))];
    // 插到条目块末尾(保留尾部空行)
    const trailing = preserveTrailingBlanks(out, { bodyStart: loc.bodyStart, end: loc.bodyEnd });
    const insertAt = loc.bodyEnd - trailing.length;
    out = out.slice(0, insertAt) + lines.join("\n") + "\n" + out.slice(insertAt);
    return { text: out, changes: [`models 已新增(${sorted.length} 个模型)`], providerFound: true };
  }

  if (headerHasInlineContent(out, modelsKey.start, modelsKey.end)) {
    throw new Error(`providers.${providerName}.models: 使用了内联写法,请先手动改成块写法再配置`);
  }
  const modelsBodyStart = lineAfter(out, modelsKey.end);
  const modelsBodyEnd = blockBodyEnd(out, modelsBodyStart, modelsKey.indent, loc.bodyEnd);
  const modelIndent = childIndent(out, modelsBodyStart, modelsBodyEnd, modelsKey.indent + 2);
  const liveIds = new Set(sorted.map((m) => m.id));
  const existing = scanChildKeys(out, modelsBodyStart, modelsBodyEnd, modelIndent);

  const ops: TextOp[] = [];
  for (const e of existing) {
    if (liveIds.has(e.key)) continue;
    // 陈旧条目:连同子块移除,保留尾部空行
    const eStart = lineAfter(out, out.indexOf("\n", e.start));
    const eEnd = blockBodyEnd(out, eStart, modelIndent, modelsBodyEnd);
    ops.push({ start: e.start, end: eEnd, replacement: preserveTrailingBlanks(out, { bodyStart: eStart, end: eEnd }) });
  }

  // 已有条目:逐键 upsert(条目里的用户键原样保留),不做整块替换
  for (const m of sorted) {
    const own = existing.find((e) => e.key === m.id);
    if (!own) continue;
    const eStart = lineAfter(out, out.indexOf("\n", own.start));
    const eEnd = blockBodyEnd(out, eStart, modelIndent, modelsBodyEnd);
    const childIndentHere = childIndent(out, eStart, eEnd, modelIndent + 2);
    ops.push(
      ...planManagedKeyUpserts(
        out,
        { start: eStart, end: eEnd },
        { separator: ":", indent: childIndentHere, keys: modelEntryKeys(m, childIndentHere) },
      ),
    );
  }

  // 新条目:整块插入 models 段首
  const newEntries = sorted.filter((m) => !existing.some((e) => e.key === m.id));
  if (newEntries.length > 0) {
    ops.push({
      start: modelsBodyStart,
      end: modelsBodyStart,
      replacement: newEntries.flatMap((m) => modelEntryLines(m, modelIndent)).join("\n") + "\n",
    });
  }

  const before = out;
  out = applyTextOps(out, ops);
  if (out !== before) changes.push(`models 已更新(${sorted.length} 个模型)`);
  return { text: out, changes, providerFound: true };
}

/** 该 provider 段是否已存在(仅刷新模型时用于判断是否已接入)。 */
export function hermesProviderExists(text: string, providerName: string): boolean {
  try {
    return locateProvider(text, providerName) !== null;
  } catch {
    return false;
  }
}

/**
 * 生成/更新 Hermes 配置:
 * - providers.<name>:upsert base_url / api_key / 传输方式(已有 api_mode 就沿用该键名,
 *   否则写 v12 的 transport),models 子块按 id 合并;
 * - model.provider / model.default 指向本 provider 与默认模型;model.base_url 若存在则清空;
 * - 顶层其它键、providers 下其它 provider、模型条目里的用户键一概不动。
 */
export function patchHermesConfig(text: string, input: HermesPatchInput): HermesPatchResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (input.models.length === 0) return { text, changes, warnings };

  const sorted = [...input.models].sort((a, b) => a.id.localeCompare(b.id));
  const defaultModel = input.defaultModel && sorted.some((m) => m.id === input.defaultModel) ? input.defaultModel : sorted[0].id;

  let out = text;

  // 全新安装的官方 config 里是 `model: ""` 哨兵;`providers: {}` 同理。先展开成块写法。
  const providersRegion = findKeyInRegion(out, 0, out.length, "providers", 0);
  if (providersRegion) out = openEmptyBlockHeader(out, providersRegion, "providers:");
  const modelRegion0 = findKeyInRegion(out, 0, out.length, "model", 0);
  if (modelRegion0) out = openEmptyBlockHeader(out, modelRegion0, "model:");

  // ── 1. providers 块 + provider 条目(缺失则整体追加) ─────────────────────
  if (!locateProvider(out, input.providerName)) {
    const providers = findKeyInRegion(out, 0, out.length, "providers", 0);
    if (!providers) {
      const block = ["providers:", ...renderProviderEntry(input, 2, "transport", sorted)];
      out = (out.trim() ? out.replace(/\s+$/, "") + "\n\n" : "") + block.join("\n") + "\n";
    } else {
      if (headerHasInlineContent(out, providers.start, providers.end)) {
        throw new Error("config.yaml 的 providers: 使用了内联写法,请先手动改成块写法再配置");
      }
      const bodyStart = lineAfter(out, providers.end);
      const bodyEnd = blockBodyEnd(out, bodyStart, providers.indent, out.length);
      const entryIndent = childIndent(out, bodyStart, bodyEnd);
      const lines = renderProviderEntry(input, entryIndent, "transport", sorted);
      out = out.slice(0, bodyStart) + lines.join("\n") + "\n" + out.slice(bodyStart);
    }
    changes.push(`providers.${input.providerName} 已新增(base_url + api_key + chat_completions + ${sorted.length} 个模型)`);
  } else {
    // ── 2. provider 内标量键 ──────────────────────────────────────────────
    const loc = locateProvider(out, input.providerName)!;
    const keyIndent = childIndent(out, loc.bodyStart, loc.bodyEnd, loc.entry.indent + 2);
    // v12 迁移写 transport,手改配置常写 api_mode(两者都认):沿用已有键名,避免同段出现两个协议键
    const wireKey = findKeyInRegion(out, loc.bodyStart, loc.bodyEnd, "api_mode", keyIndent) ? "api_mode" : "transport";

    if (findKeyInRegion(out, loc.bodyStart, loc.bodyEnd, "key_env", keyIndent)) {
      warnings.push(`providers.${input.providerName} 已有 key_env,其优先级高于 api_key(本次仍写入 api_key,但实际生效的是 key_env)`);
    }
    if (findKeyInRegion(out, loc.bodyStart, loc.bodyEnd, "key_cmd", keyIndent)) {
      warnings.push(`providers.${input.providerName} 已有 key_cmd,其优先级高于 api_key(本次仍写入 api_key,但实际生效的是 key_cmd)`);
    }

    const pad = " ".repeat(keyIndent);
    const scalarKeys: ManagedKey[] = [
      { key: "base_url", lines: [`${pad}base_url: ${yamlQuote(input.baseUrl)}`] },
      { key: "api_key", lines: [`${pad}api_key: ${yamlQuote(input.apiKey)}`] },
      { key: wireKey, lines: [`${pad}${wireKey}: chat_completions`] },
    ];
    const before = out;
    out = applyTextOps(
      out,
      planManagedKeyUpserts(out, { start: loc.bodyStart, end: loc.bodyEnd }, { separator: ":", indent: keyIndent, keys: scalarKeys }),
    );
    if (out !== before) changes.push(`providers.${input.providerName}: base_url / api_key / ${wireKey}`);
  }

  // ── 3. models 子块 ─────────────────────────────────────────────────────
  const modelsResult = applyModelsBlock(out, input.providerName, sorted);
  out = modelsResult.text;
  changes.push(...modelsResult.changes);

  // ── 4. 顶层 model 块 ───────────────────────────────────────────────────
  const providerLine = `provider: ${yamlQuote(input.providerName)}`;
  const defaultLine = `default: ${yamlQuote(defaultModel)}`;
  const modelBlock = findKeyInRegion(out, 0, out.length, "model", 0);
  if (!modelBlock) {
    out = (out.trim() ? out.replace(/\s+$/, "") + "\n\n" : "") + ["model:", `  ${providerLine}`, `  ${defaultLine}`].join("\n") + "\n";
    changes.push(`model.provider = ${input.providerName}, model.default = ${defaultModel}`);
  } else {
    if (headerHasInlineContent(out, modelBlock.start, modelBlock.end)) {
      throw new Error("config.yaml 的 model: 使用了内联写法,请先手动改成块写法再配置");
    }
    const bodyStart = lineAfter(out, modelBlock.end);
    const bodyEnd = blockBodyEnd(out, bodyStart, modelBlock.indent, out.length);
    const indent = childIndent(out, bodyStart, bodyEnd, 2);
    const modelPad = " ".repeat(indent);
    const keys: ManagedKey[] = [
      { key: "provider", lines: [`${modelPad}${providerLine}`] },
      { key: "default", lines: [`${modelPad}${defaultLine}`] },
    ];
    // 切到命名 provider 时清空遗留的 model.base_url(官方:切换 provider 后端点由 provider 段提供)
    if (findKeyInRegion(out, bodyStart, bodyEnd, "base_url", indent)) {
      keys.push({ key: "base_url", lines: [`${modelPad}base_url: ''`] });
    }
    const before = out;
    out = applyTextOps(out, planManagedKeyUpserts(out, { start: bodyStart, end: bodyEnd }, { separator: ":", indent, keys }));
    if (out !== before) changes.push(`model.provider = ${input.providerName}, model.default = ${defaultModel}`);
  }

  return { text: out, changes, warnings };
}

/**
 * 「仅更新模型列表」:只合并 providers.<name>.models,base_url / api_key / 传输方式
 * 与 model.* 一概不动(仅当 model.default 指向的模型已下架时修正)。
 * 未接入(无该 provider 段)时 providerFound=false。
 */
export function patchHermesModelList(
  text: string,
  providerName: string,
  models: HermesModelEntry[],
  configuredDefault?: string,
): { text: string; changes: string[]; providerFound: boolean } {
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  const r = applyModelsBlock(text, providerName, sorted);
  if (!r.providerFound || sorted.length === 0) return r;

  const changes = [...r.changes];
  let out = r.text;
  const modelBlock = findKeyInRegion(out, 0, out.length, "model", 0);
  if (modelBlock && !headerHasInlineContent(out, modelBlock.start, modelBlock.end)) {
    const bodyStart = lineAfter(out, modelBlock.end);
    const bodyEnd = blockBodyEnd(out, bodyStart, modelBlock.indent, out.length);
    const live = new Set(sorted.map((m) => m.id));
    const want = configuredDefault && live.has(configuredDefault) ? configuredDefault : null;
    const current = out.slice(bodyStart, bodyEnd).match(/^ *default:[ \t]*(.*)$/m);
    const currentId = current ? unquoteYaml(current[1]) : null;
    if (currentId && !live.has(currentId)) {
      const def = want ?? sorted[0].id;
      const indent = childIndent(out, bodyStart, bodyEnd, 2);
      out = applyTextOps(
        out,
        planManagedKeyUpserts(out, { start: bodyStart, end: bodyEnd }, { separator: ":", indent, keys: [{ key: "default", lines: [`${" ".repeat(indent)}default: ${yamlQuote(def)}`] }] }),
      );
      changes.push(`model.default 修正为 ${def}(原 ${currentId} 已下架)`);
    }
  }
  return { text: out, changes, providerFound: true };
}

// ---------------------------------------------------------------------------
// 状态 / 一致性检测(纯解析)
// ---------------------------------------------------------------------------

export type HermesStatus = {
  configExists: boolean;
  providerConfigured: boolean;
  baseUrl: string | null;
  apiKeySet: boolean;
  wireMode: string | null;
  modelCount: number;
  defaultProvider: string | null;
  defaultModel: string | null;
  modelBaseUrl: string | null;
  credentialVia: "api_key" | "key_env" | "key_cmd" | null;
};

/** 从 config.yaml 文本读取 providers.<name> 与 model.* 的当前值(只读诊断)。 */
export function parseHermesStatus(text: string, providerName: string): HermesStatus {
  let baseUrl: string | null = null;
  let apiKey: string | null = null;
  let wireMode: string | null = null;
  let modelCount = 0;
  let credentialVia: HermesStatus["credentialVia"] = null;

  let loc: ReturnType<typeof locateProvider> = null;
  try {
    loc = locateProvider(text, providerName);
  } catch {
    loc = null; // 内联写法等异常:状态页只报「未配置」,配置动作里再抛明确错误
  }
  if (loc) {
    const keyIndent = childIndent(text, loc.bodyStart, loc.bodyEnd, loc.entry.indent + 2);
    const grab = (name: string): string | null => {
      const m = text.slice(loc!.bodyStart, loc!.bodyEnd).match(new RegExp(`^ {${keyIndent}}${escapeRegExp(name)}:[ \\t]*(.*)$`, "m"));
      return m ? unquoteYaml(m[1]) : null;
    };
    baseUrl = grab("base_url") ?? grab("api") ?? grab("url");
    apiKey = grab("api_key");
    wireMode = grab("api_mode") ?? grab("transport");
    if (apiKey && apiKey.length > 0) credentialVia = "api_key";
    else if (grab("key_env")) credentialVia = "key_env";
    else if (grab("key_cmd")) credentialVia = "key_cmd";
    const models = findKeyInRegion(text, loc.bodyStart, loc.bodyEnd, "models", keyIndent);
    if (models && !headerHasInlineContent(text, models.start, models.end)) {
      const mStart = lineAfter(text, models.end);
      const mEnd = blockBodyEnd(text, mStart, models.indent, loc.bodyEnd);
      modelCount = scanChildKeys(text, mStart, mEnd, childIndent(text, mStart, mEnd, models.indent + 2)).length;
    }
  }

  const modelBlock = findKeyInRegion(text, 0, text.length, "model", 0);
  let defaultProvider: string | null = null;
  let defaultModel: string | null = null;
  let modelBaseUrl: string | null = null;
  if (modelBlock && !headerHasInlineContent(text, modelBlock.start, modelBlock.end)) {
    const bodyStart = lineAfter(text, modelBlock.end);
    const bodyEnd = blockBodyEnd(text, bodyStart, modelBlock.indent, text.length);
    const body = text.slice(bodyStart, bodyEnd);
    const grab = (name: string): string | null => {
      const m = body.match(new RegExp(`^ *${escapeRegExp(name)}:[ \\t]*(.*)$`, "m"));
      return m ? unquoteYaml(m[1]) : null;
    };
    defaultProvider = grab("provider");
    defaultModel = grab("default");
    modelBaseUrl = grab("base_url");
  }

  return {
    configExists: text.trim().length > 0,
    providerConfigured: baseUrl !== null,
    baseUrl,
    apiKeySet: apiKey !== null && apiKey.length > 0,
    wireMode,
    modelCount,
    defaultProvider,
    defaultModel,
    modelBaseUrl,
    credentialVia,
  };
}

/** 配置一致性:providers.<name> 的 base_url / api_key(与 compareAgentConfig 对齐)。
 *  key_env / key_cmd 场景 apiKey 返回 null(密钥不在文件里,无法比对)。 */
export function extractHermesProvider(text: string, providerName: string): { baseUrl: string | null; apiKey: string | null } {
  const s = parseHermesStatus(text, providerName);
  if (!s.providerConfigured) return { baseUrl: null, apiKey: null };
  let apiKey: string | null = null;
  try {
    const loc = locateProvider(text, providerName);
    if (loc) {
      const m = text.slice(loc.bodyStart, loc.bodyEnd).match(/^ *api_key:[ \t]*(.*)$/m);
      apiKey = m ? unquoteYaml(m[1]) : null;
    }
  } catch {
    // 内联写法:按未配置处理
  }
  return { baseUrl: s.baseUrl, apiKey: apiKey && apiKey.length > 0 ? apiKey : null };
}
