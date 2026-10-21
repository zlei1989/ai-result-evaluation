// @vitest-environment node
/**
 * 聚合流路由：`GET /api/runs/[runId]/stream?after=w-1:12,w-2:5`。
 *
 * 只钉**路由层**的四件（帧格式与游标语义由 api 包的 `run-aggregate-stream.test.ts` 钉住）：
 *   ① `after` 格式非法 ⇒ **400**：静默当成「空游标」会让调用方以为自己在续订，实际只收到实时增量
 *      （历史整段丢失，界面上表现为「刷新之后卡片一直是空的」）；
 *   ② 轮 / 行不存在 ⇒ 带原因的 404 JSON，而不是一条开了就断的 SSE；
 *   ③ 响应头是 SSE 的三件套（含给反向代理的 `X-Accel-Buffering`）；
 *   ④ 段配置 `runtime = 'nodejs'` + `force-dynamic`：事件总线是**进程内**的，换 runtime 会连不上编排层。
 *
 * 轮与行由**真实** POST 路由创建，`@aieval/evaluator` 整块被 mock（句柄走 `vi.hoisted`：
 * 本应用没声明那个包，直接 import 会让 tsc 红）。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type AgentEvent, type EvalRun } from '@aieval/contracts';
import {
  appendEvent,
  loadConfig,
  candidateEventsFile,
  saveConfig,
  setCasesRootForTesting,
  setConfigDirForTesting,
  writeCase,
  type AppConfig,
} from '@aieval/core';
import { POST as postRun } from '@/app/api/runs/route';
import {
  GET as getAggregateStream,
  dynamic as streamDynamic,
  runtime as streamRuntime,
} from '@/app/api/runs/[runId]/stream/route';
import { removeTreeWithRetry } from './testing/cleanup';

/** mock 句柄（`vi.hoisted` 的理由见 `route-runs.test.ts`） */
const evaluator = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortCandidate: vi.fn(),
  subscribeCandidateEvents: vi.fn(() => () => {}),
  // 评分那两条候选级流：`@aieval/api` 的 index 转出了它们，而 `run-stream.ts` / `messages-stream.ts`
  // 在**模块求值期**就把 `subscribeJudge*` 收进 channel 常量 ⇒ 缺键在 import 阶段就抛
  subscribeJudgeEvents: vi.fn(() => () => {}),
  subscribeJudgeRecords: vi.fn(() => () => {}),
  subscribeCandidateRecords: vi.fn(() => () => {}),
  // run 级那一套（聚合流按它订阅整轮）：同样是模块求值期读取
  subscribeRunEvents: vi.fn(() => () => {}),
  subscribeRunJudgeEvents: vi.fn(() => () => {}),
  subscribeRunRecords: vi.fn(() => () => {}),
  subscribeRunJudgeRecords: vi.fn(() => () => {}),
  // 信号流总线：api 的 index 转出 `streamGlobalSignals` / `streamAskUserChanges` / `streamInjectMessages`，
  // 那三个模块在模块求值期读这些键，缺键在 import 阶段就抛
  subscribeRunChanges: vi.fn(() => () => {}),
  subscribeAskUserChanges: vi.fn(() => () => {}),
  subscribeInjectChanges: vi.fn(() => () => {}),
  resolveJudgeRoute: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
}));

vi.mock('@aieval/evaluator', () => evaluator);

let dir: string;
let workspaceRoot: string;
let store: Map<string, EvalRun>;

/** Next 16 的 `params` 是 Promise；泛型写法见 `route-run-artifacts.test.ts` 的同名助手 */
function runContext(params: { runId: string }): { params: Promise<{ runId: string }> } {
  return { params: Promise.resolve(params) };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 往该候选的事件日志里追加一条事件（真实文件，seq 由 core 按文件发号） */
function append(runId: string, candidateId: string, event: Parameters<typeof appendEvent>[1]): AgentEvent {
  const file = candidateEventsFile(workspaceRoot, runId, candidateId);
  mkdirSync(dirname(file), { recursive: true });
  return appendEvent(file, event);
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-aggregate-'));
  setConfigDirForTesting(dir);
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

/** 走真实路由建一轮两个候选的评测，返回 runId / 两个 candidateId */
async function createRun(): Promise<{ runId: string; candidateIds: string[] }> {
  const res = await postRun(
    jsonRequest({
      caseId: 'c-1',
      executionMode: 'parallel',
      candidates: [
        { agentKind: 'cc', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { agentKind: 'cc', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
      ],
    }),
  );
  expect(res.status).toBe(201);
  const run = (await res.json()) as EvalRun;
  const candidateIds = run.candidates.map((row) => row.id);
  expect(candidateIds).toHaveLength(2);
  return { runId: run.id, candidateIds };
}

function streamRequest(query = ''): Request {
  return new Request(`http://localhost/api/runs/run-1/stream${query}`);
}

describe('GET /api/runs/[runId]/stream', () => {
  it('段配置：nodejs runtime + force-dynamic（进程内事件总线）', () => {
    expect(streamRuntime).toBe('nodejs');
    expect(streamDynamic).toBe('force-dynamic');
  });

  it('`after` 格式非法 ⇒ 400（不许静默降级成空游标）', async () => {
    const { runId } = await createRun();

    for (const after of ['w-1', 'w-1:', ':3', 'w-1:x', 'w-1:1,', 'w-1:1,,w-2:2', 'w-1:1,w-2:2,']) {
      const res = await getAggregateStream(
        new Request(`http://localhost/api/runs/${runId}/stream?after=${encodeURIComponent(after)}`),
        runContext({ runId }),
      );
      expect(res.status, `after=${after} 应当是 400`).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_QUERY');
    }
  });

  it('轮不存在 ⇒ 404 JSON（校验在开流之前完成）', async () => {
    const res = await getAggregateStream(streamRequest(), runContext({ runId: 'run-never' }));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('游标里的行不存在 ⇒ 404 JSON', async () => {
    const { runId } = await createRun();
    const res = await getAggregateStream(
      new Request(`http://localhost/api/runs/${runId}/stream?after=row-never:0`),
      runContext({ runId }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { message: string } }).toMatchObject({
      error: { message: '该评测里没有这个候选（row-never）' },
    });
  });

  it('合法请求：SSE 头三件套 + 按逐行游标回放各自的尾段（一帧一块）', async () => {
    const { runId, candidateIds } = await createRun();
    const [first = '', second = ''] = candidateIds;
    append(runId, first, { type: 'log', stream: 'stdout', text: '第一行-旧' });
    const firstKept = append(runId, first, { type: 'log', stream: 'stdout', text: '第一行-新' });
    append(runId, second, { type: 'log', stream: 'stdout', text: '第二行-更旧' });
    append(runId, second, { type: 'log', stream: 'stdout', text: '第二行-旧' });
    const secondKept = append(runId, second, { type: 'log', stream: 'stdout', text: '第二行-新' });

    const res = await getAggregateStream(
      new Request(`http://localhost/api/runs/${runId}/stream?after=${first}:1,${second}:2`),
      runContext({ runId }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    const texts: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done === true) break;
      texts.push(decoder.decode(chunk.value));
    }
    await reader?.cancel();

    expect(texts[0]).toBe(': ready\n\n');
    // 跨行不排序：各候选的帧按自己的 seq 升序，候选与候选之间按游标表的顺序
    expect(texts[1]).toBe(`id: ${firstKept.seq}\ndata: ${JSON.stringify({ ...firstKept, candidateId: first, candidateChannel: 'candidate' })}\n\n`);
    expect(texts[2]).toBe(
      `id: ${secondKept.seq}\ndata: ${JSON.stringify({ ...secondKept, candidateId: second, candidateChannel: 'candidate' })}\n\n`,
    );
  });

  it('不带 `after`（空游标）⇒ 200 但**不回放**任何历史', async () => {
    const { runId, candidateIds } = await createRun();
    const [first = ''] = candidateIds;
    append(runId, first, { type: 'log', stream: 'stdout', text: '盘上有历史' });

    const res = await getAggregateStream(streamRequest(), runContext({ runId }));
    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toBe(': ready\n\n');
    await reader?.cancel();
  });
});
