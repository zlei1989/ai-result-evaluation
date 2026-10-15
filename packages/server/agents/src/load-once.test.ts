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

  /**
   * **可重试与不可重试要分开说**：解析类失败（包没装 / 子模块缺失）修好文件后同进程重试就能成功；
   * 而**求值 / 编译期抛错**的模块被 Node 的模块表记成 errored 永久缓存 ⇒ 那一档必须点明「重启服务」，
   * 否则文案会把人引向「重装 / 重跑同一行」这条恒无效的路。
   */
  it('解析类失败 ⇒ 文案给安装命令（可重试）；求值期抛错 ⇒ 文案点明需要重启服务', async () => {
    const missing = createSdkLoader(async () => {
      throw Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });
    }, PACKAGE);
    await expect(missing()).rejects.toThrow('pnpm add');
    await expect(missing()).rejects.not.toThrow('需要重启服务');

    const evalThrow = createSdkLoader(async () => {
      throw new Error('模拟模块求值期抛错');
    }, PACKAGE);
    await expect(evalThrow()).rejects.toThrow('需要重启服务');
    // 判据是 `pinned` 而不是「凡失败都说重启」：解析类那一条上面已经反向钉住
    await expect(evalThrow()).rejects.toThrow('errored');
  });

  /**
   * `ERR_PACKAGE_IMPORT_NOT_DEFINED`（`imports` 里没声明那个说明符）是**解析类**失败：改好
   * `package.json` 之后同进程重试是有效的，把它归进「需重启」会把用户指向一个恒无效的动作。
   */
  it('`ERR_PACKAGE_IMPORT_NOT_DEFINED` 也算解析类失败（不点「需重启」）', async () => {
    const get = createSdkLoader(async () => {
      throw Object.assign(new Error('Package import specifier "#internal" is not defined'), {
        code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED',
      });
    }, PACKAGE);
    await expect(get()).rejects.not.toThrow('需要重启服务');
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
