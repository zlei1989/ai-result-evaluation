/**
 * 展示格式化：字节、时间、短哈希。
 * 原则：**任何非法输入都要有可读的兜底**，绝不让 NaN / Invalid Date 出现在界面上。
 */

/** 字节单位的档位；超出最后一档不再进位（避免出现没定义的 PB 等） */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 字节数 → 人类可读（1024 进制，保留一位小数）；负数与非有限数按 0 处理 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex];
  return unitIndex === 0 ? `${value} B` : `${value.toFixed(1)} ${unit}`;
}

/** 取哈希前 N 位；比 N 短时原样返回 */
export function shortHash(hash: string, length = 7): string {
  return hash.length <= length ? hash : hash.slice(0, length);
}

/**
 * ISO 8601 → 本地可读时间（YYYY-MM-DD HH:mm）。
 * 非法输入原样返回——显示 Invalid Date 比显示原始串更糟。
 */
export function formatDateTime(iso: string): string {
  if (iso === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
