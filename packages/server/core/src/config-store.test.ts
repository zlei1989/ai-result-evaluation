// @vitest-environment node
/**
 * 配置落盘：默认值、缺失字段归一化、原子写、BOM 容忍、损坏配置的中文报错。
 * 注意：测试一律用 setConfigDirForTesting 指向临时目录，不碰真实 ~/.aieval。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, SETTINGS_DEFAULTS } from '@aieval/contracts';
import { getConfigDir, loadConfig, saveConfig, setConfigDirForTesting } from './config-store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-config-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('getConfigDir', () => {
  it('测试覆盖优先于家目录', () => {
    expect(getConfigDir()).toBe(dir);
  });

  it('AIEVAL_CONFIG_DIR 为空串时回落到家目录，而不是把配置写到 cwd', () => {
    const previous = process.env.AIEVAL_CONFIG_DIR;
    setConfigDirForTesting(null);
    process.env.AIEVAL_CONFIG_DIR = '';
    try {
      // 空串不是有效目录：`??` 会把它当有效值，于是 configFile() 变成相对的 'config.json'，
      // 落盘位置取决于进程 cwd。必须与「没设」一样回落到 ~/.aieval。
      expect(getConfigDir()).toBe(join(homedir(), '.aieval'));
    } finally {
      if (previous === undefined) delete process.env.AIEVAL_CONFIG_DIR;
      else process.env.AIEVAL_CONFIG_DIR = previous;
    }
  });
});

describe('loadConfig', () => {
  it('文件不存在时返回完整默认配置，且不抛错', () => {
    const config = loadConfig();
    expect(config.settings).toEqual(SETTINGS_DEFAULTS);
    expect(config.providers).toEqual([]);
    expect(config.cases).toEqual([]);
  });

  it('两次 loadConfig 返回的对象互不影响（注释承诺的「每次返回新对象」）', () => {
    const first = loadConfig();
    first.settings.rowTimeoutMs = 999;
    expect(loadConfig().settings.rowTimeoutMs).toBe(SETTINGS_DEFAULTS.rowTimeoutMs);
  });

  it('settings 的嵌套字段不与共享默认值常量别名（structuredClone 的实际意义）', () => {
    // 当前 SETTINGS_DEFAULTS 里唯一的嵌套对象 defaultJudge 默认为 null，此时浅拷贝与深拷贝
    // 观测上无差别；这里临时把它换成对象，让「共享引用」可观测，finally 还原。
    const pristine = SETTINGS_DEFAULTS.defaultJudge;
    try {
      SETTINGS_DEFAULTS.defaultJudge = { providerId: 'shared', modelId: 'shared' };
      const judge = loadConfig().settings.defaultJudge;
      if (judge === null) throw new Error('前置条件不成立：defaultJudge 应已被替换为对象');
      judge.providerId = 'polluted';
      // 浅拷贝（{ ...SETTINGS_DEFAULTS }）下这里会读到 'polluted'：两次读取共享同一个嵌套对象
      expect(loadConfig().settings.defaultJudge).toEqual({ providerId: 'shared', modelId: 'shared' });
      expect(SETTINGS_DEFAULTS.defaultJudge).toEqual({ providerId: 'shared', modelId: 'shared' });
    } finally {
      SETTINGS_DEFAULTS.defaultJudge = pristine;
    }
  });

  it('缺失字段按默认值归一化（旧版本配置文件缺 cases 也能读）', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ settings: { theme: 'dark' } }), 'utf8');
    const config = loadConfig();
    expect(config.settings.theme).toBe('dark');
    // 未写出的字段回落到默认值，保证下行字段恒存在
    expect(config.settings.rowTimeoutMs).toBe(SETTINGS_DEFAULTS.rowTimeoutMs);
    expect(config.settings.workspaceRoot).toBe(SETTINGS_DEFAULTS.workspaceRoot);
    expect(config.providers).toEqual([]);
  });

  it('容忍外部工具写入的 UTF-8 BOM', () => {
    const body = JSON.stringify({ settings: { ...SETTINGS_DEFAULTS, theme: 'light' } });
    writeFileSync(join(dir, 'config.json'), `\uFEFF${body}`, 'utf8');
    expect(loadConfig().settings.theme).toBe('light');
  });

  it('配置真的损坏时抛 ServiceError，且 message 含文件路径与中文原因', () => {
    writeFileSync(join(dir, 'config.json'), '{ 这不是 JSON', 'utf8');
    let caught: unknown;
    try {
      loadConfig();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    const error = caught as ServiceError;
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('config.json');
    expect(error.message).toContain('不是合法 JSON');
  });
});

describe('saveConfig', () => {
  it('写出的文件是格式化 JSON，且能被 loadConfig 读回（往返一致）', () => {
    const config = loadConfig();
    config.settings.theme = 'dark';
    saveConfig(config);

    const raw = readFileSync(join(dir, 'config.json'), 'utf8');
    expect(raw).toContain('\n');                    // 格式化过，不是单行
    expect(raw).not.toMatch(/^\uFEFF/);             // 自己写盘不产 BOM
    expect(loadConfig().settings.theme).toBe('dark');
  });

  it('目录不存在时自动创建', () => {
    const nested = join(dir, 'a', 'b');
    setConfigDirForTesting(nested);
    saveConfig(loadConfig());
    expect(existsSync(join(nested, 'config.json'))).toBe(true);
  });

  it('覆盖写不残留临时文件（原子写的另一半）', () => {
    saveConfig(loadConfig());
    saveConfig(loadConfig());
    const leftovers = readFileSync(join(dir, 'config.json'), 'utf8');
    expect(leftovers.length).toBeGreaterThan(0);
    // 临时文件必须已被 rename 掉
    expect(existsSync(join(dir, 'config.json.tmp'))).toBe(false);
  });

  it('写盘走「临时文件（创建即 0600）→ rename」而非直接覆盖（原子写的回归守卫）', async () => {
    // 为什么必须 mock：只断言「临时文件不存在」的话，直接 writeFileSync 覆盖目标的实现
    // 同样能通过——那条断言对非原子实现没有区分力（实测过）。
    vi.resetModules();
    const calls: string[] = [];
    const writeOptions: unknown[] = [];
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        writeFileSync: (path: unknown, ...rest: unknown[]) => {
          calls.push(`write:${String(path)}`);
          // rest = [data, options]；记下创建时的选项，用于断言 0600 是**创建时**给的
          writeOptions.push(rest[1]);
          return (actual.writeFileSync as (...a: unknown[]) => void)(path, ...rest);
        },
        renameSync: (from: unknown, to: unknown) => {
          calls.push(`rename:${String(from)}->${String(to)}`);
          return (actual.renameSync as (...a: unknown[]) => void)(from, to);
        },
        // 删除也要记：先删目标再 rename 在两步之间留下「配置文件不存在」的窗口，
        // 必须在调用序列里可见，否则这条守卫拦不住它。
        rmSync: (path: unknown, ...rest: unknown[]) => {
          calls.push(`rm:${String(path)}`);
          return (actual.rmSync as (...a: unknown[]) => void)(path, ...rest);
        },
      };
    });

    const {
      saveConfig: saveConfigMocked,
      loadConfig: loadConfigMocked,
      setConfigDirForTesting: setDir,
    } = await import('./config-store');
    setDir(dir);
    saveConfigMocked(loadConfigMocked());
    // 第二次：目标文件此时已存在，正是「先删再 rename」会露出 rmSync 的那一步
    saveConfigMocked(loadConfigMocked());

    // 直奔目标文件的写必须为 0 条；且 rename 必须发生在 write 之后
    expect(calls.some((c) => c === `write:${join(dir, 'config.json')}`)).toBe(false);
    expect(calls).toContain(`write:${join(dir, 'config.json')}.tmp`);
    expect(calls).toContain(`rename:${join(dir, 'config.json')}.tmp->${join(dir, 'config.json')}`);
    expect(calls.findIndex((c) => c.startsWith('write:'))).toBeLessThan(calls.findIndex((c) => c.startsWith('rename:')));
    // 目标可写时不得删除目标：rename 本身就是原子替换，先删只会制造丢配置的窗口
    expect(calls).not.toContain(`rm:${join(dir, 'config.json')}`);
    // 明文凭据要求 0600 在**创建时**就给出：先按默认 mode 建好再 chmod 会留一个可读窗口
    expect(writeOptions[0]).toEqual({ encoding: 'utf8', mode: 0o600 });

    vi.doUnmock('node:fs');
    vi.resetModules();
    const restored = await import('./config-store');
    restored.setConfigDirForTesting(dir);
  });
});
