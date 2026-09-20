// UI 冒烟测试:无头 Chrome + CDP,在真实构建产物上跑交互断言(mock 掉 Tauri IPC)。
// 覆盖 Codex 可见模型上限(8):超限弹选择框、上限内勾选、写盘可见性、主动改选、ESC 取消、
// 不超限不打扰、新增模型再次触发。用法:npm run smoke:ui(先构建 dist)。
//
// 只依赖 Node 20+(内置 WebSocket)与系统 Chrome/Chromium(可用 CHROME_BIN 指定路径)。

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIST = join(ROOT, "dist");

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    console.error("✗ 未找到 Chrome/Chromium。用 CHROME_BIN=/path/to/chrome npm run smoke:ui 指定。");
    process.exit(1);
  }
  return found;
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function freePort() {
  return await new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** 把 dist 拷到临时目录并注入 mock.js(module 之前,普通脚本同步执行)。 */
async function prepareWebRoot(tmp) {
  const webRoot = join(tmp, "web");
  await mkdir(webRoot, { recursive: true });
  await cp(DIST, webRoot, { recursive: true });
  const html = await readFile(join(webRoot, "index.html"), "utf8");
  if (!html.includes('<script type="module"')) throw new Error("dist/index.html 结构变化:找不到 module 脚本");
  await writeFile(join(webRoot, "index.html"), html.replace('<script type="module"', '<script src="/mock.js"></script>\n    <script type="module"'));
  await cp(join(HERE, "mock.js"), join(webRoot, "mock.js"));
  return webRoot;
}

function serve(webRoot, port) {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = join(webRoot, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(webRoot)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((res) => server.listen(port, "127.0.0.1", () => res(server)));
}

async function connectCdp(cdpPort, pageUrl) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && (t.url || "").includes(pageUrl));
      if (page?.webSocketDebuggerUrl) return await wsConnect(page.webSocketDebuggerUrl);
    } catch {
      // Chrome 还没起来
    }
    await sleep(100);
  }
  throw new Error("无法连接到 Chrome 调试端口");
}

async function wsConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error("页面异常: " + (r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails)));
    return r.result?.result?.value;
  };
  const waitFor = async (expression, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        // reload 期间执行上下文销毁:重试
      }
      await sleep(80);
    }
    return false;
  };
  return { send, evaluate, waitFor, close: () => ws.close() };
}

// ---------------------------------------------------------------------------
// 页面内断言片段
// ---------------------------------------------------------------------------

const PICKER_ROWS = `[...document.querySelectorAll('.picker-row')].map(r => ({
  id: r.querySelector('.picker-id').textContent,
  checked: r.querySelector('input').checked,
  disabled: r.querySelector('input').disabled,
  isDefault: !!r.querySelector('.model-row-owner'),
}))`;
const PICKER_STATE = `(() => {
  const ov = [...document.querySelectorAll('.modal-overlay')].pop();
  return ov ? {
    title: ov.querySelector('h3')?.textContent ?? '',
    counter: ov.querySelector('.picker-counter')?.textContent ?? '',
    buttons: [...ov.querySelectorAll('.modal-footer button')].map(b => ({ text: b.textContent, disabled: b.hasAttribute('disabled') })),
  } : null;
})()`;
const CLICK_MODAL_BTN = (prefix) => `(() => {
  const ov = [...document.querySelectorAll('.modal-overlay')].pop();
  const btn = [...ov.querySelectorAll('.modal-footer button')].find(b => b.textContent.startsWith(${JSON.stringify(prefix)}));
  btn.click();
  return btn.textContent;
})()`;
const LOGS = `[...document.querySelectorAll('#output .log-block div')].map(d => d.textContent)`;
const MODELS_JSON = `(() => {
  const c = JSON.parse(window.__MOCK__.fs['/mock/home/.codex/models.json']);
  return {
    total: c.models.length,
    listed: c.models.filter(m => m.visibility === 'list').map(m => m.slug),
    hidden: c.models.filter(m => m.visibility === 'hide').map(m => m.slug),
    hiddenHasMeta: c.models.filter(m => m.visibility === 'hide').every(m => typeof m.context_window === 'number' && !!m.description),
    providers: [...new Set(c.models.map(m => (m.description || '').split(':')[0]))],
  };
})()`;
const TOGGLE_ROW = (slug, on) => `(() => {
  const r = [...document.querySelectorAll('.picker-row')].find(x => x.querySelector('.picker-id').textContent === ${JSON.stringify(slug)});
  const box = r.querySelector('input'); box.checked = ${on}; box.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;
const SET_FILTER = (value) => `(() => {
  const f = document.querySelector('.picker-filter'); f.value = ${JSON.stringify(value)};
  f.dispatchEvent(new Event('input', { bubbles: true })); return true;
})()`;

const EXPECTED_SEED = ["deepseek-v4-flash", "glm-5.3", "kimi-k3", "qwen3.8-max", "gemini-3.7-flash", "claude-sonnet-5", "grok-4.6", "deepseek-v4-pro"];
const eqSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

async function runScenarios(cdp) {
  const { evaluate, waitFor } = cdp;
  await evaluate(`location.reload()`).catch(() => {});
  await sleep(1200);

  // 启动:自动拉取模型 + Doubao 过滤
  check("启动:自动拉取网关模型并过滤 doubao", await waitFor(`document.getElementById('model-count')?.textContent === '15 个模型'`), await evaluate(`document.getElementById('model-count')?.textContent`));

  // 「配置」超上限 → 自动弹选择框
  await evaluate(`document.getElementById('btn-codex-配置').click()`);
  check("配置超上限:弹出可见模型选择框", await waitFor(`!!document.querySelector('.picker-row')`));
  const st = await evaluate(PICKER_STATE);
  check("标题与计数:x/8", st.title.includes("最多 8 个") && st.counter === "已选 8/8", `${st.title} / ${st.counter}`);
  const rows = await evaluate(PICKER_ROWS);
  check("候选=网关模型(已过滤 doubao)", rows.length === 15 && !rows.some((r) => r.id.includes("doubao")), `${rows.length} 行`);
  check("预选=既有可见集合,默认模型置首进入预选", eqSet(rows.filter((r) => r.checked).map((r) => r.id), EXPECTED_SEED) && rows.find((r) => r.id === "deepseek-v4-flash").isDefault);
  check("达上限后未勾选行禁用", rows.filter((r) => !r.checked).every((r) => r.disabled));
  check("确认按钮带计数", st.buttons.some((b) => b.text === "确认(8/8)" && !b.disabled));

  // 勾选交互
  await evaluate(TOGGLE_ROW("glm-5.3", false));
  const st2 = await evaluate(PICKER_STATE);
  const rows2 = await evaluate(PICKER_ROWS);
  check("取消勾选 → 7/8 且其余解禁", st2.counter === "已选 7/8" && rows2.filter((r) => !r.checked).every((r) => !r.disabled), st2.counter);
  await evaluate(TOGGLE_ROW("glm-5.3", true));
  check("勾回 → 8/8 且重新禁用", (await evaluate(PICKER_STATE)).counter === "已选 8/8" && (await evaluate(PICKER_ROWS)).filter((r) => !r.checked).every((r) => r.disabled));

  // 搜索过滤
  await evaluate(SET_FILTER("glm"));
  const rows3 = await evaluate(PICKER_ROWS);
  check("搜索过滤", rows3.length === 2 && rows3.every((r) => r.id.includes("glm")), rows3.map((r) => r.id).join(","));
  await evaluate(SET_FILTER(""));
  check("清空搜索恢复全部行", (await evaluate(PICKER_ROWS)).length === 15);

  // 确认 → 配置确认 → 写盘
  const writesBefore = await evaluate(`window.__MOCK__.writes.length`);
  await evaluate(CLICK_MODAL_BTN("确认("));
  await waitFor(`!document.querySelector('.picker-row')`);
  check("选择框关闭后接原确认框", (await evaluate(PICKER_STATE))?.buttons.some((b) => b.text === "确认"));
  await evaluate(CLICK_MODAL_BTN("确认"));
  await waitFor(`window.__MOCK__.writes.length > ${writesBefore}`);
  const written = await evaluate(MODELS_JSON);
  check("写盘:条目全保留,可见 8 / 隐藏 7", written.total === 15 && written.listed.length === 8 && written.hidden.length === 7);
  check("可见集合=用户选择", eqSet(written.listed, EXPECTED_SEED));
  check("隐藏条目保留完整元数据", written.hiddenHasMeta);
  check("旧工具/改名前的条目被接管(单一 description 前缀)", written.providers.length === 1 && written.providers[0] === "axon", JSON.stringify(written.providers));
  check("config.toml 一并写入(配置流程)", (await evaluate(`window.__MOCK__.writes.filter(w => w.path.endsWith('.codex/config.toml')).map(w => w.content).pop() ?? ''`)).includes("[model_providers.axon]"));
  const modelsLine = (await evaluate(LOGS)).find((l) => l.startsWith("models.json:")) ?? "";
  check("日志显示可见/隐藏与上限", modelsLine.includes("可见 8 / 隐藏 7") && modelsLine.includes("上限 8"), modelsLine);

  // 「选模型」主动改选 + ESC 取消
  await evaluate(`document.getElementById('btn-codex-选模型').click()`);
  check("「选模型」打开选择框", await waitFor(`!!document.querySelector('.picker-row')`));
  const rows5 = await evaluate(PICKER_ROWS);
  check("预选=当前 models.json 的可见集合", rows5.length === 15 && eqSet(rows5.filter((r) => r.checked).map((r) => r.id), EXPECTED_SEED));
  const writesBeforeEsc = await evaluate(`window.__MOCK__.writes.length`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  check("ESC 关闭且不写盘", (await evaluate(`!document.querySelector('.picker-row')`)) && (await evaluate(`window.__MOCK__.writes.length`)) === writesBeforeEsc);
  await evaluate(`document.getElementById('btn-codex-状态').click()`);
  check("ESC 后流程正常结算", await waitFor(`[...document.querySelectorAll('#output .log-block div')].some(d => d.textContent.includes('models.json: 15 条'))`));

  // 不超上限:刷新不打扰
  const writesBeforeRefresh = await evaluate(`window.__MOCK__.writes.length`);
  await evaluate(`document.getElementById('btn-codex-刷新模型').click()`);
  await waitFor(`[...document.querySelectorAll('#output .log-block div')].some(d => d.textContent.includes('模型列表已是最新'))`);
  check("不超上限:刷新不弹框、不写盘", !(await evaluate(`!!document.querySelector('.picker-row')`)) && (await evaluate(`window.__MOCK__.writes.length`)) === writesBeforeRefresh);

  // 批量刷新
  await evaluate(`document.getElementById('btn-refresh-all-models').click()`);
  await waitFor(`[...document.querySelectorAll('#output .log-block div')].some(d => d.textContent.startsWith('- Codex:'))`);
  const batchLines = (await evaluate(LOGS)).filter((l) => l.startsWith("- "));
  check("批量刷新:Codex 无变化,其余各自跳过", batchLines.includes("- Codex: 无变化") && batchLines.length >= 6, batchLines.join(" | "));

  // 网关新增模型 → 再次触发
  await evaluate(`(() => { window.__MOCK__.gatewayModels.push('grok-5'); document.getElementById('btn-fetch').click(); return true; })()`);
  await waitFor(`document.getElementById('model-count')?.textContent === '16 个模型'`);
  await evaluate(`document.getElementById('btn-codex-刷新模型').click()`);
  check("新增模型导致超限:再次弹出", await waitFor(`!!document.querySelector('.picker-row')`));
  const rows8 = await evaluate(PICKER_ROWS);
  check("新模型未勾选且被上限禁用,既有 8 个保持预选",
    (await evaluate(PICKER_STATE)).counter === "已选 8/8" && eqSet(rows8.filter((r) => r.checked).map((r) => r.id), EXPECTED_SEED) && rows8.find((r) => r.id === "grok-5").disabled);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
}

// ---------------------------------------------------------------------------

const tmp = join(tmpdir(), `axon-ui-smoke-${Date.now()}`);
let chrome;
let server;
try {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("dist/ 不存在,先跑 npm run build");
  const chromeBin = findChrome();
  const webPort = await freePort();
  const cdpPort = await freePort();
  const webRoot = await prepareWebRoot(tmp);
  server = await serve(webRoot, webPort);
  const pageUrl = `http://127.0.0.1:${webPort}/index.html`;
  chrome = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(tmp, "chrome-profile")}`, pageUrl,
  ], { stdio: "ignore" });

  const cdp = await connectCdp(cdpPort, `127.0.0.1:${webPort}`);
  await runScenarios(cdp);
  cdp.close();
} catch (e) {
  check("冒烟测试执行", false, e instanceof Error ? e.message : String(e));
} finally {
  chrome?.kill("SIGKILL");
  server?.close();
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败:\n" + failed.map((f) => `- ${f.name}${f.detail ? ` (${f.detail})` : ""}`).join("\n"));
  process.exit(1);
}
