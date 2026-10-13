// @vitest-environment node
/**
 * 共享匹配器的判据表：**先精确、再归一化**，撞名不归到具体哪一台。
 *
 * 这张表是「带连字符的服务器名判成没连上」那类假失败的唯一防线，也是「把 A 的工具记到 B 头上」
 * 那类假绿的唯一防线——两边各有一条用例，缺哪条都只剩一半。
 */
import { describe, expect, it } from 'vitest';
import { collidingMcpServerNames, matchMcpToolName, normalizeMcpName } from './mcp-tool-name';

describe('normalizeMcpName', () => {
  it('只改写 [A-Za-z0-9_] 之外的字符（`-` ⇒ `_`），且幂等', () => {
    expect(normalizeMcpName('my-server')).toBe('my_server');
    expect(normalizeMcpName('my_server')).toBe('my_server');
    expect(normalizeMcpName('my.server')).toBe('my_server');
    expect(normalizeMcpName(normalizeMcpName('a-b.c'))).toBe(normalizeMcpName('a-b.c'));
  });
});

describe('matchMcpToolName', () => {
  it('厂商 sanitize 过的形态也认（`my-server` 配 `mcp__my_server__echo` ⇒ 命中）', () => {
    expect(matchMcpToolName('my-server', ['Read', 'mcp__my_server__echo'])).toEqual({
      tool: 'mcp__my_server__echo',
      form: 'normalized',
    });
  });

  it('原样保留的家照旧精确命中（cc / dsh：`mcp__my-server__echo`）', () => {
    expect(matchMcpToolName('my-server', ['mcp__my-server__echo'])).toEqual({
      tool: 'mcp__my-server__echo',
      form: 'exact',
    });
  });

  it('前缀必须整段（`mcp__<name>__`）：隔壁那台的工具不给这一台记账', () => {
    expect(matchMcpToolName('playwright', ['mcp__playwright-extra__x'])).toBeNull();
    expect(matchMcpToolName('playwright', ['mcp__playwright__browser_navigate'])).not.toBeNull();
  });

  it('表缺席（`null`）与空表都不命中——「没有证据」不等于「有」', () => {
    expect(matchMcpToolName('probe', null)).toBeNull();
    expect(matchMcpToolName('probe', [])).toBeNull();
  });

  it('精确命中优先于归一化：撞名时原始名的那一台不会被抢走', () => {
    const tools = ['mcp__my_server__echo'];
    expect(matchMcpToolName('my_server', tools, true)?.form).toBe('exact');
    // 同一个表里另一台只有归一化形态可认，撞名时**不许**认下来
    expect(matchMcpToolName('my-server', tools, true)).toBeNull();
  });
});

describe('collidingMcpServerNames', () => {
  it('归一化后同形的两台都算撞名（`-` 与 `_` 并存是合法配置，不是配置错误）', () => {
    expect([...collidingMcpServerNames(['my-server', 'my_server', 'other'])]).toEqual(['my-server', 'my_server']);
    expect(collidingMcpServerNames(['probe', 'other']).size).toBe(0);
  });
});
