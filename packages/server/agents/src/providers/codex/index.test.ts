// @vitest-environment node
/**
 * codex 适配器：注入落点（客户端选项 + 完整 model_providers 条目 + 独立 CODEX_HOME/TMPDIR）、
 * 事件贯通、临时目录回收、加载降级。
 * 另含一条控制方追加的回归钉：投影 `failure` 非空的出口（三个适配器共用）。
 */
import { EFFORT_OFF, type AgentEvent } from '@aieval/contracts';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeCodexSdk,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import type { AgentRunResult } from '../../types';
import { codexEffortOf, codexProvider } from './index';
import { CODEX_PACKAGE_NAME } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
});

interface RecordedCodexConfig {
  model_provider: string;
  model_providers: Record<string, { base_url: string; wire_api: string; requires_openai_auth: boolean }>;
  /** 工具开关：只放这个 CLI 版本认的键（`tools.multi_agent` 会被忽略，见 `buildCodexConfig`） */
  tools: { web_search: boolean; update_plan: { enabled: boolean } };
  /** 特性开关（`multi_agent` 在 CLI 0.156.1 里归这里） */
  features: { multi_agent: boolean };
  /** 上下文窗口：只在供应商清单里声明过时出现（spec §6.2 / D8） */
  model_context_window?: number;
  /**
   * **关闭档的第二格**（本设计 §3.2）：只在 `off` 时出现，值为 `'none'`。
   * 类型是**可选**、且下面用 `Object.hasOwn` 断言 —— 钉的是「键**不存在**」这个形态本身。
   * ⚠️ 它与「键在、值为 `undefined`」在本仓的 SDK 下**行为等价**：`dist/index.js:343-345` 对
   * `undefined` 值直接 `continue`、**不产出任何 `--config` 参数**（早先「会被摊成字符串交给 CLI」
   * 的说法是错的）；形态判据的价值在逐键对账与抗 SDK 漂移。
   */
  model_reasoning_summary?: string;
}

describe('codexProvider', () => {
  /**
   * 窗口进 config 的唯一路径（spec §6.2）：CLI 内置目录里没有我们网关的模型名，
   * 这个数只能由我们告诉它；而「漏填」在运行面上是静默的（跑得完，只是压缩时机不对）。
   */
  it('route 带窗口 ⇒ 交给 SDK 的 config 里有 model_context_window；不带 ⇒ 该键不存在', async () => {
    const withWindow = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: withWindow, events: [] }) } });
    await codexProvider.run(
      createRunInput({
        route: { protocolType: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-x', modelId: 'GLM-5.3', contextWindow: 1_048_576 },
      }),
    );
    expect((withWindow.options?.config as RecordedCodexConfig).model_context_window).toBe(1_048_576);

    const withoutWindow = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: withoutWindow, events: [] }) } });
    await codexProvider.run(
      createRunInput({
        route: { protocolType: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-x', modelId: 'GLM-5.3' },
      }),
    );
    // 判据是「键**不存在**」这个形态本身（⚠️ 与「值为 undefined」在本仓 SDK 下行为等价，见 sdk.test.ts）
    expect(Object.hasOwn(withoutWindow.options?.config ?? {}, 'model_context_window')).toBe(false);
  });

  it('注入落点：baseUrl 补 /v1、apiKey 进客户端选项、model_providers 条目完整、CODEX_HOME 指向该行目录', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    await codexProvider.run(
      createRunInput({
        route: {
          protocolType: 'openai',
          baseUrl: 'https://gw.example.com/openai/',
          apiKey: 'sk-codex',
          modelId: 'gpt-x',
        },
      }),
    );
    expect(recorder.options?.baseUrl).toBe('https://gw.example.com/openai/v1');
    expect(recorder.options?.apiKey).toBe('sk-codex');
    // 环境里已有的 ~/.codex 配置会赢过注入的 base URL：解药是把 HOME / CODEX_HOME 指向该行目录
    expect(recorder.env?.CODEX_HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.env?.HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    const config = recorder.options?.config as RecordedCodexConfig;
    expect(config.model_provider).toBe('aieval');
    expect(config.model_providers.aieval?.base_url).toBe('https://gw.example.com/openai/v1');
    expect(config.model_providers.aieval?.wire_api).toBe('responses');
    expect(config.model_providers.aieval?.requires_openai_auth).toBe(true);
    /**
     * `tools.update_plan.enabled=true` —— **计划工具必须常开**（用户口径 2026-09-30：统一打开）。
     * 为什么这条守卫值得存在：不设它时 codex 的入站 `tools[]` 里**没有** `update_plan`
     * （实测），于是 `task` 族在 codex 侧恒为空——那是**静默的空**，界面上与「这一轮没做规划」
     * 长得一模一样。同时它也让三家口径一致（claude 走 `CLAUDE_CODE_ENABLE_TODO_TOOLS`、dsh 默认就开）。
     */
    expect(config.tools).toEqual({ web_search: false, update_plan: { enabled: true } });
    /**
     * **`multi_agent` 必须走 `features.` 前缀，且值为 `true`**（2026-10-03 用户口径修正）。
     *
     * 两个要点各有一条理由：
     *   · **前缀**：旧写法把它放在 `tools.` 下，CLI 0.156.1 把它当「不认识的 session-flag」忽略
     *     （事件流里回一句「Codex is ignoring … `tools.multi_agent` is ignored」）而**照默认值跑**
     *     ⇒ 写在哪一格必须可断言，否则「开了还是没开」无从判断；
     *   · **值**：子智能体是评测面之一，而 claude（`CLAUDE_CODE_ENABLE_TODO_TOOLS`）与 dsh
     *     （默认开）都有。关掉之后**不是「安静地没有子任务」**：真机会话文件里 `spawn_agent`
     *     的返回是「Subagent dispatch requires multi-agent support … `multi_agent = true`」
     *     ——一次失败的工具调用，事件流里连 `collab_tool_call` 都没有 ⇒ 抽屉子任务面板恒空。
     */
    expect(config.features).toEqual({ multi_agent: true });
    expect(recorder.threadOptions?.model).toBe('gpt-x');
    expect(recorder.threadOptions?.workingDirectory).toBe('D:/tmp/rows/row-1/workspace');
    // 评测是非交互的：任何走人工批准的路径都只会让该行走到超时
    expect(recorder.threadOptions?.approvalPolicy).toBe('never');
  });

  it('执行阶段的权限档：sandboxMode 必须是 danger-full-access（workspace-write 默认关掉网络）', async () => {
    // 为什么不是 `workspace-write`（本仓此前的值）：SDK 只在 `networkAccessEnabled !== undefined`
    // 时才写 `sandbox_workspace_write.network_access=…`（`dist/index.js:220-223`），
    // 也就是说工作区可写**不等于**能用网——而「装依赖 / 跑测试」正是评测要观察的行为，
    // 断网会让候选卡在第一步、最后在空 diff 上被评分（与 claude 那条 0 改动同一类静默失败）。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    await codexProvider.run(createRunInput({ permission: 'full' }));
    expect(recorder.threadOptions?.sandboxMode).toBe('danger-full-access');
    expect(recorder.threadOptions?.approvalPolicy).toBe('never');
  });

  it('评分阶段的权限档：sandboxMode: read-only（工作区只读，且不靠模型自觉）', async () => {
    // 工作区是候选的产出：评审者改了它就污染「查看改动」抽屉（抽屉按需现算 diff）。
    // 提示词里那句「只读评审」只是**要求**，这一格才是执行层的强制。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    await codexProvider.run(createRunInput({ permission: 'read-only' }));
    expect(recorder.threadOptions?.sandboxMode).toBe('read-only');
    // 批准策略两档都是 never：只读档也一样——走人工批准在评测里只会变成一次超时
    expect(recorder.threadOptions?.approvalPolicy).toBe('never');
  });

  it('给了 outputSchema ⇒ runStreamed 第二参带上它', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };

    await codexProvider.run(createRunInput({ outputSchema: schema }));

    expect(recorder.turnOptions?.outputSchema).toEqual(schema);
  });

  it('没给 outputSchema ⇒ 第二参里没有这个键（候选阶段与文本评分逐字不变）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });

    await codexProvider.run(createRunInput());

    const turnOptions = recorder.turnOptions;
    // 与下面那条 null 用例对称（终审 C3）：少了这一句，`turnOptions === null`——SDK 压根没被调用
    // （例如适配器在 `runStreamed` 之前就抛了）——会让下一行的 `!== null && …` 短路成 `false`，
    // 用例**静默变绿**：观测点丢了，反而被当成「第二参里没有这个键」。
    expect(turnOptions).not.toBeNull();
    expect(turnOptions !== null && 'outputSchema' in turnOptions).toBe(false);
  });

  it('outputSchema 显式为 null ⇒ 与「没给」同义，第二参里同样没有这个键（不放行 `schema: null` 进 CLI）', async () => {
    // 为什么把 `null` 与 `undefined` 归为同一格（控制方裁决 R27）：`null` 在这条路径上就是「没给」——
    // 在入口把两者同义化，不把判据交给厂商 SDK 的报错（它会在自己边界上先校验：`null` 不是
    // plain object ⇒ 抛 `outputSchema must be a plain JSON object`）。同一失效族的另一面在
    // claude-code 的结构化出口上留下过实证（`events.ts`：显式 `null` 顶掉真实答复，那一侧是静默的）。
    // 判据刻意用 `'outputSchema' in turnOptions` 而不是 `toBeUndefined()`：前者钉的是
    // 「这个键有没有被加进去」，后者连「加了但值为 undefined」也放行——那正是我们要封的形状。
    // ⚠️ 不可删：这条与 claude-code 的同款用例（`providers/claude-code/index.test.ts`）是**入口侧
    // null 口径的唯一守卫**——类型检查拦不住（条件展开这一形状零诊断）、lint 也拦不住（`eslint.shared.ts`
    // 无类型感知规则）⇒ 删掉它，CI 面上再没有东西拦「显式 `null` 被当成有效值透出去」。该退化在 CI 面
    // 是静默的（厂商 SDK 要到运行期才响亮报错：`outputSchema must be a plain JSON object`）。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });

    await codexProvider.run(createRunInput({ outputSchema: null as unknown as Record<string, unknown> }));

    const turnOptions = recorder.turnOptions;
    expect(turnOptions).not.toBeNull();
    expect(turnOptions !== null && 'outputSchema' in turnOptions).toBe(false);
  });

  it('本次运行的临时目录：运行中存在、跑完被删（dispose 的回收对象，§5.6.5）', async () => {
    const recorder = createRecorder();
    const existedDuringRun: boolean[] = [];
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [],
          onRunStreamed: () => {
            existedDuringRun.push(existsSync(String(recorder.env?.TMPDIR)));
          },
        }),
      },
    });
    await codexProvider.run(createRunInput());
    const scratchDir = String(recorder.env?.TMPDIR);
    expect(scratchDir).toContain('aieval-codex-');
    expect(existedDuringRun).toEqual([true]);
    expect(existsSync(scratchDir)).toBe(false);
  });

  it('事件贯通：答复条目实时累加轮次、turn.completed 交计量、item 文本进日志、未识别事件保留', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: 't1' },
            // 真实形状（rollout 实测）：一次模型调用产出 reasoning / agent_message 条目，最后才是 turn.completed
            { type: 'item.completed', item: { id: 'rs-1', type: 'reasoning', text: '先看看仓库' } },
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '第一步' } },
            { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 1, output_tokens: 2 } },
          ],
        }),
      },
    });
    const result = await codexProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({
      ok: true,
      exitReason: 'completed',
      /**
       * 2026-10-05 口径变更：轮次只数**答复条目** ⇒ 这条流里 `rs-1` 是推理（新口径下不计数）、
       * `msg-1` 是答复 ⇒ **1** 轮（旧口径把推理也数上 ⇒ 2）。
       */
      turns: 1,
      // `input` 是**归一后**的非缓存输入：`10 − 1 = 9`（见 events.ts 的 readTokens）
      tokens: { input: 9, cached: 1, output: 2, reasoningOutput: null, total: null },
    });
    /**
     * 两条（2026-10-05 口径变更；旧口径是三条）：
     *   · 推理那一条**不发**——它没给出新的轮次信息（`projection.turns` 为 `null`，发射门槛就是轮次）；
     *   · 答复条目把轮次推到 1（此时还没有用量 ⇒ tokens 为 null）；
     *   · 收尾的 turn.completed 把计量带上（turns 不变、tokens 从 null 变成采到的值 ⇒ 仍要发一条）。
     * 收尾之后不会再有一条「内容相同」的重复信号——去重在骨架里（`sameUsage`）。
     */
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages.map((event) => (event.type === 'usage' ? [event.turns, event.tokens] : null))).toEqual([
      [1, null],
      [1, { input: 9, cached: 1, output: 2, reasoningOutput: null, total: null }],
    ]);
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs).toContain('第一步');
    expect(logs.some((text) => text.includes('thread.started'))).toBe(true);
  });

  it('CLI 未安装（spawn ENOENT）：AGENT_FAILED，文案指向缺失的可执行文件，且不留临时目录', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [], threadError: new Error('spawn codex ENOENT') }),
      },
    });
    const result = await codexProvider.run(createRunInput());
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('可执行文件');
    // start 阶段失败也要清掉临时目录：否则「CLI 装不上」会变成「每跑一次留一个目录」
    expect(existsSync(String(recorder.env?.TMPDIR))).toBe(false);
  });

  it('厂商包缺失或形状不对：AGENT_LOAD_FAILED 且文案含包名；后续一轮可重试成功', async () => {
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: {} } });
    const first = await codexProvider.run(createRunInput());
    expect(first.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(first.error?.message).toContain(CODEX_PACKAGE_NAME);
    expect(first.error?.message).toContain('pnpm add');

    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    const second = await codexProvider.run(createRunInput());
    expect(second.ok).toBe(true);
  });

  it('用户终止：中止响应流后仍然释放（dispose 会删掉临时目录），且走的是第一段而不是 5 秒兜底', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const controller = new AbortController();
    setAgentRuntimeForTesting({
      sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [], hang: true }) },
    });
    // 停止入口只有 `signal`（适配器没有内层超时、编排层也没有兜底超时了）
    const promise = codexProvider.run(createRunInput({ signal: controller.signal, onEvent: collectEvents(events) }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const result = await settleWithFakeTimers(promise, { stepMs: 500, steps: 10 });
    expect(result.exitReason).toBe('canceled');
    expect(existsSync(String(recorder.env?.TMPDIR))).toBe(false);
    // 合作的中止必须**立刻**生效：它一旦失效，释放就会滑到 5 秒后的第二段并落一条 WARN（这一格就会红）
    expect(events.some((event) => event.type === 'log' && event.text.includes('秒内未结束在途 turn'))).toBe(false);
    expect(recorder.order).toEqual(['interrupt', 'turn-end']);
  });

  it('中止无效 + 迭代永不落定：第二段兜底只保证可见信号与回收，不保证流被终结（已登记的适配器能力边界）', async () => {
    // 形状：`interrupt: 'ignore'` = **第一次中止没有终结迭代**（CLI 不响应 / SDK 仍挂在等待上，措辞按
    // 平台语义收敛，评审 N1），且读循环永不落定。
    // 真 async generator 的 `return()` 只**排队**（挂在 `await` 上时 `AsyncGeneratorResumeNext` 直接返回），
    // 于是这一形状下**本适配器无法让 `runTurn` 有界返回**——这是已登记的能力边界（真实 SDK 只有
    // `spawn(signal)` 一条停止通道，没有第二个 kill/close/cancel）。
    // 2026-09-28 起**编排层也没有兜底超时了**（用户口径「执行不限时间」）：这一行的唯一出路是用户点
    // 「终止」并接受它可能收不了尾（这一格由下面「run 仍未落定」如实登记）。
    // 因此本用例只钉第二段兜底**真正能保证**的事：可见 WARN + 临时目录回收 + 关闭事件迭代恰好被请求一次；
    // **不**断言「流被终结」或「run 有界返回」——那正是复评 I1 认定的假绿（夹具曾用带外 stop() 伪造它）。
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const controller = new AbortController();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [], hang: true, interrupt: 'ignore' }),
      },
    });
    const promise = codexProvider.run(createRunInput({ signal: controller.signal, onEvent: collectEvents(events) }));
    let runSettled = false;
    void promise.then(
      () => {
        runSettled = true;
      },
      () => {
        runSettled = true;
      },
    );
    // 用户终止 → 第一段等 5 秒（interrupt 无效）→ 第二段兜底：WARN + 强制 dispose
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(6_000);
    const scratchDir = String(recorder.env?.TMPDIR);
    expect(scratchDir).toContain('aieval-codex-');
    expect(events.some((event) => event.type === 'log' && event.text.includes('秒内未结束在途 turn'))).toBe(true);
    expect(existsSync(scratchDir)).toBe(false);
    // dispose 恰好做了一次它真正能做的事：请求关闭事件迭代一次（`createDisposer` + `release ??=` 记忆化）
    expect(recorder.streamCloseCount).toBe(1);
    // 但迭代没有被终结：'turn-end' 不在顺序里，`run()` 也**仍未落定**——这两条就是被登记的边界本身
    expect(recorder.order).toEqual(['interrupt']);
    expect(runSettled).toBe(false);
    // 收尾：不能 await 这个 promise（它不会落定；`settleWithFakeTimers` 会报「用例可能是真的挂住了」），
    // 也不留悬挂定时器——本用例的定时器全是假的，afterEach 的 `useRealTimers()` 一并丢弃。
  });

  it('第二段兜底：被放弃的迭代之后又落定一次 ⇒ 关闭迭代在那一刻结束消费（`closeRunStream` 唯一可达的可观测量）', async () => {
    // 形状：第一次中止无效（'ignore'）+ 读循环先卡住、`lateEvent.afterMs` 之后**又吐出一条**、然后再度卡死。
    // 这条用例钉的是 `closeRunStream()` 在**真 async generator** 语义下真正能保证的那一格（复评 I1 的证伪
    // 实验：`return()` 是排队而非无效——排队请求在生成器的下一个挂起点生效）：被放弃的迭代只要再落定一次，
    // 迭代就在那一刻结束（**正在产出的那一个值仍会交付**），而不是把后续事件无限消费下去。
    // 它**不**意味着「runTurn 有界返回」：挂在不落定的等待上时仍无界（上一条用例登记的边界）。
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const controller = new AbortController();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [],
          hang: true,
          interrupt: 'ignore',
          lateEvent: { afterMs: 12_000, value: { type: 'item.completed', item: { id: 'late', text: '晚到的输出' } } },
        }),
      },
    });
    const promise = codexProvider.run(createRunInput({ signal: controller.signal, onEvent: collectEvents(events) }));
    // 用户终止 → 第二段兜底已发生：此刻排队中的 return 还没有任何效果（迭代仍挂着，也没有终结）
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(recorder.order).toEqual(['interrupt']);
    // 12 秒时那条晚到的事件落定 ⇒ 排队的 return 在该挂起点生效：交付这一条，然后迭代结束、走完释放
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 20 });
    expect(result.exitReason).toBe('canceled');
    expect(recorder.order).toEqual(['interrupt', 'turn-end']);
    // 关闭迭代恰好被请求一次（`createDisposer` + `release ??=` 记忆化）；删掉 closeRunStream() 时
    // 上面那条 `settleWithFakeTimers` 会先红（迭代永不结束），这一条给出「恰好调用一次」的证据
    expect(recorder.streamCloseCount).toBe(1);
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs).toContain('晚到的输出');
  });

  it('计量只在 turn.completed 上：一个条目都没有时轮次是 null（不拿 usage 反推轮次）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [{ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 1, output_tokens: 3 } }],
        }),
      },
    });
    const result = await codexProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    // 归一后：`7 − 1 = 6`；两个可选格这一条路上没有（事件流不带它们）⇒ null，**不是 0**
    expect(result.tokens).toEqual({ input: 6, cached: 1, output: 3, reasoningOutput: null, total: null });
    // 轮次的门槛是「答复条目」；一条都没有时给 null，而不是拿 turn.completed 数出一个 1
    expect(result.turns).toBeNull();
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(0);
  });

  it('后一条 turn.completed 不带 usage ⇒ 不再发 usage 事件，计量保持最近一次采到的值（不回填 0）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            /**
             * 2026-10-05 口径变更：轮次只数**答复条目** ⇒ 用一条答复条目建立「已经数到 1 轮」这个前提
             * （这里原来是一条 `reasoning`：新口径下它不推高轮次，下面那两条 usage 断言就无从成立）。
             */
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '第一步做完了' } },
            { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 1, output_tokens: 2 } },
            // 第二次调用没有任何可识别的产出条目，收尾也不带 usage：既不补 0、也不覆盖已采到的计量
            { type: 'turn.completed' },
          ],
        }),
      },
    });
    const result = await codexProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result.turns).toBe(1);
    expect(result.tokens).toEqual({ input: 9, cached: 1, output: 2, reasoningOutput: null, total: null });
    // 两条：条目那一条（轮次 1、还没有计量）+ 收尾带上计量的那一条；
    // 最后那条不带 usage 的 turn.completed 与前一条逐字段相同 ⇒ 不重复发。
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages.map((event) => (event.type === 'usage' ? [event.turns, event.tokens] : null))).toEqual([
      [1, null],
      [1, { input: 9, cached: 1, output: 2, reasoningOutput: null, total: null }],
    ]);
  });

  it('CLI 未安装的真实形态：错误在**迭代首帧**抛出（spawn ENOENT）⇒ AGENT_FAILED + 临时目录已回收（评审 M2）', async () => {
    // 真实 SDK 的 `runStreamed` 只包一层生成器（实测 dist/index.js：spawn 在生成器体内），
    // 所以「CLI 不存在」不会让 `await thread.runStreamed(...)` 抛，而是在迭代时抛。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [],
          throwAfterEvents: new Error('spawn codex ENOENT'),
        }),
      },
    });
    const result = await codexProvider.run(createRunInput());
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('ENOENT');
    expect(existsSync(String(recorder.env?.TMPDIR))).toBe(false);
  });

  it('厂商事件里的失败（投影 failure 非空）折进结果：exitReason error + error 事件落到 onEvent，run 不抛（b4 派发稿点名的无主出口）', async () => {
    // 与 claude-code 的同名用例同一目的：`runTurn` 只在 `projection.failure` 非空时把厂商事件里的失败
    // 折成 `ok:false` + `exitReason:'error'`，而这条出口此前没有任何用例覆盖。
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: 't1' },
            { type: 'turn.failed', error: { message: 'HTTP 401 unauthorized' } },
          ],
        }),
      },
    });
    const result = await codexProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AUTH_FAILED');
    expect(events.some((event) => event.type === 'error')).toBe(true);
    // 失败事件没有 usage ⇒ 计量保持 null（绝不填 0），也不会发 usage 事件
    expect(result.tokens).toBeNull();
    expect(result.turns).toBeNull();
    expect(events.some((event) => event.type === 'usage')).toBe(false);
    // 失败出口一样要走释放：临时目录不该留下来
    expect(existsSync(String(recorder.env?.TMPDIR))).toBe(false);
  });
});

/**
 * 思考强度（spec §6.4 / D13）：档位字符串进 `startThread` 的 `modelReasoningEffort`。
 *
 * 2026-10-06 变更：此前这里是「一个键都不映射」——现在**只有关闭档**走映射（`off` ⇒ CLI 的 `none`，
 * 见 `codexEffortOf`），其余档位仍逐字透传。既有的那条「给了 effort 原样带上 / 没给 ⇒ 该键不存在」
 * 判据逐字不变（它说的正是其余档位与未选两种情形）。
 */
describe('codex 的思考强度', () => {
  it('给了 effort ⇒ threadOptions.modelReasoningEffort 原样带上；没给 ⇒ 该键不存在', async () => {
    const withEffort = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: withEffort, events: [] }) } });
    await codexProvider.run(createRunInput({ effort: 'xhigh' }));
    expect(withEffort.threadOptions?.modelReasoningEffort).toBe('xhigh');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: bare, events: [] }) } });
    await codexProvider.run(createRunInput());
    expect(bare.threadOptions).not.toBeNull();
    expect(Object.hasOwn(bare.threadOptions ?? {}, 'modelReasoningEffort')).toBe(false);
  });

  /**
   * 显式关闭（2026-10-06，**本机实测**）：契约与界面统一用 `off`，而 CLI 的关闭档名是 **`none`**
   * （`--config model_reasoning_effort="none"` ⇒ 请求体 `"reasoning":{"effort":"none"}`，网关接受）。
   * `off` **不能**直传：实测该网关拒绝它（CLI 重连 5 次后失败）。见 spec §1.5。
   */
  it('显式 off ⇒ 翻成 none 传给 CLI（不是 off）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    await codexProvider.run(createRunInput({ effort: 'off' }));
    expect(recorder.threadOptions?.modelReasoningEffort).toBe('none');
  });

  it('只有关闭档走映射：其余档位逐字透传', () => {
    expect(codexEffortOf('off')).toBe('none');
    expect(codexEffortOf('high')).toBe('high');
    expect(codexEffortOf('xhigh')).toBe('xhigh');
  });

  it('档位域首项是 off（下拉框第一项）', () => {
    expect(codexProvider.metadata.reasoningEfforts[0]).toBe(EFFORT_OFF);
  });

  /**
   * **显式 `off` 的两格并存**（spec §3.2 / §4.1 守卫 5）：
   *   · `modelReasoningEffort`（`index.ts:134`，**本次不动**）= 关闭档的前半（`off` ⇒ CLI 的 `none`）；
   *   · `model_reasoning_summary`（本次新增，进 `config`）= 后半。
   * 缺任何一半都退回今天：探针 D-B 实测「只有 `effort:'none'`」时网关照样推理；而
   * `model_reasoning_summary` 是**新增的**，所以这一条同时钉住「它真的接进了 client 的 config」。
   */
  it('显式 off ⇒ config.model_reasoning_summary = none，且 modelReasoningEffort 仍是 none（两格并存）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    await codexProvider.run(createRunInput({ effort: EFFORT_OFF }));

    const config = recorder.options?.config as RecordedCodexConfig;
    expect(config.model_reasoning_summary).toBe('none');
    // 关的这一半不许**凭空造**一格窗口出来：route 没给窗口 ⇒ 这个键必须不存在
    // （与下面「显式 off 且带窗口」那条**两端对称**：那一端钉「有窗口时不许丢」，这一端钉「没窗口时不许编」）
    expect(Object.hasOwn(config, 'model_context_window')).toBe(false);
    // 后半不能顶掉前半：`modelReasoningEffort` 那一格按 spec §3.2 约束 2 **照旧**给
    expect(recorder.threadOptions?.modelReasoningEffort).toBe('none');
  });

  /**
   * **新实参不许挤掉 `contextWindow` 那一格**（本仓踩过的「插参挤掉既有位置」）。
   *
   * 为什么必须单开一条：**`off` 与窗口同时给**的那一格，其余用例一条都走不到——
   * 既有的窗口用例不带 effort（`off` 分支不成立）、新增的 `off` 用例不带窗口。
   * 实测：把调用点改成「`off` 时拿 `undefined` 当窗口」之后，本文件 + `sdk.test.ts`
   * **35 条全绿**、只有这一条红。`buildCodexConfig` 的三个位置参数都是可选的，
   * 编译器对「少喂一格」无话可说 ⇒ 这个错只能由这一条钉住。
   */
  it('显式 off 且带窗口 ⇒ 两格并存（新实参不许挤掉 model_context_window）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    await codexProvider.run(
      createRunInput({
        effort: EFFORT_OFF,
        route: {
          protocolType: 'openai',
          baseUrl: 'https://gw.example.com/v1',
          apiKey: 'sk-x',
          modelId: 'GLM-5.3',
          contextWindow: 1_048_576,
        },
      }),
    );
    const config = recorder.options?.config as RecordedCodexConfig;
    expect(config.model_context_window).toBe(1_048_576);
    expect(config.model_reasoning_summary).toBe('none');
  });

  /**
   * **其余档位与未选逐字不变**（spec §1.3 约束 2、§4.1 守卫 6 / 7）：这一格**键不存在**，
   * 且既有的 `modelReasoningEffort` 语义照旧（`xhigh` 透传、未选一个键都不加）。
   * 判据用 `Object.hasOwn`：`toBeUndefined()` 会放过「键在、值为 undefined」这一形态。
   */
  it('其它档位与未选都不带 model_reasoning_summary 键（逐字不变）', async () => {
    const withEffort = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: withEffort, events: [] }) } });
    await codexProvider.run(createRunInput({ effort: 'xhigh' }));
    expect(Object.hasOwn(withEffort.options?.config ?? {}, 'model_reasoning_summary')).toBe(false);
    expect(withEffort.threadOptions?.modelReasoningEffort).toBe('xhigh');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: bare, events: [] }) } });
    await codexProvider.run(createRunInput());
    expect(Object.hasOwn(bare.options?.config ?? {}, 'model_reasoning_summary')).toBe(false);
    expect(Object.hasOwn(bare.threadOptions ?? {}, 'modelReasoningEffort')).toBe(false);
  });
});

/**
 * 子线程用量与轮次并进合计（spec 2026-10-04 §2.3 / Task 5）。
 *
 * 夹具形状：**真会话文件**（临时 `CODEX_HOME`，找文件与读盘两步都走生产路径）+ **假 codex SDK**
 * （喂事件流、收结果）。两件事各自可测，互不牵连——这一层要钉的是「知道了子线程 id 之后，
 * 它那一份有没有并进合计、有没有跟着结果一起交出去」。
 */
describe('codex 的子线程用量：并进合计并折进结果', () => {
  /** 会话文件落的临时目录（`afterEach` 清理；与 `transcript.test.ts` 同一套做法） */
  let scratch: string | null = null;

  /** 主线程与子线程的 id：事件流里的 `thread_id` 与文件名末尾必须**同值**（`findTranscript` 的判据） */
  const MAIN_THREAD_ID = '01a0f434-707e-7563-9f07-95f376e7b56a';
  const CHILD_THREAD_ID = '01a0f434-aaaa-7161-afca-c0a8934ee999';

  afterEach(() => {
    if (scratch !== null) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = null;
    }
  });

  /**
   * 一份会话文件的行：`session_meta` + 每个 `turn_id` 一行 + 一行 `token_count`。
   *
   * ⚠️ 用量那三个数用**我们归一后的词汇**（`input` = 非缓存输入）⇒ 落盘时把 cached 加回
   * `input_tokens`：会话文件那一格**含**缓存读，读取层会减掉它（`normalizedInput`）。
   *
   * ⚠️ 每个 `turn_id` 那一行挂的是 `item_completed`（`item.type` = `UserMessage`）而**不是**
   * `task_started`（2026-10-XX 修复）：轮次判据是「这一轮**真的有本模块消费的内容**」——fork 抄进来的
   * 派发者那一轮只有 `task_started` / `turn_context` 这类开工痕迹，唯它有这一档才排除得掉。
   * `UserMessage` 落在这条消费路径上、而消息投影对未映射条目**不产出消息**
   * （`message.ts` 的 `itemMessages` 末句）⇒ 既有断言（条数、用量、轮次）一字不变。
   */
  function transcriptLines(
    meta: Record<string, unknown>,
    usage: { input: number; cached: number; output: number },
    turnIds: readonly string[],
  ): string[] {
    return [
      JSON.stringify({ timestamp: '2026-09-30T21:24:34.570Z', ordinal: 0, type: 'session_meta', payload: meta }),
      ...turnIds.map((turnId, index) =>
        JSON.stringify({
          timestamp: '2026-09-30T21:24:40.000Z',
          ordinal: index + 1,
          type: 'event_msg',
          turn_id: turnId,
          payload: {
            type: 'item_completed',
            thread_id: meta.id ?? null,
            turn_id: turnId,
            item: { type: 'UserMessage', id: `um-${turnId}`, content: [] },
            started_at_ms: 1,
            completed_at_ms: 2,
          },
        }),
      ),
      JSON.stringify({
        timestamp: '2026-09-30T21:24:44.000Z',
        ordinal: turnIds.length + 1,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: usage.input + usage.cached,
              cached_input_tokens: usage.cached,
              output_tokens: usage.output,
            },
          },
        },
      }),
    ];
  }

  /**
   * 造一个真的 `CODEX_HOME`：主线程 **100/900/50**（归一后）、子线程 **10/20/5**，子线程一个轮次。
   * 路径形状按真机（`sessions/年/月/日/rollout-*-<线程 id>.jsonl`）。
   */
  function makeCodexHomeWithChild(): string {
    const home = mkdtempSync(join(tmpdir(), 'aieval-codex-subagent-'));
    scratch = home;
    const write = (threadId: string, payload: Record<string, unknown>, usage: { input: number; cached: number; output: number }, turnIds: readonly string[]): void => {
      const file = join(home, 'sessions', '2026', '09', '30', `rollout-2026-09-30T21-24-34-570Z-${threadId}.jsonl`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${transcriptLines(payload, usage, turnIds).join('\n')}\n`, 'utf8');
    };
    write(
      MAIN_THREAD_ID,
      { id: MAIN_THREAD_ID, session_id: MAIN_THREAD_ID, parent_thread_id: null, cwd: 'D:/work/repo', source: { subagent: null } },
      { input: 100, cached: 900, output: 50 },
      ['turn-1'],
    );
    write(
      CHILD_THREAD_ID,
      {
        id: CHILD_THREAD_ID,
        session_id: MAIN_THREAD_ID,
        parent_thread_id: MAIN_THREAD_ID,
        cwd: 'D:/work/repo',
        source: { subagent: { thread_spawn: { parent_thread_id: MAIN_THREAD_ID, depth: 1, agent_path: null, agent_nickname: '工作区检查' } } },
      },
      { input: 10, cached: 20, output: 5 },
      ['child-turn-1'],
    );
    return home;
  }

  /**
   * 主线程事件流跑完（推理 + 一条答复条目 ⇒ 主 **1** 轮、一条 `turn.completed` 交计量、
   * 一条 `collab_tool_call` 交出子线程 id），`codexHome` 下同时有主线程与子线程的会话文件。
   *
   * ⚠️ 2026-10-05 口径变更：主线程原来是 **2** 轮（推理也数），现在只数答复条目 ⇒ 1 轮；
   * 收尾的 `finalTurns = lastTurns + subagentTurns` 因此是 1 + 1 = 2（下面的断言跟着改）。
   */
  async function runCodexWithChildThread(): Promise<AgentRunResult> {
    const home = makeCodexHomeWithChild();
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'item.completed', item: { id: 'rs-1', type: 'reasoning', text: '先看看仓库' } },
            { type: 'collab_tool_call', receiver_thread_ids: [CHILD_THREAD_ID] },
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '子智能体做完了' } },
            { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } },
          ],
        }),
      },
    });
    return codexProvider.run(createRunInput({ configHome: home }));
  }

  it('终态结果带子线程那一份（收尾折进 result，不只是发一条事件）', async () => {
    const result = await runCodexWithChildThread();
    // 主线程 100/900/50 + 子线程 10/20/5
    expect(result.tokens).toEqual({ input: 110, cached: 920, output: 55, reasoningOutput: null, total: null });
    expect(result.subagentTokens).toEqual({ input: 10, cached: 20, output: 5, reasoningOutput: null, total: null });
    expect(result.turns).toBe(2); // 主 1 轮（答复条目；2026-10-05 口径变更，旧口径是 2）+ 子 1 轮
    // 轮次那一格的分量：**其中的子线程那一份**（`finalTurns = lastTurns + subagentTurns` 的加数）
    expect(result.subagentTurns).toBe(1);
  });

  /**
   * 终态那条 `usage` 事件也要带分量（2026-10-04）：界面在收尾那一刻拿到的是**事件**里的这一对
   * （主会话 = `turns` − `subagentTurns`），只写进 result 的话，行快照要等编排层的终态 patch
   * 才更新，而抽屉上的实时 Tooltip 在此期间显示的仍是一行。
   */
  it('终态那条 usage 事件把「全树轮次 + 子线程分量」一起交出去', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const home = makeCodexHomeWithChild();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'item.completed', item: { id: 'rs-1', type: 'reasoning', text: '先看看仓库' } },
            { type: 'collab_tool_call', receiver_thread_ids: [CHILD_THREAD_ID] },
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '子智能体做完了' } },
            { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } },
          ],
        }),
      },
    });
    await codexProvider.run(createRunInput({ configHome: home, onEvent: collectEvents(events) }));

    const last = events.filter((event) => event.type === 'usage').at(-1);
    // 合计 = 主 1 轮（答复条目；2026-10-05 口径变更，旧口径是 2）+ 子 1 轮；分量 = 子那一份
    expect(last?.type === 'usage' ? last.turns : null).toBe(2);
    expect(last?.type === 'usage' ? last.subagentTurns : 'not-usage').toBe(1);
    expect(last?.type === 'usage' ? last.subagentTokens : null).toEqual({
      input: 10,
      cached: 20,
      output: 5,
      reasoningOutput: null,
      total: null,
    });
  });

  /**
   * **收尾那条 `usage` 的归属必须是主线程口径**（2026-10-05，spec §2.3 的计划补丁）。
   *
   * 为什么非有不可：这条收尾事件带的是**权威计量**，必然成为一条用量里程碑；`turn: null` 会让它
   * 回落「按时刻归位」——正是本次要修掉的旧行为（spec §1.2）。而这一格有两个**都不报错**的近邻：
   *   · `finalTurns`（本行合计 = 主 + 子）：拿它当会话轮次号会把这条读数挂到**别的会话同号**的轮次上；
   *   · 写死的 `1`：看着像「主线程第 1 轮」，但主线程跑了几轮它就说几轮。
   * 夹具刻意让两者**不等**（主 2 轮 + 子 1 轮 ⇒ `lastTurns = 2`、`finalTurns = 3`）⇒ 这条守卫对
   * 「写成 `finalTurns`」与「写成 `1`」两种变异**都**会红（见 Task 5 报告的变异清单）。
   * 前面那条 `turns: 3` 先钉住夹具真的落在「两个号不等」的形状上，否则这一条会退化成空转。
   */
  it('收尾那条 usage 的归属 = 主线程轮次（`lastTurns`），不是本行合计 `finalTurns`', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const home = makeCodexHomeWithChild();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'item.completed', item: { id: 'rs-1', type: 'reasoning', text: '先看看仓库' } },
            { type: 'collab_tool_call', receiver_thread_ids: [CHILD_THREAD_ID] },
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '第一步' } },
            { type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: '第二步' } },
            { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } },
          ],
        }),
      },
    });
    await codexProvider.run(createRunInput({ configHome: home, onEvent: collectEvents(events) }));

    const last = events.filter((event) => event.type === 'usage').at(-1);
    // 合计 3 = 主 2（答复条目）+ 子 1；分量 1 = 子那一份。两格与归属**同一条事件**上一起给。
    expect(last?.type === 'usage' ? last.turns : null).toBe(3);
    expect(last?.type === 'usage' ? last.subagentTurns : 'not-usage').toBe(1);
    // 归属：主线程的号（2）——不是合计 3、也不是写死的 1；会话恒为 `null`（codex 的 usage 只由主线程发）
    expect(last?.type === 'usage' ? last.turn : 'not-usage').toEqual({ subagentId: null, round: 2 });
  });

  /**
   * 合计报不出来时（事件流**一个答复条目都没数到** ⇒ `lastTurns` 为 `null`）分量必须是 `null`：
   * 轮次那一格的合计在这里没有诚实的值（「计量绝不填 0」），而**孤儿分量**会让界面按
   * 「主会话 = 合计 − 分量」算出一个不存在的主会话。这条守卫钉的是
   * `finalTurns === null ⇒ subagentTurns === null` 这一对（变异：把分量无条件交出去 ⇒ 红）。
   *
   * 夹具：事件流只有 `thread.started` 与一条 `collab_tool_call`（**都不是**答复条目）⇒
   * `lastTurns` 为 `null`；而子线程文件里确有一个轮次标识（它算得出来，但不该被交出去）。
   */
  it('事件流一次模型往返都没数到 ⇒ 分量同样为 null（不拿孤儿分量冒充）', async () => {
    const recorder = createRecorder();
    const home = makeCodexHomeWithChild();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'collab_tool_call', receiver_thread_ids: [CHILD_THREAD_ID] },
          ],
        }),
      },
    });
    const result = await codexProvider.run(createRunInput({ configHome: home }));

    expect(result.turns).toBeNull();
    expect(result.subagentTurns).toBeNull();
  });

  /**
   * 运行期那一半（Task 5 的 `project`）：流还开着的时候就把**合计与分量一起**交出去。
   *
   * 为什么要单独钉这一条：只给分量不给合计时，界面按「主会话 = 合计 − 分量」算出来的主会话是**负数**
   * ——而那个减法在界面上看起来完全正常（R2 的裁定）。**两条断言必须同一条事件**上成立。
   *
   * 用假定时器而不是真的等 800 ms：唯一的闸门是 `CONTENT_READ_MIN_INTERVAL_MS`，而 `Date.now()`
   * 也在假定时器里 ⇒ 推进时钟就能让那条晚到的事件触发一次读盘（不需要 sleep）。
   */
  it('运行期就把合计与子那一份一起交出去（同一条 usage 事件，不是只给分量）', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const home = makeCodexHomeWithChild();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          hang: true,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'collab_tool_call', receiver_thread_ids: [CHILD_THREAD_ID] },
            { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } },
          ],
          // 读盘闸门（500 ms）之后再来一条：那一刻子线程的会话文件才读得到
          lateEvent: { afterMs: 1_000, value: { type: 'item.completed', item: { id: 'late-1', type: 'agent_message', text: '还在跑' } } },
        }),
      },
    });
    const controller = new AbortController();
    const running = codexProvider.run(
      createRunInput({ configHome: home, signal: controller.signal, onEvent: collectEvents(events) }),
    );
    await vi.advanceTimersByTimeAsync(1_500);

    const last = events.filter((event) => event.type === 'usage').at(-1);
    // 主 100/900/50 + 子 10/20/5：合计与分量同一条事件
    expect(last?.type === 'usage' ? last.tokens : null).toEqual({
      input: 110,
      cached: 920,
      output: 55,
      reasoningOutput: null,
      total: null,
    });
    expect(last?.type === 'usage' ? last.subagentTokens : undefined).toEqual({
      input: 10,
      cached: 20,
      output: 5,
      reasoningOutput: null,
      total: null,
    });
    /**
     * ⚠️ **轮次那一格运行期不交分量**（2026-10-04，刻意）：这一格的分母是**运行期的合计**，
     * 而 codex 运行期的 `turns` 是**主线程口径**（事件流数出来的近似轮次，子线程的要到收尾才并进来，
     * 见 `finalize` 的注释）⇒ 交一个子线程分量出去，界面算出的「主会话 = 合计 − 分量」会算出
     * **负数**（子线程常常比主线程轮次多），那条 `subagentTurns ≤ turns` 的硬口径当场被破坏。
     * 分量与全树合计**在收尾那一条上一起给**（上一条用例钉的就是它）。
     */
    expect(last?.type === 'usage' ? last.subagentTurns : 'not-usage').toBeNull();

    controller.abort();
    await settleWithFakeTimers(running, { stepMs: 500, steps: 10 });
  });

  /**
   * 运行期第三条分支（2026-10-04 评审 Important 1）：**分量读不出来时，必须把它显式清成 `null`**。
   *
   * 真机形状：c1 已经跑完（它的会话文件里有可用的累计用量），这一轮又派了 c2，而 c2 的会话文件
   * 还没写出可用的 `total_token_usage`（`normalizedTotalUsage` 要三格齐全才认）⇒ 按「全量或 null」
   * 整个分量是 `null`。此时若图省事地「这一条什么都不带」，键缺省会让**上一版那个非零分量**留在骨架里
   * （`turn.ts` 的 R2 规则），而 `base.tokens` 在 `turn.completed` 这一条上正是**主线程口径**的数
   * ⇒ 事件上出现「主线程口径的合计 + 非零分量」，界面算出的主会话偏小、总量从 110 掉回 100。
   *
   * 时间线（假定时器；两次刷新分别落在 `thread.started` 与那条晚到的 `turn.completed` 上）：
   *   ① 模型条目 → ② `turn.completed`（事件流给 100/900/50）→ ③ 登记 c1 → ④ `thread.started`
   *   （**第一次刷新**：c1 可读 ⇒ 把 110/920/55 与 {10,20,5} 写进骨架）→ ⑤ 又一条模型条目
   *   （本条不带计量，闸门内不刷新 ⇒ 骨架里那一对**原样发出去**）→ ⑥ 登记 c2（**盘上没有它的文件**）
   *   → 晚到 1000 ms 的 `turn.completed`（**第二次刷新**：c2 读不到 ⇒ 分量 `null`）。
   *
   * ⚠️ ④ 那一格同时钉住了上位实现选择：合计是在**不带计量**的消息上折出来的
   * （折的是事件流最新那份 `wireTokens`，不是本条消息的 `tokens`）——只看本条消息的话，这里不会
   * 有任何一对可发，本用例的「前半段」也就无从谈起。
   */
  it('再一次刷新里子线程读不到 ⇒ 分量被显式清成 null（绝不与主线程口径的合计配成一对）', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const home = makeCodexHomeWithChild();
    /** 只登记 id、盘上**没有**会话文件的第二个子线程（它的累计用量这一轮读不出来） */
    const MISSING_CHILD_THREAD_ID = '01a0f434-bbbb-7161-afca-c0a8934ee777';
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          hang: true,
          events: [
            { type: 'item.completed', item: { id: 'rs-1', type: 'reasoning', text: '先看看仓库' } },
            { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } },
            { type: 'collab_tool_call', receiver_thread_ids: [CHILD_THREAD_ID] },
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: '子智能体还在跑' } },
            { type: 'collab_tool_call', receiver_thread_ids: [MISSING_CHILD_THREAD_ID] },
          ],
          // 闸门（500 ms）之后再来一条 `turn.completed`：这一次刷新里 c2 读不到
          lateEvent: {
            afterMs: 1_000,
            value: { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } },
          },
        }),
      },
    });
    const controller = new AbortController();
    const running = codexProvider.run(
      createRunInput({ configHome: home, signal: controller.signal, onEvent: collectEvents(events) }),
    );
    await vi.advanceTimersByTimeAsync(1_500);

    const usages = events.filter((event) => event.type === 'usage');
    // 前半段：合计与分量**一起**出现过（110/920/55 + {10,20,5}）——这正是后半段要清掉的那一对
    const paired = usages.find((event) => event.type === 'usage' && event.subagentTokens != null);
    expect(paired?.type === 'usage' ? paired.tokens : null).toEqual({
      input: 110,
      cached: 920,
      output: 55,
      reasoningOutput: null,
      total: null,
    });
    // 后半段：**没有**任何一条事件带着「主线程口径的合计 + 非零分量」（那种形状界面会算出负数）
    for (const event of usages) {
      if (event.type !== 'usage' || event.subagentTokens == null) continue;
      expect(event.tokens?.input ?? 0).toBeGreaterThanOrEqual(110);
    }
    // 而且分量是**显式 null**（= 明确没采到 ⇒ 覆盖旧值），不是留着上一版那个偏大的 {10,20,5}
    const last = usages.at(-1);
    expect(last?.type === 'usage' ? last.tokens : null).toEqual({
      input: 100,
      cached: 900,
      output: 50,
      reasoningOutput: null,
      total: null,
    });
    expect(last?.type === 'usage' ? last.subagentTokens : 'missing').toBeNull();

    controller.abort();
    await settleWithFakeTimers(running, { stepMs: 500, steps: 10 });
  });
});
