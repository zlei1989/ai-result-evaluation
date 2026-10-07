// @vitest-environment node
/**
 * 懒加载外壳：只缓存**成功**的加载；注入优先且不缓存。
 * 为什么「不缓存失败」必须有用例：一次镜像抖动（首次 import 失败）如果被缓存，长驻服务的后续所有行
 * 都会直接失败——故障从「一次」变成「永久」，而这正是 A6 选择懒加载要避免的事。
 * 为什么「注入不缓存」必须有用例：测试要在同一进程里从「坏模块」换到「好模块」，验证「后续一轮可
 * 重试成功」；缓存注入值会让这条路径不可测（也就等于没被验证过）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLoadError } from './errors';
import { createSdkLoader } from './load-once';
import { setAgentRuntimeForTesting } from './runtime';

const PACKAGE = '@aieval/fake-sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

describe('createSdkLoader', () => {
  it('首次调用加载、之后复用同一个结果（load 只被调一次）', async () => {
    const load = vi.fn(async () => ({ ok: true }));
    const get = createSdkLoader(load, PACKAGE);
    const first = await get();
    const second = await get();
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('加载失败抛 AgentLoadError，文案点名包名与安装方式', async () => {
    const get = createSdkLoader(async () => {
      throw new Error('Cannot find module');
    }, PACKAGE);
    await expect(get()).rejects.toBeInstanceOf(AgentLoadError);
    await expect(get()).rejects.toThrow(PACKAGE);
    await expect(get()).rejects.toThrow('pnpm add');
  });

  it('失败不被缓存：第二次调用会重试，成功后可用（「后续一轮可重试成功」）', async () => {
    let attempt = 0;
    const get = createSdkLoader(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('第一次抖动');
      return { attempt };
    }, PACKAGE);
    await expect(get()).rejects.toBeInstanceOf(AgentLoadError);
    await expect(get()).resolves.toEqual({ attempt: 2 });
  });

  it('注入的模块优先（不去碰真实包），且每次调用重新读取（可在同一进程里替换）', async () => {
    const load = vi.fn(async () => ({ source: 'real' }));
    const get = createSdkLoader(load, PACKAGE);
    setAgentRuntimeForTesting({ sdkModule: { [PACKAGE]: { source: 'fake-1' } } });
    await expect(get()).resolves.toEqual({ source: 'fake-1' });
    setAgentRuntimeForTesting({ sdkModule: { [PACKAGE]: { source: 'fake-2' } } });
    await expect(get()).resolves.toEqual({ source: 'fake-2' });
    expect(load).not.toHaveBeenCalled();
  });

  it('注入表里没有这个包名时走真实加载（三家互不影响）', async () => {
    const load = vi.fn(async () => ({ source: 'real' }));
    const get = createSdkLoader(load, PACKAGE);
    setAgentRuntimeForTesting({ sdkModule: { '@other/pkg': {} } });
    await expect(get()).resolves.toEqual({ source: 'real' });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
