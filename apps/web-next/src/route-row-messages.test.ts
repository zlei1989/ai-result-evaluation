// @vitest-environment node
/**
 * 消息路由（spec v3 §2）：`GET .../rows/[rowId]/messages`（折叠视图）与 `.../messages/stream`（SSE）。
 *
 * 只钉两件**路由层**的事（内容与帧格式由 api 包的 `messages-stream.test.ts` 钉住）：
 *   ① 存在性校验发生在**开流之前**：轮/行不存在时返回带原因的 404 JSON，而不是一个开了就断的 SSE 流；
 *   ② 段配置 `runtime = 'nodejs'` + `force-dynamic`：记录总线是**进程内**的（§11 R6），
 *      换 runtime 的症状是「连上了、永远没有新消息」——零报错，没有任何运行时守卫能发现。
 *
 * 本文件**不读** SSE 响应体：消息流不因终态关流（见 `messages-stream.ts` 文件头口径 ②），
 * `res.text()` 会一直等下去。轮与行由**真实** POST 路由创建（`route-run-artifacts.test.ts` 的同一手法），
 * `@aieval/evaluator` 整块被 mock，且句柄走 `vi.hoisted`（本应用没声明那个包，直接 import 会让 tsc 红）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type EvalRun } from '@aieval/contracts';
import { appendMessage, loadConfig, rowMessagesFile, saveConfig, setConfigDirForTesting, type AppConfig } from '@aieval/core';
import { POST as postRun } from '@/app/api/runs/route';
import { GET as getMessages } from '@/app/api/runs/[runId]/rows/[rowId]/messages/route';
import {
  GET as getMessagesStream,
  dynamic as streamDynamic,
  runtime as streamRuntime,
} from '@/app/api/runs/[runId]/rows/[rowId]/messages/stream/route';

/** mock 句柄（`vi.hoisted` 的理由见 `route-runs.test.ts`） */
const evaluator = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRowEvents: vi.fn(() => () => {}),
  subscribeRowRecords: vi.fn(() => () => {}),
  resolveJudgeRoute: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
}));

vi.mock('@aieval/evaluator', () => evaluator);

let dir: string;
let workspaceRoot: string;
let store: Map<string, EvalRun>;

/** Next 16 的 `params` 是 Promise；泛型写法见 `route-run-artifacts.test.ts` 的同名助手 */
function rowContext<P extends Record<string, string>>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-messages-'));
  setConfigDirForTesting(dir);
  workspaceRoot = join(dir, 'ws');
  const config = loadConfig();
  const seeded: AppConfig = {
    ...config,
    settings: { ...config.settings, workspaceRoot },
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
    cases: [
      {
        id: 'c-1',
        title: '多协议入站转换',
        repoPath: 'D:\\projects\\gateway',
        commitHash: null,
        repoBranch: null,
        taskPrompt: '补齐转换',
        rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }] }] },
        createdAt: '2026-09-22T00:00:00.000Z',
        updatedAt: '2026-09-22T00:00:00.000Z',
      },
    ],
  };
  saveConfig(seeded);

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
  rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
});

/** 走真实路由建一轮评测，返回 runId / rowId */
async function createRun(): Promise<{ runId: string; rowId: string }> {
  const res = await postRun(
    jsonRequest({
      caseId: 'c-1',
      executionMode: 'serial',
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    }),
  );
  expect(res.status).toBe(201);
  const run = (await res.json()) as EvalRun;
  const row = run.rows[0];
  if (row === undefined) throw new Error('创建评测没有产生候选行');
  return { runId: run.id, rowId: row.id };
}

describe('GET .../rows/[rowId]/messages', () => {
  it('该行还没有消息时返回两个空数组（不是 404、也不是空表头）', async () => {
    const { runId, rowId } = await createRun();
    const res = await getMessages(new Request('http://localhost/api/messages'), rowContext({ runId, rowId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [], subagents: [] });
  });

  it('有记录时返回**折叠后**的视图（同一条逻辑消息的多条投递只剩最后一条）', async () => {
    const { runId, rowId } = await createRun();
    const file = rowMessagesFile(workspaceRoot, runId, rowId);
    mkdirSync(dirname(file), { recursive: true });
    const base = {
      vendorId: null,
      role: 'assistant' as const,
      source: 'wire' as const,
      roundTrip: 1,
      vendorTurn: null,
      step: null,
      parentCallId: null,
      subagentId: null,
      mergeKey: 'main|1|assistant|-',
      raw: null,
    };
    appendMessage(file, {
      ...base,
      messageId: 'run-1:1',
      chunk: 'delta',
      assembly: 'open',
      blocks: [{ type: 'text', text: '我先看' }],
    });
    appendMessage(file, {
      ...base,
      messageId: 'run-1:2',
      chunk: 'snapshot',
      assembly: 'snapshot',
      blocks: [{ type: 'text', text: '我先看一下配置文件。' }],
    });

    const res = await getMessages(new Request('http://localhost/api/messages'), rowContext({ runId, rowId }));
    const body = (await res.json()) as { messages: { messageId: string; blocks: unknown[] }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] });
  });

  it('轮不存在 ⇒ 404 JSON', async () => {
    const { rowId } = await createRun();
    const res = await getMessages(new Request('http://localhost/api/messages'), rowContext({ runId: 'run-never', rowId }));
    expect(res.status).toBe(404);
  });

  it('行不存在 ⇒ 404 JSON', async () => {
    const { runId } = await createRun();
    const res = await getMessages(new Request('http://localhost/api/messages'), rowContext({ runId, rowId: 'row-never' }));
    expect(res.status).toBe(404);
  });
});

describe('GET .../rows/[rowId]/messages/stream', () => {
  it('段配置：nodejs runtime + force-dynamic（进程内记录总线，§11 R6）', () => {
    expect(streamRuntime).toBe('nodejs');
    expect(streamDynamic).toBe('force-dynamic');
  });

  it('轮不存在 ⇒ 404 JSON（校验在开流之前完成）', async () => {
    const { rowId } = await createRun();
    const res = await getMessagesStream(new Request('http://localhost/api/messages/stream'), rowContext({ runId: 'run-never', rowId }));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('行不存在 ⇒ 404 JSON', async () => {
    const { runId } = await createRun();
    const res = await getMessagesStream(new Request('http://localhost/api/messages/stream'), rowContext({ runId, rowId: 'row-never' }));
    expect(res.status).toBe(404);
  });

  it('存在时响应头是 SSE 的四个必需项（含给反向代理的 X-Accel-Buffering）', async () => {
    const { runId, rowId } = await createRun();
    const res = await getMessagesStream(new Request('http://localhost/api/messages/stream'), rowContext({ runId, rowId }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    // 不读体：流不会自己结束（文件头口径 ②）。取消它，避免悬挂的定时器留到用例之后。
    await res.body?.cancel();
  });
});
