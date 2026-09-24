// @vitest-environment node
/** 设置服务：读取时的归一化、补丁合并、改工作区根目录时的可用性校验。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, SETTINGS_DEFAULTS } from '@aieval/contracts';
import {
  defaultWorkspaceRoot,
  getConfigDir,
  loadConfig,
  saveConfig,
  setConfigDirForTesting,
  validateWorkspaceRoot,
} from '@aieval/core';
import { getSettings, updateSettings } from './settings';

// F11 的守卫要把 saveConfig 打挂成裸 errno；「只改主题不做目录校验」要能直接数
// validateWorkspaceRoot 的调用次数。settings.ts 用的是静态 import，改不了它拿到的绑定，
// 只能整模块 mock 一次；其余导出原样透传，这两个都包一层真实现，其它用例照常走真实路径。
vi.mock('@aieval/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/core')>();
  return {
    ...actual,
    saveConfig: vi.fn(actual.saveConfig),
    validateWorkspaceRoot: vi.fn(actual.validateWorkspaceRoot),
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-api-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('getSettings', () => {
  it('无配置文件时返回默认值', () => {
    // 与 SETTINGS_DEFAULTS 的唯一差别是 workspaceRoot：默认值里的 `~/.runs` 只是配置文件中的可读写法，
    // 下行一律展开为绝对路径（下一条钉的就是这件事），故这里按展开后的默认根目录比对。
    expect(getSettings()).toEqual({ ...SETTINGS_DEFAULTS, workspaceRoot: defaultWorkspaceRoot() });
  });

  it('把 workspaceRoot 的 ~ 展开成绝对路径（下行给客户端的总是绝对路径）', () => {
    const settings = getSettings();
    expect(settings.workspaceRoot).not.toContain('~');
  });

  // 读取路径**绝不能**做可写性校验：目录可能正被临时卸载 / 未挂载，此时抛错会让用户连设置页都
  // 打不开，连改回去的机会都没有。所以拿一个「mkdir 必失败」的存量根目录（被同名文件占住）来钉：
  // 一旦 normalize 改成 validateWorkspaceRoot，这条会以 NOT_WRITABLE 直接抛穿。
  it('读取时不校验可写性：存量根目录不可用时仍能返回（设置页不会因此打不开）', () => {
    const occupied = join(dir, 'unavailable-root');
    writeFileSync(occupied, 'x');
    saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: occupied } });

    const settings = getSettings();

    expect(settings.workspaceRoot).toBe(occupied);
  });
});

describe('updateSettings', () => {
  it('只改传入的字段，其余保持原值', () => {
    const next = updateSettings({ theme: 'dark' });
    expect(next.theme).toBe('dark');
    expect(next.rowTimeoutMs).toBe(SETTINGS_DEFAULTS.rowTimeoutMs);
    expect(next.diffBudgetBytes).toBe(SETTINGS_DEFAULTS.diffBudgetBytes);
  });

  it('改动落盘（重新读配置能拿到新值）', () => {
    updateSettings({ theme: 'light' });
    expect(loadConfig().settings.theme).toBe('light');
  });

  it('空补丁不改变任何字段', () => {
    updateSettings({ theme: 'dark' });
    const next = updateSettings({});
    expect(next.theme).toBe('dark');
  });

  // F3：`SettingsPatch.workspaceRoot` 的类型是 `string | undefined`（`SettingsSchema.partial()`），
  // 所以 `{ workspaceRoot: undefined }` 能通过 tsc。它合并时会把存量根目录**覆盖成 undefined**，
  // 而 `patch.workspaceRoot !== undefined` 那道校验闸门恰好放它过去——坏值于是直奔读取路径，
  // 让一个契约上只对外吐中文 ServiceError 的服务抛出原始的英文 TypeError
  //（`Cannot read properties of undefined (reading 'startsWith')`）。
  // 断言可观测结果：先放一个非默认的存量根目录，显式传 undefined 的补丁必须让它回落到默认值。
  it('显式传入 workspaceRoot: undefined 时回落到默认根目录（不抛英文 TypeError）', () => {
    updateSettings({ workspaceRoot: join(dir, 'ws') });

    const next = updateSettings({ workspaceRoot: undefined });

    expect(next.workspaceRoot).toBe(defaultWorkspaceRoot());
  });

  it('改工作区根目录时会先校验可用性，并把展开后的绝对路径落盘', () => {
    const target = join(dir, 'ws');
    const next = updateSettings({ workspaceRoot: target });
    expect(next.workspaceRoot).toBe(target);
    expect(loadConfig().settings.workspaceRoot).toBe(target);
  });

  it('工作区根目录不可用时抛 NOT_WRITABLE，且不落盘', () => {
    updateSettings({ theme: 'dark' });
    // 拿一个被文件占住的路径当根目录：mkdir 必失败
    const occupied = join(dir, 'occupied');
    writeFileSync(occupied, 'x');
    let caught: unknown;
    try {
      updateSettings({ workspaceRoot: occupied });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_WRITABLE');
    // 失败的改动不得落盘
    expect(loadConfig().settings.workspaceRoot).not.toBe(occupied);
    expect(loadConfig().settings.theme).toBe('dark');
  });

  // 这条用例原来的断言是 `expect(getConfigDir()).toBe(before)`，是**空转**的：getConfigDir() 返回的是
  // beforeEach 塞进去的临时目录，updateSettings 无论如何都改不了它——校验跑不跑、跑几次，它都相等。
  // 于是「不改工作区根目录时不做目录校验」这个名字对任何实现都成立，包括**无条件校验**的实现。
  // 真正的判据只有一个：校验函数被调用了没有。所以这里直接数 spy 的调用次数。
  it('只改主题时不做目录校验：validateWorkspaceRoot 一次都没被调用', () => {
    // vitest.node.ts 没开 clearMocks，mock 的调用记录会跨用例累积，而前面几条用例真的调过校验，
    // 这里必须先清一次，否则断言的是「历史上没调过」而不是「这次没调」。
    vi.mocked(validateWorkspaceRoot).mockClear();

    updateSettings({ theme: 'dark' });

    expect(vi.mocked(validateWorkspaceRoot)).not.toHaveBeenCalled();
  });

  // 与上一条成对但判据不同：上一条数的是「校验函数有没有被调用」，这条盯的是**可观测后果**——
  // 存量根目录不可用（被同名文件占住，mkdir 必失败）时，只改主题仍然要能存下去。
  // 少了它，「跳过校验」被改成「拿存量根目录去校验」就只会让设置页在某天突然报 NOT_WRITABLE。
  it('存量工作区根目录不可用时，只改主题仍能保存（不校验未改动的根目录）', () => {
    const occupied = join(dir, 'stale-root');
    writeFileSync(occupied, 'x');
    saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: occupied } });

    const next = updateSettings({ theme: 'dark' });

    expect(next.workspaceRoot).toBe(occupied);
    expect(next.theme).toBe('dark');
    expect(loadConfig().settings.theme).toBe('dark');
  });

  it('保存的配置里 workspaceRoot 是绝对路径而非 ~ 形式', () => {
    saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: '~/.runs' } });
    const next = updateSettings({ theme: 'dark' });
    expect(next.workspaceRoot).not.toContain('~');
  });

  // F11（Task 4 评审）：saveConfig 会抛原始 errno（EPERM / ENOSPC / 只读盘），而契约要求对外错误
  // 一律是可直接展示的中文原因。这里把 saveConfig 打挂成裸 errno，断言 updateSettings 折成
  // INTERNAL 且 message 里带配置目录——少了那个 try/catch，路由层会把英文 errno 原文返回给用户。
  it('保存配置抛原始 errno 时折成带配置目录的 INTERNAL 中文错误', () => {
    vi.mocked(saveConfig).mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted');
    });
    let caught: unknown;
    try {
      updateSettings({ theme: 'dark' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('设置保存失败');
    expect((caught as ServiceError).message).toContain(getConfigDir());
  });
});
