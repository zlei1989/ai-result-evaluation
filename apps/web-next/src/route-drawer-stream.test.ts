// @vitest-environment node
/**
 * 抽屉流路由：`GET /api/runs/[runId]/drawer/stream?rowId=&rowChannel=[&afterSeq=N]`。
 *
 * 只在这一层出现的东西就是本文件的断言对象：
 *   1. **查询参数的 zod 校验**：`rowChannel` 白名单（非法值 / 缺参 400）、`rowId` 必填（缺参 400）
 *      ——静默空流会让调用方以为「连上了、只是没内容」；
 *   2. **错误映射**：轮/行不存在折成 404 + 中文原因（不是一条开了就断的 SSE）；
 *   3. **SSE 响应头三件套**与帧头分轨（事件帧有 `id:`、消息帧没有）；
 *   4. **段配置**：`runtime = 'nodejs'`（总线是进程内的）与 `force-dynamic`——它没有任何运行时症状，
 *      掉了之后表现是「本机单进程下一切正常、换个 runtime 就连不上编排层」。
 *
 * `@aieval/evaluator` 整块 mock（不起真实 agent 进程），评测快照由 POST 路由真实创建、
 * 产物由 core 真实落盘——「校验真的读了盘」这条必须有真文件才成立。
 * mock 句柄走 `vi.hoisted`，且键要凑齐 `@aieval/api` 的 index 在**模块求值期**读到的那些
 * （缺键在 import 阶段就抛，见 `route-run-artifacts.test.ts` 的同一段注释）。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStreamFrameSchema, ServiceError, type EvalRun } from '@aieval/contracts';
import { appendEvent, appendMessage, loadConfig, rowEventsFile, rowMessagesFile, saveConfig, setCasesRootForTesting, setConfigDirForTesting, writeCase, type AppConfig } from '@aieval/core';
import { POST as postRun } from '@/app/api/runs/route';
import {
  GET as getDrawerStream,
  dynamic as streamDynamic,
  runtime as streamRuntime,
} from '@/app/api/runs/[runId]/drawer/stream/route';
import { removeTreeWithRetry } from './testing/cleanup';

/** mock 句柄（`vi.hoisted` 的理由见 `route-run-artifacts.test.ts`） */
const evaluator = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRowEvents: vi.fn(() => () => {}),
  subscribeJudgeEvents: vi.fn(() => () => {}),
  subscribeRowRecords: vi.fn(() => () => {}),
  subscribeJudgeRecords: vi.fn(() => () => {}),
  subscribeRunChanges: vi.fn(() => () => {}),
  resolveJudgeRoute: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
}));

vi.mock('@aieval/evaluator', () => evaluator);

let dir: string;
let store: Map<string, EvalRun>;

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  // 本仓 vitest 没开 clearMocks：调用历史是累积的，逐条用例断言前必须先清
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-drawer-'));
  setConfigDirForTesting(dir);
  setCasesRootForTesting(join(dir, 'cases'));
  const config = loadConfig();
  const seeded: AppConfig = {
    ...config,
    settings: { ...config.settings, workspaceRoot: join(dir, 'ws'), casesRoot: join(dir, 'cases'), casesAutoCommit: false },
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
  writeCase({
    id: 'c-1',
    title: '多协议入站转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
    taskPrompt: '补齐转换',
    rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }] }] },
    includeSteps: false,
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

/** 走真实路由建一轮评测（真实 core 落盘），返回快照与它那一行 */
async function createRun(): Promise<{ run: EvalRun; rowId: string }> {
  const res = await postRun(
    jsonRequest({
      caseId: 'c-1',
      executionMode: 'serial',
      rows: [{ agentKind: 'cc', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    }),
  );
  expect(res.status).toBe(201);
  const run = (await res.json()) as EvalRun;
  const rowId = run.rows[0]?.id;
  if (rowId === undefined) throw new Error('创建评测没有产生候选行');
  return { run, rowId };
}

/**
 * 动态段上下文：Next 16 的 `params` 是 Promise。
 * 必须**泛型**（写成 `Record<string, string>` 会在 `strictFunctionTypes` 下 TS2345，
 * 理由见 `route-run-artifacts.test.ts` 的同一处注释）。
 */
function context<P extends Record<string, string>>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}

/** 请求 URL：查询串按用例给（`?` 由调用方带） */
function url(query: string, init?: RequestInit): Request {
  return new Request(`http://localhost/api/runs/run-1/drawer/stream${query}`, init);
}

/** 往该行的事件日志里追加一条事件（写真实文件，走 core 的 seq 分配） */
function appendRowEvent(run: EvalRun, rowId: string, event: Parameters<typeof appendEvent>[1]): void {
  const file = rowEventsFile(run.workspaceBase, run.id, rowId);
  mkdirSync(dirname(file), { recursive: true });
  appendEvent(file, event);
}

/** 往该行的记录日志里追加一条消息（同上，写真实文件） */
function appendRowMessage(run: EvalRun, rowId: string, text: string): void {
  const file = rowMessagesFile(run.workspaceBase, run.id, rowId);
  mkdirSync(dirname(file), { recursive: true });
  appendMessage(file, {
    messageId: 'run-1:1',
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    origin: 'case-prompt',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    blocks: [{ type: 'text', text }],
    raw: null,
  });
}

describe('GET /api/runs/[runId]/drawer/stream', () => {
  it('段配置：nodejs runtime + force-dynamic（进程内两条总线）', () => {
    expect(streamRuntime).toBe('nodejs');
    expect(streamDynamic).toBe('force-dynamic');
  });

  it('`rowChannel` 非法或缺参 → 400（不许静默空流、不许默认成候选）', async () => {
    const { run, rowId } = await createRun();

    const missing = await getDrawerStream(url(`?rowId=${rowId}`), context({ runId: run.id }));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('INVALID_QUERY');

    const illegal = await getDrawerStream(url(`?rowId=${rowId}&rowChannel=judge-events`), context({ runId: run.id }));
    expect(illegal.status).toBe(400);
    expect(((await illegal.json()) as { error: { code: string } }).error.code).toBe('INVALID_QUERY');
  });

  it('`rowId` 缺参或空串 → 400', async () => {
    const { run } = await createRun();

    for (const query of ['?rowChannel=candidate', '?rowId=&rowChannel=candidate']) {
      const res = await getDrawerStream(url(query), context({ runId: run.id }));
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_QUERY');
    }
  });

  it('行不属于这一轮 → 404 + 中文原因（不是一条开了就断的 SSE）', async () => {
    const { run } = await createRun();

    const res = await getDrawerStream(url('?rowId=row-never&rowChannel=candidate'), context({ runId: run.id }));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('该评测里没有这一行（row-never）');
  });

  it('轮不存在 → 404', async () => {
    const res = await getDrawerStream(url('?rowId=w-1&rowChannel=candidate'), context({ runId: 'run-never' }));

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('响应头三件套 + 帧头分轨：事件帧有 `id:`、消息帧没有（回放带终态 ⇒ 流自己结束）', async () => {
    const { run, rowId } = await createRun();
    appendRowMessage(run, rowId, '历史对话');
    appendRowEvent(run, rowId, { type: 'log', stream: 'stdout', text: '第一行' });
    appendRowEvent(run, rowId, { type: 'end', exitReason: 'completed' });

    const res = await getDrawerStream(url(`?rowId=${rowId}&rowChannel=candidate`), context({ runId: run.id }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    // 回放里带终态 ⇒ 流会自己结束（否则这里会挂住）。首块是 ready 注释帧（打开即有首字节）
    const text = await res.text();
    expect(text.startsWith(': ready\n\n')).toBe(true);
    expect(text).toMatch(/^id: 1$/m);
    expect(text).toMatch(/^id: 2$/m);
    const messageFrame = text.split('\n\n').find((block) => block.startsWith('event: message'));
    expect(messageFrame).toBeDefined();
    expect(messageFrame).not.toMatch(/^id: /m);
    // 载荷按**契约**校验（帧形状的真源只有一份）
    const dataLine = messageFrame?.split('\n').find((line) => line.startsWith('data: ')) ?? '';
    expect(RunStreamFrameSchema.parse(JSON.parse(dataLine.slice('data: '.length)))).toMatchObject({
      type: 'message',
      rowId,
      rowChannel: 'candidate',
    });
  });

  it('`Last-Event-ID` 优先于 query：重连时只发头、不发 query 的浏览器因此不重不漏', async () => {
    const { run, rowId } = await createRun();
    for (const text of ['一', '二', '三']) appendRowEvent(run, rowId, { type: 'log', stream: 'stdout', text });
    appendRowEvent(run, rowId, { type: 'end', exitReason: 'completed' });

    const byQuery = await getDrawerStream(url(`?rowId=${rowId}&rowChannel=candidate&afterSeq=2`), context({ runId: run.id }));
    const queryText = await byQuery.text();
    expect(queryText).not.toContain('"text":"一"');
    expect(queryText).toContain('"text":"三"');

    // 头与 query 冲突时以头为准（query 里带的是首连那一刻的旧值）
    const byHeader = await getDrawerStream(
      url(`?rowId=${rowId}&rowChannel=candidate&afterSeq=3`, { headers: { 'last-event-id': '1' } }),
      context({ runId: run.id }),
    );
    const headerText = await byHeader.text();
    expect(headerText).not.toContain('"text":"一"');
    expect(headerText).toContain('"text":"二"');
    expect(headerText).toContain('"text":"三"');
  });

  it('judge 那条 channel 读评分那一族：候选的事件不出现在这条流里', async () => {
    const { run, rowId } = await createRun();
    appendRowEvent(run, rowId, { type: 'log', stream: 'stdout', text: '候选的第一行' });
    const judgeFile = rowEventsFile(run.workspaceBase, run.id, rowId).replace(/events\.jsonl$/, 'judge-events.jsonl');
    mkdirSync(dirname(judgeFile), { recursive: true });
    appendEvent(judgeFile, { type: 'log', stream: 'stderr', text: '评分的第一行' });

    const res = await getDrawerStream(url(`?rowId=${rowId}&rowChannel=judge`), context({ runId: run.id }));
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('响应没有 body');
    // 评分的 `judge-events.jsonl` 里没有终态 ⇒ 这条流不会自己结束：读两块（ready + 历史）后取消
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    text += decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(text).toContain('评分的第一行');
    expect(text).not.toContain('候选的第一行');
  });
});
