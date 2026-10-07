// @vitest-environment node
/**
 * 评测页的 URL 状态解析（纯函数）。
 * URL 是右栏状态的唯一真源（刷新与分享都能回到同一屏），所以「脏 URL 怎么办」必须在这里定死：
 * 未知 `panel`、空 `id`、`panel=detail` / `edit` 但没有 id —— 一律回落到「不显示右栏」，
 * 绝不抛错、也绝不半开半合地渲染一条空右栏（那正是 ListDetailLayout 文件头警告的形态）。
 */
import { describe, expect, it } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { describeError, parseRunsPanel, runsPanelHref } from './runs-view';

describe('parseRunsPanel', () => {
  it.each([
    ['?panel=detail&id=run-1', { panel: 'detail', id: 'run-1' }],
    ['?panel=new', { panel: 'new', id: null }],
    // 创建表单不需要 id：带上也忽略
    ['?panel=new&id=run-1', { panel: 'new', id: null }],
    ['?panel=edit&id=run-1', { panel: 'edit', id: 'run-1' }],
    // 编辑没有 id 等于没打开右栏（与 detail 同一条回落：半开的右栏是 ListDetailLayout 警告的形态）
    ['?panel=edit', { panel: null, id: null }],
    ['?panel=edit&id=', { panel: null, id: null }],
    // 只有 id：当成详情（老链接/手敲 URL 的常见形态）
    ['?id=run-1', { panel: 'detail', id: 'run-1' }],
    // 空串 id 等于没给
    ['?panel=detail&id=', { panel: null, id: null }],
    ['?panel=detail', { panel: null, id: null }],
    // 未知 panel：有 id 当详情，没有就当没打开右栏
    ['?panel=foo&id=run-1', { panel: 'detail', id: 'run-1' }],
    ['?panel=foo', { panel: null, id: null }],
    ['', { panel: null, id: null }],
  ])('%s → %o', (search, expected) => {
    expect(parseRunsPanel(search)).toEqual(expected);
  });

  it('接受 URLSearchParams（页面里就是这么传的）', () => {
    expect(parseRunsPanel(new URLSearchParams('panel=detail&id=run-9'))).toEqual({ panel: 'detail', id: 'run-9' });
  });
});

describe('runsPanelHref', () => {
  it('四种状态各有稳定的 URL', () => {
    expect(runsPanelHref(null, null)).toBe('/runs');
    expect(runsPanelHref('new', null)).toBe('/runs?panel=new');
    expect(runsPanelHref('detail', 'run-1')).toBe('/runs?panel=detail&id=run-1');
    // detail 但没 id ⇒ 回落到「不显示右栏」，不留一个半开的 URL
    expect(runsPanelHref('detail', null)).toBe('/runs');
    expect(runsPanelHref('edit', 'run-1')).toBe('/runs?panel=edit&id=run-1');
    // 与 detail 同一条回落：编辑也必须有一个明确的轮次
    expect(runsPanelHref('edit', null)).toBe('/runs');
  });

  it('id 会被转义（不假设 id 永远只有 UUID 字符）', () => {
    expect(runsPanelHref('detail', 'a b&c')).toBe('/runs?panel=detail&id=a%20b%26c');
  });
});

describe('describeError', () => {
  it('ServiceError 用它的中文 message（契约要求 message 可直接展示）', () => {
    expect(describeError(new ServiceError('CONFLICT', '这一轮没有可执行的候选行：全部行都已评分'))).toBe(
      '这一轮没有可执行的候选行：全部行都已评分',
    );
  });

  it('其它抛出物兜底成一句中文，不透英文内部错误', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toBe('操作失败，请稍后重试');
    expect(describeError('字符串')).toBe('操作失败，请稍后重试');
  });
});
