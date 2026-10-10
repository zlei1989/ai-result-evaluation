// @vitest-environment node
/**
 * 产物的按需读取：代码改动（现场算）与执行日志（读 events.jsonl）。
 *
 * `@aieval/evaluator` 被整块 mock 掉（理由见 runs.test.ts 的文件头：不起真实 agent 进程）；
 * 本文件把自己的快照塞进假 store，从而精确控制「行指向哪个工作区、基线是什么」。
 *
 * `@aieval/core` 只把 `collectDiff` / `truncateDiff` / `readEvents` 包一层可观测的 spy
 * （其余导出原样透传）：这三处是「调用契约」的观测点——例如「裁剪用的是设置里的预算」这条
 * 只能靠 truncateDiff 的第二参断言，用真实实现反而看不出预算从哪来。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type EvalRun } from '@aieval/contracts';
// `collectDiff` / `truncateDiff` / `readEvents` 取自被 mock 之后的那一份：
// `vi.mock` 会被提升到所有 import 之前（无论 import 写在文件哪一行），故与其余导出同一条语句引入——
// 分两条 import 同一模块会撞仓库的 `import-x/no-duplicates`（error 级）。
import { appendEvent, collectDiff, readEvents, setCasesRootForTesting, setConfigDirForTesting, truncateDiff } from '@aieval/core';
import { getRun as getRunSnapshot } from '@aieval/evaluator';
import { getRowDiffFile, getRowDiffIndex, getRowLog, resetRowDiffCache } from './run-artifacts';
import { updateSettings } from './settings';
import { makeAnthropicProvider, makeCase, makeRow, makeRun, seedConfig } from './testing/run-fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
}));

vi.mock('@aieval/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/core')>();
  return {
    ...actual,
    collectDiff: vi.fn(actual.collectDiff),
    truncateDiff: vi.fn(actual.truncateDiff),
    readEvents: vi.fn(actual.readEvents),
  };
});

let dir: string;
let workspaceRoot: string;
/** 假的「磁盘」：getRun 从这里读 */
let store: Map<string, EvalRun>;

/** 把一轮评测放进假 store，并按需建出该行的工作区目录 */
function seedRun(run: EvalRun, options: { createWorkspace?: boolean } = {}): void {
  store.set(run.id, run);
  if (options.createWorkspace === true) {
    for (const row of run.rows) mkdirSync(row.workspacePath, { recursive: true });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-artifacts-'));
  setConfigDirForTesting(dir);
  // 用例目录也要指到临时目录：用例是一文件一落（core 的 `case-store`），config 目录的 override 管不到它
  setCasesRootForTesting(join(dir, 'cases'));
  workspaceRoot = join(dir, 'ws');
  updateSettings({ workspaceRoot });
  seedConfig({ providers: [makeAnthropicProvider()], cases: [makeCase()] });

  store = new Map();
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
  vi.mocked(collectDiff).mockClear();
  vi.mocked(truncateDiff).mockClear();
  vi.mocked(readEvents).mockClear();
  // 上面三个 mock 都是 `vi.fn(真实实现)`，而本仓没开 `clearMocks`、`mockClear` 又**不还原实现**：
  // 不装默认值的话，「裁剪预算」「按 workspaceBase 找产物」这两条只关心别的断言的用例，
  // 会因为前面某条用例（或缺失的前置用例）留下的实现而红——单独跑 `-t` 时就是这种红。
  // 这里给 collectDiff 一个「跑得通」的默认返回，需要真算或需要抛错的用例自己覆盖它。
  vi.mocked(collectDiff).mockReturnValue({
    text: '',
    files: [],
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  });
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

describe('getRowDiffIndex / getRowDiffFile', () => {
  const TEXT = [
    '### 已提交改动（baseline-40..HEAD）',
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '### 未提交改动（工作区 vs HEAD）',
    '（无）',
    '### 未跟踪文件',
    'c.ts',
    '',
  ].join('\n');

  beforeEach(() => {
    // 缓存是模块级 Map，用例之间必须清干净，否则「第一次算、第二次命中」会串台
    resetRowDiffCache();
  });

  function seedWithDiff(files: { path: string; insertions: number; deletions: number }[]): void {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockReturnValue({
      text: TEXT,
      files,
      filesChanged: files.length,
      insertions: files.reduce((sum, f) => sum + f.insertions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    });
    vi.mocked(truncateDiff).mockImplementation((text: string) => ({ text, truncated: false, droppedFiles: [] }));
  }

  it('工作区还不存在时抛 CONFLICT，且不去跑 git', () => {
    seedRun(makeRun({ rows: [makeRow({ workspacePath: join(workspaceRoot, 'run-1', 'rows', 'r-1', 'workspace') })] }));

    let caught: unknown;
    try {
      getRowDiffIndex('run-1', 'r-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as ServiceError).message).toContain('还没有工作区');
    expect(vi.mocked(collectDiff)).not.toHaveBeenCalled();
  });

  it('索引：分页切片，但 total 与增删合计是全局值（不随翻页跳动）', () => {
    seedWithDiff([
      { path: 'a.ts', insertions: 1, deletions: 0 },
      { path: 'c.ts', insertions: 5, deletions: 2 },
    ]);

    const page = getRowDiffIndex('run-1', 'r-1', 0, 1);

    expect(page.total).toBe(2);
    expect(page.offset).toBe(0);
    expect(page.files.map((f) => f.path)).toEqual(['a.ts']);
    // 全局合计：两个文件加起来，而不是本页那一个
    expect(page.insertions).toBe(6);
    expect(page.deletions).toBe(2);
  });

  it('索引：第二页给出剩下那些，offset 如实回报', () => {
    seedWithDiff([
      { path: 'a.ts', insertions: 1, deletions: 0 },
      { path: 'c.ts', insertions: 5, deletions: 2 },
    ]);

    const page = getRowDiffIndex('run-1', 'r-1', 1, 1);

    expect(page.offset).toBe(1);
    expect(page.files.map((f) => f.path)).toEqual(['c.ts']);
  });

  it('索引：limit 封顶 200（手改 URL 不能把全量拉回来）', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ path: `f${i}.ts`, insertions: 1, deletions: 0 }));
    seedWithDiff(many);

    expect(getRowDiffIndex('run-1', 'r-1', 0, 9999).files).toHaveLength(200);
  });

  it('索引：offset/limit 非法时按默认值处理，不抛错（只读展示接口宽容降级）', () => {
    seedWithDiff([{ path: 'a.ts', insertions: 1, deletions: 0 }]);

    expect(getRowDiffIndex('run-1', 'r-1', -5, -1).files).toHaveLength(1);
    expect(getRowDiffIndex('run-1', 'r-1', 1.5, 2.5).offset).toBe(0);
  });

  it('索引：未跟踪文件带 untracked 标记，普通文件不带', () => {
    seedWithDiff([
      { path: 'a.ts', insertions: 1, deletions: 0 },
      { path: 'c.ts', insertions: 5, deletions: 2 },
    ]);

    const page = getRowDiffIndex('run-1', 'r-1');

    expect(page.files.find((f) => f.path === 'c.ts')?.untracked).toBe(true);
    expect(page.files.find((f) => f.path === 'a.ts')?.untracked).toBe(false);
  });

  it('索引：被预算丢弃的文件 hasBody=false，并计入 noBodyCount 与 droppedFiles', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockReturnValue({
      text: TEXT,
      files: [
        { path: 'a.ts', insertions: 1, deletions: 0 },
        { path: 'c.ts', insertions: 5, deletions: 2 },
      ],
      filesChanged: 2,
      insertions: 6,
      deletions: 2,
    });
    // 模拟预算只装得下第一个文件
    vi.mocked(truncateDiff).mockReturnValue({ text: TEXT, truncated: true, droppedFiles: ['c.ts'] });

    const page = getRowDiffIndex('run-1', 'r-1');

    expect(page.truncated).toBe(true);
    expect(page.droppedFiles).toEqual(['c.ts']);
    expect(page.noBodyCount).toBe(1);
    expect(page.files.find((f) => f.path === 'a.ts')?.hasBody).toBe(true);
    expect(page.files.find((f) => f.path === 'c.ts')?.hasBody).toBe(false);
  });

  it('单文件正文：取到那一段，并带上该文件的计数', () => {
    seedWithDiff([
      { path: 'a.ts', insertions: 1, deletions: 0 },
      { path: 'c.ts', insertions: 5, deletions: 2 },
    ]);

    const file = getRowDiffFile('run-1', 'r-1', 'a.ts');

    expect(file.path).toBe('a.ts');
    expect(file.patch).toContain('+new');
    expect(file.insertions).toBe(1);
    expect(file.deletions).toBe(0);
    expect(file.binary).toBe(false);
  });

  it('单文件正文：路径不在本次改动里 → NOT_FOUND（与「被丢弃」是两回事）', () => {
    seedWithDiff([{ path: 'a.ts', insertions: 1, deletions: 0 }]);

    let caught: unknown;
    try {
      getRowDiffFile('run-1', 'r-1', 'nope.ts');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });

  it('单文件正文：文件在、但正文被预算丢了 → CONFLICT 且说清原因', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockReturnValue({
      text: '### 未提交改动（工作区 vs HEAD）\n（无）\n',
      files: [{ path: 'a.ts', insertions: 1, deletions: 0 }],
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
    vi.mocked(truncateDiff).mockReturnValue({ text: '', truncated: true, droppedFiles: ['a.ts'] });

    let caught: unknown;
    try {
      getRowDiffFile('run-1', 'r-1', 'a.ts');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as ServiceError).message).toContain('未包含在本轮评分输入中');
  });

  it('单文件正文：没有 @@ 的段落算二进制（界面不渲染 diff 视图）', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockReturnValue({
      text: '### 未提交改动（工作区 vs HEAD）\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n',
      files: [{ path: 'img.png', insertions: 0, deletions: 0 }],
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    });
    vi.mocked(truncateDiff).mockImplementation((text: string) => ({ text, truncated: false, droppedFiles: [] }));

    expect(getRowDiffFile('run-1', 'r-1', 'img.png').binary).toBe(true);
  });

  it('裁剪预算取自设置里的 diffBudgetBytes，而不是硬编码的 256KB', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    updateSettings({ diffBudgetBytes: 12_345 });

    getRowDiffIndex('run-1', 'r-1');

    expect(vi.mocked(truncateDiff)).toHaveBeenCalledWith(expect.any(String), 12_345);
  });

  it('30 秒缓存：一次抽屉会话里多次请求只跑一次 git', () => {
    seedWithDiff([{ path: 'a.ts', insertions: 1, deletions: 0 }]);

    getRowDiffIndex('run-1', 'r-1');
    getRowDiffFile('run-1', 'r-1', 'a.ts');
    getRowDiffIndex('run-1', 'r-1', 0, 30);

    expect(vi.mocked(collectDiff)).toHaveBeenCalledTimes(1);
  });

  it('按该轮快照里的 workspaceBase 找产物，而不是当前设置里的根目录', () => {
    const oldRoot = join(dir, 'old-ws');
    const row = makeRow({ id: 'r-1', workspacePath: join(oldRoot, 'run-1', 'rows', 'r-1', 'workspace') });
    seedRun(makeRun({ id: 'run-1', workspaceBase: oldRoot, rows: [row] }));
    mkdirSync(row.workspacePath, { recursive: true });
    updateSettings({ workspaceRoot: join(dir, 'new-ws') });
    vi.mocked(collectDiff).mockReturnValue({ text: '', files: [], filesChanged: 0, insertions: 0, deletions: 0 });
    vi.mocked(truncateDiff).mockImplementation((text: string) => ({ text, truncated: false, droppedFiles: [] }));

    getRowDiffIndex('run-1', 'r-1');

    expect(vi.mocked(collectDiff)).toHaveBeenCalledWith(row.workspacePath, row.baselineCommit);
  });

  it('git 抛错时折成含路径的中文原因（不透英文 stderr）', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockImplementation(() => {
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    });

    let caught: unknown;
    try {
      getRowDiffIndex('run-1', 'r-1');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('读取代码改动失败');
    expect((caught as ServiceError).message).toContain('not a git repository');
  });

  it('行 id 不存在时抛 NOT_FOUND', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1' })] }), { createWorkspace: true });

    expect(() => getRowDiffIndex('run-1', 'r-x')).toThrowError(/没有这一行/);
  });
});

describe('getRowLog', () => {
  it('不给 afterSeq 时读全量；给了就只读 seq 更大的部分', () => {
    const run = makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] });
    seedRun(run);
    const file = join(workspaceRoot, 'run-1', 'rows', 'r-1', 'events.jsonl');
    mkdirSync(join(workspaceRoot, 'run-1', 'rows', 'r-1'), { recursive: true });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '一行' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '二行' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '三行' });

    expect(getRowLog('run-1', 'r-1').map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(getRowLog('run-1', 'r-1', 2).map((event) => event.seq)).toEqual([3]);
    // afterSeq=0 等价于「从头」（抽屉首帧）
    expect(getRowLog('run-1', 'r-1', 0).map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('事件文件还不存在时返回空数组，而不是报错', () => {
    seedRun(makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));

    expect(getRowLog('run-1', 'r-1')).toEqual([]);
  });

  it('读日志失败时折成含文件路径的中文原因（不把 SyntaxError 抛成 500）', () => {
    seedRun(makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    // 造一个真的坏文件：末行是半截 JSON（进程被杀在写一半时的真实形态）
    const rowDir = join(workspaceRoot, 'run-1', 'rows', 'r-1');
    mkdirSync(rowDir, { recursive: true });
    writeFileSync(join(rowDir, 'events.jsonl'), '{"seq":1,"at":"2026-09-22T08:00:00.000Z","type":"log","stream":"stdout","text":"half', 'utf8');
    // 用 `once` 而不是常驻的 `mockImplementation`：本仓的 vitest **没开 `clearMocks`**
    //（`vitest.node.ts` 只设 environment/include），而 beforeEach 里的 `mockClear` 只清调用记录、
    // **不还原实现**——常驻的抛错实现会漏给后面「按 workspaceBase 读日志」那条用例，把它一起染红。
    // 这里的一次性实现被本次 `getRowLog` 调用当场消费，泄漏路径因此不存在。
    vi.mocked(readEvents).mockImplementationOnce(() => {
      throw new SyntaxError('Unexpected end of JSON input');
    });

    let caught: unknown;
    try {
      getRowLog('run-1', 'r-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('读取执行日志失败');
    expect((caught as ServiceError).message).toContain('events.jsonl');
  });

  it('按该轮快照里的 workspaceBase 读日志，而不是当前设置里的根目录', () => {
    const oldRoot = join(dir, 'old-ws');
    const run = makeRun({ id: 'run-1', workspaceBase: oldRoot, rows: [makeRow({ id: 'r-1' })] });
    seedRun(run);
    const rowDir = join(oldRoot, 'run-1', 'rows', 'r-1');
    mkdirSync(rowDir, { recursive: true });
    appendEvent(join(rowDir, 'events.jsonl'), { type: 'log', stream: 'stdout', text: '旧根目录里的事件' });
    updateSettings({ workspaceRoot: join(dir, 'new-ws') });

    // `AgentEvent` 是判别联合，非 `log` 成员没有 `text` 字段（直接写 `event.text` 过不了 typecheck）；
    // 这里按判别式收窄，断言强度不变：非 log 事件会取到空串，同样让 toEqual 红。
    expect(getRowLog('run-1', 'r-1').map((event) => (event.type === 'log' ? event.text : ''))).toEqual(['旧根目录里的事件']);
  });

  it('行 id 不存在时抛 NOT_FOUND', () => {
    seedRun(makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));

    expect(() => getRowLog('run-1', 'r-x')).toThrowError(/没有这一行/);
  });
});
