// @vitest-environment node
/**
 * dsh 适配器：环境变量注入（保留尾部 /v1 + 显式 API key）、终止必然走第二段（5 秒 → WARN → 关闭运行时）、
 * 用量提取与加载降级。
 * dsh 是「非合作适配器」的真实样本：cancelMidTurn 为 false、interrupt() 是刻意空实现，所以它的终止
 * 路径 100% 会经过释放兜底的第二段——这条用例同时是那段兜底逻辑的真实性证明。
 * 「在途通知消费被终结」这一格在 dsh 上是**可达且可钉**的：真实 `NotificationSubscription.close()`
 * 会 reject 挂起的等待者（见夹具 `createFakeDshSdk` 的 JSDoc），所以这里连 `recorder.order` 一起钉住，
 * 而不是像 codex 那样只登记能力边界。
 * 事件构造数据一律照真机读数（`probe/dumps/v3/`）的外形：`{ method:'session.event', params:{ event } }`。
 * 收尾轮（去重缺陷）：**一轮恰好一条 `usage`**，以及「两轮各一条、tokens 是当轮的量」。
 */
import { EFFORT_OFF, type AgentEvent } from '@aieval/contracts';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_GRACE_MS } from '../../release';
import { setAgentRuntimeForTesting } from '../../runtime';
import type { AgentRunInput, AgentRunResult, AskUserReply, InjectionPort } from '../../types';
import {
  DSH_ASK_ANSWERER_PLUGIN_RELATIVE_PATH,
  DSH_ASK_ANSWERER_PLUGIN_SOURCE,
  DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH,
  DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH,
  DSH_ASK_WAIT_TIMEOUT_ANSWERED_SECONDS,
  DSH_ASK_WAIT_TIMEOUT_UNANSWERED_SECONDS,
} from './ask-user';
import {
  DSH_INJECT_PLUGIN_RELATIVE_PATH,
  DSH_INJECT_QUEUE_RELATIVE_PATH,
  DSH_INJECT_RECEIPTS_RELATIVE_PATH,
} from './inject';
import {
  DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH,
  DSH_STREAM_TAP_PLUGIN_SOURCE,
  DSH_STREAM_TAP_RELATIVE_PATH,
} from './stream-tap';
import {
  collectEvents,
  createFakeDshSdk,
  createRecorder,
  createRunInput,
  createTurnState,
  DSH_SESSION_PLACEHOLDER,
  FIXTURE_CONFIG_HOME,
  FIXTURE_CWD,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import {
  DSH_ASSISTANT_MESSAGE_TYPE,
  DSH_REQUEST_HEADER_TYPE,
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
  noteChildSession,
  buildDshRoutePatch,
  diagnoseStreamEnd,
  dshProvider,
} from './index';
import { dshTurnAttribution, resetDshMessageStateForTesting, seedDshSessionRoundHighWater } from './message';
import { DSH_PACKAGE_NAME } from './sdk';
import { removeTreeWithRetry } from '../../testing/cleanup';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
});

/**
 * **放行判据：会话树，不是同一个会话**（用户口径：「dsh 展示的不对」）。
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
    // 真机载荷：`{parentSessionId, childSessionId}`（`finished` 另有同值的 `agentId`）
    expect(
      acceptsRunNotification({ method: 'subagent.started', params: { parentSessionId: OWN, childSessionId: CHILD } }, OWN, children),
    ).toBe(true);
    expect(
      acceptsRunNotification(
        { method: 'subagent.finished', params: { parentSessionId: OWN, childSessionId: CHILD, agentId: CHILD } },
        OWN,
        children,
      ),
    ).toBe(true);
  });

  it('更早版本 / 其它载体的 `params.subagentId` 一并容忍（多认一个键，漏认的代价是子会话整段消失）', () => {
    const children = new Set<string>();
    noteChildSession({ method: 'subagent.started', params: { subagentId: CHILD, parentSessionId: OWN } } as never, OWN, children);
    expect(children.has(CHILD)).toBe(true);
  });

  /**
   * **身份来源的第四格：信封 `params.sessionId`**（真机 `subagent` 工具派发的那一档）。
   *
   * 真机读数：派发时只投一条 `subagent/descriptor`（子会话自己的 `seq: 6`，`data` 里没有 `childId`），
   * **没有** `subagent.started`；子会话的 `assistant/message` 与 `step/start` 照常投送，
   * 而它们的 `sessionId` 是子会话 id ⇒ 放行判据的 ③ 只认登记过的 id。
   * 少了信封那一格：子会话的事件被挡掉（子智能体的话一个字都不剩），它的 tok 也不算进
   * 「子智能体那一份」（真机那一轮主会话 54249 / 分量 27560 就是这么来的）。
   */
  it('subagent/descriptor 的信封 sessionId 被登记成子会话（真机没有 subagent.started 的那一档）', () => {
    const children = new Set<string>();
    noteChildSession(
      {
        method: 'session.event',
        params: {
          sessionId: CHILD,
          event: { type: 'subagent/descriptor', seq: 6, time: 1, data: { mode: 'one-shot', provider: 'spawn' } },
        },
      },
      OWN,
      children,
    );
    expect([...children]).toEqual([CHILD]);
    // 登记之后，这条子会话的事件才放得进来
    expect(acceptsRunNotification({ method: 'session.event', params: { sessionId: CHILD } }, OWN, children)).toBe(true);
    // 而本会话自己的信封不算子会话（`session.event` 一律带它）
    const selfOnly = new Set<string>();
    noteChildSession({ method: 'session.event', params: { sessionId: OWN, event: { type: 'tool/call' } } }, OWN, selfOnly);
    expect([...selfOnly]).toEqual([]);
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
  it('注入落点：路由键 + 绝对路径的 overlay + **自定义变量名**带凭据；DSH_HOME/HOME 都指向该候选目录', async () => {
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
    expect(recorder.env?.DSH_HOME).toBe(FIXTURE_CONFIG_HOME);
    expect(recorder.env?.HOME).toBe(FIXTURE_CONFIG_HOME);
    expect(recorder.options?.dshHome).toBe(FIXTURE_CONFIG_HOME);
    expect(recorder.options?.model).toBe('deepseek-x');
    expect(recorder.options?.cwd).toBe(FIXTURE_CWD);
    expect(recorder.options?.processCwd).toBe(FIXTURE_CWD);
    // 路由：`provider` 必须是 overlay 里声明的那个键（三者不同源就会在 initialize 阶段报 no adapter）
    expect(recorder.options?.provider).toBe(DSH_ROUTE_KEY);
    // overlay 路径必须是**绝对路径**：SDK 用 `resolve(callerCwd, path)` 解析，而 callerCwd 是宿主进程的
    // cwd ⇒ 相对路径会让文件落到别处（甚至不在候选的 .agenthome 里）。
    // ⚠️ 这条断言同时是夹具的守卫：夹具的 configHome 若写盘符字面量（`D:/tmp/…`），它在 POSIX 上
    // 不是绝对路径——这候选会当场红，而不是悄悄把 overlay 写进仓库根。
    const patches = recorder.options?.patches as string[] | undefined;
    expect(patches).toHaveLength(1);
    expect(isAbsolute(patches?.[0] ?? '')).toBe(true);
    expect(patches?.[0]).toBe(join(FIXTURE_CONFIG_HOME, DSH_ROUTE_PATCH_RELATIVE_PATH));
    expect(recorder.prompt).toBe('把 README 的标题改成「示例项目」，然后结束。');
  });

  /**
   * 退役旧凭据通道：**显式删除**，而不是「不再注入」。
   *
   * 为什么必须单独一条：`buildSubprocessEnv` 以**宿主环境为底**展开，而开发机上 `DEEPSEEK_API_KEY`
   * 很常见。只「不再注入」的实现会让宿主的密钥被子进程继承，于是那条已无人配置的
   * `deepseek-official` 路由静默可用（安装态 0.1.7 的 llm-deepseek 账号 token 优先于 API key）
   * ⇒ 悄悄跑到公网并计费；`web_search` 也会拿它去打搜索接口。
   * 「只是不再注入、不写 undefined」这种实现只有这条用例能杀——其余用例在那种实现下全绿。
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
   * 冷启动握手预算。
   *
   * 为什么这条必须存在：SDK 的 `initializeTimeoutMs` 默认 **10s**（`launch.d.ts` 的
   * `DEFAULT_INITIALIZE_TIMEOUT_MS = 10000`），而本适配器每次都跑在**全新的 `configHome`** 上
   *（不变量 3）⇒ 每次都是冷启动。实测：默认值下两条协议**双双**
   * `initialize timed out after 10000ms waiting for dsh profile "sdk"`，被折成 `AGENT_FAILED`，
   * 界面上只看到「这个候选失败了」；少了 `startDsh` 里这个候选，本用例当场红（`undefined`）。
   */
  it('冷启动握手预算显式给足：不吃 SDK 的 10s 默认值', async () => {
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
    // 冒烟实测到的启动形状正是那一档，而它的 approval 是 `ask`：越界操作会挂在无人应答的批准上。
    // 同一个变量在 `danger-full-access` 下同时把 approval 设成 `never`（同一份 yml 的 `approval` 行），
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

  it('收到 outputSchema ⇒ 走填充层跑完：结果记 applied.structuredOutput=false', async () => {
    // 口径：`outputSchema` 表达的是「我想要」，而**骨架一律把它交给 `start`**（不替厂商摘键）。
    // dsh 没有原生 schema 通道 ⇒ 走适配器内的填充层：把约束写进首轮提示词（断言的落点是
    // 「填充层：提示词注入与同会话修正」那一组），形状由骨架的自校验 + 最多两轮同会话修正兜住。
    // 这里**不**断言「报中文错且不构造运行时」：那条口径会让一次本来就能跑的评分直接失败，
    // 而「提示词约束 + 自校验 + 修正轮」才是没有原生通道的这一家该有的收场。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });

    const result = await dshProvider.run(createRunInput({ outputSchema: { type: 'object' } }));

    expect(result).toMatchObject({ ok: true, exitReason: 'completed' });
    expect(result.applied).toEqual({ structuredOutput: false });
    // 没有原生通道不是失败：运行时照常构造、照常释放（与下面「显式 null」那一格同一收场）
    expect(recorder.options).not.toBeNull();
    expect(recorder.closeCount).toBe(1);
  });

  it('outputSchema 显式为 null ⇒ 与「没给」同义：不注入、不报错，正常跑完', async () => {
    // 空值口径与 codex 逐字统一：判据是「非对象（含 null）就按没给处置」。
    // `null` 在这条路径上与「没给」同义——它表达的是「这一格没有值」，不是「要一份 schema」；
    // 三个适配器不能各写一套口径（出口侧与入口侧都封过「假值被当成有效值」那一族）。
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
    // 端到端跑动里出现过同一轮两条内容相同的 usage）。
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
    // 用户口径：事件里的 tokens 是「到目前为止」的累计（覆盖语义），所以第二个 step 交出的
    // 必须是两段之和；「取走即归零」会让第二轮看起来**更便宜**。
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

  it('失败的运行：turn/end(kind:error) ⇒ 结果 error，不是「界面显示成功、实际没干活」', async () => {
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

  it('终止：interrupt 不被响应 → 5 秒后落 WARN → 关闭运行时恰好一次，结果为 canceled', async () => {
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
    // 先钉「可见信号」（非合作的适配器必须可见，不能静默），再钉计数——
    // 与 codex 的同类用例同一顺序，也让「第二段没跑」这类缺陷红在最有信息量的那条断言上
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

  it('运行中未识别通知同样保留原始负载（不得静默丢弃）', async () => {
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

  it('包已安装但导出面不匹配：AGENT_LOAD_FAILED，且文案**不含** `pnpm add`', async () => {
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

  it('握手失败：折进 AGENT_FAILED，run() 不抛，且没有「被关闭的对象」就不去关', async () => {
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

  it('通知流运行中抛出：折进 AGENT_FAILED，且运行时**仍然被释放**（失败路径不泄漏）', async () => {
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
    expect(events.some((event) => event.type === 'error')).toBe(true); // 失败也要进该候选的事件日志
    expect(recorder.closeCount).toBe(1); // 释放路径在失败出口上照样走完（dispose 恰好一次）
  });
});

/**
 * overlay 的**落点与内容**：适配器在**运行时启动之前**把
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
   * 自定义请求头落在**写出来的 overlay 文件**里（不是只在纯函数里成立）。
   *
   * 为什么还要一条跑一遍真落盘的：`buildDshRoutePatch` 的纯函数用例证明「给了就写」，
   * 证明不了「适配器把入参交给了它」——漏传那一格时文件照写、路由照常，只是**一条头都没有**，
   * 任何事件与结果里都看不出来。这条走 `dshProvider.run` + 真 `configHome`，判据是磁盘事实。
   */
  it('自定义请求头写进落盘的 overlay；不给时文件里没有 headers 块', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    try {
      setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: createRecorder(), events: [] }) } });

      await dshProvider.run(createRunInput({ configHome: home, route: ROUTE, requestHeaders: { 'X-Trace-Id': 'abc' } }));
      const written = readFileSync(overlayPath(home), 'utf8');
      expect(written).toContain('        headers:');
      expect(written).toContain('          "X-Trace-Id": "abc"');

      await dshProvider.run(createRunInput({ configHome: home, route: ROUTE }));
      expect(readFileSync(overlayPath(home), 'utf8')).not.toContain('headers:');
    } finally {
      removeTreeWithRetry(home);
    }
  });

  /**
   * 模型名里带 `"` / `\` / `:` 时写出的 YAML 必须能**原样读回**（转义口径）。
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
 * 思考强度（未选不等于「不传」）。
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
 * `ask_user_question` 的工具挂载（用户口径）：
 * `@deepseek-ai/dsh-tool-ask-user` **已随 dsh 装好**，但 `dsh-base` 与 `dsh-sdk-app` 两个 bundle
 * 都**没有**把它装进 profile（只有 `dsh-web-app` 的 preset 有）⇒ 适配器必须补一行 insert。
 *
 * **落点已搬进 overlay**：`insert` 与路由同住一份 per-launch patch，而不是写
 * `profiles/sdk/cordis.patch.yml`——那是 dsh 自己的持久化层（Settings / config-editor 会写它），
 * 适配器整份重写它会让两份来源混在一个文件里。
 *
 * 判据是磁盘上的文件内容：只看适配器内部算了什么，证明不了 dsh 读得到。
 * 实测依据：`dsh --profile sdk --patch <overlay> --dump-config` 下 `tool-ask-user` 由 0 处变 2 处、
 * 无 patch 告警，且**不需要**改 profile 的 `dependencies`（dsh 从自身安装解析插件）。
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
       * **照样全绿**（实测过的守卫无区分力），而生产上那一个候选会以
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
      /**
       * 等待档**逐字**钉住（四行必须连续、顺序不许换）：本仓没有应答面，阻塞档下模型一问就拿到
       * `NO_PROVIDER` 工具错误，而有限 `timeout` 的定时档到点交回的是「尚未答复」这个设计好的结果。
       * 判据取整块而不是逐行 `toContain`：逐行写的话，「配置挂到了别的插件候选上」与
       * 「`mode` 被写成阻塞档」两种坏法都能溜过去（两行各自都还在文件里）。
       * ⚠️ `timeout` 必须是有限正整数——`-1` 会回落阻塞档，等于这条止血没做。
       */
      expect(snapshotAtBoot).toContain(
        ['      name: "@deepseek-ai/dsh-tool-ask-user"', '      config:', '        mode: "timed"', '        timeout: 1'].join(
          '\n',
        ),
      );
      /**
       * stream-tap 的挂载行：**相对名**（`./aieval-stream-tap.mjs`，按 profile 目录
       * 解析）+ 插件本体在装配时刻就落盘。少了 insert 行，runtime 起来后没有任何人写旁路文件
       * ⇒ delta 一条都不到——那是静默的空（能力声明 `yes` 与实现不一致，界面打字机不动）。
       */
      expect(snapshotAtBoot).toContain('id: aieval-stream-tap');
      expect(snapshotAtBoot).toContain('name: "./aieval-stream-tap.mjs"');
      expect(readFileSync(join(home, DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH), 'utf8')).toBe(DSH_STREAM_TAP_PLUGIN_SOURCE);
      // 旁路文件装配时刻**清零**（重跑同一行绝不能重放上一轮尝试的增量行）
      expect(statSync(join(home, DSH_STREAM_TAP_RELATIVE_PATH)).size).toBe(0);
      /**
       * 权限：旁路文件里是**模型输出的逐字转录**，必须在**这里**就是 0600——插件那边的
       * `appendFileSync(..., { mode: 0o600 })` 对已存在的文件不改权限（真机实测过 0644）。
       */
      expect(statSync(join(home, DSH_STREAM_TAP_RELATIVE_PATH)).mode & 0o777).toBe(0o600);
      // ② 运行结束后仍在
      expect(readFileSync(overlayPath(home), 'utf8')).toContain('tool-ask-user');
      expect(readFileSync(overlayPath(home), 'utf8')).toContain('aieval-stream-tap');
      /**
       * ③ **反向断言**：旧落点一个都不许出现。
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
 * **提问应答面的装配**：这一轮挂没挂应答面（= 调用方传了 `onAskUser`）是**同一个自变量**，
 * 它同时决定 overlay 里那一行与插件落盘（见 `ask-user.ts` 的文件头）。
 *
 * 判据是**磁盘上的文件**：只看适配器内部算了什么，证明不了 dsh 读得到（装配清单在 boot 那一步读，
 * 写晚了这个候选照样「跑完」，只是没人认领那一问——那是静默的空）。两条一正一反缺一不可：
 * 只钉「挂了就有」会让「没挂也有」这种回归（插件白挂、文件白落）无人出声。
 */
describe('dsh 的提问应答面装配（ask-user）', () => {
  const ROUTE = {
    protocolType: 'anthropic' as const,
    baseUrl: 'https://gw.example.com/anthropic',
    apiKey: 'sk-test-key',
    modelId: 'GLM-5.3',
  };
  const askUserReply = async (): Promise<AskUserReply> => ({ outcome: 'answered', answers: [] });
  const overlayPath = (home: string): string => join(home, DSH_ROUTE_PATCH_RELATIVE_PATH);

  it('挂了应答面 ⇒ 装配时刻 overlay 里就有应答者那一行，插件与两份 sidecar 都落盘（清零）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    try {
      // 时序判据同 `tool-ask-user` 那条：快照点取 `new DeepSeekHarness(...)` 那一刻
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

      await dshProvider.run(createRunInput({ configHome: home, route: ROUTE, onAskUser: askUserReply }));

      // ① 那一行在装配清单里（**相对名与 stream-tap 同形**：相对名按 `<dshHome>` 解析）
      expect(snapshotAtBoot).toContain(['    - id: aieval-ask-answerer', '      name: "./aieval-ask-answerer.mjs"'].join('\n'));
      // 等待档与应答面同源派生：有人能被问到 ⇒ 阻塞档（`-1`：既不到点收场、又带 `wait.callId`）
      expect(snapshotAtBoot).toContain(['        mode: "timed"', `        timeout: ${DSH_ASK_WAIT_TIMEOUT_ANSWERED_SECONDS}`].join('\n'));
      // ② 插件本体在装配时刻就落盘，且逐字是那一份源码
      expect(readFileSync(join(home, DSH_ASK_ANSWERER_PLUGIN_RELATIVE_PATH), 'utf8')).toBe(DSH_ASK_ANSWERER_PLUGIN_SOURCE);
      expect(readFileSync(join(home, DSH_ASK_ANSWERER_PLUGIN_RELATIVE_PATH), 'utf8')).toContain('user-questions/request');
      // ③ 两份 sidecar **整份清零**（追加型：重跑同一行时上一轮的提问与答复绝不能被当成本次的）
      expect(statSync(join(home, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH)).size).toBe(0);
      expect(statSync(join(home, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH)).size).toBe(0);
      // ④ 权限 0600（提问正文与人的答复；`appendFileSync` 的 mode 对已存在文件是空操作，只能在这里给）
      expect(statSync(join(home, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH)).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH)).mode & 0o777).toBe(0o600);
    } finally {
      removeTreeWithRetry(home);
    }
  });

  it('不传回调 ⇒ overlay 里没有那一行、插件与 sidecar 都不落盘（零回归）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    try {
      setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: createRecorder(), events: [] }) } });

      await dshProvider.run(createRunInput({ configHome: home, route: ROUTE }));

      const overlay = readFileSync(overlayPath(home), 'utf8');
      expect(overlay).not.toContain('aieval-ask-answerer');
      // 提问工具那一行照旧在（它是厂商的包，与应答面无关），等待档留在定时档那一格
      expect(overlay).toContain('id: tool-ask-user');
      expect(overlay).toContain(['        mode: "timed"', `        timeout: ${DSH_ASK_WAIT_TIMEOUT_UNANSWERED_SECONDS}`].join('\n'));
      expect(existsSync(join(home, DSH_ASK_ANSWERER_PLUGIN_RELATIVE_PATH))).toBe(false);
      expect(existsSync(join(home, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH))).toBe(false);
      expect(existsSync(join(home, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH))).toBe(false);
    } finally {
      removeTreeWithRetry(home);
    }
  });
});

/**
 * overlay patch 生成器：**纯函数**，输入即全部事实。
 *
 * 为什么单独一组用例：这份文本是「本仓的路由事实」到「pi-ai 路由配置」的**唯一**翻译点，
 * 三件事都只在这里发生——协议选 wire、baseURL 按 wire 归一化、档位映射成 wire 拼写。
 * 它错了不会在本仓炸，而是让 dsh 子进程在 `initialize` 阶段以
 * `no adapter registered` / `UNKNOWN_MODEL` / `UNSUPPORTED_REASONING_EFFORT` 收场，
 * 报错点离原因很远（这三条失败通道有真机记录）。
 */
describe('buildDshRoutePatch', () => {
  const base = {
    protocolType: 'anthropic' as const,
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: 'deepseek-flash',
  };

  /**
   * 整份 overlay **逐字**：窗口与上限未知（那两个键就不写）时的完整产物。
   *
   * 为什么要有这一条（下面那些 `toContain` 各自只证明「某一行在文件里」）：dsh 读的是**整份**装配
   * 清单，所以「其余候选没被顺手改动」本身就是要守的性质——路由块、模型、档位映射、三条插件挂载行
   * 与它们的先后，全在这份字面量里。少了它，改动别的行（甚至删掉某一行）不会有任何用例出声；
   * 有了它，任何一处漂移都必须显式改这份字面量，改的人躲不过去。
   */
  it('整份 patch 逐字：路由 / 模型 / 档位 / 三条插件挂载（提问工具在定时档）', () => {
    expect(buildDshRoutePatch(base)).toBe(
      [
        '# 由 ai-result-evaluation 写入：本次运行的路由、模型与档位（overlay，叠在 profile 之上）',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      aieval-route:',
        '        api: anthropic-messages',
        '        baseURL: "https://gw.example.com/anthropic"',
        '        apiKeyEnv: AIEVAL_ROUTE_API_KEY',
        '        models:',
        '          - id: "deepseek-flash"',
        '            reasoningEfforts:',
        '              off: null',
        '              low: "low"',
        '              high: "high"',
        '              max: "max"',
        '',
        '# 新增行必须走 insert（顶层 `- id:` 只能覆盖既有行）——见 dsh-base 的文件头',
        '- insert:',
        '    - id: tool-ask-user',
        '      name: "@deepseek-ai/dsh-tool-ask-user"',
        '      config:',
        '        mode: "timed"',
        '        timeout: 1',
        '    - id: aieval-stream-tap',
        '      name: "./aieval-stream-tap.mjs"',
        '',
      ].join('\n'),
    );
  });

  /**
   * 模型请求重试次数的**落点**：`llm-pi-ai` 路由块里的 `retryPolicy`（不是某个插件的 config）。
   *
   * 为什么要钉位置与整块缺席：`retryPolicy` 是**每条路由自己的**配置（执行者是 `dsh-llm-retry`，
   * 它按 provider 查策略）；写到别处不会报错，只是永远不生效。缺省时整块不出现 —— 那才是
   * 「吃厂商 normal 档默认（5 次）」，与「显式写了 5」在厂商侧不是同一件事。
   */
  it('重试次数：给了 ⇒ 路由块里出现 retryPolicy（normal + maxRetries）；没给 ⇒ 整块不出现', () => {
    const bare = buildDshRoutePatch(base);
    expect(bare).not.toContain('retryPolicy');

    const withRetries = buildDshRoutePatch({ ...base, retries: 10 });
    expect(withRetries).toContain(
      ['        retryPolicy:', '          mode: normal', '          maxRetries: 10'].join('\n'),
    );
    const lines = withRetries.split('\n');
    const apiKeyAt = lines.indexOf('        apiKeyEnv: AIEVAL_ROUTE_API_KEY');
    const retryAt = lines.indexOf('        retryPolicy:');
    const modelsAt = lines.indexOf('        models:');
    expect(retryAt).toBeGreaterThan(apiKeyAt);
    expect(retryAt).toBeLessThan(modelsAt);
    // 0 = 不重试：同样照写，不许被 `||` 一类的兜底吞成厂商默认
    expect(buildDshRoutePatch({ ...base, retries: 0 })).toContain('          maxRetries: 0');
  });

  /**
   * 应答面那一格**同时**决定两件事：插不插应答者那一行、等待档取哪一档（`askUserAnswerer`）。
   * 判据是「两份 patch 的**逐行差集**恰好是这两处」——只 `toContain` 那一候选的话，
   * 「顺手改坏了别的行」「没挂时也插了」「等待档与应答面各写一份」三种坏法都能溜过去。
   */
  it('挂了应答面 ⇒ 只多应答者那一块、且等待档换成阻塞档；没挂 ⇒ 定时档 1 秒且一个字都不多', () => {
    const bare = buildDshRoutePatch(base);
    const answered = buildDshRoutePatch({ ...base, askUserAnswerer: true });
    const block = ['    - id: aieval-ask-answerer', '      name: "./aieval-ask-answerer.mjs"'];
    const bareLines = bare.split('\n');
    const lines = answered.split('\n');
    const added = lines.filter((line) => !bareLines.includes(line)).sort();
    const removed = bareLines.filter((line) => !lines.includes(line));
    expect(added).toEqual([...block, `        timeout: ${DSH_ASK_WAIT_TIMEOUT_ANSWERED_SECONDS}`].sort());
    expect(removed).toEqual([`        timeout: ${DSH_ASK_WAIT_TIMEOUT_UNANSWERED_SECONDS}`]);
    // 两档都写在同一处（`mode: timed` 之下），档位名不许漂
    expect(answered).toContain(['        mode: "timed"', `        timeout: ${DSH_ASK_WAIT_TIMEOUT_ANSWERED_SECONDS}`].join('\n'));
    expect(bare).toContain(['        mode: "timed"', `        timeout: ${DSH_ASK_WAIT_TIMEOUT_UNANSWERED_SECONDS}`].join('\n'));
    expect(bare).not.toContain('aieval-ask-answerer');
  });

  /**
   * 自定义请求头：写进路由的 `headers` 块，**键值都过 YAML 引号转义**。
   *
   * 为什么判据是「YAML 读回来逐字相等」而不是「文件里出现了那个字符串」：头名里可能有 `-`、
   * 值里可能有 `:`（例如 `https://gw:8443`），裸写会被 YAML 解析成别的结构——而 dsh 那边
   * 读到的就是一份错的头表（或者整份 patch 解析失败）。空集那一半同样要钉：给了空表不许留一个空的
   * `headers:` 键（那在 llm-pi-ai 的 schema 里是「一条头都没有」之外的一种形状）。
   *
   * 用 `yaml` 打字面量太粗：这里按「键值两格逐行配对」读回，够证明引号与转义没坏。
   */
  it('自定义请求头：进路由的 headers 块，值里的冒号与引号原样读回；空集时这一块不出现', () => {
    const patch = buildDshRoutePatch({
      ...base,
      headers: { 'X-Trace-Id': 'abc', 'X-Url': 'https://gw.example.com:8443/a', 'X-Quote': 'say "hi"' },
    });
    const lines = patch.split('\n');
    const at = lines.indexOf('        headers:');
    expect(at, 'patch 里没有 headers 块').toBeGreaterThan(-1);
    const block = lines.slice(at + 1, at + 4);
    expect(block).toEqual([
      '          "X-Trace-Id": "abc"',
      '          "X-Url": "https://gw.example.com:8443/a"',
      '          "X-Quote": "say \\"hi\\""',
    ]);

    expect(buildDshRoutePatch(base)).not.toContain('headers:');
    expect(buildDshRoutePatch({ ...base, headers: {} })).not.toContain('headers:');
  });

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
      // ⇒ `path.slice(1)`），实测落到 `/v1/messages?beta=true` 与 `/v1/responses` 都正确。
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
    // `off: null` ⇒ 实测发 `thinking:{type:'disabled'}` / `reasoning:{effort:'none'}`
    expect(patch).toContain('off: null');
    expect(patch).toContain('low: "low"');
    expect(patch).toContain('high: "high"');
    // responses 的 OpenAI 枚举里没有 max，但实测七种拼写全部 200 ⇒ 原样透传
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
 * 身份就在 `params.childSessionId` 上（真机那一对是 `{parentSessionId, childSessionId}`），
 * 而它与随后子会话事件里的 `params.sessionId` 同值（真机核过）
 * ⇒ 用例里的 `sessionEvent(..., 'child-1')` 才认得出「这一条属于 child-1」。
 * `parentSessionId` 写占位 id（真机这里是主会话 id；夹具只改写 `params.sessionId` 那一格）。
 */
function subagentStarted(childSessionId: string): unknown {
  return {
    method: DSH_SUBAGENT_STARTED_METHOD,
    params: { childSessionId, parentSessionId: DSH_SESSION_PLACEHOLDER },
  };
}

/** 收场那一条（真机 `status` 只有 `ok` / `error`，`stopReason` 五档，见 `message.ts` 的映射表） */
function subagentFinished(childSessionId: string): unknown {
  return {
    method: DSH_SUBAGENT_FINISHED_METHOD,
    // 真机另有这三格（`provider` / `parentSessionId` / `lastAssistantMessage`），R8-A 的原始捕获逐字如此
    params: {
      provider: 'spawn',
      agentId: childSessionId,
      parentSessionId: DSH_SESSION_PLACEHOLDER,
      childSessionId,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: '子任务完成。' }],
    },
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
 * 子智能体那一份用量。
 *
 * 今天的事实（本任务**不改**）：dsh 的 `assistant/message` 与 `step/start` 两支**都不按会话分叉**
 * ⇒ `tokens` 与 `turns` 已经含子会话；本组钉的是新那一格——「其中的**子智能体分量**」，
 * 它**只按候选的子会话白名单**求和。
 *
 * 为什么白名单是重点：`sessionUsage` 是 `message.ts` 里**模块级**的表（同一个 Node 进程里并行跑着
 * 好几行），主会话之外还有**别的行**的会话 ⇒ 只有白名单能把这个候选圈出来。
 *
 * 两条**夹具层面**的事实（与真机的差别，先说清楚）：
 *   · 子会话的事件带的是**它自己的** `params.sessionId`（真机如此）⇒ `sessionEvent(..., 'child-1')`
 *     就是「这一条属于 child-1」；
 *   · 假 harness 会执行适配器交给 `subscribe` 的**会话过滤**，所以「别的候选的会话」那一条根本到不了
 *     投影（它既不是本会话、也不在白名单里）。「合计含子会话用量」这件事由第一条用例钉住
 *     （child-1 的 4 / 1 / 3 进了 `tokens`）；「别的行绝不算进来」钉的是**分量**只认白名单——
 *     去掉白名单（改成遍历 `sessionUsage` 全部键）时它会红：主会话那一笔就在表里。
 *
 * 时间线的一条（夹具比真机**更早**把状态备齐）：假 harness 一口气把整串通知投递进来，筛选回调在
 * **投递时**就跑完 ⇒ 投影看到第一条带用量的消息时，白名单/已收场集合**已经是终态**。
 * 这不影响本组的判据（判的是「分量怎么算」），但它让「收场那一刻的结论何时送到消费方」在这一层
 * 观察不到——第 4 条用例的注记说明了这一点。
 */
describe('子智能体那一份用量', () => {
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

  it('别的候选的会话（不在候选子会话白名单里）绝不算进来', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      MAIN_USAGE,
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { usage: { inputTokens: 999, cacheReadTokens: 0, outputTokens: 999 } }, 'other-row-session'),
    ]);
    // 合计仍会含它（dsh 的既成口径：投影不按会话分叉；那件事由第 1 条用例钉住——child-1 的
    // 4 / 1 / 3 确实进了 `tokens`），但**子那一份必须只算白名单**。
    // ⚠️ 夹具层面：这个会话不在白名单里，会被会话过滤**挡在投影之外**（见本组的 JSDoc），所以下面钉的
    // 是「分量只认白名单」这件事本身——去掉白名单（遍历 `sessionUsage` 全部键）时它会红：
    // 主会话那一笔就在表里。
    expect(usageEvents(events).at(-1)?.subagentTokens).toMatchObject({ input: 0, cached: 0, output: 0 });
  });

  it('子会话已收场却一条用量都没有 ⇒ 子那一份 null（宁可不出数），合计仍含主会话', async () => {
    /**
     * ⚠️ 这一条**在实现之前也是绿的**，原因有两层，都值得知道：
     *   · 骨架那个局部量的初值就是 `null`（投影**整格缺席** = 保持原值，见 `turn.ts`），所以「还没实现」
     *     与「明确算成 null」在事件上长得一样 ⇒ 它的区分力不来自「有没有实现」，而来自
     *     **`dshSubagentUsage` 里那一支在不在**（去掉 `finishedSessions` 那支的实现正是被它杀掉的）；
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
   * 收尾那一格：`startDsh` 的 `TurnStart` 也要给 `finalize`，
   * 否则「子会话收场却没报到用量 ⇒ 没采到」这个结论**在整轮再也没有消息**时就送不出去——
   * 留在 `AgentRunResult.subagentTokens`（进而进行的快照）里的是骨架那个初值或上一版的旧数。
   * `finalize` 在 `finally` 里跑（正常 / 失败 / 被终止都跑，`turn.ts:611-626`），
   * 且 `subagentTokens` 的**显式 `null` 会覆盖**。
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
    //    （假 harness 一口气投递通知，所以「旧数残留」那一半在这个夹具里构造不出来）。
    const running = await runDshResultWith([subagentStarted('child-3')]);
    expect(running.subagentTokens).toMatchObject({ input: 0, cached: 0, output: 0 });
  });

  /**
   * 口径：`null` 那一格**不能是静默的**。第三档承诺「`null` 伴随一条
   * **点名**的 WARN」，运维据此分得清「没采到」与「确实没有子智能体」——codex
   * （`codex/transcript.ts` 的「未找到子线程 …」）与 claude（`cc/index.ts` 的
   * 「读不到子智能体 …」，用例 `cc/index.test.ts` 那条）都落了这条 WARN，
   * 而 dsh 原来在 `finalize` 里给的是 `drafts: []` ⇒ 一格 `null` 悄无声息。
   */
  /**
   * **技能面的「装了却没观测到目录」**：厂商首次发布且这次会话里零条技能时根本不投
   * `skill-catalog`（`dsh-tool-skill` 的 `if (!history.published && skills.length === 0) return;`），
   * 于是「我们装进去的技能被厂商**全丢了**」与「厂商就是没投」在 wire 上是同一格 `null` ⇒
   * 观测格读成「未能核验」、**行照跑照出分**。收尾必须有人说话（真机：10 条臂里 7 条一次 `[]`
   * 都没读到，其中 3 条磁盘上确实有物化好的技能、厂商一条都没认领）。
   */
  it('装了技能却整轮没观测到技能目录 ⇒ 一条点名 WARN；装了没观测到不是这一档就不出声', async () => {
    const skillRoot = mkdtempSync(join(tmpdir(), 'dsh-skill-warn-'));
    const sourceDir = join(skillRoot, 'probe-alpha');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: probe-alpha\ndescription: probe skill\n---\n\n正文\n', 'utf8');
    const skill = { name: 'probe-alpha', sourceDir };
    const noCatalog: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [STEP_START_EVENT, MAIN_USAGE] }) },
    });
    await dshProvider.run(
      createRunInput({ skills: [skill], onEvent: collectEvents(noCatalog) }),
    );
    const warns = noCatalog
      .filter((event) => event.type === 'log' && event.stream === 'stderr' && event.text.startsWith('[WARN] 本次运行装了'))
      .map((event) => (event.type === 'log' ? event.text : ''));
    expect(warns).toHaveLength(1);
    // 点名到**条数**与机制（否则读的人不知道该不该去查）
    expect(warns[0]).toContain('1 条技能');
    expect(warns[0]).toContain('未能核验');

    // 观测到目录 ⇒ 不出声（这一档是「核验过了」）
    const withCatalog: AgentEvent[] = [];
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [
            STEP_START_EVENT,
            MAIN_USAGE,
            sessionEvent('user/message', {
              source: { kind: 'skill-catalog' },
              content: [{ type: 'text', text: 'A skill is a reusable set of task-specific instructions.\n\n<available_skills>\n- `probe-alpha`: probe skill\n</available_skills>' }],
            }),
          ],
        }),
      },
    });
    await dshProvider.run(createRunInput({ skills: [skill], onEvent: collectEvents(withCatalog) }));
    expect(
      withCatalog.filter((event) => event.type === 'log' && event.text.startsWith('[WARN] 本次运行装了')),
    ).toHaveLength(0);

    /**
     * **续接 / 追问段不报**（R5-B 的真机读数）：厂商的 `agent/pre-step` 先扫会话历史里那条
     * `skill-catalog`，摘要没变就直接 return（不重发）⇒「这一段没看到目录」在那里是**设计**。
     * 不排除这一档，每一段追问都会误报一条「未能核验」。
     */
    const resumed: AgentEvent[] = [];
    const first = await dshProvider.run(
      createRunInput({ skills: [skill], onEvent: collectEvents([]) }),
    );
    setAgentRuntimeForTesting({
      sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [STEP_START_EVENT, MAIN_USAGE] }) },
    });
    await dshProvider.run(
      createRunInput({
        ...(first.sessionId === null ? {} : { resume: { sessionId: first.sessionId } }),
        skills: [skill],
        onEvent: collectEvents(resumed),
      }),
    );
    expect(
      resumed.filter((event) => event.type === 'log' && event.text.startsWith('[WARN] 本次运行装了')),
    ).toHaveLength(0);

    // 一条技能都没装 ⇒ 厂商不投是设计，不许刷噪声
    const noSkills: AgentEvent[] = [];
    setAgentRuntimeForTesting({
      sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [STEP_START_EVENT, MAIN_USAGE] }) },
    });
    await dshProvider.run(createRunInput({ onEvent: collectEvents(noSkills) }));
    expect(
      noSkills.filter((event) => event.type === 'log' && event.text.startsWith('[WARN] 本次运行装了')),
    ).toHaveLength(0);
  });

  /**
   * **释放前等子智能体收场**：`run()` 在**根**会话 idle 时就落定（厂商门面如此），而后台派出去的
   * 子智能体可能还在跑（真机实测落定后子会话又跑了 8.6 s）。此时释放运行时等于把它们连根拔掉：
   * `subagent.finished` 永远不来、子智能体那一份用量与轮次只到一半。`session/wait` 正是补这条缺口
   * 的原语（等整棵子树收场），门面没包、只能走 `client.request`。
   *
   * 四档：还有子会话在跑 ⇒ 恰好调一次且带候选 sessionId；全部收场 ⇒ 一次都不调（零开销）；
   * 已终止 ⇒ 不等（停机不能被一分钟的等待拖住）；请求失败 ⇒ 吞掉且不改结论。
   */
  describe('释放前等子智能体收场（session/wait）', () => {
    it('还有子会话在跑 ⇒ 恰好一次 `session/wait`；全部收场 ⇒ 一次都不调', async () => {
      const live = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: live,
            events: [STEP_START_EVENT, MAIN_USAGE, subagentStarted('child-live'), assistantReply('收尾。')],
          }),
        },
      });
      const result = await dshProvider.run(createRunInput());
      expect(result.ok).toBe(true);
      expect(live.requestCalls).toHaveLength(1);
      expect(live.requestCalls[0]?.method).toBe('session/wait');
      expect(live.requestCalls[0]?.params).toEqual({ sessionId: result.sessionId });

      const done = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: done,
            events: [
              STEP_START_EVENT,
              MAIN_USAGE,
              subagentStarted('child-done'),
              subagentFinished('child-done'),
              assistantReply('收尾。'),
            ],
          }),
        },
      });
      await dshProvider.run(createRunInput());
      expect(done.requestCalls).toEqual([]);
    });

    /**
     * **等不到就把话说明白**：`session/wait` 失败（子会话永远不收场 / 到点 / 被外部 dispose）时，
     * 白名单里那些还没收场的子会话马上会被掐死 —— 「还在跑、以后会报」是假话。分量必须按
     * 「事实缺失」交 `null` 并点名，不能按 0 计入（真机形状：被杀的子任务交 `{0,0,0}` + `turns 1`，
     * 而它永远不会再报）。
     */
    /**
     * **终止要能打断等待**（R5-A 的真机读数：6.059 s 按停止，那一次 `session/wait` 照旧跑满
     * 60 003 ms，`run.json` 最后还给 `completed`）。等待发生在收流之前 ⇒ 骨架的 `requestStop()`
     * 此刻正好能把它打断。判据是**墙钟**：挂住的请求 + 中途 abort ⇒ 收尾立刻继续。
     */
    /**
     * **插件加载了但拿不到 `agents` 服务**（R5-A 的漏报面）：加载收据里的 `hasAgents: false` 此前
     * 只落一条 debug ⇒ 「投递恒 `agent-not-found`」在收尾零留痕。加载收据在（不是「没加载」）
     * 但拿不到服务 ⇒ 单独一条 WARN（与「没等到收据」那条分开说）。
     */
    it('等待当中被终止 ⇒ 不跑满上限，立即收场（结论不变）', async () => {
      const events: AgentEvent[] = [];
      const controller = new AbortController();
      const recorder = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder,
            events: [STEP_START_EVENT, MAIN_USAGE, subagentStarted('child-hang'), assistantReply('收尾。')],
            requestHangs: true,
          }),
        },
      });
      // 收流落定后 30ms 按停止：这一拍必定落在 drain 的等待里（挂住的请求不会自己结束）
      setTimeout(() => controller.abort(), 30);
      const startedAt = Date.now();
      const result = await dshProvider.run(createRunInput({ signal: controller.signal, onEvent: collectEvents(events) }));
      const elapsed = Date.now() - startedAt;
      expect(recorder.requestCalls).toHaveLength(1);
      // 远小于 `DSH_SUBAGENT_DRAIN_MS`（60 s）：被终止打断，不是跑到上限
      expect(elapsed).toBeLessThan(5_000);
      // 结论按「被终止」那一档收（`ok` 与退出原因由骨架定，这一格的判据是**墙钟**）
      expect(result.exitReason).toBe('canceled');
    });

    it('等不到子会话收场 ⇒ 分量交 null 且点名（不按 0 计）', async () => {
      const events: AgentEvent[] = [];
      const recorder = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder,
            events: [STEP_START_EVENT, MAIN_USAGE, subagentStarted('child-never'), assistantReply('收尾。')],
            requestError: new Error('session agent was disposed outside the server'),
          }),
        },
      });
      const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
      // 分量两格都是 null（不是 0、也不是半份读数）
      expect(result.subagentTokens).toBeNull();
      expect(result.subagentTurns).toBeNull();
      const warns = events
        .filter((event) => event.type === 'log' && event.stream === 'stderr' && event.text.startsWith('[WARN] 释放运行时之前没能等到子会话'))
        .map((event) => (event.type === 'log' ? event.text : ''));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('child-never');
      // 结论不变：运行本身照旧成功
      expect(result.ok).toBe(true);
    });

    it('已终止 ⇒ 不等；请求失败 ⇒ 吞掉、结论不变', async () => {
      const aborted = createRecorder();
      const controller = new AbortController();
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: aborted,
            events: [STEP_START_EVENT, MAIN_USAGE, subagentStarted('child-abort'), assistantReply('收尾。')],
          }),
        },
      });
      controller.abort();
      await dshProvider.run(createRunInput({ signal: controller.signal }));
      expect(aborted.requestCalls).toEqual([]);

      const failing = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: failing,
            events: [STEP_START_EVENT, MAIN_USAGE, subagentStarted('child-fail'), assistantReply('收尾。')],
            requestError: new Error('session agent was disposed outside the server'),
          }),
        },
      });
      const result = await dshProvider.run(createRunInput());
      expect(result.ok).toBe(true);
      expect(failing.requestCalls).toHaveLength(1);
    });
  });

  it('子会话收场却无用量 ⇒ 一条**点名**的 WARN（null 那一格不能是静默的）', async () => {
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
   * 身份**三级兜底**必须与白名单登记**同源**：规范描述的那一支形状
   * （`agentId` / `childSessionId`，真机给 `subagentId`）只被 `noteChildSession` 认、
   * 而 `noteFinishedChildSession` 只认 `subagentId` 的话，收场那一条就白来了——
   * 白名单里的子会话被当成「还在跑」⇒ `null` 静默降级成 `{0,0,0}`（把「没采到」说成「确实没有」）。
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
   * 两把尺子不互相顶替（守卫 4 / 5）：`usage.turn` 是**该会话自己的往返号**
   * （这条读数属于哪个会话的第几次模型往返，按会话单调编号、与别的会话无关），
   * 而 `turns` 仍是**全树合计**（`step/start` 一个都不落）。
   * 把 `turns` 改成每会话 ⇒ 这里读到的合计会掉回 2（主会话自己的步数）。
   */
  it('归属按该会话自己的往返号走，而 `turns` 仍是全树合计（两把尺子不互相顶替）', async () => {
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
 * 子智能体那一份**轮次**。
 *
 * 与用量那一组是同一件事的两半，但 dsh 的**取数面不同**：`turns` 从第一天起就是全树口径
 * （`step/start` 那一支不按会话分叉，`events.ts` 的既成口径）⇒ 分量必须**另按会话数**，
 * 而圈出「候选的子会话」的唯一依据仍是**同一份白名单**。
 *
 * 三条口径与用量**逐字相同**（三档）：
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
describe('子智能体那一份轮次', () => {
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

  /**
   * **跨 run 不累积**（真机形状：追问 / 续接的第二个 run 会**重新登记**同一个子会话 id）。
   *
   * `sessionUsage` 与按会话的往返计数都是**模块级、跨 run 不清**的（同一个 Node 进程里还跑着别的行），
   * 而「子智能体那一份」问的是**本 run** 的增量 ⇒ 少了基线，第二个 run 的分量会把前一个 run 一起算上：
   * 真机形状是候选快照上出现「合计 60 / 子分量 2010」。基线在 `noteChildSession` 首次登记时记下。
   */
  it('同一个子会话 id 在第二个 run 里再登记 ⇒ 分量只算本 run 那一段', async () => {
    const recorder = createRecorder();
    const childUsage = (input: number): unknown =>
      sessionEvent(
        DSH_ASSISTANT_MESSAGE_TYPE,
        { turn: 1, step: 1, usage: { inputTokens: input, cacheReadTokens: 0, outputTokens: 1 } },
        'child-1',
      );
    // 第一个 run：子会话跑两步、报了 2000
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [
            STEP_START_EVENT,
            subagentStarted('child-1'),
            sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'),
            sessionEvent('step/start', { turn: 1, step: 2 }, 'child-1'),
            childUsage(2000),
          ],
        }),
      },
    });
    const first = await dshProvider.run(createRunInput());
    expect(first.subagentTokens?.input).toBe(2000);
    expect(first.subagentTurns).toBe(2);

    // 第二个 run：**同一个子会话 id 又说话**（追问 / 续接），本轮只有 10 / 一步
    const sessionId = first.sessionId;
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [
            sessionEvent('step/start', { turn: 2, step: 1 }),
            subagentStarted('child-1'),
            sessionEvent('step/start', { turn: 2, step: 1 }, 'child-1'),
            childUsage(10),
          ],
        }),
      },
    });
    const second = await dshProvider.run(
      createRunInput(sessionId === null ? {} : { resume: { sessionId } }),
    );

    // 分量只算本 run：10 / 1（不是 2010 / 3）
    expect(second.subagentTokens?.input).toBe(10);
    expect(second.subagentTurns).toBe(1);
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

  it('别的候选的会话（不在候选白名单里）的 step 绝不算进分量', async () => {
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
   * `null` 那一格**不能是静默的**：这一格与用量同源，所以**同一条**点名 WARN 必须说清
   * 「给不出的是**哪一格**」。
   *
   * ⚠️ **措辞与判据一起定**：抄另两家的「这个候选的 tok / 缓存命中 / 轮次**不含**它们」不行——
   * 那句话在 codex / claude 上成立（那两家的
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
    expect(warns[0]).toContain('步数含');
    // ③ 另两家那句句式（「…/ 轮次**不含**它们」，在 dsh 上是假的）不许借过来：
    //    换成另两家那种句式 ⇒ ① 与 ③ 同时红
    expect(warns[0]).not.toContain('不含它们');
  });
});

/** 投影那一层的失败上下文（形状与既有直调用例一致：`events.test.ts` 的 `CONTEXT`） */
const PROJECT_CONTEXT = { kind: 'dsh', baseUrl: 'https://gw.example.com/anthropic' } as const;

/**
 * **三档**只能在投影这一层钉：
 *   · 值（没有子会话 ⇒ `{0,0,0}`；有 ⇒ 子会话之和）；
 *   · **显式 `null`**（已收场却没报到用量 = 事实缺失，宁可不出数）；
 *   · **键缺席**（这一条不谈它 ⇒ 骨架保持上一份，见 `turn.ts` 的 `TurnProjection.subagentTokens`）。
 *
 * 为什么不能只靠上面那组集成用例：投影整格缺席时，骨架交出来的事件里那一格是它**自己的初始 `null`**
 * ⇒「缺席」与「显式 null」在**事件层**长得一样（去重判据也按三元组比，那一格只参与「变了没」），
 * 只有直接看投影才分得开。这一组因此在**实现之前**就能红（`undefined` vs `null`）。
 */
describe('projectDshNotification：子智能体那一份的三档', () => {
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
   * 第三档（「本条不谈它」⇒ 键缺席）在 `turn/start` 这一支上钉。
   *
   * ⚠️ **这一条挂在 `step/start` 上**：`step/start` **两格分量都交**
   * （理由见 `events.ts` 那一支的注释）——合计在那里刚 +1，只交其中一格会让事件上出现
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
    // 让 `turn/start` 也带上它们 ⇒ 这几条断言当场红
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
   * `turn/end` **也谈它**：收尾那一条按既有口径
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
 *     **三条出口都同时带两格**（理由见 `events.ts` 那两支的注释）；
 *     而 `turn/start` / `tool/call` / `tool/result` 这些两格**都不带**（第三档「本条不谈它」，
 *     骨架保持上一份）——本组最后那条用例的落点因此是 `turn/start`，不是 `step/start`。
 */
describe('projectDshNotification：子智能体那一份轮次的三档', () => {
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
   * ⚠️ `step/start` 这一支**两格分量都交**：这一条刚把合计 +1，
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

/**
 * **订阅中途失败**（真机事故的守卫）：SDK 的 `fail()` 是静默的，把它当成「流正常结束」就会
 * 漏掉整段执行日志。真机形状：厂商会话日志 201 条事件、我们只收到前 13 条，
 * 之后 138 秒的内容一条不剩，**而行照旧判 judged、执行日志整段空白、任何日志里都没有线索**。
 *
 * 三条判据各自有靶子：
 *   ① 运行照常收场（内容缺失不是「适配器失败」——diff 与评分由产物独立成立）；
 *   ② 但必须留痕：**一条** stderr 的 log，指名通知流中断并带原因（否则现象无法解释）；
 *   ③ **不许忙循环**：订阅死了以后 `next()` 会立刻拒绝，若还把它放进 race 就是 100% CPU 空转
 *      （`recorder.subscriptionNextCalls` 是这条的判据——没有它，「不忙循环」只是个说法）。
 */
describe('dsh 通知订阅中途失败：如实报出、不忙循环', () => {
  it('放行 1 条之后订阅失败 ⇒ 一条 stderr log 指名中断，且 run 照常收场', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const boom = new Error('notification subscription failed (filter threw)');
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          // 真实序列：turn/start → step/start → assistant/message → step/end → turn/end
          events: [STEP_START_EVENT, USAGE_EVENT, TURN_END_EVENT],
          /**
           * 异步投递（夹具默认同步吐完）：真机的事件是在 `run()` 未落定期间陆续到达的，
           * 而订阅中途失败只发生在「消费者正等 `next()`」那条路径上——同步吐完的夹具
           * 一进循环就 `settled` 为真、永不调 `next()`，守卫会假绿。
           */
          emitAsync: true,
          failSubscriptionAfter: { notifications: 1, error: boom },
        }),
      },
    });

    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));

    // ① 收场方式不变：这一轮的产品（diff / 评分）不由通知流决定
    expect(result.ok).toBe(true);
    expect(recorder.closeCount).toBe(1);
    // ② 唯一线索：一条 stderr 的 log，带原因与「断在哪」
    const failure = events.filter((event) => event.type === 'log' && event.text.includes('通知流中断'));
    expect(failure).toHaveLength(1);
    const line = failure[0];
    expect(line?.type === 'log' ? line.stream : null).toBe('stderr');
    expect(line?.type === 'log' ? line.text : '').toContain(boom.message);
    expect(line?.type === 'log' ? line.text : '').toContain('已放行');
    // 中断之后的事件确实没进来 ⇒ 这条 log 是这个候选唯一的解释（`turn/end` 拿不到了）
    expect(events.some((event) => event.type === 'end')).toBe(false);
    // ③ 不忙循环：订阅失败后我们不再把立刻拒绝的 `next()` 放进 race
    //    （放宽到 50：正常路径每轮最多一次，忙循环在同样墙钟内是几千次）
    expect(recorder.subscriptionNextCalls).toBeLessThan(50);
  });
});

/**
 * **收尾竞速**：一批通知与 `run()` 落定撞进同一拍时，批头那条已经被 SDK 交给**在飞的** `next()`
 * （`push()` 是「有等待者就 resolve 它、没有才入队」），而竞速里 `runPromise.then(…)` 比
 * `pendingNext` 的三段链少两跳 ⇒ 判 run 赢；循环回到开头发现 `tryNext()` 是空的、`settled` 又是真，
 * 如果就此 break，那条值再没人读。
 *
 * 真机读数（约 160 次运行命中 1 次）：`deliveredNotifications: 25, receivedNotifications: 24,
 * sawTurnEnd: false`，同一轮照旧 `exitReason: 'completed'`。
 * **最坏形状就是下面这一条**：丢的那条正好是 `turn/end(kind:'error')` ⇒ 一次失败的运行被判成功
 * （`ok: true` / `exitReason: 'completed'`），而界面上只有一条服务端 WARN。
 */
/**
 * 有效 cwd 那一格只喂 DEBUG 日志（`resumedWorkingDirectory`），它背后是一次真实 wire 往返
 * （`session/working-directory/get`，runtime 已收场 / 超时都会拒）。写成不可失败的表达式时，
 * 一次纯读数的失败会把整轮折成 `AGENT_FAILED` —— 观测手段没有资格制造失败。
 */
describe('续接的 cwd 读数：读不到只记 null，不影响这一轮', () => {
  it('getWorkingDirectory 抛错 ⇒ 这一轮照常完成（不许折成 AGENT_FAILED）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'aieval-dsh-cwd-'));
    try {
      const recorder = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder,
            events: [sessionEvent('step/start', { turn: 1, step: 1 }), assistantReply('收尾。')],
            resumeWorkingDirectoryError: new Error('session/working-directory/get timed out'),
          }),
        },
      });

      const result = await dshProvider.run(
        createRunInput({ configHome, resume: { sessionId: 'session-cwd-读数失败' } }),
      );

      expect(result.ok).toBe(true);
      expect(recorder.resumedSessions).toEqual(['session-cwd-读数失败']);
    } finally {
      removeTreeWithRetry(configHome);
    }
  });
});

describe('dsh 收尾竞速：同拍批头那条通知不许被丢', () => {
  const ERROR_TURN_END = sessionEvent(DSH_TURN_END_TYPE, {
    turn: 1,
    reason: { kind: 'error', error: { message: 'terminated', code: 'TRANSPORT' } },
  });

  it('批头是 turn/end(kind:error) ⇒ 失败必须落到结论上（不许判 completed）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          // 先一步一条吐 `step/start`，收尾那两条（错误的 turn/end + idle）与 run 落定同拍
          events: [STEP_START_EVENT, ERROR_TURN_END],
          emitAsync: true,
          settleBatch: 2,
        }),
      },
    });

    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));

    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('error');
    // 厂商原文（更有归因价值的那一份）也要进事件流
    expect(events.some((event) => event.type === 'error' && event.message.includes('TRANSPORT'))).toBe(true);
  });

  it('批头是普通通知（非失败）⇒ 它照常进事件流（丢了就是静默少一条）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [STEP_START_EVENT, USAGE_EVENT, TURN_END_EVENT],
          emitAsync: true,
          settleBatch: 2,
        }),
      },
    });

    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));

    expect(result.ok).toBe(true);
    // 用量是那条同拍通知带出来的：丢了它，这一轮的 tokens 就是 null
    expect(result.tokens?.input).toBe(218);
    expect(result.turns).toBe(1);
  });

  it('run() 以拒绝收场时先把队列排空：已在队列里的那批通知照常进事件流，之后才抛真因', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const boom = new Error('transport closed while settling');
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          /**
           * 形状要**逼真**：`step/start` 先一条一拍地到（消费循环正等在 `next()` 上），
           * 收尾那批（错误的 `turn/end` + `idle`）与 `run()` 的拒绝同拍——
           * 于是拒绝发生时队列里确实压着厂商原文，而它会不会被读，取决于竞速那一臂怎么处置拒绝。
           */
          events: [STEP_START_EVENT, ERROR_TURN_END, USAGE_EVENT],
          emitAsync: true,
          settleBatch: 2,
          throwAfterEvents: boom,
        }),
      },
    });

    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));

    // 队列里那两条（错误的 turn/end + idle）在抛出之前就被投影：**厂商原文**留在证据里
    // （判据用 `terminated` 而不是 TRANSPORT：后者也会出现在 run 拒绝那条错误事件上，会假绿）
    expect(events.some((event) => event.type === 'error' && event.message.includes('terminated'))).toBe(true);
    // 真因仍然是 run() 的拒绝（SDK 异常），不是被吞掉
    expect(result.ok).toBe(false);
    expect(result.error?.message ?? '').toContain('transport closed');
  });
});

/**
 * **循环退出时的五种收场**（纯函数 `diagnoseStreamEnd`）：这是「执行日志为什么是空的」唯一答案来源。
 *
 * 为什么值得单独钉：真机上出现过**两种**互不相同的形状——
 *   ① 订阅被 SDK `fail()` 判死（过滤器抛错 / 传输死）⇒ 有报错可抓；
 *   ② **什么都没报，投送就是停了**（第二次重跑：厂商会话日志 245 KB 内容齐全，我们 13 条之后再无音信）。
 * 只做 ① 的话，② 依旧是一句无法解释的空白。而「没见过 turn/end」这一条判据必须**配一个静默时长**
 * 才敢下结论，否则夹具那种「事件吐完就落定」的形状会被误报成故障。
 * 第三档 `closed` 是**我们自己发起的关闭**：终止 / 看门狗 / 停机之后流断在这里是预期收场，
 * 一个字都不该报（否则每一次终止都会说「执行日志因此不完整」，而其实一条都没丢）。
 */
describe('diagnoseStreamEnd：投送为什么停（五态各自可辨 + 断点在哪一侧）', () => {
  it('见过 turn/end ⇒ ok（正常的收尾就是它）', () => {
    expect(
      diagnoseStreamEnd({ failure: null, delivered: 20, received: 20, sawTurnEnd: true, silentMs: 0, closing: false }),
    ).toEqual({ kind: 'ok' });
  });

  it('我们自己关的（closing）⇒ closed，**无论**有没有见过 turn/end、静默了多久', () => {
    // 终止路径的真实形状：关闭同步终结订阅、run 的 promise 随后才落定 ⇒ 没有 turn/end、
    // 静默时长恰好跨过 5 秒宽限（那是 release 的第一段等待，不是投送停滞）
    expect(
      diagnoseStreamEnd({ failure: null, delivered: 4, received: 4, sawTurnEnd: false, silentMs: 5_100, closing: true }),
    ).toEqual({ kind: 'closed' });
  });

  it('订阅被 fail() ⇒ failed，原因带 name: message（原文照抄给排障）', () => {
    const verdict = diagnoseStreamEnd({
      failure: new TypeError('x is not a function'),
      delivered: 13,
      received: 13,
      sawTurnEnd: false,
      silentMs: 120_000,
      closing: false,
    });
    expect(verdict.kind).toBe('failed');
    expect(verdict.kind === 'failed' ? verdict.reason : '').toBe('TypeError: x is not a function');
  });

  it('投送真的死过一次 ⇒ 即使随后走到终止也照报 failed（那次丢的是真内容）', () => {
    const verdict = diagnoseStreamEnd({
      failure: new Error('transport died'),
      delivered: 13,
      received: 13,
      sawTurnEnd: false,
      silentMs: 5_100,
      closing: true,
    });
    expect(verdict.kind).toBe('failed');
  });

  /**
   * **真机事故的形状**：客户端把 181 条全投递了（过滤器每条都会被调用、全部接受），
   * 而我们只消费了 15 条 ⇒ 断点在**我们这一侧的消费循环**（根因是生成器把 `next()` promise 遗弃成
   * 孤儿）。这条用例钉的是「原因里必须能读出这个差额」——只报「我们收到 15 条」会把矛头指向厂商。
   */
  it('投递 181 / 消费 15 ⇒ stalled 且原因点明「断点在我们这一侧的消费循环」', () => {
    const verdict = diagnoseStreamEnd({ failure: null, delivered: 181, received: 15, sawTurnEnd: false, silentMs: 138_000, closing: false });
    expect(verdict.kind).toBe('stalled');
    const reason = verdict.kind === 'stalled' ? verdict.reason : '';
    expect(reason).toContain('未收到 turn/end');
    expect(reason).toContain('181');
    expect(reason).toContain('15');
    expect(reason).toContain('我们这一侧的消费循环');
  });

  it('投递与消费相等 ⇒ 原因说「客户端也只投递了 N 条」，指向投送侧', () => {
    const verdict = diagnoseStreamEnd({ failure: null, delivered: 13, received: 13, sawTurnEnd: false, silentMs: 138_000, closing: false });
    expect(verdict.kind).toBe('stalled');
    const reason = verdict.kind === 'stalled' ? verdict.reason : '';
    expect(reason).toContain('客户端也只投递了 13 条');
    expect(reason).toContain('投送侧');
  });

  it('静默没超过阈值 ⇒ unknown 且**不报**（夹具那种「吐完就落定」不许被误报成故障）', () => {
    expect(
      diagnoseStreamEnd({ failure: null, delivered: 3, received: 3, sawTurnEnd: false, silentMs: 40, closing: false }),
    ).toEqual({ kind: 'unknown' });
  });
});

/**
 * **孤儿 `next()` 的回归守卫**（真机事故的根因，见 `notificationStream` 的注释）。
 *
 * 靶子：消费循环每 100 ms 被 `tapWake` 唤醒并**与 `subscription.next()` 竞速**；若每一轮都新建一个
 * `next()` 并在竞速输掉后把它遗弃，那份 promise 仍挂在 SDK 的 waiter 队列里 ⇒ 此后每条通知都被交给
 * **孤儿**（resolve 后丢弃），真正在等的那一个永远拿不到。真机形状：客户端投递 181 条、过滤器全部接受，
 * 而生成器只放行前 15 条（都在前 50 ms 内先入队的那批），之后 137 秒一条不剩、**零报错**、
 * `messages.jsonl` 为 0、行照旧判成功。
 *
 * 为什么必须把投递间隔调到 **150 ms（> 轮询拍 100 ms）**：默认的 2 ms 投递永远抢在 `tapWake` 之前，
 * 孤儿根本产生不了 —— 那条路径在夹具层是完全隐形的（这正是它此前全绿的原因）。
 * 判据取 `tokens`：它只由**最后那条** `assistant/message` 带出来，前两条被丢掉时它必为 `null`。
 */
describe('dsh 通知消费：慢投递不许丢帧（孤儿 next() 守卫）', () => {
  it('投递间隔 150ms > tap 轮询拍 100ms：三条通知（含用量与 turn/end）一条都不许丢', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder,
          events: [STEP_START_EVENT, USAGE_EVENT, TURN_END_EVENT],
          emitAsync: true,
          emitIntervalMs: 150,
        }),
      },
    });

    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));

    // 用量在**第三条**（+450ms，早于它的两次竞速都已输过）：丢了它就说明孤儿把通知吃掉了
    expect(result.tokens).toEqual({ input: 218, cached: 8832, output: 2, reasoningOutput: null, total: null });
    // 轮次与收尾同理：`turn/end` 是最后一条，收到它才算真的没丢
    expect(result.turns).toBe(1);
    expect(usageEvents(events).length).toBeGreaterThan(0);
  });
});

/**
 * MCP 的**注入落点与判据**（dsh）。
 *
 * 落点：per-launch overlay 的 `insert` 里每台一行 `@deepseek-ai/dsh-mcp-client`
 * （dsh 的插件方法表是封闭的 ⇒ 没有「程序化入口」那种东西）。
 *
 * 判据：`request/header` 事件的 `data.header.tools` —— **这是唯一判据**。dsh 起不来时工具
 * 静默从表里消失、会话照常跑完、我们这一侧没有结构化错误（四臂实测），
 * 所以「表在、里面没有 `mcp__<serverName>__*`」= 这一台没起来。工具名的形状与另两家一致。
 */
describe('dsh 的 MCP 注入与判据', () => {
  /** `request/header` 的逐字形状（真机：`data.header.tools` 是对象数组，取 `name` 那一格） */
  const header = (tools: readonly string[]): unknown =>
    sessionEvent(DSH_REQUEST_HEADER_TYPE, {
      header: {
        config: { provider: DSH_ROUTE_KEY, model: 'GLM-5.3' },
        tools: tools.map((name) => ({ name, description: `${name} 的说明` })),
      },
    });

  it('overlay 的 insert 里有每一台的插件行（`serverName` = 我们的名字、传输名是 dsh 的两档）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-mcp-'));
    try {
      const recorder = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) },
      });

      await dshProvider.run(
        createRunInput({
          configHome: home,
          mcpServers: {
            probe: { transport: 'stdio', enabled: true, command: 'node', args: ['/probe.mjs'], env: { P: '1' } },
            context7: { transport: 'http', enabled: true, url: 'https://mcp.context7.com/mcp', headers: { K: 'v' } },
          },
        }),
      );

      const overlay = readFileSync(join(home, DSH_ROUTE_PATCH_RELATIVE_PATH), 'utf8');
      expect(overlay).toContain('- id: mcp-probe');
      expect(overlay).toContain('- id: mcp-context7');
      expect(overlay).toContain('name: "@deepseek-ai/dsh-mcp-client"');
      expect(overlay).toContain('serverName: "probe"');
      expect(overlay).toContain('transport: stdio');
      expect(overlay).toContain('serverName: "context7"');
      expect(overlay).toContain('transport: streamable-http');
      // 路由行与两条既有 insert 一个都没被挤掉（overlay 是**整份重建**的，改一处别把别处写丢）
      expect(overlay).toContain('- id: llm-pi-ai');
      expect(overlay).toContain('id: tool-ask-user');
      expect(overlay).toContain('id: aieval-stream-tap');
    } finally {
      removeTreeWithRetry(home);
    }
  });

  it('一台都没配 ⇒ overlay 里一行 MCP 插件都没有（不写空壳行）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-mcp-'));
    try {
      const recorder = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) },
      });

      await dshProvider.run(createRunInput({ configHome: home }));

      const overlay = readFileSync(join(home, DSH_ROUTE_PATCH_RELATIVE_PATH), 'utf8');
      expect(overlay).not.toContain('dsh-mcp-client');
      expect(overlay).not.toContain('serverName:');
    } finally {
      removeTreeWithRetry(home);
    }
  });

  it('候选内 `.npmrc` 复刻宿主的 registry 那一行（dsh 也要——候选内首次注入 61 MB 就卡在这一格）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-mcp-'));
    try {
      const previous = process.env['npm_config_registry'];
      delete process.env['npm_config_registry'];
      try {
        const recorder = createRecorder();
        setAgentRuntimeForTesting({
          sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) },
        });
        await dshProvider.run(createRunInput({ configHome: home }));
        // 宿主的 `.npmrc` 有没有 registry 由这台机器决定：**有就复刻、没有就什么都不做**
        // （判据与 `writeCandidateNpmrc` 的守卫同源，这里只钉「这家也调了它」——本机有配置时文件必须在）
        const hostNpmrc = join(homedir(), '.npmrc');
        const hostHasRegistry = existsSync(hostNpmrc) && /^\s*registry\s*=/im.test(readFileSync(hostNpmrc, 'utf8'));
        expect(existsSync(join(home, '.npmrc'))).toBe(hostHasRegistry);
      } finally {
        if (previous !== undefined) process.env['npm_config_registry'] = previous;
      }
    } finally {
      removeTreeWithRetry(home);
    }
  });

  it('`request/header` 的工具表 → 一条 vendor-system（通道 `vendor-tool-table`、tools 逐字）', async () => {
    const events = await runDshWith([
      header(['bash', 'mcp__probe__probe_echo', 'mcp__other__x']),
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }),
    ]);

    const vendor = events.filter((event) => event.type === 'vendor-system');
    expect(vendor.length).toBe(1);
    expect(vendor[0]).toMatchObject({
      mcpChannel: 'vendor-tool-table',
      // 工具面逐字（**只取名字**：描述是几千字的英文，进事件流只会把它撑大）
      tools: ['bash', 'mcp__probe__probe_echo', 'mcp__other__x'],
      // 这一家没有「每台 MCP 一张状态表」那种东西 ⇒ 如实记 null，不编一个空数组
      mcpServers: null,
    });
  });

  it('工具表没变 ⇒ 不重复发（一个 step 一条 header，重复发会把事件流灌满同一份表）', async () => {
    const events = await runDshWith([
      header(['bash']),
      header(['bash']),
      header(['bash', 'mcp__probe__probe_echo']),
      header(['bash', 'mcp__probe__probe_echo']),
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }),
    ]);

    // 只在**变了**的那两条上发（第一条 + 工具出现的那一条），且各自带全量
    const vendor = events.filter((event) => event.type === 'vendor-system');
    expect(vendor.map((event) => (event.type === 'vendor-system' ? event.tools : null))).toEqual([
      ['bash'],
      ['bash', 'mcp__probe__probe_echo'],
    ]);
  });

  it('`data.header` 形状不对（没有 tools / 不是数组）⇒ 不发事件，绝不编一个空表', async () => {
    const events = await runDshWith([
      sessionEvent(DSH_REQUEST_HEADER_TYPE, { header: { config: {} } }),
      sessionEvent(DSH_REQUEST_HEADER_TYPE, { header: { tools: 'bash' } }),
      sessionEvent(DSH_REQUEST_HEADER_TYPE, {}),
    ]);

    // `[]` 在本仓的定义是「投送了、确实是空的」——拿一个读不动的形状去发它就是在说谎
    expect(events.some((event) => event.type === 'vendor-system')).toBe(false);
  });
});

/** 一次 `harness.run` 的原文：填充层的判据全落在这两格上（提示词与会话归属） */
interface DshRunCall {
  prompt: string;
  sessionId: string | undefined;
}

/**
 * 造一个**按调用次数换台词**的假 dsh SDK：订阅语义、会话归属改写、`idle` 收尾与关闭全部照旧走既有夹具，
 * 只在 `run()` 上包一层——先记下本次的提示词与会话 id，再把「这一轮该吐的通知」换进夹具共用的那张表。
 *
 * 为什么需要这一层：既有夹具一次运行只认一份事件表、也只在 `recorder.prompt` 上留**最后一次**提示词；
 * 而填充层的两条路径都发生在**两次 `run` 之间**（首轮把 schema 追加进提示词、答复不合格时同会话追问），
 * 判据正是「第一次收到了什么、第二次又收到了什么、两次的会话归属是否逐字相同」。
 * 时序上安全：夹具的 `run()` 在**调用期同步**读那张表，故换台词必须发生在 `super.run()` 之前。
 */
function createRoundDshSdk(options: {
  rounds: readonly (readonly unknown[])[];
  /** stream-tap 旁路行：夹具在**每一轮** `run()` 落笔（真机时序：增量长在文件里、通知流静默） */
  tapLines?: readonly unknown[];
}): {
    sdkModule: unknown;
    recorder: ReturnType<typeof createRecorder>;
    calls: DshRunCall[];
  } {
  const events: unknown[] = [];
  const recorder = createRecorder();
  const calls: DshRunCall[] = [];
  // 夹具的返回值是 `unknown`，这里收窄到「构造一个带 run 的 harness」——适配器用的其余成员照旧存在
  const base = createFakeDshSdk({
    recorder,
    events,
    ...(options.tapLines === undefined ? {} : { tapLines: options.tapLines }),
  }) as {
    DeepSeekHarness: new (clientOptions: Record<string, unknown>) => {
      run(prompt: string, runOptions?: { sessionId?: string }): Promise<unknown>;
    };
  };

  class RoundHarness extends base.DeepSeekHarness {
    /** 记下本次调用的原文，并把这一轮的通知换成 `rounds[n]`（n 从 1 数起，超出即空表） */
    override async run(prompt: string, runOptions?: { sessionId?: string }): Promise<unknown> {
      calls.push({ prompt, sessionId: runOptions?.sessionId });
      const round = options.rounds[calls.length - 1] ?? [];
      events.length = 0;
      events.push(...round);
      return super.run(prompt, runOptions);
    }
  }
  return { sdkModule: { DeepSeekHarness: RoundHarness }, recorder, calls };
}

/**
 * 一条 `assistant/message`（答复正文）：`data.message.content[]` 里 `type: 'text'` 的块是
 * `finalText` 的唯一来源（`dsh/events.ts` 的 `readAssistantText`）⇒ 结构化答复就靠它喂进去。
 */
function assistantReply(text: string): unknown {
  return sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text }] },
  });
}

/**
 * **填充层**：dsh 的 SDK 没有 schema 入参（原生通道不存在）⇒ 适配器用两件事对齐另两家——
 * 首轮把 JSON Schema 追加进提示词，答复不合格时用**同一个 `sessionId`** 在同一会话里追问。
 *
 * 这一组钉四件事：
 *   ① 首轮注入：给了 schema ⇒ 提示词以调用方原文**开头**并带上约束段；没给 ⇒ 与原文逐字相同；
 *   ② 非对象 schema（字符串 / 数组 / `null`）按「没给」处置：不注入、也不报错；
 *   ③ 同会话追问：第二次 `run()` 与第一次**逐字同一个** `sessionId`，提示词带问题清单与 schema 原文，
 *      答复合格后 `finalText` 取第二次那一份；
 *   ④ `applied.structuredOutput` 恒为 `false`：它记的是「有没有走原生通道」，填充层不算。
 *
 * 判据取「假 harness 收到了什么」而不是最终答复：注入与追问都发生在两次 `run` 之间，
 * 只看结果证明不了模型当时看到的是哪一份提示词。
 */
describe('填充层：提示词注入与同会话修正', () => {
  /**
   * 判据 schema：一个必填布尔字段 + 拒多余字段。
   * 三件都是承重的：`type` 与 `required` 决定问题清单的原文（`$.achieved：期望 boolean，实际 string`），
   * 而 `additionalProperties: false` 在提示词里以**可逐字断言的 JSON 字面量**出现
   * （缩进两格的 `"additionalProperties": false`）⇒ 断言它才证明 schema 原文真的进了提示词，
   * 而不是「提示词里提到了 schema」这种一改就假的弱判据。
   */
  const SCHEMA = {
    type: 'object',
    properties: { achieved: { type: 'boolean' } },
    required: ['achieved'],
    additionalProperties: false,
  };

  /** 调用方原文：多行 + 中文标点。`startsWith` 与 `toBe` 靠它划清「原文」与「追加段」的边界 */
  const CALLER_PROMPT = '数出工作区里 .ts 文件的个数。\n最后只回一个 JSON 对象。';
  /** 不合格的答复：`achieved` 是字符串 ⇒ 问题清单恰好一条（路径 `$.achieved`） */
  const INVALID_REPLY = '{"achieved":"yes"}';
  /** 合格的那一份 */
  const VALID_REPLY = '{"achieved":true}';

  it('给了 outputSchema ⇒ 首轮提示词以调用方原文开头，并追加「## 输出约束」与 schema 原文', async () => {
    const { sdkModule, calls } = createRoundDshSdk({ rounds: [[assistantReply(VALID_REPLY)]] });
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: sdkModule } });

    await dshProvider.run(createRunInput({ prompt: CALLER_PROMPT, outputSchema: SCHEMA }));

    expect(calls, '答复本来就合格 ⇒ 只该有一次 run（多出来的追问会白烧一次模型往返）').toHaveLength(1);
    const prompt = calls[0]?.prompt ?? '';
    // 追加段只能长在原文**之后**：前 N 个字符必须逐字是调用方原文（被 trim / 被改写都在这里见红）
    expect(prompt.slice(0, CALLER_PROMPT.length), '提示词必须以调用方原文逐字开头，追加段只能接在它后面').toBe(CALLER_PROMPT);
    expect(prompt, '提示词里必须有约束段的标题「## 输出约束」').toContain('## 输出约束');
    expect(prompt, '约束段必须带 schema 的 JSON 原文（additionalProperties 那一行逐字）').toContain(
      '"additionalProperties": false',
    );
    expect(prompt, '约束段必须带 schema 的属性名（缺了它模型不知道要出什么字段）').toContain('"achieved": {');
  });

  it('没给 outputSchema ⇒ 提示词与调用方原文逐字相同（一个字符都不多）', async () => {
    const { sdkModule, calls } = createRoundDshSdk({ rounds: [[assistantReply(VALID_REPLY)]] });
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: sdkModule } });

    await dshProvider.run(createRunInput({ prompt: CALLER_PROMPT }));

    expect(calls[0]?.prompt, '没要 schema 就不许往提示词里加任何东西：逐字相同，连换候选都不许多').toBe(CALLER_PROMPT);
  });

  it('outputSchema 是字符串 / 数组 / null ⇒ 按「没给」处置：不注入、也不报错', async () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['字符串', '{"type":"object"}'],
      ['数组', []],
      ['null', null],
    ];
    for (const [label, value] of cases) {
      const events: AgentEvent[] = [];
      const { sdkModule, calls } = createRoundDshSdk({ rounds: [[assistantReply(VALID_REPLY)]] });
      setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: sdkModule } });

      const result = await dshProvider.run(
        createRunInput({ prompt: CALLER_PROMPT, outputSchema: value, onEvent: collectEvents(events) }),
      );

      expect(calls[0]?.prompt, `${label} 形态的 schema 必须按「没给」处置：提示词逐字等于原文`).toBe(CALLER_PROMPT);
      expect(result.ok, `${label} 形态的 schema 不是失败：它与「没给」同义，照常跑完`).toBe(true);
      expect(events.some((event) => event.type === 'error'), `${label} 形态的 schema 不该落 error 事件`).toBe(false);
    }
  });

  it('首轮答复不合格 ⇒ 第二次 run 用逐字相同的 sessionId 追问，提示词带问题清单、schema 原文与「不要重新读取工作区」', async () => {
    const events: AgentEvent[] = [];
    const { sdkModule, recorder, calls } = createRoundDshSdk({
      rounds: [[assistantReply(INVALID_REPLY)], [assistantReply(VALID_REPLY)]],
    });
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: sdkModule } });

    await dshProvider.run(
      createRunInput({ prompt: CALLER_PROMPT, outputSchema: SCHEMA, onEvent: collectEvents(events) }),
    );

    expect(calls, '首轮答复不合格必须触发第二次 run（dsh 没有原生通道，修正只能靠追问）').toHaveLength(2);
    const firstId = calls[0]?.sessionId ?? '';
    // 先钉「第一次确实带了会话 id」：不钉的话 `undefined === undefined` 也会让下面那条相等断言通过
    expect(firstId, '第一次 run 必须带会话 id——没有它，「同会话」这条判据就是空的').not.toBe('');
    expect(calls[1]?.sessionId, '追问必须用与首轮逐字相同的 sessionId（新建会话 = 让模型把活重干一遍）').toBe(firstId);
    expect(recorder.order, '追问不建新运行时：整轮只有一次 start 与一次 dispose').toEqual(['start', 'dispose']);

    const feedback = calls[1]?.prompt ?? '';
    expect(feedback, '修正提示词必须点名问题（点号路径 + 期望/实际），模型才知道要改哪儿').toContain(
      '$.achieved：期望 boolean，实际 string',
    );
    expect(feedback, '修正提示词必须再给一次 schema 原文（追问是一份自足的提示词）').toContain(
      '"additionalProperties": false',
    );
    expect(feedback, '修正提示词必须带上模型自己上一次的答复原文').toContain(INVALID_REPLY);
    expect(feedback, '修正只修形状：必须明写不要重新读取工作区').toContain('不要重新读取工作区');
    // 修正轮必须**可见**（只进日志这一条是刻意的：界面上的「输出约束」仍只回答原生通道）
    const repairLogs = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''));
    expect(
      repairLogs.some((text) => text.includes('结构化输出未通过校验') && text.includes('第 1/2 步')),
      '修正轮必须落一条带步数的 WARN（否则「为什么多了一轮模型往返」在日志里查不到）',
    ).toBe(true);
  });

  it('修正轮答复合格 ⇒ result.finalText 是第二次的答复（骨架取最后一轮）', async () => {
    const { sdkModule } = createRoundDshSdk({
      rounds: [[assistantReply(INVALID_REPLY)], [assistantReply(VALID_REPLY)]],
    });
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: sdkModule } });

    const result = await dshProvider.run(createRunInput({ prompt: CALLER_PROMPT, outputSchema: SCHEMA }));

    expect(result.finalText, 'finalText 必须取**最后一轮**的答复（跨活动区间复用同一份 state.finalText）').toBe(
      VALID_REPLY,
    );
  });

  it('要了 schema 且真的跑了修正轮 ⇒ applied.structuredOutput 仍是 false（填充层不算原生通道）', async () => {
    const { sdkModule, calls } = createRoundDshSdk({
      rounds: [[assistantReply(INVALID_REPLY)], [assistantReply(VALID_REPLY)]],
    });
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: sdkModule } });

    const result = await dshProvider.run(createRunInput({ prompt: CALLER_PROMPT, outputSchema: SCHEMA }));

    // 前置：这一轮确实走了填充层（没有它，这条用例证明不了「填充层不算原生」）
    expect(calls, '前置：本轮必须真的追问过一次').toHaveLength(2);
    expect(result.applied, 'dsh 没有原生 schema 通道：填充层做没做事，这一格都只能是 false').toEqual({
      structuredOutput: false,
    });
  });
});

/**
 * **人工消息面（投递两档 + 续接）在适配器这一层的接线判据**。
 *
 * 真机那一半（插件真的被加载、`agent.steer` 真的把话送进下一次模型请求、`inbox.remove` 真的撤回）
 * 在 `injection-real-path.test.ts` 里；这一组判的是**装与不装的边界**与**版本门**——两处错了
 * 都不会被那一半发现：
 *   · 没挂端口却落了插件文件 / 插了 overlay 那一行（「不进人工消息就一处都不动」不成立）；
 *   · 声明 `off-by-adapter` 的续接被实现成「静默开一条新会话」（用户以为在追问、模型什么都不记得）。
 */
describe('人工消息面：装与不装的边界 + 续接的版本门', () => {
  const PLUGIN_FILE = DSH_INJECT_PLUGIN_RELATIVE_PATH;
  const QUEUE_FILE = DSH_INJECT_QUEUE_RELATIVE_PATH;
  const RECEIPTS_FILE = DSH_INJECT_RECEIPTS_RELATIVE_PATH;

  /** 一次运行之后，候选配置目录里有哪些跟人工消息面有关的落点 */
  function injectionArtifacts(configHome: string): Record<string, boolean> {
    return {
      plugin: existsSync(join(configHome, PLUGIN_FILE)),
      queue: existsSync(join(configHome, QUEUE_FILE)),
      receipts: existsSync(join(configHome, RECEIPTS_FILE)),
      overlayLine: readFileSync(join(configHome, DSH_ROUTE_PATCH_RELATIVE_PATH), 'utf8').includes('aieval-inject'),
    };
  }

  /** 假端口：`available` 由用例给，三个动作都不抛（契约如此） */
  function portWith(available: boolean): InjectionPort {
    return {
      available,
      drain: () => [],
      markDelivered: () => {},
      retract: async () => 'unsupported',
    };
  }

  async function runOnce(configHome: string, overrides: Partial<AgentRunInput> = {}): Promise<AgentRunResult> {
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder: createRecorder(),
          events: [sessionEvent('step/start', { turn: 1, step: 1 }), assistantReply('收尾。')],
        }),
      },
    });
    return dshProvider.run(createRunInput({ configHome, ...overrides }));
  }

  it('没传注入端口 ⇒ 插件、两份流水、overlay 那一行一个都不落（零回归）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'dsh-inject-off-'));
    try {
      const result = await runOnce(configHome);
      expect(result.ok).toBe(true);
      expect(injectionArtifacts(configHome)).toEqual({
        plugin: false,
        queue: false,
        receipts: false,
        overlayLine: false,
      });
    } finally {
      removeTreeWithRetry(configHome);
    }
  });

  /**
   * **插件没被加载 ⇒ 收尾点名 WARN**（人工消息面 / 应答面各一条）。
   *
   * 插件没被厂商加载或激活时，这一侧所有出口都是静默的：投递流水写了没人读、提问流水永远是空的
   * ——而「功能没了」与「这一轮没人发消息」在界面上长得一模一样。厂商那边只留一行
   * `did not activate`（适配器不读它的 stderr）。三条口径：只说话不改结论、两座桥各说各的、
   * 有加载收据时一条都不落。
   */
  /**
   * **权限档的会话属性**（R4-A 的 F1）：厂商把权限档当**会话属性**——`permission/preset` 只在
   * 会话起手投一条，续接段不重投，而实际生效的是首次创建那条会话时的档。真机反例：首段 `full`
   * 建会话、第二段 `read-only` + 续接，写文件**照样成功**（对照臂新会话被拒）。
   *
   * 三条口径：**续接 + 非 full + 观测不到档位 ⇒ 点名 WARN**（只读档静默拿到写权限是评分阶段最不能
   * 接受的那一类）；**本次要的档与厂商报的档不一致 ⇒ WARN**（抽屉上「显示哪一档」与「实际哪一档」
   * 冲突时留痕）；`full` 与「观测到了且一致」两档都不出声。
   */
  describe('权限档与会话属性的不一致', () => {
    it('续接 + read-only + 观测不到档位 ⇒ 一条点名 WARN；full 或观测到了则不出声', async () => {
      const collectPermissionWarns = (events: AgentEvent[]): string[] =>
        events
          .filter(
            (event) =>
              event.type === 'log'
              && event.stream === 'stderr'
              && typeof event.text === 'string'
              && event.text.includes('权限档'),
          )
          .map((event) => (event.type === 'log' ? event.text : ''));

      // 续接 + read-only：厂商不重投权限档 ⇒ WARN
      const resumedEvents: AgentEvent[] = [];
      const recorder = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [STEP_START_EVENT, MAIN_USAGE] }) },
      });
      const first = await dshProvider.run(createRunInput());
      setAgentRuntimeForTesting({
        sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [STEP_START_EVENT, MAIN_USAGE] }) },
      });
      await dshProvider.run(
        createRunInput({
          ...(first.sessionId === null ? {} : { resume: { sessionId: first.sessionId } }),
          permission: 'read-only',
          onEvent: collectEvents(resumedEvents),
        }),
      );
      const warns = collectPermissionWarns(resumedEvents);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('read-only');
      expect(warns[0]).toContain('续接');

      // 续接 + full：风险方向相反（工具报错可见），不出声
      const fullEvents: AgentEvent[] = [];
      setAgentRuntimeForTesting({
        sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [STEP_START_EVENT, MAIN_USAGE] }) },
      });
      await dshProvider.run(
        createRunInput({
          ...(first.sessionId === null ? {} : { resume: { sessionId: first.sessionId } }),
          onEvent: collectEvents(fullEvents),
        }),
      );
      expect(collectPermissionWarns(fullEvents)).toHaveLength(0);
    });

    /**
     * **两个方向都要报**：要 `full` 却拿到 `read-only` 是功能面（写工具莫名失败），要 `read-only`
     * 却拿到 `full` 是安全面。续接段厂商**不重投**权限档，所以只有「本进程里知道这条会话的档位」
     * 这一支能发现差异；而本段观测到了就交给 `events.ts` 那一支（避免同一件事说两遍）。
     */
    it('续接段要求的档与会话已知档不一致（反方向）⇒ 也报一条', async () => {
      const events: AgentEvent[] = [];
      const recorder = createRecorder();
      // 首段：新会话、read-only，厂商投了 preset
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder,
            events: [sessionEvent('permission/preset', { preset: 'read-only' }), STEP_START_EVENT, MAIN_USAGE],
          }),
        },
      });
      const first = await dshProvider.run(createRunInput({ permission: 'read-only' }));
      // 续接段：要求 full，但厂商不重投 ⇒ 会话记忆说 read-only
      setAgentRuntimeForTesting({
        sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [STEP_START_EVENT, MAIN_USAGE] }) },
      });
      await dshProvider.run(
        createRunInput({
          ...(first.sessionId === null ? {} : { resume: { sessionId: first.sessionId } }),
          permission: 'full',
          onEvent: collectEvents(events),
        }),
      );
      const warns = events.filter(
        (event) =>
          event.type === 'log'
          && event.stream === 'stderr'
          && typeof event.text === 'string'
          && event.text.includes('这条会话的档位是'),
      );
      expect(warns).toHaveLength(1);
    });

    it('厂商报的档与本次要求不一致 ⇒ WARN（新会话也报）', async () => {
      const events: AgentEvent[] = [];
      const recorder = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder,
            events: [
              sessionEvent('permission/preset', { preset: 'danger-full-access' }),
              STEP_START_EVENT,
              MAIN_USAGE,
            ],
          }),
        },
      });
      await dshProvider.run(createRunInput({ permission: 'read-only', onEvent: collectEvents(events) }));
      const warns = events.filter(
        (event) =>
          event.type === 'log'
          && event.stream === 'stderr'
          && typeof event.text === 'string'
          && event.text.includes('本次运行要求权限档'),
      );
      expect(warns).toHaveLength(1);
    });
  });

  /**
   * **跨进程播种**（`session-log.ts` + `seedDshSessionRoundHighWater`）：续接时按厂商会话日志里
   * `step/start` 的条数抬高发号表 ⇒ 新进程的号从 `n+1` 起，而不是从 1 起（不播种就会与上一段的
   * `mergeKey` 逐个撞车）。读不到日志 ⇒ 不播种（退回今天的行为，不引入新的失败面）。
   */
  describe('跨进程续接的往返号播种', () => {
    it('日志里有 N 条 step/start ⇒ 续接段的号从 N+1 起（读不到就不播种）', () => {
      resetDshMessageStateForTesting();
      const sessionId = 'session-seed-1';
      // 不播种：第一次分配拿 1
      expect(dshTurnAttribution(sessionId, { turn: 1, step: 1 })?.round).toBe(1);
      resetDshMessageStateForTesting();
      // 播种 9 ⇒ 下一个新组合拿 10（与 phase1 的 1..9 零交集）
      seedDshSessionRoundHighWater(sessionId, 9);
      expect(dshTurnAttribution(sessionId, { turn: 2, step: 1 })?.round).toBe(10);
      // 幂等：重复播种取较大值，不会把号推回去
      seedDshSessionRoundHighWater(sessionId, 3);
      expect(dshTurnAttribution(sessionId, { turn: 2, step: 2 })?.round).toBe(11);
      // 播种 0 / null（读不到日志）⇒ 与不播种同形
      resetDshMessageStateForTesting();
      seedDshSessionRoundHighWater(sessionId, null);
      seedDshSessionRoundHighWater(sessionId, 0);
      expect(dshTurnAttribution(sessionId, { turn: 1, step: 1 })?.round).toBe(1);
    });
  });

  it('配了插件却整轮没有加载收据 ⇒ 人工消息面一条点名 WARN；有收据则一条都不落', async () => {
    const silentHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-silent-'));
    try {
      const events: AgentEvent[] = [];
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: createRecorder(),
            events: [sessionEvent('step/start', { turn: 1, step: 1 }), assistantReply('收尾。')],
          }),
        },
      });
      // 假 SDK 不会真的加载插件 ⇒ 收据流水里没有 `plugin-loaded` 那一行
      await dshProvider.run(createRunInput({ configHome: silentHome, inject: portWith(true), onEvent: collectEvents(events) }));
      const warns = events
        .filter((event) => event.type === 'log' && event.stream === 'stderr' && event.text.startsWith('[WARN] 人工消息面配了插件'))
        .map((event) => (event.type === 'log' ? event.text : ''));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('did not activate');
    } finally {
      removeTreeWithRetry(silentHome);
    }

    // 有加载收据（真插件的形状）⇒ 一条都不落
    const loadedHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-loaded-'));
    try {
      const events: AgentEvent[] = [];
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: createRecorder(),
            events: [sessionEvent('step/start', { turn: 1, step: 1 }), assistantReply('收尾。')],
          }),
        },
      });
      let atConstruct: (() => void) | null = null;
      atConstruct = () => {
        appendFileSync(
          join(loadedHome, RECEIPTS_FILE),
          `${JSON.stringify({ phase: 'plugin-loaded', at: Date.now(), url: `file://${loadedHome}/aieval-inject.mjs`, pid: process.pid, serviceAtLoad: true })}\n`,
        );
      };
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: createRecorder(),
            events: [sessionEvent('step/start', { turn: 1, step: 1 }), assistantReply('收尾。')],
            onConstruct: atConstruct,
          }),
        },
      });
      await dshProvider.run(createRunInput({ configHome: loadedHome, inject: portWith(true), onEvent: collectEvents(events) }));
      expect(
        events.filter((event) => event.type === 'log' && event.text.startsWith('[WARN] 人工消息面配了插件')),
      ).toHaveLength(0);
    } finally {
      removeTreeWithRetry(loadedHome);
    }
  });

  it('端口在但 available === false ⇒ 与「没传端口」逐字同形（一格都不挂）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'dsh-inject-closed-'));
    try {
      await runOnce(configHome, { inject: portWith(false) });
      expect(injectionArtifacts(configHome)).toEqual({
        plugin: false,
        queue: false,
        receipts: false,
        overlayLine: false,
      });
    } finally {
      removeTreeWithRetry(configHome);
    }
  });

  it('端口开着 ⇒ 插件与两份流水在 boot 之前落盘、overlay 里那一行也在', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'dsh-inject-on-'));
    try {
      // 装配时刻的快照点：读盘时 boot（`new DeepSeekHarness`）已经在那一刻发生
      let atConstruct: Record<string, boolean> | null = null;
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: createRecorder(),
            events: [sessionEvent('step/start', { turn: 1, step: 1 }), assistantReply('收尾。')],
            onConstruct: () => {
              atConstruct = injectionArtifacts(configHome);
            },
          }),
        },
      });
      await dshProvider.run(createRunInput({ configHome, inject: portWith(true) }));
      // 写盘晚了的表现是「插件从来没被加载过」——放在 boot 之后写就会被这一条抓住
      expect(atConstruct).toEqual({ plugin: true, queue: true, receipts: true, overlayLine: true });
      // 两份流水是追加型的：重跑同一行必须从空开始
      expect(readFileSync(join(configHome, QUEUE_FILE), 'utf8')).toBe('');
      expect(readFileSync(join(configHome, RECEIPTS_FILE), 'utf8')).toBe('');
    } finally {
      removeTreeWithRetry(configHome);
    }
  });

  it('会话身份如实上报（跨进程续接的唯一键）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'dsh-session-id-'));
    try {
      const result = await runOnce(configHome);
      expect(result.sessionId).toMatch(/^session-[0-9a-f]{32}$/);
    } finally {
      removeTreeWithRetry(configHome);
    }
  });

  it('客户端没有 resumeSession 这一格（更旧的 wire）⇒ 收到 resume 如实抛中文错，绝不静默开一条新会话', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'dsh-resume-gated-'));
    const recorder = createRecorder();
    try {
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder,
            events: [sessionEvent('step/start', { turn: 1, step: 1 }), assistantReply('收尾。')],
            resumeSession: 'absent',
          }),
        },
      });
      const result = await dshProvider.run(
        createRunInput({ configHome, resume: { sessionId: 'session-已存在的会话' } }),
      );
      expect(result.ok, '没有这一格的客户端收到 resume 必须失败，不许静默从头跑').toBe(false);
      expect(result.error?.message).toContain('session/resume');
      // **没有**开一条新会话：一次模型往返都没有发生过
      expect(recorder.prompt, '收到 resume 却照旧跑了提示词 = 静默开了一条新会话').toBeNull();
      expect(result.sessionId).toBeNull();
    } finally {
      removeTreeWithRetry(configHome);
    }
  });

  it('客户端缺这一格时换 id 也一样拦（不是靠某个特定 id 的特例）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'dsh-resume-gated2-'));
    try {
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder: createRecorder(),
            events: [sessionEvent('step/start', { turn: 1, step: 1 }), assistantReply('收尾。')],
            resumeSession: 'absent',
          }),
        },
      });
      const result = await dshProvider.run(
        createRunInput({ configHome, resume: { sessionId: 'session-2' } }),
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('AGENT_FAILED');
    } finally {
      removeTreeWithRetry(configHome);
    }
  });

  it('客户端有 resumeSession ⇒ 走 adopt：新会话那条入口一次都不碰', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'dsh-resume-adopt-'));
    const recorder = createRecorder();
    try {
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({
            recorder,
            events: [
              sessionEvent('step/start', { turn: 1, step: 1 }),
              assistantReply('接着上次的收尾。'),
            ],
          }),
        },
      });
      const result = await dshProvider.run(
        createRunInput({ configHome, resume: { sessionId: 'session-已存在的会话' } }),
      );
      expect(result.ok, '这一版有 session/resume，收到 resume 不该失败').toBe(true);
      expect(recorder.resumedSessions, 'adopt 的入参必须是我们传的那个 id').toEqual([
        'session-已存在的会话',
      ]);
      expect(
        recorder.freshRunCalls,
        'adopt 之后又走 harness.run() = 身份没定死（那条 wire 会撞 already exists）',
      ).toBe(0);
      expect(recorder.prompt, 'adopt 出来的句柄也要收到提示词').not.toBeNull();
      expect(result.sessionId, '续接之后上报的身份必须是 adopt 的那一条').toBe('session-已存在的会话');
    } finally {
      removeTreeWithRetry(configHome);
    }
  });
});

/**
 * 收尾与回收的两条硬口径（都在 `startDsh` 的运行时生命周期上）：
 *
 *  1. **`resume` 被厂商拒之后不许留下孤儿运行时**。`runtime.start()` 已经 spawn 了子进程，
 *     而骨架此刻还没有 `TurnStart`（`started === undefined`）⇒ 它的 `finally` 碰不到任何可关闭
 *     对象。disposer 因此建在 `start()` **之前**，并由这一段自己兜住抛错路径。
 *     症状（缺这一格时）：每次失败的追问都在机器上留一个常驻 `dsh` 进程捏着该候选 `.agenthome`。
 *  2. **我们自己发起的关闭不算「通知流中断」**。关闭运行时会同步终结订阅，而消费循环此刻还挂在
 *     `next()` 上、`settled` 仍是 `false` ⇒ 只看 `settled` 的判据会把每一次用户终止都报成
 *     「内容丢了」（真机上那一个候选会多一条 stderr 事件说「执行日志因此不完整」）。
 */
describe('dsh 运行时生命周期：失败回收与「自己关的不算断流」', () => {
  /** 只补夹具缺的那一格（`resumeSession`）与本用例要断言的关闭计数 */
  function fakeSdkWithResume(resume: () => Promise<never>): { recorder: ReturnType<typeof createRecorder>; module: unknown } {
    const recorder = createRecorder();
    const idleSubscription = (): unknown => ({
      next: (): Promise<never> => new Promise<never>(() => {}),
      tryNext: (): undefined => undefined,
      close: (): void => {},
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<never> {
        for (;;) yield await new Promise<never>(() => {});
      },
    });
    class FakeHarness {
      readonly client = {
        subscribe: () => idleSubscription(),
        subscribeSessionTree: () => idleSubscription(),
        prompt: async (): Promise<string> => 'message-1',
        close: async (): Promise<void> => {},
      };
      async start(): Promise<void> {
        recorder.order.push('start');
      }
      async run(): Promise<unknown> {
        throw new Error('不该走到 run：adopt 失败应当停在续接那一步');
      }
      async resumeSession(): Promise<never> {
        return resume();
      }
      async close(): Promise<void> {
        recorder.closeCount += 1;
        recorder.order.push('dispose');
      }
    }
    return { recorder, module: { DeepSeekHarness: FakeHarness } };
  }

  it('续接被厂商拒（not found）⇒ 候选失败，且已起来的运行时**恰好被回收一次**', async () => {
    const { recorder, module } = fakeSdkWithResume(async () => {
      throw new Error('session "session-x" not found');
    });
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: module } });
    const result = await dshProvider.run(createRunInput({ resume: { sessionId: 'session-x' } }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(recorder.order).toContain('start');
    expect(recorder.closeCount, '续接失败后运行时没人关 = 孤儿 dsh 子进程').toBe(1);
  });

  it('用户终止：事件流里**不许**出现「通知流中断」这条假诊断', async () => {
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
    const result = await settleWithFakeTimers(promise, {
      stepMs: 1_000,
      steps: 10 * (RELEASE_GRACE_MS / 1_000 + 2),
    });

    expect(result.exitReason).toBe('canceled');
    // 先钉「释放确实走了第二段」（否则这条用例可能因为压根没关运行时而假绿）
    expect(recorder.closeCount).toBe(1);
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs.filter((text) => text.includes('通知流中断'))).toEqual([]);
  });
});

/**
 * 追问区间（第二条活动区间）里，**上一轮登记过的子会话**仍要放行它的增量。
 *
 * stream-tap 的门闸按「会话已知表」放行伪通知，而那张表**每条活动区间重建一份**。
 * 只放自己的会话 id 会让上一轮登记过的子会话在追问区间里重新变成「未知」：
 * 那些增量候选被挂住，最后随 `tap.close()` 一起丢掉——子智能体的话缺一段，零报错。
 * 播种因此取 `runState.childSessions`（与放行判据同一份事实，过滤器在收到
 * `subagent.started` 时写入）。
 *
 * 判据取**事件与消息的同一条时间线**：修正轮的那条 WARN 之后必须还能看到子会话的增量
 * （首轮那一份在 `subagent.started` 投影之后就放行了，不算数）。
 */
describe('stream-tap 门闸：追问区间仍认上一轮登记的子会话', () => {
  const CHILD = 'f3a1c2d4-5b6e-4f70-8a91-2c3d4e5f6071';
  const SCHEMA = { type: 'object', properties: { achieved: { type: 'boolean' } }, required: ['achieved'] };
  const INVALID_REPLY = '{"achieved":"yes"}';
  const VALID_REPLY = '{"achieved":true}';
  /** 真机 tap 行形状：`{ sid, frame }`，帧里带 `chunk`（`stream-tap.ts` 的读取口径） */
  const childDelta = (text: string): unknown => ({
    sid: CHILD,
    frame: {
      type: 'chunk',
      attemptId: 'att-1',
      revision: 1,
      index: 0,
      time: 1,
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text },
    },
  });

  it('修正轮里子会话的增量照旧出消息（子任务身份没被区间边界忘掉）', async () => {
    /** 事件与消息的同一条时间线（两者在投影循环里同步产出）；`chunk` 用来把增量与收口快照分开 */
    const timeline: Array<{ kind: 'log' | 'message'; text: string; subagentId: string | null; chunk: string | null }> = [];
    const { sdkModule } = createRoundDshSdk({
      rounds: [
        [
          { method: DSH_SUBAGENT_STARTED_METHOD, params: { parentSessionId: 'session-1', childSessionId: CHILD } },
          assistantReply(INVALID_REPLY),
        ],
        [assistantReply(VALID_REPLY)],
      ],
      tapLines: [childDelta('子会话还在说话')],
    });
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: sdkModule } });

    await dshProvider.run(
      createRunInput({
        prompt: '数出工作区里 .ts 文件的个数。',
        outputSchema: SCHEMA,
        onEvent: (event) => {
          if (event.type === 'log') timeline.push({ kind: 'log', text: event.text, subagentId: null, chunk: null });
        },
        onMessage: (message) => {
          timeline.push({
            kind: 'message',
            text: message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join(''),
            subagentId: message.subagentId,
            chunk: message.chunk,
          });
        },
      }),
    );

    const repairAt = timeline.findIndex((one) => one.kind === 'log' && one.text.includes('结构化输出未通过校验'));
    expect(repairAt, '这一组的前提是首轮答复不合格、真的进了修正轮').toBeGreaterThanOrEqual(0);
    /**
     * 只数**增量**（`chunk: 'delta'`）：`runTurn` 收尾的 `sealOpen` 会把没等到快照的载体按累积值
     * 再发一条，而那条是 `chunk: 'snapshot'`——把两者混在一起数，首轮那一份会把这条判据盖成假绿。
     */
    const childDeltasAfterRepair = timeline
      .slice(repairAt)
      .filter((one) => one.kind === 'message' && one.subagentId === CHILD && one.chunk === 'delta');
    expect(
      childDeltasAfterRepair.length,
      '追问区间里子会话的增量一条都没出 = 门闸把上一轮登记过的会话忘了（那些行随 tap.close() 丢掉）',
    ).toBeGreaterThan(0);
  });
});

/**
 * 整轮**没见过 `turn/end`** 时：界面一个字都不报（`unknown` 是刻意的——没有证据就别编一个故障），
 * 但服务端必须留一条 WARN。
 *
 * 为什么值得钉：失败通道只有 `turn/end` 一条，而「收尾那条通知已经被 `shift()` 出来、却在竞速里
 * 没人读它的值」这条路径会把整条丢掉（FAQ 的 `24 / 24 / 25 / 25` 条）——那时这个候选照旧判成功，
 * **任何日志、任何事件都没有**，排障只能去翻厂商会话日志。这条 WARN 是那种形状的唯一线索。
 */
describe('收尾留痕：没见过 turn/end', () => {
  it('界面不报、结论不改写，但服务端有一条带两个计数的 WARN', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const events: AgentEvent[] = [];
      const recorder = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: {
          [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [sessionEvent('session/title', { title: '跑完了' })] }),
        },
      });
      const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));

      expect(result.ok, '留痕不改结论：这个候选照旧按已产出的内容判').toBe(true);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      const texts = warn.mock.calls.map((call) => String(call[0] ?? ''));
      expect(texts.some((text) => text.includes('没收到 turn/end'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
