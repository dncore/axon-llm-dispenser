// 备份文件分类与清理规划(纯函数):区分「本 app 自动生成的备份」与「用户重命名保留的备份」,
// 只对前者做上限轮转式的清理规划,后者一律不动。

import { escapeRegExp } from "./util";

/** 自动备份保留数(超出部分可清理;手动重命名的备份不受影响)。 */
export const BACKUP_KEEP_AUTO = 10;

/**
 * 是否为本 app 自动生成的备份名:
 * `<base>.bak-YYYYMMDDHHMMSS`(现行)或 `<base>.bak-pre-restore-YYYYMMDDHHMMSS`(还原前快照),
 * 兼容旧版带短横线的时间戳(`.bak-20260810-172613`)。
 */
export function isAutoBackupName(base: string, name: string): boolean {
  return new RegExp(`^${escapeRegExp(base)}\\.bak-(?:pre-restore-)?\\d{8}-?\\d{6}$`).test(name);
}

/** 按时间倒序的自动备份里,超出保留数的条目(应删除的候选)。 */
export function pickStaleAutoBackups<T extends { name: string; mtimeMs: number }>(
  files: T[],
  base: string,
  keep = BACKUP_KEEP_AUTO,
): T[] {
  const autos = files
    .filter((f) => isAutoBackupName(base, f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return autos.slice(Math.max(0, keep));
}
