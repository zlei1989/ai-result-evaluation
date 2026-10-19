/**
 * 命令面板的**数据门**：收起状态下不读列表，第一次打开之后才挂列表来源。
 *
 * 为什么要专门钉这一条：面板挂在应用根（全站可见），而用例 / 评测列表要走接口。
 * 没有门的话，`/settings`、`/dev/agent-log` 这些本来不碰用例 / 评测的路由一进来就会
 * 发两份列表请求——「SWR 同键去重」只保证同一屏不重复发，管不了「本来不该发的也发了」。
 * 用例列表随用例数增长，这份开销在这些路由上是纯浪费，还会掩盖「某页自己忘了取数」。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { GatedCommandPalette, type CommandPaletteGroup } from './command-palette';
import { installResizeObserverStub } from '../testing/resize-observer';

installResizeObserverStub();
Element.prototype.scrollIntoView = () => {};

/** 不依赖网络的分组：导航项 */
const STATIC_GROUPS: CommandPaletteGroup[] = [
  {
    heading: '导航',
    items: [
      { id: 'nav-runs', label: '评测', href: '/runs' },
      { id: 'nav-cases', label: '用例', href: '/cases' },
      { id: 'nav-settings', label: '设置', href: '/settings' },
    ],
  },
];

/** 列表分组（用例）：模拟「打开后才去读」的那一份数据 */
const LIST_GROUP: CommandPaletteGroup = {
  heading: '用例',
  items: [{ id: 'case-1', label: '登录页改造', href: '/cases?panel=detail&id=c1' }],
};

/**
 * 造一个假列表来源：**被调用即计一次数**（等于「发了一次请求」），数据 30ms 后才给，
 * 用来验证「导航项先到、列表随后补」。
 */
function createListSource(load: () => void): () => CommandPaletteGroup[] {
  return function useListGroups(): CommandPaletteGroup[] {
    const [groups, setGroups] = useState<CommandPaletteGroup[]>([]);
    useEffect(() => {
      load();
      const timer = setTimeout(() => setGroups([LIST_GROUP]), 30);
      return () => clearTimeout(timer);
    }, []);
    return groups;
  };
}

function setup(): { load: ReturnType<typeof vi.fn> } {
  const load = vi.fn();
  render(
    <GatedCommandPalette
      staticGroups={STATIC_GROUPS}
      useListGroups={createListSource(load)}
      onSelect={vi.fn()}
    />,
  );
  return { load };
}

/** 用组合键唤起（挂在 document 上的全局监听） */
function pressPaletteShortcut(): void {
  fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
}

describe('GatedCommandPalette', () => {
  it('面板没被打开过之前，一个列表请求都不发（/settings 这类路由不吃这份开销）', () => {
    const { load } = setup();

    expect(load).not.toHaveBeenCalled();
    // 面板也没渲染出来：收起状态就是「什么都没发生」
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('第一次打开才发请求；导航三项在请求回来之前就已渲染，之后关掉再开不重发', async () => {
    const { load } = setup();
    expect(load).not.toHaveBeenCalled();

    pressPaletteShortcut();

    // ① 请求发了（挂载探针的 effect 在本次事件里跑完，不必等下一次轮询）；
    expect(load).toHaveBeenCalledTimes(1);
    // ② 导航项已经在了——它们不依赖网络，首屏不等数据；
    expect(screen.getByRole('option', { name: '评测' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '设置' })).toBeInTheDocument();
    // ③ 而列表此刻还没回来，不该凭空出现
    expect(screen.queryByText('登录页改造')).toBeNull();

    // ④ 列表回来后就补进面板
    await waitFor(() => expect(screen.getByText('登录页改造')).toBeInTheDocument());

    // ⑤ 关掉再唤起：探针保持挂载，命中缓存，不重发
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
    pressPaletteShortcut();
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(1);
  });
});
