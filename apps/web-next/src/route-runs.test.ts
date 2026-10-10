// @vitest-environment node
/**
 * 评测路由端到端：列表 / 创建 / 详情 / 启动 / 终止 / 单行终止 / 候选池。
 *
 * **`@aieval/evaluator` 被整块 mock 掉**：这些用例要验的是「zod → api → 错误映射」这条链路，
 * 而编排层的启动会真的 spawn agent 子进程（评测执行用假的 evaluator：在 api 边界替换掉它，
 * 既不起进程，也能精确控制「磁盘上有什么快照」）。`@aieval/agents` / `@aieval/core` / `@aieval/api`
 * 都是真实的——候选池的协议过滤正需要真实的注册表元数据。
 *
 * 配置目录与工作区根目录都在 mkdtemp 出来的临时目录里：**绝不触碰真实 ~/.aieval / ~/.aieval-runs**。
 *
 * 四处**实测修正**（前三处是不修就在本机必然红的原因，第四处是不修就不安全的原因）：
 * 1. mock 句柄走 `vi.hoisted`，测试里**不再**`import '@aieval/evaluator'`：该说明符不在本应用的
 * 依赖里（`AGENTS.md` 的方向表），TS 直接 `Cannot find module`（`pnpm typecheck` 会红）；
 * 同时 `vi.mock` 的说明符由 `vitest.config.ts` 的 alias 指到真实源文件——没有那个 alias 时
 * mock 只注册在裸说明符上，**api 包内部那次 import 解析到真实模块，mock 一条都不生效**，
 * 测试侧拿到 `vi.fn`、api 侧却真的在跑编排层（实测日志里出现 `[evaluator] 评测开始`）；
 * 2. mock 工厂必须把这一整套名字都列出来（`resolveJudgeRoute` / `recoverInterruptedRuns` /
 * `requireJudgeAgent` / `deleteRun` / `assertRunMutable`）：本文件经 `@/app/api/runs/route`
 * 间接 import `@aieval/api` 的 `index.ts`，而它**转出**了这些名字。
 * ⚠️ 缺键**不在模块求值期**抛（这一句原来是「ESM 的转出绑定在模块求值期就被读取，缺键会直接抛」，
 * 实测推翻）：模块照常求值，vitest 的 mock 命名空间是**访问那一刻**才抛
 * `[vitest] No "…" export is defined on the mock`。于是红的是**走到那条路径**的用例
 * （服务端 500，cause 就是那句 mock 错误），同文件其余用例照绿——实测删掉 `assertRunMutable`
 * 只有那两条真的走到 `updateRun` 的 PUT 用例红；而**没有任何执行路径访问**的键
 * （如只被启动钩子用的 `recoverInterruptedRuns`）缺了也**全绿**（实测 23/23 全过）。
 * 故这条规则是「照清单补键」：漏键不会当场响，只会让**别人的**用例在你改的另一处红；
 * 3. `listRuns` 必须装上实现（`[...store.values]`）：原稿只用 `vi.fn` 占位，于是
 * `listRunsView` 里的 `[...undefined]` 抛 TypeError、接口回 500；
 * 4. 列表顺序那条用例必须先 `store.clear`：POST 真实创建的两轮评测，其 `createdAt` 是
 * **本机当前时刻**，比用例写死的 `T09:00` 更新，
 * 不清掉它们就会排在最前，`toEqual(['new','old'])` 必然红。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EFFORT_OFF, ServiceError, type EvalRun } from '@aieval/contracts';
import { loadConfig, saveConfig, setCasesRootForTesting, setConfigDirForTesting, writeCase, type AppConfig } from '@aieval/core';
import { GET as getRuns, POST as postRun } from '@/app/api/runs/route';
import { GET as getModelOptions } from '@/app/api/runs/model-options/route';
import {
  GET as getRunEvents,
  dynamic as runEventsDynamic,
  runtime as runEventsRuntime,
} from '@/app/api/runs/events/route';
import { GET as getRun, DELETE as deleteRunRoute, PUT as putRun } from '@/app/api/runs/[runId]/route';
import { POST as postStart } from '@/app/api/runs/[runId]/start/route';
import { POST as postAbortRun } from '@/app/api/runs/[runId]/abort/route';
import { POST as postAbortRow } from '@/app/api/runs/[runId]/rows/[rowId]/abort/route';
import { POST as postRescore } from '@/app/api/runs/[runId]/rows/[rowId]/rescore/route';
import { POST as postRetry } from '@/app/api/runs/[runId]/rows/[rowId]/retry/route';
import { removeTreeWithRetry } from './testing/cleanup';

/**
 * mock 句柄（`vi.hoisted` 让它们先于 import 求值，`vi.mock` 的工厂再把它整块交出去）。
 * 用具柄而不是 `await import('@aieval/evaluator')`：后者会让 tsc 去解析一个本应用没声明的包。
 *
 * **这是一份手写的键清单，漏键在运行期才炸**：api 的 `createRun` 在 `useAgentJudge: true` 时
 * 会调 `requireJudgeAgent`（创建时的评分配置校验），本文件少了它就会得到
 * `[vitest] No "requireJudgeAgent" export is defined on the "@aieval/evaluator" mock` → 500。
 * 本文件**刻意**把这两个评分路由函数留成空桩：这里钉的是「zod 解析有没有把字段丢掉」这条传输链，
 * 评分配置的实际判定在 `@aieval/api` 自己的用例里（runs.test.ts 用的是真实实现）。
 */
const evaluator = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  // `@aieval/api` 的 index.ts 转出了 `rescoreRow`，而本文件经 `@/app/api/runs/route`
  // 间接 import 了那个 index：缺键是**访问那一刻**才抛
  // 「No "rescoreRow" export is defined on the mock」（与文件头第 2 条同一个坑）
  rescoreRow: vi.fn(),
  // 单行重新执行与重评同一个形状、同一个坑：api 的 index 转出了 `retryRow`，
  // 缺键在**访问到它**（走那条路由的用例）时才抛「No "retryRow" export is defined on the mock」
  retryRow: vi.fn(),
  subscribeRowEvents: vi.fn(() => () => {}),
  // 评分那两条流：`@aieval/api` 的 index 转出了它们，而 `messages-stream.ts` /
  // `run-stream.ts` 在**模块求值期**就把 `subscribeJudge*` 收进 channel 常量 ⇒ 缺键在 import 阶段就抛
  subscribeJudgeEvents: vi.fn(() => () => {}),
  subscribeJudgeRecords: vi.fn(() => () => {}),
  // 候选那条记录流：`messages-stream.ts` 在模块求值期收进 channel 常量，同上
  subscribeRowRecords: vi.fn(() => () => {}),
  // run 级信号总线（`/api/runs/events`）：api 的 index 转出 `streamRunSignals`，而 run-events.ts
  // 在模块求值期就读这个键——缺了它，**任何**经 `@aieval/api` index 的 import 都当场抛
  // 「No "subscribeRunChanges" export is defined on the mock」（比 rescoreRow 那类访问时才抛更早）。
  // 签名显式写 listener 参数：下面那条接驳用例要 mockImplementation，零参推断会与之不兼容
  subscribeRunChanges: vi.fn((listener: (runId: string) => void) => {
    void listener;
    return () => {};
  }),
  resolveJudgeRoute: vi.fn(),
  requireJudgeAgent: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
  // 整轮删除：api 的 index.ts 转出了 `deleteRun`，同一个坑
  deleteRun: vi.fn(),
  // 编辑的活性守卫（`updateRun` 在落盘前调它）：同样是 api 的 index.ts 转出的名字。
  // 留成空桩是有意的——这里钉的是传输链，活性判据在 contracts / api 自己的用例里。
  // ⚠️ 缺了它**不会**在模块求值期报错：删掉这一行文件照样加载，只有真的走到
  // `updateRun` 的那两条 PUT 用例红（500，cause 是 `[vitest] No "assertRunMutable" export is
  // defined on the mock`），其余 21 条照绿——「手写键清单要一直照补」的理由就在这里。
  assertRunMutable: vi.fn(),
}));

vi.mock('@aieval/evaluator', () => evaluator);

let dir: string;
let store: Map<string, EvalRun>;

const openaiProvider = {
  id: 'p-openai',
  name: 'OpenAI 网关',
  protocolType: 'openai' as const,
  baseUrl: 'https://gw.example.com/v1',
  apiKey: 'sk-openai',
  models: [{ id: 'gpt-5', source: 'fetched' as const }],
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
};

const anthropicProvider = {
  ...openaiProvider,
  id: 'p-anthropic',
  name: 'Anthropic 网关',
  protocolType: 'anthropic' as const,
  baseUrl: 'https://gw.example.com/anthropic',
  apiKey: 'sk-anthropic',
  models: [{ id: 'claude-opus-4-6', source: 'manual' as const }],
};

const testCase = {
  id: 'c-1',
  title: '多协议入站转换',
  repoPath: 'D:\\projects\\gateway',
  commitHash: null,
  repoBranch: null,
  taskPrompt: '补齐转换',
  // 用例的评分表：读侧对**旧版数据**（只有 judgePrompt、没有 rubric）显式抛 INTERNAL，
  // 故任何喂进 getCase / createRun 的夹具都必须带上这一格（夹具与契约同批换形状）
  rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }] }] },
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
};

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 直通调用路由的 POST（Next 把 params 包成 Promise，这里按同形传） */
function post<P extends Record<string, string>>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  params: P,
): Promise<Response> {
  return handler(new Request('http://localhost/api/runs'), { params: Promise.resolve(params) });
}

beforeEach(() => {
  // 本仓 vitest **没开 `clearMocks`**（vitest.node.ts 只设 environment/include），
  // 而 `not.toHaveBeenCalled()` 断言的是累积历史：不清就会把上一轮用例的调用算进来
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-runs-'));
  setConfigDirForTesting(dir);
  // 用例目录也指到临时目录：用例是一文件一落（core 的 case-store），config 目录的 override 管不到它
  setCasesRootForTesting(join(dir, 'cases'));
  const config = loadConfig();
  const seeded: AppConfig = {
    ...config,
    settings: { ...config.settings, workspaceRoot: join(dir, 'ws'), casesRoot: join(dir, 'cases'), casesAutoCommit: false },
    providers: [openaiProvider, anthropicProvider],
  };
  saveConfig(seeded);
  // 用例按真实来路写：它是独立文件，不再随配置一起覆盖写
  writeCase(testCase);

  store = new Map();
  evaluator.saveRun.mockImplementation((run: EvalRun) => {
    store.set(run.id, run);
  });
  evaluator.getRun.mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
  // `listRunsView()` 会做 `[...listRuns()]`：不给实现就抛 TypeError，接口回 500（见文件头第 3 条）
  evaluator.listRuns.mockImplementation(() => [...store.values()]);
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

/** 建一轮真实的评测（走 POST 路由），返回它的快照 */
async function createRealRun(): Promise<EvalRun> {
  const res = await postRun(
    jsonRequest({
      caseId: 'c-1',
      executionMode: 'parallel',
      rows: [
        { agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' },
      ],
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as EvalRun;
}

describe('GET /api/runs', () => {
  it('返回按创建时间倒序的列表', async () => {
    // 先真实创建两轮拿到完整快照，再清空 store 换成受控的 createdAt：
    // POST 造出来的行带本机当前时刻，不清掉就会排在用例写死的时间之前（见文件头第 4 条）
    const first = await createRealRun();
    const second = await createRealRun();
    store.clear();
    store.set('old', { ...first, id: 'old', createdAt: '2026-09-22T08:00:00.000Z' });
    store.set('new', { ...second, id: 'new', createdAt: '2026-09-22T09:00:00.000Z' });

    const res = await getRuns();
    const body = (await res.json()) as EvalRun[];

    expect(res.status).toBe(200);
    expect(body.map((run) => run.id)).toEqual(['new', 'old']);
  });
});

describe('POST /api/runs', () => {
  it('合法请求返回 201 与落库后的快照（供应商名与 baseUrl 已快照）', async () => {
    const run = await createRealRun();

    expect(run.status).toBe('idle');
    expect(run.rows[0]?.providerName).toBe('Anthropic 网关');
    expect(run.rows[0]?.baseUrl).toBe('https://gw.example.com/anthropic');
    // 落的是磁盘（假的 store），不是内存里的临时对象
    expect(store.get(run.id)?.rows).toHaveLength(2);
  });

  /**
   * POST 路由把 `useAgentJudge` 真的交给了服务端。
   *
   * 这一条钉的**不是**「服务端能用它」，而是「它没在解析那一层被丢掉」：zod 3 的 `z.object`
   * 对**未声明**的键是**静默丢弃**（不是拒绝）。丢掉的表现极难发现——POST 仍然 201、
   * 界面照样显示「正在用智能体评分」，两边都不报错，只是这一轮悄悄用了模型评分。
   * 所以断言落库快照上的那一格，而不是 HTTP 状态码。
   */
  it('POST /api/runs 把 useAgentJudge 真的交给了服务端（zod 默认 strip 未知键，漏声明就是静默丢弃）', async () => {
    const response = await postRun(
      jsonRequest({
        caseId: testCase.id,
        executionMode: 'parallel',
        useAgentJudge: true,
        rows: [{ agentKind: 'codex', providerId: openaiProvider.id, modelId: 'gpt-5' }],
      }),
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as EvalRun;
    expect(created.useAgentJudge).toBe(true);
  });

  it('请求体缺字段时 400，且 context 是真 zod 的 issues', async () => {
    const res = await postRun(jsonRequest({ caseId: 'c-1' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.context.map((issue: { path: string[] }) => issue.path[0])).toContain('executionMode');
  });

  it('一行都没有时 400（RunCreateSchema 的 min(1)）', async () => {
    const res = await postRun(jsonRequest({ caseId: 'c-1', executionMode: 'parallel', rows: [] }));

    expect(res.status).toBe(400);
  });

  it('供应商不存在 → 404 中文原因', async () => {
    const res = await postRun(
      jsonRequest({
        caseId: 'c-1',
        executionMode: 'parallel',
        rows: [{ agentKind: 'claude-code', providerId: 'p-gone', modelId: 'claude-opus-4-6' }],
      }),
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain('p-gone');
  });

  it('协议不匹配 → 409（Claude Code 不能被 openai 供应商驱动）', async () => {
    const res = await postRun(
      jsonRequest({
        caseId: 'c-1',
        executionMode: 'parallel',
        rows: [{ agentKind: 'claude-code', providerId: 'p-openai', modelId: 'gpt-5' }],
      }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('OpenAI 兼容');
  });
});

describe('GET /api/runs/[runId]', () => {
  it('存在返回 200，不存在返回 404', async () => {
    const run = await createRealRun();

    const ok = await getRun(new Request('http://localhost/api/runs/x'), { params: Promise.resolve({ runId: run.id }) });
    expect(ok.status).toBe(200);

    const missing = await getRun(new Request('http://localhost/api/runs/x'), { params: Promise.resolve({ runId: 'nope' }) });
    expect(missing.status).toBe(404);
  });

  it('形状不对 runId 原样交给 api 层：路由里**没有**第二份形状校验', async () => {
    // 判据的唯一位置是 evaluator/run-store.ts 的入口（`assertRunId` → INVALID_QUERY），
    // 本文件把 evaluator 整块 mock 掉了，所以这里能验的不是「400 还是 404」，而是**路由的职责边界**：
    // 脏 id 必须原样落到 api 入口。一旦有人在这条路由里补上第二份形状校验（提前返回 400/404），
    // api 入口就不会被调用——两份判据必然漂移，而漂移时先抛的那一份说了算。
    evaluator.getRun.mockClear();

    await getRun(new Request('http://localhost/api/runs/x'), { params: Promise.resolve({ runId: '..' }) });

    expect(evaluator.getRun).toHaveBeenCalledWith('..');
  });
});

describe('POST /api/runs/[runId]/start', () => {
  it('有可执行行时交给编排层', async () => {
    const run = await createRealRun();
    evaluator.startRun.mockReturnValue({ ...run, status: 'running' });

    const res = await post(postStart, { runId: run.id });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('running');
  });

  it('全部已评分 → 409，且不调用编排层', async () => {
    const run = await createRealRun();
    store.set(run.id, { ...run, rows: run.rows.map((row) => ({ ...row, status: 'judged' as const })) });
    evaluator.startRun.mockClear();

    const res = await post(postStart, { runId: run.id });

    expect(res.status).toBe(409);
    expect(evaluator.startRun).not.toHaveBeenCalled();
  });
});

describe('POST /api/runs/[runId]/abort 与单行 abort', () => {
  it('整轮终止走编排层；未知轮 → 404', async () => {
    const run = await createRealRun();
    evaluator.abortRun.mockReturnValue({ ...run, status: 'partial' });

    expect((await post(postAbortRun, { runId: run.id })).status).toBe(200);
    expect((await post(postAbortRun, { runId: 'nope' })).status).toBe(404);
  });

  it('单行终止：行不存在 → 404（脏 URL 不能真的去杀别人）', async () => {
    const run = await createRealRun();
    evaluator.abortRow.mockReturnValue({ ...run, status: 'partial' });

    expect((await post(postAbortRow, { runId: run.id, rowId: run.rows[0]?.id ?? '' })).status).toBe(200);
    expect((await post(postAbortRow, { runId: run.id, rowId: 'r-x' })).status).toBe(404);
  });
});

/**
 * 行级重新评分路由。
 *
 * 这一条钉的是**传输链**：路由把 `params` 里两个 id 原样交给 `@aieval/api`，再把它的返回值
 * 作为 JSON 回出去。可重评的判据不在这里（它是 contracts 的 `canRescoreRow` + 编排层的
 * `rescoreRefusal`），故这里只验「转到了、回的是快照」——与单行 abort 同一套写法。
 */
describe('POST /api/runs/[runId]/rows/[rowId]/rescore', () => {
  it('转发到服务层并回快照，两个 id 都按 URL 里的那一个原样传下去', async () => {
    const run = await createRealRun();
    const rowId = run.rows[0]?.id ?? '';
    evaluator.rescoreRow.mockReturnValue({ ...run, status: 'running' });

    const res = await post(postRescore, { runId: run.id, rowId });

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(run.id);
    expect(evaluator.rescoreRow).toHaveBeenCalledWith(run.id, rowId);
  });
});

/**
 * 单行**重新执行**路由（引入，界面文案 晚间起是「重新执行」，
 * 路由与 api 名保持 `retry`）：与 rescore 逐字同形的传输链守卫。
 * 判据（`canRetryRow`）与服务端拒绝原因都不在这里，这里只验「两个 id 原样转下去、回的是快照」。
 */
describe('POST /api/runs/[runId]/rows/[rowId]/retry', () => {
  it('转发到服务层并回快照，两个 id 都按 URL 里的那一个原样传下去', async () => {
    const run = await createRealRun();
    const rowId = run.rows[0]?.id ?? '';
    evaluator.retryRow.mockReturnValue({ ...run, status: 'running' });

    const res = await post(postRetry, { runId: run.id, rowId });

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(run.id);
    expect(evaluator.retryRow).toHaveBeenCalledWith(run.id, rowId);
  });
});

describe('GET /api/runs/model-options', () => {
  it('按协议过滤候选池，并带上三种智能体的能力元数据', async () => {
    const res = await getModelOptions();
    const groups = (await res.json()) as Array<Record<string, unknown>>;

    expect(res.status).toBe(200);
    expect(groups.map((group) => group.agentKind)).toEqual(['claude-code', 'codex', 'dsh']);
    // 键集合钉死：两侧（api / client）各声明过一次这个形状，谁偷偷加字段都会在这里失败。
    // `efforts`（思考强度的档位域）是有意加的第六格。
    // `messageCapability`（消息能力声明）是 ****api 加的第七格——
    // 当时这处期望值没跟着补，于是它一直红到 收尾 fix 轮才补齐（本次顺手修，不是本线引入的格）。
    // `defaultEffort`（未选档位时该家实际会用的档）是 ****加的第八格：界面拿它拼
    // 创建表单的占位符，「未指定（DeepSeek Harness 用 high）」里的厂商名与档位都由它 + `AGENT_LABELS`
    // 拼出来（此前那句写死在 UI 里，且写的是 kind 缩写 `dsh`）。
    // ⚠️ 这一格按「有意义才出现」投影（与 `options` 里那三格同一条规则）⇒ 必须**两侧都钉**：
    // 只钉 DSH 一侧的话，把投影改成「恒写这一格（不声明时写 undefined）」照样绿——而那一改会让
    // claude / codex 的响应里多出一个恒为 `undefined` 的键，且 `JSON.stringify` 又会把它丢掉，
    // 于是「有没有声明」这件事在两条通道上长得不一样。
    expect(Object.keys(groups[0] ?? {}).sort()).toEqual([
      'agentKind',
      'cancelMidTurn',
      'efforts',
      'messageCapability',
      'options',
      'protocolTypes',
      'usage',
    ]);
    const dsh = groups.find((group) => group.agentKind === 'dsh') as Record<string, unknown>;
    expect(Object.keys(dsh).sort()).toEqual([
      'agentKind',
      'cancelMidTurn',
      'defaultEffort',
      'efforts',
      'messageCapability',
      'options',
      'protocolTypes',
      'usage',
    ]);
    // 值是注册表真值（今天只有 DSH 声明它），且 claude-code 那一组**没有这一格**（不是空串 / undefined）
    expect(dsh.defaultEffort).toBe('high');
    expect('defaultEffort' in (groups[0] ?? {})).toBe(false);

    const claude = groups.find((group) => group.agentKind === 'claude-code') as { options: Array<{ modelId: string }> };
    const codex = groups.find((group) => group.agentKind === 'codex') as { options: Array<{ modelId: string }> };
    expect(claude.options.map((option) => option.modelId)).toEqual(['claude-opus-4-6']);
    expect(codex.options.map((option) => option.modelId)).toEqual(['gpt-5']);
    // DSH 的 cancelMidTurn 是 false（界面文案要跟着变）
    expect((groups.find((group) => group.agentKind === 'dsh') as { cancelMidTurn: boolean }).cancelMidTurn).toBe(false);
  });

  /**
   * `options[]` 的**键集合**：接缝的另一半。
   *
   * 为什么必须有这一条：api 的 `AgentModelOption` 与 client 的同名接口是**两处手写的同一份形状**
   * （client 不能 import api），而类型上「可选属性缺失」**天然可赋值** ⇒ client 少写三格
   * （`contextWindow` / `efforts` / `recommendedEffort`，正是这次补上的）tsc 一个字都不报；
   * 症状是界面静默丢掉那一格——面板读的 `efforts` 一丢，「思考强度」下拉就永远是空的。
   * 这一组按 api 的投影规则用两种模型各钉一条：
   * · 上游**没声明**档位 ⇒ 没有 `contextWindow` / `recommendedEffort` 这两格（只有 `efforts`）；
   * · 上游**声明过**档位与推荐档 + 有窗口 ⇒ 三格都在。
   */
  it('options 的键集合按「有意义才出现」钉住：声明的三格才出现，没声明的只有 efforts', async () => {
    const bare = { id: 'claude-opus-4-6', source: 'manual' as const };
    const declared = {
      id: 'declared',
      source: 'manual' as const,
      contextWindow: 200_000,
      supportedEfforts: ['low', 'high'],
      recommendedEffort: 'high',
    };
    saveConfig({ ...loadConfig(), providers: [{ ...anthropicProvider, models: [bare, declared] }] });

    const res = await getModelOptions();
    const groups = (await res.json()) as Array<{ agentKind: string; options: Array<Record<string, unknown>> }>;
    const claude = groups.find((group) => group.agentKind === 'claude-code');
    const [undeclared, withEfforts] = claude?.options ?? [];

    // 未声明：只有五格（`efforts` 是「该家完整档位域」，与上游声明与否无关 ⇒ 它恒在）
    expect(Object.keys(undeclared ?? {}).sort()).toEqual([
      'efforts',
      'modelId',
      'providerId',
      'providerName',
      'source',
    ]);
    // 声明过：窗口与推荐档这两格才出现（推荐档只在它落在候选里时才有值）
    expect(Object.keys(withEfforts ?? {}).sort()).toEqual([
      'contextWindow',
      'efforts',
      'modelId',
      'providerId',
      'providerName',
      'recommendedEffort',
      'source',
    ]);
    // 键集合之外再钉一次值（少了它，两个空对象也能让上面两条通过）：
    // 未声明 ⇒ 首项仍是关闭档（该家完整档位域）；声明过 ⇒ 交集 ∪ 关闭档
    expect(undeclared?.efforts).toContain(EFFORT_OFF);
    expect(withEfforts?.efforts).toEqual([EFFORT_OFF, 'low', 'high']);
  });

  it('DSH 的三项元数据按新口径透传（协议集合 / usage true / 不可中途取消）', async () => {
    const res = await getModelOptions();
    const groups = (await res.json()) as Array<{
      agentKind: string;
      protocolTypes: string[];
      usage: boolean;
      cancelMidTurn: boolean;
      options: Array<{ modelId: string }>;
    }>;
    const dsh = groups.find((group) => group.agentKind === 'dsh');

    // DSH 两条 wire 都能收（收口） ⇒ 两个元素；这条同时钉住「投影不许把集合拍平回单值」
    expect(dsh?.protocolTypes).toEqual(['openai', 'anthropic']);
    expect(dsh?.usage).toBe(true);
    expect(dsh?.cancelMidTurn).toBe(false);
    // 投影的判据来自注册表元数据：**两类协议**的供应商都该出现在这一组里（顺序 = 供应商清单顺序）
    expect(dsh?.options.map((option) => option.modelId)).toEqual(['gpt-5', 'claude-opus-4-6']);
  });
});

/**
 * `PUT /api/runs/[runId]`（编辑）与 `DELETE`（删除）：这一层钉的是**传输链**——
 * zod 有没有把 `rows[].id` 解析掉、两个 id 有没有按 URL 原样交给 api、错误有没有映射成中文。
 * 「哪一行被重置」是 api / contracts 的判据，不在本文件的职责里（mock 掉了 evaluator）。
 *
 * 三条失败路径都断言**错误码映射出来的 HTTP 状态**（400 / 404 / 409）：路由的第三件事就是
 * 这张映射表，只断 message 的话，「404 是从 NOT_FOUND 来的」与「是从别处漏出来的」分不开。
 */
describe('PUT /api/runs/[runId]', () => {
  it('把 rows[].id 真的交给了服务端（zod 默认 strip 未知键，漏声明就是静默当新行）', async () => {
    const run = await createRealRun();
    const rowId = run.rows[0]?.id ?? '';
    // 编排层被 mock，故这里断言的是「api 层收到了带 id 的那一行」——用 saveRun 的落盘物反向核对
    store.set(run.id, run);

    const res = await putRun(jsonRequest({ caseId: 'c-1', executionMode: 'serial', rows: [{ id: rowId, agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }] }), {
      params: Promise.resolve({ runId: run.id }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as EvalRun;
    expect(body.executionMode).toBe('serial');
    // 行 id 原样保留 = 「原地更新这一行」这条语义真的走到了 api
    expect(body.rows.map((row) => row.id)).toEqual([rowId]);
    expect(store.get(run.id)?.executionMode).toBe('serial');
  });

  it('rows 为空的请求体 → 400（RunUpdateSchema 的 min(1)）', async () => {
    const run = await createRealRun();
    const res = await putRun(jsonRequest({ caseId: 'c-1', executionMode: 'serial', rows: [] }), {
      params: Promise.resolve({ runId: run.id }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_QUERY');
  });

  it('未知的行 id → 404，且带出那个 id（不许静默当新行）', async () => {
    const run = await createRealRun();
    const res = await putRun(
      jsonRequest({ caseId: 'c-1', executionMode: 'serial', rows: [{ id: 'r-404', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }] }),
      { params: Promise.resolve({ runId: run.id }) },
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('r-404');
  });

  it('运行中的轮次 → 409', async () => {
    const run = await createRealRun();
    store.set(run.id, { ...run, status: 'running' });
    const res = await putRun(
      jsonRequest({ caseId: 'c-1', executionMode: 'serial', rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }] }),
      { params: Promise.resolve({ runId: run.id }) },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CONFLICT');
  });
});

describe('DELETE /api/runs/[runId]', () => {
  it('转给 api 层并把 workspaceRemoved 原样回出去', async () => {
    const run = await createRealRun();
    evaluator.deleteRun.mockReturnValue({ workspaceRemoved: false });

    const res = await deleteRunRoute(new Request('http://localhost/api/runs/x', { method: 'DELETE' }), {
      params: Promise.resolve({ runId: run.id }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceRemoved: false });
    expect(evaluator.deleteRun).toHaveBeenCalledWith(run.id);
  });

  it('不存在的轮次 → 404', async () => {
    const res = await deleteRunRoute(new Request('http://localhost/api/runs/x', { method: 'DELETE' }), {
      params: Promise.resolve({ runId: 'nope' }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/runs/events（run 级信号 SSE）', () => {
  // 本文件不读完整响应体之外的东西：帧内容与心跳由 api 包的 run-events.test.ts 钉死，
  // 这里只钉**路由层**的三件事——段配置、响应头、以及「mock 的总线推一条 ⇒ 流里出一帧」的接驳。

  it('段配置：runtime = nodejs（进程内信号总线）+ force-dynamic（长连接不当静态资源）', () => {
    expect(runEventsRuntime).toBe('nodejs');
    expect(runEventsDynamic).toBe('force-dynamic');
  });

  it('响应头是 SSE 的全套（含给反代的 X-Accel-Buffering: no）', async () => {
    const res = await getRunEvents();
    // 读完就关：这条流没有「自然结束」（不因终态关流），挂着不取消会把心跳定时器漏给后面的用例
    await res.body?.cancel();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
  });

  it('ready 注释帧先行；mock 总线推一条信号 ⇒ 流里出一帧 run-updated（接驳完整）', async () => {
    // 用数组承接监听器而不是闭包变量：TS 的控制流分析不追踪闭包里的赋值，
    // `let publish = null` 在赋值之后仍被收窄成 null，调用处就成了 never
    const handlers: Array<(runId: string) => void> = [];
    evaluator.subscribeRunChanges.mockImplementation((listener: (runId: string) => void) => {
      handlers.push(listener);
      return () => {};
    });

    const res = await getRunEvents();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // 打开即有首字节（ready 注释帧）：响应头要等第一次 enqueue 才 flush
    expect(decoder.decode((await reader.read()).value)).toBe(': ready\n\n');

    handlers[0]?.('run-1');
    expect(decoder.decode((await reader.read()).value)).toBe('event: run-updated\ndata: {"runId":"run-1"}\n\n');

    await reader.cancel();
  });
});
