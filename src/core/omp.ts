// Oh My Pi (omp) 配置:写入 ~/.omp/agent/models.yml(providers)+ config.yml(modelRoles)。
// 纯文本变换(缩进感知的 YAML 块补丁),不做文件 I/O。
// DeepSeek 模型按 DeepSeek 官方 awesome-deepseek-agent 指南的优化配置写入
// (thinking 等级锁定 + 完整 compat 块:官方明示 compat 整体替换不合并,必须写全)。

import type { ResolvedModel } from "./models";
import { isDeepseekModel } from "./models";
import { blockBodyEnd, findKeyInRegion, headerHasInlineContent, lineAfter, yamlQuote, unquoteYaml } from "./util";

export type OmpProviderInput = {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  models: ResolvedModel[];
};

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** omp 的 baseUrl 不带 /v1(官方指南明示)。 */
export function ompBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, "");
}

/** 由 thinkingLevelMap 推导 omp 的 thinking 等级范围(首个非空等级 ~ 末个非空等级)。 */
function thinkingRange(map?: Partial<Record<string, string | null>>): { minLevel: string; maxLevel: string } | null {
  if (!map) return null;
  const levels = LEVEL_ORDER.filter((l) => typeof map[l] === "string" && (map[l] as string).length > 0);
  if (levels.length === 0) return null;
  return { minLevel: levels[0], maxLevel: levels[levels.length - 1] };
}

/** 渲染单个模型条目;DeepSeek 推理模型带官方 thinking/compat 优化块。 */
function renderModelLines(pad: string, m: ResolvedModel): string[] {
  const out: string[] = [];
  const dsReasoning = isDeepseekModel(m.id) && m.reasoning;
  out.push(`${pad}- id: ${yamlQuote(m.id)}`);
  if (m.name && m.name !== m.id) out.push(`${pad}  name: ${yamlQuote(m.name)}`);
  out.push(`${pad}  reasoning: ${m.reasoning}`);
  if (dsReasoning) {
    const range = thinkingRange(m.thinkingLevelMap) ?? { minLevel: "high", maxLevel: "xhigh" };
    out.push(`${pad}  thinking:`);
    out.push(`${pad}    minLevel: ${range.minLevel}`);
    out.push(`${pad}    maxLevel: ${range.maxLevel}`);
    out.push(`${pad}    mode: effort`);
  }
  out.push(`${pad}  input: [${m.input.includes("image") ? "text, image" : "text"}]`);
  out.push(`${pad}  contextWindow: ${m.contextWindow}`);
  out.push(`${pad}  maxTokens: ${m.maxTokens}`);
  if (dsReasoning) out.push(...renderCompatLines(pad + "  ", m));
  return out;
}

/** DeepSeek 官方完整 compat 块(缺少三关键字段会导致思考模式下工具调用 400)。 */
function renderCompatLines(pad: string, m: ResolvedModel): string[] {
  const map = m.compat?.reasoningEffortMap ?? {};
  const out: string[] = [`${pad}compat:`];
  out.push(`${pad}  supportsDeveloperRole: false`);
  out.push(`${pad}  supportsReasoningEffort: ${m.compat?.supportsReasoningEffort ?? true}`);
  out.push(`${pad}  maxTokensField: max_tokens`);
  const entries = Object.entries(map).filter(([, v]) => typeof v === "string" && v.length > 0);
  if (entries.length > 0) {
    out.push(`${pad}  reasoningEffortMap:`);
    for (const [level, wire] of entries) out.push(`${pad}    ${level}: ${yamlQuote(wire as string)}`);
  }
  out.push(`${pad}  supportsToolChoice: false`);
  out.push(`${pad}  requiresReasoningContentForToolCalls: true`);
  out.push(`${pad}  requiresAssistantContentForToolCalls: true`);
  out.push(`${pad}  extraBody:`);
  out.push(`${pad}    thinking:`);
  out.push(`${pad}      type: enabled`);
  return out;
}

function renderProviderBlock(indent: number, opts: OmpProviderInput): string[] {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  const out = [`${pad}${opts.providerName}:`];
  out.push(`${inner}baseUrl: ${yamlQuote(ompBaseUrl(opts.baseUrl))}`);
  out.push(`${inner}api: openai-completions`);
  out.push(`${inner}apiKey: ${yamlQuote(opts.apiKey)}`);
  out.push(`${inner}authHeader: true`);
  out.push(`${inner}models:`);
  for (const m of opts.models) out.push(...renderModelLines(inner + "  ", m));
  return out;
}

/** 在 ~/.omp/agent/models.yml 中 upsert providers.<name> 段(保留其它 provider)。 */
export function patchOmpModelsYml(text: string, opts: OmpProviderInput): { text: string; changes: string[] } {
  const modelCount = opts.models.length;
  const prov = findKeyInRegion(text, 0, text.length, "providers", 0);
  if (!prov) {
    const block = "providers:\n" + renderProviderBlock(2, opts).join("\n") + "\n";
    const next = (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block;
    return { text: next, changes: [`新建 providers.${opts.providerName}(${modelCount} 个模型)`] };
  }
  if (headerHasInlineContent(text, prov.start, prov.end)) throw new Error("providers: 使用内联样式(flow style),请手动编辑 models.yml");
  const provBodyStart = lineAfter(text, prov.end);
  const provBodyEnd = blockBodyEnd(text, provBodyStart, prov.indent, text.length);

  const provider = findKeyInRegion(text, provBodyStart, provBodyEnd, opts.providerName);
  if (!provider) {
    const block = renderProviderBlock(prov.indent + 2, opts).join("\n") + "\n";
    const next = text.slice(0, provBodyStart) + block + text.slice(provBodyStart);
    return { text: next, changes: [`providers 段新增 ${opts.providerName}(${modelCount} 个模型)`] };
  }
  if (headerHasInlineContent(text, provider.start, provider.end)) throw new Error(`providers.${opts.providerName}: 使用内联样式,请手动编辑 models.yml`);
  const bodyStart = lineAfter(text, provider.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, provider.indent, provBodyEnd);
  const children = renderProviderBlock(provider.indent, opts).slice(1);
  const next = text.slice(0, bodyStart) + children.join("\n") + "\n" + text.slice(bodyEnd);
  return { text: next, changes: next === text ? [] : [`providers.${opts.providerName} 已更新(${modelCount} 个模型)`] };
}

/** 在 ~/.omp/agent/config.yml 中 upsert modelRoles.default。 */
export function patchOmpConfigYml(text: string, providerName: string, defaultModel: string): { text: string; changes: string[] } {
  const role = `${providerName}/${defaultModel}`;
  const mr = findKeyInRegion(text, 0, text.length, "modelRoles", 0);
  if (!mr) {
    const block = `modelRoles:\n  default: ${yamlQuote(role)}\n`;
    const next = (text.trim() ? text.replace(/\s+$/, "") + "\n\n" : "") + block;
    return { text: next, changes: [`新建 modelRoles.default = ${role}`] };
  }
  if (headerHasInlineContent(text, mr.start, mr.end)) throw new Error("modelRoles: 使用内联样式,请手动编辑 config.yml");
  const bodyStart = lineAfter(text, mr.end);
  const bodyEnd = blockBodyEnd(text, bodyStart, mr.indent, text.length);
  const line = `  default: ${yamlQuote(role)}`;
  const def = findKeyInRegion(text, bodyStart, bodyEnd, "default");
  const next = def
    ? text.slice(0, def.start) + line + text.slice(lineAfter(text, def.end))
    : text.slice(0, bodyStart) + line + "\n" + text.slice(bodyStart);
  return { text: next, changes: next === text ? [] : [`modelRoles.default = ${role}`] };
}

// ---------------------------------------------------------------------------
// 状态诊断
// ---------------------------------------------------------------------------

export type OmpStatus = {
  modelsExists: boolean;
  providerConfigured: boolean;
  providerBaseUrl: string | null;
  providerModels: number;
  configExists: boolean;
  defaultRole: string | null;
};

/** 从 models.yml / config.yml 文本解析 omp 状态(纯)。 */
export function parseOmpStatus(modelsText: string, configText: string, providerName: string): OmpStatus {
  let providerBaseUrl: string | null = null;
  let providerModels = 0;
  const prov = findKeyInRegion(modelsText, 0, modelsText.length, "providers", 0);
  if (prov) {
    const provBodyStart = lineAfter(modelsText, prov.end);
    const provBodyEnd = blockBodyEnd(modelsText, provBodyStart, prov.indent, modelsText.length);
    const p = findKeyInRegion(modelsText, provBodyStart, provBodyEnd, providerName);
    if (p) {
      const bodyStart = lineAfter(modelsText, p.end);
      const bodyEnd = blockBodyEnd(modelsText, bodyStart, p.indent, provBodyEnd);
      const body = modelsText.slice(bodyStart, bodyEnd);
      const bm = body.match(/^ *baseUrl: *(.*)$/m);
      providerBaseUrl = bm ? unquoteYaml(bm[1]) : null;
      providerModels = (body.match(/^ *- id:/gm) ?? []).length;
    }
  }
  let defaultRole: string | null = null;
  const mr = findKeyInRegion(configText, 0, configText.length, "modelRoles", 0);
  if (mr) {
    const bodyStart = lineAfter(configText, mr.end);
    const bodyEnd = blockBodyEnd(configText, bodyStart, mr.indent, configText.length);
    const dm = configText.slice(bodyStart, bodyEnd).match(/^ *default: *(.*)$/m);
    defaultRole = dm ? unquoteYaml(dm[1]) : null;
  }
  return {
    modelsExists: modelsText.length > 0,
    providerConfigured: providerBaseUrl !== null,
    providerBaseUrl,
    providerModels,
    configExists: configText.length > 0,
    defaultRole,
  };
}
