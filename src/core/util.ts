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
