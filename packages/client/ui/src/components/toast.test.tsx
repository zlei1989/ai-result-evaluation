/**
 * toast 的渲染面：从**包根**取 `Toaster` 与 `toast`，证明「调用之后文案出现在页面上」。
 *
 * 判据刻意走包根（`../index`）而不是 `./ui/toast` 深路径：装配侧（`apps/web-next`）只能拿包根出口，
 * 深路径一直通，用它写用例等于把「包根漏转出」整个放过。
 *
 * `toast` 是模块级单例，`Toaster` 默认就用那份单例当 manager——两者若没接上，
 * 页面里调用成功、界面上一个提示都不出现，且控制台不报错。本文件把这条接线钉死。
 * `toast.promise` 的三态同样按**用户看到的文案**断言：loading → success / error，
 * 而不是只看它返回了原 promise。
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster, toast } from '../index';
import { installResizeObserverStub } from '../testing/resize-observer';

beforeEach(() => {
  // toast 的根节点会量高度（ResizeObserver），jsdom 没有这个构造器
  installResizeObserverStub();
});

afterEach(() => {
  // 单例跨用例存活：不清掉的话下一条用例会读到上一条留下的 toast
  act(() => {
    toast.close();
  });
  vi.unstubAllGlobals();
});

describe('vendored toast 从包根可用', () => {
  it('调用后出现文案；toast.promise 的 loading / success / error 三态都显示原文案', async () => {
    render(
      <Toaster>
        <span>宿主</span>
      </Toaster>,
    );

    // ① 一次性提示
    act(() => {
      toast.success('用例已保存');
    });
    expect(await screen.findByText('用例已保存')).toBeInTheDocument();

    // ② promise 成功链：先 loading，settle 后换成成功文案
    let resolveSync!: (value: string) => void;
    const syncing = new Promise<string>((resolve) => {
      resolveSync = resolve;
    });
    act(() => {
      void toast.promise(syncing, {
        loading: '正在同步用例变更…',
        success: (value) => `同步已完成：${value}`,
        error: (cause) => `同步失败：${cause instanceof Error ? cause.message : String(cause)}`,
      });
    });
    expect(await screen.findByText('正在同步用例变更…')).toBeInTheDocument();
    await act(async () => {
      resolveSync('3 个文件');
      await syncing;
    });
    expect(await screen.findByText('同步已完成：3 个文件')).toBeInTheDocument();

    // ③ promise 失败链：原因原文透传（页面不得改写服务端文案）
    let rejectSync!: (cause: unknown) => void;
    const failing = new Promise<string>((_resolve, reject) => {
      rejectSync = reject;
    });
    const rejected = toast.promise(failing, {
      loading: '正在同步用例变更…',
      success: '不该出现',
      error: (cause) => `同步失败：${cause instanceof Error ? cause.message : String(cause)}`,
    });
    await act(async () => {
      rejectSync(new Error('推送失败：远端拒绝'));
      await expect(rejected).rejects.toThrow('推送失败：远端拒绝');
    });
    expect(await screen.findByText('同步失败：推送失败：远端拒绝')).toBeInTheDocument();
  });
});
