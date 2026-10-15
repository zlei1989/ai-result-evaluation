// @vitest-environment node
/**
 * pi SDK 外壳的两条装载前提：**Node 版本闸**与**入口形状校验**。
 *
 * 两条都在**注入的假模块**上验证（`setAgentRuntimeForTesting`）：真包一 import 就是 335–432 ms
 * 与约 90 MB RSS，而这里要拦的是判据本身（版本比较、入口名），不是厂商包的内部行为。
 * 版本闸单独开一节：它是**我们自加**的（厂商的 `engines` 不自查），判据错了在真机上只会表现为
 * 「莫名其妙在别处失败」。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  PI_AI_PACKAGE_NAME,
  PI_MIN_NODE_VERSION,
  PI_PACKAGE_NAME,
  type PiSdkModule,
  type PiSession,
  assertPiNodeVersion,
  loadPiAi,
  loadPiSdk,
} from './sdk';

/**
 * **自声明与厂商 `.d.ts` 逐格对齐**（判据在 `tsc` 上，`typeof import(...)` 只在类型位置求值、
 * 不产生任何运行期 import——厂商包只能动态 import）。
 *
 * 为什么需要这条守卫：窄壳的声明是「我们以为厂商有什么」的全部记录，而它写错的两种形态都不会在
 * 本层当场报错——名字拼错（`followUp` 写成 `followup`）要等到真机那一轮才以
 * `… is not a function` 出现；**签名收窄错**（`followUp` 声明成同步）则永远不会报，
 * 直到我们真去 `await` 一个 undefined。
 *
 * 方向定成「厂商那一格**收得下**我们的声明」（`Vendor extends Ours`），不取反向：反向会逼我们
 * 把厂商的每一格都抄进来，而抄一份就随升级漂移。这个方向下，「我们发明了厂商没有的方法」会让
 * `Vendor...['那一格']` 取不到 ⇒ `tsc` 当场报错。
 */
type VendorPiModule = typeof import('@earendil-works/pi-coding-agent');
type VendorPiSession = InstanceType<VendorPiModule['AgentSession']>;
type AssertAssignable<From, To> = From extends To ? true : false;

/** 会话面：只列本仓声明了的那几格（没声明的格子不在这张表里，故不构成漂移判据） */
const declaredSessionCells: [
  AssertAssignable<VendorPiSession['sessionId'], PiSession['sessionId']>,
  AssertAssignable<VendorPiSession['sessionFile'], PiSession['sessionFile']>,
  AssertAssignable<VendorPiSession['steer'], PiSession['steer']>,
  AssertAssignable<VendorPiSession['followUp'], PiSession['followUp']>,
] = [true, true, true, true];

/** 会话管理器静态面：三条构造路径（`continueRecent` 也进表：本仓刻意不用它，故它的形状也得是真的） */
const declaredSessionManagerCells: [
  AssertAssignable<VendorPiModule['SessionManager']['create'], PiSdkModule['SessionManager']['create']>,
  AssertAssignable<VendorPiModule['SessionManager']['open'], PiSdkModule['SessionManager']['open']>,
  AssertAssignable<VendorPiModule['SessionManager']['continueRecent'], PiSdkModule['SessionManager']['continueRecent']>,
] = [true, true, true];

/**
 * 伪造 `process.versions.node`：它是只读数据属性（`writable: false`），只能整条替换后再还原。
 * 必须 `await` 回调——同步 `finally` 会在回调的 promise 落定**之前**就把版本还原回去，
 * 于是「闸在第一次调用拦下、第二次却放行」这种假绿会混进来。
 */
async function withFakeNodeVersion<T>(version: string, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node');
  Object.defineProperty(process.versions, 'node', { value: version, configurable: true });
  try {
    return await run();
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process.versions, 'node', descriptor);
  }
}

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

describe('pi 的 Node 版本闸', () => {
  it('包名与下限取自真值（下限就是 pi 声明的 engines 底线）', () => {
    expect(PI_PACKAGE_NAME).toBe('@earendil-works/pi-coding-agent');
    expect(PI_MIN_NODE_VERSION).toBe('22.19.0');
  });

  it('满足下限即通过（含等于下限、更高的大版本、更高的次版本）', () => {
    for (const version of ['22.19.0', '22.20.1', '23.0.0', '24.19.0']) {
      expect(() => assertPiNodeVersion(version), version).not.toThrow();
    }
  });

  /**
   * 低于下限一律 `AGENT_LOAD_FAILED`：文案点名**下限**、**本机版本**与补救动作。
   * `22.9.0` 那一格是**字典序陷阱**的守卫——按字符串比较会把它放到 `22.19.0` 之上（静默放行）。
   */
  it('低于下限抛 AGENT_LOAD_FAILED 并点名下限与本机版本（不含 `pnpm add`）', () => {
    for (const version of ['22.18.9', '22.9.0', '21.99.0', '20.11.0', '18.20.4']) {
      let thrown: unknown;
      try {
        assertPiNodeVersion(version);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${version} 必须被拦下`).toBeInstanceOf(Error);
      const { code, message } = thrown as { code?: string; message: string };
      expect(code).toBe('AGENT_LOAD_FAILED');
      expect(message).toContain(`Node ≥${PI_MIN_NODE_VERSION}`);
      expect(message).toContain(version);
      expect(message).toContain('升级 Node');
      expect(message).not.toContain('pnpm add');
    }
  });

  it('生产路径默认读宿主的 process.versions.node（无参调用可用）', () => {
    expect(() => assertPiNodeVersion()).not.toThrow();
  });
});

describe('pi 的装载路径', () => {
  /**
   * 版本闸排在形状校验**之前**：同一个「导出面也不对」的模块，版本不合格时给出的必须是版本这一格
   * （补救动作是升级 Node），不得让用户拿着「导出面不匹配」去找适配器版本。
   */
  it('版本闸先于形状校验：版本不合格时报的是版本这一格，不提导出面', async () => {
    setAgentRuntimeForTesting({ sdkModule: { [PI_PACKAGE_NAME]: {} } });
    await withFakeNodeVersion('20.11.0', async () => {
      let thrown: unknown;
      try {
        await loadPiSdk();
      } catch (error) {
        thrown = error;
      }
      const { code, message } = thrown as { code?: string; message: string };
      expect(code).toBe('AGENT_LOAD_FAILED');
      expect(message).toContain(`Node ≥${PI_MIN_NODE_VERSION}`);
      expect(message).toContain('20.11.0');
      expect(message).not.toContain('pnpm add');
      expect(message).not.toContain('createAgentSession'); // 形状那一格的措辞不该出现
    });
  });

  /**
   * 五格**全在**才交出模块：这一格是「装配序列恒要的那几格齐了」的正面判据。
   * 少任何一格都由下面两条负向用例逐个点名（不是只判入口那一个名字）。
   */
  it('版本合格 + 装配面五格齐 ⇒ 交出注入的模块', async () => {
    const fake = {
      createAgentSession: async () => ({ session: 'fake' }),
      DefaultResourceLoader: class {},
      SessionManager: { create: () => ({}), open: () => ({}), continueRecent: () => ({}) },
      SettingsManager: { inMemory: () => ({}) },
      ModelRuntime: class {
        static create = async () => ({});
      },
    };
    setAgentRuntimeForTesting({ sdkModule: { [PI_PACKAGE_NAME]: fake } });
    await withFakeNodeVersion('22.19.0', async () => {
      await expect(loadPiSdk()).resolves.toBe(fake);
    });
  });

  /**
   * 逐格点名：缺的那一格必须出现在文案里（旧实现只判 `createAgentSession`，其余四格缺席会变成
   * 装配期的裸 TypeError，还被归成在重试表里的 `AGENT_FAILED`）。
   */
  it.each([
    ['DefaultResourceLoader', { DefaultResourceLoader: undefined }],
    ['SessionManager', { SessionManager: { create: () => ({}) } }],
    ['SettingsManager', { SettingsManager: {} }],
    ['ModelRuntime', { ModelRuntime: undefined }],
  ])('缺 %s 即 shape-mismatch，且文案点名那一格', async (entry, patch) => {
    const fake = {
      createAgentSession: async () => ({ session: 'fake' }),
      DefaultResourceLoader: class {},
      SessionManager: { create: () => ({}), open: () => ({}), continueRecent: () => ({}) },
      SettingsManager: { inMemory: () => ({}) },
      ModelRuntime: class {
        static create = async () => ({});
      },
      ...patch,
    };
    setAgentRuntimeForTesting({ sdkModule: { [PI_PACKAGE_NAME]: fake } });
    await withFakeNodeVersion('22.19.0', async () => {
      await expect(loadPiSdk()).rejects.toThrow(new RegExp(entry));
    });
  });

  /**
   * 形状不对：包在、名字对，只是导出面不是适配器期望的那一支 ⇒ 文案指向「期望入口 vs 实测导出面」，
   * 不得出现恒无效的安装命令。
   */
  it('入口缺失即 shape-mismatch：点名期望入口与实测导出面，文案不含 `pnpm add`', async () => {
    setAgentRuntimeForTesting({
      sdkModule: { [PI_PACKAGE_NAME]: { DefaultResourceLoader: class {}, ModelRuntime: class {} } },
    });
    await withFakeNodeVersion('24.19.0', async () => {
      let thrown: unknown;
      try {
        await loadPiSdk();
      } catch (error) {
        thrown = error;
      }
      const { code, message } = thrown as { code?: string; message: string };
      expect(code).toBe('AGENT_LOAD_FAILED');
      expect(message).not.toContain('pnpm add');
      expect(message).toContain('createAgentSession'); // 期望的入口
      expect(message).toContain('DefaultResourceLoader'); // 实测拿到的
      expect(message).toContain('ModelRuntime');
    });
  });

  it('模块不是对象（厂商包形态变了）也只归加载失败，不让读导出面成为新的崩溃点', async () => {
    setAgentRuntimeForTesting({ sdkModule: { [PI_PACKAGE_NAME]: 'not-a-module' } });
    await withFakeNodeVersion('24.19.0', async () => {
      await expect(loadPiSdk()).rejects.toThrow(/（读不到任何导出）/);
    });
  });
});

/**
 * 凭据存储那一格（pi 的**模型层**包）：它是「凭据只进内存、不落盘」的唯一通道，
 * 而导入面错了的失败点离真因很远（SDK 在 `ModelRuntime.create` 里才校验 `credentials` 的形状）。
 */
describe('pi-ai 的凭据存储装载', () => {
  it('包名是真值，且它是与 pi-coding-agent 分开的一份（凭据存储不在后者的出口面里）', () => {
    expect(PI_AI_PACKAGE_NAME).toBe('@earendil-works/pi-ai');
    expect(PI_AI_PACKAGE_NAME).not.toBe(PI_PACKAGE_NAME);
  });

  it('导出面正确 ⇒ 交出注入的模块', async () => {
    const store = class InMemoryCredentialStore {};
    setAgentRuntimeForTesting({ sdkModule: { [PI_AI_PACKAGE_NAME]: { InMemoryCredentialStore: store } } });
    await expect(loadPiAi()).resolves.toEqual({ InMemoryCredentialStore: store });
  });

  /**
   * 形状不对 ⇒ `AGENT_LOAD_FAILED` 且有 `shape-mismatch` 文案（点名期望入口与实测导出面）：
   * 装错了版本时重装是恒无效的建议，文案必须把矛头指向「导出面对不上」。
   */
  it('缺 InMemoryCredentialStore ⇒ shape-mismatch（点名期望入口，文案不含 `pnpm add`）', async () => {
    setAgentRuntimeForTesting({ sdkModule: { [PI_AI_PACKAGE_NAME]: { somethingElse: 1 } } });
    let thrown: unknown;
    try {
      await loadPiAi();
    } catch (error) {
      thrown = error;
    }
    const { code, message } = thrown as { code?: string; message: string };
    expect(code).toBe('AGENT_LOAD_FAILED');
    expect(message).toContain('InMemoryCredentialStore');
    expect(message).toContain('somethingElse');
    expect(message).not.toContain('pnpm add');
  });

  it('模块不是对象（厂商包形态变了）也只归加载失败，不让读导出面成为新的崩溃点', async () => {
    setAgentRuntimeForTesting({ sdkModule: { [PI_AI_PACKAGE_NAME]: null } });
    await expect(loadPiAi()).rejects.toThrow(/（读不到任何导出）/);
  });
});

/**
 * 上面那两条 `AssertAssignable` 表的**运行期影子**：真判据是类型断言（`tsc` 见红即守卫生效），
 * 这一条只保证这张表真的被求值过一次（否则「表在文件里但没人读」与「表不存在」在 `vitest` 上同形）。
 */
describe('自声明与厂商 .d.ts 的对齐表', () => {
  it('会话面与会话管理器面逐格对齐（不发明厂商没有的成员）', () => {
    expect(declaredSessionCells).toEqual([true, true, true, true]);
    expect(declaredSessionManagerCells).toEqual([true, true, true]);
  });
});
