// @vitest-environment node
/** 设置服务：读取时的归一化、补丁合并、改工作区根目录时的可用性校验。 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, SETTINGS_DEFAULTS, maskApiKey, toSettingsView } from '@aieval/contracts';
import {
  defaultCasesRoot,
  defaultWorkspaceRoot,
  getConfigDir,
  loadConfig,
  saveConfig,
  setConfigDirForTesting,
  validateWorkspaceRoot,
} from '@aieval/core';
import { getSettings, updateSettings } from './settings';
import { removeTreeWithRetry } from './testing/cleanup';

// 守卫要把 saveConfig 打挂成裸 errno；「只改主题不做目录校验」要能直接数
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
  removeTreeWithRetry(dir);
});

describe('getSettings', () => {
  it('无配置文件时返回默认值', () => {
    // 与 SETTINGS_DEFAULTS 的差别是**两个根目录**：默认值里的 `~/.aieval-runs` 与 `~/.aieval-cases`
    // 只是配置文件中的可读写法，下行一律展开为绝对路径（下一条钉的就是这件事）。
    expect(getSettings()).toEqual({
      ...SETTINGS_DEFAULTS,
      workspaceRoot: defaultWorkspaceRoot(),
      casesRoot: defaultCasesRoot(),
      // mcpServers 走**出口形态**：预置两项里 context7 的 `CONTEXT7_API_KEY` 是敏感键，
      // 出口那一侧照口径把 `${CONTEXT7_API_KEY}` 这个占位也掩掉（值可能是占位、也可能是
      // 用户手填的明文，两者都原样下行就是泄密）。故这里按掩码后的那份比对，而不是拿默认值硬套。
      mcpServers: toSettingsView(SETTINGS_DEFAULTS).mcpServers,
    });
  });

  it('把 workspaceRoot 的 ~ 展开成绝对路径（下行给客户端的总是绝对路径）', () => {
    const settings = getSettings();
    expect(settings.workspaceRoot).not.toContain('~');
  });

  // 读取路径**绝不能**做可写性校验：目录可能正被临时卸载 / 未挂载，此时抛错会让用户连设置页都
  // 打不开，连再改一次的机会都没有。所以拿一个「mkdir 必失败」的存量根目录（被同名文件占住）来钉：
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

  // `SettingsPatch.workspaceRoot` 的类型是 `string | undefined`（`SettingsSchema.partial()`），
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
    saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: '~/.aieval-runs' } });
    const next = updateSettings({ theme: 'dark' });
    expect(next.workspaceRoot).not.toContain('~');
  });

  // saveConfig 会抛原始 errno（EPERM / ENOSPC / 只读盘），而契约要求对外错误
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

/**
 * MCP 密钥的**出口守卫**（本文件里唯一直接盯泄漏的一组）：
 * 落盘那份必须留明文（注入要用原值），而 `GET /api/settings` 与 PUT 的响应里一个明文子串都不能有。
 * 判据取「把整坨响应 JSON 序列化后搜明文子串」——它同时覆盖 http 的 `headers` 与 stdio 的 `env`
 * 两条路径，也覆盖「将来有人多加一条下行通道」；逐字段断言做不到这一点。
 *
 * 另一半是**反例**：PUT 给了真新值就得真的替换。少了它，「未改动」那条规则一旦写宽（例如把所有
 * 敏感键都当成未改动），改密钥会静默无效，而症状要到下次运行才以 401 现身。
 */
describe('MCP 密钥：出口掩码与「未改动」信号', () => {
  const HTTP_KEY = 'ctx7-api-plain-0001';
  const ENV_TOKEN = 'ghp-api-plain-0002';

  /** 把两台 MCP（http + stdio）以**明文**写进落盘配置：出口守卫必须从真实读盘路径上验 */
  function seedPlaintextConfig(): void {
    saveConfig({
      ...loadConfig(),
      settings: {
        ...SETTINGS_DEFAULTS,
        mcpServers: {
          context7: {
            transport: 'http',
            enabled: true,
            url: 'https://mcp.context7.com/mcp',
            headers: { CONTEXT7_API_KEY: HTTP_KEY, Accept: 'application/json' },
          },
          playwright: {
            transport: 'stdio',
            enabled: true,
            command: 'npx',
            env: { GITHUB_TOKEN: ENV_TOKEN, NODE_ENV: 'production' },
          },
        },
      },
    });
  }

  /** 落盘那份的 http headers；形状不对就抛——守卫不许因为取不到值而静默通过 */
  function storedHeaders(name: string): Record<string, string> {
    const entry = loadConfig().settings.mcpServers[name];
    if (entry?.transport !== 'http' || entry.headers === undefined) {
      throw new Error(`落盘里找不到 http 条目 ${name} 的 headers（实际：${JSON.stringify(entry)}）`);
    }
    return entry.headers;
  }

  /** 落盘那份的 stdio env；同一套「取不到就抛」的理由 */
  function storedEnv(name: string): Record<string, string> {
    const entry = loadConfig().settings.mcpServers[name];
    if (entry?.transport !== 'stdio' || entry.env === undefined) {
      throw new Error(`落盘里找不到 stdio 条目 ${name} 的 env（实际：${JSON.stringify(entry)}）`);
    }
    return entry.env;
  }

  it('出口 JSON 里搜不到任何明文，敏感值出的是掩码、非敏感值照常可见', () => {
    seedPlaintextConfig();

    const json = JSON.stringify(getSettings());

    expect(json).not.toContain(HTTP_KEY);
    expect(json).not.toContain(ENV_TOKEN);
    expect(json).toContain(maskApiKey(HTTP_KEY));
    expect(json).toContain('production');
  });

  it('把出口那份原样 PUT 回去：落盘的真密钥不被掩码串覆盖', () => {
    seedPlaintextConfig();
    const view = getSettings();

    const next = updateSettings({ mcpServers: view.mcpServers });

    expect(storedHeaders('context7')['CONTEXT7_API_KEY']).toBe(HTTP_KEY);
    expect(storedEnv('playwright')['GITHUB_TOKEN']).toBe(ENV_TOKEN);
    // 响应也必须仍是掩码：PUT 的返回值就是界面接着用的那份状态
    expect(JSON.stringify(next)).not.toContain(HTTP_KEY);
  });

  it('敏感值 PUT 空串 = 未改动（表单「留空表示不修改」），保留落盘原值', () => {
    seedPlaintextConfig();

    updateSettings({
      mcpServers: {
        context7: {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: '' },
        },
      },
    });

    expect(storedHeaders('context7')['CONTEXT7_API_KEY']).toBe(HTTP_KEY);
  });

  it('反例：PUT 给新值就真的替换（改密钥不许静默无效）', () => {
    seedPlaintextConfig();

    const next = updateSettings({
      mcpServers: {
        context7: {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: 'ctx7-rotated-0009' },
        },
      },
    });

    expect(storedHeaders('context7')['CONTEXT7_API_KEY']).toBe('ctx7-rotated-0009');
    expect(JSON.stringify(next)).not.toContain('ctx7-rotated-0009');
    expect(JSON.stringify(next)).toContain(maskApiKey('ctx7-rotated-0009'));
  });
});
