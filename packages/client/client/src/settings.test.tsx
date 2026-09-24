/**
 * useSettings：读取、补丁更新、响应回写缓存且不被随后的 GET 覆盖。
 * 注意：本用例要覆盖的是「mutation 成功后 revalidate:false」这条约定——
 * 少了它，紧接着的 GET 会用旧值覆盖刚写入的新值，用户看到主题弹回去。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SETTINGS_DEFAULTS } from '@aieval/contracts';
import { useSettings } from './settings';

/**
 * 每个用例都挂一份全新的 SWR 缓存。
 * 为什么必需：SWR 的缓存与「并发请求去重表」都挂在 cache 对象上（不是模块作用域），
 * 但默认 cache 是模块级单例——用例之间沿用同一份时，第二个用例挂载会直接命中
 * 上一个用例写入的数据与在飞去重项，一次 GET 都不发，
 * 于是「回写之后 GET 恰好一次」这条验收退化成「0 次」而失真。
 * wrapper 用 createElement 而非 JSX：它只有一行，写成 JSX 并不会更短更清楚。
 * （本包现在可以写 JSX——base tsconfig 已是 jsx: react-jsx——所以这只是写法选择，不是转译限制。）
 */
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSettings', () => {
  it('挂载后拉到设置', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(SETTINGS_DEFAULTS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.settings).toBeDefined());
    expect(result.current.settings?.theme).toBe(SETTINGS_DEFAULTS.theme);
    // 首个 GET 的 URL 就是 hook 的 cache key，钉住它必须等于真实路由
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/settings');
  });

  it('update 发出 PUT 并把响应回写进缓存', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ ...SETTINGS_DEFAULTS, theme: 'dark' }), { status: 200 });
      }
      return new Response(JSON.stringify(SETTINGS_DEFAULTS), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.settings).toBeDefined());

    await result.current.update({ theme: 'dark' });
    await waitFor(() => expect(result.current.settings?.theme).toBe('dark'));

    // 回写之后不得再发 GET 去覆盖（revalidate:false 的验收）
    const getCount = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'PUT').length;
    expect(getCount).toBe(1);
  });
});
