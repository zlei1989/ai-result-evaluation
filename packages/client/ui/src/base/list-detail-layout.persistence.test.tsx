/**
 * `ListDetailLayout` 与 `react-resizable-panels` 的**接线契约**：像素持久化怎么进出。
 *
 * 这条用例替身的是第三方库（`react-resizable-panels`），不是被测代码的内部件——jsdom 没有布局
 * 引擎，真实拖拽/真实像素宽在本仓不可达（见 `testing/resize-observer.ts` 的口径）；真机几何由
 * 冒烟用例读 `getBoundingClientRect` 钉。这里钉的是三条会静默退化的接线：
 *   1. 存量值是**像素**：还原必须走 `panelRef.resize(700)`，不能按比例（0..100）送；
 *   2. 落盘取 `onResize` 的 `inPixels`，且只在 `onLayoutChanged` 的 `isUserInteraction` 为真时写；
 *   3. 详情栏声明 `preserve-pixel-size`，窄窗时把有效 `minSize` 降到「预算 − 列表栏 min」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { installResizeObserverStub } from '../testing/resize-observer';
import { ListDetailLayout } from './list-detail-layout';

/** 替身记录：resize 入参、每个 Panel 收到的 props、Group 收到的 props */
const fake = vi.hoisted(() => ({
  resized: [] as { id: string; size: unknown }[],
  panels: new Map<string, Record<string, unknown>>(),
  group: null as Record<string, unknown> | null,
}));

vi.mock('react-resizable-panels', async () => {
  const React = await import('react');
  return {
    // 真实库的 usePanelRef 就是一个 ref 对象；Panel 用 useImperativeHandle 挂命令式句柄
    usePanelRef: () => React.useRef(null),
    Group: (props: Record<string, unknown>) => {
      fake.group = props;
      const { elementRef, children, ...rest } = props as Record<string, unknown> & {
        elementRef?: React.Ref<HTMLDivElement>;
        children?: React.ReactNode;
      };
      return React.createElement(
        'div',
        { ...rest, 'data-group': 'true', 'data-testid': 'group', ref: elementRef },
        children as React.ReactNode,
      );
    },
    Panel: (props: Record<string, unknown>) => {
      const { id, panelRef, children, ...rest } = props as Record<string, unknown> & {
        id: string;
        panelRef?: React.Ref<unknown>;
        children?: React.ReactNode;
      };
      fake.panels.set(id, rest);
      React.useImperativeHandle(
        panelRef,
        () => ({
          resize: (size: unknown) => fake.resized.push({ id, size }),
          getSize: () => ({ asPercentage: 0, inPixels: 0 }),
          collapse: () => {},
          expand: () => {},
          isCollapsed: () => false,
        }),
        [id],
      );
      return React.createElement(
        'div',
        {
          'data-panel': 'true',
          'data-testid': id,
          'data-group-behavior': String(rest.groupResizeBehavior),
        },
        children as React.ReactNode,
      );
    },
    Separator: () => React.createElement('div', { role: 'separator', 'data-separator': 'inactive' }),
  };
});

// 真实库在挂载时 new ResizeObserver（分组尺寸变化），jsdom 没有；只装桩、不驱动回调
beforeEach(() => {
  installResizeObserverStub();
  fake.resized.length = 0;
  fake.panels.clear();
  fake.group = null;
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function renderLayout(key: string): ReturnType<typeof render> {
  return render(
    <ListDetailLayout
      list={<span>列表</span>}
      detail={<span>详情</span>}
      detailOpen
      widthStorageKey={key}
    />,
  );
}

describe('ListDetailLayout 的像素持久化', () => {
  it('存量是像素：挂载后用 resize(700) 还原，不按比例送 70 / "70%"', async () => {
    // 容器量得到（1200）才走规划分支；规划只会把 700 往边界内夹，不会把它变成比例
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200);
    try {
      window.localStorage.setItem('px-key', '700');
      renderLayout('px-key');

      await waitFor(() => {
        expect(fake.resized).toContainEqual({ id: 'detail', size: 700 });
      });
      // 像素值域远大于百分比：还原路径上不允许出现 0..100 的比例数
      for (const call of fake.resized) {
        expect(call.size).toBeGreaterThan(100);
      }
    } finally {
      widthSpy.mockRestore();
    }
  });

  it('拖拽把 onResize 的 inPixels 落盘；窗口缩放（非用户交互）不覆盖用户意图', async () => {
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200);
    try {
      renderLayout('drag-key');
      await waitFor(() => expect(fake.group).not.toBeNull());

      // 用户拖拽：先上报像素，松手时 Group 才标记为用户交互
      act(() => {
        (fake.panels.get('detail')?.onResize as (size: unknown, id: string, prev: unknown) => void)(
          { asPercentage: 60, inPixels: 720 },
          'detail',
          { asPercentage: 50, inPixels: 600 },
        );
      });
      act(() => {
        (fake.group?.onLayoutChanged as (layout: unknown, meta: unknown) => void)(
          { list: 40, detail: 60 },
          { isUserInteraction: true },
        );
      });
      expect(window.localStorage.getItem('drag-key')).toBe('720');

      // 窗口缩窄导致被夹紧：不是用户意图，不能把 720 覆盖成夹紧后的值
      act(() => {
        (fake.panels.get('detail')?.onResize as (size: unknown, id: string, prev: unknown) => void)(
          { asPercentage: 50, inPixels: 500 },
          'detail',
          { asPercentage: 60, inPixels: 720 },
        );
      });
      act(() => {
        (fake.group?.onLayoutChanged as (layout: unknown, meta: unknown) => void)(
          { list: 50, detail: 50 },
          { isUserInteraction: false },
        );
      });
      expect(window.localStorage.getItem('drag-key')).toBe('720');
    } finally {
      widthSpy.mockRestore();
    }
  });

  it('详情栏固定像素：preserve-pixel-size，窄窗把 minSize 降到「预算 − 列表栏 min」', async () => {
    // 容器 402：两栏下限之和放不下（120 + 320 + 6 > 402）⇒ 详情栏下限必须降到 276
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(402);
    try {
      renderLayout('narrow-key');
      await waitFor(() => expect(fake.panels.get('detail')).toBeDefined());
      const detail = fake.panels.get('detail');
      expect(detail?.groupResizeBehavior).toBe('preserve-pixel-size');
      expect(detail?.minSize).toBe(276);
      // max 保持声明值：视口每变一次就改 max 会把 `preserve-pixel-size` 冲掉（实时缩窗退化成按比例）
      expect(detail?.maxSize).toBe(900);
    } finally {
      widthSpy.mockRestore();
    }
  });
});
