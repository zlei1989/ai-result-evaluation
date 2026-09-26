// @vitest-environment node
/**
 * codex 适配器：注入落点（客户端选项 + 完整 model_providers 条目 + 独立 CODEX_HOME/TMPDIR）、
 * 事件贯通、临时目录回收、加载降级。
 * 另含一条控制方追加的回归钉：投影 `failure` 非空的出口（三个适配器共用）。
 */
import type { AgentEvent } from '@aieval/contracts';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeCodexSdk,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import { codexProvider } from './index';
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
    // 「键不存在」而不是「值为 undefined」：SDK 会把它摊成 `--config key=value` 交给 CLI
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
     * **`multi_agent` 必须走 `features.` 前缀**（2026-09-27 实测修正）。
     *
     * 旧写法把它放在 `tools.` 下，CLI 0.156.1 把它当「不认识的 session-flag」忽略
     * （事件流里回一句「Codex is ignoring … `tools.multi_agent` is ignored」），**照默认值跑**——
     * 而实测默认是 `codex features list` 里的 `multi_agent stable true`：
     * 也就是说这条「关掉多智能体」的护栏**从来没有生效过**（§5.6.4 的理由：命名空间工具
     * 在网关侧常回 400）。判据用**真 CLI** 离线核验过（见冒烟记录 §6）：修正后的两个键
     * 一个都不再出现在忽略清单里。
     */
    expect(config.features).toEqual({ multi_agent: false });
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

  it('事件贯通：模型产出条目实时累加轮次、turn.completed 交计量、item 文本进日志、未识别事件保留', async () => {
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
      // 近似口径：两条模型产出条目 ⇒ 2 轮（codex 的事件流里没有逐次请求事件，见 events.ts 文件头）
      turns: 2,
      // `input` 是**归一后**的非缓存输入：`10 − 1 = 9`（见 events.ts 的 readTokens）
      tokens: { input: 9, cached: 1, output: 2, reasoningOutput: null, total: null },
    });
    // 三条：两条模型产出条目（轮次 1 → 2，此时还没有用量 ⇒ tokens 为 null），
    // 收尾的 turn.completed 把计量带上（turns 不变、tokens 从 null 变成采到的值 ⇒ 仍要发一条）。
    // 收尾之后不会再有一条「内容相同」的重复信号——去重在骨架里（`sameUsage`）。
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages.map((event) => (event.type === 'usage' ? [event.turns, event.tokens] : null))).toEqual([
      [1, null],
      [2, null],
      [2, { input: 9, cached: 1, output: 2, reasoningOutput: null, total: null }],
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
    // 轮次的门槛是「模型产出条目」；一条都没有时给 null，而不是拿 turn.completed 数出一个 1
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
            { type: 'item.completed', item: { id: 'rs-1', type: 'reasoning', text: '想一下' } },
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
 * 思考强度（spec §6.4 / D13）：档位字符串原样进 `startThread` 的 `modelReasoningEffort`
 * （codex-sdk 的 `ModelReasoningEffort` 是个八值联合，我们不做任何映射 —— 映射就是静默改语义）。
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
});
