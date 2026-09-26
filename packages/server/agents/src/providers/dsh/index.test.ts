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
import type { AgentEvent } from '@aieval/contracts';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_GRACE_MS } from '../../release';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeDshSdk,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import { DSH_ASSISTANT_MESSAGE_TYPE, DSH_TURN_END_TYPE } from './events';
import {
  DSH_INITIALIZE_TIMEOUT_MS,
  DSH_LEGACY_PROFILE_PATCH_RELATIVE_PATH,
  DSH_ROUTE_API_KEY_ENV,
  DSH_ROUTE_KEY,
  DSH_ROUTE_PATCH_RELATIVE_PATH,
  buildDshRoutePatch,
  dshProvider,
} from './index';
import { DSH_PACKAGE_NAME } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
});

/**
 * 造一条真实的会话事件通知（外形照 dump）。
 * `sessionId` 只是**占位**：夹具会把通知上的会话归属对齐到本次 run 的会话 id
 * （真实 SDK 产出的通知一定带那个 id，见 `agent-fixtures.ts` 的 `tagSession`）。
 */
function sessionEvent(type: string, data: unknown, sessionId = 'session-fake'): unknown {
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
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

/**
 * 思考强度（spec §6.4 / D13）：档位字符串原样进 `DeepSeekHarness` 的 `reasoningEffort`。
 * 这一格 dsh 侧是**硬校验**的（不支持的档位报 `UNSUPPORTED_REASONING_EFFORT`），
 * 所以「不传」必须真的是不传，而不是传一个 `undefined`。
 */
describe('dsh 的思考强度', () => {
  it('给了 effort ⇒ harness 选项里的 reasoningEffort 原样带上；没给 ⇒ 该键不存在', async () => {
    const withEffort = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: withEffort, events: [] }) } });
    await dshProvider.run(createRunInput({ effort: 'max' }));
    expect(withEffort.options?.reasoningEffort).toBe('max');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: bare, events: [] }) } });
    await dshProvider.run(createRunInput());
    expect(bare.options).not.toBeNull();
    expect(Object.hasOwn(bare.options ?? {}, 'reasoningEffort')).toBe(false);
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
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
