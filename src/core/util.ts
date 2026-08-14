// 通用工具:纯函数,不依赖 Node/DOM。

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 时间戳(用于备份文件名)。 */
export function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** 脱敏展示 token:保留首尾便于辨认。 */
export function maskToken(token: string): string {
  if (token.length <= 10) return "****";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/** 生成 URL 安全的随机 Token(32 字节 base64url,无 padding)。 */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * YAML 标量安全引号:安全字符(含空格)直接输出,否则按 JSON 双引号转义。
 * 排除含 `: `(冒号+空格)或 ` #`(空格+井号)的值——这两种会让 plain scalar 语义改变。
 */
export function yamlQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./:?=&%~+@ -]+$/.test(value) && !/: | #/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/** 反转 YAML 标量引号(仅用于状态展示)。 */
export function unquoteYaml(s: string): string {
  const v = s.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

// ---------------------------------------------------------------------------
// YAML 块定位(缩进感知的文本级补丁,dsh/omp 共用)
// ---------------------------------------------------------------------------

/** 在 [from, to) 区域内定位 `key:` 行(可限定缩进)。 */
export function findKeyInRegion(
  text: string,
  from: number,
  to: number,
  key: string,
  exactIndent?: number,
): { start: number; end: number; indent: number } | null {
  const region = text.slice(from, to);
  const re = new RegExp(`^( *)${escapeRegExp(key)}:(?:[ \\t]|$)`, "m");
  const m = re.exec(region);
  if (!m) return null;
  if (exactIndent !== undefined && m[1].length !== exactIndent) return null;
  const lineStart = from + m.index;
  const lineEnd = text.indexOf("\n", lineStart);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return { start: lineStart, end, indent: m[1].length };
}

/** 行尾后的下一个位置(跳过换行符)。 */
export function lineAfter(text: string, lineEnd: number): number {
  return lineEnd < text.length && text[lineEnd] === "\n" ? lineEnd + 1 : text.length;
}

/** 块体的结束位置:第一个缩进 <= blockIndent 的非空非注释行。 */
export function blockBodyEnd(text: string, bodyStart: number, blockIndent: number, limit: number): number {
  let pos = bodyStart;
  while (pos < limit) {
    const lineEnd = text.indexOf("\n", pos);
    const end = lineEnd === -1 ? limit : lineEnd + 1;
    const line = text.slice(pos, end);
    const content = line.trimStart();
    if (content.length > 0 && !content.startsWith("#")) {
      const indent = line.length - line.trimStart().length;
      if (indent <= blockIndent) return pos;
    }
    pos = end;
  }
  return limit;
}

/** 键行是否带内联值(flow style 等,直接报错要求手动编辑)。 */
export function headerHasInlineContent(text: string, headerStart: number, headerEnd: number): boolean {
  const line = text.slice(headerStart, headerEnd);
  const colonIdx = line.indexOf(":");
  const rest = line.slice(colonIdx + 1).trim();
  return rest.length > 0 && !rest.startsWith("#");
}
