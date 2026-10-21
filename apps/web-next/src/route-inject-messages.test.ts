// @vitest-environment node
/**
 * 人工消息路由组：快照 `GET /api/inject-messages`、发送 `POST`（同一条路由）、信号流
 * `GET /api/inject-messages/stream`、撤回 `POST .../retract`、改期 `POST .../promote`、
 * 附件 `POST .../attachments`。
 *
 * 与既有路由用例同源：**只断路由层自己的东西**——响应头四件套、状态码映射、zod 拦下的请求体、
 * multipart 表单的读法。业务断言（幂等三条、四态、上限、文件名净化）在 `@aieval/api` 与
 * `@aieval/core` 的用例里，本文件不重复。
 *
 * `@aieval/evaluator` **不 mock**：队列表与运行快照都用真的（快照由 `saveRun` 真落盘），
 * 判断「这个候选在不在」的是真 `getRun`。这条路由组的存在性校验与附件根都读快照，
 * 假的快照会让撤回那条路写候选级事件时报一条 ERROR（它按 `run.json` 解析这一轮的根），
 * 那种噪声会盖住真的问题。附件确实落到临时磁盘上（判据是「盘上真的多出这一个文件」）。
 * 只有两样东西走 `vi.importActual`（见下）：本应用没声明那个包，`import` 连类型都解析不到。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EvalRun } from '@aieval/contracts';
import { setCasesRootForTesting, setConfigDirForTesting } from '@aieval/core';
import { updateSettings } from '@aieval/api';
import { GET as getSnapshot, POST as postSend } from '@/app/api/inject-messages/route';
import { POST as postAttachments } from '@/app/api/inject-messages/attachments/route';
import { POST as postPromote } from '@/app/api/inject-messages/promote/route';
import { POST as postRetract } from '@/app/api/inject-messages/retract/route';
import { removeTreeWithRetry } from './testing/cleanup';

// 段配置与 GET 一起取：`dynamic` / `runtime` 是 Next 的**段配置导出**（不是普通函数），
// 用动态 import 的具名解构取它们（`import { dynamic as … }` 在 TS 的语法里读不过去）
const {
  GET: getSignalStream,
  dynamic: streamDynamic,
  runtime: streamRuntime,
} = await import('@/app/api/inject-messages/stream/route');

/**
 * 真实 evaluator 模块的两格，都走 `vi.importActual`：`saveRun` 用来把夹具真落盘
 * （否则 `getRun` 找不到那一轮，撤回那条路的事件会报 ERROR），`resetInjectQueueForTesting`
 * 用来清那张挂 `globalThis` 的表（它跨用例、跨文件存活）。
 * 泛型给 `Record<string, unknown>`：本应用没声明这个包（方向表：web-next 只到 api / core / ui /
 * client / contracts），连 `typeof import('@aieval/evaluator')` 都解析不到（tsc 报 TS2307），
 * 名字的存在性因此由运行期负责（本仓路由用例同一处置）。
 */
const actualEvaluator = await vi.importActual<Record<string, unknown>>('@aieval/evaluator');
const saveRun = actualEvaluator.saveRun as (run: EvalRun) => void;
const resetInjectQueueForTesting = actualEvaluator.resetInjectQueueForTesting as () => void;

let dir: string;

/**
 * 造一轮单行评测并**真落盘**（`saveRun` 写进本用例自己的临时工作区根）：**手写最小字面量**，
 * 不走 `POST /api/runs`——真实创建路径要连供应商、用例与设置一起播种，而那几样这条路由组
 * 一处都用不到，字面量的代价只是把契约里那几格写全。
 * `workspaceBase` 取**本用例自己的临时目录**：附件落盘是真的，上一用例留下的文件不该影响下一条。
 */
function seedRun(): EvalRun {
  const run: EvalRun = {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '为多协议入站补齐转换',
    note: '',
    repoPath: join(dir, 'repo'),
    commitHash: null,
    repoBranch: null,
    rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '补齐转换', weight: 20 }] }] },
    includeSteps: false,
    status: 'idle',
    executionMode: 'serial',
    useAgentJudge: false,
    askUser: false,
    injectMessages: true,
    candidates: [
      {
        id: 'r-1',
        agentKind: 'cc',
        providerId: 'p-anthropic',
        providerName: 'Anthropic 网关',
        baseUrl: 'https://gw.example.com/anthropic',
        modelId: 'claude-opus-4-6',
        status: 'pending',
        branch: 'test/r-1',
        workspacePath: join(dir, 'run-1', 'candidates', 'r-1', 'workspace'),
        baselineCommit: '',
        tokens: null,
        turns: null,
        durationMs: null,
        diff: null,
        score: null,
        error: null,
        attempts: 0,
        sessionId: null,
        followUps: 0,
        followUpRounds: 0,
      },
    ],
    workspaceBase: dir,
    createdAt: '2026-10-13T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  };
  saveRun(run);
  return run;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-inject-'));
  setConfigDirForTesting(dir);
  // 用例目录也指到临时目录：用例是一文件一落（core 的 `case-store`），config 的 override 管不到它
  setCasesRootForTesting(join(dir, 'cases'));
  // 快照读侧只扫**当前设置里的根**（`getRun` 的口径），故它必须与本用例那棵树对上
  updateSettings({ workspaceRoot: dir });
  // 队列表挂在 `globalThis` 的总线上：不清的话上一条用例的条目会让快照多一条
  resetInjectQueueForTesting();
  seedRun();
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

/** 用真实的 Request 全局构造请求，和 Next 交给路由的入参同形 */
function jsonRequest(body: unknown, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** 一条合法的登记请求 */
function sendBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { runId: 'run-1', candidateId: 'r-1', messageId: 'm-1', text: '先跑一遍测试', attachments: [], requires: 'idle', ...overrides };
}

/** 登记一条（多数用例的前置） */
async function send(overrides: Record<string, unknown> = {}): Promise<void> {
  const response = await postSend(jsonRequest(sendBody(overrides), '/api/inject-messages'));
  expect(response.status).toBe(200);
}

describe('GET /api/inject-messages（快照）', () => {
  it('没有消息时给空数组（不是 204、也不是 null）', async () => {
    const response = await getSnapshot(new Request('http://localhost/api/inject-messages?runId=run-1&candidateId=r-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('给登记过的条目（正文、两档要求与四态都在）', async () => {
    await send();

    const response = await getSnapshot(new Request('http://localhost/api/inject-messages?runId=run-1&candidateId=r-1'));

    expect(await response.json()).toMatchObject([{ messageId: 'm-1', text: '先跑一遍测试', requires: 'idle', state: 'queued' }]);
  });

  it('查询参数缺失或不合法 ⇒ 400 INVALID_QUERY（不是 500，也不是空队列）', async () => {
    for (const url of [
      'http://localhost/api/inject-messages',
      'http://localhost/api/inject-messages?runId=run-1',
      'http://localhost/api/inject-messages?runId=&candidateId=r-1',
    ]) {
      const response = await getSnapshot(new Request(url));
      expect(response.status, url).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
    }
  });

  it('轮不存在 ⇒ 404 JSON', async () => {
    const response = await getSnapshot(new Request('http://localhost/api/inject-messages?runId=run-never&candidateId=r-1'));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('POST /api/inject-messages（发送）', () => {
  it('首次登记：200 + created: true + 那一条', async () => {
    const response = await postSend(jsonRequest(sendBody(), '/api/inject-messages'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: true, message: { messageId: 'm-1', state: 'queued' } });
  });

  it('同一 messageId 再发一次：**200**（不是 409）+ created: false + 同一条，队列里仍只有一条', async () => {
    await send();
    const again = await postSend(jsonRequest(sendBody({ text: '改过的另一句' }), '/api/inject-messages'));

    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, message: { text: '先跑一遍测试' } });
    expect(await (await getSnapshot(new Request('http://localhost/api/inject-messages?runId=run-1&candidateId=r-1'))).json()).toHaveLength(1);
  });

  it('请求体不合法 ⇒ 400，一条都不进表（缺 requires / 空消息 / 附件超 10 个 / id 形状不对）', async () => {
    const bodies = [
      { ...sendBody(), requires: undefined },
      sendBody({ text: '   ' }),
      sendBody({ attachments: Array.from({ length: 11 }, () => ({ kind: 'file', path: '/abs/a.txt', mimeType: null })) }),
      sendBody({ messageId: '../evil' }),
    ];
    for (const body of bodies) {
      const response = await postSend(jsonRequest(body, '/api/inject-messages'));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
    }
    expect(await (await getSnapshot(new Request('http://localhost/api/inject-messages?runId=run-1&candidateId=r-1'))).json()).toEqual([]);
  });

  it('不是合法 JSON：400，且文案说的是请求体而不是查询参数', async () => {
    const response = await postSend(jsonRequest('{ 这不是 JSON', '/api/inject-messages'));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_QUERY', message: '请求体不是合法 JSON' } });
  });
});

describe('GET /api/inject-messages/stream（信号流）', () => {
  it('响应头四件套与既有三条流逐字相同，且进程内总线要求 nodejs 运行时', async () => {
    const response = getSignalStream();

    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('connection')).toBe('keep-alive');
    // 反代默认会把 SSE 缓冲成「等连接结束才一起到」：少了这一格，症状是「帧全对但要等很久」
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    expect(streamDynamic).toBe('force-dynamic');
    expect(streamRuntime).toBe('nodejs');

    await response.body?.cancel();
  });
});

describe('POST /api/inject-messages/retract（撤回）', () => {
  it('还没投出去的那一条：200 + removed', async () => {
    await send();

    const response = await postRetract(jsonRequest({ runId: 'run-1', candidateId: 'r-1', messageId: 'm-1' }, '/api/inject-messages/retract'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'removed', message: { state: 'gone' } });
  });

  it('重复撤回 ⇒ 200 + already-retracted（不是 404：那会让客户端以为这个 id 从没存在过）', async () => {
    await send();
    await postRetract(jsonRequest({ runId: 'run-1', candidateId: 'r-1', messageId: 'm-1' }, '/api/inject-messages/retract'));

    const again = await postRetract(jsonRequest({ runId: 'run-1', candidateId: 'r-1', messageId: 'm-1' }, '/api/inject-messages/retract'));

    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: 'already-retracted' });
  });

  it('表里没有这个 id ⇒ 404；请求体不合法 ⇒ 400', async () => {
    const missing = await postRetract(jsonRequest({ runId: 'run-1', candidateId: 'r-1', messageId: 'm-never' }, '/api/inject-messages/retract'));
    expect(missing.status).toBe(404);

    const bad = await postRetract(jsonRequest({ runId: 'run-1', candidateId: 'r-1' }, '/api/inject-messages/retract'));
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/inject-messages/promote（改期）', () => {
  it('排队 → 立即：200 + promoted，且快照里的 requires 真的变了', async () => {
    await send();

    const response = await postPromote(jsonRequest({ runId: 'run-1', candidateId: 'r-1', messageId: 'm-1' }, '/api/inject-messages/promote'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'promoted', message: { requires: 'round' } });
  });

  it('没有这个 messageId ⇒ 404；请求体不合法 ⇒ 400', async () => {
    expect((await postPromote(jsonRequest({ runId: 'run-1', candidateId: 'r-1', messageId: 'm-never' }, '/api/inject-messages/promote'))).status).toBe(404);
    expect((await postPromote(jsonRequest({ messageId: 'm-1' }, '/api/inject-messages/promote'))).status).toBe(400);
  });
});

describe('POST /api/inject-messages/attachments（附件 multipart）', () => {
  /** 一份 multipart 表单（`file` 用真实的 `File`，与 Next 交给路由的形状同源） */
  function formRequest(fields: Record<string, string>, file: File | null): Request {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    if (file !== null) form.set('file', file);
    return new Request('http://localhost/api/inject-messages/attachments', { method: 'POST', body: form });
  }

  it('落盘成功：200 + {kind, path, mimeType}，文件真的在盘上、内容逐字节相等', async () => {
    const response = await postAttachments(
      formRequest({ runId: 'run-1', candidateId: 'r-1', messageId: 'm-1' }, new File(['png-body'], 'a.png', { type: 'image/png' })),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string; path: string; mimeType: string | null };
    expect(body).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(body.path).toContain(join('run-1', 'candidates', 'r-1', 'attachments', 'm-1'));
    expect(readFileSync(body.path, 'utf8')).toBe('png-body');
  });

  it('表单缺字段 ⇒ 400（`messageId` 的形状也在这一关：它会被拼进目录名）', async () => {
    const missing = await postAttachments(formRequest({ runId: 'run-1', candidateId: 'r-1' }, new File(['x'], 'a.txt', { type: 'text/plain' })));
    expect(missing.status).toBe(400);

    const traversal = await postAttachments(
      formRequest({ runId: 'run-1', candidateId: 'r-1', messageId: '..' }, new File(['x'], 'a.txt', { type: 'text/plain' })),
    );
    expect(traversal.status).toBe(400);
  });

  it('表单里没有文件 ⇒ 400，文案说的是字段名（不是 500）', async () => {
    const response = await postAttachments(formRequest({ runId: 'run-1', candidateId: 'r-1', messageId: 'm-1' }, null));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
  });

  it('正文不是 multipart ⇒ 400（`formData()` 抛的 TypeError 不许折成 500）', async () => {
    const response = await postAttachments(jsonRequest({ runId: 'run-1' }, '/api/inject-messages/attachments'));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
  });

  it('声明长度明显超标的请求在读进内存之前就被拒 ⇒ 400', async () => {
    const form = new FormData();
    form.set('runId', 'run-1');
    form.set('candidateId', 'r-1');
    form.set('messageId', 'm-1');
    form.set('file', new File(['x'], 'a.txt', { type: 'text/plain' }));
    const response = await postAttachments(
      new Request('http://localhost/api/inject-messages/attachments', {
        method: 'POST',
        // 显式声明一个超标的长度（真机上是客户端自己报的）：粗筛据此在 `formData()` 之前拒绝
        headers: { 'content-length': String(64 * 1024 * 1024) },
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
  });

  it('轮不存在 ⇒ 404，且盘上不建任何目录', async () => {
    const response = await postAttachments(
      formRequest({ runId: 'run-never', candidateId: 'r-1', messageId: 'm-1' }, new File(['x'], 'a.txt', { type: 'text/plain' })),
    );

    expect(response.status).toBe(404);
    expect(existsSync(join(dir, 'run-never'))).toBe(false);
  });
});
