// axon-llm-dispenser 前端入口:连接设置 + 工具接入 + 鉴权 + 状态。

import "./styles.css";
import * as bridge from "./bridge";
import * as flows from "./flows";
import { claudeModelSuffix } from "./core/claude";
import { buildResolvedModels } from "./core/models";

const APP_VERSION = "0.1.0";
const GITHUB_REPO = "dncore/axon-llm-dispenser";

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
  ]);

  const modelsCard = h("section", { class: "card models-sidebar" }, [
    h("h2", {}, ["模型目录"]),
    h("div", { class: "row" }, [
      h("button", { id: "btn-fetch", class: "btn" }, ["拉取模型(/models)"]),
      h("span", { id: "model-count", class: "hint" }, []),
    ]),
    h("label", { class: "row toggle" }, [
      h("input", { id: "chk-exclude-doubao", type: "checkbox", checked: "checked" }),
      h("span", {}, ["过滤 Doubao 系模型"]),
    ]),
    h("div", { id: "models-list", class: "models-list" }, [h("div", { class: "log-empty" }, ["点击「拉取模型」获取模型列表"])]),
  ]);

  const toolsCard = h("section", { class: "card" }, [
    h("h2", {}, ["工具接入"]),
    toolCard("claude", "Claude Code", ["配置", "状态", "还原"]),
    toolCard("codex", "Codex", ["配置", "状态", "还原"]),
    toolCard("dsh", "DeepSeek Harness (dsh)", ["配置", "状态", "还原"]),
    toolCard("pi", "pi agent", ["配置", "状态", "还原"]),
    toolCard("reasonix", "Reasonix", ["配置", "状态", "生成 Token", "关闭鉴权", "还原"]),
  ]);

  const outputCard = h("section", { class: "card" }, [
    h("h2", {}, ["输出"]),
    h("div", { id: "output", class: "output" }, [
      h("div", { class: "log-empty" }, ["操作结果会显示在这里"]),
    ]),
  ]);

  root.append(
    h("div", { id: "toast-container", class: "toast-container" }, []),
    h("header", { class: "header" }, [
      h("div", { class: "brand" }, [
        h("h1", {}, ["axon-llm-dispenser"]),
        h("span", { class: "subtitle" }, ["把自有的 OpenAI 兼容网关接入 Codex / Reasonix / dsh / Claude / pi"]),
      ]),
      h("div", { class: "header-actions" }, [
        h("span", { class: "version" }, [`v${APP_VERSION}`]),
        h("button", { id: "btn-update", class: "btn btn-ghost" }, ["检查更新"]),
      ]),
    ]),

    h("main", { class: "main" }, [
      modelsCard,
      h("div", { class: "col" }, [connCard]),
      h("div", { class: "col" }, [toolsCard, outputCard]),
    ]),

    h("footer", { class: "footer" }, [
      h("span", {}, ["配置写入各工具官方配置文件,原文件自动备份;密钥文件 0600。"]),
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
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/><path d="M7 16.5l2-2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
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
  "配置": "config",
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
    h("span", { class: "tool-name" }, [name]),
    h("div", { class: "tool-actions" }, buttons),
  ]);
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

/** 自定义确认弹窗(window.confirm 在 Tauri WebView 下不可用,故自实现)。 */
function confirmDialog(message: string, onOk: () => void): void {
  const overlay = h("div", { class: "modal-overlay" }, []);
  const modal = h("div", { class: "modal modal-sm" }, [
    h("p", { class: "confirm-text" }, [message]),
    h("div", { class: "modal-footer" }, [
      h("button", { class: "btn btn-ghost" }, ["取消"]),
      h("button", { class: "btn" }, ["确认"]),
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
  document.body.append(overlay);
}

/** Claude 模型映射弹窗:为每个角色选模型,按上下文映射表自动加 [1m]/[200k] 后缀。 */
function openClaudeConfigModal(): void {
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

    const roleDefs: { key: "main" | "haiku" | "sonnet" | "opus" | "fable" | "subagent"; label: string }[] = [
      { key: "main", label: "主模型 ANTHROPIC_MODEL" },
      { key: "haiku", label: "Haiku 快速 DEFAULT_HAIKU" },
      { key: "sonnet", label: "Sonnet DEFAULT_SONNET" },
      { key: "opus", label: "Opus DEFAULT_OPUS" },
      { key: "fable", label: "Fable DEFAULT_FABLE" },
      { key: "subagent", label: "子代理 SUBAGENT_MODEL" },
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
      list.append(h("div", { class: "claude-role-row" }, [
        h("span", { class: "claude-role-label" }, [r.label]),
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

/** 还原弹窗:列出所选工具的全部备份,用户点选恢复。 */
function openRestoreModal(tool: string): void {
  void run(`还原(${tool})`, async () => {
    const targets = await flows.getRestoreTargets(tool);
    const backups: { label: string; name: string; path: string; time: string; size: string }[] = [];
    for (const t of targets) {
      for (const b of await flows.listBackups(t.path)) {
        backups.push({
          label: t.label,
          name: b.name,
          path: b.path,
          time: new Date(b.mtimeMs).toLocaleString(),
          size: `${(b.size / 1024).toFixed(1)}KB`,
        });
      }
    }
    if (backups.length === 0) {
      notify(`${tool} 暂无备份(每次配置写入前会自动备份 .bak-*)`, "info");
      return;
    }

    const overlay = h("div", { class: "modal-overlay" }, []);
    const modal = h("div", { class: "modal" }, [
      h("h3", {}, [`还原 - ${tool}`]),
      h("div", { class: "modal-sub" }, [`共 ${backups.length} 个备份,点击选择要恢复的备份`]),
    ]);
    const list = h("div", { class: "modal-list" }, []);
    for (const b of backups) {
      const row = h("button", { class: "modal-row" }, [
        h("span", { class: "modal-label" }, [b.label]),
        h("span", { class: "modal-name" }, [b.name]),
        h("span", { class: "modal-meta" }, [`${b.time} · ${b.size}`]),
      ]);
      row.addEventListener("click", () => {
        // 直接还原(当前文件自动备份 .bak-pre-restore-*,可再从此恢复),弹窗内显示结果
        const targetPath = targets.find((t) => t.label === b.label)?.path ?? "";
        row.disabled = true;
        row.replaceChildren(h("span", { class: "modal-label" }, [b.label]), h("span", { class: "modal-name", id: "restore-progress" }, ["还原中…"]));
        void run("还原", async () => {
          try {
            const r = await flows.restoreBackup(targetPath, b.path);
            list.replaceChildren(
              h("div", { class: "modal-result" }, [
                `✓ 已还原「${b.label}」`,
                h("div", { class: "hint" }, [r.backup ? `当前文件已备份: ${bridge.basenamePath(r.backup)}` : ""]),
              ]),
            );
            notify(`已还原 ${b.label}${r.backup ? `,当前文件已备份 ${bridge.basenamePath(r.backup)}` : ""}`, "info");
            if (tool === "pi") notify("还原后重启 pi 生效", "info");
          } catch (e) {
            row.disabled = false;
            row.replaceChildren(
              h("span", { class: "modal-label" }, [b.label]),
              h("span", { class: "modal-name" }, [b.name]),
              h("span", { class: "modal-meta" }, [`${b.time} · ${b.size}`]),
            );
            notify(`还原失败: ${e}`, "error");
          }
        });
      });
      list.append(row);
    }
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

/** 统一包装异步操作:任何异常都在输出面板可见,不再静默失败。 */
async function run(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    notify(`${label}: ${e}`, "error");
  }
}

function bind(): void {
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
      const s = $("conn-status");
      s.textContent = "连接中…";
      const info = await flows.testConnection(config.baseUrl, config.apiKey);
      let shown = info;
      if (config.excludeDoubao) {
        shown = info.filter((m) => !flows.isDoubaoModel(m.id));
        if (shown.length !== info.length) notify(`已过滤 ${info.length - shown.length} 个 Doubao 模型`, "info");
      }
      setModelRows(shown);
      s.textContent = "连接成功";
      notify(`连接成功,拉取到 ${info.length} 个模型(展示 ${shown.length})`, "info");
    }),
  );

  $("btn-fetch").addEventListener("click", () => $("btn-test").click());


  $("btn-codex-配置").addEventListener("click", () =>
    confirmDialog("将覆盖 Codex 现有配置(config.toml / models.json),原文件会自动备份(.bak-*),确认?", () => {
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
    confirmDialog("将覆盖 Reasonix 现有配置(config.toml / .env),原文件会自动备份(.bak-*),确认?", () => {
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
    confirmDialog("将覆盖 dsh 现有配置(settings.yaml / .credentials.yaml),原文件会自动备份(.bak-*),确认?", () => {
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
    confirmDialog("将覆盖 pi 现有配置(models.json / settings.json),原文件会自动备份(.bak-*),确认?", () => {
      void run("pi 配置", async () => {
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
    run("pi 状态", async () => {
      readFields();
      log(await flows.piStatus(config));
    }),
  );

  $("btn-pi-还原").addEventListener("click", () => openRestoreModal("pi"));

  $("btn-update").addEventListener("click", () =>
    run("检查更新", async () => {
      const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
      if (!resp.ok) return notify("暂未找到发布版本(或仓库尚未公开)", "error");
      const data = (await resp.json()) as { tag_name?: string; html_url?: string };
      const latest = data.tag_name?.replace(/^v/, "") ?? "";
      if (latest && latest !== APP_VERSION) {
        notify(`发现新版本 v${latest},当前 v${APP_VERSION}`);
        if (data.html_url) await bridge.openUrl(data.html_url);
      } else {
        notify(`已是最新版本 v${APP_VERSION}`, "info");
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  // 全局兜底:任何未捕获的异步错误都在输出面板可见
  window.addEventListener("unhandledrejection", (ev) => {
    notify(`未处理的错误: ${ev.reason}`, "error");
  });
  // 弹窗打开时锁定主页面滚动(body.modal-open → overflow:hidden)
  const syncModalLock = (): void => {
    document.body.classList.toggle("modal-open", document.querySelectorAll(".modal-overlay").length > 0);
  };
  new MutationObserver(syncModalLock).observe(document.body, { childList: true });
  build();
  bind();
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
}

void boot();
