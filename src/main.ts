// axon-llm-dispenser 前端入口:连接设置 + 工具接入 + 鉴权 + 状态。

import "./styles.css";
import * as bridge from "./bridge";
import * as appcfg from "./core/appconfig";
import * as flows from "./flows";
import { AGENT_CLIS } from "./core/agents";
import { BACKUP_KEEP_AUTO } from "./core/backup";
import { claudeModelSuffix } from "./core/claude";
import { buildResolvedModels, gatewayThinkingDisabled, isKnownModel } from "./core/models";
import { CODX_MAX_LISTED_MODELS, CODX_PROXY_CONVERT_PATTERN, CODX_PROXY_DEFAULT_PORT } from "./core/codex";
import { fallbackAutostartChecked } from "./core/autostart";
// 开机自启(macOS LaunchAgent / Windows 注册表),状态由系统侧查询,不入 AppConfig。
import { enable as autostartEnable, disable as autostartDisable, isEnabled as autostartIsEnabled } from "@tauri-apps/plugin-autostart";


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

// 多 Provider:顶层字段始终是「当前激活 profile」的视图(见 core/appconfig.ts)
let config: bridge.AppConfig = appcfg.cloneConfig(bridge.DEFAULT_CONFIG);

/** 工具卡片显示名(一键切换/应用到已接入工具时的确认与日志用)。 */
const TOOL_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  dsh: "DeepSeek Harness (dsh)",
  pi: "Pi agent",
  omp: "Oh My Pi",
  reasonix: "Reasonix",
  opencode: "OpenCode",
  grok: "Grok",
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
    h("h2", { class: "conn-title" }, [
      "连接设置",
      h("span", { id: "conn-status", class: "conn-status-dot status-idle", title: "未测试连接" }, []),
    ]),
    h("div", { class: "card-body" }, [
      providerBar(),
      h("div", { class: "grid2" }, [
        field("Provider 名", "input-provider", "各工具中的路由名(默认 axon)", "axon"),
        field("显示名", "input-display", "配置界面展示名", "Axon"),
      ]),
      field("Base URL", "input-base", "OpenAI 兼容网关地址,如 https://gateway.example/v1", ""),
      field("API Key", "input-key", "网关凭据", "", "password", true),
      field("Anthropic 端点(Claude 用,可留空)", "input-anthropic", "留空自动推导:base_url 的 /api/v1 → /api/anthropic", ""),
      h("div", { class: "row" }, [
        h("button", { id: "btn-test", class: "btn" }, ["测试连接"]),
        h("button", { id: "btn-save", class: "btn btn-ghost" }, ["保存配置"]),
        h("button", { id: "btn-del-config", class: "btn btn-danger", type: "button" }, ["删除配置"]),
      ]),
    ]),
  ]);

  const modelsCard = h("section", { class: "card models-sidebar card-lockable" }, [
    h("h2", { class: "models-title" }, [
      "模型列表",
      h("div", { class: "fetch-right" }, [
        h("span", { id: "model-count", class: "hint" }, []),
        h("button", { id: "btn-fetch", class: "btn btn-small btn-icon-only", type: "button", title: "拉取模型(/models)" }, [icon("refresh")]),
      ]),
    ]),
    h("label", { class: "row toggle" }, [
      h("input", { id: "chk-exclude-doubao", type: "checkbox", checked: "checked" }),
      h("span", {}, ["过滤 Doubao 系模型"]),
    ]),
    h("div", { id: "models-list", class: "models-list" }, [h("div", { class: "log-empty" }, ["填写网关后点 ↻ 拉取模型列表"])]),
    h("div", { class: "card-overlay" }, []),
  ]);

  const toolsCard = h("section", { class: "card card-lockable" }, [
    h("h2", { class: "tools-title" }, [
      "工具接入",
      h("div", { class: "tools-title-right" }, [
        h("button", { id: "btn-refresh-all-models", class: "btn btn-small btn-icon-only", type: "button", title: "刷新全部模型列表(仅更新各 Agent 的模型条目,不改 base_url / 密钥 / 默认模型)" }, [icon("refresh")]),
        h("button", { id: "btn-upgrade-all", class: "btn btn-upgrade-all", type: "button", title: "升级全部" }, [icon("arrow-up")]),
        helpTipIcon(),
      ]),
    ]),
    h("div", { class: "card-body" }, [
      toolCard("claude", "Claude Code", ["配置", "状态", "还原"]),
      toolCard("codex", "Codex", ["配置", "刷新模型", "选模型", "状态", "还原"]),
      toolCard("dsh", "DeepSeek Harness (dsh)", ["配置", "刷新模型", "状态", "还原"]),
      toolCard("pi", "Pi agent", ["配置", "状态", "还原"]),
      toolCard("omp", "Oh My Pi", ["配置", "刷新模型", "状态", "还原"]),
      toolCard("reasonix", "Reasonix", ["配置", "刷新模型", "状态", "生成 Token", "关闭鉴权", "还原"]),
      toolCard("opencode", "OpenCode", ["配置", "刷新模型", "状态", "还原"]),
      toolCard("grok", "Grok", ["配置", "刷新模型", "状态", "还原"]),
    ]),
    h("div", { class: "card-overlay" }, []),
  ]);

  root.append(
    h("div", { id: "toast-container", class: "toast-container" }, []),
    h("header", { class: "header" }, [
      h("div", { class: "brand" }, [
        h("img", { class: "brand-icon", src: "/app-icon.png", alt: "Axon" }),
        h("div", { class: "brand-text" }, [
          h("div", { class: "brand-title" }, [
            h("h1", {}, ["Axon"]),
            h("span", { id: "app-version", class: "version" }, ["v…"]),
          ]),
          h("span", { class: "subtitle" }, ["把自有的 OpenAI 兼容网关配置到各 Agent 工具"]),
        ]),
      ]),
      proxyWidget(),
    ]),

    h("div", { id: "guide-banner", class: "guide-banner" }, [
      h("span", { class: "guide-text" }, []),
      h("button", { id: "guide-close", class: "guide-close", type: "button", title: "关闭引导" }, ["×"]),
    ]),

    h("main", { class: "main" }, [
      modelsCard,
      h("div", { class: "col" }, [connCard]),
      h("div", { class: "col" }, [toolsCard]),
    ]),

    h("footer", { id: "footer", class: "footer" }, [
      h("div", { id: "footer-handle", class: "footer-handle", title: "拖拽调整高度" }, [
        h("button", { id: "btn-expand-log", class: "btn-expand", type: "button", title: "展开日志面板" }, [icon("chevron-up")]),
      ]),
      h("div", { id: "output", class: "output" }, [
        h("div", { class: "log-empty" }, ["操作过程与结果会显示在这里"]),
      ]),
    ]),
  );
}

function field(label: string, id: string, placeholder: string, value: string, type = "text", reveal = false): El {
  const input = h("input", { id, class: "input", type, placeholder, value });
  if (!reveal) {
    return h("label", { class: "field" }, [
      h("span", { class: "field-label" }, [label]),
      input,
    ]);
  }
  // reveal=true(密码字段):输入框右侧加眼睛按钮,点击切换明文/密文
  const eye = h("button", { class: "input-eye", type: "button", title: "显示 API Key" }, [icon("eye")]);
  eye.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.replaceChildren(icon(show ? "eye-off" : "eye"));
    eye.title = show ? "隐藏 API Key" : "显示 API Key";
    eye.classList.toggle("active", show);
  });
  return h("label", { class: "field" }, [
    h("span", { class: "field-label" }, [label]),
    h("div", { class: "input-wrap" }, [input, eye]),
  ]);
}

// ---------------------------------------------------------------------------
// 多 Provider 配置:保存多套网关(baseUrl/key/模型列表各自独立),一键切换并写入已接入工具
// ---------------------------------------------------------------------------

/** 下拉选项(引用共享:customSelect 每次展开时按当前内容渲染,profile 增删后无需重建控件)。 */
const providerOptions: string[] = [];
const providerLabels: string[] = [];
let providerSelect: { el: El; value: () => string; set: (v: string) => void } | null = null;

/** profile 下拉显示名:名称 + 网关主机(便于区分同名/同 provider 路由的多套配置)。 */
function providerLabel(p: appcfg.ProviderProfile): string {
  const host = hostOf(p.baseUrl);
  return `${p.displayName || p.provider}${host ? ` · ${host}` : ""}`;
}

function hostOf(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

/** 把当前 profiles 灌进下拉选项并同步当前选中项。 */
function renderProviderSelect(): void {
  providerOptions.length = 0;
  providerLabels.length = 0;
  for (const p of config.profiles) {
    providerOptions.push(p.id);
    providerLabels.push(providerLabel(p));
  }
  providerSelect?.set(config.activeProfileId);
}

/** 连接设置卡片顶部的 Provider 切换条:选择即切换(载入表单 + 可选写入已接入工具)。 */
function providerBar(): El {
  providerSelect = customSelect(providerOptions, config.activeProfileId, (id) => void switchProvider(id), {
    labels: providerLabels,
    filterPlaceholder: "搜索 Provider…",
  });
  const add = h("button", { id: "btn-provider-add", class: "btn btn-small", type: "button", title: "新建 Provider 配置(以当前表单的 Provider 名 / Anthropic 端点为模板)" }, ["＋ 新建"]);
  const del = h("button", { id: "btn-provider-del", class: "btn btn-small btn-danger", type: "button", title: "删除当前 Provider 配置(仅本 app 内保存的配置,各工具已写入的不受影响)" }, [icon("trash")]);
  const apply = h("button", { id: "btn-provider-apply", class: "btn btn-small", type: "button", title: "把当前 Provider 应用到所有「已接入」的工具" }, ["应用到已接入工具"]);
  return h("div", { class: "provider-bar" }, [
    h("span", { class: "field-label" }, ["Provider 配置"]),
    providerSelect.el,
    add,
    del,
    h("span", { class: "provider-bar-gap" }, []),
    apply,
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
  package:
    '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="m7.5 4.3 9 5.2"/>',
  sliders:
    '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "arrow-up": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  "eye-off":
    '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
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

/** 状态徽标图标(安装/配置检测):颜色由 CSS 类控制(点亮/置灰/脉冲)。 */
function stateIcon(name: string, id: string, cls: string): SVGSVGElement {
  const el = icon(name);
  el.id = id;
  el.classList.add("agent-state", cls);
  return el;
}

/** 工具接入卡片标题行右侧的「?」图标:悬停展示图标与按钮说明(用真实图标,不用文字描述形状)。 */
function toolsHelpContent(): El {
  const row = (iconName: string, desc: string): El =>
    h("div", { class: "tip-row" }, [icon(iconName), h("span", {}, [desc])]);
  return h("div", {}, [
    row("package", "安装检测:绿=已检测到 CLI,灰=未检测到(PATH 与常见安装目录)"),
    row("arrow-up", "升级:安装图标变橙色↑表示有新版本,点击按现有安装方式升级;未安装时点击可选官方方式安装"),
    row("sliders", "配置一致性:绿=与当前 Provider 一致,紫=指向本 app 的另一个 Provider,橙=不一致,灰=未配置"),
    h("div", { class: "tip-note" }, ["状态图标均可点击重新检测;标题行 ↑ 按钮为批量升级"]),
    h("div", { class: "tip-note" }, ["Pi 卡片上的橙色 ext 角标 = 更新 Pi 扩展(packages,即点即更;pi 本体无更新时也可单独更新;升级 pi 后也会自动顺带更新扩展)"]),
    row("play", "配置 = 生成/更新接入配置(写入官方配置文件;文件被外部改动过时自动备份 .bak-*)"),
    row("info", "状态 = 查看该工具的配置状态"),
    row("restore", "还原 = 从备份恢复(可重命名/删除/编辑备份内容;「清理自动备份」按文件保留最近 10 个)"),
  ]);
}

function helpTipIcon(): El {
  const tip = h("span", { class: "help-tip" }, ["?"]);
  tip.addEventListener("mouseenter", () => showTip(tip, toolsHelpContent()));
  tip.addEventListener("mouseleave", hideTip);
  return tip;
}

// ---------------------------------------------------------------------------
// Header 右侧:Codex 转换代理(端口固定展示 + 开关 + 帮助悬浮说明)
// ---------------------------------------------------------------------------

/** 代理帮助悬浮内容。 */
function proxyHelpContent(): El {
  const wrap = h("div", {}, []);
  wrap.append(
    h("div", { class: "tip-row" }, [
      h("span", {}, ["Codex 转换代理:把 Codex 的 Responses 请求经本机代理转成 Chat Completions 发给网关"]),
    ]),
    h("div", { class: "tip-note" }, [
      "解决网关卡 gpt-5.6 家族 /responses 不可用导致的 502;其它模型代理纯透传。",
      "端口固定为 17321,仅供查看;默认开启。关闭后 Codex 直连网关,gpt-5.6 家族可能报 502/不可用。",
    ]),
  );
  return wrap;
}

/** 代理端口展示(固定,不可修改;实际主机随代理状态刷新)。 */
function proxyPortLabel(): El {
  return h("span", { class: "proxy-port", id: "proxy-port" }, [`localhost:${CODX_PROXY_DEFAULT_PORT}`]);
}

/** 开关:默认开启;关闭需二次确认(影响 Codex 运行)。 */
function proxyToggle(): El {
  const sw = h("input", { type: "checkbox", id: "chk-proxy-switch", checked: "checked" });
  sw.addEventListener("change", () => {
    const box = sw as HTMLInputElement;
    if (box.checked) {
      void proxySwitchOn(box);
      return;
    }
    // 关闭:先弹二次确认;未确认时把开关恢复为开
    confirmDialog(
      "关闭 Codex 转换代理后,Codex 将直接连接网关。若网关卡 /responses 不可用(如 gpt-5.6 家族),请求会报 502 或「Model resources are currently busy」。确定关闭?",
      () => void proxySwitchOff(box),
      "关闭代理",
      "取消",
      "btn-danger-solid",
    );
    box.checked = true; // 确认后才真正关闭
  });
  return h("label", { class: "switch" }, [sw, h("span", { class: "slider" }, [])]);
}

async function proxySwitchOn(box: HTMLInputElement): Promise<void> {
  config.codexProxy = { enabled: true, port: CODX_PROXY_DEFAULT_PORT };
  await bridge.saveAppConfig(config).catch(() => {});
  try {
    const codexHome = await bridge.codexHome();
    const st = await bridge.proxyStart(CODX_PROXY_DEFAULT_PORT, config.baseUrl, CODX_PROXY_CONVERT_PATTERN, await bridge.joinPath(codexHome, "models.json"));
    updateProxyBadge(st.codexHost, st.port);
    notify(`Codex 转换代理已开启(${st.codexHost}:${st.port})${st.hijackWarning ? ",注意:" + st.hijackWarning : ""}`, "info");
  } catch (e) {
    notify(`代理启动失败: ${e}`, "error");
    box.checked = false;
    config.codexProxy = { enabled: false, port: CODX_PROXY_DEFAULT_PORT };
    void bridge.saveAppConfig(config).catch(() => {});
  }
}

async function proxySwitchOff(box: HTMLInputElement): Promise<void> {
  try {
    await bridge.proxyStop();
  } catch {
    // 停止失败不阻塞;状态可能已死
  }
  box.checked = false;
  config.codexProxy = { enabled: false, port: CODX_PROXY_DEFAULT_PORT };
  await bridge.saveAppConfig(config).catch(() => {});
  notify("Codex 转换代理已关闭(Codex 将直连网关)", "info");
}

/** 刷新 header 端口展示(实时主机/端口)。 */
function updateProxyBadge(host: string | undefined, port: number | undefined): void {
  const el = document.getElementById("proxy-port");
  if (el) el.textContent = `${host ?? "localhost"}:${port ?? CODX_PROXY_DEFAULT_PORT}`;
}

/** Header 右侧组件:端口 + 开关 + 帮助。 */
function proxyWidget(): El {
  const help = h("span", { class: "help-tip", id: "proxy-help" }, ["?"]);
  help.addEventListener("mouseenter", () => showTip(help, proxyHelpContent()));
  help.addEventListener("mouseleave", hideTip);
  return h("div", { class: "header-right" }, [
    h("span", { class: "proxy-title" }, ["Codex 转换代理"]),
    proxyPortLabel(),
    proxyToggle(),
    help,
    h("span", { class: "header-divider" }, []),
    h("span", { class: "proxy-title" }, ["开机自启"]),
    autostartToggle(),
    h("span", { class: "header-divider" }, []),
    appUpdateWidget(),
  ]);
}

/** Header 右上:App 自身更新提示(默认隐藏,检测到新版才显示)。 */
function appUpdateWidget(): El {
  return h("span", { id: "app-update-chip", class: "app-update-chip", style: "display:none" }, []);
}

/** 窗口重新可见/聚焦时的重查节流:30 分钟内不重复打 GitHub API。 */
const APP_UPDATE_RECHECK_INTERVAL_MS = 30 * 60 * 1000;
let appUpdateCheckedAt = 0;

/** 检查 App 更新:有新版则显示更新条;macOS「一键升级」,Windows「去下载」。
 *  force=false 时受 30 分钟节流(供窗口可见/聚焦时的重查用)。 */
async function checkAppUpdate(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - appUpdateCheckedAt < APP_UPDATE_RECHECK_INTERVAL_MS) return;
  appUpdateCheckedAt = now;
  try {
    const info = await bridge.appCheckUpdate();
    const chip = document.getElementById("app-update-chip");
    if (!chip) return;
    if (!info.updateAvailable) {
      // 重查时已无新版(如手动升级过):收起旧提示
      chip.replaceChildren();
      chip.style.display = "none";
      return;
    }
    chip.replaceChildren();
    const isMac = navigator.userAgent.includes("Mac");
    const btn = h("button", { class: "btn btn-small", type: "button", title: isMac ? "执行 brew upgrade axon-llm-dispenser" : "前往 GitHub Release 下载" }, [isMac ? "一键升级" : "去下载"]);
    btn.addEventListener("click", () => {
      if (isMac) {
        confirmDialog(`升级 Axon 到 v${info.latest}?将执行 brew upgrade axon-llm-dispenser,升级会自动重启应用。`, () => {
          notify("brew 升级进行中,期间请勿强制退出;完成后应用自动重启为新版", "info");
          void bridge.appUpdateMacos().then(
            () => notify("升级完成,应用即将重启", "info"),
            (e) => notify(`升级失败: ${e}`, "error"),
          );
        });
      } else {
        void bridge.openUrl(info.url);
      }
    });
    chip.append(h("span", { class: "proxy-title" }, [`发现新版本 v${info.latest}`]), btn);
    chip.style.display = "inline-flex";
  } catch {
    // 更新检查失败(离线/GitHub 不可达):静默
  }
}

/** 开机自启开关(header):状态由 OS 侧(LaunchAgent/注册表)真实回填。 */
function autostartToggle(): El {
  const sw = h("input", { type: "checkbox", id: "chk-autostart" });
  sw.addEventListener("change", () => void toggleAutostart(sw as HTMLInputElement));
  return h("label", { class: "switch" }, [sw, h("span", { class: "slider" }, [])]);
}

async function toggleAutostart(box: HTMLInputElement): Promise<void> {
  try {
    if (box.checked) {
      await autostartEnable();
      notify("已开启开机自启:登录时自动打开 Axon", "info");
    } else {
      await autostartDisable();
      notify("已关闭开机自启", "info");
    }
  } catch (e) {
    notify(`设置开机自启失败: ${e}`, "error");
    box.checked = await fallbackAutostartChecked(box.checked, autostartIsEnabled); // 回滚到真实状态
  }
}

/** 自定义下拉选择器(替代原生 select,匹配应用视觉)。
 *  options 与 opts.labels 按引用读取(profile 增删后直接改数组即可),set() 供外部同步选中项。 */
function customSelect(
  options: string[],
  initial: string,
  onChange: (v: string) => void,
  opts?: { labels?: string[]; filterPlaceholder?: string },
): { el: El; value: () => string; set: (v: string) => void } {
  const labelOf = (v: string): string => opts?.labels?.[options.indexOf(v)] ?? v;
  let current = options.includes(initial) ? initial : options[0] ?? "";
  const valueSpan = h("span", { class: "cselect-value" }, [labelOf(current)]);
  const btn = h("button", { class: "cselect-btn", type: "button" }, [valueSpan, h("span", { class: "cselect-arrow" }, ["▾"])]);
  const filter = h("input", { class: "cselect-filter", type: "text", placeholder: opts?.filterPlaceholder ?? "搜索模型…" });
  const list = h("div", { class: "cselect-list" }, []);
  const popup = h("div", { class: "cselect-popup" }, [filter, list]);
  const wrap = h("div", { class: "cselect" }, [btn, popup]);

  const close = (): void => popup.classList.remove("open");
  const set = (v: string): void => {
    current = v;
    valueSpan.textContent = labelOf(v);
  };
  const render = (): void => {
    list.replaceChildren();
    const q = filter.value.toLowerCase();
    for (const o of options) {
      const label = labelOf(o);
      if (q && !label.toLowerCase().includes(q)) continue;
      const item = h("button", { class: "cselect-item", type: "button" }, [label]);
      if (o === current) item.classList.add("active");
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        set(o);
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
  return { el: wrap, value: () => current, set };
}

const ACTION_ICONS: Record<string, string> = {
  "配置": "play",
  "刷新模型": "refresh",
  "选模型": "sliders",
  "状态": "info",
  "还原": "restore",
  "生成 Token": "key",
  "关闭鉴权": "lock",
};
const ACTION_TITLES: Record<string, string> = {
  "配置": "配置(覆盖现有配置;外部改动过才备份 .bak-*)",
  "刷新模型": "仅更新模型列表:只写模型相关配置,不改 base_url / 密钥 / 默认模型(外部改动过才备份)",
  "选模型": `选择 Codex 可见模型(${CODX_MAX_LISTED_MODELS} 个上限;未选中的写 visibility=hide,仅在 models.json 里生效)`,
  "状态": "查看配置状态",
  "还原": "从备份还原",
  "生成 Token": "生成鉴权 Token",
  "关闭鉴权": "关闭鉴权",
};

function toolCard(id: string, name: string, actions: string[]): El {
  const buttons = actions.map((a) =>
    h("button", { class: "btn btn-small btn-icon-only", id: `btn-${id}-${a}`, title: ACTION_TITLES[a] ?? a }, [icon(ACTION_ICONS[a] ?? "config")]),
  );
  const extBadge =
    id === "pi"
      ? h("button", { id: "agent-ext-pi", class: "agent-ext", type: "button", style: "display:none", title: "更新 Pi 扩展(packages;pi update --extensions,即点即更,不更新 pi 本体)" }, ["ext"])
      : null;
  return h("div", { class: "tool" }, [
    h("div", { class: "tool-left" }, [
      stateIcon("package", `agent-dot-${id}`, "checking"), // 安装状态:包裹盒
      stateIcon("sliders", `agent-cfg-dot-${id}`, "checking"), // 配置一致性:滑杆
      h("span", { class: "tool-name" }, [name]),
      // Pi 扩展角标放名字之后,避免把 agent 名与其他行横向错位
      ...(extBadge ? [extBadge] : []),
    ]),
    h("div", { class: "tool-actions" }, buttons),
  ]);
}

/** 检测单个 agent CLI 并更新徽标。 */
async function detectOne(tool: string): Promise<void> {
  const info = AGENT_CLIS[tool];
  if (!info) return;
  const dot = document.getElementById(`agent-dot-${tool}`);
  if (!dot) return;
  dot.classList.add("checking");
  dot.classList.remove("installed", "missing");
  dot.title = "检测安装中…";
  try {
    const p = await flows.detectAgentCli(tool);
    dot.classList.remove("checking");
    if (p) {
      dot.classList.add("installed");
      dot.title = `已检测到 ${info.bin}: ${p}(点击重新检测)`;
    } else {
      dot.classList.add("missing");
      dot.title = `未检测到 ${info.bin}(已检查 PATH 与常见安装目录;点击重新检测)${info.note ? `;${info.note}` : ""}`;
    }
  } catch {
    dot.classList.remove("checking");
    dot.classList.add("missing");
    dot.title = "安装检测失败(点击重新检测)";
  }
}

/** 启动后异步检测各 agent CLI 安装情况(不阻塞渲染,只更新工具卡片的安装徽标)。 */
async function detectAgents(): Promise<void> {
  for (const tool of Object.keys(AGENT_CLIS)) {
    const dot = document.getElementById(`agent-dot-${tool}`);
    dot?.addEventListener("click", () => void onInstallIconClick(tool)); // 点击:升级/安装/重检
    void detectOne(tool);
  }
  document.getElementById("agent-ext-pi")?.addEventListener("click", () => void onPiExtensionsClick()); // Pi 扩展角标:即点即更
}

// ---------------------------------------------------------------------------
// agent 升级/安装:检查可升级状态、图标切换、安装方式选择、批量升级、流式日志
// ---------------------------------------------------------------------------

const updStatus = new Map<string, bridge.AgentUpdateStatus>();
let updating = false;

/** 检查各 agent 的可升级状态(复用安装检测定位二进制,再由 Rust 端比对版本)。 */
async function checkAgentUpdates(): Promise<void> {
  const entries: bridge.AgentUpdateEntry[] = [];
  for (const tool of Object.keys(AGENT_CLIS)) {
    entries.push({ name: tool, path: await flows.detectAgentCli(tool) });
  }
  let list: bridge.AgentUpdateStatus[];
  try {
    list = await bridge.agentCheck(entries);
  } catch {
    return; // 检查失败保持现状
  }
  updStatus.clear();
  for (const s of list) updStatus.set(s.name, s);
  syncUpgradeIcons();
}

/** 按可升级状态切换安装图标:可升级→橙色↑;未安装→灰包裹盒(点击安装);已安装最新→绿包裹盒。 */
function syncUpgradeIcons(): void {
  let updatable: string[] = [];
  for (const [tool, s] of updStatus) {
    const el = document.getElementById(`agent-dot-${tool}`);
    if (!el) continue;
    el.classList.remove("updating");
    // Pi 扩展角标:仅已安装 pi 时可见(即点即更,不做版本检测)
    if (tool === "pi") {
      const extBtn = document.getElementById("agent-ext-pi");
      if (extBtn) extBtn.style.display = s.installed ? "" : "none";
    }
    if (s.updateAvailable) {
      updatable.push(tool);
      el.innerHTML = ICONS["arrow-up"];
      el.classList.add("update-available");
      el.classList.remove("installed", "missing", "checking");
      el.title = `${s.label} 有新版本:${s.version ?? "?"} → ${s.latest ?? "?"}(安装方式:${s.manager ?? "未知"};点击升级)`;
    } else if (!s.installed) {
      el.innerHTML = ICONS.package;
      el.classList.add("missing");
      el.classList.remove("installed", "checking", "update-available");
      el.title = `未安装 ${AGENT_CLIS[tool].bin}(点击选择官方方式安装)`;
    } else {
      el.innerHTML = ICONS.package;
      el.classList.add("installed");
      el.classList.remove("missing", "checking", "update-available");
      el.title = `已检测到 ${AGENT_CLIS[tool].bin}: v${s.version ?? "?"}(点击重新检测)`;
    }
  }
  const batchBtn = document.getElementById("btn-upgrade-all");
  if (batchBtn) {
    batchBtn.classList.remove("updating");
    batchBtn.classList.toggle("show", updatable.length > 0);
    batchBtn.title = `升级全部(${updatable.length} 个可升级)`;
  }
}

/** 升级/安装进行中:目标图标与批量按钮进入 loading 脉冲状态。 */
function setUpdatingIcons(tools: string[], on: boolean): void {
  for (const t of tools) {
    document.getElementById(`agent-dot-${t}`)?.classList.toggle("updating", on);
  }
  const batchBtn = document.getElementById("btn-upgrade-all");
  batchBtn?.classList.toggle("updating", on);
  if (batchBtn && on) batchBtn.title = "升级中…";
}

/** 安装图标点击:可升级→确认升级;未安装→选择官方方式安装;否则重检。 */
async function onInstallIconClick(tool: string): Promise<void> {
  if (updating) {
    notify("升级/安装进行中,请稍候", "info");
    return;
  }
  const s = updStatus.get(tool);
  if (s?.updateAvailable) {
    confirmDialog(`升级 ${s.label}?当前 ${s.version ?? "?"} → 最新 ${s.latest ?? "?"}(按现有安装方式 ${s.manager ?? "未知"}),过程日志实时显示在底部面板。`, () => {
      void runUpgrade([tool]);
    });
    return;
  }
  if (s && !s.installed) {
    openInstallModal(tool, s.installMethods);
    return;
  }
  await detectOne(tool);
  await checkAgentUpdates();
  const after = updStatus.get(tool);
  if (after?.installed) {
    notify(`${after.label} 已是最新 (v${after.version ?? "?"},最新 ${after.latest ?? "?"})`, "info");
  }
}

/** 未安装时弹安装方式选择(多种方式)或直接确认(单一方式)。 */
function openInstallModal(tool: string, methods: bridge.InstallMethod[]): void {
  const bin = AGENT_CLIS[tool].bin;
  if (methods.length === 1) {
    const m = methods[0];
    confirmDialog(`安装 ${bin}?将执行官方命令:${m.command}(过程日志实时显示在底部面板)`, () => {
      void runInstall(tool, m.id);
    });
    return;
  }
  clearOverlays();
  const overlay = h("div", { class: "modal-overlay" }, []);
  const modal = h("div", { class: "modal modal-sm" }, [
    h("h3", {}, [`安装 ${bin}`]),
    h("div", { class: "modal-sub" }, ["选择官方安装方式(执行过程显示在底部日志面板)"]),
  ]);
  const list = h("div", { class: "modal-list" }, []);
  for (const m of methods) {
    const row = h("button", { class: "modal-row", type: "button" }, [
      h("span", { class: "modal-label" }, [m.label]),
      h("span", { class: "modal-name" }, [m.command]),
    ]);
    row.addEventListener("click", () => {
      overlay.remove();
      void runInstall(tool, m.id);
    });
    list.append(row);
  }
  modal.append(list);
  const cancel = h("button", { class: "btn btn-ghost" }, ["取消"]);
  cancel.addEventListener("click", () => overlay.remove());
  modal.append(h("div", { class: "modal-footer" }, [cancel]));
  overlay.append(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
}

/** 批量/单个升级:顺序执行,日志事件实时写入日志面板,完成后重检。
 * 升级行为不改变日志面板高度(展开/收起由用户手动控制)。 */
async function runUpgrade(tools: string[]): Promise<void> {
  if (updating) return;
  updating = true;
  setUpdatingIcons(tools, true);
  const entries: bridge.AgentUpdateEntry[] = tools.map((t) => ({ name: t, path: updStatus.get(t)?.path ?? null }));
  try {
    await bridge.agentUpdate(entries);
    notify("升级任务完成,详见底部日志", "info");
  } catch (e) {
    notify(`升级失败: ${e}`, "error");
  }
  updating = false;
  setUpdatingIcons(tools, false);
  await checkAgentUpdates();
}

/** Pi 扩展角标点击:确认后即点即更(pi update --extensions,无需检测,不更新 pi 本体)。 */
async function onPiExtensionsClick(): Promise<void> {
  if (updating) {
    notify("升级/安装进行中,请稍候", "info");
    return;
  }
  const s = updStatus.get("pi");
  const piPath = s?.path ?? (await flows.detectAgentCli("pi"));
  if (!piPath) {
    notify("未检测到 pi,请先安装 pi", "error");
    return;
  }
  confirmDialog("更新 Pi 扩展(packages)?将执行 pi update --extensions,不更新 pi 本体,过程日志实时显示在底部面板。", () => {
    void runPiExtensionsUpdate(piPath);
  });
}

/** 执行 pi update --extensions:角标进入 loading 脉冲,完成后重检。 */
async function runPiExtensionsUpdate(piPath: string): Promise<void> {
  if (updating) return;
  updating = true;
  const badge = document.getElementById("agent-ext-pi");
  badge?.classList.add("updating");
  badge?.setAttribute("disabled", "disabled");
  try {
    await bridge.piExtensionsUpdate(piPath);
    notify("Pi 扩展更新完成,详见底部日志", "info");
  } catch (e) {
    notify(`Pi 扩展更新失败: ${e}`, "error");
  }
  updating = false;
  badge?.classList.remove("updating");
  badge?.removeAttribute("disabled");
  await checkAgentUpdates();
}

/** 按官方方式安装:日志实时写入,完成后重检安装与升级状态。 */
async function runInstall(tool: string, methodId: string): Promise<void> {
  if (updating) return;
  updating = true;
  setUpdatingIcons([tool], true);
  try {
    await bridge.agentInstall(tool, methodId);
    notify("安装完成,正在重新检测…", "info");
  } catch (e) {
    notify(`安装失败: ${e}`, "error");
  }
  updating = false;
  setUpdatingIcons([tool], false);
  await detectOne(tool);
  await checkAgentUpdates();
}

// ---------------------------------------------------------------------------
// 新手引导条:未完成接入流程时显示,完成后自动消失;× 可关闭(本次会话)
// ---------------------------------------------------------------------------

let guideDismissed = false;

// ---------------------------------------------------------------------------
// 卡片蒙层锁定:「模型列表」「工具接入」在网关连接成功前置灰不可交互
// ---------------------------------------------------------------------------

let gatewayConnected = false;

/** 按连接状态锁定/解锁卡片蒙层。 */
function syncCardLock(): void {
  const locked = !gatewayConnected;
  document.querySelectorAll(".card-lockable").forEach((el) => el.classList.toggle("locked", locked));
}

/** 按当前状态更新引导条:只依据是否配置了 Base URL 与 API Key,未配置则显示。 */
function syncOnboarding(): void {
  const banner = document.getElementById("guide-banner");
  readFields();
  const gatewayReady = Boolean(config.baseUrl && config.apiKey);
  if (banner) {
    if (guideDismissed || gatewayReady) {
      banner.style.display = "none";
    } else {
      const text = banner.querySelector(".guide-text") as El;
      text.textContent = "开始使用:在「连接设置」填写 Base URL 与 API Key → 点「测试连接」拉取模型 → 点任意 Agent 的 ▶ 一键接入";
      banner.style.display = "flex";
    }
  }
  syncCardLock();
}

/** 该工具的配置是否命中了其它已保存的 Provider(频繁切换时一眼看出各工具指向哪套网关)。 */
async function matchOtherProvider(tool: string): Promise<appcfg.ProviderProfile | null> {
  for (const p of config.profiles) {
    if (p.id === config.activeProfileId) continue;
    try {
      const r = await flows.detectAgentConfig(tool, { ...config, ...p });
      if (r.state === "ok") return p;
    } catch {
      // 单个 profile 检测失败不影响其它判断
    }
  }
  return null;
}

/** 检测单个 agent 的网关配置一致性并更新方形徽标(绿=一致,橙=不一致,蓝=其它 Provider,灰=未配置)。 */
async function detectAgentConfigOne(tool: string): Promise<void> {
  const dot = document.getElementById(`agent-cfg-dot-${tool}`);
  if (!dot) return;
  readFields();
  dot.classList.add("checking");
  dot.classList.remove("ok", "stale", "missing", "other");
  dot.title = "检测配置中…";
  try {
    const r = await flows.detectAgentConfig(tool, config);
    dot.classList.remove("checking");
    if (r.state === "ok") {
      dot.classList.add("ok");
      dot.title = "已配置且一致:provider 的 baseUrl 与 Key 同当前网关配置(点击重新检测)";
    } else {
      const other = await matchOtherProvider(tool);
      if (other) {
        dot.classList.add("other");
        dot.title = `当前写入的是本 app 的另一个 Provider:「${providerLabel(other)}」(点击重新检测;切到该 Provider,或点「应用到已接入工具」改指当前 Provider)`;
      } else if (r.state === "stale") {
        dot.classList.add("stale");
        dot.title = `检测到 provider 但配置不一致: baseUrl=${r.baseUrl ?? "(无)"},Key ${r.keyMatches ? "一致" : "不一致"}(点击重新检测)`;
      } else {
        dot.classList.add("missing");
        dot.title = config.baseUrl
          ? "未检测到本 app 写入的 provider(点击重新检测)"
          : "未保存网关配置,无法检测(点击重新检测)";
      }
    }
  } catch {
    dot.classList.remove("checking");
    dot.classList.add("missing");
    dot.title = "配置检测失败(点击重新检测)";
  }
  syncOnboarding();
}

/** 启动后异步检测各 agent 的配置一致性(方形徽标)。 */
async function detectAgentConfigs(): Promise<void> {
  for (const tool of Object.keys(AGENT_CLIS)) {
    const dot = document.getElementById(`agent-cfg-dot-${tool}`);
    dot?.addEventListener("click", () => void detectAgentConfigOne(tool)); // 点击徽标强制重检
    void detectAgentConfigOne(tool);
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

/** 把配置填进表单(启动加载与「删除配置」重置共用)。 */
function fillForm(cfg: bridge.AppConfig): void {
  ($("input-provider") as HTMLInputElement).value = cfg.provider;
  ($("input-display") as HTMLInputElement).value = cfg.displayName;
  ($("input-base") as HTMLInputElement).value = cfg.baseUrl;
  ($("input-key") as HTMLInputElement).value = cfg.apiKey;
  ($("input-anthropic") as HTMLInputElement).value = cfg.anthropicBaseUrl;
  ($("chk-exclude-doubao") as HTMLInputElement).checked = cfg.excludeDoubao;
}

/** 表单恢复刚安装时的初始状态(含 API Key 眼睛与模型列表)。 */
function resetForm(): void {
  config = appcfg.cloneConfig(bridge.DEFAULT_CONFIG);
  fillForm(config);
  const keyInput = $("input-key") as HTMLInputElement;
  keyInput.type = "password";
  const eye = keyInput.closest(".input-wrap")?.querySelector(".input-eye");
  if (eye) {
    eye.replaceChildren(icon("eye"));
    eye.setAttribute("title", "显示 API Key");
    eye.classList.remove("active");
  }
  setConnStatus("idle");
  setModelRows([]);
  gatewayConnected = false;
  syncCardLock();
  renderProviderSelect();
}

// ---------------------------------------------------------------------------
// Provider 配置切换:载入表单 → 拉取模型 →(可选)写入已接入工具
// ---------------------------------------------------------------------------

/** 保存配置:先把表单(顶层字段)写回激活 profile,再落盘;内存 profiles 同步更新。 */
async function persistConfig(): Promise<string> {
  config = appcfg.syncActiveProfile(config);
  return await bridge.saveAppConfig(config);
}

/** 拉取当前 profile 的模型列表并持久化(切换 profile 后自动调用)。 */
async function refreshModelsForActive(): Promise<string[] | null> {
  try {
    await fetchAndRenderModels();
  } catch (e) {
    notify(`拉取模型失败: ${e}`, "error");
    return null;
  }
  await persistConfig().catch(() => {});
  const ids = flows.filterDoubao(readModelIds(), config.excludeDoubao);
  if (ids.length === 0) {
    notify("该网关过滤后模型列表为空,无法写入工具", "error");
    return null;
  }
  return ids;
}

/** 用给定配置检测哪些工具「已接入」(存在本 app 写入的 provider 段,含 baseUrl/Key 不一致的情况)。 */
async function detectConfiguredTools(cfg: bridge.AppConfig): Promise<string[]> {
  const out: string[] = [];
  for (const tool of Object.keys(TOOL_LABELS)) {
    try {
      const r = await flows.detectAgentConfig(tool, cfg);
      if (r.state !== "missing") out.push(tool);
    } catch {
      // 检测失败按未接入处理
    }
  }
  return out;
}

/**
 * 把当前 profile 写入指定工具(调用方保证 ids 已就绪、codexListed 已定):
 * Claude 沿用 settings.json 现有角色映射;Codex 用给定可见集合(并记入 profile)。
 */
async function applyProfileToTools(tools: string[], ids: string[], codexListed?: string[]): Promise<void> {
  for (const tool of tools) {
    const label = TOOL_LABELS[tool];
    try {
      if (tool === "claude") {
        const roles = await flows.getClaudeCurrentRoles();
        if (!roles) {
          log([`—— Claude Code ——`, "跳过:settings.json 里没有角色模型配置,请用 Claude 卡片的「配置」选择角色"]);
          continue;
        }
        const r = await flows.configureClaude(config, roles);
        log([`—— ${label} ——`, ...r.lines]);
      } else if (tool === "codex") {
        const r = await flows.configureCodex(config, ids, codexListed);
        log([`—— ${label} ——`, ...r.lines]);
        rememberCodexChoice(codexListed ?? [], ids);
      } else if (tool === "reasonix") {
        const r = await flows.configureReasonix(config, ids);
        log([`—— ${label} ——`, ...r.lines]);
      } else if (tool === "dsh") {
        const r = await flows.configureDsh(config, ids);
        log([`—— ${label} ——`, ...r.lines]);
      } else if (tool === "pi") {
        const r = await flows.configurePi(config, ids);
        log([`—— ${label} ——`, ...r.lines]);
      } else if (tool === "omp") {
        const r = await flows.configureOmp(config, ids);
        log([`—— ${label} ——`, ...r.lines]);
      } else if (tool === "opencode") {
        const r = await flows.configureOpenCode(config, ids);
        log([`—— ${label} ——`, ...r.lines]);
      } else if (tool === "grok") {
        const r = await flows.configureGrok(config, ids);
        log([`—— ${label} ——`, ...r.lines]);
      }
      void detectAgentConfigOne(tool);
    } catch (e) {
      notify(`${label} 写入失败: ${e}`, "error");
    }
  }
  await persistConfig().catch(() => {});
}

/** 已接入工具清单的确认文案(切换/应用前统一展示)。 */
function confirmApplyText(action: string, tools: string[]): string {
  const names = tools.map((t) => TOOL_LABELS[t]).join("、");
  return `${action}\n将写入已接入的工具:${names}(未接入的自动跳过)\nCodex 会重启转换代理并刷新模型目录;Claude 沿用现有角色映射;各文件仅在检测到外部改动时才备份(.bak-*)。\n确认?`;
}

/** 切换到指定 profile:保存当前表单 → 载入新 profile → 拉模型 → 确认后写入已接入工具。 */
async function switchProvider(id: string): Promise<void> {
  if (id === config.activeProfileId) return;
  readFields(); // 表单 → 顶层字段(activateProfile 会写回旧 profile)
  const before = config; // 旧 profile 视图:判定「已接入」用它(工具当前指向的是它)
  config = appcfg.activateProfile(config, id);
  fillForm(config);
  setModelRows(config.models ?? []);
  setConnStatus("idle");
  gatewayConnected = false;
  syncCardLock();
  renderProviderSelect();
  await persistConfig();
  const label = providerLabel(appcfg.activeProfile(config));
  log([`已切换 Provider: ${label}(${config.baseUrl || "未填 Base URL"})`]);
  syncOnboarding();

  const ids = await refreshModelsForActive();
  if (!ids) {
    notify(`已切换到「${label}」(仅表单,未写入工具:新网关不可用或无模型)`, "info");
    return;
  }

  const tools = await detectConfiguredTools(before);
  if (tools.length === 0) {
    notify(`已切换到「${label}」;未检测到已接入的工具,需要时点各工具的「配置」`, "info");
    return;
  }
  // Codex 可见集合先定(可能弹选择框),再统一确认写入
  let codexListed: string[] | undefined;
  if (tools.includes("codex")) {
    const sel = await resolveCodexListed(ids);
    if (!sel) return;
    codexListed = sel;
  }
  const ok = await confirmDialogAsync(confirmApplyText(`已切换到 Provider「${label}」。`, tools));
  if (!ok) {
    notify(`已切换到「${label}」,各工具仍指向原 Provider(可点「应用到已接入工具」再写入)`, "info");
    return;
  }
  await applyProfileToTools(tools, ids, codexListed);
  notify(`已把「${label}」写入 ${tools.length} 个已接入工具`, "info");
}

/** 新建 profile(以当前表单的 Provider 名 / 显示名为模板,Base URL 与密钥留空重填)。 */
async function createProvider(): Promise<void> {
  readFields();
  await persistConfig();
  const name = await promptDialog("新建 Provider 配置", "名称(仅本 app 内用于区分,如 公司网关 / 自建 A5000)", `gateway-${config.profiles.length + 1}`);
  if (!name) return;
  const p = appcfg.emptyProfile(appcfg.newProfileId(config.profiles), config.provider || "axon", name);
  p.anthropicBaseUrl = config.anthropicBaseUrl; // 同一网关家族常用同一 Anthropic 端点
  config = appcfg.addProfile(config, p);
  fillForm(config);
  setModelRows([]);
  setConnStatus("idle");
  gatewayConnected = false;
  syncCardLock();
  renderProviderSelect();
  await persistConfig();
  notify(`已新建 Provider「${name}」:填写 Base URL / API Key 后点「测试连接」`, "info");
  syncOnboarding();
}

/** 删除当前 profile(仅删本 app 内保存的配置;各工具已写入的内容不受影响)。 */
async function deleteProvider(): Promise<void> {
  const active = appcfg.activeProfile(config);
  const rest = config.profiles.filter((p) => p.id !== active.id);
  const next = rest.length > 0 ? `;删除后切换到「${providerLabel(rest[0])}」` : ";删除后表单恢复初始状态";
  const ok = await confirmDialogAsync(`删除 Provider 配置「${providerLabel(active)}」?\n仅删除本 app 内保存的这套配置,各工具已写入的配置不受影响${next}。`, "删除", "取消", "btn-danger-solid");
  if (!ok) return;
  config = appcfg.removeProfile(config, active.id);
  fillForm(config);
  setModelRows(config.models ?? []);
  setConnStatus("idle");
  gatewayConnected = false;
  syncCardLock();
  renderProviderSelect();
  await persistConfig();
  notify(`已删除 Provider 配置「${providerLabel(active)}」`, "info");
  syncOnboarding();
}

/** 把当前 profile 应用到所有已接入工具(不下发切换表单的副作用)。 */
async function applyActiveToConfiguredTools(): Promise<void> {
  readFields();
  if (!validateProvider()) return;
  const ids = await ensureModels();
  if (!ids) return;
  const tools = await detectConfiguredTools(config);
  if (tools.length === 0) {
    notify("未检测到已接入的工具(先在各工具卡片点「配置」写入一次)", "error");
    return;
  }
  const label = providerLabel(appcfg.activeProfile(config));
  let codexListed: string[] | undefined;
  if (tools.includes("codex")) {
    const sel = await resolveCodexListed(ids);
    if (!sel) return;
    codexListed = sel;
  }
  const ok = await confirmDialogAsync(confirmApplyText(`把 Provider「${label}」应用到已接入工具?`, tools));
  if (!ok) return;
  await applyProfileToTools(tools, ids, codexListed);
  notify(`已把「${label}」写入 ${tools.length} 个已接入工具`, "info");
}

function readModelIds(): string[] {
  return modelRows.map((r) => r.id);
}

/** 渲染侧边模型列表。 */
function renderModelsList(): void {
  const list = document.getElementById("models-list");
  if (!list) return;
  list.replaceChildren();
  if (modelRows.length === 0) {
    list.append(h("div", { class: "log-empty" }, ["填写网关后点 ↻ 拉取模型列表"]));
  }
  for (const r of modelRows) {
    const row = h("div", { class: "model-row" }, [
      h("span", { class: "model-row-id" }, [r.id]),
      // 未命中元数据表(规格为推断值)的模型标 "new"
      ...(isKnownModel(r.id) ? [] : [h("span", { class: "model-row-new", title: "未命中模型元数据表,规格按 id 推断" }, ["new"])]),
      // 网关兼容层强制关思考的模型:显式标注,避免用户以为它是常规推理模型
      ...(gatewayThinkingDisabled(r.id)
        ? [h("span", { class: "model-row-warn", title: "该模型在本网关上带工具时思考被强制关闭(上游限制:function tools 与 reasoning_effort 互斥)。需要思考+工具请换模型;自动挑选默认模型时会跳过它" }, ["无思考"])]
        : []),
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

/** 连接状态点(标题行右侧):灰=未测试,蓝脉冲=连接中,绿=成功,红=失败。 */
function setConnStatus(state: "idle" | "checking" | "ok" | "error", tip?: string): void {
  const dot = $("conn-status");
  dot.classList.remove("status-idle", "status-checking", "status-ok", "status-error");
  dot.classList.add(`status-${state}`);
  dot.title = tip ?? { idle: "未测试连接", checking: "连接中…", ok: "连接成功", error: "连接失败" }[state];
}

/** 拉取模型并渲染到侧栏;失败时置红并抛出,由调用方 run() 统一报错。 */
async function fetchAndRenderModels(): Promise<void> {
  setConnStatus("checking");
  try {
    const info = await flows.testConnection(config.baseUrl, config.apiKey);
    let shown = info;
    if (config.excludeDoubao) {
      shown = info.filter((m) => !flows.isDoubaoModel(m.id));
    }
    setModelRows(shown);
    config.models = shown.map((m) => ({ id: m.id, ownedBy: m.ownedBy })); // 持久化,避免刷新/升级后模型项丢失
    setConnStatus("ok", `连接成功,拉取到 ${info.length} 个模型(展示 ${shown.length})`);
    notify(`连接成功,拉取到 ${info.length} 个模型(展示 ${shown.length})`, "info");
    gatewayConnected = true;
    syncCardLock(); // 连接成功:解锁模型列表/工具接入卡片
  } catch (e) {
    setConnStatus("error", `连接失败: ${e}`);
    gatewayConnected = false;
    syncCardLock(); // 连接失败:重新锁定
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
    ids = flows.filterDoubao(ids, true);
  }
  if (ids.length === 0) {
    notify("过滤后模型列表为空,请取消「过滤 Doubao」或添加其它模型", "error");
    return null;
  }
  return ids;
}

let tipEl: El | null = null;

/** JS tooltip:fixed 定位逃逸弹窗 overflow:hidden,自动贴边不截断。内容支持文本或 DOM 节点。 */
function showTip(target: El, text: string | El): void {
  hideTip();
  const el = h("div", { class: "tip-popup" }, [text instanceof Node ? text : document.createTextNode(text)]);
  document.body.append(el);
  const r = target.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  // 垂直:默认显示在目标上方;顶部放不下时放下方;仍放不下时贴底
  let top = r.top - er.height - 6;
  if (top < 8) top = r.bottom + 6;
  if (top + er.height > window.innerHeight - 8) top = window.innerHeight - er.height - 8;
  el.style.top = `${Math.max(8, top)}px`;
  // 水平:居中于目标,整体钳制在视口内(不超出/截断);不用 transform,避免钳制后偏移
  const wantLeft = r.left + r.width / 2 - er.width / 2;
  const left = Math.min(Math.max(8, wantLeft), window.innerWidth - er.width - 8);
  el.style.left = `${Math.max(8, left)}px`;
  el.style.transform = "none";
  tipEl = el;
}

function hideTip(): void {
  tipEl?.remove();
  tipEl = null;
}

/** Promise 弹窗(确认/选择)的关闭回调:ESC/批量清理时走各自回调结算,避免 await 永久挂起。 */
const overlayDismissers = new WeakMap<Element, () => void>();

/** 清理所有残留弹窗(自愈:避免旧 overlay 堆积导致假卡死)。 *//** 清理所有残留弹窗(自愈:避免旧 overlay 堆积导致假卡死)。 */
function clearOverlays(): void {
  document.querySelectorAll(".modal-overlay").forEach((el) => {
    const dismiss = overlayDismissers.get(el);
    if (dismiss) dismiss(); // Promise 弹窗按「取消」结算,否则其 await 永不返回
    else el.remove();
  });
}

/** 自定义确认弹窗(window.confirm 在 Tauri WebView 下不可用,故自实现)。
 * 不清除已有弹窗:允许叠加在还原弹窗等上层做二次确认(ESC 只关最上层)。
 * okClass 用于危险操作的红色确认按钮(如 btn-danger-solid)。 */
function confirmDialog(message: string, onOk: () => void, okLabel = "确认", cancelLabel = "取消", okClass = ""): void {
  void confirmDialogAsync(message, okLabel, cancelLabel, okClass).then((ok) => {
    if (ok) onOk();
  });
}

/** confirmDialog 的 Promise 版(刷新模型流程:先算变更、确认后才写入)。 */
function confirmDialogAsync(message: string, okLabel = "确认", cancelLabel = "取消", okClass = ""): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "modal-overlay" }, []);
    const modal = h("div", { class: "modal modal-sm" }, [
      h("p", { class: "confirm-text" }, [message]),
      h("div", { class: "modal-footer" }, [
        h("button", { class: "btn btn-ghost" }, [cancelLabel]),
        h("button", { class: `btn ${okClass}`.trim() }, [okLabel]),
      ]),
    ]);
    const [cancel, ok] = modal.querySelectorAll("button");
    const close = (result: boolean): void => {
      overlay.remove();
      resolve(result);
    };
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    overlayDismissers.set(overlay, () => close(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    overlay.append(modal);
    document.body.append(overlay);
  });
}

/** 文本输入弹窗(window.prompt 在 Tauri WebView 下不可用),确认返回去空格后的值,取消返回 null。 */
function promptDialog(title: string, label: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = h("div", { class: "modal-overlay" }, []);
    const input = h("input", { class: "input", type: "text", placeholder: label }, []);
    input.value = initial;
    const modal = h("div", { class: "modal modal-sm" }, [
      h("h3", {}, [title]),
      h("div", { class: "modal-sub" }, [label]),
      input,
    ]);
    const cancel = h("button", { class: "btn btn-ghost" }, ["取消"]);
    const ok = h("button", { class: "btn" }, ["确认"]);
    const close = (value: string | null): void => {
      overlay.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", () => close(input.value.trim() || null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") close(input.value.trim() || null);
    });
    overlayDismissers.set(overlay, () => close(null));
    modal.append(h("div", { class: "modal-footer" }, [cancel, ok]));
    overlay.append(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

/**
 * Codex 可见模型选择弹窗:Codex 客户端模型列表超过上限会渲染错乱,
 * 让用户在上限内挑选要显示的模型(其余以 visibility="hide" 写入,仍可用 codex -m <id> 指定)。
 * 返回选中的 id 集合(取消返回 null)。
 */
function openCodexModelPicker(ids: string[], preselect: string[], cap: number, defaultModel: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const selected = new Set(preselect);
    // 展示顺序与 models.json 的写入顺序一致(按 id 排序)
    const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));
    const overlay = h("div", { class: "modal-overlay" }, []);
    const counter = h("span", { class: "picker-counter" }, []);
    const filter = h("input", { class: "input picker-filter", type: "text", placeholder: "搜索模型…" }, []);
    const list = h("div", { class: "modal-list picker-list" }, []);
    const ok = h("button", { class: "btn" }, []);
    const cancel = h("button", { class: "btn btn-ghost" }, ["取消"]);
    const modal = h("div", { class: "modal" }, [
      h("h3", {}, [`Codex 可见模型(最多 ${cap} 个)`]),
      h("div", { class: "modal-sub" }, [
        `Codex 客户端的模型列表超过 ${cap} 个会渲染错乱,请选择要在选择器里显示的模型;` +
          `未选中的以 visibility="hide" 写入(不出现在选择器,但仍保留在目录里,可作默认模型 / codex -m <id> 指定)。`,
      ]),
      h("div", { class: "picker-toolbar" }, [filter, counter]),
      list,
    ]);

    const sync = (): void => {
      counter.textContent = `已选 ${selected.size}/${cap}`;
      ok.textContent = `确认(${selected.size}/${cap})`;
      if (selected.size === 0) ok.setAttribute("disabled", "disabled");
      else ok.removeAttribute("disabled");
    };
    const render = (): void => {
      const q = filter.value.trim().toLowerCase();
      list.replaceChildren();
      for (const id of sortedIds) {
        if (q && !id.toLowerCase().includes(q)) continue;
        const on = selected.has(id);
        const box = h("input", { type: "checkbox" }, []) as HTMLInputElement;
        box.checked = on;
        box.disabled = !on && selected.size >= cap; // 到达上限后其余条目不可勾选
        const row = h("label", { class: `picker-row${on ? " on" : ""}` }, [
          box,
          h("span", { class: "picker-id" }, [id]),
          ...(id === defaultModel ? [h("span", { class: "model-row-owner", title: "config.toml 里的默认模型" }, ["默认"])] : []),
        ]);
        box.addEventListener("change", () => {
          if (box.checked) selected.add(id);
          else selected.delete(id);
          render(); // 重渲染以同步计数、行态与「已达上限」的可勾选性
        });
        list.append(row);
      }
      sync();
    };
    const close = (result: string[] | null): void => {
      overlay.remove();
      resolve(result);
    };
    filter.addEventListener("input", render);
    filter.addEventListener("click", (e) => e.stopPropagation());
    cancel.addEventListener("click", () => close(null));
    ok.addEventListener("click", () => close([...selected]));
    overlayDismissers.set(overlay, () => close(null));
    modal.append(h("div", { class: "modal-footer" }, [cancel, ok]));
    overlay.append(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.body.append(overlay);
    render();
    filter.focus();
  });
}

/** 当前 profile 的 Codex 可见集合记忆(切换网关后各自沿用,不互相覆盖)。 */
function codexMemory(): { listed?: string[]; known?: string[] } {
  const p = appcfg.activeProfile(config);
  return { listed: p.codexListed, known: p.codexKnown };
}

/** 计算 Codex 可见集合:沿用该 profile 上次的选择(网关后续新增的模型仍会触发超上限弹框);
 *  超上限时弹选择框;返回最终集合(用户取消返回 null)。 */
async function resolveCodexListed(ids: string[]): Promise<string[] | null> {
  const p = await flows.codexListedPlan(config, ids, codexMemory());
  if (!p.needsChoice) return p.listed;
  return await openCodexModelPicker(ids, p.listed, CODX_MAX_LISTED_MODELS, p.defaultModel);
}

/** 记住当前 profile 的 Codex 可见选择与当时的模型列表(切换网关后互不覆盖)。 */
function rememberCodexChoice(listed: string[], known: string[]): void {
  const id = config.activeProfileId;
  config.profiles = config.profiles.map((p) => (p.id === id ? { ...p, codexListed: [...listed], codexKnown: [...known] } : p));
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
        void detectAgentConfigOne("claude");
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
      notify(`${tool} 暂无备份(写入前检测到外部改动时会自动备份 .bak-*)`, "info");
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
          }, "删除", "取消", "btn-danger-solid"),
        );
        list.append(h("div", { class: "modal-row" }, [main, h("div", { class: "backup-actions" }, [play, rename, del])]));
      }
    };
    render();
    modal.append(list);
    const close = h("button", { class: "btn btn-ghost", id: "modal-close" }, ["关闭"]);
    close.addEventListener("click", () => overlay.remove());
    // 清理自动备份:每个文件保留最近 N 个(手动重命名的备份不动),解决频繁写盘留下的堆积
    const cleanup = h("button", { class: "btn btn-ghost", type: "button", title: `每个文件保留最近 ${BACKUP_KEEP_AUTO} 个自动备份,删除更早的;手动重命名的备份不受影响` }, ["清理自动备份"]);
    cleanup.addEventListener("click", () =>
      void run("清理备份", async () => {
        const stale: BackupRow[] = [];
        for (const t of targets) {
          for (const b of await flows.planBackupCleanup(t.path)) {
            stale.push({ label: t.label, targetPath: t.path, base: bridge.basenamePath(t.path), name: b.name, path: b.path, time: "", size: "" });
          }
        }
        if (stale.length === 0) {
          notify(`没有需要清理的自动备份(每个文件保留最近 ${BACKUP_KEEP_AUTO} 个;手动重命名的备份不参与)`, "info");
          return;
        }
        const names = stale.slice(0, 5).map((s) => s.name).join("、");
        const ok = await confirmDialogAsync(
          `将删除 ${stale.length} 个自动备份(每个文件保留最近 ${BACKUP_KEEP_AUTO} 个;手动重命名的备份不受影响):\n${names}${stale.length > 5 ? " …" : ""}\n删除后不可恢复,确认?`,
          "删除",
          "取消",
          "btn-danger-solid",
        );
        if (!ok) return;
        const n = await flows.deleteBackups(stale.map((s) => s.path));
        notify(`已清理 ${n} 个自动备份`, "info");
        await refresh();
      }),
    );
    modal.append(h("div", { class: "modal-footer" }, [cleanup, close]));
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
  const gutter = h("div", { class: "editor-gutter" }, []);
  // 行号侧栏:与 textarea 字体/行高/内边距一致,输入时重算行数,滚动时同步偏移
  const syncGutter = (): void => {
    const lines = ta.value.split("\n").length;
    let nums = "";
    for (let i = 1; i <= lines; i++) nums += `${i}\n`;
    gutter.textContent = nums;
    gutter.scrollTop = ta.scrollTop;
  };
  ta.addEventListener("input", syncGutter);
  ta.addEventListener("scroll", () => {
    gutter.scrollTop = ta.scrollTop;
  });
  const modal = h("div", { class: "modal" }, [
    h("h3", {}, [`查看/编辑 - ${b.name}`]),
    h("div", { class: "modal-sub" }, [`${b.label} · 保存写回备份文件,应用还原到当前配置(均校验格式)`]),
    h("div", { class: "editor-wrap" }, [gutter, ta]),
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
    syncGutter();
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

/** 展开/收起按钮图标与提示随面板高度状态切换。 */
function syncExpandBtn(): void {
  const expanded = $("footer").offsetHeight > FOOTER_MIN + 20;
  const btn = $("btn-expand-log");
  btn.replaceChildren(icon(expanded ? "chevron-down" : "chevron-up"));
  btn.title = expanded ? "收起日志面板" : "展开日志面板";
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
  // 批量升级:升级全部可升级的 agent(各按现有安装方式)
  $("btn-upgrade-all").addEventListener("click", () => {
    const names = [...updStatus.entries()].filter(([, s]) => s.updateAvailable).map(([n]) => n);
    if (names.length === 0) return;
    confirmDialog(`将升级 ${names.length} 个 Agent(${names.join("、")}),按各自现有安装方式执行,过程日志实时显示在底部面板。确认?`, () => {
      void runUpgrade(names);
    });
  });

  // 新手引导条关闭按钮(本次会话内隐藏)
  $("guide-close").addEventListener("click", () => {
    guideDismissed = true;
    const banner = document.getElementById("guide-banner");
    if (banner) banner.style.display = "none";
  });

  // 底部日志面板:拖拽调高、把手上的 chevron 按钮单击展开/收起、窗口缩放时重新夹紧
  initFooterMin();
  window.addEventListener("resize", () => setFooterHeight($("footer").offsetHeight));
  $("btn-expand-log").addEventListener("pointerdown", (e) => e.stopPropagation()); // 点按钮不触发拖拽
  $("btn-expand-log").addEventListener("click", () => {
    const expanded = $("footer").offsetHeight > FOOTER_MIN + 20;
    setFooterHeight(expanded ? FOOTER_MIN : Math.floor(window.innerHeight / 2));
  });
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

  // Provider 配置:新建 / 删除 / 应用到已接入工具(切换由下拉 onChange 触发)
  $("btn-provider-add").addEventListener("click", () => void run("新建 Provider", createProvider));
  $("btn-provider-del").addEventListener("click", () => void run("删除 Provider", deleteProvider));
  $("btn-provider-apply").addEventListener("click", () => void run("应用到已接入工具", applyActiveToConfiguredTools));

  $("btn-save").addEventListener("click", () =>
    run("保存配置", async () => {
      readFields();
      if (!config.baseUrl && !config.apiKey) {
        notify("Base URL 与 API Key 为空,未保存", "error");
        return;
      }
      const path = await persistConfig();
      renderProviderSelect(); // 名称/网关变化同步下拉显示
      notify(`配置已保存: ${path}`);
      syncOnboarding();
      void detectAgentConfigs(); // 网关变化后重检各 agent 配置一致性(同步引导条)
    }),
  );

  $("btn-del-config").addEventListener("click", () =>
    confirmDialog(`将删除保存的网关配置(config.json,含全部 ${config.profiles.length} 个 Provider),表单恢复刚安装时的初始状态;各 Agent 已写入的配置不受影响。`, () => {
      void run("删除配置", async () => {
        const path = await bridge.appConfigFile();
        if (await bridge.exists(path)) await bridge.deleteFile(path);
        resetForm();
        notify("已删除应用配置,表单已恢复初始状态", "info");
        void detectAgentConfigs();
        syncOnboarding();
      });
    }, "删除", "取消", "btn-danger-solid"),
  );

  $("btn-test").addEventListener("click", () =>
    run("测试连接", async () => {
      readFields();
      if (!config.baseUrl) {
        notify("请先填写 Base URL", "error");
        return;
      }
      await fetchAndRenderModels();
      // 连接成功即自动保存配置,无需再手动点「保存配置」
      const path = await persistConfig();
      renderProviderSelect(); // 网关主机变化同步下拉显示
      notify(`配置已保存: ${path}`, "info");
      syncOnboarding();
    }),
  );

  $("btn-fetch").addEventListener("click", () => $("btn-test").click());


  $("btn-codex-配置").addEventListener("click", () =>
    void run("Codex 配置", async () => {
      readFields();
      if (!validateProvider()) return;
      const ids = await ensureModels();
      if (!ids) return;
      // 可见模型超上限时先让用户在上限内挑选(取消则中止)
      const listed = await resolveCodexListed(ids);
      if (!listed) return;
      const ok = await confirmDialogAsync("将更新 Codex 的接入配置:写入 config.toml / models.json 中 provider/鉴权与模型相关字段,保留其它设置;文件被外部改动过时自动备份(.bak-*),确认?");
      if (!ok) return;
      const r = await flows.configureCodex(config, ids, listed);
      log(r.lines);
      rememberCodexChoice(listed, ids);
      await persistConfig().catch(() => {});
      void detectAgentConfigOne("codex");
    }),
  );

  // 主动改选(不依赖超上限触发):只写 models.json 的可见性,不动 config.toml
  $("btn-codex-选模型").addEventListener("click", () =>
    void run("Codex 选择可见模型", async () => {
      readFields();
      if (!validateProvider()) return;
      const ids = await ensureModels();
      if (!ids) return;
      const lp = await flows.codexListedPlan(config, ids, codexMemory());
      const sel = await openCodexModelPicker(ids, lp.listed, CODX_MAX_LISTED_MODELS, lp.defaultModel);
      if (!sel) return;
      rememberCodexChoice(sel, ids);
      if (await applyOnePlan("codex", "Codex", await flows.planRefreshCodex(config, ids, sel))) {
        await persistConfig().catch(() => {}); // 记住本 profile 的可见集合选择
      }
    }),
  );

  $("btn-codex-状态").addEventListener("click", () =>
    run("Codex 状态", async () => {
      log(await flows.codexStatus());
    }),
  );

  $("btn-codex-还原").addEventListener("click", () => openRestoreModal("codex"));

  $("btn-reasonix-配置").addEventListener("click", () =>
    confirmDialog("将更新 Reasonix 的接入配置:写入 config.toml / .env 中 provider/鉴权与模型相关字段,保留其它设置;文件被外部改动过时自动备份(.bak-*),确认?", () => {
      void run("Reasonix 配置", async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        const r = await flows.configureReasonix(config, ids);
        log(r.lines);
        void detectAgentConfigOne("reasonix");
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
    confirmDialog("将生成新的固定鉴权 Token 并写入 Reasonix [serve] 段(覆盖旧 Token;文件被外部改动过时自动备份),确认?", () => {
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
    confirmDialog("将更新 dsh 的接入配置:写入 settings.yaml / .credentials.yaml 中 provider/鉴权与模型相关字段,保留其它设置;文件被外部改动过时自动备份(.bak-*),确认?", () => {
      void run("dsh 配置", async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        const r = await flows.configureDsh(config, ids);
        log(r.lines);
        void detectAgentConfigOne("dsh");
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

  $("btn-grok-配置").addEventListener("click", () =>
    confirmDialog("将更新 grok 的接入配置:写入 config.toml 的 [model_providers.<name>] 与每模型 [model.<id>] 块,保留其它设置;API Key 以明文写入 provider 块(grok 不加载 home .env,env_key 需 shell 导出故不用);原文件自动备份(.bak-*),确认?", () => {
      void run("grok 配置", async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        const r = await flows.configureGrok(config, ids);
        log(r.lines);
        void detectAgentConfigOne("grok");
      });
    }),
  );

  $("btn-grok-状态").addEventListener("click", () =>
    run("grok 状态", async () => {
      readFields();
      log(await flows.grokStatus(config));
    }),
  );

  $("btn-grok-还原").addEventListener("click", () => openRestoreModal("grok"));

  $("btn-claude-配置").addEventListener("click", () => openClaudeConfigModal());

  $("btn-claude-状态").addEventListener("click", () =>
    run("Claude 状态", async () => {
      log(await flows.claudeStatus());
    }),
  );

  $("btn-claude-还原").addEventListener("click", () => openRestoreModal("claude"));

  $("btn-pi-配置").addEventListener("click", () =>
    confirmDialog("将更新 Pi 的接入配置:写入 models.json / settings.json 中 provider/鉴权与模型相关字段,保留其它设置;文件被外部改动过时自动备份(.bak-*),确认?", () => {
      void run("Pi 配置", async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        const r = await flows.configurePi(config, ids);
        log(r.lines);
        void detectAgentConfigOne("pi");
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

  $("btn-omp-配置").addEventListener("click", () =>
    confirmDialog("将更新 omp 的接入配置:写入 models.yml / config.yml 中 provider/鉴权与模型相关字段,DeepSeek 模型应用官方特配(thinking 等级 + 完整 compat),保留其它设置;文件被外部改动过时自动备份(.bak-*),确认?", () => {
      void run("omp 配置", async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        const r = await flows.configureOmp(config, ids);
        log(r.lines);
        void detectAgentConfigOne("omp");
      });
    }),
  );

  $("btn-omp-状态").addEventListener("click", () =>
    run("omp 状态", async () => {
      readFields();
      log(await flows.ompStatus(config));
    }),
  );

  $("btn-omp-还原").addEventListener("click", () => openRestoreModal("omp"));

  $("btn-opencode-配置").addEventListener("click", () =>
    confirmDialog(
      "将更新 OpenCode 的接入配置:写入 ~/.config/opencode/opencode.json(provider 块 + 默认 model)与 ~/.local/share/opencode/auth.json(密钥,0600,不备份),保留其它设置;opencode.json 外部改动过时自动备份(.bak-*),确认?",
      () => {
        void run("OpenCode 配置", async () => {
          readFields();
          if (!validateProvider()) return;
          const ids = await ensureModels();
          if (!ids) return;
          const r = await flows.configureOpenCode(config, ids);
          log(r.lines);
          void detectAgentConfigOne("opencode");
        });
      },
    ),
  );

  $("btn-opencode-状态").addEventListener("click", () =>
    run("OpenCode 状态", async () => {
      readFields();
      log(await flows.opencodeStatus(config));
    }),
  );

  $("btn-opencode-还原").addEventListener("click", () => openRestoreModal("opencode"));

  // ---- 刷新模型(仅更新模型列表):先算变更 → 展示确认 → 写入;不改 base_url/密钥/默认模型 ----

  /** 执行单个刷新计划:跳过/无变化直接记日志,否则确认后写入。返回是否真的写盘。 */
  const applyOnePlan = async (agent: string, label: string, p: flows.ModelsRefreshPlan): Promise<boolean> => {
    if (p.skip || p.changes.length === 0) {
      log([`${label}: ${p.skip ?? "模型列表已是最新,无变化"}`]);
      return false;
    }
    const ok = await confirmDialogAsync(
      `仅更新模型列表(${label}):\n${p.changes.join("\n")}\n\n只写模型相关配置,不改 base_url / 密钥 / 默认模型;文件被外部改动过时自动备份(.bak-*),确认?`,
    );
    if (!ok) return false;
    log(await flows.applyRefreshPlans([p]));
    void detectAgentConfigOne(agent);
    return true;
  };

  /** 单 agent 刷新处理器:拉模型 → 计划 → 确认 → 执行。 */
  const refreshOne =
    (
      agent: string,
      label: string,
      plan: (cfg: bridge.AppConfig, ids: string[]) => Promise<flows.ModelsRefreshPlan>,
    ): (() => void) =>
    () =>
      void run(`${label} 刷新模型`, async () => {
        readFields();
        if (!validateProvider()) return;
        const ids = await ensureModels();
        if (!ids) return;
        await applyOnePlan(agent, label, await plan(config, ids));
      });

  // Codex 刷新模型:可见模型超上限时先让用户挑选(未接入则直接跳过,不弹选择框)
  $("btn-codex-刷新模型").addEventListener("click", () =>
    void run("Codex 刷新模型", async () => {
      readFields();
      if (!validateProvider()) return;
      const ids = await ensureModels();
      if (!ids) return;
      const base = await flows.planRefreshCodex(config, ids, undefined, codexMemory());
      if (base.skip) {
        log([`Codex: ${base.skip}`]);
        return;
      }
      const listed = await resolveCodexListed(ids);
      if (!listed) return;
      rememberCodexChoice(listed, ids);
      // 无变化时不落盘(避免每次点击都改写 config.json)
      if (await applyOnePlan("codex", "Codex", await flows.planRefreshCodex(config, ids, listed))) {
        await persistConfig().catch(() => {});
      }
    }),
  );
  $("btn-dsh-刷新模型").addEventListener("click", refreshOne("dsh", "dsh", flows.planRefreshDsh));
  $("btn-omp-刷新模型").addEventListener("click", refreshOne("omp", "omp", flows.planRefreshOmp));
  $("btn-reasonix-刷新模型").addEventListener("click", refreshOne("reasonix", "Reasonix", flows.planRefreshReasonix));
  $("btn-opencode-刷新模型").addEventListener("click", refreshOne("opencode", "OpenCode", flows.planRefreshOpenCode));
  $("btn-grok-刷新模型").addEventListener("click", refreshOne("grok", "Grok", flows.planRefreshGrok));

  // 全局:刷新全部已接入 agent 的模型列表(单点失败不中断)
  $("btn-refresh-all-models").addEventListener("click", () =>
    void run("刷新全部模型列表", async () => {
      readFields();
      if (!validateProvider()) return;
      const ids = await ensureModels();
      if (!ids) return;
      const basePlans = await flows.planRefreshAll(config, ids, undefined, codexMemory());
      // Codex 可见模型超上限:先让用户在上限内挑选(取消则整个批量刷新中止)
      let codexListed: string[] | undefined;
      const codexBase = basePlans.find((p) => p.agent === "Codex");
      if (codexBase && !codexBase.skip) {
        const sel = await resolveCodexListed(ids);
        if (!sel) return;
        codexListed = sel;
        rememberCodexChoice(sel, ids);
      }
      const plans = codexListed ? await flows.planRefreshAll(config, ids, codexListed) : basePlans;
      const ready = plans.filter((p) => !p.skip && p.changes.length > 0);
      if (ready.length === 0) {
        log(plans.map((p) => `- ${p.agent}: ${p.skip ?? "无变化"}`));
        return;
      }
      const detail = ready.map((p) => `${p.agent}: ${p.changes.join("; ")}`).join("\n");
      const ok = await confirmDialogAsync(
        `将刷新 ${ready.length} 个已接入 Agent 的模型列表:\n${detail}\n\n只写模型相关配置,不改 base_url / 密钥 / 默认模型;各自文件被外部改动过时自动备份(.bak-*),确认?`,
      );
      if (!ok) return;
      log(await flows.applyRefreshPlans(plans));
      await persistConfig().catch(() => {});
      for (const a of ["codex", "dsh", "omp", "reasonix", "opencode", "grok"]) void detectAgentConfigOne(a);
    }),
  );
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/** 开机自启初始化:查询系统侧真实状态回填 header 开关。自启由 OS 持有(LaunchAgent/注册表),不入 AppConfig。 */
async function initAutostart(): Promise<void> {
  const box = $("chk-autostart") as HTMLInputElement;
  try {
    box.checked = await autostartIsEnabled();
  } catch {
    // 查询失败(如平台不支持):保持关闭,切换时会再次报错
  }
}

async function boot(): Promise<void> {
  // 全局兜底:任何未捕获的异步错误都在输出面板可见
  window.addEventListener("unhandledrejection", (ev) => {
    notify(`未处理的错误: ${ev.reason}`, "error");
  });
  // 关闭 webview 右键默认菜单(Reload/返回等)
  document.addEventListener("contextmenu", (e) => e.preventDefault());
  // ESC 只关闭最上层弹窗(确认/编辑弹窗叠加在还原弹窗上时逐层退出);
  // Promise 弹窗(确认/模型选择)走各自的关闭回调,保证 await 能结算
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const overlays = document.querySelectorAll(".modal-overlay");
      const top = overlays[overlays.length - 1] as El | undefined;
      if (!top) return;
      const dismiss = overlayDismissers.get(top);
      if (dismiss) dismiss();
      else top.remove();
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
  syncCardLock(); // 初始锁定模型列表/工具接入(避免加载配置前可交互)
  initAutostart(); // 开机自启开关:回填系统侧真实状态
  // 升级/安装日志流:逐行写入底部日志面板
  void bridge.onAgentUpdateLog((line) => log([line], "info"));
  // 启动后异步检测各 agent CLI 安装情况(徽标)
  void detectAgents();
  // 启动后异步检查各 agent 可升级状态(橙色↑图标)
  void checkAgentUpdates();
  // 版本号跟随应用版本(发版时由 CI 写入 tauri.conf.json,显示即 tag 版本)
  try {
    const vEl = document.getElementById("app-version");
    if (vEl) vEl.textContent = `v${await bridge.appVersion()}`;
  } catch {
    // 忽略:版本获取失败时保留占位
  }
  // 检查 App 自身更新(有新版才显示提示)
  void checkAppUpdate(true);
  // 窗口从托盘/后台恢复可见或获得焦点时重查(30 分钟节流):长驻实例(关窗仅隐藏、
  // 自启 --background)不重启也能拿到最新版本状态
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkAppUpdate();
  });
  window.addEventListener("focus", () => void checkAppUpdate());
  try {
    config = await bridge.loadAppConfig();
    fillForm(config);
  } catch {
    // 使用默认配置
  }
  renderProviderSelect(); // Provider 下拉:按已保存的配置列表(旧版单 provider 配置自动迁移为一条)
  // Header 开关/端口与配置同步(默认开启;端口固定展示)
  const proxySw = document.getElementById("chk-proxy-switch") as HTMLInputElement | null;
  if (proxySw) proxySw.checked = config.codexProxy?.enabled ?? true;
  void bridge
    .proxyStatus()
    .then((p) => {
      if (p.running && p.codexHost) updateProxyBadge(p.codexHost, p.port);
    })
    .catch(() => {});
  // Codex 转换代理自愈:开启代理模式时,若上次拉起的代理进程已退出(重启机器/异常退出),
  // 启动本 app 即自动按当前网关配置重新拉起,保证 Codex 随时可用。
  if ((config.codexProxy?.enabled ?? true) && config.baseUrl) {
    const codexHome = await bridge.codexHome();
    void bridge
      .proxyStart(config.codexProxy?.port ?? 17321, config.baseUrl, CODX_PROXY_CONVERT_PATTERN, await bridge.joinPath(codexHome, "models.json"))
      .then((st) => {
        updateProxyBadge(st.codexHost, st.port);
        if (st.hijackWarning) console.warn("[codex-proxy]", st.hijackWarning);
      })
      .catch(() => {
        // 静默:启动期代理拉起失败不阻塞 UI,重跑「配置」时会再次尝试并报错
      });
  }
  // 上次保存的模型列表先恢复(升级/刷新后不丢),随后再自动拉取刷新
  if (config.models && config.models.length > 0) {
    setModelRows(config.models);
  }
  // 首次打开:有上次保存的 Base URL 与 API Key 时自动拉取模型列表
  if (config.baseUrl && config.apiKey) {
    void run("自动拉取模型", async () => {
      await fetchAndRenderModels();
      await persistConfig().catch(() => {}); // 持久化最新模型列表(写入所属 profile)
    });
  }
  // 启动后异步检测各 agent 的配置一致性(方形徽标)
  void detectAgentConfigs();
  syncOnboarding();
}

void boot();
