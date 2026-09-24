/**
 * 偏好记忆：localStorage 读写的容错口径。
 * 三条硬要求：无 window / 存储抛错 / 脏值，都必须回落默认值而**不抛错**；
 * 且 useStoredWidth 不能在首帧就读 localStorage（否则 SSR 与客户端首帧不一致，触发水合警告）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readStoredPreference, useStoredWidth } from './stored-preference';

afterEach(() => {
  // 必须先解除全局桩，再碰 window：SSR 用例把 window 桩成 undefined，
  // 若先执行 window.localStorage.clear() 会抛 TypeError，且**解除桩的那一行永远跑不到**——
  // 结果是 window 在整个文件后续用例里一直是 undefined（实测：后面 7 条全红）。
  vi.unstubAllGlobals();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('readStoredPreference', () => {
  it('无存量值时返回 seed', () => {
    expect(readStoredPreference('k', 7, (raw) => Number(raw))).toBe(7);
  });

  it('解析器返回 null 时回落 seed（脏值不落地）', () => {
    window.localStorage.setItem('k', 'abc');
    expect(readStoredPreference('k', 7, (raw) => (Number.isFinite(Number(raw)) ? Number(raw) : null))).toBe(7);
  });

  it('存储读取抛错时不抛出、回落 seed（隐私模式 / 禁用存储）', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readStoredPreference('k', 9, (raw) => Number(raw))).toBe(9);
  });

  it('无 window（SSR）时回落 seed', () => {
    vi.stubGlobal('window', undefined);
    expect(readStoredPreference('k', 11, (raw) => Number(raw))).toBe(11);
  });

  it('存储本身不可用（访问 localStorage 属性就抛错）时同样静默回落', () => {
    // 与「getItem 抛错」是**两条不同的路径**：隐私模式 / 分区隔离会让 window.localStorage
    // 这个**属性访问**本身抛错。实现里取值写在 try 内才兜得住，挪到 try 外就会炸穿到调用方。
    vi.stubGlobal('window', {
      ...globalThis.window,
      get localStorage(): Storage {
        throw new Error('SecurityError');
      },
    });
    expect(readStoredPreference('k', 13, (raw) => Number(raw))).toBe(13);
    const { result } = renderHook(() => useStoredWidth('w', 420, 320, 900));
    expect(() => act(() => result.current[1](500))).not.toThrow();
    expect(result.current[0]).toBe(500);
  });
});

describe('useStoredWidth', () => {
  it('首帧用 seed（不在挂载前读 localStorage，避免水合不一致）', () => {
    window.localStorage.setItem('w', '700');
    // 「首帧」只能在**渲染期**观察：renderHook 的 render 包在 act() 里，返回时 useEffect 已经跑完，
    // 存量值 700 已经写进状态（同一 setup 的下一条用例断言的正是 700）——两者不可能同时成立。
    // 故把每次渲染读到的值记下来，rendered[0] 才是首帧。若把读取挪进 useState 初始化函数
    // （水合不一致的根因），首帧记到的会是 700。
    const rendered: number[] = [];
    renderHook(() => {
      const [width] = useStoredWidth('w', 420, 320, 900);
      rendered.push(width);
      return width;
    });
    expect(rendered[0]).toBe(420);
  });

  it('挂载后读出存量值', async () => {
    window.localStorage.setItem('w', '700');
    const { result } = renderHook(() => useStoredWidth('w', 420, 320, 900));
    await act(async () => {});
    expect(result.current[0]).toBe(700);
  });

  it('存量值越界时被夹紧到区间内', async () => {
    window.localStorage.setItem('w', '99999');
    const { result } = renderHook(() => useStoredWidth('w', 420, 320, 900));
    await act(async () => {});
    expect(result.current[0]).toBe(900);
  });

  it('存量值是非数字脏值时回落 seed', async () => {
    window.localStorage.setItem('w', 'NaN');
    const { result } = renderHook(() => useStoredWidth('w', 420, 320, 900));
    await act(async () => {});
    expect(result.current[0]).toBe(420);
  });

  it('seed 本身越界时也参与夹紧', () => {
    const { result } = renderHook(() => useStoredWidth('w', 10_000, 320, 900));
    expect(result.current[0]).toBe(900);
  });

  it('update 会写回 localStorage 并夹紧', async () => {
    const { result } = renderHook(() => useStoredWidth('w', 420, 320, 900));
    act(() => result.current[1](1500));
    expect(result.current[0]).toBe(900);
    expect(window.localStorage.getItem('w')).toBe('900');
  });

  it('写入抛错时不抛出，本次会话内仍然生效', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => useStoredWidth('w', 420, 320, 900));
    expect(() => act(() => result.current[1](500))).not.toThrow();
    expect(result.current[0]).toBe(500);
  });
});
