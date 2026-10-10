// @vitest-environment node
/**
 * 用例存储：`<casesRoot>/<id>.json` 的读写、坏文件容错、id 形状（路径穿越）与测试隔离。
 *
 * 三条必须钉住的口径：
 *   1. **id 是文件名**——`assertCaseId` 是防路径穿越的唯一一道门（`../escape` 这种 id 必须在写读两侧都被拒）；
 *   2. **读侧宽容、写侧严格**——坏文件让 `listCases` 跳过并给出 warnings，让 `readCase` 抛含路径的中文原因；
 *   3. **测试期绝不碰真实家目录**——默认根目录是 `~/.aieval-cases`，本文件一律用 `setCasesRootForTesting`
 *      指向 mkdtemp 出来的临时目录，并顺带钉住「覆盖压过设置」这条优先级。
 *
 * 一律用真实文件系统（不 mock node:fs）：这里错的正是「落盘形状」本身，mock 掉就等于把它假设掉。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DEFAULTS, ServiceError, type TestCase } from '@aieval/contracts';
import {
  assertCaseId,
  caseFile,
  deleteCaseFile,
  getCasesRoot,
  getCasesRootOverrideForTesting,
  listCases,
  readCase,
  setCasesRootForTesting,
  writeCase,
} from './case-store';
import { saveConfig, setConfigDirForTesting } from './config-store';
import { removeTreeWithRetry } from './testing/cleanup';

/**
 * 只把 `renameSync` 包一层（实现原样透传）：下面那条「原子写的实质」守卫要**打挂 rename**，
 * 才能看出实现是「写临时文件再改名」还是「先删目标再写」。
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let dir: string;
let casesRoot: string;

/** 造一条合法用例：只覆盖自己关心的字段 */
function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'c-1',
    title: 'LRU 缓存',
    repoPath: 'D:/repos/demo',
    commitHash: null,
    repoBranch: null,
    taskPrompt: '实现一个 LRU 缓存',
    rubric: { groups: [{ name: '一、功能实现', items: [{ id: 'A1', goal: '实现 LRU 缓存', weight: 20 }] }] },
    createdAt: '2026-09-22T10:30:00.000Z',
    updatedAt: '2026-09-22T10:30:00.000Z',
    ...overrides,
  };
}

/** 直接往用例目录里写一个文件（按「手改过 / 外部工具写进来」的真实来路：绕过 writeCase） */
function seedRawFile(name: string, content: string): void {
  mkdirSync(casesRoot, { recursive: true });
  writeFileSync(join(casesRoot, name), content, 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-case-store-'));
  casesRoot = join(dir, 'cases');
  setConfigDirForTesting(join(dir, 'config'));
  setCasesRootForTesting(casesRoot);
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

describe('路径解析与测试隔离', () => {
  it('用例文件落在 <casesRoot>/<id>.json，目录不存在时不算错误', () => {
    expect(getCasesRoot()).toBe(casesRoot);
    expect(caseFile('c-1')).toBe(join(casesRoot, 'c-1.json'));
    // 目录还没建出来 = 还没有用例（首次使用 / 刚改过根目录），不是错误
    expect(existsSync(casesRoot)).toBe(false);
    expect(listCases()).toEqual({ cases: [], warnings: [] });
  });

  /**
   * 覆盖压过设置：`setCasesRootForTesting` 存在的唯一理由就是「默认根目录在真实家目录下」。
   * 这条守卫故意把设置里的 `casesRoot` 写成另一个（不存在的）目录，再断言读写仍落在临时目录——
   * 少了 override 的值优先，整套用例测试就会去读写开发者的 `~/.aieval-cases`。
   */
  it('测试覆盖压过设置里的 casesRoot（读写不落到真实家目录）', () => {
    const decoy = join(dir, 'decoy-cases');
    saveConfig({ settings: { ...SETTINGS_DEFAULTS, workspaceRoot: join(dir, 'runs'), casesRoot: decoy }, providers: [] });

    // 设置里写的是 decoy，但 override 还在 ⇒ 真源仍是 casesRoot
    expect(getCasesRootOverrideForTesting()).toBe(casesRoot);
    expect(getCasesRoot()).toBe(casesRoot);
    writeCase(makeCase());
    expect(existsSync(join(decoy, 'c-1.json'))).toBe(false);
    expect(existsSync(join(casesRoot, 'c-1.json'))).toBe(true);
  });

  it('没有覆盖时按设置的 casesRoot 解析（生产路径）', () => {
    const configured = join(dir, 'configured-cases');
    saveConfig({ settings: { ...SETTINGS_DEFAULTS, workspaceRoot: join(dir, 'runs'), casesRoot: configured }, providers: [] });
    setCasesRootForTesting(null);

    expect(getCasesRoot()).toBe(configured);
    expect(caseFile('c-1')).toBe(join(configured, 'c-1.json'));
  });
});

describe('id 形状（路径穿越的唯一一道门）', () => {
  it('合法形状原样通过（UUID 与手写 id 都收）', () => {
    for (const id of ['4f027017-192c-4694-9831-38ff935d41f0', 'c-1', 'A_b-9', 'x'.repeat(64)]) {
      expect(assertCaseId(id), id).toBe(id);
    }
  });

  it('带路径分隔符 / .. / 空白 / 超长的 id 一律 INVALID_QUERY', () => {
    for (const id of ['../escape', 'a/b', 'a\\b', '..', '', ' ', 'x'.repeat(65), '用例', 'a b']) {
      let caught: unknown;
      try {
        assertCaseId(id);
      } catch (error) {
        caught = error;
      }
      expect(caught, id).toBeInstanceOf(ServiceError);
      expect((caught as ServiceError).code, id).toBe('INVALID_QUERY');
      expect((caught as ServiceError).message, id).toContain('用例 id 不合法');
    }
  });

  it('穿越型 id 连路径都拼不出来（读 / 写 / 删三条路一起拦）', () => {
    const outside = join(dir, 'escape.json');
    writeFileSync(outside, '{"id":"escape"}', 'utf8');

    expect(() => caseFile('../escape')).toThrow(ServiceError);
    expect(() => readCase('../escape')).toThrow(ServiceError);
    expect(() => writeCase(makeCase({ id: '../escape' }))).toThrow(ServiceError);
    expect(() => deleteCaseFile('../escape')).toThrow(ServiceError);
    // 反向对照：那个越界文件一个字节都没被动过（没被删、也没被覆盖）
    expect(readFileSync(outside, 'utf8')).toBe('{"id":"escape"}');
  });
});

describe('写与读', () => {
  it('写进去读回来逐字一致，且文件是 0600、不带 BOM、不留 .tmp', () => {
    const testCase = makeCase();
    writeCase(testCase);

    expect(readCase('c-1')).toEqual(testCase);
    const text = readFileSync(caseFile('c-1'), 'utf8');
    expect(text.startsWith('\uFEFF')).toBe(false);
    expect(text.endsWith('\n')).toBe(true);
    // 权限：临时文件创建即 0600、rename 之后仍是它（POSIX）
    if (process.platform !== 'win32') expect(statSync(caseFile('c-1')).mode & 0o777).toBe(0o600);
    expect(readdirSync(casesRoot).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('覆盖写是替换：旧内容一个字节都不留', () => {
    writeCase(makeCase({ title: '第一版' }));
    writeCase(makeCase({ title: '第二版' }));

    expect(readCase('c-1')?.title).toBe('第二版');
    expect(readFileSync(caseFile('c-1'), 'utf8')).not.toContain('第一版');
  });

  it('容忍 UTF-8 BOM（PowerShell 5.1 的 Set-Content 默认带它）', () => {
    seedRawFile('c-1.json', `\uFEFF${JSON.stringify(makeCase({ title: 'BOM 写下的' }))}`);

    expect(readCase('c-1')?.title).toBe('BOM 写下的');
    expect(listCases().cases.map((item) => item.title)).toEqual(['BOM 写下的']);
  });

  it('文件名是身份的真源：内容里的 id 与文件名不一致时以文件名为准', () => {
    seedRawFile('c-1.json', JSON.stringify(makeCase({ id: 'c-别的' })));

    expect(readCase('c-1')?.id).toBe('c-1');
    expect(listCases().cases[0]?.id).toBe('c-1');
  });

  it('删除是幂等的（文件本来就不在也算成功）', () => {
    writeCase(makeCase());
    deleteCaseFile('c-1');
    expect(existsSync(caseFile('c-1'))).toBe(false);
    expect(() => deleteCaseFile('c-1')).not.toThrow();
  });
});

describe('坏文件：列表跳过并说出来，详情抛带路径的中文原因', () => {
  it('跳过坏文件并给 warnings；非 .json 文件直接被忽略且不告警', () => {
    writeCase(makeCase({ title: '好的' }));
    // 三种坏形状各一：不是合法 JSON、不是对象（数组）、id 形状不合法
    seedRawFile('broken.json', '{不是 JSON');
    seedRawFile('array.json', '[]');
    seedRawFile('bad name.json', JSON.stringify(makeCase()));
    seedRawFile('README.md', '# 用例仓库\n');

    const listed = listCases();

    expect(listed.cases.map((item) => item.title)).toEqual(['好的']);
    expect(listed.warnings).toHaveLength(3);
    expect(listed.warnings.join('\n')).toContain('broken.json');
    expect(listed.warnings.join('\n')).toContain('array.json');
    expect(listed.warnings.join('\n')).toContain('bad name.json');
    // 非用例文件（README）不算坏用例，也不进 warnings
    expect(listed.warnings.join('\n')).not.toContain('README.md');
  });

  it('读单个坏文件抛 INTERNAL 且原因里带文件路径（不能只说「不存在」）', () => {
    seedRawFile('broken.json', '{不是 JSON');

    let caught: unknown;
    try {
      readCase('broken');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain(join(casesRoot, 'broken.json'));
    // 「不存在」是另一件事（返回 null），不能拿它冒充坏文件
    expect(readCase('missing')).toBeNull();
  });

  it('坏文件不阻断列表，也不被自动清掉（清理由用户决定）', () => {
    seedRawFile('broken.json', '{不是 JSON');

    expect(listCases().warnings).toHaveLength(1);
    expect(existsSync(join(casesRoot, 'broken.json'))).toBe(true);
  });

  it('只读文件也删得掉（删除是删除，不该被权限位拦住）', () => {
    if (process.platform === 'win32') return;
    writeCase(makeCase());
    chmodSync(caseFile('c-1'), 0o444);

    deleteCaseFile('c-1');

    expect(existsSync(caseFile('c-1'))).toBe(false);
  });

  /**
   * **原子写的实质**：覆盖失败时旧文件必须原封不动。
   * 判据刻意打挂 `renameSync`（写临时文件那一步已经成功），于是两种实现分道扬镳：
   *   · 临时文件 + rename（正确）→ 目标还是旧内容，抛中文 INTERNAL；
   *   · 「先删目标再写」（变异体，AGENTS.md 点名的写法）→ 目标已经没了，这里直接 ENOENT。
   * 这条守卫见过失败：变异验证时把 `if (isReadOnly(file)) rmSync(...)` 改成无条件先删，本用例当场红。
   */
  it('rename 失败时旧文件原封不动（不是先删再写）', () => {
    writeCase(makeCase({ title: '旧的一版' }));
    const before = readFileSync(caseFile('c-1'), 'utf8');
    const realRename = vi.mocked(renameSync).getMockImplementation();
    // 两次 rename 都打挂：writeCase 在 rename 失败后会按「目标是否只读」决定是否先删再重试，
    // 这里两次都失败 ⇒ 走最终的错误出口
    vi.mocked(renameSync).mockImplementation(() => {
      throw new Error('EPERM: operation not permitted, rename');
    });

    try {
      expect(() => writeCase(makeCase({ title: '新的一版' }))).toThrowError(/用例保存失败/);
      expect(readFileSync(caseFile('c-1'), 'utf8')).toBe(before);
      expect(readCase('c-1')?.title).toBe('旧的一版');
    } finally {
      if (realRename !== undefined) vi.mocked(renameSync).mockImplementation(realRename);
    }
  });
});

describe('落盘失败的错误信封', () => {
  it('根目录被同名文件占住时抛含路径的中文 INTERNAL', () => {
    // 用例目录「被同名文件占住」：mkdirSync(recursive) 会抛 ENOTDIR/EEXIST
    const occupied = join(dir, 'occupied');
    writeFileSync(occupied, 'x', 'utf8');
    setCasesRootForTesting(occupied);

    let caught: unknown;
    try {
      writeCase(makeCase());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('用例保存失败');
    expect((caught as ServiceError).message).toContain(occupied);
  });

  it('用例文件被目录占住时读侧给中文 INTERNAL（不是裸 EISDIR）', () => {
    // 文件位置上放一个目录：readFileSync 抛 EISDIR，必须折成中文原因
    mkdirSync(caseFile('c-1'), { recursive: true });

    expect(() => readCase('c-1')).toThrowError(/读不出用例文件/);
  });
});
