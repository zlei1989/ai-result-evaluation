/**
 * 主题 hook：三处消费点同步 + 文档根属性口径。
 * 这是**防回归**用例：「组件亮了、底色还是暗的」这类半亮主题，
 * 根因就是三个消费点有一个没同步（ConfigProvider / html[data-theme] / ConfigProvider.config）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ConfigProvider } from 'antd';
// 第三消费点的读回器必须从 **lib** 子路径取：antd 没有 exports map，但 `antd` 的 main 是
// `lib/index.js`，而 Vitest 下 `antd/es/config-provider` 是**另一个模块实例**，
// 用 es/ 读 globalConfig() 恒为 undefined，看起来像「没写入」。
import { globalConfig } from 'antd/lib/config-provider';
import { useResolvedTheme } from './app-theme';
import { SYSTEM_DARK_QUERY, type ThemePreference } from './theme-resolve';

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
});

describe('useResolvedTheme', () => {
  it('显式 dark：mode 为 dark，data-theme 写解析后的值，preference 保留原值', () => {
    const { result } = renderHook(() => useResolvedTheme({ preference: 'dark' }));
    expect(result.current.mode).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('dark');
  });

  it('auto：data-theme 写实际明暗，data-theme-preference 保留 auto 以便区分「跟随系统」', () => {
    vi.stubGlobal('window', { ...globalThis.window, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) });
    const { result } = renderHook(() => useResolvedTheme({ preference: 'auto' }));
    expect(result.current.mode).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themePreference).toBe('auto');
  });

  it('偏好未就绪（undefined）时按暗色兜底', () => {
    const { result } = renderHook(() => useResolvedTheme({}));
    expect(result.current.mode).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('dark');
  });

  it('apply=false 时不写文档根属性（供只需要配置的场景）', () => {
    renderHook(() => useResolvedTheme({ preference: 'light', apply: false }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('mode 变化时重新写文档根属性', () => {
    // initialProps 必须标成偏好联合类型：`as const` 会把 renderHook 的 Props 推成字面量
    // 'dark'，后续 rerender 传 'light' 会被 tsc 判为不可赋值（strict）。
    const { rerender } = renderHook(({ preference }) => useResolvedTheme({ preference }), {
      initialProps: { preference: 'dark' as ThemePreference },
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
    rerender({ preference: 'light' as const });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('消费点③：把 themeConfig 与 holderRender 真正写进 antd 全局配置', () => {
    // globalConfig 是模块级单例，先读前值以便用例结束后复原
    const previous = globalConfig();
    const previousTheme = previous.getTheme();
    const previousHolder = previous.holderRender;
    try {
      const { result } = renderHook(() => useResolvedTheme({ preference: 'light' }));
      // 同一引用：静态 message/Modal 拿到的正是这个 hook 的 themeConfig
      expect(globalConfig().holderRender).toBe(result.current.holderRender);
      expect(globalConfig().getTheme()).toBe(result.current.themeConfig);
    } finally {
      // holderRender 总能复原；theme 只在先前有值时可复原——antd 的 setGlobalConfig 里是
      // `if (theme)`，传 undefined 不写入，没有 unset API。残留值不影响本文件任何断言：
      // 下面 apply=false 用例比对的是它**紧邻之前**读到的值，与用例执行顺序无关。
      if (previousTheme !== undefined) ConfigProvider.config({ theme: previousTheme });
      ConfigProvider.config({ holderRender: previousHolder });
    }
  });

  it('apply=false 时连全局配置也不写（两个消费点一起跳过）', () => {
    const before = globalConfig();
    const beforeTheme = before.getTheme();
    const beforeHolder = before.holderRender;
    renderHook(() => useResolvedTheme({ preference: 'light', apply: false }));
    expect(globalConfig().getTheme()).toBe(beforeTheme);
    expect(globalConfig().holderRender).toBe(beforeHolder);
  });

  it('订阅 prefers-color-scheme 并在卸载时清理（jsdom 不提供 matchMedia，不打桩则订阅分支不可达）', () => {
    // jsdom 没有 matchMedia：不打桩的话 effect 会在 typeof 检查处直接 return，订阅路径根本走不到。
    // 这里用 vi.fn() 打桩，好让它能**观察**注册与清理，而不只是让代码跑起来。
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const media = { matches: true, addEventListener, removeEventListener };
    const matchMedia = vi.fn((_query: string) => media); // 参数必须显式标注：vi.fn(() => media) 会把 calls 推成零长元组（TS2493）
    vi.stubGlobal('window', { ...globalThis.window, matchMedia });

    const { result, unmount } = renderHook(() => useResolvedTheme({ preference: 'auto' }));
    expect(result.current.mode).toBe('dark');

    // 查询串必须是导出的常量本身，不是抄一遍的字面量。这里**逐个调用**检查而不是
    // toHaveBeenCalledWith：readSystemDark 也会调 matchMedia，只查「存在一次匹配」的话，
    // effect 里把字面量抄错会被 render 期那次正确调用蒙混过去（实测：只改 effect 的字面量仍然全绿）。
    for (const [query] of matchMedia.mock.calls) expect(query).toBe(SYSTEM_DARK_QUERY);
    // 再钉住常量**自己的取值**：上面那条比对的是「调用点用的是不是这个常量」，
    // 常量本身被改成 light 查询时两条都还是绿的（读回的系统偏好会整体反过来）。
    expect(SYSTEM_DARK_QUERY).toBe('(prefers-color-scheme: dark)');
    // 挂载时注册一次 'change'
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener.mock.calls[0]?.[0]).toBe('change');

    // 订阅是真的在同步系统偏好，而不只是注册了个没人调的回调
    const listener = addEventListener.mock.calls[0]?.[1] as () => void;
    media.matches = false;
    act(() => {
      listener();
    });
    expect(result.current.mode).toBe('light');

    // 卸载时用**同一个**函数引用清理（换一个引用移除 = 监听器泄漏）
    unmount();
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener.mock.calls[0]?.[0]).toBe('change');
    expect(removeEventListener.mock.calls[0]?.[1]).toBe(listener);
  });
});
