// axon-llm-dispenser 前端入口:连接设置 + 工具接入 + 鉴权 + 状态。

import "./styles.css";
import * as bridge from "./bridge";
import * as flows from "./flows";

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

let config: bridge.AppConfig = {
  provider: "axon",
  displayName: "Axon",
  baseUrl: "",
  apiKey: "",
  defaultModel: "",
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
}

// ---------------------------------------------------------------------------
// 构建 UI
// ---------------------------------------------------------------------------

function build(): void {
  const root = $("app");

  root.append(
    h("header", { class: "header" }, [
      h("div", { class: "brand" }, [
        h("h1", {}, ["axon-llm-dispenser"]),
        h("span", { class: "subtitle" }, ["把自有的 OpenAI 兼容网关接入 Codex / Reasonix / DeepSeek Harness"]),
      ]),
      h("div", { class: "header-actions" }, [
        h("span", { class: "version" }, [`v${APP_VERSION}`]),
        h("button", { id: "btn-update", class: "btn btn-ghost" }, ["检查更新"]),
      ]),
    ]),

    h("main", { class: "main" }, [
      h("section", { class: "card" }, [
        h("h2", {}, ["连接设置"]),
        h("div", { class: "grid2" }, [
          field("Provider 名", "input-provider", "用于各工具中的路由名(默认 axon)", "axon"),
          field("显示名", "input-display", "配置界面展示名", "Axon"),
        ]),
        field("Base URL", "input-base", "OpenAI 兼容网关地址,如 https://gateway.example/v1", ""),
        field("API Key", "input-key", "网关凭据", "", "password"),
        h("div", { class: "row" }, [
          h("button", { id: "btn-test", class: "btn" }, ["测试连接"]),
          h("button", { id: "btn-save", class: "btn btn-ghost" }, ["保存配置"]),
          h("span", { id: "conn-status", class: "hint" }, []),
        ]),
      ]),

      h("section", { class: "card" }, [
        h("h2", {}, ["模型目录"]),
        h("div", { class: "row" }, [
          h("button", { id: "btn-fetch", class: "btn" }, ["拉取模型(/models)"]),
          h("span", { id: "model-count", class: "hint" }, []),
        ]),
        h("textarea", { id: "models", class: "models", placeholder: "每行一个模型 ID;可手动增删。点击「拉取模型」自动填充。" }, []),
      ]),

      h("section", { class: "card" }, [
        h("h2", {}, ["工具接入"]),
        toolCard("codex", "Codex", ["配置", "状态"]),
        toolCard("reasonix", "Reasonix", ["配置", "状态", "生成 Token", "关闭鉴权"]),
        toolCard("dsh", "DeepSeek Harness (dsh)", ["配置", "状态"]),
      ]),

      h("section", { class: "card" }, [
        h("h2", {}, ["输出"]),
        h("div", { id: "output", class: "output" }, [
          h("div", { class: "log-empty" }, ["操作结果会显示在这里"]),
        ]),
      ]),
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

function toolCard(id: string, name: string, actions: string[]): El {
  const buttons = actions.map((a) => h("button", { class: "btn btn-small", id: `btn-${id}-${a}` }, [a]));
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
}

function readModelIds(): string[] {
  return ($("models") as HTMLTextAreaElement).value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  const ids = readModelIds();
  if (ids.length === 0) {
    notify("模型列表为空,请先「拉取模型」或手动输入", "error");
    return null;
  }
  return ids;
}

function bind(): void {
  $("btn-save").addEventListener("click", async () => {
    readFields();
    if (!config.baseUrl && !config.apiKey) {
      notify("Base URL 与 API Key 为空,未保存", "error");
      return;
    }
    const path = await bridge.saveAppConfig(config);
    notify(`配置已保存: ${path}`);
  });

  $("btn-test").addEventListener("click", async () => {
    readFields();
    if (!config.baseUrl) return notify("请先填写 Base URL", "error");
    const s = $("conn-status");
    s.textContent = "连接中…";
    try {
      const ids = await flows.testConnection(config.baseUrl, config.apiKey);
      ($("models") as HTMLTextAreaElement).value = ids.join("\n");
      $("model-count").textContent = `${ids.length} 个模型`;
      s.textContent = "连接成功";
      notify(`连接成功,拉取到 ${ids.length} 个模型`, "info");
    } catch (e) {
      s.textContent = "连接失败";
      notify(`连接失败: ${e}`, "error");
    }
  });

  $("btn-fetch").addEventListener("click", () => $("btn-test").click());

  $("btn-codex-配置").addEventListener("click", async () => {
    readFields();
    if (!validateProvider()) return;
    const ids = await ensureModels();
    if (!ids) return;
    try {
      const r = await flows.configureCodex(config, ids);
      log(r.lines);
    } catch (e) {
      notify(`Codex 配置失败: ${e}`, "error");
    }
  });

  $("btn-codex-状态").addEventListener("click", async () => {
    log(await flows.codexStatus());
  });

  $("btn-reasonix-配置").addEventListener("click", async () => {
    readFields();
    if (!validateProvider()) return;
    const ids = await ensureModels();
    if (!ids) return;
    try {
      const r = await flows.configureReasonix(config, ids);
      log(r.lines);
    } catch (e) {
      notify(`Reasonix 配置失败: ${e}`, "error");
    }
  });

  $("btn-reasonix-状态").addEventListener("click", async () => {
    readFields();
    log(await flows.reasonixStatus(config));
  });

  $("btn-reasonix-生成 Token").addEventListener("click", async () => {
    const ok = confirm("将生成新的固定鉴权 Token 并写入 Reasonix [serve] 段(覆盖旧 Token,原文件自动备份),确认?");
    if (!ok) return;
    try {
      const r = await flows.generateReasonixAuth();
      log(r.lines);
    } catch (e) {
      notify(`生成 Token 失败: ${e}`, "error");
    }
  });

  $("btn-reasonix-关闭鉴权").addEventListener("click", async () => {
    const ok = confirm("将 Reasonix 鉴权改回 auth_mode=none 并移除 token,确认?");
    if (!ok) return;
    try {
      const r = await flows.disableReasonixAuth();
      log(r.lines);
    } catch (e) {
      notify(`关闭鉴权失败: ${e}`, "error");
    }
  });

  $("btn-dsh-配置").addEventListener("click", async () => {
    readFields();
    if (!validateProvider()) return;
    const ids = await ensureModels();
    if (!ids) return;
    try {
      const r = await flows.configureDsh(config, ids);
      log(r.lines);
    } catch (e) {
      notify(`dsh 配置失败: ${e}`, "error");
    }
  });

  $("btn-dsh-状态").addEventListener("click", async () => {
    readFields();
    log(await flows.dshStatus(config));
  });

  $("btn-update").addEventListener("click", async () => {
    try {
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
    } catch (e) {
      notify(`检查更新失败: ${e}`, "error");
    }
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  build();
  bind();
  try {
    config = await bridge.loadAppConfig();
    ($("input-provider") as HTMLInputElement).value = config.provider;
    ($("input-display") as HTMLInputElement).value = config.displayName;
    ($("input-base") as HTMLInputElement).value = config.baseUrl;
    ($("input-key") as HTMLInputElement).value = config.apiKey;
  } catch {
    // 使用默认配置
  }
}

void boot();
