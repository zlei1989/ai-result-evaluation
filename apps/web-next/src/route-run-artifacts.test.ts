// @vitest-environment node
/**
 * 产物路由：代码改动（现场跑 git 现算）、执行日志（?afterSeq=）、SSE 帧与响应头。
 *
 * 本文件**故意让 `@aieval/core` 保持真实、并真的建一个 git 仓库**：diff 路由的价值就在于
 * 「真的能算出改动」，把它 mock 掉等于把最容易错的地方（工作目录、基线、三样合并）从测试里删掉。
 * 仓库建在 mkdtemp 出来的临时目录里，**不碰真实仓库、不碰真实 ~/.aieval**。
 * `@aieval/evaluator` 仍然被整块 mock（不起真实 agent 进程），快照由 POST 路由真实创建。
 *
 * 三处修正（理由与 route-runs.test.ts 的文件头逐条相同）：
 *   · mock 句柄走 `vi.hoisted`，测试里不再 `import '@aieval/evaluator'`（本应用没声明它，tsc 会红）；
 *   · mock 工厂多两个键（`resolveJudgeRoute` / `recoverInterruptedRuns`）：`@aieval/api` 的 index.ts
 *     会**转出**这两个名字，ESM 的转出绑定在模块求值期读取，缺键在 import 阶段就抛；
 *   · `listRuns` 装上实现（`[...store.values()]`），免得 `listRunsView()` 里 `[...undefined]` 抛 TypeError。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type AgentEvent, type EvalRun } from '@aieval/contracts';
import { appendEvent, loadConfig, rowEventsFile, saveConfig, setCasesRootForTesting, setConfigDirForTesting, writeCase, type AppConfig } from '@aieval/core';
import { POST as postRun } from '@/app/api/runs/route';
import { GET as getDiff } from '@/app/api/runs/[runId]/rows/[rowId]/diff/route';
import { GET as getLog } from '@/app/api/runs/[runId]/rows/[rowId]/log/route';
// 段配置（Next 的 route segment config）也要有守卫：它没有任何运行时症状，
// 掉了之后表现是「本机单进程下一切正常、换个 runtime 就连不上编排层」
import {
  GET as getStream,
  dynamic as streamDynamic,
  runtime as streamRuntime,
} from '@/app/api/runs/[runId]/rows/[rowId]/stream/route';
import { removeTreeWithRetry } from './testing/cleanup';

/** mock 句柄（`vi.hoisted` 的理由见 route-runs.test.ts） */
const evaluator = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRowEvents: vi.fn(() => () => {}),
  // 评分那两条流：`@aieval/api` 的 index 转出了它们，而 `messages-stream.ts` /
  // `run-stream.ts` 在**模块求值期**就把 `subscribeJudge*` 收进 channel 常量 ⇒ 缺键在 import 阶段就抛
  subscribeJudgeEvents: vi.fn(() => () => {}),
  subscribeJudgeRecords: vi.fn(() => () => {}),
  // 候选那条记录流：`messages-stream.ts` 在模块求值期收进 channel 常量，同上
  subscribeRowRecords: vi.fn(() => () => {}),
  // run 级信号总线（`/api/runs/events`）：api 的 index 转出 `streamRunSignals`，run-events.ts
  // 在模块求值期读这个键，缺键在 import 阶段就抛（见 route-runs.test.ts 的同款注释）
  subscribeRunChanges: vi.fn(() => () => {}),
  resolveJudgeRoute: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
}));

vi.mock('@aieval/evaluator', () => evaluator);

let dir: string;
let workspaceRoot: string;
let store: Map<string, EvalRun>;

/** 在临时目录里建一个真仓库：一次提交 + 未提交的改动 + 一个未跟踪文件（三样都覆盖） */
function initRepo(repoDir: string): { baseline: string } {
  mkdirSync(repoDir, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  git('init');
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n', 'utf8');
  git('add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=tester', 'commit', '-m', 'init');
  const baseline = git('rev-parse', 'HEAD').trim();
  // 已改未提交
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  // 未跟踪的新文件
  writeFileSync(join(repoDir, 'c.ts'), 'export const c = 3;\n', 'utf8');
  return { baseline };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  // 本仓 vitest 没开 clearMocks：调用历史是累积的，逐条用例断言 before/after 前必须先清
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-artifacts-'));
  setConfigDirForTesting(dir);
  // 用例目录也指到临时目录：用例是一文件一落（core 的 case-store），config 目录的 override 管不到它
  setCasesRootForTesting(join(dir, 'cases'));
  workspaceRoot = join(dir, 'ws');
  const config = loadConfig();
  const seeded: AppConfig = {
    ...config,
    settings: { ...config.settings, workspaceRoot, casesRoot: join(dir, 'cases'), casesAutoCommit: false },
    providers: [
      {
        id: 'p-anthropic',
        name: 'Anthropic 网关',
        protocolType: 'anthropic',
        baseUrl: 'https://gw.example.com/anthropic',
        apiKey: 'sk-anthropic',
        models: [{ id: 'claude-opus-4-6', source: 'manual' }],
        createdAt: '2026-09-22T00:00:00.000Z',
        updatedAt: '2026-09-22T00:00:00.000Z',
      },
    ],
  };
  saveConfig(seeded);
  // 用例按真实来路写：它是文件，不再随配置一起覆盖写
  writeCase({
    id: 'c-1',
    title: '多协议入站转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
    taskPrompt: '补齐转换',
    // 读侧对**旧版数据**（只有 judgePrompt、没有 rubric）显式抛 INTERNAL：夹具必须带这一格
    rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }] }] },
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  });

  store = new Map();
  evaluator.saveRun.mockImplementation((run: EvalRun) => {
    store.set(run.id, run);
  });
  evaluator.getRun.mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
  evaluator.listRuns.mockImplementation(() => [...store.values()]);
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

/** 走真实路由建一轮评测，返回快照 */
async function createRun(): Promise<EvalRun> {
  const res = await postRun(
    jsonRequest({
      caseId: 'c-1',
      executionMode: 'serial',
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as EvalRun;
}

/**
 * 动态段上下文：Next 16 的 `params` 是 Promise。
 * 必须**泛型**（写成 `Record<string, string>` 就错了）：路由的上下文参数是
 * `{ runId: string; rowId: string }`，`Record<string, string>` 只提供索引签名、不提供具名属性，
 * `strictFunctionTypes` 下参数是逆变位置，传进去直接 TS2345（实测）。
 */
function rowContext<P extends Record<string, string>>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}

describe('GET .../rows/[rowId]/diff', () => {
  /** 建一轮 + 真仓库，返回 run 与 row（三样改动都覆盖：已提交 / 未提交 / 未跟踪） */
  async function seedRepo(): Promise<{ runId: string; rowId: string }> {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const { baseline } = initRepo(row.workspacePath);
    store.set(run.id, { ...run, rows: [{ ...row, baselineCommit: baseline }] });
    return { runId: run.id, rowId: row.id };
  }

  it('索引：不带正文，只给文件清单与三个计数', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId, rowId }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.insertions).toBeGreaterThanOrEqual(1);
    // 索引响应里**没有**正文——带了就等于把「一次下发全部」请回来
    expect(body).not.toHaveProperty('text');
    expect(body.files.map((f: { path: string }) => f.path)).toContain('a.ts');
  });

  it('索引：未跟踪的新文件带 untracked 标记', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId, rowId }));
    const body = await res.json();

    const untracked = body.files.find((f: { path: string }) => f.path === 'c.ts');
    expect(untracked?.untracked).toBe(true);
  });

  it('索引：?limit= 分页，且 limit 封顶后不报错', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff?offset=0&limit=1'), rowContext({ runId, rowId }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.files.length).toBeLessThanOrEqual(1);
    expect(body.offset).toBe(0);

    const huge = await getDiff(new Request('http://localhost/api/diff?limit=99999'), rowContext({ runId, rowId }));
    expect(huge.status).toBe(200);
  });

  it('索引：非法 offset/limit 宽容降级（不是 400）', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff?offset=abc&limit=-3'), rowContext({ runId, rowId }));

    expect(res.status).toBe(200);
    expect((await res.json()).offset).toBe(0);
  });

  it('单文件正文：?file= 取到那一段，含未提交的改动与未跟踪新文件的正文', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff?file=a.ts'), rowContext({ runId, rowId }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.path).toBe('a.ts');
    // 未提交的改动必须在正文里（只取 commit..HEAD 会漏掉它）
    expect(body.patch).toContain('const b = 2;');
    expect(body.binary).toBe(false);

    const untrackedFile = await getDiff(new Request('http://localhost/api/diff?file=c.ts'), rowContext({ runId, rowId }));
    expect((await untrackedFile.json()).patch).toContain('const c = 3;');
  });

  it('单文件正文：路径含空格时按 URL 编码解码后仍能取到', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const { baseline } = initRepo(row.workspacePath);
    writeFileSync(join(row.workspacePath, 'my file.ts'), 'export const s = 1;\n', 'utf8');
    store.set(run.id, { ...run, rows: [{ ...row, baselineCommit: baseline }] });

    const res = await getDiff(
      new Request(`http://localhost/api/diff?file=${encodeURIComponent('my file.ts')}`),
      rowContext({ runId: run.id, rowId: row.id }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).patch).toContain('export const s = 1;');
  });

  it('单文件正文：路径不在改动里 → 404', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff?file=nope.ts'), rowContext({ runId, rowId }));

    expect(res.status).toBe(404);
  });

  it('工作区还没建起来 → 409 中文原因，而不是英文 git 报错', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');

    const res = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId: run.id, rowId: row.id }));

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('还没有工作区');
  });

  it('轮不存在 → 404', async () => {
    const res = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId: 'nope', rowId: 'w-1' }));

    expect(res.status).toBe(404);
  });

  it('回归守卫：?file= 与 ?offset= 走的是两条不同的分支', async () => {
    const { runId, rowId } = await seedRepo();

    const indexRes = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId, rowId }));
    const fileRes = await getDiff(new Request('http://localhost/api/diff?file=a.ts'), rowContext({ runId, rowId }));

    // 索引有 files/total，单文件有 patch —— 两个形状不能互相冒充
    expect(Object.keys(await indexRes.json())).toContain('total');
    expect(Object.keys(await fileRes.json())).toContain('patch');
  });
});

describe('GET .../rows/[rowId]/log', () => {
  it('返回全量；?afterSeq= 只返回增量', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const file = rowEventsFile(workspaceRoot, run.id, row.id);
    mkdirSync(dirname(file), { recursive: true });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '一' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '二' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '三' });

    const all = await getLog(new Request('http://localhost/api/log'), rowContext({ runId: run.id, rowId: row.id }));
    expect(((await all.json()) as AgentEvent[]).map((event) => event.seq)).toEqual([1, 2, 3]);

    const inc = await getLog(new Request('http://localhost/api/log?afterSeq=2'), rowContext({ runId: run.id, rowId: row.id }));
    expect(((await inc.json()) as AgentEvent[]).map((event) => event.seq)).toEqual([3]);
  });

  it('?afterSeq=abc → 400（不静默当成 0 给全量）', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');

    const res = await getLog(new Request('http://localhost/api/log?afterSeq=abc'), rowContext({ runId: run.id, rowId: row.id }));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_QUERY');
  });
});

describe('GET .../rows/[rowId]/stream', () => {
  it('段配置：nodejs runtime + force-dynamic（进程内事件总线）', () => {
    // 事件总线是**进程内**的：换到 edge 之类的 runtime，SSE 路由就连不上编排层，
    // 而症状是「连上了、永远没有新事件」——零报错。段配置本身没有任何运行时守卫，故在这里钉住。
    expect(streamRuntime).toBe('nodejs');
    expect(streamDynamic).toBe('force-dynamic');
  });

  it('响应头是 SSE 的四个必需项，帧格式为 id/event/data + 空行', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const file = rowEventsFile(workspaceRoot, run.id, row.id);
    mkdirSync(dirname(file), { recursive: true });
    const first = appendEvent(file, { type: 'log', stream: 'stdout', text: '第一行' });
    const end = appendEvent(file, { type: 'end', exitReason: 'completed' });

    const res = await getStream(new Request('http://localhost/api/stream'), rowContext({ runId: run.id, rowId: row.id }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    // 回放里带终态 ⇒ 流会自己结束（否则这里会挂住）。
    // 首块是 ready 注释帧（打开即有首字节，-①）：它先 flush 响应头，之后才是历史帧
    const text = await res.text();
    expect(text).toBe(
      ': ready\n\n' +
        `id: ${first.seq}\nevent: log\ndata: ${JSON.stringify(first)}\n\n` +
        `id: ${end.seq}\nevent: end\ndata: ${JSON.stringify(end)}\n\n`,
    );
  });

  it('Last-Event-ID 优先于 ?afterSeq=（重连只发头，query 里是首连那一刻的旧值）', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const file = rowEventsFile(workspaceRoot, run.id, row.id);
    mkdirSync(dirname(file), { recursive: true });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '一' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '二' });
    const end = appendEvent(file, { type: 'end', exitReason: 'completed' });

    const res = await getStream(
      new Request('http://localhost/api/stream?afterSeq=0', { headers: { 'last-event-id': '2' } }),
      rowContext({ runId: run.id, rowId: row.id }),
    );

    const text = await res.text();
    // 首块是 ready 注释帧（打开即有首字节，-①），回放从它之后开始
    expect(text.startsWith(': ready\n\n')).toBe(true);
    expect(text.slice(': ready\n\n'.length).startsWith(`id: ${end.seq}\n`)).toBe(true);
    expect(text).not.toContain('"text":"一"');
  });

  it('轮/行不存在时回 404 JSON（不是开了就结束的 SSE 流）', async () => {
    const run = await createRun();
    const res = await getStream(new Request('http://localhost/api/stream'), rowContext({ runId: run.id, rowId: 'w-x' }));

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).error.message).toContain('没有这一行');
  });
});
