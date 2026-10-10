// @vitest-environment node
/**
 * 配置落盘：默认值、缺失字段归一化、原子写、BOM 容忍、损坏配置的中文报错。
 * 注意：测试一律用 setConfigDirForTesting 指向临时目录，不碰真实 ~/.aieval。
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSchema, ServiceError, SETTINGS_DEFAULTS, TestCaseSchema, type TestCase } from '@aieval/contracts';
import { readCase, setCasesRootForTesting, writeCase } from './case-store';
import { getConfigDir, loadConfig, saveConfig, setConfigDirForTesting } from './config-store';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-config-'));
  setConfigDirForTesting(dir);
  // 用例住 `<casesRoot>/<id>.json`，不在配置目录里——本文件那条跨存储的回归守卫要写一份用例文件，
  // 故用例目录也要指到临时目录（默认根目录是真实的 ~/.aieval-cases）
  setCasesRootForTesting(join(dir, 'cases'));
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
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
    // 用例已搬去 `<casesRoot>/<id>.json`：配置对象里**没有**这一格。
    // 多一个键就等于两份真源（写入侧只写一份，读侧看到的是另一份）
    expect('cases' in config).toBe(false);
  });

  /**
   * 旧版本把用例写在 `config.json` 的 `cases` 数组里。搬到独立文件之后这一格被**静默忽略**
   * （用户口径 2026-10-09：不做迁移、不做兼容，用例由用户手工搬），但「忽略」不等于「读进运行时」——
   * 一条手改残留的 `cases` 若又进了 `AppConfig`，设置页保存时就会把整份覆盖写回，等于凭空复活一份旧数据。
   * 判据刻意是「键在不在」而不是「值等不等于空数组」：后者在实现重新读它时照样绿。
   */
  it('旧 config.json 里的 cases 数组被忽略，不进 AppConfig', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ settings: SETTINGS_DEFAULTS, providers: [], cases: [{ id: 'c-legacy', title: '旧用例' }] }),
      'utf8',
    );

    const config = loadConfig();

    expect('cases' in config).toBe(false);
    expect(config.providers).toEqual([]);
    // 反向对照：同一份文件里 settings 照常读回来（不是把整份配置丢了）
    expect(config.settings.theme).toBe(SETTINGS_DEFAULTS.theme);
  });

  it('两次 loadConfig 返回的对象互不影响（注释承诺的「每次返回新对象」）', () => {
    const first = loadConfig();
    first.settings.diffBudgetBytes = 999;
    expect(loadConfig().settings.diffBudgetBytes).toBe(SETTINGS_DEFAULTS.diffBudgetBytes);
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
    expect(config.settings.diffBudgetBytes).toBe(SETTINGS_DEFAULTS.diffBudgetBytes);
    expect(config.settings.workspaceRoot).toBe(SETTINGS_DEFAULTS.workspaceRoot);
    expect(config.providers).toEqual([]);
  });

  // 2026-09-28 删掉「单行超时」之后，磁盘上**已有**的 config.json 里还留着 rowTimeoutMs。
  // 读侧**只认契约里还有的键**：它既不能让读盘失败，也不该继续出现在 `GET /api/settings` 的
  // 响应里（那是契约里不存在的字段）——落盘数据照原样留在文件里，下一次保存自然把它带走。
  it('旧配置里多出来的 rowTimeoutMs 被丢掉（不抛、其余字段照常、读侧看不到它）', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ settings: { theme: 'dark', rowTimeoutMs: 1_800_000 } }),
      'utf8',
    );
    const config = loadConfig();
    expect(config.settings.theme).toBe('dark');
    expect(config.settings.diffBudgetBytes).toBe(SETTINGS_DEFAULTS.diffBudgetBytes);
    expect('rowTimeoutMs' in config.settings).toBe(false);
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

  it('rename 瞬时失败（Windows 杀软/索引器占用）时不得删除目标，重试即可', async () => {
    // 为什么单列一条：EPERM 有两种成因，症状一样、处置相反。
    //   ① 目标只读——替换必失败，只能先删目标再重命名（下一条守卫钉住这一半）；
    //   ② 杀软/索引器瞬时占用——纯粹是瞬时的，重试 rename 就过去了。
    // 把 ② 也当成 ① 处理会白白制造「配置文件不存在」的窗口：崩溃或并发读取撞进去，
    // loadConfig() 会静默回落默认值，设置、供应商与明文 apiKey 一起丢。
    // 实测这条窗口真的会被触发：`pnpm test` 全量并发跑时稳定复现（8 次里红 1～2 次），
    // 日志里是 `[WARN] rename 覆盖配置失败，回退到删除后重试 … EPERM`。
    vi.resetModules();
    const calls: string[] = [];
    let renameAttempts = 0;
    let failNextRename = false;
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        renameSync: (from: unknown, to: unknown) => {
          renameAttempts += 1;
          calls.push(`rename:${String(from)}->${String(to)}`);
          if (failNextRename) {
            failNextRename = false;
            throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
          }
          return (actual.renameSync as (...a: unknown[]) => void)(from, to);
        },
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
    // 先落一份「健康的既有配置」：目标可写（0600 写出来，Windows 上不带只读属性）
    const seeded = loadConfigMocked();
    seeded.settings.theme = 'dark';
    saveConfigMocked(seeded);

    renameAttempts = 0;
    calls.length = 0;
    failNextRename = true;
    const next = loadConfigMocked();
    next.settings.theme = 'light';
    saveConfigMocked(next);

    // 失败一次就该重试（而不是放弃保存）
    expect(renameAttempts).toBe(2);
    // 目标可写 ⇒ 重试足以成功，任何对目标的删除都是多余的丢配置窗口
    expect(calls).not.toContain(`rm:${join(dir, 'config.json')}`);
    expect(loadConfigMocked().settings.theme).toBe('light');

    vi.doUnmock('node:fs');
    vi.resetModules();
    const restored = await import('./config-store');
    restored.setConfigDirForTesting(dir);
  });

  it('目标被外部置为只读时仍能保存（只读这一半回退不许被顺手删掉）', async () => {
    // 上一条守卫要求「目标可写时不许删」，很容易被过度修正成「永远不删」——那会让只读目标
    // 再也保存不了（裸 rename 替换只读文件在 Windows 上必失败）。这条从**结果**侧钉住另一半：
    // 只读目标仍必须保存成功。
    // renameSync 用桩模拟 Windows 语义（目标只读则抛 EPERM），否则在「本机 rename 恰好能覆盖
    // 只读文件」的环境里这条会变成没有区分力的空断言。
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        renameSync: (from: unknown, to: unknown) => {
          const target = actual.statSync(String(to), { throwIfNoEntry: false });
          if (target && (target.mode & 0o200) === 0) {
            throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
          }
          return (actual.renameSync as (...a: unknown[]) => void)(from, to);
        },
      };
    });

    const {
      saveConfig: saveConfigMocked,
      loadConfig: loadConfigMocked,
      setConfigDirForTesting: setDir,
    } = await import('./config-store');
    setDir(dir);
    const seeded = loadConfigMocked();
    seeded.settings.theme = 'dark';
    saveConfigMocked(seeded);

    const file = join(dir, 'config.json');
    chmodSync(file, 0o444);
    // 前置条件：本平台的 stat 必须真的能反映只读（Windows 上 libuv 用写位表达只读属性）。
    // 不成立的话下面的断言就是在测一个不存在的场景，必须在这里就炸掉。
    expect(statSync(file).mode & 0o200).toBe(0);

    const next = loadConfigMocked();
    next.settings.theme = 'light';
    saveConfigMocked(next);

    expect(loadConfigMocked().settings.theme).toBe('light');

    vi.doUnmock('node:fs');
    vi.resetModules();
    const restored = await import('./config-store');
    restored.setConfigDirForTesting(dir);
  });
});

describe('落盘的 Provider / TestCase 与契约同形（去重复类型后的回归守卫）', () => {
  it('写出的 Provider / TestCase 记录能被 contracts 的 schema 直接解析', () => {
    const config = loadConfig();
    config.providers.push({
      id: 'p-1',
      name: 'DeepSeek 官方',
      protocolType: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-abcdefghijklmn',
      models: [{ id: 'deepseek-chat', source: 'fetched' }],
      createdAt: '2026-09-22T10:30:00.000Z',
      updatedAt: '2026-09-22T10:30:00.000Z',
    });
    saveConfig(config);
    // 用例走另一个存储（`case-store` 的 `writeCase`）：两者各写各的，读回来一起过契约 schema
    const testCase: TestCase = {
      id: 'c-1',
      title: 'LRU 缓存',
      repoPath: 'D:/repos/demo',
      commitHash: null,
      repoBranch: null,
      taskPrompt: '实现一个 LRU 缓存',
      // 判据已换成**评分表**（Task 2：`TestCase.judgePrompt` → `rubric`）。形状与 evaluator 夹具同一约定：
      // 一组、一项、带 id——本用例只关心「core 写出的记录能被契约 schema 解析」，表的内容是叙述性的
      rubric: { groups: [{ name: '一、功能实现', items: [{ id: 'A1', goal: '实现 LRU 缓存', weight: 20 }] }] },
      createdAt: '2026-09-22T10:30:00.000Z',
      updatedAt: '2026-09-22T10:30:00.000Z',
    };
    writeCase(testCase);

    const roundTripped = loadConfig();
    const storedCase = readCase('c-1');
    // 用契约 schema 解析落盘再读回的对象：core 的本地类型一旦与契约漂移（少字段、多字段、
    // 枚举取值不同），这里会直接失败——这正是「去重复声明」要守的那条线。
    const provider = ProviderSchema.safeParse(roundTripped.providers[0]);
    const testCaseParsed = TestCaseSchema.safeParse(storedCase);
    expect(provider.success).toBe(true);
    expect(testCaseParsed.success).toBe(true);
    expect(roundTripped.providers[0]?.protocolType).toBe('openai');
    expect(storedCase?.commitHash).toBeNull();
  });
});
