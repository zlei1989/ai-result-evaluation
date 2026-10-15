// @vitest-environment node
/**
 * 路径归属判据（`isInside`）：技能预览与候选产物读取共用的「第二道门」。
 *
 * 为什么单独一组：它是**字符串前缀比较**，而前缀比较最容易漏的那一格是
 * 「同名前缀的兄弟目录」（`/a/b` 与 `/a/bc`）——漏了它，一个越界路径会被判成「在根之内」，
 * 而这件事在真机上只在特定的软链现场才看得见。分隔符用 `node:path` 的 `sep` 拼，
 * 故本用例跟着平台走（本仓的 CI 与开发机都是 POSIX）。
 */
import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside } from './path-inside';

describe('isInside', () => {
  it('根本身算在内（调用方拿它判「目标就是根」这一档）', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
  });

  it('子路径在内（一层与多层都算）', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b/c/d.md')).toBe(true);
  });

  it('同名前缀的兄弟目录在外（`/a/b` 不含 `/a/bc`）', () => {
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a/bc/d')).toBe(false);
  });

  it('父路径、绝对路径与其它树都在外', () => {
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/a/b', '/')).toBe(false);
    expect(isInside('/a/b', '/other/b')).toBe(false);
  });

  it('根带尾分隔符时也成立（`realpath` 的返回值在根目录上可能带 `/`）', () => {
    expect(isInside(`/a/b${sep}`, '/a/b/c')).toBe(true);
  });
});
