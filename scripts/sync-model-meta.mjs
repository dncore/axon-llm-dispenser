// 从 canonical gist 拉取统一模型表(models.json),重新生成 src/core/models.ts 的
// KNOWN_MODELS 表段 + vendor 副本 scripts/model-meta.json。
//
// 用法: node scripts/sync-model-meta.mjs [--check]
//   默认   : 拉取 gist → 生成 → 写回表段与 vendor 副本
//   --check: 只对比不写回;有差异退出 1(CI 漂移门禁);网络不可达时用 vendor
//            副本本地重生成对比,仍能拦住「手改表段」类漂移(退出 0)
//
// canonical: https://gist.github.com/dncore/b8931f4ca3833698be0a4a091f91c0e2
// 表值口径与决策记录见 gist README(官方文档优先;overlay 如排除名单不入 canonical)。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GIST_ID = "b8931f4ca3833698be0a4a091f91c0e2";
const API_URL = `https://api.github.com/gists/${GIST_ID}`;
const TARGET = join(REPO, "src", "core", "models.ts");
const VENDOR = join(REPO, "scripts", "model-meta.json");
const BEGIN = "// @model-meta:begin";
const END = "// @model-meta:end";

const check = process.argv.includes("--check");

async function fetchCanonical() {
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "sync-model-meta" } });
    if (!res.ok) throw new Error(String(res.status));
    const gist = await res.json();
    const text = gist.files?.["models.json"]?.content;
    if (!text) throw new Error("gist 缺 models.json");
    let rev = gist.history?.[0]?.version?.slice(0, 8) ?? "";
    return { doc: JSON.parse(text), rev, online: true };
  } catch {
    return { doc: JSON.parse(readFileSync(VENDOR, "utf8")), rev: "", online: false };
  }
}

/** 值 → TS 字面量(裸键 + 单行对象,与 axon 表风格一致)。 */
function tsLiteral(v, key = false) {
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => tsLiteral(x)).join(", ")}]`;
  if (v === null || typeof v !== "object") return String(v);
  const parts = Object.entries(v).map(([k, val]) => {
    const id = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
    return `${id}: ${tsLiteral(val)}`;
  });
  return `{ ${parts.join(", ")} }`;
}

function renderTable(doc, rev) {
  const ids = Object.keys(doc.models);
  const head = [
    `${BEGIN} — 由 scripts/sync-model-meta.mjs 从 canonical gist 生成,勿手改`,
    // 头部只放 rev 与数量:内容不变则重生成逐字节稳定(--check 跨日不假红)
    `// canonical: gist ${GIST_ID.slice(0, 8)}${rev ? ` @ ${rev}` : ""} · ${ids.length} models`,
  ];
  const entries = ids.map((id) => `  ${tsLiteral(id)}: ${tsLiteral(doc.models[id])},`);
  return [...head, "const KNOWN_MODELS: Record<string, ModelMeta> = {", ...entries, "};", END].join("\n");
}

const src = readFileSync(TARGET, "utf8");
if (!src.includes("const KNOWN_MODELS")) throw new Error("models.ts 未找到 KNOWN_MODELS");

const { doc, rev, online } = await fetchCanonical();
const block = renderTable(doc, rev);
const vendorJson = JSON.stringify(doc, null, 2) + "\n";

let next;
if (src.includes(BEGIN) && src.includes(END)) {
  const begin = src.indexOf(BEGIN);
  const end = src.indexOf(END) + END.length;
  next = src.slice(0, begin) + block + src.slice(end);
} else {
  // 首次接线:定位原手写表(const 声明行到其闭合 "};" 行)整段替换
  const decl = src.indexOf("const KNOWN_MODELS");
  if (decl < 0) throw new Error("未找到 KNOWN_MODELS 声明");
  const close = src.indexOf("\n};", decl);
  if (close < 0) throw new Error("未找到表闭合");
  next = src.slice(0, decl) + block + src.slice(close + 3);
}

if (check) {
  if (next !== src) {
    console.log("❌ KNOWN_MODELS 表与 canonical gist 有漂移,运行 npm run sync:models 重新生成");
    process.exit(1);
  }
  if (readFileSync(VENDOR, "utf8") !== vendorJson) {
    console.log("❌ scripts/model-meta.json 与 gist 不一致,运行 npm run sync:models");
    process.exit(1);
  }
  console.log(`✅ 模型表与 canonical 一致(${online ? "gist 在线校验" : "离线,按 vendor 副本校验"})`);
  process.exit(0);
}

writeFileSync(TARGET, next);
writeFileSync(VENDOR, vendorJson);
console.log(`✓ 已生成(${online ? `gist ${rev}` : "离线 vendor 副本"},${Object.keys(doc.models).length} models)→ ${TARGET} + ${VENDOR}`);
