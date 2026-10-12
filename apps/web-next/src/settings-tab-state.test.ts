// @vitest-environment node
/**
 * 设置页 Tab 的 URL 状态机：`?tab=` 解析的合法值 / 脏 URL 回落，与反向构造的规范写法。
 *
 * 页面那一侧没有渲染测试面（`apps/web-next` 保留 `jsx: preserve`），受控 `activeKey` 喂的是
 * 这两个纯函数的输出——「脏 URL 不白屏」「默认态只有一个写法」这两条边界只有这里钉得住。
 */
import { describe, expect, it } from 'vitest';
import { parseSettingsTab, settingsTabHref, type SettingsTabKey } from './settings-tab-state';

describe('parseSettingsTab', () => {
  it('四个合法值原样返回（与页面 Tabs 的 key 一一对应）', () => {
    const keys: SettingsTabKey[] = ['basic', 'judge', 'mcp', 'skills'];
    for (const key of keys) {
      expect(parseSettingsTab(`tab=${key}`)).toBe(key);
    }
  });

  it('没有 tab 参数 → null（默认激活第一个 Tab「基础」）', () => {
    expect(parseSettingsTab('')).toBe(null);
    expect(parseSettingsTab('id=1')).toBe(null);
  });

  it('未知值回落 null：脏 URL 不白屏，与不给 activeKey 时的 antd 默认行为一致', () => {
    expect(parseSettingsTab('tab=workspace')).toBe(null);
    expect(parseSettingsTab('tab=foo')).toBe(null);
    // 大小写敏感：宽松匹配会让同一个地址出现两种写法
    expect(parseSettingsTab('tab=MCP')).toBe(null);
    expect(parseSettingsTab('tab=')).toBe(null);
  });

  it('URLSearchParams 实例与字符串两种入参同一结果（页面喂的是前者）', () => {
    expect(parseSettingsTab(new URLSearchParams('tab=judge'))).toBe('judge');
    expect(parseSettingsTab(new URLSearchParams('tab=zzz'))).toBe(null);
    expect(parseSettingsTab(new URLSearchParams(''))).toBe(null);
  });

  it('只认第一个 tab 值（重复参数按 URLSearchParams.get 的语义）', () => {
    expect(parseSettingsTab('tab=mcp&tab=skills')).toBe('mcp');
  });
});

describe('settingsTabHref', () => {
  it('null（URL 里没有合法 tab）→ 裸 /settings', () => {
    expect(settingsTabHref(null)).toBe('/settings');
  });

  it('basic 也给裸 /settings：默认态的规范写法只有一种，不保留 ?tab=basic', () => {
    expect(settingsTabHref('basic')).toBe('/settings');
  });

  it('非默认 Tab 带上查询串，值可直接分享（四个 key 都是安全字符，无需编码）', () => {
    expect(settingsTabHref('judge')).toBe('/settings?tab=judge');
    expect(settingsTabHref('mcp')).toBe('/settings?tab=mcp');
    expect(settingsTabHref('skills')).toBe('/settings?tab=skills');
  });

  it('往返一致：href 产出的查询串解析回同一个 Tab', () => {
    for (const key of ['judge', 'mcp', 'skills'] as SettingsTabKey[]) {
      const query = settingsTabHref(key).split('?')[1] ?? '';
      expect(parseSettingsTab(query)).toBe(key);
    }
    // basic 与 null 都清参（上面的用例钉了两种写法同为裸 /settings），
    // 裸地址解析回 null —— 两种默认写法在解析侧等价，都回落第一个 Tab
    expect(parseSettingsTab('')).toBe(null);
  });
});
