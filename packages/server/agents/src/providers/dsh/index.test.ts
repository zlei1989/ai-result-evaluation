// @vitest-environment node
/**
 * dsh 适配器：环境变量注入（保留尾部 /v1 + 显式 API key）、终止必然走第二段（5 秒 → WARN → 关闭运行时）、
 * 实测回写后的用量提取、加载降级。
 * dsh 是「非合作适配器」的真实样本：cancelMidTurn 为 false、interrupt() 是刻意空实现，所以它的终止
 * 路径 100% 会经过 §5.6.5 的第二段——这条用例同时是那段兜底逻辑的真实性证明。
 * 「在途通知消费被终结」这一格在 dsh 上是**可达且可钉**的：真实 `NotificationSubscription.close()`
 * 会 reject 挂起的等待者（见夹具 `createFakeDshSdk` 的 JSDoc），所以这里连 `recorder.order` 一起钉住，
 * 而不是像 codex 那样只登记能力边界。
 * 事件构造数据一律照 `probe/dumps/dsh.json` 的真实外形：`{ method:'session.event', params:{ event } }`。
 * 收尾轮（Task 11 真机端到端登记的去重缺陷）：**一轮恰好一条 `usage`**，以及「两轮各一条、tokens 是当轮的量」。
 */
import { EFFORT_OFF, type AgentEvent } from '@aieval/contracts';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_GRACE_MS } from '../../release';
import { setAgentRuntimeForTesting } from '../../runtime';
import type { AgentRunResult } from '../../types';
import {
  collectEvents,
  createFakeDshSdk,
  createRecorder,
  createRunInput,
  createTurnState,
  DSH_SESSION_PLACEHOLDER,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import {
  DSH_ASSISTANT_MESSAGE_TYPE,
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_SUBAGENT_STARTED_METHOD,
  DSH_TURN_END_TYPE,
  projectDshNotification,
} from './events';
import {
  DSH_DEFAULT_EFFORT,
  DSH_INITIALIZE_TIMEOUT_MS,
  DSH_LEGACY_PROFILE_PATCH_RELATIVE_PATH,
  DSH_ROUTE_API_KEY_ENV,
  DSH_ROUTE_KEY,
  DSH_ROUTE_PATCH_RELATIVE_PATH,
  acceptsRunNotification,
  buildDshRoutePatch,
  dshProvider,
} from './index';
import { resetDshMessageStateForTesting } from './message';
import { DSH_PACKAGE_NAME } from './sdk';
import { removeTreeWithRetry } from '../../testing/cleanup';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
});

/**
 * **放行判据：会话树，不是同一个会话**（2026-10-03 用户口径：「dsh 展示的不对」）。
 *
 * 缺陷形状：子智能体的会话事件**在同一条通知流里**，而 `params.sessionId` 是**子会话自己的 id**
 * （真机探针：主会话 `session-e8c4…`、子会话 `7be765b2-…`）。原来的判据「认领第一个带
 * `sessionId` 的通知、之后只放行同一个 id」把子会话的事件**全部丢掉** ⇒ 抽屉里子任务占位条在、
 * 点进去一个字都没有（真机：一整轮跑完，落盘文件里只出现过主会话一个 id）。
 */
describe('dsh 通知流的放行判据（会话树）', () => {
  const OWN = 'session-e8c4db43b9ef4c8388150679889fb072';
  const CHILD = '7be765b2-72af-4148-9953-ef7d3141c361';

  it('本会话的事件放行；别的会话（还没认出是子会话）不放行', () => {
    const children = new Set<string>();
    expect(acceptsRunNotification({ method: 'session.event', params: { sessionId: OWN } }, OWN, children)).toBe(true);
    // 认成「别的行」⇒ 不放行：同一个 harness 实例在多行之间共享，混进来比丢几条更难查
    expect(acceptsRunNotification({ method: 'session.event', params: { sessionId: 'someone-else' } }, OWN, children)).toBe(
      false,
    );
  });

  it('**子会话的事件放行**（这正是原来丢掉的那一批）', () => {
    const children = new Set([CHILD]);
    expect(acceptsRunNotification({ method: 'session.event', params: { sessionId: CHILD } }, OWN, children)).toBe(true);
  });

  it('不带会话归属的顶层通知（`subagent.started` / `finished`）一律放行——它是子会话 id 的唯一来源', () => {
    const children = new Set<string>();
    expect(
      acceptsRunNotification({ method: 'subagent.started', params: { subagentId: CHILD, parentSessionId: OWN } }, OWN, children),
    ).toBe(true);
    expect(
      acceptsRunNotification({ method: 'subagent.finished', params: { subagentId: CHILD, parentSessionId: OWN } }, OWN, children),
    ).toBe(true);
  });
});

/**
 * 造一条真实的会话事件通知（外形照 dump）。
 * `sessionId` 缺省是**占位** id：夹具会把占位 id（以及没带 id 的通知）的会话归属对齐到本次 run 的
 * 会话 id；给了**真实存在的另一个会话** id（如子会话）时夹具**照原样保留**——真机形状就是那样
 * （主会话与子会话的通知在同一条流里，靠 `params.sessionId` 区分，见 `agent-fixtures.ts` 的 `tagSession`）。
 */
function sessionEvent(type: string, data: unknown, sessionId = DSH_SESSION_PLACEHOLDER): unknown {
  return { method: 'session.event', params: { sessionId, event: { type, seq: 1, time: 1, data } } };
}

/** 只取 usage 事件（判别联合的窄化辅助）：计数与取值都走它，免得每处各写一遍 filter */
function usageEvents(events: readonly AgentEvent[]): Array<Extract<AgentEvent, { type: 'usage' }>> {
  return events.filter((event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage');
}

const USAGE_EVENT = sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
  turn: 1,
  step: 1,
  usage: { inputTokens: 218, cacheReadTokens: 8832, outputTokens: 2 },
});
const TURN_END_EVENT = sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } });
/** 一次模型 API 往返的落点（轮次就是数它，见 events.ts 的文件头） */
const STEP_START_EVENT = sessionEvent('step/start', { turn: 1, step: 1 });

describe('dshProvider', () => {
  it('注入落点：路由键 + 绝对路径的 overlay + **自定义变量名**带凭据；DSH_HOME/HOME 都指向该行目录', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    await dshProvider.run(
      createRunInput({
        route: {
          protocolType: 'anthropic',
          baseUrl: 'https://gw.example.com/deepseek/v1/',
          apiKey: 'sk-dsh',
          modelId: 'deepseek-x',
        },
      }),
    );
    // 凭据走**我们自己的变量名**（overlay 里 `apiKeyEnv` 逐字引用它），不再用 DEEPSEEK_API_KEY
    expect(recorder.env?.[DSH_ROUTE_API_KEY_ENV]).toBe('sk-dsh');
    expect(recorder.env?.DSH_HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.env?.HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.options?.dshHome).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.options?.model).toBe('deepseek-x');
    expect(recorder.options?.cwd).toBe('D:/tmp/rows/row-1/workspace');
    expect(recorder.options?.processCwd).toBe('D:/tmp/rows/row-1/workspace');
    // 路由：`provider` 必须是 overlay 里声明的那个键（三者不同源就会在 initialize 阶段报 no adapter）
    expect(recorder.options?.provider).toBe(DSH_ROUTE_KEY);
    // overlay 路径必须是**绝对路径**：SDK 用 `resolve(callerCwd, path)` 解析，而 callerCwd 是宿主进程的
    // cwd ⇒ 相对路径会让文件落到别处（甚至不在本行的 .agenthome 里）
    const patches = recorder.options?.patches as string[] | undefined;
    expect(patches).toHaveLength(1);
    expect(isAbsolute(patches?.[0] ?? '')).toBe(true);
    expect(patches?.[0]).toBe(join('D:/tmp/rows/row-1/.agenthome', DSH_ROUTE_PATCH_RELATIVE_PATH));
    expect(recorder.prompt).toBe('把 README 的标题改成「示例项目」，然后结束。');
  });

  /**
   * 退役旧凭据通道（计划 D6a）：**显式删除**，而不是「不再注入」。
   *
   * 为什么必须单独一条：`buildSubprocessEnv` 以**宿主环境为底**展开，而开发机上 `DEEPSEEK_API_KEY`
   * 很常见。只「不再注入」的实现会让宿主的密钥被子进程继承，于是那条已无人配置的
   * `deepseek-official` 路由静默可用（安装态 0.1.7 的 llm-deepseek 账号 token 优先于 API key）
   * ⇒ 悄悄跑到公网并计费；`web_search` 也会拿它去打搜索接口。
   * 变异体 M13b「只是不再注入、不写 undefined」只有这条用例能杀——其余用例在那种实现下全绿。
   */
  it('宿主环境里的 DEEPSEEK_* 必须被显式删除，而不是「不再注入」（D6a）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    process.env.DEEPSEEK_API_KEY = 'host-leak';
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
    try {
      await dshProvider.run(createRunInput());
      expect(recorder.env?.DEEPSEEK_API_KEY).toBeUndefined();
      expect(recorder.env?.DEEPSEEK_BASE_URL).toBeUndefined();
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.DEEPSEEK_BASE_URL;
    }
  });

  /**
   * 冷启动握手预算（Task 9 真机发现的缺陷，2026-09-30）。
   *
   * 为什么这条必须存在：SDK 的 `initializeTimeoutMs` 默认 **10s**（`launch.d.ts` 的
   * `DEFAULT_INITIALIZE_TIMEOUT_MS = 10000`），而本适配器每次都跑在**全新的 `configHome`** 上
   *（§5.6.4 不变量 3）⇒ 每次都是冷启动。实测：默认值下两条协议**双双**
   * `initialize timed out after 10000ms waiting for dsh profile "sdk"`，被折成 `AGENT_FAILED`，
   * 界面上只看到「这一行失败了」。变异体验证：删掉 `startDsh` 里这一行 ⇒ 本用例变红（`undefined`）。
   */
  it('冷启动握手预算显式给足：不吃 SDK 的 10s 默认值（Task 9 真机缺陷）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    await dshProvider.run(createRunInput());
    expect(recorder.options?.initializeTimeoutMs).toBe(DSH_INITIALIZE_TIMEOUT_MS);
    // 真机冷启动在 10s 上下（实测两次超时），30s 是「明显更宽」的下界而不是拍脑袋的精确值
    expect(DSH_INITIALIZE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('执行阶段的权限档：DSH_PERMISSION_MODE=danger-full-access 进子进程环境', async () => {
    // 为什么必须显式给：不设它时 dsh 自己回落到 `workspace-write`（`dsh-base/cordis.patch.yml` 的
    // `sandbox-policy` 行逐字：`process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`）——
    // p6 冒烟实测到的启动形状正是那一档，而它的 approval 是 `ask`：越界操作会挂在无人应答的批准上。
    // 同一个变量在 `danger-full-access` 下顺带把 approval 设成 `never`（同一份 yml 的 `approval` 行），
    // 所以「全权限」在 dsh 上就是这一个变量，不需要第二个开关。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    await dshProvider.run(createRunInput({ permission: 'full' }));
    expect(recorder.env?.DSH_PERMISSION_MODE).toBe('danger-full-access');
  });

  it('评分阶段的权限档：DSH_PERMISSION_MODE=read-only（工作区只读）', async () => {
    // 这一格就是「评审者改不了候选的产出」在 dsh 上的执行层落点：提示词里的「只读评审」只是要求，
    // 而 dsh 的三档预设里只有 read-only / workspace-write / danger-full-access 三个值，
    // 写错一个词（例如 `readonly`）不会报错——它会静默回落到 workspace-write（那是可写的）。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    await dshProvider.run(createRunInput({ permission: 'read-only' }));
    expect(recorder.env?.DSH_PERMISSION_MODE).toBe('read-only');
  });

  it('收到 outputSchema ⇒ 报中文错且**不构造运行时**（纵深防御：悄悄忽略才是缺陷）', async () => {
    // 第二道防线（第一道在编排层：它按注册表能力决定不传这个字段）。协议来自公开类型 `AgentRunInput`：
    // 谁都能构造一条带 `outputSchema` 的输入喂给 dsh，而 dsh 的 SDK 客户端没有 schema 入参 ⇒
    // 悄悄忽略会让调用方以为「已经强约束」，实际什么都没发生——那正是本仓最忌讳的「看起来做到了」。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });

    // 注意**不能**用 `.catch()` 取错误：守卫在 `startDsh` 里，而骨架承诺「永不抛」，
    // 它把 start 抛出的异常折进结果（`turn.ts` 的 `catch (cause)`）——所以错误在 `result.error` 上。
    const result = await dshProvider.run(createRunInput({ outputSchema: { type: 'object' } }));

    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('error');
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('不支持结构化输出');
    // `recorder.options` 是 `new DeepSeekHarness(options)` 的记录点（夹具 `agent-fixtures.ts:526`）：null = 构造函数
    // 一次都没被调用。这比「没 spawn」更直接：连厂商 SDK 都不该被加载（守卫在 `loadDshSdk()` 之前）。
    expect(recorder.options).toBeNull();
    expect(recorder.prompt).toBeNull(); // 没进到交提示词那一步
    expect(recorder.closeCount).toBe(0); // 没有「被关闭的对象」就不该有任何关闭动作
  });

  it('outputSchema 显式为 null ⇒ 与「没给」同义：不报错，按「不支持结构化输出」正常跑完', async () => {
    // 空值口径与 codex（Task 4）逐字统一：判据是「既非 undefined 也非 null 才拦」。
    // `null` 在这条路径上与「没给」同义——它表达的是「这一格没有值」，不是「要一份 schema」；
    // 三个适配器不能各写一套口径（Task 3 在出口侧、Task 4 在入口侧都封过「假值被当成有效值」那一族）。
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });

    const result = await dshProvider.run(
      createRunInput({
        outputSchema: null as unknown as Record<string, unknown>,
        onEvent: collectEvents(events),
      }),
    );

    expect(result).toMatchObject({ ok: true, exitReason: 'completed', tokens: null, turns: null });
    expect(recorder.options).not.toBeNull(); // 运行时照常构造（dsh 的行为与今天一致）
    expect(recorder.closeCount).toBe(1); // 正常出口照常释放
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('端到端：轮次在 `step/start` 就涨（不等模型回答），计量一到补一条，收尾不重复发', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          // 真实序列（探测 dump）：turn/start → step/start → assistant/message → step/end → turn/end
          events: [STEP_START_EVENT, USAGE_EVENT, TURN_END_EVENT],
        }),
      },
    });
    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({
      ok: true,
      exitReason: 'completed',
      tokens: { input: 218, cached: 8832, output: 2, reasoningOutput: null, total: null },
      turns: 1,
    });
    const usages = usageEvents(events);
    // 两条，内容各不相同：① `step/start` 时轮次就涨（此刻还没有用量 ⇒ tokens 为 null）；
    // ② `assistant/message` 的用量一到，补一条把 tok 带上。
    // 收尾的 `turn/end` 交出的是**同一对值** ⇒ 被骨架去重掉（这正是「同一轮只有一条收尾信号」的守卫：
    // Task 11 的真机端到端实测到过同一轮两条内容相同的 usage）。
    expect(usages.map((event) => [event.turns, event.tokens])).toEqual([
      [1, null],
      [1, { input: 218, cached: 8832, output: 2, reasoningOutput: null, total: null }],
    ]);
    /**
     * 时间格（2026-10-XX）：dsh 只能拿**会话事件自己的 `time`**（`params.event.time`，epoch 毫秒），
     * 所以 `source: 'events'`、`apiMs` / `ttftMs` 是 `null`（这一家报不出首字延迟与纯 API 时长）。
     * 夹具里两条事件的 `time` 都是 1 ⇒ `totalMs: 0`——**这是夹具的取值，不是「没采到」**
     * （没采到时这一格是 `null`，见下一条用例）。
     */
    expect(usages[1]?.timing).toEqual({ totalMs: 0, apiMs: null, ttftMs: null, source: 'events' });
    expect(recorder.closeCount).toBe(1); // 正常出口也要释放
  });

  it('两个 step：轮次实时涨到 2，计量是**累计**值（不再是「当轮的量」）', async () => {
    // 2026-09-28 口径变化：事件里的 tokens 是「到目前为止」的累计（覆盖语义），
    // 所以第二个 step 交出的必须是两段之和。原来「取走即归零」的做法会让第二轮看起来**更便宜**。
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const usage = (step: number, input: number, cached: number, output: number): unknown =>
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step,
        usage: { inputTokens: input, cacheReadTokens: cached, outputTokens: output },
      });
    const stepStart = (step: number): unknown => sessionEvent('step/start', { turn: 1, step });
    const turnEnd = (turn: number): unknown =>
      sessionEvent(DSH_TURN_END_TYPE, { turn, reason: { kind: 'completed' } });
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [
            stepStart(1),
            usage(1, 218, 8832, 2),
            stepStart(2),
            usage(2, 100, 0, 7),
            turnEnd(1),
          ],
        }),
      },
    });
    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({
      ok: true,
      exitReason: 'completed',
      turns: 2,
      tokens: { input: 318, cached: 8832, output: 9, reasoningOutput: null, total: null },
    });
    const usages = usageEvents(events);
    expect(usages.map((event) => [event.turns, event.tokens])).toEqual([
      [1, null],
      [1, { input: 218, cached: 8832, output: 2, reasoningOutput: null, total: null }],
      // 第二个 step 一开始轮次就跳到 2（计量还是上一个 step 的累计）
      [2, { input: 218, cached: 8832, output: 2, reasoningOutput: null, total: null }],
      [2, { input: 318, cached: 8832, output: 9, reasoningOutput: null, total: null }],
    ]);
    // 收尾那条与前一条逐字段相同 ⇒ 不重复发（没有第五条）
    expect(usages).toHaveLength(4);
  });

  /**
   * 时间格的**缺数据路径**（2026-10-XX）：会话事件里没有 `time`（或不是数字）时，
   * `timing` 必须是 `null`（= 未采集），**不许**拿我们自己的 `at` 冒充厂商时间、
   * 也不许填一个 `totalMs: 0`（那会被读成「瞬间跑完」，与「没采到」含义相反）。
   */
  it('会话事件没有 time ⇒ timing 是 null（不拿我们自己的 at 冒充，也不填 0）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    // 把 `time` 整格去掉（不是设成 0）：真实缺字段的形状。`step/start` 在前——
    // 轮次的发射门槛要它，否则这条用量根本没有出口
    const withoutTime = {
      method: 'session.event',
      params: {
        sessionId: 'session-fake',
        event: {
          type: DSH_ASSISTANT_MESSAGE_TYPE,
          seq: 1,
          data: { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 1, outputTokens: 2 } },
        },
      },
    };
    setAgentRuntimeForTesting({
      sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [STEP_START_EVENT, withoutTime] }) },
    });
    await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    const usages = usageEvents(events);
    expect(usages.length).toBeGreaterThan(0);
    for (const event of usages) expect(event.timing).toBeNull();
  });

  it('失败的运行：turn/end(kind:error) ⇒ 结果 error，不是「界面显示成功、实际没干活」（评审 L2）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [
            sessionEvent(DSH_TURN_END_TYPE, {
              turn: 1,
              reason: { kind: 'error', error: { message: 'HTTP 401 unauthorized', code: 'TRANSPORT' } },
            }),
          ],
        }),
      },
    });
    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('error');
    expect(result.error?.code).toBe('AUTH_FAILED');
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('终止：interrupt 不被响应 → 5 秒后落 WARN → 关闭运行时恰好一次，结果为 canceled（Review Focus #3）', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [], hang: true }) },
    });
    const controller = new AbortController();
    const promise = dshProvider.run(createRunInput({ signal: controller.signal, onEvent: collectEvents(events) }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(result.exitReason).toBe('canceled');
    expect(result.error?.code).toBe('AGENT_CANCELED');
    // 先钉「可见信号」（§5.6.5：非合作的适配器必须可见，不能静默），再钉计数——
    // 与 codex 的同类用例同一顺序，也让「第二段没跑」这类变异体红在最有信息量的那条断言上
    const warn = events.find((event) => event.type === 'log' && event.text.includes('[WARN]'));
    expect(warn?.type === 'log' ? warn.text : '').toContain(`${RELEASE_GRACE_MS / 1000} 秒`);
    expect(recorder.closeCount).toBe(1); // dispose 幂等：终止与第二段只关一次
    // 关闭运行时让在途消费收场：真实订阅在 close 时 reject 挂起的等待者，
    // 适配器拿到的是「流结束」（它不依赖那次 reject 的类型，只依赖流终止）
    expect(recorder.order).toEqual(['start', 'dispose']);
  });

  it('运行中事件贯通：未识别通知进日志、结果 ok', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [sessionEvent('session/title', { title: '做完了' })],
        }),
      },
    });
    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({ ok: true, exitReason: 'completed', tokens: null, turns: null });
    expect(events.some((event) => event.type === 'log' && event.text.includes('做完了'))).toBe(true);
    expect(recorder.closeCount).toBe(1); // 正常出口也要释放
  });

  it('运行中未识别通知同样保留原始负载（§5.6.3：不得静默丢弃）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [sessionEvent('tool/result', { name: 'pwsh', ok: true })],
        }),
      },
    });
    await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs.some((text) => text.includes('tool/result') && text.includes('pwsh'))).toBe(true);
  });

  it('包已安装但导出面不匹配：AGENT_LOAD_FAILED，且文案**不含** `pnpm add`（评审 M1）', async () => {
    // 注入 `{}` = 「包装好了，但没有 DeepSeekHarness」——文案在这条分支上必须指向
    // 「适配器期望的入口 vs 实测导出面」，而不是让人去重装一个已装好的包
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: {} } });
    const first = await dshProvider.run(createRunInput());
    expect(first.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(first.error?.message).toContain(DSH_PACKAGE_NAME);
    expect(first.error?.message).not.toContain('pnpm add');
    expect(first.error?.message).toContain('已安装');
    expect(first.error?.message).toContain('不是安装问题');
    expect(first.error?.message).toContain('读不到任何导出');

    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    const second = await dshProvider.run(createRunInput());
    expect(second.ok).toBe(true);
  });

  it('形状不匹配的文案点名期望入口与**实测导出面**（拿错版本时能一眼看出装的是哪一支）', async () => {
    // 造一个「装了另一支入口」的模块：适配器现在期望的是 DeepSeekHarness（实测入口）
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: { HarnessClient: class {} } } });
    const result = await dshProvider.run(createRunInput());
    expect(result.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(result.error?.message).toContain('DeepSeekHarness'); // 期望的入口
    expect(result.error?.message).toContain('HarnessClient'); // 实测拿到的
  });

  it('握手失败：折进 AGENT_FAILED，run() 不抛，且没有「被关闭的对象」就不去关（评审 L1）', async () => {
    // 运行时起不来时，用户看到的是这一次运行的失败原因，而不是一个抛出去的异常。
    // 实测入口把「起不来」落在 `start()` 上（探测前落在 `createRuntime()` 上）
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [], startError: new Error('运行时起不来') }),
      },
    });
    const result = await dshProvider.run(createRunInput());
    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('error');
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('运行时起不来'); // 原文照传，保留排障线索
    expect(recorder.closeCount).toBe(0); // 从没建出运行时 ⇒ 不该有任何关闭动作
  });

  it('通知流运行中抛出：折进 AGENT_FAILED，且运行时**仍然被释放**（评审 L1：失败路径不泄漏）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [sessionEvent('session/title', { title: '半截' })],
          throwAfterEvents: new Error('传输中断'),
        }),
      },
    });
    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('error');
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('传输中断');
    expect(events.some((event) => event.type === 'error')).toBe(true); // 失败也要进该行的事件日志
    expect(recorder.closeCount).toBe(1); // 释放路径在失败出口上照样走完（dispose 恰好一次）
  });
});

/**
 * overlay 的**落点与内容**（计划 Task 5/6）：适配器在**运行时启动之前**把
 * `<configHome>/aieval-route.patch.yml` 写出来，那份文件同时承载路由、模型能力、档位与工具挂载。
 * 判据是**磁盘上的文件内容**——只看适配器内部算了什么，证明不了 dsh 读得到。
 *
 * 三个旧落点已退役：`settings.yaml`（旧版本迁移 shim）与 `profiles/sdk/cordis.patch.yml`
 * （dsh 自己的持久化层）都不再写；`DEEPSEEK_*` 也不再注入（见上面那条 D6a 用例）。
 */
describe('dsh 的 overlay 落点', () => {
  const ROUTE = {
    protocolType: 'anthropic' as const,
    baseUrl: 'https://gw.example.com/anthropic',
    apiKey: 'sk-test-key',
    modelId: 'GLM-5.3',
  };
  const overlayPath = (home: string): string => join(home, DSH_ROUTE_PATCH_RELATIVE_PATH);

  it('窗口与输出上限进 overlay 的 model 分节；未知 ⇒ **不写那个键**（文件照常在）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    try {
      const recorder = createRecorder();
      setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });

      await dshProvider.run(
        createRunInput({
          configHome: home,
          route: { ...ROUTE, contextWindow: 1_048_576, maxOutputTokens: 131_072 },
        }),
      );

      const written = readFileSync(overlayPath(home), 'utf8');
      expect(written).toContain('llm-pi-ai');
      expect(written).toContain('id: "GLM-5.3"');
      expect(written).toContain('contextWindow: 1048576');
      expect(written).toContain('maxTokens: 131072');

      // 第二次：窗口未知 ⇒ 整份重建后的 patch 里**没有那两个键**。
      // 语义与旧落点不同（旧的是「删文件」），所以判据也跟着换：文件一直在（它同时承载路由与工具挂载），
      // 未知的**格子**不出现——不写 0、不写 null、不兜底一个默认值。
      await dshProvider.run(createRunInput({ configHome: home, route: ROUTE }));

      const rebuilt = readFileSync(overlayPath(home), 'utf8');
      expect(rebuilt).not.toContain('contextWindow');
      expect(rebuilt).not.toContain('maxTokens');
      expect(rebuilt).toContain('llm-pi-ai');
    } finally {
      removeTreeWithRetry(home);
    }
  });

  it('没有输出上限时只写 contextWindow（不写 maxTokens 那个键）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    try {
      setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: createRecorder(), events: [] }) } });

      await dshProvider.run(createRunInput({ configHome: home, route: { ...ROUTE, contextWindow: 262_144 } }));

      const written = readFileSync(overlayPath(home), 'utf8');
      expect(written).toContain('contextWindow: 262144');
      expect(written).not.toContain('maxTokens');
    } finally {
      removeTreeWithRetry(home);
    }
  });

  /**
   * 模型名里带 `"` / `\` / `:` 时写出的 YAML 必须能**原样读回**（spec §6.3 的转义口径）。
   * 判据是往返逐字相等，而不是「文件里出现了某个字符串」——后者在转义写错时也可能成立。
   * 为什么这个坑是真的：网关的模型名里 `/` `-` `.` 是常态，`:` 也出现过（命名空间前缀），
   * 而裸写的 `id: a:b` 在 YAML 里是合法的「键值对」写法，读回来就不再是那个 id 了。
   */
  it('模型名含引号 / 反斜杠 / 冒号时，写出的 YAML 读回来逐字相等', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    const modelId = 'a"b\\c:d';
    try {
      setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: createRecorder(), events: [] }) } });

      await dshProvider.run(createRunInput({ configHome: home, route: { ...ROUTE, modelId, contextWindow: 8_192 } }));

      const written = readFileSync(overlayPath(home), 'utf8');
      const line = written.split('\n').find((entry) => entry.trimStart().startsWith('- id: "')) ?? '';
      const raw = line.slice(line.indexOf('id:') + 3).trim();
      // 两半判据都要：① 写出的标量**逐字**是转义后的形态（未转义的引号会让 YAML 歧义甚至非法）；
      // ② 反转义后与原 id 逐字相等（DSH 读回来的必须还是那一个模型）
      expect(raw).toBe('"a\\"b\\\\c:d"');
      const roundTripped =
        raw.startsWith('"') && raw.endsWith('"')
          ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
          : raw;
      expect(roundTripped).toBe(modelId);
    } finally {
      removeTreeWithRetry(home);
    }
  });
});

/**
 * 思考强度（spec §6.4 / D13；**2026-10-06 口径变更**：未选不再等于「不传」）。
 *
 * 为什么改：dsh 的「不传」实际是**显式关闭**（pi-ai 不写 reasoning 字段 ⇒ 落
 * `reasoning:{effort:'none'}`，见探测记录与 `sdk.ts` 的口径）。用户口径是「不能默认关闭，
 * 必须显式配置」⇒ 未选时由适配器给一个**会思考**的缺省档；关闭只能靠显式选 `off`。
 */
describe('dsh 的思考强度', () => {
  it('给了 effort ⇒ 原样带上；没给 ⇒ 用缺省档 high（不是「不传」）', async () => {
    const withEffort = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: withEffort, events: [] }) } });
    await dshProvider.run(createRunInput({ effort: 'max' }));
    expect(withEffort.options?.reasoningEffort).toBe('max');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: bare, events: [] }) } });
    await dshProvider.run(createRunInput());
    // 变更前这里是 `Object.hasOwn(...) === false`（「不传」）——那等于关闭
    expect(bare.options?.reasoningEffort).toBe(DSH_DEFAULT_EFFORT);
  });

  it('显式 off ⇒ 原样交给 harness（关闭由 harness 的 `off: null` 实现，适配器不特判）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    await dshProvider.run(createRunInput({ effort: 'off' }));
    expect(recorder.options?.reasoningEffort).toBe('off');
  });

  it('缺省档必须是「会思考」的档：在该家档位域里，且不是关闭档', () => {
    expect(dshProvider.metadata.reasoningEfforts).toContain(DSH_DEFAULT_EFFORT);
    expect(DSH_DEFAULT_EFFORT).not.toBe(EFFORT_OFF);
  });
});

/**
 * `ask_user_question` 的工具挂载（用户口径 2026-09-30）：
 * `@deepseek-ai/dsh-tool-ask-user` **已随 dsh 装好**，但 `dsh-base` 与 `dsh-sdk-app` 两个 bundle
 * 都**没有**把它装进 profile（只有 `dsh-web-app` 的 preset 有）⇒ 适配器必须补一行 insert。
 *
 * **落点已搬进 overlay**（计划 D3b）：`insert` 与路由同住一份 per-launch patch，而不是写
 * `profiles/sdk/cordis.patch.yml`——那是 dsh 自己的持久化层（Settings / config-editor 会写它），
 * 适配器整份重写它会让两份来源混在一个文件里。
 *
 * 判据是磁盘上的文件内容：只看适配器内部算了什么，证明不了 dsh 读得到。
 * 实测依据：`dsh --profile sdk --patch <overlay> --dump-config` 下 `tool-ask-user` 由 0 处变 2 处、
 * 无 patch 告警（探测报告 §1），且**不需要**改 profile 的 `dependencies`（dsh 从自身安装解析插件）。
 */
describe('dsh 的 ask_user_question 挂载', () => {
  const ROUTE = {
    protocolType: 'anthropic' as const,
    baseUrl: 'https://gw.example.com/anthropic',
    apiKey: 'sk-test-key',
    modelId: 'GLM-5.3',
  };
  const overlayPath = (home: string): string => join(home, DSH_ROUTE_PATCH_RELATIVE_PATH);
  const legacyPath = (home: string): string => join(home, DSH_LEGACY_PROFILE_PATCH_RELATIVE_PATH);

  it('装配时刻 overlay 就在（insert tool-ask-user + 路由），且**不再写旧落点**', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    try {
      /**
       * **时序判据**：dsh 在 **boot 时**读装配清单（`--patch` 由 SDK 拼进 argv）⇒ 这份文件必须在
       * `new DeepSeekHarness(...)` 之前就写好。所以快照点取构造那一刻，而不是 run() 结束之后。
       * 为什么这条断言是必需的：把写入挪到 `start()` 之后，只看「run() 结束后文件在」的用例
       * **照样全绿**（实测过的守卫无区分力），而生产上那一行会以
       * `no adapter registered for provider "aieval-route"` 收场。
       */
      let snapshotAtBoot: string | null = null;
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: createRecorder(),
            events: [],
            onConstruct: () => {
              snapshotAtBoot = existsSync(overlayPath(home)) ? readFileSync(overlayPath(home), 'utf8') : null;
            },
          }),
        },
      });

      await dshProvider.run(createRunInput({ configHome: home, route: { ...ROUTE, contextWindow: 1_048_576 } }));

      // ① 装配时刻它就在（三块内容各自成判据：路由行、insert 形态、包名逐字正确）
      expect(snapshotAtBoot).not.toBeNull();
      expect(snapshotAtBoot).toContain('- id: llm-pi-ai');
      expect(snapshotAtBoot).toContain(`      ${DSH_ROUTE_KEY}:`);
      expect(snapshotAtBoot).toContain('- insert:');
      expect(snapshotAtBoot).toContain('id: tool-ask-user');
      expect(snapshotAtBoot).toContain('name: "@deepseek-ai/dsh-tool-ask-user"');
      // ② 运行结束后仍在
      expect(readFileSync(overlayPath(home), 'utf8')).toContain('tool-ask-user');
      /**
       * ③ **反向断言**：旧落点一个都不许出现（计划 Task 6 的「退役」判据）。
       * 少了这条，把 insert 又搬回 profile patch（或顺手恢复 settings.yaml）也能让上面全绿，
       * 而那样就回到「两份来源写同一个文件」的老问题。
       */
      expect(existsSync(legacyPath(home))).toBe(false);
      expect(existsSync(join(home, 'settings.yaml'))).toBe(false);
    } finally {
      removeTreeWithRetry(home);
    }
  });

  it('窗口未知时整份重建，**路由与工具挂载照样在**（它们与窗口无关）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    try {
      setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: createRecorder(), events: [] }) } });

      await dshProvider.run(createRunInput({ configHome: home, route: { ...ROUTE, contextWindow: 262_144 } }));
      expect(existsSync(overlayPath(home))).toBe(true);

      // 第二次：窗口未知 ⇒ 那一格不写，但路由与 insert 不能被连带删掉
      await dshProvider.run(createRunInput({ configHome: home, route: ROUTE }));

      const rebuilt = readFileSync(overlayPath(home), 'utf8');
      expect(rebuilt).not.toContain('contextWindow');
      expect(rebuilt).toContain('tool-ask-user');
      expect(rebuilt).toContain(`      ${DSH_ROUTE_KEY}:`);
    } finally {
      removeTreeWithRetry(home);
    }
  });

  it('幂等：同一个 home 连跑两次，overlay 内容逐字不变', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    try {
      setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: createRecorder(), events: [] }) } });

      await dshProvider.run(createRunInput({ configHome: home, route: ROUTE }));
      const first = readFileSync(overlayPath(home), 'utf8');
      await dshProvider.run(createRunInput({ configHome: home, route: ROUTE }));
      const second = readFileSync(overlayPath(home), 'utf8');

      expect(second).toBe(first);
    } finally {
      removeTreeWithRetry(home);
    }
  });
});

/**
 * overlay patch 生成器（计划 Task 4）：**纯函数**，输入即全部事实。
 *
 * 为什么单独一组用例：这份文本是「本仓的路由事实」到「pi-ai 路由配置」的**唯一**翻译点，
 * 三件事都只在这里发生——协议选 wire、baseURL 按 wire 归一化、档位映射成 wire 拼写。
 * 它错了不会在本仓炸，而是让 dsh 子进程在 `initialize` 阶段以
 * `no adapter registered` / `UNKNOWN_MODEL` / `UNSUPPORTED_REASONING_EFFORT` 收场，
 * 报错点离原因很远（真机探测报告 §2/§5 记录了这三条失败通道）。
 */
describe('buildDshRoutePatch', () => {
  const base = {
    protocolType: 'anthropic' as const,
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: 'deepseek-flash',
  };

  it('协议 → wire：anthropic 走 anthropic-messages、openai 只走 openai-responses（D2）', () => {
    expect(buildDshRoutePatch(base)).toContain('api: anthropic-messages');
    expect(buildDshRoutePatch({ ...base, protocolType: 'openai' })).toContain('api: openai-responses');
    // 反面：openai 那一支**不许**出现 chat-completions（用户口径只支持 responses）
    expect(buildDshRoutePatch({ ...base, protocolType: 'openai' })).not.toContain('openai-completions');
  });

  /**
   * D8：pi-ai **不做** baseURL 归一化（模型请求收到配置原样的 baseURL），所以归一化必须由我们做，
   * 且方向按 wire 分叉——anthropic 剥掉尾部 `/v1`（pi-ai 会追加 `/v1/messages`），
   * openai 补上 `/v1`（SDK 会追加 `/responses`）。写反就是 `/v1/v1/messages` 或 `{root}/responses`。
   */
  it('baseURL 按 wire 归一化：四个输入 × 两个方向', () => {
    const cases = [
      ['https://gw/anthropic', 'https://gw/anthropic', 'https://gw/anthropic/v1'],
      ['https://gw/anthropic/v1', 'https://gw/anthropic', 'https://gw/anthropic/v1'],
      ['https://gw/anthropic/v1/', 'https://gw/anthropic', 'https://gw/anthropic/v1'],
      // 裸 host：规范化会补一个尾部 `/`（`withPath` 用 `new URL().toString()`，这是既有行为）。
      // 它**不是**缺陷：厂商 SDK 拼路径时会吃掉首斜杠（`baseURL.endsWith('/') && path.startsWith('/')`
      // ⇒ `path.slice(1)`），实测落到 `/v1/messages?beta=true` 与 `/v1/responses` 都正确（探测报告 §2）。
      ['https://gw', 'https://gw/', 'https://gw/v1'],
    ] as const;
    for (const [input, expectedAnthropic, expectedOpenai] of cases) {
      expect(buildDshRoutePatch({ ...base, baseUrl: input }), `anthropic: ${input}`)
        .toContain(`baseURL: "${expectedAnthropic}"`);
      expect(buildDshRoutePatch({ ...base, baseUrl: input, protocolType: 'openai' }), `openai: ${input}`)
        .toContain(`baseURL: "${expectedOpenai}"`);
    }
  });

  it('模型 id / 窗口 / 上限逐字进 patch；未知的格子**不出现那个键**', () => {
    const withCaps = buildDshRoutePatch({ ...base, contextWindow: 1_048_576, maxOutputTokens: 131_072 });
    expect(withCaps).toContain('id: "deepseek-flash"');
    expect(withCaps).toContain('contextWindow: 1048576');
    expect(withCaps).toContain('maxTokens: 131072');

    const bare = buildDshRoutePatch(base);
    expect(bare).toContain('id: "deepseek-flash"');
    // 未知 = 不写这个键（既不写 0 也不写 null）：pi-ai 会用它的默认值，而不是我们编一个
    expect(bare).not.toContain('contextWindow');
    expect(bare).not.toContain('maxTokens');
  });

  /**
   * 档位：patch 里声明的键集合必须**逐字等于**注册表 `reasoningEfforts`。
   * 反了会怎样：界面上能选、patch 里没有 ⇒ dsh 在 `initialize` 阶段报
   * `UNSUPPORTED_REASONING_EFFORT`，用户选完到运行时才失败（本仓最忌讳的那一类）。
   */
  it('四个档位全部声明，且键集合与注册表 metadata.reasoningEfforts 逐字相等', () => {
    const levelLines = buildDshRoutePatch(base)
      .split('\n')
      .filter((line) => /^ {14}(off|low|high|max|minimal|medium|xhigh):/.test(line))
      .map((line) => line.trim().split(':')[0]);
    expect([...levelLines].sort()).toEqual([...dshProvider.metadata.reasoningEfforts].sort());
  });

  it('档位值是 wire 拼写：off 写成 null（显式关闭），其余原样', () => {
    const patch = buildDshRoutePatch(base);
    // 探测报告 §2：`off: null` ⇒ 实测发 `thinking:{type:'disabled'}` / `reasoning:{effort:'none'}`
    expect(patch).toContain('off: null');
    expect(patch).toContain('low: "low"');
    expect(patch).toContain('high: "high"');
    // responses 的 OpenAI 枚举里没有 max，但实测七种拼写全部 200 ⇒ 原样透传（探测报告 §4）
    expect(patch).toContain('max: "max"');
  });

  it('模型名含引号 / 反斜杠 / 冒号时，写出的 YAML 读回来逐字相等', () => {
    const modelId = 'a"b\\c:d';
    // 取**模型那一行**（`- id: "…"` 带引号），不是上面那条 `- id: llm-pi-ai` 的路由行
    const line = buildDshRoutePatch({ ...base, modelId })
      .split('\n')
      .find((entry) => entry.trimStart().startsWith('- id: "')) ?? '';
    const raw = line.slice(line.indexOf('id:') + 3).trim();
    // 两半判据都要（与旧 settings.yaml 那条同口径）：① 逐字是转义后的形态；
    // ② 反转义后与原 id 相等（dsh 读回来的必须还是那一个模型）
    expect(raw).toBe('"a\\"b\\\\c:d"');
    const roundTripped = raw.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
    expect(roundTripped).toBe(modelId);
  });

  it('同一份输入两次调用逐字相同（纯函数：无时间戳、无随机、无环境读取）', () => {
    expect(buildDshRoutePatch(base)).toBe(buildDshRoutePatch(base));
  });
});

/**
 * 把一串通知喂给 `dshProvider`，返回收集到的事件。
 * 既有 `dshProvider` 组的接线方式（`setAgentRuntimeForTesting` + 假 SDK + `collectEvents`）在这里
 * 只包一层：通知按**给的顺序**投递，且 `subagent.started` 的 `subagentId` 就是那个子会话 id
 * ⇒ 用例里的 `sessionEvent(..., 'child-1')` 说的正是「这一条属于 child-1」。
 */
async function runDshWith(notifications: readonly unknown[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const recorder = createRecorder();
  setAgentRuntimeForTesting({
    sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: notifications }) },
  });
  await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
  return events;
}

/**
 * 同 `runDshWith`，但要的是**运行结果**：收尾（`TurnStart.finalize`）交回的那一格**只在结果上**——
 * `turn.ts` 的收尾只把它折进结果（`finalized.subagentTokens` 覆盖，见 `TurnFinalize` 的注释），
 * 不发 `usage` 事件。所以「跑完那一刻说得清是『没采到』还是『确实没有』」这件事只能这样钉。
 */
async function runDshResultWith(notifications: readonly unknown[]): Promise<AgentRunResult> {
  const recorder = createRecorder();
  setAgentRuntimeForTesting({
    sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: notifications }) },
  });
  return dshProvider.run(createRunInput());
}

/**
 * 子智能体的两条通知是**顶层**的（`{ method, params }`，**不套** `session.event`，见 `protocol.ts`）：
 * 身份就在 `params.subagentId` 上，而它与随后子会话事件里的 `params.sessionId` 同值（真机核过）
 * ⇒ 用例里的 `sessionEvent(..., 'child-1')` 才认得出「这一条属于 child-1」。
 * `parentSessionId` 写占位 id（真机这里是主会话 id；夹具只改写 `params.sessionId` 那一格）。
 */
function subagentStarted(subagentId: string): unknown {
  return { method: DSH_SUBAGENT_STARTED_METHOD, params: { subagentId, parentSessionId: DSH_SESSION_PLACEHOLDER } };
}

/** 收场那一条（真机 `status` 只有 `ok` / `error`，`stopReason` 五档，见 `message.ts` 的映射表） */
function subagentFinished(subagentId: string): unknown {
  return {
    method: DSH_SUBAGENT_FINISHED_METHOD,
    params: { subagentId, status: 'ok', stopReason: 'completed' },
  };
}

/**
 * 主会话的一条用量：本组的算术都按 **10 / 0 / 2** 写死（`14 = 10 + 4`、`1 = 0 + 1`、`5 = 2 + 3`）。
 * 为什么不用文件级那个 `USAGE_EVENT`：它的读数是真机 dump 的 218 / 8832 / 2，拿它做加法会让断言变成
 * 一串看不出对应关系的数（两条的形状完全相同，只有取值不同）。
 */
const MAIN_USAGE = sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
  turn: 1,
  step: 1,
  usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 },
});

/**
 * 子智能体那一份用量（spec 2026-10-04 §2.3）。
 *
 * 今天的事实（本任务**不改**）：dsh 的 `assistant/message` 与 `step/start` 两支**都不按会话分叉**
 * ⇒ `tokens` 与 `turns` 已经含子会话；本组钉的是新那一格——「其中的**子智能体分量**」，
 * 它**只按本行的子会话白名单**求和。
 *
 * 为什么白名单是重点：`sessionUsage` 是 `message.ts` 里**模块级**的表（同一个 Node 进程里并行跑着
 * 好几行），主会话之外还有**别的行**的会话 ⇒ 只有白名单能把这一行圈出来。
 *
 * 两条**夹具层面**的事实（与真机的差别，先说清楚）：
 *   · 子会话的事件带的是**它自己的** `params.sessionId`（真机如此）⇒ `sessionEvent(..., 'child-1')`
 *     就是「这一条属于 child-1」；
 *   · 假 harness 会执行适配器交给 `subscribe` 的**会话过滤**，所以「别的行的会话」那一条根本到不了
 *     投影（它既不是本会话、也不在白名单里）。「合计含子会话用量」这件事由第一条用例钉住
 *     （child-1 的 4 / 1 / 3 进了 `tokens`）；「别的行绝不算进来」钉的是**分量**只认白名单——
 *     去掉白名单（改成遍历 `sessionUsage` 全部键）时它会红：主会话那一笔就在表里。
 *
 * 时间线的一条（夹具比真机**更早**把状态备齐）：假 harness 一口气把整串通知投递进来，筛选回调在
 * **投递时**就跑完 ⇒ 投影看到第一条带用量的消息时，白名单/已收场集合**已经是终态**。
 * 这不影响本组的判据（判的是「分量怎么算」），但它让「收场那一刻的结论何时送到消费方」在这一层
 * 观察不到——第 4 条用例的注记说明了这一点。
 */
describe('子智能体那一份用量（spec 2026-10-04 §2.3）', () => {
  /**
   * 模块级的关联表（`sessionUsage` / 子会话身份）按用例清空：本组的 id 是固定字面量
   * （`child-1` / `other-row-session`），不清就会跨用例串味——而串味的方向恰好是「白名单之外
   * 也有数」，会让守卫的判据变成「取决于上一条用例跑没跑」。
   */
  beforeEach(() => {
    resetDshMessageStateForTesting();
  });

  it('子会话的 assistant/message 用量进合计，并单独交回子那一份', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE, // 主会话：input 10 / cached 0 / output 2
      subagentStarted('child-1'),
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { usage: { inputTokens: 4, cacheReadTokens: 1, outputTokens: 3 } }, 'child-1'),
    ]);
    const last = usageEvents(events).at(-1);
    // 判据用 `toMatchObject` 而不是 `toEqual`：整格是 `UsageTokens`，两个可选格
    // （`reasoningOutput` / `total`）**也随它一起**交出来（这里是 `null`）——本组要钉的是三元组。
    expect(last?.tokens).toMatchObject({ input: 14, cached: 1, output: 5 });
    expect(last?.subagentTokens).toMatchObject({ input: 4, cached: 1, output: 3 });
  });

  it('没有子会话 ⇒ 子那一份是 {0,0,0}（「确实没有」，不是 null）', async () => {
    const events = await runDshWith([STEP_START_EVENT, MAIN_USAGE]);
    expect(usageEvents(events).at(-1)?.subagentTokens).toMatchObject({ input: 0, cached: 0, output: 0 });
  });

  it('别的行的会话（不在本行子会话白名单里）绝不算进来', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { usage: { inputTokens: 999, cacheReadTokens: 0, outputTokens: 999 } }, 'other-row-session'),
    ]);
    // 合计仍会含它（dsh 的既成口径：投影不按会话分叉；那件事由第 1 条用例钉住——child-1 的
    // 4 / 1 / 3 确实进了 `tokens`），但**子那一份必须只算白名单**。
    // ⚠️ 夹具层面：这个会话不在白名单里，会被会话过滤**挡在投影之外**（见本组的 JSDoc），所以下面钉的
    // 是「分量只认白名单」这件事本身——去掉白名单（遍历 `sessionUsage` 全部键）时它会红：
    // 主会话那一笔就在表里（变异验证 M1 实测如此）。
    expect(usageEvents(events).at(-1)?.subagentTokens).toMatchObject({ input: 0, cached: 0, output: 0 });
  });

  it('子会话已收场却一条用量都没有 ⇒ 子那一份 null（宁可不出数），合计仍含主会话', async () => {
    /**
     * ⚠️ 这一条**在实现之前也是绿的**，原因有两层，都值得知道：
     *   · 骨架那个局部量的初值就是 `null`（投影**整格缺席** = 保持原值，见 `turn.ts`），所以「还没实现」
     *     与「明确算成 null」在事件上长得一样 ⇒ 它的区分力不来自「有没有实现」，而来自
     *     **`dshSubagentUsage` 里那一支在不在**（去掉 `finishedSessions` 那支的变异体正是被它杀掉的）；
     *   · 假 harness 是**一口气**把整串通知投递进来的（筛选回调在投递时跑完），所以「已收场」这件事在
     *     投影看到主会话那条用量时就已经登记好了——真机是逐条到达的，结论会在**下一条**
     *     `assistant/message` 上出现（见 `events.ts` 里那一支的注记）。
     */
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      subagentStarted('child-2'),
      subagentFinished('child-2'),
    ]);
    const last = usageEvents(events).at(-1);
    expect(last?.subagentTokens).toBeNull();
    expect(last?.tokens).toMatchObject({ input: 10, cached: 0, output: 2 });
  });

  it('轮次继续含子会话的 step（既成事实的守卫）', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      subagentStarted('child-1'),
      sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'),
    ]);
    expect(usageEvents(events).at(-1)?.turns).toBe(2);
  });

  /**
   * 收尾那一格（2026-10-04 评审 Important 1）：`startDsh` 的 `TurnStart` 也要给 `finalize`，
   * 否则「子会话收场却没报到用量 ⇒ 没采到」这个结论**在整轮再也没有消息**时就送不出去——
   * 留在 `AgentRunResult.subagentTokens`（进而进行快照）里的是骨架那个初值或上一版的旧数。
   * `finalize` 在 `finally` 里跑（正常 / 失败 / 被终止都跑，`turn.ts:611-626`），
   * 且 `subagentTokens` 的**显式 `null` 会覆盖**（R2）。
   */
  it('收尾（finalize）也交一次分量：跑完那一格说得清是「没采到」还是「确实没有」', async () => {
    // ① 子会话收场却一条用量都没有 ⇒ 结果里是 **null**（不是 `{0,0,0}`、也不是缺席）
    const finished = await runDshResultWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      subagentStarted('child-2'),
      subagentFinished('child-2'),
    ]);
    expect(finished.subagentTokens).toBeNull();
    // ② 只有一条「派发」、整轮一条用量都没有 ⇒ 结果里是 `{0,0,0}`（还在跑，它还会报）。
    //    这一半是**「收尾交没交」的可观测判据**：不交的话留在结果里的是骨架那个初值 `null`
    //    （假 harness 一口气投递通知，所以「旧数残留」那一半在这个夹具里构造不出来，见报告 §8）。
    const running = await runDshResultWith([subagentStarted('child-3')]);
    expect(running.subagentTokens).toMatchObject({ input: 0, cached: 0, output: 0 });
  });

  /**
   * R17（Task 9 收口裁定）：`null` 那一格**不能是静默的**。spec §2.2 的第三档承诺「`null` 伴随一条
   * **点名**的 WARN」，运维据此分得清「没采到」与「确实没有子智能体」——codex
   * （`codex/transcript.ts` 的「未找到子线程 …」）与 claude（`claude-code/index.ts` 的
   * 「读不到子智能体 …」，用例 `claude-code/index.test.ts` 那条）都落了这条 WARN，
   * 而 dsh 原来在 `finalize` 里给的是 `drafts: []` ⇒ 一格 `null` 悄无声息。
   */
  it('子会话收场却无用量 ⇒ 一条**点名**的 WARN（R17：null 那一格不能是静默的）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [
            STEP_START_EVENT,
            MAIN_USAGE,
            subagentStarted('child-6'),
            subagentFinished('child-6'),
            subagentStarted('child-7'),
            subagentFinished('child-7'),
          ],
        }),
      },
    });
    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result.subagentTokens).toBeNull();
    const warns = events
      .filter((event) => event.type === 'log' && event.stream === 'stderr' && event.text.startsWith('[WARN] 子会话'))
      .map((event) => (event.type === 'log' ? event.text : ''));
    // **一条**文案串起全部 id，不是每个 id 一条（两个子会话都收场、都没报用量）
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('child-6');
    expect(warns[0]).toContain('child-7');
  });

  /**
   * 身份**三级兜底**必须与白名单登记**同源**（2026-10-04 评审 Minor 2）：规范描述的那一支形状
   * （`agentId` / `childSessionId`，真机给 `subagentId`）只被 `noteChildSession` 认、
   * 而 `noteFinishedChildSession` 只认 `subagentId` 的话，收场那一条就白来了——
   * 白名单里的子会话被当成「还在跑」⇒ R2 的 `null` 静默降级成 `{0,0,0}`（把「没采到」说成「确实没有」）。
   */
  it('收场通知只带 childSessionId（规范形状）时也认得出——身份兜底与白名单同源', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      { method: DSH_SUBAGENT_STARTED_METHOD, params: { childSessionId: 'child-4' } },
      {
        method: DSH_SUBAGENT_FINISHED_METHOD,
        params: { childSessionId: 'child-4', status: 'ok', stopReason: 'completed' },
      },
    ]);
    expect(usageEvents(events).at(-1)?.subagentTokens).toBeNull();
  });

  /**
   * 两把尺子不互相顶替（spec 2026-10-05 §3.1 守卫 4 / 5）：`usage.turn` 是**每会话自己的** `step`
   * （这条读数属于哪个会话的第几次模型往返），而 `turns` 仍是**全树合计**（`step/start` 一个都不落）。
   * 变异体：把 `turns` 顺手改成每会话 ⇒ 这里读到的合计会掉回 2（主会话自己的步数）。
   */
  it('归属按每会话自己的 step 走，而 `turns` 仍是全树合计（两把尺子不互相顶替）', async () => {
    const events = await runDshWith([
      STEP_START_EVENT, // 主会话 step 1
      subagentStarted('child-1'),
      sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'),
      sessionEvent('step/start', { turn: 1, step: 2 }), // 主会话 step 2（合计因此是 3）
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 2, usage: { inputTokens: 4, cacheReadTokens: 1, outputTokens: 3 } }, undefined),
    ]);
    const last = usageEvents(events).at(-1);
    // 合计：主 2 步 + 子 1 步 = 3（既成口径，本次不动）
    expect(last?.turns).toBe(3);
    // 归属：这一条来自**主会话的第 2 步**
    expect(last?.turn).toEqual({ subagentId: null, round: 2 });
  });
});

/**
 * 子智能体那一份**轮次**（2026-10-04，spec §2.3 dsh 段）。
 *
 * 与用量那一组是同一件事的两半，但 dsh 的**取数面不同**：`turns` 从第一天起就是全树口径
 * （`step/start` 那一支不按会话分叉，`events.ts` 的既成口径）⇒ 分量必须**另按会话数**，
 * 而圈出「本行的子会话」的唯一依据仍是**同一份白名单**。
 *
 * 三条口径与用量**逐字相同**（spec §2.2 的三档）：
 *   · 没有子会话 ⇒ `0`（确实没有，不是 `null`）；
 *   · 白名单里的子会话 ⇒ 按「到目前为止」求它自己的 `step/start` 数；
 *   · 有子会话**已收场却没报到** ⇒ `null`，且判据是 `dshSilentChildSessions`——**与用量同一个谓词**
 *     （收尾那条点名 WARN 也读它），绝不另造第二个。
 *
 * ⚠️ 与用量那一组**唯一**的落点差异：轮次的分量在 `step/start` 那一支**也交**（用量那一支不交）。
 * 理由是「两格必须同刻」：合计在那里刚 +1，分量若等到下一条 `assistant/message` 才更新，
 * 界面上「主会话 = 合计 − 分量」会短暂地多算 1（一行画得出来的假拆分）。
 * 本组第一条用例正是钉这件事：最后一条事件是**子会话的 `step/start`**，两格都得是新的。
 */
describe('子智能体那一份轮次（spec 2026-10-04 §2.3 dsh 段）', () => {
  beforeEach(() => {
    resetDshMessageStateForTesting();
  });

  it('子会话的 step/start 单独计入分量，且与合计**同一条事件**上同刻更新（主 1 + 子 1）', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      subagentStarted('child-1'),
      sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'),
    ]);
    const last = usageEvents(events).at(-1);
    // 既成口径（上一条用例钉的就是它）：`turns` 含子会话；本次只是把**其中的分量**另外交出来。
    // ⚠️ 两条断言必须在**同一条事件**上成立：只给合计不给分量的话，界面按「主会话 = 合计 − 分量」
    // 算出的主会话会多 1（旧分量还没跟上），而那两行看起来完全正常。
    expect(last?.turns).toBe(2);
    expect(last?.subagentTurns).toBe(1);
  });

  it('子会话跑了 3 轮 ⇒ 分量 3，合计主 1 + 子 3（逐格满足 subagentTurns ≤ turns）', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      subagentStarted('child-1'),
      sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'),
      sessionEvent('step/start', { turn: 1, step: 2 }, 'child-1'),
      sessionEvent('step/start', { turn: 2, step: 1 }, 'child-1'),
    ]);
    const last = usageEvents(events).at(-1);
    expect(last?.subagentTurns).toBe(3);
    expect(last?.turns).toBe(4);
  });

  it('没有子会话 ⇒ 分量是 0（「确实没有」，不是 null）', async () => {
    const events = await runDshWith([STEP_START_EVENT, MAIN_USAGE]);
    const last = usageEvents(events).at(-1);
    expect(last?.subagentTurns).toBe(0);
    expect(last?.turns).toBe(1);
  });

  it('子会话已收场却一条 step 都没有 ⇒ 分量 null；用量与轮次**同时**为 null（同一个判据）', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      subagentStarted('child-2'),
      subagentFinished('child-2'),
    ]);
    const last = usageEvents(events).at(-1);
    expect(last?.subagentTurns).toBeNull();
    // 两格同源：判据只有一份（`dshSilentChildSessions`）、**同一次求值**（`assistant/message` 这一支
    // 两格一起算）⇒ 这一条事件上不可能一格有数、另一格 null。
    // ⚠️ 别把这句话推广到**所有**分支：`turn/start` 那一类两格都不带（骨架保持上一份），
    // 而带分量的三条出口（`step/start` / `assistant/message` / `turn/end`）都同时带两格。
    expect(last?.subagentTokens).toBeNull();
    // 合计不受影响：那仍是已观察到的全树读数（退回主会话口径 = 主会话那一格）
    expect(last?.turns).toBe(1);
  });

  it('别的行的会话（不在本行白名单里）的 step 绝不算进分量', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      sessionEvent('step/start', { turn: 1, step: 1 }, 'other-row-session'),
    ]);
    // 夹具层面这个会话会被会话过滤挡在投影之外（见用量那一组的 JSDoc）⇒ 这里钉的是「分量只按白名单
    // 求和」这件事本身：去掉白名单（遍历全部会话的计数）时它会红——主会话那一轮就在表里。
    expect(usageEvents(events).at(-1)?.subagentTurns).toBe(0);
  });

  /**
   * 收尾那一格：与用量同一处（`finalize`）、同一条理由——「子会话收场却没报到」这个结论是在
   * **不带轮次**的通知（`subagent.finished`）上成立的，若整轮再无消息，只有收尾送得出去。
   */
  it('收尾（finalize）也交一次分量：跑完那一刻说得清「没采到」还是「确实没有」', async () => {
    const finished = await runDshResultWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      subagentStarted('child-2'),
      subagentFinished('child-2'),
    ]);
    expect(finished.subagentTurns).toBeNull();
    const running = await runDshResultWith([subagentStarted('child-3')]);
    expect(running.subagentTurns).toBe(0);
  });

  /**
   * `null` 那一格**不能是静默的**（R17）：这一格与用量同源，所以**同一条**点名 WARN 必须说清
   * 「给不出的是**哪一格**」。
   *
   * ⚠️ **措辞在 2026-10-04 复核（I2）时改过一次，判据也一起改了**：原来的文案抄了另两家的
   * 「这一行的 tok / 缓存命中 / 轮次**不含**它们」——那句话在 codex / claude 上成立（那两家的
   * 合计真的会退回主线程口径），**在 dsh 上是假的**：dsh 的 `turns` 是**构造上的全树累加**
   * （`step/start` 不按会话分叉，上一条「轮次继续含子会话的 step」用例钉着它）⇒ 一个收场却没报
   * 用量的子会话，它的 `step` **已经在合计里**，缺的只是**分量**。
   * 这一条正是运维对着 `主 27 + 子 7 = 34` 复核时会读到的那一行，所以它必须逐格说对。
   */
  it('收场无用量 ⇒ 那条点名 WARN 说清「缺的是分量」，且分别交代轮次与 tok 的合计口径', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      subagentStarted('child-8'),
      subagentFinished('child-8'),
    ]);
    const warns = events
      .filter((event) => event.type === 'log' && event.stream === 'stderr' && event.text.startsWith('[WARN] 子会话'))
      .map((event) => (event.type === 'log' ? event.text : ''));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('child-8');
    // ① 缺的是**分量**（不是「三格都不含它们」）
    expect(warns[0]).toContain('分量');
    // ② 轮次那一格的合计**含**它的 step（dsh 的既成口径）——这句话反过来说就是错的。
    //    两条一起钉：缺的是分量（①），而合计并没有因此少算谁的轮次（②）。
    expect(warns[0]).toContain('轮次含');
    // ③ 另两家那句句式（「…/ 轮次**不含**它们」，在 dsh 上是假的）不许借过来：
    //    变异（改回旧句式）⇒ ① 与 ③ 同时红
    expect(warns[0]).not.toContain('不含它们');
  });
});

/** 投影那一层的失败上下文（形状与既有直调用例一致：`events.test.ts` 的 `CONTEXT`） */
const PROJECT_CONTEXT = { kind: 'dsh', baseUrl: 'https://gw.example.com/anthropic' } as const;

/**
 * R2 的**三档**只能在投影这一层钉（预检裁定 R2，2026-10-04）：
 *   · 值（没有子会话 ⇒ `{0,0,0}`；有 ⇒ 子会话之和）；
 *   · **显式 `null`**（已收场却没报到用量 = 事实缺失，宁可不出数）；
 *   · **键缺席**（这一条不谈它 ⇒ 骨架保持上一份，见 `turn.ts` 的 `TurnProjection.subagentTokens`）。
 *
 * 为什么不能只靠上面那组集成用例：投影整格缺席时，骨架交出来的事件里那一格是它**自己的初始 `null`**
 * ⇒「缺席」与「显式 null」在**事件层**长得一样（去重判据也按三元组比，那一格只参与「变了没」），
 * 只有直接看投影才分得开。这一组因此在**实现之前**就能红（`undefined` vs `null`），
 * 也正是 brief 里 Step 2 说的那个失败形状。
 */
describe('projectDshNotification：子智能体那一份的三档（R2）', () => {
  beforeEach(() => {
    resetDshMessageStateForTesting();
  });

  /** 一条会话内用量事件（`sessionId` 就是它的会话：主会话或子会话，这一层不经过会话过滤） */
  const usageOf = (sessionId: string, input: number, cached: number, output: number): unknown =>
    sessionEvent(
      DSH_ASSISTANT_MESSAGE_TYPE,
      { turn: 1, step: 1, usage: { inputTokens: input, cacheReadTokens: cached, outputTokens: output } },
      sessionId,
    );

  it('白名单为空 ⇒ 值 `{0,0,0}`（「确实没有子会话」，不是 `null`）', () => {
    const projection = projectDshNotification(
      usageOf('session-main', 10, 0, 2),
      createTurnState(),
      PROJECT_CONTEXT,
      { childSessions: new Set(), finishedSessions: new Set() },
    );
    expect(projection.subagentTokens).toMatchObject({ input: 0, cached: 0, output: 0 });
    expect(projection.subagentTokens).not.toBeNull();
  });

  it('白名单里的子会话报过用量 ⇒ 值就是它那一份（合计不含在分量里）', () => {
    // 同一个 `state`（= 同一次运行）：子会话的用量按其真机路径记进模块级的表，同时**也进合计**
    const state = createTurnState();
    projectDshNotification(usageOf('child-1', 4, 1, 3), state, PROJECT_CONTEXT);
    const projection = projectDshNotification(
      usageOf('session-main', 10, 0, 2),
      state,
      PROJECT_CONTEXT,
      { childSessions: new Set(['child-1']), finishedSessions: new Set() },
    );
    expect(projection.subagentTokens).toMatchObject({ input: 4, cached: 1, output: 3 });
    // 合计是「主 + 子」（既成口径不改：投影不按会话分叉），分量只算子会话那 4 / 1 / 3
    expect(projection.tokens).toMatchObject({ input: 14, cached: 1, output: 5 });
  });

  it('已收场却一条用量都没有 ⇒ **显式 `null`**（不是 `{0,0,0}`、也不是缺席）', () => {
    const projection = projectDshNotification(
      usageOf('session-main', 10, 0, 2),
      createTurnState(),
      PROJECT_CONTEXT,
      { childSessions: new Set(['child-2']), finishedSessions: new Set(['child-2']) },
    );
    expect(projection.subagentTokens).toBeNull();
    // 「显式 null」与「键缺席」必须分得开：骨架按 `in` 判据决定「覆盖成 null」还是「保持原值」
    expect('subagentTokens' in projection).toBe(true);
  });

  /**
   * R2 的第三档（「本条不谈它」⇒ 键缺席）在 `turn/start` 这一支上钉。
   *
   * ⚠️ **这一条原来挂在 `step/start` 上，2026-10-04 复核后搬家**：`step/start` 现在**两格分量都交**
   * （M1 的收口，理由见 `events.ts` 那一支的注释）——合计在那里刚 +1，只交其中一格会让事件上出现
   * 「旧的用量分量 + `null` 的轮次分量」这种不一致（两格各自与自己的上一版自洽，但摆在一起是错的）。
   * 而 `turn/start`（轮次开始）既不重量也不重轮次 ⇒ 它才是这一档的落点。
   */
  it('这一条不谈它（`turn/start`）⇒ **两格都键缺席**（骨架保持上一份）', () => {
    const projection = projectDshNotification(
      sessionEvent('turn/start', { turn: 1 }),
      createTurnState(),
      PROJECT_CONTEXT,
    );
    expect('subagentTokens' in projection).toBe(false);
    expect(projection.subagentTokens).toBeUndefined();
    // 轮次那一格同一条规则（两格都是「本条不带」⇒ 保持）：
    // 变异：让 `turn/start` 也带上它们 ⇒ 这几条断言当场红
    expect('subagentTurns' in projection).toBe(false);
    expect(projection.subagentTurns).toBeUndefined();
  });

  it('仍在跑的子会话（还没报用量）算 0 ⇒ 值 `{0,0,0}`，不是 `null`', () => {
    const projection = projectDshNotification(
      usageOf('session-main', 10, 0, 2),
      createTurnState(),
      PROJECT_CONTEXT,
      { childSessions: new Set(['child-3']), finishedSessions: new Set() },
    );
    expect(projection.subagentTokens).toMatchObject({ input: 0, cached: 0, output: 0 });
  });

  /**
   * `turn/end` **也谈它**（2026-10-04 评审 Important 1 的可选那一半）：收尾那一条按既有口径
   * 「把最新的一份再交一次」（tokens / timing / turns 都是这样），分量不能例外——否则它是三条格子里
   * 唯一可能停在旧值的那个，界面在「子会话刚收场、本轮再无消息」时看不到「没采到」。
   * 正常与失败**两条出口都要带**（失败那条同样会发 usage 事件，漏一条就有一半的运行停在旧值）。
   */
  it('`turn/end` 也带分量：正常与失败两条出口都是最新值（收场无用量 ⇒ 显式 `null`）', () => {
    const runState = { childSessions: new Set(['child-5']), finishedSessions: new Set(['child-5']) };
    const completed = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }),
      createTurnState({ turns: 1 }),
      PROJECT_CONTEXT,
      runState,
    );
    expect(completed.subagentTokens).toBeNull();
    const failed = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'error', error: '传输中断' } }),
      createTurnState({ turns: 1 }),
      PROJECT_CONTEXT,
      runState,
    );
    expect(failed.subagentTokens).toBeNull();
  });
});

/**
 * 轮次那一格的**三档**同样只能在投影这一层钉（理由与上面那组逐字相同：骨架那个局部量的初值就是
 * `null`，于是「整格缺席」与「显式 null」在事件层长得一样）。额外两条：
 *   · **分量与合计同源同刻**：两格都由同一条 `step/start` 驱动 ⇒ `subagentTurns ≤ turns` 是构造上的；
 *   · **分量在哪几条出口上出现，是「全有或全无」**：`step/start` / `assistant/message` / `turn/end`
 *     **三条出口都同时带两格**（复核 M1 的收口，理由见 `events.ts` 那两支的注释）；
 *     而 `turn/start` / `tool/call` / `tool/result` 这些两格**都不带**（R2 的第三档「本条不谈它」，
 *     骨架保持上一份）——本组最后那条用例的落点因此是 `turn/start`，不是 `step/start`。
 */
describe('projectDshNotification：子智能体那一份轮次的三档（R2）', () => {
  beforeEach(() => {
    resetDshMessageStateForTesting();
  });

  /** 一条会话内的 `step/start`（`sessionId` 就是它的会话：主会话或子会话，这一层不经过会话过滤） */
  const stepOf = (sessionId: string): unknown => sessionEvent('step/start', { turn: 1, step: 1 }, sessionId);

  /** 一条会话内的用量事件（两格分量也随它一起交出来：`assistant/message` 是三条带分量的出口之一） */
  const usageOf = (sessionId: string): unknown =>
    sessionEvent(
      DSH_ASSISTANT_MESSAGE_TYPE,
      { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } },
      sessionId,
    );

  it('白名单为空 ⇒ 值 `0`（「确实没有子会话」，不是 `null`）', () => {
    const projection = projectDshNotification(
      usageOf('session-main'),
      createTurnState(),
      PROJECT_CONTEXT,
      { childSessions: new Set(), finishedSessions: new Set() },
    );
    expect(projection.subagentTurns).toBe(0);
  });

  it('白名单里的子会话跑过 2 轮 ⇒ 分量是 2，合计同刻为 3（主 1 + 子 2）', () => {
    // 同一个 `state`（= 同一次运行）：子会话的两轮先按会话计进来（`step/start` 那一支自己就交分量）
    const state = createTurnState();
    const childOnly = projectDshNotification(
      stepOf('child-1'),
      state,
      PROJECT_CONTEXT,
      { childSessions: new Set(['child-1']), finishedSessions: new Set() },
    );
    expect(childOnly.subagentTurns).toBe(1);
    const second = projectDshNotification(
      stepOf('child-1'),
      state,
      PROJECT_CONTEXT,
      { childSessions: new Set(['child-1']), finishedSessions: new Set() },
    );
    expect(second.subagentTurns).toBe(2);
    const projection = projectDshNotification(
      stepOf('session-main'),
      state,
      PROJECT_CONTEXT,
      { childSessions: new Set(['child-1']), finishedSessions: new Set() },
    );
    expect(projection.subagentTurns).toBe(2);
    // 既成口径：合计含子会话（`step/start` 不按会话分叉）⇒ 分量恒 ≤ 合计（主 1 + 子 2）
    expect(projection.turns).toBe(3);
  });

  it('已收场却一条 step 都没有 ⇒ **显式 `null`**（不是 `0`、也不是缺席）', () => {
    const projection = projectDshNotification(
      usageOf('session-main'),
      createTurnState(),
      PROJECT_CONTEXT,
      { childSessions: new Set(['child-2']), finishedSessions: new Set(['child-2']) },
    );
    expect(projection.subagentTurns).toBeNull();
    // 「显式 null」与「键缺席」必须分得开：骨架按 `in` 判据决定「覆盖成 null」还是「保持原值」
    expect('subagentTurns' in projection).toBe(true);
  });

  it('这一条不谈它（`turn/start`）⇒ **键缺席**（骨架保持上一份）', () => {
    const projection = projectDshNotification(
      sessionEvent('turn/start', { turn: 1 }),
      createTurnState(),
      PROJECT_CONTEXT,
    );
    expect('subagentTurns' in projection).toBe(false);
    expect(projection.subagentTurns).toBeUndefined();
  });

  /**
   * ⚠️ `step/start` 这一支**两格分量都交**（2026-10-04 复核 M1 的收口）：这一条刚把合计 +1，
   * 而两格分量若不跟上，事件上就会出现「上一版的非零用量分量 + `null` 的轮次分量」——
   * 真机可达的时序：子 A 报过用量（两格都写进骨架）→ 子 B 收场却一条都没报 → 主会话开下一步
   * ⇒ 只交轮次那一格的话，界面上「子智能体 1 轮」与「子智能体 0 token」会同时摆着。
   * 两格**同一判据、同一刻**（`dshSilentChildSessions`）⇒ 一起交才是自洽的。
   */
  it('`step/start` 与合计同刻交两格分量（只交一格会留下「旧用量 + null 轮次」那种不一致）', () => {
    // 白名单里那个子会话已收场却什么都没报 ⇒ 两格同时是「明确没采到」
    const projection = projectDshNotification(
      stepOf('session-main'),
      createTurnState(),
      PROJECT_CONTEXT,
      { childSessions: new Set(['child-9']), finishedSessions: new Set(['child-9']) },
    );
    expect('subagentTokens' in projection).toBe(true);
    expect(projection.subagentTokens).toBeNull();
    expect('subagentTurns' in projection).toBe(true);
    expect(projection.subagentTurns).toBeNull();
    // 合计照旧（这一支的既有语义）：主会话那一步
    expect(projection.turns).toBe(1);
  });

  it('`step/start` 交轮次的分量，用量的分量也一起（没有子会话 ⇒ `0` 与 `{0,0,0}`）', () => {
    const projection = projectDshNotification(
      stepOf('session-main'),
      createTurnState(),
      PROJECT_CONTEXT,
      { childSessions: new Set(), finishedSessions: new Set() },
    );
    expect(projection.subagentTurns).toBe(0);
    expect(projection.subagentTokens).toMatchObject({ input: 0, cached: 0, output: 0 });
  });

  it('`turn/end` 也带分量：正常与失败两条出口都是最新值', () => {
    const state = createTurnState({ turns: 1 });
    projectDshNotification(stepOf('child-5'), state, PROJECT_CONTEXT);
    const runState = { childSessions: new Set(['child-5']), finishedSessions: new Set<string>() };
    const completed = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }),
      state,
      PROJECT_CONTEXT,
      runState,
    );
    expect(completed.subagentTurns).toBe(1);
    const failed = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'error', error: '传输中断' } }),
      state,
      PROJECT_CONTEXT,
      runState,
    );
    expect(failed.subagentTurns).toBe(1);
  });
});
