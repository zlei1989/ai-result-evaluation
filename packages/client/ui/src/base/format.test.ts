// @vitest-environment node
/** 展示格式化：字节、时间、短哈希。边界是重点（0 字节、负数、空串）。 */
import { describe, expect, it } from 'vitest';
import { formatBytes, formatDateTime, shortHash } from './format';

describe('formatBytes', () => {
  it('小于 1KB 时按字节显示', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('按 1024 进制换算并保留一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });

  it('负数与 NaN 不产生 NaN 文案', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('超出 TB 时不再进位（避免出现 PB 之类没定义的档）', () => {
    expect(formatBytes(1024 ** 5)).toContain('TB');
  });
});

describe('shortHash', () => {
  it('默认取前 7 位', () => {
    expect(shortHash('0123456789abcdef0123456789abcdef01234567')).toBe('0123456');
  });

  it('可指定长度', () => {
    expect(shortHash('0123456789abcdef', 4)).toBe('0123');
  });

  it('比长度更短时原样返回（不抛错）', () => {
    expect(shortHash('abc')).toBe('abc');
    expect(shortHash('', 7)).toBe('');
  });
});

describe('formatDateTime', () => {
  it('把 ISO 8601 转成本地可读时间，且包含年月日', () => {
    const out = formatDateTime('2026-09-22T10:30:00.000Z');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/\d{2}:\d{2}/);
    // 上面两条太松：把实现换成 `return iso`（原样返回）它们照样通过（ISO 串里也有 2026 与 10:30）。
    // 这条钉死**输出形状**YYYY-MM-DD HH:mm——不依赖本机时区，但排除原样返回 ISO / toISOString 这类实现。
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('非法输入原样返回，不显示 Invalid Date', () => {
    expect(formatDateTime('不是时间')).toBe('不是时间');
    expect(formatDateTime('')).toBe('');
  });
});
