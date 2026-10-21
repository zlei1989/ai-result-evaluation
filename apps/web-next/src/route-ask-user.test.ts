// @vitest-environment node
/**
 * 应答面路由：快照 `GET /api/ask-user`、信号流 `GET /api/ask-user/stream`、应答 `POST /api/ask-user/answers`。
 *
 * 与既有路由用例同源：**只断路由层自己的东西**——响应头四件套、状态码映射、zod 拦下的请求体。
 * 业务断言（幂等三条、快照只含未答的、答完出表）在 `@aieval/evaluator` 与 `@aieval/api` 的用例里，
 * 本文件不重复：同一件事写两遍，改一处就会漏另一处。
 *
 * `@aieval/evaluator` 是**假挂起表**而不是真表：真表挂 `globalThis`、跨用例存活，会逼着本文件
 * 去清一份不属于路由层的状态。假表只覆盖四个名字，其余名字由 `importOriginal` 原样透传——
 * `@aieval/api` 的 index 会把 evaluator 的一整套名字转出去（`recoverInterruptedRuns` 等），
 * 手写键清单漏一个就在运行期炸，且漏的那些与本文件无关。
 * 假表**如实模拟「已答名单」**：没有那一格，409 与 404 就分不开，而这两档正是路由层要映射的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type AskUserAnswer, type AskUserQuestion } from '@aieval/contracts';

/** 假挂起表：`pending` 是全部登记、`answered` 是已答名单（与真表同构，只是不挂 globalThis） */
const table = vi.hoisted(() => ({
  pending: new Map<string, unknown>(),
  answered: new Set<string>(),
}));

/**
 * 假 `@aieval/evaluator`：**手写键清单**，理由与 `route-runs.test.ts` / `route-run-artifacts.test.ts` 逐条相同——
 * 本应用没声明这个包（方向表：web-next 只到 api / core / ui / client / contracts），
 * 直连它连 `typeof import(...)` 都解析不到（tsc 报 TS2307），故句柄走 `vi.hoisted`、测试里不 import 它。
 * 下面每个键都在 `@aieval/api` 的 index 或某个模块求值期被读到，缺一个就在 import 阶段抛
 * （`[vitest] No "…" export is defined on the mock`），而**只会红在走到那条路径的用例上**。
 */
const evaluator = vi.hoisted(() => ({
  // 待答面（本文件的对象）：假表如实模拟「已答名单」，否则 409 与 404 分不开
  registerAskUser: vi.fn(),
  listPendingAskUser: vi.fn(),
  resolveAskUser: vi.fn(),
  subscribeAskUserChanges: vi.fn(() => () => {}),
  // 下面这些与本文件无关，但 api 的 index 会转出它们、或某个模块在求值期就收进 channel 常量
  callTextApi: vi.fn(),
  listRunsForCase: vi.fn(),
  requireJudgeAgent: vi.fn(),
  requireJudgeEffort: vi.fn(),
  resolveJudgeEffort: vi.fn(),
  resolveJudgeRoute: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
  abortCandidate: vi.fn(),
  abortRun: vi.fn(),
  assertRunMutable: vi.fn(),
  deleteRun: vi.fn(),
  getRun: vi.fn(),
  listRuns: vi.fn(() => []),
  rescoreCandidate: vi.fn(),
  retryCandidate: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  subscribeJudgeEvents: vi.fn(() => () => {}),
  subscribeCandidateEvents: vi.fn(() => () => {}),
  subscribeJudgeRecords: vi.fn(() => () => {}),
  subscribeCandidateRecords: vi.fn(() => () => {}),
  subscribeRunChanges: vi.fn(() => () => {}),
}));

vi.mock('@aieval/evaluator', () => {
  // 假表的实现（不能用 `vi.hoisted` 里的闭包：那里只能放 `vi.fn`，逻辑写在这里更好读）
  evaluator.registerAskUser.mockImplementation(
    (input: { askId: string; runId: string; candidateId: string | null; stage: string; request: { questions: AskUserQuestion[] } }) => {
      // 快照端点要的那几格：真表在登记时算 `askedAt`，并把 `questions` 从请求上下文里摊平出来
      table.pending.set(input.askId, {
        askId: input.askId,
        runId: input.runId,
        candidateId: input.candidateId,
        stage: input.stage,
        questions: input.request.questions,
        askedAt: '2026-10-13T12:00:00.000Z',
      });
      return { outcome: new Promise(() => {}), settle: () => {} };
    },
  );
  evaluator.listPendingAskUser.mockImplementation(() => [...table.pending.values()]);
  evaluator.resolveAskUser.mockImplementation((askId: string) => {
    if (table.answered.has(askId)) throw new ServiceError('CONFLICT', '这一问已经答过了');
    if (!table.pending.has(askId)) throw new ServiceError('NOT_FOUND', '这一问不在待答清单里');
    table.pending.delete(askId);
    table.answered.add(askId);
    return { askId, answeredAt: '2026-10-13T12:00:05.000Z' };
  });
  return evaluator;
});

const { GET: getSnapshot } = await import('@/app/api/ask-user/route');
const {
  GET: getSignalStream,
  dynamic: streamDynamic,
  runtime: streamRuntime,
} = await import('@/app/api/ask-user/stream/route');
const { POST: postAnswer } = await import('@/app/api/ask-user/answers/route');

/** 一条问题样本：三格布尔各有取值，免得「字段抄错」这类错在用例里也被抄一遍 */
const QUESTION: AskUserQuestion = {
  header: '选路径',
  prompt: '这次改动走哪条路？',
  options: [{ label: '原地改', description: null, recommended: false }],
  multiSelect: false,
  allowOther: true,
  secret: false,
};

/** 一份与 `QUESTION` 对上的答案 */
const ANSWER: AskUserAnswer = { header: '选路径', selected: ['原地改'], custom: null };

/** 往假表里登记一条提问（路由层只读 askId 与快照那几格；`runId` 是快照过滤的判据） */
function register(askId = 'ask-1', candidateId: string | null = 'row-1', runId = 'run-1'): void {
  evaluator.registerAskUser({
    askId,
    runId,
    candidateId,
    stage: 'agent',
    request: { questions: [QUESTION], toolName: 'AskUserQuestion', callId: 'call-1', vendorBudgetMs: null, subagentId: null },
  });
}

/**
 * 快照请求：与 Next 交给路由的入参同形（`query` 就是 `?runId=` 那一格）。
 * 走真的 `URL` 解析而不是把 runId 直接塞给 api：路由层要断的正是「查询串怎么变成过滤条件」。
 */
function snapshotRequest(query = ''): Request {
  return new Request(`http://localhost/api/ask-user${query}`);
}

/** 用真实的 Request 全局构造请求，和 Next 交给路由的入参同形 */
function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/ask-user/answers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  table.pending.clear();
  // 已答名单**刻意不清**：它与 `askId` 的对应关系是「谁被答过」，清了就等于换了一个进程
  table.answered.clear();
});

afterEach(() => {
  table.pending.clear();
  table.answered.clear();
});

describe('GET /api/ask-user（待答快照）', () => {
  it('把挂起表里的待答提问转成 JSON 清单', async () => {
    register('ask-1');
    register('ask-2', null);

    const response = await getSnapshot(snapshotRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<Record<string, unknown>>;
    expect(body.map((entry) => entry.askId)).toEqual(['ask-1', 'ask-2']);
    expect(body[0]).toMatchObject({ runId: 'run-1', candidateId: 'row-1', stage: 'agent', questions: [QUESTION] });
    expect(body[1]).toMatchObject({ candidateId: null });
    // 快照不带宽商上下文：那是回灌答案时才用的东西，界面没有消费方
    expect(Object.keys(body[0] ?? {})).not.toContain('toolName');
  });

  it('被人答过的那一问从快照里消失（快照是唯一读侧）', async () => {
    register('ask-1');
    await postAnswer(jsonRequest({ askId: 'ask-1', answers: [ANSWER] }));

    expect(await (await getSnapshot(snapshotRequest())).json()).toEqual([]);
  });

  it('没人提问时给空数组（不是 204、也不是 null）', async () => {
    const response = await getSnapshot(snapshotRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('`?runId=` 只返回该轮的条目；不带参数时返回全部（一条用例钉住两个方向）', async () => {
    register('ask-1', 'row-1', 'run-1');
    register('ask-2', null, 'run-2');

    const filtered = await getSnapshot(snapshotRequest('?runId=run-2'));
    expect(((await filtered.json()) as Array<{ askId: string }>).map((entry) => entry.askId)).toEqual(['ask-2']);

    const all = await getSnapshot(snapshotRequest());
    expect(((await all.json()) as Array<{ askId: string }>).map((entry) => entry.askId)).toEqual(['ask-1', 'ask-2']);
  });
});

describe('GET /api/ask-user/stream（信号流）', () => {
  it('响应头四件套与既有两条流逐字相同，且进程内总线要求 nodejs 运行时', async () => {
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

describe('POST /api/ask-user/answers（应答）', () => {
  it('首个应答：200 且回这一问的收场结果（答案原样带回，附带答时刻）', async () => {
    register();

    const response = await postAnswer(jsonRequest({ askId: 'ask-1', answers: [ANSWER] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      askId: 'ask-1',
      answer: { outcome: 'answered', answers: [ANSWER] },
      answeredAt: '2026-10-13T12:00:05.000Z',
    });
  });

  it('同一 askId 第二次提交：409 CONFLICT（不是 404——这一问确实存在过，客户端该提示「已经答过了」）', async () => {
    register();
    await postAnswer(jsonRequest({ askId: 'ask-1', answers: [ANSWER] }));

    const again = await postAnswer(jsonRequest({ askId: 'ask-1', answers: [ANSWER] }));

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('未知 askId：404 NOT_FOUND（客户端该去刷新快照）', async () => {
    const response = await postAnswer(jsonRequest({ askId: 'ask-没有这一条', answers: [ANSWER] }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('请求体不合法：400 INVALID_QUERY（缺 askId / 答案数组为空 / 答案形状不对，一条都不进表）', async () => {
    register();

    const bodies = [
      { answers: [ANSWER] },
      { askId: 'ask-1', answers: [] },
      { askId: 'ask-1', answers: [{ header: '选路径', selected: [] }] },
      { askId: '', answers: [ANSWER] },
    ];
    for (const body of bodies) {
      const response = await postAnswer(jsonRequest(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_QUERY' } });
    }

    // 一份都没被受理（走的是 zod 那一关，连 api 层都没进）：那一问还在待答清单里
    expect((await (await getSnapshot(snapshotRequest())).json()) as unknown[]).toHaveLength(1);
  });

  it('不是合法 JSON：400，且文案说的是请求体而不是查询参数', async () => {
    const response = await postAnswer(
      new Request('http://localhost/api/ask-user/answers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ 这不是 JSON',
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_QUERY', message: '请求体不是合法 JSON' } });
  });
});
