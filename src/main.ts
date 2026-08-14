// axon-llm-dispenser 前端入口:连接设置 + 工具接入 + 鉴权 + 状态。

import "./styles.css";
import * as bridge from "./bridge";
import * as flows from "./flows";
import { AGENT_CLIS } from "./core/agents";
import { claudeModelSuffix } from "./core/claude";
import { buildResolvedModels } from "./core/models";


type El = HTMLElement;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

// ---------------------------------------------------------------------------
// 状态与引用
// ---------------------------------------------------------------------------

const $ = (id: string): El => document.getElementById(id)!;

type ModelRow = { id: string; ownedBy?: string };
let modelRows: ModelRow[] = [];

let config: bridge.AppConfig = {
  provider: "axon",
  displayName: "Axon",
  baseUrl: "",
  apiKey: "",
  defaultModel: "",
  anthropicBaseUrl: "",
  excludeDoubao: true,
};

// ---------------------------------------------------------------------------
// 输出面板
// ---------------------------------------------------------------------------

function log(lines: string[], kind: "info" | "error" = "info"): void {
  const out = $("output");
  out.querySelector(".log-empty")?.remove(); // 有日志后隐藏空提示
  const block = h("div", { class: `log-block log-${kind}` });
  for (const line of lines) block.append(h("div", {}, [line]));
  out.prepend(block);
  out.scrollTop = 0;
}

function notify(msg: string, kind: "info" | "error" = "info"): void {
  log([msg], kind);
  showToast(msg, kind);
}

/** 顶部 banner toast:成功(绿)/失败(红),自动消失。 */
function showToast(msg: string, kind: "info" | "error"): void {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = h("div", { class: `toast ${kind === "error" ? "toast-error" : "toast-success"}` }, [msg]);
  container.append(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  window.setTimeout(() => {
    toast.classList.remove("show");
    window.setTimeout(() => toast.remove(), 250);
  }, 3600);
}

// ---------------------------------------------------------------------------
// 构建 UI
// ---------------------------------------------------------------------------

function build(): void {
  const root = $("app");

  const connCard = h("section", { class: "card" }, [
    h("h2", {}, ["连接设置"]),
    h("div", { class: "card-body" }, [
      h("div", { class: "grid2" }, [
        field("Provider 名", "input-provider", "各工具中的路由名(默认 axon)", "axon"),
        field("显示名", "input-display", "配置界面展示名", "Axon"),
      ]),
      field("Base URL", "input-base", "OpenAI 兼容网关地址,如 https://gateway.example/v1", ""),
      field("API Key", "input-key", "网关凭据", "", "password"),
      field("Anthropic 端点(Claude 用,可留空)", "input-anthropic", "留空自动推导:base_url 的 /api/v1 → /api/anthropic", ""),
      h("div", { class: "row" }, [
        h("button", { id: "btn-test", class: "btn" }, ["测试连接"]),
        h("button", { id: "btn-save", class: "btn btn-ghost" }, ["保存配置"]),
        h("span", { id: "conn-status", class: "hint" }, []),
      ]),
    ]),
  ]);

  const modelsCard = h("section", { class: "card models-sidebar" }, [
    h("h2", { class: "models-title" }, [
      "模型目录",
      h("div", { class: "fetch-right" }, [
        h("span", { id: "model-count", class: "hint" }, []),
        h("button", { id: "btn-fetch", class: "btn btn-small btn-icon-only", type: "button", title: "拉取模型(/models)" }, [icon("refresh")]),
      ]),
    ]),
    h("label", { class: "row toggle" }, [
      h("input", { id: "chk-exclude-doubao", type: "checkbox", checked: "checked" }),
      h("span", {}, ["过滤 Doubao 系模型"]),
    ]),
    h("div", { id: "models-list", class: "models-list" }, [h("div", { class: "log-empty" }, ["点击「拉取模型」获取模型列表"])]),
  ]);

  const toolsCard = h("section", { class: "card" }, [
    h("h2", {}, ["工具接入"]),
    h("div", { class: "card-body" }, [
      toolCard("claude", "Claude Code", ["配置", "状态", "还原"]),
      toolCard("codex", "Codex", ["配置", "状态", "还原"]),
      toolCard("dsh", "DeepSeek Harness (dsh)", ["配置", "状态", "还原"]),
      toolCard("pi", "Pi agent", ["配置", "状态", "还原"]),
      toolCard("reasonix", "Reasonix", ["配置", "状态", "生成 Token", "关闭鉴权", "还原"]),
    ]),
  ]);

  root.append(
    h("div", { id: "toast-container", class: "toast-container" }, []),
    h("header", { class: "header" }, [
      h("div", { class: "brand" }, [
        h("h1", {}, ["Axon"]),
        h("span", { class: "subtitle" }, ["把自有的 OpenAI 兼容网关接入 Codex / Reasonix / dsh / Claude / Pi"]),
      ]),
      h("div", { class: "header-actions" }, [
        h("span", { id: "app-version", class: "version" }, ["v…"]),
      ]),
    ]),

    h("main", { class: "main" }, [
      modelsCard,
      h("div", { class: "col" }, [connCard]),
      h("div", { class: "col" }, [toolsCard]),
    ]),

    h("footer", { id: "footer", class: "footer" }, [
      h("div", { id: "footer-handle", class: "footer-handle", title: "拖拽调整高度" }, []),
      h("div", { class: "footer-bar" }, [
        h("span", { class: "footer-title" }, ["输出"]),
        h("button", { id: "btn-expand-log", class: "btn btn-small btn-ghost", type: "button", title: "展开到半个视窗高度" }, ["展开 ▲"]),
      ]),
      h("div", { id: "output", class: "output" }, [
        h("div", { class: "log-empty" }, ["操作结果会显示在这里"]),
      ]),
    ]),
  );
}

function field(label: string, id: string, placeholder: string, value: string, type = "text"): El {
  return h("label", { class: "field" }, [
    h("span", { class: "field-label" }, [label]),
    h("input", { id, class: "input", type, placeholder, value }),
  ]);
}

/** 内联 SVG 图标(Lucide 风格 stroke 图标)。 */
const ICONS: Record<string, string> = {
  config:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  restore:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/><path d="M7 16.5l2-2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  pen: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
};

function icon(name: string): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "2");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.innerHTML = ICONS[name] ?? ICONS.config;
  el.classList.add("btn-icon");
  return el;
}

/** 自定义下拉选择器(替代原生 select,匹配应用视觉)。 */
function customSelect(options: string[], initial: string, onChange: (v: string) => void): { el: El; value: () => string } {
  let current = options.includes(initial) ? initial : options[0] ?? "";
  const valueSpan = h("span", { class: "cselect-value" }, [current]);
  const btn = h("button", { class: "cselect-btn", type: "button" }, [valueSpan, h("span", { class: "cselect-arrow" }, ["▾"])]);
  const filter = h("input", { class: "cselect-filter", type: "text", placeholder: "搜索模型…" });
  const list = h("div", { class: "cselect-list" }, []);
  const popup = h("div", { class: "cselect-popup" }, [filter, list]);
  const wrap = h("div", { class: "cselect" }, [btn, popup]);

  const close = (): void => popup.classList.remove("open");
  const render = (): void => {
    list.replaceChildren();
    const q = filter.value.toLowerCase();
    for (const o of options) {
      if (q && !o.toLowerCase().includes(q)) continue;
      const item = h("button", { class: "cselect-item", type: "button" }, [o]);
      if (o === current) item.classList.add("active");
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        current = o;
        valueSpan.textContent = o;
        close();
        onChange(o);
      });
      list.append(item);
    }
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = popup.classList.toggle("open");
    if (isOpen) {
      const rect = btn.getBoundingClientRect();
      popup.style.top = `${rect.bottom + 4}px`;
      popup.style.left = `${rect.left}px`;
      popup.style.width = `${rect.width}px`;
      popup.style.maxHeight = `${Math.max(120, window.innerHeight - rect.bottom - 16)}px`;
      filter.value = "";
      render();
      filter.focus();
    }
  });
  filter.addEventListener("input", render);
  filter.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", close);
  return { el: wrap, value: () => current };
}

const ACTION_ICONS: Record<string, string> = {
  "配置": "play",
  "状态": "info",
  "还原": "restore",
  "生成 Token": "key",
  "关闭鉴权": "lock",
};
const ACTION_TITLES: Record<string, string> = {
  "配置": "配置(覆盖现有配置,自动备份)",
  "状态": "查看配置状态",
  "还原": "从备份还原",
  "生成 Token": "生成鉴权 Token",
  "关闭鉴权": "关闭鉴权",
};

function toolCard(id: string, name: string, actions: string[]): El {
  const buttons = actions.map((a) =>
    h("button", { class: "btn btn-small btn-icon-only", id: `btn-${id}-${a}`, title: ACTION_TITLES[a] ?? a }, [icon(ACTION_ICONS[a] ?? "config")]),
  );
  return h("div", { class: "tool" }, [
    h("div", { class: "tool-left" }, [
      h("span", { id: `agent-dot-${id}`, class: "agent-dot checking", title: "检测安装中…" }, []),
      h("span", { class: "tool-name" }, [name]),
    ]),
    h("div", { class: "tool-actions" }, buttons),
  ]);
}

/** 启动后异步检测各 agent CLI 安装情况(不阻塞渲染,只更新工具卡片的安装徽标)。 */
async function detectAgents(): Promise<void> {
  for (const [tool, info] of Object.entries(AGENT_CLIS)) {
    const dot = document.getElementById(`agent-dot-${tool}`);
    if (!dot) continue;
    try {
      const p = await flows.detectAgentCli(tool);
      dot.classList.remove("checking");
      if (p) {
        dot.classList.add("installed");
        dot.title = `已检测到 ${info.bin}: ${p}`;
      } else {
        dot.classList.add("missing");
        dot.title = `未检测到 ${info.bin}(已检查 PATH 与常见安装目录)${info.note ? `;${info.note}` : ""}`;
      }
    } catch {
      dot.classList.remove("checking");
      dot.classList.add("missing");
      dot.title = "安装检测失败";
    }
  }
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

function readFields(): void {
  config.provider = ($("input-provider") as HTMLInputElement).value.trim() || "axon";
  config.displayName = ($("input-display") as HTMLInputElement).value.trim() || config.provider;
  config.baseUrl = ($("input-base") as HTMLInputElement).value.trim();
  config.apiKey = ($("input-key") as HTMLInputElement).value.trim();
  config.anthropicBaseUrl = ($("input-anthropic") as HTMLInputElement).value.trim();
  config.excludeDoubao = ($("chk-exclude-doubao") as HTMLInputElement).checked;
}

function readModelIds(): string[] {
  return modelRows.map((r) => r.id);
}

/** 渲染侧边模型列表。 */
function renderModelsList(): void {
  const list = document.getElementById("models-list");
  if (!list) return;
  list.replaceChildren();
  for (const r of modelRows) {
    const row = h("div", { class: "model-row" }, [
      h("span", { class: "model-row-id" }, [r.id]),
      r.ownedBy ? h("span", { class: "model-row-owner" }, [r.ownedBy]) : h("span", { class: "model-row-owner" }, ["—"]),
      h("button", { class: "model-row-del", type: "button", title: "移除" }, ["×"]),
    ]);
    (row.querySelector(".model-row-del") as El).addEventListener("click", () => {
      modelRows = modelRows.filter((m) => m.id !== r.id);
      renderModelsList();
      const c = document.getElementById("model-count");
      if (c) c.textContent = `${modelRows.length} 个模型`;
    });
    list.append(row);
  }
  const c = document.getElementById("model-count");
  if (c) c.textContent = `${modelRows.length} 个模型`;
}

/** 设置模型列表(替换式),并渲染。 */
function setModelRows(rows: ModelRow[]): void {
  modelRows = rows;
  renderModelsList();
}

/** 拉取模型并渲染到侧栏;失败时重置状态并抛出,由调用方 run() 统一报错。 */
async function fetchAndRenderModels(): Promise<void> {
  const s = $("conn-status");
  s.textContent = "连接中…";
  try {
    const info = await flows.testConnection(config.baseUrl, config.apiKey);
    let shown = info;
    if (config.excludeDoubao) {
      shown = info.filter((m) => !flows.isDoubaoModel(m.id));
      if (shown.length !== info.length) notify(`已过滤 ${info.length - shown.length} 个 Doubao 模型`, "info");
    }
    setModelRows(shown);
    s.textContent = "连接成功";
    notify(`连接成功,拉取到 ${info.length} 个模型(展示 ${shown.length})`, "info");
  } catch (e) {
    s.textContent = "";
    throw e;
  }
}

function validateProvider(): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.provider)) {
    notify("Provider 名只能包含 A-Za-z0-9 . _ -,且不能以符号开头", "error");
    return false;
  }
  if (!config.baseUrl) {
    notify("请先填写 Base URL", "error");
    return false;
  }
  if (!config.apiKey) {
    notify("请先填写 API Key", "error");
    return false;
  }
  return true;
}

async function ensureModels(): Promise<string[] | null> {
  let ids = readModelIds();
  if (ids.length === 0) {
    // 未拉取模型时自动拉取,再开始配置
    if (!config.baseUrl) {
      notify("请先填写 Base URL", "error");
      return null;
    }
    try {
      const info = await flows.testConnection(config.baseUrl, config.apiKey);
      setModelRows(info);
      ids = readModelIds();
    } catch (e) {
      notify(`自动拉取模型失败: ${e}`, "error");
      return null;
    }
  }
  if (config.excludeDoubao) {
    const before = ids.length;
    ids = flows.filterDoubao(ids, true);
    if (ids.length !== before) notify(`已过滤 ${before - ids.length} 个 Doubao 模型`, "info");
  }
  if (ids.length === 0) {
    notify("过滤后模型列表为空,请取消「过滤 Doubao」或添加其它模型", "error");
    return null;
  }
  return ids;
}

let tipEl: El | null = null;

/** JS tooltip:fixed 定位逃逸弹窗 overflow:hidden,自动贴边。 */
function showTip(target: El, text: string): void {
  hideTip();
  const el = h("div", { class: "tip-popup" }, [text]);
  document.body.append(el);
  const r = target.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  // 默认显示在图标上方,视口顶部放不下时放下方
  let top = r.top - er.height - 6;
  if (top < 8) top = r.bottom + 6;
  el.style.top = `${top}px`;
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.transform = "translateX(-50%)";
  const fr = el.getBoundingClientRect();
  if (fr.left < 8) el.style.left = "8px";
  else if (fr.right > window.innerWidth - 8) el.style.left = `${window.innerWidth - fr.width - 8}px`;
  tipEl = el;
}

function hideTip(): void {
  tipEl?.remove();
  tipEl = null;
}

/** 清理所有残留弹窗(自愈:避免旧 overlay 堆积导致假卡死)。 *//** 清理所有残留弹窗(自愈:避免旧 overlay 堆积导致假卡死)。 */
function clearOverlays(): void {
  document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
}

/** 自定义确认弹窗(window.confirm 在 Tauri WebView 下不可用,故自实现)。
 * 不清除已有弹窗:允许叠加在还原弹窗等上层做二次确认(ESC 只关最上层)。 */
function confirmDialog(message: string, onOk: () => void, okLabel = "确认", cancelLabel = "取消"): void {
  const overlay = h("div", { class: "modal-overlay" }, []);
  const modal = h("div", { class: "modal modal-sm" }, [
    h("p", { class: "confirm-text" }, [message]),
    h("div", { class: "modal-footer" }, [
      h("button", { class: "btn btn-ghost" }, [cancelLabel]),
      h("button", { class: "btn" }, [okLabel]),
    ]),
  ]);
  const [cancel, ok] = modal.querySelectorAll("button");
  const close = (): void => overlay.remove();
  cancel.addEventListener("click", close);
  ok.addEventListener("click", () => {
    close();
    onOk();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.append(modal);
  document.body.append(overlay);
}

/** Claude 模型映射弹窗:为每个角色选模型,按上下文映射表自动加 [1m]/[200k] 后缀。 */
function openClaudeConfigModal(): void {
  clearOverlays();
  void run("Claude 模型选择", async () => {
    readFields();
    if (!validateProvider()) return;
    let ids = readModelIds();
    if (ids.length === 0) {
      if (!config.baseUrl) {
        notify("请先填写 Base URL", "error");
        return;
      }
      try {
        const info = await flows.testConnection(config.baseUrl, config.apiKey);
        setModelRows(info);
        ids = readModelIds();
      } catch (e) {
        notify(`自动拉取模型失败: ${e}`, "error");
        return;
      }
    }
    if (config.excludeDoubao) ids = flows.filterDoubao(ids, true);
    if (ids.length === 0) {
      notify("模型列表为空(已过滤 Doubao),无法配置 Claude", "error");
      return;
    }
    ids.sort((a, b) => a.localeCompare(b));

    // 默认值:优先取当前 ~/.claude/settings.json 的配置(去掉 [1m]/[200k] 后缀),
    // 不在模型列表内或未配置时退回常用默认
    const def = config.defaultModel && ids.includes(config.defaultModel)
      ? config.defaultModel
      : ids.includes("deepseek-v4-flash")
        ? "deepseek-v4-flash"
        : ids[0];
    const current = await flows.getClaudeCurrentRoles();
    const pickDefault = (key: "main" | "haiku" | "sonnet" | "opus" | "fable" | "subagent"): string => {
      const cur = current?.[key] ?? "";
      return cur && ids.includes(cur) ? cur : def;
    };

    const roleDefs: { key: "main" | "haiku" | "sonnet" | "opus" | "fable" | "subagent"; env: string; desc: string }[] = [
      { key: "main", env: "ANTHROPIC_MODEL", desc: "主模型:默认会话使用的模型" },
      { key: "haiku", env: "ANTHROPIC_DEFAULT_HAIKU_MODEL", desc: "Haiku 快速模型:后台任务 / 轻量调用" },
      { key: "sonnet", env: "ANTHROPIC_DEFAULT_SONNET_MODEL", desc: "Sonnet 模型:日常任务" },
      { key: "opus", env: "ANTHROPIC_DEFAULT_OPUS_MODEL", desc: "Opus 模型:复杂任务" },
      { key: "fable", env: "ANTHROPIC_DEFAULT_FABLE_MODEL", desc: "Fable 模型" },
      { key: "subagent", env: "CLAUDE_CODE_SUBAGENT_MODEL", desc: "子代理使用的模型" },
    ];
    const selects: Record<string, { value: () => string }> = {};

    const overlay = h("div", { class: "modal-overlay" }, []);
    const modal = h("div", { class: "modal" }, [
      h("h3", {}, ["Claude 模型映射"]),
      h("div", { class: "modal-sub" }, ["为每个角色选择模型;按上下文映射表自动加 [1m]/[200k] 后缀"]),
    ]);
    const list = h("div", { class: "modal-list" }, []);
    for (const r of roleDefs) {
      const preview = h("span", { class: "claude-preview" }, []);
      const updatePreview = (v: string): void => {
        const cw = buildResolvedModels([v])[0]?.contextWindow ?? 0;
        const suffix = claudeModelSuffix(cw);
        preview.textContent = suffix ? `[${suffix}]` : "";
      };
      const sel = customSelect(ids, pickDefault(r.key), updatePreview);
      selects[r.key] = sel;
      updatePreview(sel.value());
      const tip = h("span", { class: "claude-tip" }, ["?"]);
      tip.addEventListener("mouseenter", () => showTip(tip, r.desc));
      tip.addEventListener("mouseleave", hideTip);
      list.append(h("div", { class: "claude-role-row" }, [
        h("span", { class: "claude-role-label" }, [r.env, tip]),
        sel.el,
        preview,
      ]));
    }
    modal.append(list);
    const ok = h("button", { class: "btn" }, ["生成配置"]);
    const cancel = h("button", { class: "btn btn-ghost" }, ["取消"]);
    cancel.addEventListener("click", () => overlay.remove());
    ok.addEventListener("click", () => {
      overlay.remove();
      void run("Claude 配置", async () => {
        const r = await flows.configureClaude(config, {
          main: selects.main.value(),
          haiku: selects.haiku.value(),
          sonnet: selects.sonnet.value(),
          opus: selects.opus.value(),
          fable: selects.fable.value(),
          subagent: selects.subagent.value(),
        });
        log(r.lines);
      });
    });
    modal.append(h("div", { class: "modal-footer" }, [cancel, ok]));
    overlay.append(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.append(overlay);
  });
}

/** 还原弹窗:列出所选工具的全部备份,支持应用(▶)/重命名(✎)/删除(🗑)/查看编辑。 */
function openRestoreModal(tool: string): void {
  clearOverlays();
  const toolName = tool === "pi" ? "Pi" : tool; // pi 显示名首字母大写
  void run(`还原(${toolName})`, async () => {
    const targets = await flows.getRestoreTargets(tool);
    const collect = async (): Promise<BackupRow[]> => {
      const out: BackupRow[] = [];
      for (const t of targets) {
        for (const b of await flows.listBackups(t.path)) {
          out.push({
            label: t.label,
            targetPath: t.path,
            base: bridge.basenamePath(t.path),
            name: b.name,
            path: b.path,
            time: new Date(b.mtimeMs).toLocaleString(),
            size: `${(b.size / 1024).toFixed(1)}KB`,
          });
        }
      }
      return out;
    };
    let rows = await collect();
    if (rows.length === 0) {
      notify(`${tool} 暂无备份(每次配置写入前会自动备份 .bak-*)`, "info");
      return;
    }

    const overlay = h("div", { class: "modal-overlay" }, []);
    const modal = h("div", { class: "modal" }, [
      h("h3", {}, [`还原 - ${toolName}`]),
      h("div", { class: "modal-sub" }, [`共 ${rows.length} 个备份。点击条目查看/编辑配置;▶ 应用、✎ 重命名、🗑 删除`]),
    ]);
    const list = h("div", { class: "modal-list" }, []);

    /** 应用备份后弹窗内联显示结果。 */
    const showResult = (label: string, backup?: string): void => {
      list.replaceChildren(
        h("div", { class: "modal-result" }, [
          `✓ 已还原「${label}」`,
          h("div", { class: "hint" }, [backup ? `当前文件已备份: ${bridge.basenamePath(backup)}` : ""]),
        ]),
      );
    };
    /** 播放按钮:二次确认后应用备份。 */
    const applyRow = (b: BackupRow): void => {
      confirmDialog(`将用备份「${b.name}」覆盖「${b.label}」?当前配置会先备份为 .bak-pre-restore-*,确认?`, () => {
        void run("还原", async () => {
          const r = await flows.restoreBackup(b.targetPath, b.path);
          showResult(b.label, r.backup);
          notify(`已还原 ${b.label}${r.backup ? `,当前文件已备份 ${bridge.basenamePath(r.backup)}` : ""}`, "info");
          if (tool === "pi") notify("还原后重启 Pi 生效", "info");
        });
      });
    };
    /** 重命名/删除/编辑保存后重新拉取列表,保证名称/大小/时间准确。 */
    const refresh = async (): Promise<void> => {
      rows = await collect();
      render();
    };
    const render = (): void => {
      list.replaceChildren();
      for (const b of rows) {
        const main = h("button", { class: "modal-row-main", type: "button" }, [
          h("span", { class: "modal-label" }, [b.label]),
          h("span", { class: "modal-name" }, [b.name]),
          h("span", { class: "modal-meta" }, [`${b.time} · ${b.size}`]),
        ]);
        main.addEventListener("click", () => openBackupEditor(b, () => void refresh()));
        const play = h("button", { class: "backup-action-btn", type: "button", title: "应用此备份" }, [icon("play")]);
        play.addEventListener("click", () => applyRow(b));
        const rename = h("button", { class: "backup-action-btn", type: "button", title: "重命名" }, [icon("pen")]);
        rename.addEventListener("click", () => openRenameModal(b, () => void refresh()));
        const del = h("button", { class: "backup-action-btn danger", type: "button", title: "删除" }, [icon("trash")]);
        del.addEventListener("click", () =>
          confirmDialog(`确定删除备份「${b.name}」?删除后不可恢复。`, () => {
            void run("删除备份", async () => {
              await bridge.deleteFile(b.path);
              notify(`已删除 ${b.name}`, "info");
              await refresh();
            });
          }),
        );
        list.append(h("div", { class: "modal-row" }, [main, h("div", { class: "backup-actions" }, [play, rename, del])]));
      }
    };
    render();
    modal.append(list);
    const close = h("button", { class: "btn btn-ghost", id: "modal-close" }, ["关闭"]);
    close.addEventListener("click", () => overlay.remove());
    modal.append(h("div", { class: "modal-footer" }, [close]));
    overlay.append(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.append(overlay);
  });
}

type BackupRow = { label: string; targetPath: string; base: string; name: string; path: string; time: string; size: string };

/** 查看/编辑备份内容:保存(校验格式)写回备份文件,应用(校验格式)还原到当前配置。 */
function openBackupEditor(b: BackupRow, onDone: () => void): void {
  const overlay = h("div", { class: "modal-overlay" }, []);
  const ta = h("textarea", { class: "backup-editor", spellcheck: "false" }, []);
  const modal = h("div", { class: "modal" }, [
    h("h3", {}, [`查看/编辑 - ${b.name}`]),
    h("div", { class: "modal-sub" }, [`${b.label} · 保存写回备份文件,应用还原到当前配置(均校验格式)`]),
    ta,
  ]);
  const cancel = h("button", { class: "btn btn-ghost" }, ["取消"]);
  const save = h("button", { class: "btn" }, ["保存"]);
  const apply = h("button", { class: "btn" }, ["应用"]);
  cancel.addEventListener("click", () => overlay.remove());
  // 格式错误时 validateConfig 抛错 → run() toast 提示,弹窗保持打开(编辑状态不丢失)
  save.addEventListener("click", () =>
    void run("保存备份", async () => {
      await bridge.validateConfig(b.path, ta.value);
      await bridge.writeFile(b.path, ta.value);
      notify(`已保存 ${b.name}`, "info");
      overlay.remove();
      onDone();
    }),
  );
  apply.addEventListener("click", () =>
    confirmDialog(`将当前编辑内容应用到「${b.label}」?当前配置会先备份为 .bak-pre-restore-*,确认?`, () => {
      void run("应用备份", async () => {
        await bridge.validateConfig(b.path, ta.value);
        const r = await flows.applyBackupContent(b.targetPath, ta.value);
        notify(`已还原 ${b.label}${r.backup ? `,当前文件已备份 ${bridge.basenamePath(r.backup)}` : ""}`, "info");
        overlay.remove();
        onDone();
      });
    }),
  );
  modal.append(h("div", { class: "modal-footer" }, [cancel, save, apply]));
  overlay.append(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
  void run("读取备份", async () => {
    ta.value = await bridge.readFile(b.path);
  });
}

/** 重命名备份弹窗:校验名称(保留 .bak- 前缀、不含路径分隔符、不与现有文件冲突)。 */
function openRenameModal(b: BackupRow, onDone: () => void): void {
  const overlay = h("div", { class: "modal-overlay" }, []);
  const input = h("input", { class: "input", type: "text", placeholder: "新的文件名" }, []);
  input.value = b.name;
  const modal = h("div", { class: "modal modal-sm" }, [
    h("h3", {}, ["重命名备份"]),
    h("div", { class: "modal-sub" }, [`文件名需以 ${b.base}.bak- 开头,否则不会出现在备份列表`]),
    input,
  ]);
  const cancel = h("button", { class: "btn btn-ghost" }, ["取消"]);
  const ok = h("button", { class: "btn" }, ["确认"]);
  // 校验失败 throw → run() toast 提示,弹窗保持打开
  const submit = (): void =>
    void run("重命名", async () => {
      const name = input.value.trim();
      if (!name) throw new Error("名称不能为空");
      if (/[/\\]/.test(name)) throw new Error("名称不能包含路径分隔符");
      if (!name.startsWith(`${b.base}.bak-`)) throw new Error(`名称需以 ${b.base}.bak- 开头`);
      await flows.renameBackup(b.path, name);
      notify(`已重命名为 ${name}`, "info");
      overlay.remove();
      onDone();
    });
  cancel.addEventListener("click", () => overlay.remove());
  ok.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  modal.append(h("div", { class: "modal-footer" }, [cancel, ok]));
  overlay.append(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
}

/** 统一包装异步操作:任何异常都在输出面板可见,不再静默失败。 */
async function run(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    notify(`${label}: ${e}`, "error");
  }
}

// ---------------------------------------------------------------------------
// 底部日志面板:默认 3 行高,展开按钮切到半屏,上边缘拖拽调整高度
// ---------------------------------------------------------------------------

let FOOTER_MIN = 128; // 兜底默认值;启动时按日志区实际行高重算

function setFooterHeight(h: number): void {
  const footer = $("footer");
  const max = Math.max(FOOTER_MIN, window.innerHeight - 120); // 预留 header 与主区域
  footer.style.height = `${Math.min(Math.max(h, FOOTER_MIN), max)}px`;
  syncExpandBtn();
}

function syncExpandBtn(): void {
  const expanded = $("footer").offsetHeight > FOOTER_MIN + 20;
  $("btn-expand-log").textContent = expanded ? "收起 ▼" : "展开 ▲";
}

/** 按日志块实际高度计算最小高度(3 条日志),避免跨平台字体/padding 差异。 */
function initFooterMin(): void {
  const footer = $("footer");
  const out = $("output");
  const overhead = footer.offsetHeight - out.clientHeight; // 拖拽条 + 标题栏 + 边距
  const probe = h("div", { class: "log-block" }, ["行"]); // 探针块:实测一条日志的实际高度
  out.append(probe);
  const rowH = probe.offsetHeight;
  probe.remove();
  FOOTER_MIN = overhead + 16 + 3 * rowH + 4; // 16 = 日志区上下 padding,+4 缓冲
  setFooterHeight(FOOTER_MIN);
}

function bind(): void {
  // 底部日志面板:展开/收起、拖拽调高、窗口缩放时重新夹紧
  initFooterMin();
  $("btn-expand-log").addEventListener("click", () => {
    const expanded = $("footer").offsetHeight > FOOTER_MIN + 20;
    setFooterHeight(expanded ? FOOTER_MIN : Math.floor(window.innerHeight / 2));
  });
  window.addEventListener("resize", () => setFooterHeight($("footer").offsetHeight));
  $("footer-handle").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = $("footer").offsetHeight;
    document.body.classList.add("footer-dragging");
    const move = (ev: PointerEvent): void => setFooterHeight(startH + startY - ev.clientY);
    const stop = (): void => {
      document.body.classList.remove("footer-dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });

  $("btn-save").addEventListener("click", () =>
    run("保存配置", async () => {
      readFields();
      if (!config.baseUrl && !config.apiKey) {
        notify("Base URL 与 API Key 为空,未保存", "error");
        return;
      }
      const path = await bridge.saveAppConfig(config);
      notify(`配置已保存: ${path}`);
    }),
  );

  $("btn-test").addEventListener("click", () =>
    run("测试连接", async () => {
      readFields();
      if (!config.baseUrl) {
        notify("请先填写 Base URL", "error");
        return;
      }
      await fetchAndRenderModels();
    }),
  );

  $("btn-fetch").addEventListener("click", () => $("btn-test").click());


  $("btn-codex-配置").addEventListener("click", () =>
    confirmDialog("将更新 Codex 的接入配置:写入 config.toml / models.json 中 provider/鉴权与模型相关字段,保留其它设置;原文件自动备份(.bak-*),确认?", () => {
      void run("Codex 配置", async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        const r = await flows.configureCodex(config, ids);
        log(r.lines);
      });
    }),
  );

  $("btn-codex-状态").addEventListener("click", () =>
    run("Codex 状态", async () => {
      log(await flows.codexStatus());
    }),
  );

  $("btn-codex-还原").addEventListener("click", () => openRestoreModal("codex"));

  $("btn-reasonix-配置").addEventListener("click", () =>
    confirmDialog("将更新 Reasonix 的接入配置:写入 config.toml / .env 中 provider/鉴权与模型相关字段,保留其它设置;原文件自动备份(.bak-*),确认?", () => {
      void run("Reasonix 配置", async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        const r = await flows.configureReasonix(config, ids);
        log(r.lines);
      });
    }),
  );

  $("btn-reasonix-状态").addEventListener("click", () =>
    run("Reasonix 状态", async () => {
      readFields();
      log(await flows.reasonixStatus(config));
    }),
  );

  $("btn-reasonix-还原").addEventListener("click", () => openRestoreModal("reasonix"));

  $("btn-reasonix-生成 Token").addEventListener("click", () =>
    confirmDialog("将生成新的固定鉴权 Token 并写入 Reasonix [serve] 段(覆盖旧 Token,原文件自动备份),确认?", () => {
      void run("生成 Token", async () => {
        const r = await flows.generateReasonixAuth();
        log(r.lines);
      });
    }),
  );

  $("btn-reasonix-关闭鉴权").addEventListener("click", () =>
    confirmDialog("将 Reasonix 鉴权改回 auth_mode=none 并移除 token,确认?", () => {
      void run("关闭鉴权", async () => {
        const r = await flows.disableReasonixAuth();
        log(r.lines);
      });
    }),
  );

  $("btn-dsh-配置").addEventListener("click", () =>
    confirmDialog("将更新 dsh 的接入配置:写入 settings.yaml / .credentials.yaml 中 provider/鉴权与模型相关字段,保留其它设置;原文件自动备份(.bak-*),确认?", () => {
      void run("dsh 配置", async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        const r = await flows.configureDsh(config, ids);
        log(r.lines);
      });
    }),
  );

  $("btn-dsh-状态").addEventListener("click", () =>
    run("dsh 状态", async () => {
      readFields();
      log(await flows.dshStatus(config));
    }),
  );

  $("btn-dsh-还原").addEventListener("click", () => openRestoreModal("dsh"));

  $("btn-claude-配置").addEventListener("click", () => openClaudeConfigModal());

  $("btn-claude-状态").addEventListener("click", () =>
    run("Claude 状态", async () => {
      log(await flows.claudeStatus());
    }),
  );

  $("btn-claude-还原").addEventListener("click", () => openRestoreModal("claude"));

  $("btn-pi-配置").addEventListener("click", () =>
    confirmDialog("将更新 Pi 的接入配置:写入 models.json / settings.json 中 provider/鉴权与模型相关字段,保留其它设置;原文件自动备份(.bak-*),确认?", () => {
      void run("Pi 配置", async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        const r = await flows.configurePi(config, ids);
        log(r.lines);
      });
    }),
  );

  $("btn-pi-状态").addEventListener("click", () =>
    run("Pi 状态", async () => {
      readFields();
      log(await flows.piStatus(config));
    }),
  );

  $("btn-pi-还原").addEventListener("click", () => openRestoreModal("pi"));
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  // 全局兜底:任何未捕获的异步错误都在输出面板可见
  window.addEventListener("unhandledrejection", (ev) => {
    notify(`未处理的错误: ${ev.reason}`, "error");
  });
  // 关闭 webview 右键默认菜单(Reload/返回等)
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  // ESC 只关闭最上层弹窗(确认/编辑弹窗叠加在还原弹窗上时逐层退出)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const overlays = document.querySelectorAll(".modal-overlay");
      overlays[overlays.length - 1]?.remove();
    }
  });
  // 全局 JS 错误显示为 toast(暴露隐藏错误)
  window.addEventListener("error", (ev) => notify(`页面错误: ${ev.message}`, "error"));
  // 弹窗打开时锁定主页面滚动(body.modal-open → overflow:hidden)
  const syncModalLock = (): void => {
    document.body.classList.toggle("modal-open", document.querySelectorAll(".modal-overlay").length > 0);
  };
  new MutationObserver(syncModalLock).observe(document.body, { childList: true });
  build();
  bind();
  // 启动后异步检测各 agent CLI 安装情况(徽标)
  void detectAgents();
  // 版本号跟随应用版本(发版时由 CI 写入 tauri.conf.json,显示即 tag 版本)
  try {
    const vEl = document.getElementById("app-version");
    if (vEl) vEl.textContent = `v${await bridge.appVersion()}`;
  } catch {
    // 忽略:版本获取失败时保留占位
  }
  try {
    config = await bridge.loadAppConfig();
    ($("input-provider") as HTMLInputElement).value = config.provider;
    ($("input-display") as HTMLInputElement).value = config.displayName;
    ($("input-base") as HTMLInputElement).value = config.baseUrl;
    ($("input-key") as HTMLInputElement).value = config.apiKey;
    ($("input-anthropic") as HTMLInputElement).value = config.anthropicBaseUrl;
    ($("chk-exclude-doubao") as HTMLInputElement).checked = config.excludeDoubao;
  } catch {
    // 使用默认配置
  }
  // 首次打开:有上次保存的 Base URL 与 API Key 时自动拉取模型列表
  if (config.baseUrl && config.apiKey) {
    void run("自动拉取模型", fetchAndRenderModels);
  }
}

void boot();
