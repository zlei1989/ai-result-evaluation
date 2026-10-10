// @vitest-environment node
/**
 * 运行快照读写：落盘、按用例筛选、坏文件跳过、缺文件抛 NOT_FOUND。
 * 配置目录与工作区根目录一律指向 mkdtempSync 出来的临时目录——绝不碰真实的 ~/.aieval 与 ~/.aieval-runs。
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DEFAULTS, ServiceError, type EvalRun } from '@aieval/contracts';
import { loadConfig, readEvents, rowEventsFile, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { publishRowEvent } from './events';
import { recalledRunRoot } from './run-root-memory';
import { getRun, getRunForWrite, listRuns, listRunsForCase, saveRun } from './run-store';
import { makeRowFixture, makeRunFixture, makeScoreFixture, RUBRIC_FIXTURE } from './testing/fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

// 「rename 覆盖失败」的三个分支（瞬时失败要重试 / 只读才先删 / 两次都失败要报中文错）无法在 CI 上
// 稳定造出真实成因：只把 renameSync 与 rmSync 换成可注入的替身（默认原样透传），
// config-store 的原子写与 run-store 的其余路径照常走真实文件系统。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), rmSync: vi.fn(actual.rmSync) };
});

/** 取抛出的错误（断言 code 时必须拿到对象本身，不能只 expect(...).toThrow()） */
function thrownBy(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

let dir: string;
let ws: string;

beforeEach(() => {
  // 先复位实现：上一轮用例可能装了粘性 mockImplementation（mockReset 还原为 vi.fn(actual.renameSync)）
  vi.mocked(renameSync).mockReset();
  vi.mocked(rmSync).mockReset();
  dir = mkdtempSync(join(tmpdir(), 'aieval-run-store-'));
  ws = join(dir, 'runs');
  mkdirSync(ws, { recursive: true });
  setConfigDirForTesting(dir);
  saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: ws } });
  // 夹具自身（saveConfig）的写盘调用不计入用例内的次数断言
  vi.mocked(renameSync).mockClear();
  vi.mocked(rmSync).mockClear();
});

afterEach(() => {
  // 先复位再删目录：万一删目录抛错，覆盖值会漏给下一个用例
  setConfigDirForTesting(null);
  removeTreeWithRetry(dir);
});

/**
 * 最小合法快照：rows 允许为空数组，其余字段必须给全——
 * 少任何一个 EvalRunSchema 都会拒绝，测试就变成在测自己的夹具而不是被测代码。
 * `rubric` 与 `caseTitle` / `repoPath` 同一档：它是**必填的评分表快照**，缺了 `saveRun` 的写侧自检
 * 会直接拒绝（契约），而那时红的会是这一整个文件里的每一条用例。
 */
function makeRun(overrides: Partial<EvalRun> & Pick<EvalRun, 'id' | 'caseId'>): EvalRun {
  return {
    caseTitle: '示例用例',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
    rubric: RUBRIC_FIXTURE,
    status: 'idle',
    executionMode: 'parallel',
    useAgentJudge: false,
    rows: [],
    workspaceBase: ws,
    createdAt: '2026-09-22T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('run-store', () => {
  it('saveRun 后 getRun 原样读回（含中文与非 ASCII 字段）', () => {
    const run = makeRun({ id: 'run-1', caseId: 'case-1', caseTitle: '中文标题 · 用例「甲」' });

    saveRun(run);

    expect(getRun('run-1')).toEqual(run);
  });

  it('重复 saveRun 同一 runId 时后写的覆盖前写的（整体覆盖，不做增量合并）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'idle' }));

    saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'done' }));

    expect(getRun('run-1').status).toBe('done');
  });

  it('listRuns 只认 run.json，不把工作区里的 cases 缓存目录当成一次评测', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1' }));
    // 用例级缓存仓库就住在同一个根目录下：{workspaceRoot}/cases/{caseId}/cache，它没有 run.json
    mkdirSync(join(ws, 'cases', 'case-1', 'cache'), { recursive: true });

    expect(listRuns().map((run) => run.id)).toEqual(['run-1']);
  });

  it('listRunsForCase 按用例 id 精确筛选（标题相同也不会串）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1' }));
    saveRun(makeRun({ id: 'run-2', caseId: 'case-2' }));

    expect(listRunsForCase('case-1').map((run) => run.id)).toEqual(['run-1']);
  });

  // 一个坏文件不能让整个评测列表打不开：列表路径必须跳过并记 WARN，而不是抛穿。
  it('损坏的 run.json 被跳过（不影响其它快照）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1' }));
    mkdirSync(join(ws, 'run-broken'), { recursive: true });
    writeFileSync(join(ws, 'run-broken', 'run.json'), '{ 这不是 JSON', 'utf8');

    expect(listRuns().map((run) => run.id)).toEqual(['run-1']);
  });

  it('字段不全的快照同样被跳过（旧版本写下的文件不该让列表崩）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1' }));
    mkdirSync(join(ws, 'run-old'), { recursive: true });
    writeFileSync(join(ws, 'run-old', 'run.json'), JSON.stringify({ id: 'run-old' }), 'utf8');

    expect(listRuns().map((run) => run.id)).toEqual(['run-1']);
  });

  /**
   * **可见性**：`readSnapshot` 的 per-file WARN 回答的是
   * 「哪个文件坏了」，答不了「列表为什么短」——旧口径的 `run.json` 被跳过后，症状就是
   * 「评测记录凭空少了几轮」，而它与「产物真的没了 / 根目录改错了」在日志里长得一模一样。
   * `listRuns` 因此在同一趟扫描的最后记**一条**汇总 WARN，数的是「读得出 JSON、但过不了契约」的旧快照。
   *
   * 三条断言各钉一件事：① 全都读得出时**一条都没有**（否则这条 WARN 迟早变成被忽略的背景噪声）；
   * ② 两条旧快照 ⇒ **恰好一条**（不是每个文件一条——那是 per-file WARN 的活）；
   * ③ 计数是 2 而不是 3：**损坏文件（JSON 都读不出）不算进这个数**——它有自己那条带路径的 WARN，
   * 处置是修文件，而汇总句说的是「因评分口径升级不再兼容」，混进来这句话就说假了。
   */
  it('旧口径快照被跳过时记一条汇总 WARN（计数只含「读得出但不再兼容」的文件）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const aggregateCalls = (): unknown[][] =>
      warn.mock.calls.filter((call) => String(call[0]).includes('不再兼容'));
    try {
      saveRun(makeRun({ id: 'run-ok', caseId: 'case-1' }));
      // ① 反向对照：全都能读时不许有汇总（这一趟的读数就是「干净」的基准）
      expect(listRuns().map((run) => run.id)).toEqual(['run-ok']);
      expect(aggregateCalls()).toHaveLength(0);

      // 两条旧口径快照：JSON 读得出来、`EvalRunSchema` 拒（重构前的 run.json 没有 `rubric` 这一格）
      for (const id of ['run-old-1', 'run-old-2']) {
        mkdirSync(join(ws, id), { recursive: true });
        writeFileSync(join(ws, id, 'run.json'), JSON.stringify({ id, caseId: 'case-1', dimensions: [] }), 'utf8');
      }
      // 一条真损坏的快照（JSON 都解析不了）：它只该出现在 per-file 那条 WARN 里
      mkdirSync(join(ws, 'run-broken'), { recursive: true });
      writeFileSync(join(ws, 'run-broken', 'run.json'), '{ 这不是 JSON', 'utf8');

      expect(listRuns().map((run) => run.id)).toEqual(['run-ok']);

      // ② 恰好一条（每个文件一条的话这里会是 2 或 3）
      const aggregate = aggregateCalls();
      expect(aggregate).toHaveLength(1);
      // ③ 计数 = 2（损坏文件不在里面），且带上根目录：排障的人要能直接去那个目录看
      expect(aggregate[0]?.[1]).toMatchObject({ root: ws, incompatible: 2 });
    } finally {
      warn.mockRestore();
    }
  });

  it('根目录不存在时 listRuns 返回空数组（从没跑过评测是正常状态，不是错误）', () => {
    removeTreeWithRetry(ws);

    expect(listRuns()).toEqual([]);
  });

  it('getRun 对不存在的 runId 抛 NOT_FOUND（而不是返回 undefined）', () => {
    let caught: unknown;
    try {
      getRun('missing-run');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });

  it('getRun 对损坏的快照抛 INTERNAL，且 message 里带文件路径（便于直接去磁盘核对）', () => {
    mkdirSync(join(ws, 'run-bad'), { recursive: true });
    const file = join(ws, 'run-bad', 'run.json');
    writeFileSync(file, '{ 坏', 'utf8');

    let caught: unknown;
    try {
      getRun('run-bad');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('run-bad');
  });

  it('带 UTF-8 BOM 的快照能正常读（外部工具写过的文件）', () => {
    saveRun(makeRun({ id: 'run-bom', caseId: 'case-1' }));
    const file = join(ws, 'run-bom', 'run.json');
    // 在文件开头插一个 U+FEFF：模拟 PowerShell 5.1 的 Set-Content / ConvertTo-Json 写出的文件
    writeFileSync(file, `\uFEFF${readFileSync(file, 'utf8')}`, 'utf8');

    expect(getRun('run-bom').id).toBe('run-bom');
  });

  // rename 瞬时失败不许先删目标。
  // 快照是这一轮评测的唯一落盘真相，而「删除 → 重命名」之间的 getRun / SSE 读到的是 NOT_FOUND——
  // 那一刻正是「这一轮写不进磁盘」的故障现场，排障的人会先怀疑数据丢了。
  it('rename 瞬时失败时先重试（目标可写就绝不先删快照）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'idle' }));
    // 只让**第一次** rename 失败：模拟杀软 / 索引器瞬时占用
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted, rename');
    });
    vi.mocked(rmSync).mockClear();

    saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'done' }));

    expect(getRun('run-1').status).toBe('done');
    // 目标可写：回退路径（先删再重命名）一次都不该走
    expect(vi.mocked(rmSync)).not.toHaveBeenCalled();
  });

  it('目标确实只读时才走「先删再重命名」的回退（只读是唯一需要删除的成因）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'idle' }));
    const file = join(ws, 'run-1', 'run.json');
    chmodSync(file, 0o444);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted, rename');
    });
    vi.mocked(rmSync).mockClear();

    saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'done' }));

    expect(getRun('run-1').status).toBe('done');
    // 只读目标必须先删再重命名；这条断言钉的是**分支判定**（不看宿主的 rename 语义）
    expect(vi.mocked(rmSync)).toHaveBeenCalledWith(file, { force: true });
  });

  it('重试仍失败时抛中文 INTERNAL，且原有快照完好（不静默丢数据）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'idle' }));
    vi.mocked(renameSync).mockImplementation(() => {
      throw new Error('EPERM: operation not permitted, rename');
    });

    let caught: unknown;
    try {
      saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'done' }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('运行快照写入失败');
    expect((caught as ServiceError).message).toContain(join(ws, 'run-1', 'run.json'));
    // 旧快照一个字节都没被动过：可写目标上不许先删；新内容留在 .tmp 里供排查
    expect(getRun('run-1').status).toBe('idle');
  });

  /**
   * 老快照读盘：磁盘上已有的 run.json 里，score 那一格**没有** `structuredOutput`。
   *
   * 为什么必须**真的写盘再读回**，而不是顺手做一次 `ScoreResultSchema.parse`：
   * 契约层的 `.default(false)` 已经钉过，那是「schema 会兜」，不是「读入口会兜」。
   * 这条钉的是读路径本身（`getRun` → `readSnapshot` → `safeParse`）：读侧将来若被换成原样
   * `JSON.parse`，老记录的这一格就变成 `undefined`——界面与「这一分是不是在 schema 约束下拿到的」
   * 判断都会读到一个不存在的值，而今天没有任何用例会红。
   * 走**直接写盘**（绕过 `saveRun`）才是真的老文件：`saveRun` 的写侧自检会把默认值补齐，
   * 用它永远造不出「缺这一格」的快照（与上面几条直接写盘的用例同一手法）。
   */
  it('磁盘上已有的评分（score 里没有 structuredOutput）读盘后是 false', () => {
    const row = makeRowFixture({ id: 'row-legacy', status: 'judged', score: makeScoreFixture(true) });
    const run = makeRun({ id: 'run-legacy-score', caseId: 'case-1', rows: [row] });
    const runDir = join(run.workspaceBase, run.id);
    mkdirSync(runDir, { recursive: true });
    const legacy = structuredClone(run);
    // 老快照的形状：那一行已经有分，但 score 里**没有** structuredOutput 这一格
    for (const legacyRow of legacy.rows) {
      if (legacyRow.score !== null) delete (legacyRow.score as { structuredOutput?: boolean }).structuredOutput;
    }
    const file = join(runDir, 'run.json');
    writeFileSync(file, JSON.stringify(legacy), 'utf8');
    // 前置条件自证：写下去的字节里真的没有这一格。少了这条，删除写法一旦失效（比如字段名写错），
    // 用例会绿在夹具自带的 `false` 上——看着在测老快照，其实什么都没测。
    expect(readFileSync(file, 'utf8')).not.toContain('structuredOutput');

    const loaded = getRun(run.id);

    expect(loaded.rows[0]?.score?.structuredOutput).toBe(false);
  });
});

/**
 * `getRun` / `saveRun` 把 runId **直接拼进路径**（`{workspaceRoot}/{runId}/run.json`），
 * 带 `..` / 分隔符 / 绝对路径的 id 会逃出 workspaceRoot——`saveRun` 还会在根目录之外建目录并写文件。
 * 今天不可达（调用方都是 `randomUUID()`），但 api 层的 `GET /api/runs/{runId}` 会把**用户可控的 URL 段**
 * 喂给 `getRun`，而该签名本身不做任何形状约束，所以形状校验必须落在唯一的路径拼接点。
 */
describe('run-store 的 runId 形状校验', () => {
  it('getRun / saveRun 拒绝带路径含义的 runId（分隔符 / .. / 以 . 开头 / 空串）', () => {
    // getRun（api 层的 URL 段入口）：连 `../../etc` 这种会落到 workspaceRoot 之外两级、且属于**共享临时根**的
    // id 也必须拒——判定发生在拼路径之前，所以它与磁盘上恰好有什么无关
    for (const bad of ['../../etc', '../escaped', 'a/b', 'a\\b', '..', '.hidden', 'C:\\Windows\\Temp', '']) {
      const fromGet = thrownBy(() => getRun(bad));
      expect(fromGet).toBeInstanceOf(ServiceError);
      expect((fromGet as ServiceError).code).toBe('INVALID_QUERY');
    }
    // saveRun（写盘入口）：每个形状逐一拒。**探针统一用 per-run 的 `../escaped`**——它的落点 {dir}/escaped
    // 是本次 mkdtemp 独享的目录；换成 `../../etc` 的话，变异体一旦存活就会把 run.json 写进**共享的**系统临时根
    // （那正是这条守卫要防的事：变异体一旦存活，写的就是共享的系统临时根）。
    for (const bad of ['../escaped', 'a/b', 'a\\b', '..', '.hidden', 'C:\\Windows\\Temp', '']) {
      const fromSave = thrownBy(() => saveRun(makeRun({ id: bad, caseId: 'case-1' })));
      expect(fromSave).toBeInstanceOf(ServiceError);
      expect((fromSave as ServiceError).code).toBe('INVALID_QUERY');
      expect((fromSave as ServiceError).message).toContain('评测 id 不合法');
    }
    // 一个文件都不许产生：`../escaped` 的落点 {dir}/escaped 在 workspaceRoot 之外，
    // 空串的落点是 {workspaceRoot}/run.json（listRuns 永远看不到它）
    expect(existsSync(join(dir, 'escaped'))).toBe(false);
    expect(existsSync(join(ws, 'run.json'))).toBe(false);
    expect(listRuns()).toEqual([]);
  });

  // 反向对照：合法 UUID 照常读写——守卫不能宽到挡住正路（它是 api 层唯一会走的形状）
  it('合法 UUID 形态的 runId 照常读写', () => {
    const id = randomUUID();

    saveRun(makeRun({ id, caseId: 'case-1' }));

    expect(getRun(id).id).toBe(id);
  });

  // 错误信息要能回答「哪个 id 被拒了」：code 是 INVALID_QUERY（不是「不存在」），message 与 context 都带原值。
  // 注意 code 这一条是承重的：只断言 message/context 的话，旧实现的 NOT_FOUND（「评测不存在：../../etc」）
  // 也能让本用例通过——那就成了一条恒绿的假守卫。
  it('拒绝时用 INVALID_QUERY 说明「形状不对」，message 与 context 都带上原值', () => {
    const caught = thrownBy(() => getRun('../escaped')) as ServiceError;

    expect(caught.code).toBe('INVALID_QUERY');
    expect(caught.message).toContain('评测 id 不合法');
    expect(caught.message).toContain('../escaped');
    expect(caught.context).toMatchObject({ runId: '../escaped' });
  });
});

/**
 * 写侧自检（与 core 的 `appendEvent` 写入点校验同一条原则）。
 *
 * 为什么这条守卫必须有：读路径的 `readSnapshot` 用的是 `safeParse`，不合契约的快照只记一句 WARN
 * 就返回 null，于是脏数据会**先写进磁盘**、再被 `listRuns` 静默跳过 —— 这一轮评测从列表里凭空消失，
 * 而写入端与读取端都不报错（只有直接 `getRun` 才会抛 INTERNAL）。写侧拒绝必须发生在**落盘之前**，
 * 且落盘的是校验后的对象：`JSON.stringify(NaN)` 会把 NaN 改写成 `null`，那样坏数据依旧混进磁盘，
 * 只是换了一副「看起来合法」的样子。
 */
describe('saveRun 的写侧自检', () => {
  it('形状漂移（NaN 计量）在写入点抛中文 ServiceError，且盘上不留快照（不许写完再让 listRuns 静默跳过）', () => {
    const row = makeRowFixture({ tokens: { input: Number.NaN, cached: 0, output: 0 } });
    const run = makeRunFixture({ id: 'run-nan', caseId: 'case-1', workspaceRoot: ws, rows: [row] });

    // 错误面必须与 I/O 失败一致：**中文 ServiceError**（code + 可直接展示的原因），不是裸英文 ZodError
    //（B2 裁决 2：口径同 core 的 appendEvent 写侧校验，否则路由层会把 zod 的英文文案返回给用户）。
    // 只断言「抛了」是不够的——旧实现抛的 ZodError 同样满足 `toThrow()`，那条守卫就只钉了「抛没抛」、
    // 钉不住「抛的是什么」。
    const caught = thrownBy(() => saveRun(run)) as ServiceError;
    expect(caught).toBeInstanceOf(ServiceError);
    expect(caught.code).toBe('INTERNAL');
    expect(caught.message).toContain('运行快照不符合契约');
    // 报错必须指向出问题的字段（不是「写入失败」这种无法定位的兜底文案）
    expect(caught.message).toContain('rows.0.tokens.input');
    expect(caught.context).toMatchObject({ runId: 'run-nan' });

    // 盘上连这一轮的目录都不该留下：校验先于 mkdir，否则残留的空目录会让人以为「跑过这一轮」
    expect(existsSync(join(ws, 'run-nan'))).toBe(false);
    expect(existsSync(join(ws, 'run-nan', 'run.json'))).toBe(false);
    expect(listRuns().map((candidate) => candidate.id)).not.toContain('run-nan');
  });

  // 反向对照：合法快照照常落盘，且比原对象更干净（zod 会剥掉 schema 之外的键）。
  // 这条钉的是「写侧自检不能宽到挡住正路」——它是每条 saveRun 调用都要过的路径。
  it('合法快照照常落盘，落盘的是校验后的对象', () => {
    const run = makeRunFixture({ id: 'run-ok', caseId: 'case-1', workspaceRoot: ws });

    saveRun(run);

    expect(getRun('run-ok')).toEqual(run);
  });
});

/**
 * `workspaceBase` 的**形状**校验。
 *
 * 写侧落盘位置完全取自这一项（`runDir(root, id)`），而契约里它只是 `z.string()`——没有 `.min(1)`、
 * 没有绝对路径约束。形状不对的值会让产物写到**读侧永远看不到的地方**：`''` ⇒ 进程 CWD 下的 `<runId>/`，
 * `'~/.aieval-runs'`（设置里的合法可读写法）⇒ 字面 `~` 目录（读侧 `resolveRootForRead` 会展开成家目录）。
 * 「今天创建点都写绝对路径」不是安全论证——写侧已经在依赖它了。
 *
 * 注意这条守卫的**落点断言要盯住进程 CWD**：变异体（去掉校验）真的会把快照写进 CWD，
 * 所以断言必须能看见它（而不是只看「抛没抛」）。
 */
describe('saveRun 的 workspaceBase 形状校验', () => {
  it('空串 / `~` 写法 / 相对路径一律拒绝：产物不许写到进程 CWD 或字面 `~` 目录', () => {
    for (const bad of ['', '~/.aieval-runs', 'runs', './runs']) {
      const caught = thrownBy(() => saveRun(makeRun({ id: 'run-base-bad', caseId: 'case-1', workspaceBase: bad }))) as ServiceError;
      expect(caught, `应当拒绝：${JSON.stringify(bad)}`).toBeInstanceOf(ServiceError);
      expect(caught.code).toBe('INVALID_QUERY');
      expect(caught.message).toContain('工作区根目录不合法');
      expect(caught.context).toMatchObject({ runId: 'run-base-bad', workspaceBase: bad });
    }
    // 空串的落点是 `join('', 'run-base-bad')` = 进程 CWD 下的同名目录；`~/.aieval-runs` 的落点是 CWD 下的字面 `~`
    expect(existsSync(join(process.cwd(), 'run-base-bad'))).toBe(false);
    expect(existsSync(join(process.cwd(), '~'))).toBe(false);
    // 坏根不许进进程内记忆（校验必须排在 rememberRunRoot 之前），否则事件侧会照着它写
    expect(recalledRunRoot('run-base-bad')).toBeUndefined();
    expect(listRuns().map((run) => run.id)).not.toContain('run-base-bad');
  });

  // 反向对照：合法根照常落盘。盘符形式（`C:/…`）在 POSIX 上 `isAbsolute()` 认不出来，
  // 判据必须与 core 的 `expandHome` 同口径单独识别——否则 Linux 上会把合法的 Windows 根拒掉。
  it('绝对路径照常落盘（含 Windows 盘符形式，与 core 的 expandHome 同口径）', () => {
    saveRun(makeRun({ id: 'run-base-ok', caseId: 'case-1', workspaceBase: ws }));
    expect(getRun('run-base-ok').id).toBe('run-base-ok');

    // 把临时根改写成正斜杠的盘符形态：Windows 上走的是盘符分支，且落点仍是本用例自己的临时目录
    const driveForm = ws.replace(/\\/g, '/');
    saveRun(makeRun({ id: 'run-base-drive', caseId: 'case-1', workspaceBase: driveForm }));
    expect(getRun('run-base-drive').workspaceBase).toBe(driveForm);
  });
});

/**
 * 写侧与 `events.ts` 的根目录口径必须同源（B2 裁决 1）。
 *
 * `events.ts` 按 `rowEventsFile(getRunForWrite(runId).workspaceBase, …)` 定位事件日志——**该轮自己记录的根**；
 * 而写侧若改取「当前 `settings.workspaceRoot`」：一轮评测进行中用户改了根目录，快照写进新根、
 * 事件留在旧根，这一轮的产物就**裂成两半**（界面上的行状态与日志抽屉对不上，而两边都不报错）。
 * 裁决口径是「该轮整体留在旧根，把根目录改回去即可恢复可见」，所以写侧也必须取自 `run.workspaceBase`。
 */
describe('saveRun 的根目录口径（与该轮自己的 workspaceBase 同源）', () => {
  it('一轮进行中改了工作区根目录：快照与事件都留在旧根，新根下不出现这一轮', () => {
    const runId = 'run-root-switch';
    const rowId = 'row-root-switch';
    saveRun(makeRun({ id: runId, caseId: 'case-1' }));
    // 先发一条事件：生产里编排层的第一步就是发 `preparing` 状态事件，事件路径在这一刻与「这一轮的根」
    // 绑定（events.ts 的进程内缓存，与本条守卫无关）；这里照生产顺序走，保证断言的是根目录口径本身。
    publishRowEvent(runId, rowId, { type: 'status', status: 'preparing' });

    // 模拟用户跑到一半去设置页把工作区根目录改到 B（只改设置，不搬任何产物）
    const otherRoot = join(dir, 'runs-b');
    saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: otherRoot } });

    saveRun(makeRun({ id: runId, caseId: 'case-1', status: 'running' }));
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '改根目录之后的一行日志' });

    // 快照仍在 A，且是刚写下的那一份（写进 B 的话这里读到的还是最初的 idle 快照）
    const snapshot = JSON.parse(readFileSync(join(ws, runId, 'run.json'), 'utf8')) as EvalRun;
    expect(snapshot.status).toBe('running');
    // 事件也在 A，并且能按契约读回来
    const events = readEvents(rowEventsFile(ws, runId, rowId));
    expect(events.map((event) => event.type)).toEqual(['status', 'log']);
    expect(JSON.stringify(events)).toContain('改根目录之后的一行日志');

    // 新根下不出现这一轮的任何产物：产物必须整体留在旧根
    expect(existsSync(join(otherRoot, runId))).toBe(false);
    expect(listRuns().map((candidate) => candidate.id)).not.toContain(runId);
  });

  /**
   * 另一半：「同进程内另靠『记住 runId → workspaceBase』兜住」。
   *
   * 上面那条守卫先发了一条事件，事件路径因此在 `events.ts` 里被缓存，于是它**没有覆盖**真正的
   * 生产故障面：同一轮的**后续行**（事件路径尚未缓存）在用户改完根目录后第一次发事件时，
   * `getRun` 会抛 NOT_FOUND，`publishRowEvent` 把这个异常冒出去 ⇒ 一次设置变更把在途轮次**中途打死**。
   * 生产上编排层第一步就发 `preparing`，所以典型的在途轮次首行不受影响，后续行照样会撞上。
   *
   * 这条守卫因此必须用**另一个此前从未发布过事件的 rowId**：那正是「事件路径尚未缓存」这个前提。
   * 期望行为是「仍写在 A 下」——不抛 NOT_FOUND（在途轮次不崩），也不写进 B（产物不裂成两半）。
   */
  it('改根目录后，对**尚未发布过事件**的行发事件仍写在旧根（进程内记忆兜底，不抛 NOT_FOUND）', () => {
    const runId = 'run-root-memory';
    const firstRowId = 'row-already-published';
    const laterRowId = 'row-never-published';
    saveRun(makeRun({ id: runId, caseId: 'case-1' }));
    // 同一轮的首行照生产顺序先发一条：它把「这一轮的事件路径」缓存起来，
    // 从而保证本用例钉的是**记忆兜底**本身，而不是事件路径缓存顺手掩盖了问题
    publishRowEvent(runId, firstRowId, { type: 'status', status: 'preparing' });

    // 用户改根目录到 B（只改设置，不搬任何产物）
    const otherRoot = join(dir, 'runs-b');
    saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: otherRoot } });

    // 后续行第一次发事件：事件路径尚未缓存 ⇒ 只能靠进程内记忆解析出「这一轮自己的根」
    publishRowEvent(runId, laterRowId, { type: 'log', stream: 'stdout', text: '改根目录之后的后续行' });

    const events = readEvents(rowEventsFile(ws, runId, laterRowId));
    expect(events).toHaveLength(1);
    expect(events[0]?.type === 'log' && events[0].text).toBe('改根目录之后的后续行');
    // 新根下不许出现这一行的任何产物（写进 B 就等于「一轮的产物裂成两半」，比找不到更难查）
    expect(existsSync(join(otherRoot, runId))).toBe(false);
    // 首行的事件日志也不受影响地留在 A
    expect(readEvents(rowEventsFile(ws, runId, firstRowId))).toHaveLength(1);
  });

  // 反向对照：记忆里没有这个 runId 时，NOT_FOUND 照旧（「跨重启 + 改过根」找不到是明确接受的）。
  // 少了这条，把兜底写成「任何 NOT_FOUND 都拿记忆里随便一个根顶上」也会绿。
  it('记忆里没有的 runId 仍然抛 NOT_FOUND（兜底不掩盖「这一轮真的不存在」）', () => {
    saveConfig({
      ...loadConfig(),
      settings: { ...SETTINGS_DEFAULTS, workspaceRoot: join(dir, 'runs-b') },
    });

    let caught: unknown;
    try {
      publishRowEvent('run-never-saved', 'row-1', { type: 'log', stream: 'stdout', text: '不该落盘' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    expect(existsSync(join(ws, 'run-never-saved'))).toBe(false);
  });

  /**
   * **快照侧**：编排层要在同一份记忆上读快照，否则「改了根目录 = 在途轮次被打死」
   * 只是换了一扇门——`requireRow → getRun` 抛 NOT_FOUND，`settleFailed` 也要先 `requireRow`
   * ⇒ 行停在非终态。`getRunForWrite` 就是那个入口：当前根优先、NOT_FOUND 时用记忆兜底。
   * 同时钉住**对外读侧口径不变**：`getRun` 仍只扫当前根（对外读侧口径，api 层的路由用的就是它）。
   */
  it('getRunForWrite 按该轮自己的根读快照，getRun 的对外口径不变（仍只扫当前根）', () => {
    const runId = 'run-write-root';
    saveRun(makeRun({ id: runId, caseId: 'case-1', status: 'running' }));
    const otherRoot = join(dir, 'runs-b');
    saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: otherRoot } });

    // 对外入口：改根之后这一轮就不在「当前根」里了 —— 这正是接受的可见性局限，语义不变
    const fromGetRun = thrownBy(() => getRun(runId)) as ServiceError;
    expect(fromGetRun).toBeInstanceOf(ServiceError);
    expect(fromGetRun.code).toBe('NOT_FOUND');

    // 在途轮次的入口：读得到，且就是旧根 A 里那一份（不是新根 B 的空世界）
    expect(getRunForWrite(runId).status).toBe('running');
    expect(getRunForWrite(runId).workspaceBase).toBe(ws);
    // 新根下不许冒出这一轮的任何产物（读侧兜底不许变成「顺手在新根里建一份」）
    expect(existsSync(join(otherRoot, runId))).toBe(false);

    // 反向对照一：记忆里没有的 runId 照样 NOT_FOUND（兜底不掩盖「这一轮真的不存在」）
    expect((thrownBy(() => getRunForWrite('run-never-saved')) as ServiceError).code).toBe('NOT_FOUND');
    // 反向对照二：形状非法时抛 INVALID_QUERY，**不许**拿旧根去重试——那会把「形状不对」伪装成「根不对」
    expect((thrownBy(() => getRunForWrite('../escaped')) as ServiceError).code).toBe('INVALID_QUERY');
  });

  // 反向对照三：当前根下的快照**损坏**（INTERNAL）同样不许兜底——旧根里也许有一份好的，
  // 但「读不出」与「不在这个根」是两种失败，混起来会把排障引向完全错误的方向。
  it('当前根下快照损坏时 getRunForWrite 抛 INTERNAL，不拿旧根顶上', () => {
    const runId = 'run-write-root-broken';
    saveRun(makeRun({ id: runId, caseId: 'case-1' }));
    const otherRoot = join(dir, 'runs-b');
    mkdirSync(join(otherRoot, runId), { recursive: true });
    writeFileSync(join(otherRoot, runId, 'run.json'), '{ 坏', 'utf8');
    saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: otherRoot } });

    const caught = thrownBy(() => getRunForWrite(runId)) as ServiceError;
    expect(caught).toBeInstanceOf(ServiceError);
    expect(caught.code).toBe('INTERNAL');
  });
});
