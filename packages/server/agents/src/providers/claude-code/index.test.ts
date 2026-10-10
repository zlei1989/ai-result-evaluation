// @vitest-environment node
/**
 * claude-code 适配器：注入落点、凭据隔离正反两面、事件贯通、超时释放顺序、加载降级。
 * 全部走假 SDK 注入 —— 单测不碰真实 CLI、不碰真实 API、不产生费用。
 * 另含两条控制方追加的回归钉：投影 `failure` 非空的出口（三个适配器共用）、以及
 * `onGraceExceeded` 这条 `release.ts ↔ turn.ts` 接缝上的抛错路径。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EFFORT_OFF, type AgentEvent, type SubagentRecord } from '@aieval/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeClaudeSdk,
  createRecorder,
  createRunInput,
  FIXTURE_CONFIG_HOME,
  FIXTURE_CWD,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import type { AgentRunResult } from '../../types';
import {
  CLAUDE_CODE_EXTRA_BODY,
  CLAUDE_OFF_DISABLED_WARNING_TEXT,
  claudeCodeProvider,
  claudeExtraEnvFor,
  HOST_DISABLE_BETAS_ENV,
  hostDisablesBetas,
} from './index';
import { CLAUDE_PACKAGE_NAME } from './sdk';
import { removeTreeWithRetry } from '../../testing/cleanup';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  // 环境还原：本文件有 `vi.stubEnv` 的用例（body 覆盖层；WARN 加固那一批由 T3 加），漏还原会漏给后面的用例
  vi.unstubAllEnvs();
});

/** 收集 logger 的 error 级输出（受保护发射口吞掉异常后必须仍然可见） */
function captureLoggerErrors(): string[] {
  const messages: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(' '));
  });
  return messages;
}

describe('claudeCodeProvider', () => {
  it('注入落点：baseUrl 拆掉尾部 /v1 进 ANTHROPIC_BASE_URL、模型进 options.model、cwd 与 settings 三件套到位', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(
      createRunInput({
        route: {
          protocolType: 'anthropic',
          baseUrl: 'https://gw.example.com/anthropic/v1/',
          apiKey: 'sk-claude',
          modelId: 'claude-x',
        },
      }),
    );
    expect(recorder.env?.ANTHROPIC_BASE_URL).toBe('https://gw.example.com/anthropic');
    expect(recorder.env?.ANTHROPIC_API_KEY).toBe('sk-claude');
    expect(recorder.env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-claude');
    expect(recorder.env?.CLAUDE_CONFIG_DIR).toBe(FIXTURE_CONFIG_HOME);
    expect(recorder.env?.HOME).toBe(FIXTURE_CONFIG_HOME);
    /**
     * 任务跟踪工具必须**常开**（用户口径 2026-09-30）。
     * 为什么这条守卫值得存在：不开它时 claude 的工具表里**一个 `Task*` 都没有**
     * （A/B 实测 26 → 30），`task` 族在 claude 侧恒为空 —— 那是**静默的空**，
     * 界面上与「这一轮没做规划」长得一模一样，跨家比较会因此失真。
     */
    expect(recorder.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');
    expect(recorder.options?.model).toBe('claude-x');
    expect(recorder.options?.cwd).toBe(FIXTURE_CWD);
    // 打开 settings 是被测仓库的 CLAUDE.md 能生效的**前提**（SDK 的 JSDoc 逐字：
    // 「Must include `'project'` to load CLAUDE.md files」）——`[]` 会把仓库自己的作业说明一起挡住。
    expect(recorder.options?.settingSources).toEqual(['user', 'project', 'local']);
    /**
     * 子智能体的文本/思考必须转发（spec §6.4.2）。
     * 为什么这条守卫值得存在：不开它时子智能体只发 `tool_use`/`tool_result`
     * （官方逐字 "enough for a heartbeat counter"），于是**子智能体说了什么、想了什么全都看不到**——
     * 真机 A/B：不开时子智能体消息 5 条、开了 10 条（多出 `thinking:3` + `text:3`）。
     * 那是**静默的空**：派发面板看起来"工作正常"，只是永远只有工具流水。
     */
    expect(recorder.options?.forwardSubagentText).toBe(true);
    /**
     * 流式增量必须**常开**（2026-10-09，兑现 `streamingDelta: 'yes'` 的声明）。
     * 为什么这条守卫值得存在：不开它 wire 上一个 `stream_event` 都没有，解析路径整条空转——
     * 能力声明与实现不一致（旧账：《消息规范》已知边界表「声明与实现不一致」一行，本次闭合）。
     * 那是**静默的空**：界面永远整块出正文，与「厂商不支持」长得一模一样。
     */
    expect(recorder.options?.includePartialMessages).toBe(true);
    // 禁用名单逐字钉死：少一项就是「那条旁路又回来了」，多一项得先在 ALWAYS_DISALLOWED_TOOLS 里写清理由。
    // 这里用的是 `claude-x`（含 `claude`）⇒ **不含** `WebSearch`；那一格随模型名分档，两端由下一条用例钉。
    expect(recorder.options?.disallowedTools).toEqual([
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'PushNotification',
      'DesignSync',
    ]);
    // 成对的另一半（flag 档）：打开 settings 就等于允许 `${cwd}/.claude/settings.json` 的 env 块改写
    // 本次路由——本机实测（CLI 2.1.281，三档回环对照）：只开 settingSources 时 14 次 `/v1/messages`
    // 全部打到仓库指定的地址与密钥；补上这一格后全部回到本次路由。少了它，上面那条断言就是「打开了
    // 一个能顶掉路由的开关而没有任何东西顶回去」。
    const pinned = (recorder.options?.settings as { env?: Record<string, string> } | undefined)?.env;
    expect(pinned).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com/anthropic',
      ANTHROPIC_API_KEY: 'sk-claude',
      ANTHROPIC_AUTH_TOKEN: 'sk-claude',
    });
    // 两半必须**同源**：只改注入、忘了改这一格（或反过来）会让「看起来路由是对的、实际打到别处」，
    // 而那种偏差在界面上完全看不见。
    expect(pinned?.ANTHROPIC_BASE_URL).toBe(recorder.env?.ANTHROPIC_BASE_URL);
    expect(pinned?.ANTHROPIC_API_KEY).toBe(recorder.env?.ANTHROPIC_API_KEY);
  });

  it('WebSearch 随模型名分档：modelId 含 claude 放行、其余模型禁用（大小写不敏感，子串判定）', async () => {
    // 为什么这一格要单独钉两端：它是名单里**唯一随模型变**的一项，而写坏的方式恰好是最静默的两种——
    //   · 判据写成 `modelId === 'claude'` / 只匹配小写前缀 ⇒ 网关侧的 `anthropic/claude-sonnet-4-6`
    //     被当成「非 Claude 模型」，WebSearch 白禁；
    //   · 判据反过来（`!includes`）⇒ 第三方模型拿到网关不实现的工具（§5.6.5：网关对这类命名空间
    //     工具回 400），行会以工具报错收场，而界面上只看到「模型报错」。
    const cases: Array<{ modelId: string; webSearchBanned: boolean }> = [
      { modelId: 'claude-sonnet-4-6', webSearchBanned: false },
      { modelId: 'anthropic/Claude-4.5', webSearchBanned: false }, // 大小写 + 网关前缀两种写法
      { modelId: 'jd/GLM-5.3', webSearchBanned: true },
      { modelId: 'JoyAI-Code-1.6', webSearchBanned: true },
    ];
    for (const { modelId, webSearchBanned } of cases) {
      const recorder = createRecorder();
      setAgentRuntimeForTesting({
        sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) },
      });
      await claudeCodeProvider.run(
        createRunInput({ route: { protocolType: 'anthropic', baseUrl: 'https://gw.example.com/anthropic', apiKey: 'sk-x', modelId } }),
      );
      const banned = recorder.options?.disallowedTools as string[] | undefined;
      expect(banned?.includes('WebSearch'), `${modelId} 的 WebSearch 禁用状态`).toBe(webSearchBanned);
      // 其余六项与模型无关：任何模型都不许放行（判据错成「整体反转」时这条先红）
      expect(banned).toEqual(expect.arrayContaining(['CronCreate', 'ScheduleWakeup', 'PushNotification', 'DesignSync']));
    }
  });

  it('执行阶段的权限档：permissionMode: bypassPermissions **必须**带 allowDangerouslySkipPermissions', async () => {
    // 为什么这条是必修：缺权限档的后果不是「偶尔要确认一次」，而是本产品的核心动作
    // （改工作区里的文件）根本发生不了——p6 冒烟里 7 行 claude-code **全部 0 改动**，
    // 评分在「无改动」输入上打出 20 分（run.json 里评分模型自己写「diff 为空」）。
    // 而 `bypassPermissions` **单独给是无效的**：SDK 把它与 `allowDangerouslySkipPermissions`
    // 拼成两个独立 argv（`--permission-mode` / `--allow-dangerously-skip-permissions`），
    // 类型面也逐字写着「Must be set to `true` when using …」。只钉前者会漏掉真正承重的那一半。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ permission: 'full' }));
    expect(recorder.options?.permissionMode).toBe('bypassPermissions');
    expect(recorder.options?.allowDangerouslySkipPermissions).toBe(true);
  });

  it('评分阶段的权限档：dontAsk + permissionPrompts: none（读放行、写被拒，且不挂在无人应答的批准上）', async () => {
    // 为什么不是 `plan`：`plan` 的语义是「不执行任何工具」，评审者连 `git diff` 都跑不了——
    // 而它的工作正是**自己去看改动**（这正是不走文本通路的理由，见 judge-agent.ts 头注）。
    // 为什么必须带 `permissionPrompts: 'none'`：评测没有任何批准面，越界操作要**当场被拒**
    // 并把原因回给模型；少了它，一次越界会挂在一个永远没人应答的批准上，把该行无限拖住
    // ——那时界面上看到的是「一直没结束」，而真实原因是「它想写文件」。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ permission: 'read-only' }));
    expect(recorder.options?.permissionMode).toBe('dontAsk');
    expect(recorder.options?.permissionPrompts).toBe('none');
    // 反向断言：只读档**不许**顺手把跳过批准也打开（两档共用一个选项对象时最容易出的错）
    expect(recorder.options?.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('不给 SDK 传 maxTurns（执行段完全不限轮次，2026-09-28 用户口径）', async () => {
    // 为什么这条必须钉住：SDK 的 `maxTurns` 是「最大 API 往返次数」，加回来就等于**我们自己**给执行段
    // 装了上限——而口径是「一行只会因为跑完 / 失败 / 用户点终止结束」。删它的时候一个用例都不会红，
    // 所以「有人顺手加个保险」这件事今天只有这条守卫能拦住。
    // 判据写 `undefined` 而不是「大于某个数」：设一个大数字仍然是上限，长任务照样会被掐断，只是更晚。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({}));
    expect(recorder.options?.maxTurns).toBeUndefined();
  });

  it('cwd 做 realpath 归一：8.3 短名路径不得原样交给 SDK（终审 H1 的另一半）', async (ctx) => {
    // 两条一起做才完整：`permissionMode` 只放宽「编辑要不要逐个批准」，**不放宽路径安全门**。
    // 那道门把含 8.3 短名的路径判为「需要人工确认」，连 Read 都拦（p6 `04-runA.md:93-109` 的
    // decision_reason 原文 + CLI 自述）⇒ 冒烟夹具的 `C:\Users\ZHANGL~1\...` 让整行写不动。
    //
    // 这里钉的是**实现细节，不是措辞**：把真实存在的目录换成短名形态（`GetShortPathName` 的产物），
    // 断言「SDK 拿到的 cwd 不等于短名形态」。若哪天归一被去掉（或误用 JS 版 `realpathSync`——
    // 本机实测它在 Windows 上**不**做短名归一，只有 `.native` 才做），recorder 里就会留着
    // `ZHANGL~1`，本用例当场红。
    //
    // ⚠️ 本机实测：`os.tmpdir()` 本身就是短名形态（`C:\Users\ZHANGL~1\AppData\Local\Temp`），
    // 所以短名目录直接在它下面建即可，不必额外调 Win32 的 `GetShortPathName`。文件系统关掉了
    // 8.3 生成的机器上 `tmpdir()` 不含 `~1`，这条构造不出来 ⇒ 显式跳过并说明（不静默假绿）。
    const shortRoot = tmpdir();
    if (!/~\d/.test(shortRoot)) {
      // 用一条可读的跳过原因，而不是悄悄 return：静默跳过会让「守卫还在不在」无从判断。
      //
      // 为什么是 `ctx.skip(原因)` 而不是 `expect.soft(…)`（2026-10-07 修正）：后者**判这条红**，
      // 于是「本机造不出短名」这件事表现成一条恒红——实测（本机 8.3 生成已关，`tmpdir()` 是长名
      // `C:\Users\Zlei1\AppData\Local\Temp`）整个门禁永远挂着一条与代码无关的红。
      // `ctx.skip` 仍然**看得见**：摘要里记一条 skipped，并把这句原因原样带出来。
      ctx.skip(`本机 tmpdir 不含 8.3 短名（${shortRoot}），H1 的归一用例在此环境不可构造`);
    }
    const probeRoot = join(shortRoot, `aieval-h1-cwd-${randomUUID()}`);
    const shortDir = join(probeRoot, 'workspace');
    mkdirSync(shortDir, { recursive: true });
    try {
      expect(shortDir).toContain('~1'); // 前提成立（否则下面那条断言就是空转的）

      const recorder = createRecorder();
      setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
      await claudeCodeProvider.run(createRunInput({ cwd: shortDir }));

      expect(recorder.options?.cwd).toBe(realpathSync.native(shortDir));
      expect(String(recorder.options?.cwd)).not.toBe(shortDir);
      expect(String(recorder.options?.cwd)).not.toContain('~1');
    } finally {
      removeTreeWithRetry(probeRoot);
    }
  });

  it('终止时的 interrupt() 不许留下没人处理的 rejection（终审 H3：裸 void 会打崩进程）', async () => {
    // p6 实测 14 次 `unhandledRejection: Error: Query closed before response received`，
    // 堆栈逐层指向 `providers/claude-code/index.ts` 的 `void query.interrupt?.()`。
    // 生产环境 Node 默认 `--unhandled-rejections=throw` ⇒ 这是**能终结进程**的形状。
    // 判据是「那份被拒 promise 有没有被挂上 handler」（夹具在下一个微任务结算），
    // 不与运行器如何处置 unhandledRejection 挂钩。
    vi.useFakeTimers();
    const recorder = createRecorder();
    const controller = new AbortController();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [],
          hang: true,
          interrupt: 'ignore',
          interruptRejects: 'Query closed before response received',
        }),
      },
    });
    // 停止入口只有 `signal`（用户点「终止」）：适配器没有内层超时、编排层也没有兜底超时了
    const promise = claudeCodeProvider.run(createRunInput({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    // 步长必须跨过 RELEASE_GRACE_MS（5 秒）：`interrupt: 'ignore'` 的适配器要靠第二段兜底才收场
    // （实测踩过：500ms × 10 落在 grace 之内，promise 永远不落定 ⇒ 误报成「用例挂住了」）
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 20 });

    expect(result.exitReason).toBe('canceled');
    // 判据是 `then` 被调过：`Promise.resolve(x).catch(…)` 会同步调它一次，裸 `void x` 一次都不调。
    // 这条断言不依赖运行器怎么报 unhandledRejection，也不依赖微任务时序（两种更弱的写法都实测会误判）。
    expect(recorder.interruptThenCalls).not.toBeNull();
    expect(recorder.interruptThenCalls?.()).toBeGreaterThan(0);
    // 吞掉 rejection **不等于**吞掉释放：dispose 照常、恰好一次（它才是硬回收）
    expect(recorder.order.filter((entry) => entry === 'dispose')).toHaveLength(1);
    expect(recorder.order[0]).toBe('interrupt');
  });

  it('凭据隔离：子进程拿到了密钥，宿主 process.env 一个字段都没变（Review Focus #2）', async () => {
    const before = { ...process.env };
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(createRunInput());
    expect(recorder.env?.ANTHROPIC_API_KEY).toBe('sk-test-key'); // 正面：子进程拿到了
    expect({ ...process.env }).toEqual(before); // 反面：宿主一个字段都没被写
  });

  it('事件贯通：消息流被投影成日志与 usage 事件，结果带回计量', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', uuid: 's1' },
            { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: '改好了' }] } },
            {
              type: 'result',
              uuid: 'r1',
              result: '任务完成',
              num_turns: 2,
              usage: { input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 20 },
            },
          ],
        }),
      },
    });
    const result = await claudeCodeProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({
      ok: true,
      exitReason: 'completed',
      tokens: { input: 100, cached: 10, output: 20 },
      turns: 2,
    });
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
    expect(events.some((event) => event.type === 'log' && event.text.includes('改好了'))).toBe(true);
    expect(events[0]?.seq).toBe(1); // run 内 seq 从 1 开始
  });

  it('用户终止：顺序为 interrupt → turn 终结 → dispose（§5.6.6）', async () => {
    vi.useFakeTimers();
    const recorder = createRecorder();
    const controller = new AbortController();
    setAgentRuntimeForTesting({
      sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [], hang: true }) },
    });
    const promise = claudeCodeProvider.run(createRunInput({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const result = await settleWithFakeTimers(promise, { stepMs: 500, steps: 10 });
    expect(result.exitReason).toBe('canceled');
    expect(recorder.order).toEqual(['interrupt', 'turn-end', 'dispose']);
  });

  it('厂商包缺失或形状不对：AGENT_LOAD_FAILED 且文案含包名与安装方式；同一进程内后续一轮可重试成功（Review Focus #4）', async () => {
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: {} } });
    const first = await claudeCodeProvider.run(createRunInput());
    expect(first).toMatchObject({ ok: false, exitReason: 'error' });
    expect(first.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(first.error?.message).toContain(CLAUDE_PACKAGE_NAME);
    expect(first.error?.message).toContain('pnpm add');

    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    const second = await claudeCodeProvider.run(createRunInput());
    expect(second.ok).toBe(true);
  });

  it('厂商消息里的失败（投影 failure 非空）折进结果：exitReason error + error 事件落到 onEvent，run 不抛（b4 派发稿点名的无主出口）', async () => {
    // 这条出口是三个适配器共用的：`runTurn` 只在 `projection.failure` 非空时把厂商消息里的失败
    // 折成 `ok:false` + `exitReason:'error'`。此前没有任何用例覆盖它（T6 的合成 hooks 从没让它非空）。
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'assistant', uuid: 'a-err', message: { content: [{ type: 'text', text: '开始执行' }] } },
            {
              type: 'result',
              subtype: 'error_during_execution',
              uuid: 'r-err',
              is_error: true,
              result: 'HTTP 429 too many requests',
            },
          ],
        }),
      },
    });
    const result = await claudeCodeProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('RATE_LIMITED');
    expect(events.some((event) => event.type === 'error')).toBe(true);
    // 失败那条消息没有 usage / num_turns ⇒ 计量保持 null（绝不填 0），也不会发 usage 事件
    expect(result.tokens).toBeNull();
    expect(result.turns).toBeNull();
    expect(events.some((event) => event.type === 'usage')).toBe(false);
  });

  it('第二段兜底的 emit 出口抛错：不外抛、仍判 canceled、dispose 恰好一次、失败落 logger.error', async () => {
    // 控制方追加的回归钉（T5/T6 评审：6 个发射口里 onGraceExceeded 这一处至今无单出口用例）。
    // 消费方抛错是真实形状：p4 的 publishRowEvent → appendEvent 按契约 R26 在写侧 schema 不过时抛。
    const loggerErrors = captureLoggerErrors();
    vi.useFakeTimers();
    const recorder = createRecorder();
    const controller = new AbortController();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [], hang: true, interrupt: 'ignore' }),
      },
    });
    const promise = claudeCodeProvider.run(
      createRunInput({
        signal: controller.signal,
        onEvent: (event) => {
          // 只让「5 秒兜底」那条 WARN 抛：其他出口（结论摘要）照常放行
          if (event.type === 'log' && event.text.includes('秒内未结束在途 turn')) {
            throw new Error('日志写盘失败（兜底 WARN）');
          }
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(result.exitReason).toBe('canceled');
    expect(recorder.order.filter((entry) => entry === 'dispose')).toHaveLength(1);
    expect(loggerErrors.some((line) => line.includes('事件回调失败'))).toBe(true);
  });

  it('第二段兜底的回调自身抛错（logger 路径）：释放仍走完 dispose，结论照常给出，run 不抛', async () => {
    // 这条钉的是 release.ts ↔ turn.ts 的接缝：onGraceExceeded 不是「只是打个日志」，
    // 它一旦抛出去而 release 侧没有 try/catch，`dispose()` 永不执行（子进程/临时目录没人回收），
    // 且异常会从 runTurn 的 finally 冒出 ⇒ run() 抛、该行永远停在 running。
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('服务日志写入失败（兜底 WARN）');
    });
    const recorder = createRecorder();
    const controller = new AbortController();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [], hang: true, interrupt: 'ignore' }),
      },
    });
    const promise = claudeCodeProvider.run(createRunInput({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(warnSpy).toHaveBeenCalled();
    expect(result.exitReason).toBe('canceled');
    expect(recorder.order.filter((entry) => entry === 'dispose')).toHaveLength(1);
  });

  it('计量前提：同一条 result 同时给出 tokens 与 turns ⇒ 恰好一条 usage 事件（b4 派发稿口径）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            {
              type: 'result',
              uuid: 'r-both',
              result: '完成',
              num_turns: 3,
              usage: { input_tokens: 5, cache_read_input_tokens: 1, output_tokens: 2 },
            },
          ],
        }),
      },
    });
    const result = await claudeCodeProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result.tokens).toEqual({ input: 5, cached: 1, output: 2, reasoningOutput: null, total: null });
    expect(result.turns).toBe(3);
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
  });

  it('轮次与计量分两条消息给 ⇒ 结果值仍然对，且轮次一到那条把**已经采到的**计量一起发出去', async () => {
    // 2026-09-28 的口径：`usage` 的发射门槛是**轮次**（tokens 可空）。所以「只有 tokens 的那一条」
    // 不发事件，而随后给出轮次的那一条会把到目前为止的累计计量带上——少了这个携带，
    // 界面上的 tok 会在只带轮次的那条事件上掉回「采集中」。
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            {
              type: 'result',
              uuid: 'r-tokens',
              result: '第一段',
              usage: { input_tokens: 5, cache_read_input_tokens: 1, output_tokens: 2 },
            },
            { type: 'result', uuid: 'r-turns', result: '第二段', num_turns: 3 },
          ],
        }),
      },
    });
    const result = await claudeCodeProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result.tokens).toEqual({ input: 5, cached: 1, output: 2, reasoningOutput: null, total: null });
    expect(result.turns).toBe(3);
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages).toHaveLength(1);
    expect(usages[0]?.type === 'usage' ? [usages[0].turns, usages[0].tokens] : null).toEqual([
      3,
      { input: 5, cached: 1, output: 2, reasoningOutput: null, total: null },
    ]);
  });

  /**
   * 结构化输出的厂商选项落点（2026-09-28 评分通路）。
   *
   * 两条一起才完整：**给了**要真的落到 SDK 的 `outputFormat`（少一半就是「中性入参被适配器吃掉」，
   * 评分通路仍旧只能靠提示词请求 JSON）；**没给**要连这个键都不出现——候选执行阶段与文本评分走的是
   * 同一份 `sdk.query` 选项对象，多一个 `outputFormat: undefined` 在今天无害，但它让「这条路径到底
   * 有没有变」从源码上一眼看不出，而这一格的行为差异（CLI 侧重问直到符合 schema）不是无害的。
   * 判据用 `'outputFormat' in options` 而不是 `toBeUndefined()`：后者对「键存在但值是 undefined」
   * 与「键不存在」给出同一个结论，正好把要钉的那件事放过。
   */
  it('给了 outputSchema ⇒ options.outputFormat 是 json_schema 且 schema 原样带上', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };

    await claudeCodeProvider.run(createRunInput({ outputSchema: schema }));

    expect(recorder.options?.outputFormat).toEqual({ type: 'json_schema', schema });
  });

  it('没给 outputSchema ⇒ options 里没有 outputFormat 这个键（候选阶段与文本评分逐字不变）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput());

    const options = recorder.options;
    // 先钉住「选项对象确实到手了」（修复轮 2 / R25）：`options !== null && 'outputFormat' in options` 在
    // `recorder.options` 为 `null` 时短路成 `false` ⇒ 那半句断言会把「SDK 压根没被调用」也判成通过。
    // 空洞守卫比没有守卫更坏：它在报告里长得像一条已覆盖的约束。
    expect(recorder.options).not.toBeNull();
    expect(options !== null && 'outputFormat' in options).toBe(false);
  });

  /**
   * 入口侧 null 口径的**唯一守卫**（与 `providers/codex/index.test.ts` 的「显式为 null」那条成对）。
   * ⚠️ 不可删：类型检查拦不住它（条件展开这一形状零诊断——声明类型本就不含 `null`，变异后仍窄化到
   * 可赋值类型），lint 也拦不住（`eslint.shared.ts` 里没有类型感知规则）⇒ 删掉这条用例，CI 面上就
   * 再没有东西拦「显式 `null` 被当成有效值透给厂商 SDK」。这一退化在 CI 面是**静默**的
   * （要到运行期才由 CLI 自己响亮报错），所以只能靠用例守。
   */
  it('outputSchema 显式为 null ⇒ 与「没给」同义，options 里同样没有 outputFormat 这个键（不放行 `schema: null` 进 SDK）', async () => {
    // 类型上这一格不含 `null`，故要断言才传得进去（与 codex 那条同款写法）；判据仍用
    // `'outputFormat' in options` 而不是 `toBeUndefined()`——后者连「加了但值为 undefined」也放行。
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput({ outputSchema: null as unknown as Record<string, unknown> }));

    const options = recorder.options;
    expect(recorder.options).not.toBeNull();
    expect(options !== null && 'outputFormat' in options).toBe(false);
  });
});

/**
 * 窗口 ⇒ 模型名（spec §6.1 / D4）：cc 三家唯一能表达「1M 变体」的通道就是**模型名后缀**
 * （Agent SDK 里那个 `betas: ['context-1m-2025-08-07']` 入口已随 beta 退役）。
 * 判据用 `recorder.options?.model`（`createFakeClaudeSdk` 记录的**真实** query 入参），
 * 而不是本项目自己算出来的中间变量——中间变量绿了而 SDK 收到别的名字，正是这条要防的事。
 */
describe('claude-code 的 1M 后缀', () => {
  /** 一份最小可用的 anthropic 路由：`createRunInput` 是浅覆盖，route 必须整份给 */
  const ROUTE = {
    protocolType: 'anthropic' as const,
    baseUrl: 'https://gw.example.com/anthropic',
    apiKey: 'sk-test-key',
    modelId: 'GLM-5.3',
  };

  it.each([
    [1_000_000, 'GLM-5.3[1m]'],
    [1_048_576, 'GLM-5.3[1m]'],
    [999_999, 'GLM-5.3'],
    [undefined, 'GLM-5.3'],
  ])('窗口 %s ⇒ 传给 SDK 的模型名是 %s', async (contextWindow, expected) => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    // 显式 undefined 会让「值就是 undefined」与「没给」在对象里长得一样，故按分支构造
    const route = contextWindow === undefined ? ROUTE : { ...ROUTE, contextWindow };

    await claudeCodeProvider.run(createRunInput({ route }));

    expect(recorder.options?.model).toBe(expected);
  });

  it('模型名里本来就带 [1m] 时不重复拼接（幂等）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(
      createRunInput({ route: { ...ROUTE, modelId: 'GLM-5.3[1m]', contextWindow: 1_048_576 } }),
    );

    expect(recorder.options?.model).toBe('GLM-5.3[1m]');
  });

  /**
   * 后缀判定**不分大小写**：用户手工维护模型清单时写成 `X[1M]` 是很容易发生的事
   * （网关的 `displayName` 就常写成大写），而 `endsWith('[1m]')` 会把 `X[1M]` 判成「没带后缀」
   * 于是拼出 `X[1M][1m]` —— 那是一个**根本不存在**的模型名，而它只会在真跑时才炸。
   */
  it('名字带大写 [1M] 时也不重复拼接', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(
      createRunInput({ route: { ...ROUTE, modelId: 'GLM-5.3[1M]', contextWindow: 1_048_576 } }),
    );

    expect(recorder.options?.model).toBe('GLM-5.3[1M]');
  });
});

/**
 * 思考强度（spec §6.4 / D13）：档位字符串**原样**透传给 SDK 的 `options.effort`，
 * 没给就一个键都不加 —— SDK 会把 `undefined` 当成「没有这一格」还是「要一个 undefined 档」
 * 我们无从保证，而这条路径上的两种解释差别是「按默认档跑」与「报错」。
 * ⚠️ **唯一的例外是关闭档 `off`**（2026-10-06）：它**不走** `effort`（`off` 不在 SDK 的
 * `EffortLevel` 值域里，直传会让 CLI 校验失败），而是翻成 `thinking: { type: 'disabled' }`
 * —— 见本组下面那条用例。
 */
describe('claude-code 的思考强度', () => {
  /**
   * 基线：先把宿主可能设过的同名变量清掉。
   * 为什么必须有：本组那条「非 off 档位的注入键集合逐字不变」读的是 `recorder.env`，
   * 而它是 `buildSubprocessEnv` 合并后的对象（以宿主 `process.env` 为底，`route.ts:88-90`）
   * ⇒ 宿主设过 `CLAUDE_CODE_EXTRA_BODY` 时那一条会**假红**（它不是我们的缺陷 ——
   * 真机 A/B 的 B 臂恰恰就是靠宿主设这个变量做到的，所以这台机器上它真有可能在场）。
   * 策略与 spec §5.1.1 一致：「键不存在」的判据落在**纯函数**上；真实运行面那一条
   * 则先把宿主那一格清干净。
   * 用 `vi.stubEnv(name, undefined)` 而不是 `delete process.env.X`：后者在测试里也是写入写法。
   * 还原交给文件级 `afterEach` 的 `vi.unstubAllEnvs()`（上面刚加的那一行）。
   */
  beforeEach(() => {
    vi.stubEnv(CLAUDE_CODE_EXTRA_BODY, undefined);
    // 同一个钩子里补这一行（Task 3，`HOST_DISABLE_BETAS_ENV`）：上面那段理由对它**逐字成立**
    // ——本组新加的「宿主没设 ⇒ `off` 档不出现 WARN」读的也是合并后的 `recorder.env`，
    // 宿主设过就假红。**并进同一个钩子**而不是另起一个 describe：两者都是「本组用例的宿主环境基线」，
    // 分成两处写必然漂移（一处补了新变量、另一处没有）。
    vi.stubEnv(HOST_DISABLE_BETAS_ENV, undefined);
  });

  it('给了 effort ⇒ options.effort 原样带上；没给 ⇒ 该键不存在', async () => {
    const withEffort = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: withEffort, events: [] }) },
    });
    await claudeCodeProvider.run(createRunInput({ effort: 'max' }));
    expect(withEffort.options?.effort).toBe('max');
    // 2026-10-06（Task 6 补）：**非 `off` 的档位不许带上 `thinking`**。此前这条用例只断 `effort`，
    // 于是把适配器改成「无条件加 `thinking: { type: 'disabled' }`」时全部用例仍绿
    // ⇒「关闭只在显式 `off` 时发生」这半句没有守卫（Task 2 评审 Minor 1）。
    expect(Object.hasOwn(withEffort.options ?? {}, 'thinking')).toBe(false);

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: bare, events: [] }) } });
    await claudeCodeProvider.run(createRunInput());
    expect(bare.options).not.toBeNull();
    expect(Object.hasOwn(bare.options ?? {}, 'effort')).toBe(false);
    // 守卫 6 的另一半：**未给**时 `thinking` 也不出现（同一变异体的第二条见证）
    expect(Object.hasOwn(bare.options ?? {}, 'thinking')).toBe(false);
  });

  /**
   * 显式关闭（2026-10-06 口径）：契约与界面统一用档名 `off`，**这一家要翻成
   * `thinking: { type: 'disabled' }`**（SDK 的 `EffortLevel` 里没有 off 档，关闭是另一个字段）。
   */
  it('显式 off ⇒ thinking: disabled 且不传 effort', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ effort: 'off' }));

    expect(recorder.options?.thinking).toEqual({ type: 'disabled' });
    expect(Object.hasOwn(recorder.options ?? {}, 'effort')).toBe(false);
  });

  it('档位域首项是 off（下拉框第一项）', () => {
    expect(claudeCodeProvider.metadata.reasoningEfforts[0]).toBe(EFFORT_OFF);
  });

  /**
   * **`off` 的修复（2026-10-06，spec §3.1）**：契约与界面统一用档名 `off`，而 CLI 的**模型能力门**
   * 会**故意**不把 `thinking:{type:'disabled'}` 写进请求体（它不认识 `deepseek-flash` 这类网关模型名，
   * 真机 A/B 逐字证据：不带 env ⇒ 请求体 8 个顶层键、**没有** `thinking`，响应里仍有思考块；
   * 带 env ⇒ 9 个键、多出 `"thinking":{"type":"disabled"}`，响应 `content_block` 只有 `text`）。
   * ⇒ 这一家必须靠**环境变量覆盖层**兜底；`thinking` 选项那一格（`index.ts:256`）保留不动，两半各管一批模型。
   *
   * ⚠️ 判据读的是 `recorder.env`（= 真的交给 SDK spawn CLI 的那一份），不是 `process.env`
   * ——注入了但没接进 spawn 的 env 等于没做。
   */
  it('显式 off ⇒ 注入 CLAUDE_CODE_EXTRA_BODY（从交给 SDK 的那份 env 读）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ effort: EFFORT_OFF }));

    expect(recorder.env?.[CLAUDE_CODE_EXTRA_BODY]).toBe('{"thinking":{"type":"disabled"}}');
  });

  /**
   * **值的合法性与形状**（spec §3.3）：CLI 对 `CLAUDE_CODE_EXTRA_BODY` 的**非法 JSON 静默忽略整条**
   * ——不报错、`thinking` 仍缺失、思考照旧。真机上就是这么踩的（第一次 A/B 的 B 臂作废：
   * PowerShell 5.1 吃掉了内层双引号，env 变成 `{thinking:{type:disabled}}`）。
   *
   * 这条用例就是「注入值必须是合法 JSON」的守卫，**变异体逐字同形于真机那次作废**：
   * 把实现从 `JSON.stringify(...)` 改成手写常量 `'{thinking:{type:disabled}}'` ⇒ `JSON.parse` 当场抛。
   */
  it('注入的值是合法 JSON，且深等于 { thinking: { type: disabled } }（非法 JSON 会被 CLI 静默整条忽略）', () => {
    const raw = claudeExtraEnvFor(EFFORT_OFF)[CLAUDE_CODE_EXTRA_BODY];
    expect(raw).toBe('{"thinking":{"type":"disabled"}}');
    // 合法性：解析失败会抛（这正是真机上那次作废的形状）
    expect(JSON.parse(raw ?? '')).toStrictEqual({ thinking: { type: 'disabled' } });
    /**
     * **键名逐字**：CLI 只认 `CLAUDE_CODE_EXTRA_BODY` 这一个字符串，名字写错的后果是
     * **整条静默失效**（CLI 读不到 ⇒ 什么都不做，思考照旧，与「没注入」逐字同形）。
     *
     * ⚠️ 这一格刻意用**字面量字符串**、不走上面那个共享常量：常量与实现同源，键名一旦被改错，
     * 走常量的断言会**跟着一起错**（两边同时变成错的键名 ⇒ 谁也发现不了）。
     * 判据取 `Object.keys`：既钉键名逐字，也钉「只注入这一条」（多注一条同样是行为改变）。
     */
    expect(Object.keys(claudeExtraEnvFor(EFFORT_OFF))).toStrictEqual(['CLAUDE_CODE_EXTRA_BODY']);
  });

  /** 其余档位**不注入**：**纯函数**判据，与宿主是否设过同名变量无关（spec §5.1.1） */
  it('其它档位不注入：claudeExtraEnvFor(max) 里没有这个键', () => {
    expect(Object.hasOwn(claudeExtraEnvFor('max'), CLAUDE_CODE_EXTRA_BODY)).toBe(false);
  });

  /** 未选**不注入**：同上，走纯函数（宿主环境不得影响这条判据） */
  it('未选档位不注入：claudeExtraEnvFor(undefined) 里没有这个键', () => {
    expect(Object.hasOwn(claudeExtraEnvFor(undefined), CLAUDE_CODE_EXTRA_BODY)).toBe(false);
  });

  /**
   * **其它档位与未选在真实运行里也逐字不变**（spec §1.3 约束 2）。
   * 为什么值得单开一条：上面两条走的是纯函数，证明的是「函数会返回空对象」；这一条证明的是
   * **空对象被条件展开进了 `injected` 之后没有留下任何键**——即「没有**新增**」那一半。
   *
   * ⚠️ 它**拦不住** `[CLAUDE_CODE_EXTRA_BODY]: off ? VALUE : undefined` 那种实现：`buildSubprocessEnv`
   * （`route.ts:94-96`）把 `undefined` 解释成「**删键**」，删完之后 `Object.hasOwn` 恰好就是 `false`，
   * 正好**满足**这条断言（2026-10-06 实测：那种实现下这一条**照绿**，宿主设没设同名变量都一样）。
   * ⇒「不许删键」那一半由下面那条「宿主设过同名变量…」见证，两条合起来才是「逐字不变」。
   */
  it('非 off 档位的注入键集合逐字不变：max 与未选都不带 CLAUDE_CODE_EXTRA_BODY', async () => {
    const withMax = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: withMax, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ effort: 'max' }));
    expect(Object.hasOwn(withMax.env ?? {}, CLAUDE_CODE_EXTRA_BODY)).toBe(false);

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: bare, events: [] }) } });
    await claudeCodeProvider.run(createRunInput());
    expect(Object.hasOwn(bare.env ?? {}, CLAUDE_CODE_EXTRA_BODY)).toBe(false);
  });

  /**
   * **「不许删键」那一半**（spec §3.1 约束 1 的正身，2026-10-06 实测补）：上面那条只证明
   * 「非 off 档**没有新增**这个键」，而它**拦不住** `[KEY]: off ? VALUE : undefined` 那种实现——
   * `buildSubprocessEnv`（`route.ts:94-96`）把 `undefined` 解释成「**删键**」，删完之后
   * `Object.hasOwn` 恰好就是 `false`，正好**满足**上面那条断言（实测：把实现改成显式 `undefined`，
   * 上面那条**照绿**）。⇒ 「其它档位与未选逐字不变」还差**另一半**：宿主**设过**同名变量时，
   * 非 off 档必须把它**原样留着**（既不许覆盖，也不许删掉）。
   *
   * 这一半同时是宿主环境的**反向**守卫：`beforeEach` 把该变量归零是为了让「键不存在」测的是我们的代码；
   * 而这一条反过来**显式设上**它，测的正是「我们没碰宿主的环境」。
   *
   * ⚠️ **两臂都要**（`max` 与**未选**）：约束点名的正是「其它档位**与未选**」，只测 `max` 会漏掉
   * 「未选」那一格——而它走的是**另一条**判据（`effort === undefined` 与 `effort === 'max'` 在
   * `claudeExtraEnvFor` 里是两个分支，将来只改其中之一时，单臂的哨兵是看不见的）。
   */
  it('宿主设过同名变量时，非 off 档与未选都把它原样留给子进程（既没覆盖也没被 undefined 删掉）', async () => {
    vi.stubEnv(CLAUDE_CODE_EXTRA_BODY, 'host-value');
    const withMax = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: withMax, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ effort: 'max' }));
    expect(withMax.env?.[CLAUDE_CODE_EXTRA_BODY]).toBe('host-value');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: bare, events: [] }) } });
    await claudeCodeProvider.run(createRunInput());
    expect(bare.env?.[CLAUDE_CODE_EXTRA_BODY]).toBe('host-value');
  });

  /**
   * **守卫 9a（纯判据四例）**（spec §5.1.1 守卫 9a 的判据三件套）：
   * ① env 无该键 ⇒ `null`；② 设 `'1'` ⇒ 返回命中（**键名原文**）；③ 设**小写拼写** ⇒ 同样命中、
   * 且回报的是**原拼写**（`route.ts:76-84`：逐项保留宿主的键名形态，Windows 常写 `Path`）；
   * ④ `'high'` 与未选 ⇒ 一律 `null`（**非 off 档不看**）。
   */
  it('判据（纯函数）四例：无键 ⇒ null；设 1 ⇒ 命中；小写拼写 ⇒ 命中且回报原拼写；非 off 档 ⇒ null', () => {
    /**
     * ⚠️ **每一例都要显式给第二个实参 `effort`**：它是判据的一部分（只在 `off` 档看），
     * 少给一个就等于「未选」⇒ 前三例会全部返回 `null`（连「命中」那两例也拿不到键名），
     * 而 `effort` 在签名里是**必需**参数 —— 漏给还会让 `pnpm.cmd typecheck` 报 TS2554。
     */
    expect(hostDisablesBetas({}, EFFORT_OFF)).toBeNull();
    expect(hostDisablesBetas({ [HOST_DISABLE_BETAS_ENV]: '1' }, EFFORT_OFF)).toBe(HOST_DISABLE_BETAS_ENV);

    // ③ 大小写不敏感、回报原拼写（变异体⑨的靶子：大小写敏感的精确键查找会在这里漏报）
    const lower = 'claude_code_disable_experimental_betas';
    expect(hostDisablesBetas({ [lower]: '1' }, EFFORT_OFF)).toBe(lower);

    // ④ 非 off 档不看：`off` 门就在这个函数里，所以「档位」也得是它的入参
    expect(hostDisablesBetas({ [HOST_DISABLE_BETAS_ENV]: '1' }, 'high')).toBeNull();
    expect(hostDisablesBetas({ [HOST_DISABLE_BETAS_ENV]: '1' }, undefined)).toBeNull();
  });

  /**
   * **守卫 9b 的第一、二半**（spec §5.1.1）：`off` 档 + 宿主设过 ⇒ `console.warn` 收到 WARN，
   * **且 message 逐字等于 §5.1.1 那段**（`<键名原文>` 处替换成实际拼写）。
   *
   * ⚠️ 第二半是**「不许改写」的守卫**：文案既然是契约，就得有断言钉住，否则必然漂。
   * 正文在这里是**字面量**（门审 Important，2026-10-06：改为**不**经 `CLAUDE_OFF_DISABLED_WARNING_TEXT` 拼）：
   * 常量的**字面值**若只改大小写（例如 `Claude_Code_Disable_Experimental_Betas`），9a 只有一条
   * **大小写不敏感**的字面量判据 ⇒ 六条断言会**全绿**，而产品侧拿去查宿主环境的名字跟着常量一起错
   * （POSIX 上大小写敏感 ⇒ WARN **永不触发**）——那正是本线反复出现的「经共享常量读键 ⇒ 一起错」。
   * 用字面量之后，常量的大小写漂移在这里**当场红**；常量模板与 spec 正文的逐字比对仍由本组最后那条
   * `WARN 文案模板与 spec §5.1.1 逐字一致` 看管（两半各钉一件事，不是两份正文）。
   *
   * ⚠️ 取值用 `'true'`（宿主的常见写法）而**不是** `'1'`：判据是「变量在不在」，
   * 窄成 `=== '1'` 会在这一形态下不告警（变异体⑩）。
   */
  it('off 档 + 宿主设过 ⇒ 落一条 WARN，message 逐字等于 spec §5.1.1 那段', async () => {
    vi.stubEnv(HOST_DISABLE_BETAS_ENV, 'true');
    /** `console.warn(message, context)` 的原文（两个参数都收下：下面分别比对 message 与 context） */
    const calls: unknown[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput({ effort: EFFORT_OFF }));

    /**
     * ① message **逐字**：日志器的前缀 `[WARN] [agents/claude-code] ` 由 `core/src/logger.ts:25-27`
     * 的 `format` 拼出，**不在** message 里 ⇒ 这里比的是去掉前缀之后的那一段。
     *
     * ⚠️ 契约正文**逐字写在这里**、且键名用**字面量**（理由见上，门审 Important）：
     * 常量的字面值一旦漂移（尤其只改大小写），走常量拼出来的判据会跟着一起错、当场全绿。
     */
    const expected =
      'off 档的关闭被静默忽略：子进程环境里存在 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS，它使 CLAUDE_CODE_EXTRA_BODY 的 body 覆盖失效，本次运行的 off 档读数作废；处置：从运行环境里去掉该变量后重跑，或改用别的方式关闭思考。';
    expect(calls.length).toBeGreaterThan(0);
    const hit = calls.find((args) => String(args[0]).endsWith(expected));
    expect(hit).toBeDefined();
    // 顺带钉住「没有第二个参数混进 message」：参数 0 必须**以那段文案结尾**（前缀之外一字不多）
    expect(String(hit?.[0])).toBe(`[WARN] [agents/claude-code] ${expected}`);
    // ② context 固定为 `{ variable: '<键名原文>', effort: 'off' }`（作为第二个参数透传，不 JSON.stringify）
    expect(hit?.[1]).toStrictEqual({ variable: HOST_DISABLE_BETAS_ENV, effort: EFFORT_OFF });
  });

  /**
   * **接线级的「回报原拼写」**（spec §5.1.1 ②；门审 Important，2026-10-06 补）：
   * 宿主写成**小写拼写**时，WARN 里带的、以及 context 里回报的，都必须是**那个小写原文**。
   *
   * 为什么纯函数那一例不够：9a 第③例只证明「函数会回报原拼写」，而**接线**处若把它丢掉
   * （例如实现改成用 `HOST_DISABLE_BETAS_ENV` 常量去拼文案 / 填 context），纯函数照样绿，
   * 日志却点名了一个宿主环境里**根本不存在**的名字——Windows 上因为环境变量大小写不敏感而行为照旧，
   * POSIX 上则是「查不到 ⇒ 永远不告警」的另一种静默。两条拼在一起才是「回报原拼写」的完整见证。
   *
   * ⚠️ 与上一条同一个理由，这里的正文同样是**字面量**（不经常量拼），键名写的就是小写原文。
   */
  it('宿主写小写拼写 ⇒ WARN 的 message 与 context 带的都是那个小写原文（回报原拼写，接线级）', async () => {
    const lower = 'claude_code_disable_experimental_betas';
    vi.stubEnv(lower, 'true');
    const calls: unknown[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput({ effort: EFFORT_OFF }));

    const expected =
      'off 档的关闭被静默忽略：子进程环境里存在 claude_code_disable_experimental_betas，它使 CLAUDE_CODE_EXTRA_BODY 的 body 覆盖失效，本次运行的 off 档读数作废；处置：从运行环境里去掉该变量后重跑，或改用别的方式关闭思考。';
    expect(calls.map((args) => String(args[0]))).toContain(`[WARN] [agents/claude-code] ${expected}`);
    // context 里的 `variable` 是第二份「原拼写」：文案对了、context 写规范拼写同样是漂移
    const hit = calls.find((args) => String(args[0]).endsWith(expected));
    expect(hit?.[1]).toStrictEqual({ variable: lower, effort: EFFORT_OFF });
  });

  /**
   * **守卫 9b 的第三半 + 变异体⑪的靶子**（spec §5.1.1「它是观测，不是拦截」）：
   * WARN 出现时 `CLAUDE_CODE_EXTRA_BODY` **照旧逐字注入**，本行也**照常跑完**（不抛、不跳过）。
   */
  it('观测不拦截：WARN 出现时覆盖层仍逐字注入，本行照常跑完', async () => {
    vi.stubEnv(HOST_DISABLE_BETAS_ENV, 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    const result = await claudeCodeProvider.run(createRunInput({ effort: EFFORT_OFF }));

    expect(recorder.env?.[CLAUDE_CODE_EXTRA_BODY]).toBe('{"thinking":{"type":"disabled"}}');
    expect(result.ok).toBe(true);
  });

  /** **守卫 9b 的第四半**：`vi.stubEnv(name, undefined)`（= 宿主没设）⇒ 跑 `off` **不出现** WARN */
  it('宿主没设 ⇒ off 档不出现 WARN', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput({ effort: EFFORT_OFF }));

    expect(warnings.filter((line) => line.includes(HOST_DISABLE_BETAS_ENV))).toStrictEqual([]);
  });

  /**
   * **其余档位连一条日志都不多**（spec §5.1.1 判据③：这是**新增的输出**，
   * 不能漏到别的档位上）。与上一条分成两个用例：一个是「它不说话」、一个是「它乱说话」，
   * 失败原因完全不同。
   */
  it('非 off 档位即使宿主设过该变量也不告警（新增输出不外溢）', async () => {
    vi.stubEnv(HOST_DISABLE_BETAS_ENV, 'true');
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput({ effort: 'high' }));

    expect(warnings.filter((line) => line.includes(HOST_DISABLE_BETAS_ENV))).toStrictEqual([]);
  });

  /**
   * **导出给测试的那段文案必须与 spec §5.1.1 逐字一致**（含唯一可变 token 的位置）。
   * 这条用例是**最后一道**防漂移：上面那条比的是「运行时 message = 实现导出的常量」，
   * 这一条比的是「那个常量 = spec 的原文」——两半合起来才等价于「message = spec 原文」。
   */
  it('WARN 文案模板与 spec §5.1.1 逐字一致（<键名原文> 是唯一可变 token）', () => {
    expect(CLAUDE_OFF_DISABLED_WARNING_TEXT).toBe(
      'off 档的关闭被静默忽略：子进程环境里存在 <键名原文>，它使 CLAUDE_CODE_EXTRA_BODY 的 body 覆盖失效，本次运行的 off 档读数作废；处置：从运行环境里去掉该变量后重跑，或改用别的方式关闭思考。',
    );
  });
});

/**
 * 本文件下面**两组 describe 共用**的两条夹具（2026-10-04 复核 M-d 改正）。
 *
 * 此前它们各在每个 describe 里抄了一份，而两处的注释都写着「与…**同一份**夹具」——那是假的：
 * 同一份实现被抄了两遍，改一处不会带上另一处（正是本仓最忌讳的那种「两份必然漂移」）。
 * 提到模块作用域之后那句话才成立；将来要改目录布局或 `assistant` 的形状，只有这一处。
 *
 * ⚠️ 与 `subagent-usage.test.ts` 里那一对仍然**只是同形**（逐个字段相同，但是**另一份拷贝**）：
 * 那个文件有自己的模块作用域，跨文件共享要么再抽一个 `testing/` 夹具、要么就照实说「同形拷贝」——
 * 这里选后者，别把这句话读成「全仓只有一份」。
 */
function writeAgentFile(configHome: string, sessionId: string, taskId: string, lines: unknown[]): void {
  const dir = join(configHome, 'projects', 'D---tmp-proj', sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${taskId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
}

/** 文件里的一条 assistant 记录：同一个 `message.id` 会出现多次（按内容块），后到覆盖 */
function assistant(messageId: string, usage: Record<string, number>): unknown {
  return { type: 'assistant', isSidechain: true, uuid: `${messageId}-${Math.random()}`, message: { id: messageId, usage } };
}

/**
 * 主会话的一条 assistant 消息：上面两组用例共用（轮次按它的 `message.id` 去重计数，一个 id 一轮）。
 * 放在模块级而不是某一组里：子智能体那一份与轮次那一份都要「主会话立一轮」，两份各写一个会漂移。
 */
function mainAssistant(uuid: string, messageId: string): unknown {
  return { type: 'assistant', uuid, message: { id: messageId, content: [{ type: 'text', text: '干活' }] } };
}

/**
 * **真派发**的 `task_started`（真机形状：`subagent_type` / `spawn_depth` / `prompt` **三格齐**）。
 *
 * ⚠️ 这三格不是装饰（spec §4 **R19**，2026-10-05）：`message.ts` 的**形状判据**就是「三格至少一格
 * **非 `null`**」（`''` 与 `0` 也算，刻度见 `message.test.ts` 的「刻度」那条），
 * 而它决定两件事——① 面板会不会为这个 id 产一条子任务行；② 这个 id 进不进「事实核对名单」
 * （`index.ts` 的 `subagentIds`，收尾据此点名「读不到 X」）。**夹具漏了这三格，写的就不是一次派发**
 * 而是一条幻影（CLI 给非 Agent 后台任务发的那种形状），用例会以「没有 WARN / 没有记录」的形式静默走偏。
 */
function dispatchStarted(taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: `call_${taskId}`,
    // 三格逐字取自真机产物（`afb636cf844060a29` 那条）
    subagent_type: 'general-purpose',
    spawn_depth: 1,
    prompt: '审查这个页面，把发现写成结论',
    ...extra,
  };
}

/**
 * 子智能体那一份用量（spec 2026-10-04 §2.3/§2.4）：claude 的**唯一**权威源是 CLI 落盘的
 * `<CLAUDE_CONFIG_DIR>/projects/<项目>/<sessionId>/subagents/agent-<agentId>.jsonl`，
 * 由收尾（`finalize`）读出来并折进结果。
 *
 * 为什么这两条用例必须存在：`subagentTokens` 走的是「结果 → 行快照」这一条链路，
 * 而它只在**收尾**才产生 ⇒ 少接一根线（没记 `task_id`、没记 `session_id`、没交回结果）
 * 的表现都是「界面上的 tok 只有主会话」——与今天的行为**一模一样**，静默且看不出缺。
 */
describe('claude-code 的子智能体用量（收尾读 CLI 落盘的会话文件）', () => {
  it('finalize 把子智能体那一份加进结果，taskId 与 sessionId 都用对', async () => {
    // configHome 必须指向**本用例自己的**临时目录（收尾要按它去读子智能体会话文件，
    // 而这条用例要往里面写 agent-*.jsonl）；夹具默认值 `FIXTURE_CONFIG_HOME` 是共享的，
    // 写进去会漏给同文件其它用例（默认值的形状见上面「注入落点」那条断言）
    const configHome = mkdtempSync(join(tmpdir(), 'claude-row-'));
    writeAgentFile(configHome, 's-1', 'task-1', [
      assistant('m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant('m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-1' },
            dispatchStarted('task-1', { tool_use_id: 'call_1', description: '审查页面' }),
            /**
             * 主会话的**一轮**要由带 `message.id` 的 assistant 消息来立（轮次口径：一次模型 API 往返
             * 算一次，按 `message.id` 去重计数）——只有 `result` 而没有 assistant 时主会话轮次是
             * `num_turns` 兜底、这里没给 ⇒ 主会话那一格是 `null`，`轮次 = 主 + 子` 就算不出来。
             */
            { type: 'assistant', uuid: 'a-1', message: { id: 'main-m-1', content: [{ type: 'text', text: '派一个子任务' }] } },
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const result = await claudeCodeProvider.run(createRunInput({ configHome }));
    expect(result.subagentTokens).toEqual({ input: 4, cached: 0, output: 2, reasoningOutput: null, total: null });
    expect(result.tokens).toEqual({ input: 104, cached: 0, output: 12, reasoningOutput: null, total: null });
    expect(result.turns).toBe(2); // 主 1 轮 + 子 1 轮
  });

  /**
   * **真机缺陷的回归测试**（2026-10-05，产物 `11a5feb5…/0d881bdc…`）：事件流的 `task_*` 里除了真派发的
   * 子智能体，还混着 CLI 给**非 Agent 任务**发的条目——那条 Bash 命令的 `description`
   * （"Check latest Vue version on npm"）就是 wire 上那个「子智能体的名字」，而它的
   * `parentToolUseId` 是**子智能体自己那条 Bash 调用**的 id（`call_01_…`），盘上永远没有它的转录。
   *
   * 旧读数按「事件流的每个 id 都要有同名文件」判 ⇒ 那个幻影条目让**整格** null：卡片两个 Tooltip
   * 都没有子智能体那一行，日志里还挂着一条点名 WARN——而真子智能体的转录就在盘上、读得动。
   * 现在的判据是**枚举目录**，事件流的 id 只用于「一个转录都没有」时的核对。
   */
  it('事件流里混着没有转录的 task 条目时，真子智能体的那一份照读（幻影条目不再拖垮整格）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    // 真机形状：转录文件名里是 **agentId**（17 位十六进制），与真派发那条 wire id 同值
    writeAgentFile(configHome, 's-phantom', 'ae63ead9521ee0d28', [
      assistant('m-1', { input_tokens: 13552, cache_read_input_tokens: 0, output_tokens: 114 }),
      assistant('m-2', { input_tokens: 1106, cache_read_input_tokens: 13568, output_tokens: 678 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-phantom' },
            // 真派发（字段齐：subagent_type / spawn_depth / prompt 都是真机里那几个）
            {
              type: 'system',
              subtype: 'task_started',
              task_id: 'ae63ead9521ee0d28',
              tool_use_id: 'call_00_1XHGYscTzFm2JLo8y7Cr1773',
              description: 'Review Vue 3 hello world page',
              subagent_type: 'general-purpose',
              spawn_depth: 1,
              prompt: 'Review the file…',
            },
            // CLI 的非 Agent task 条目（9 位 id、没有 kind/depth/prompt，父 id 是子智能体内部的 Bash 调用）
            { type: 'system', subtype: 'task_started', task_id: 'bey1yc1n7', tool_use_id: 'call_01_8LZpHuCgmKv8s15UluBE8153', description: 'Check latest Vue version on npm' },
            { type: 'system', subtype: 'task_notification', task_id: 'bey1yc1n7', tool_use_id: 'call_01_8LZpHuCgmKv8s15UluBE8153', status: 'completed', summary: 'Check latest Vue version on npm' },
            mainAssistant('a-1', 'main-m-1'),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    /** 派发面板那一侧的记录（`onSubagent` → `messages.jsonl` / SSE ⇒ 抽屉里的子任务行） */
    const records: SubagentRecord[] = [];
    const result = await claudeCodeProvider.run(
      createRunInput({ configHome, onEvent: collectEvents(events), onSubagent: (record) => records.push(record) }),
    );

    // 两格都有数（旧行为：两格都是 null）
    expect(result.subagentTokens).toEqual({ input: 14658, cached: 13568, output: 792, reasoningOutput: null, total: null });
    expect(result.subagentTurns).toBe(2);
    expect(result.turns).toBe(3); // 主 1 轮 + 子 2 轮
    // 幻影条目**不是事实缺失** ⇒ 那条点名 WARN 不该出现（它以前点的正是那个 task id）
    expect(events.some((event) => event.type === 'log' && event.text.includes('读不到子智能体'))).toBe(false);
    /**
     * **面板里不许有幽灵行**（R19 的后果①，2026-10-05）：幻影条目既不产 `SubagentRecord`，
     * 也不该被 `finalize` 的重交带上（它压根不在 `lastSubagentRecordById` 里）。
     * 真派发的那个会出现**两条**（派发帧 + 收尾重交帧），但身份只有一个
     * ⇒ 判据按**身份去重**，不数条数（条数由「收尾重交」这条机制决定，与幽灵行无关）。
     * 旧行为：这里会多出一条 `bey1yc1n7`（名字是那条 Bash 的 `description`、用量恒「未采集」）。
     */
    expect([...new Set(records.map((record) => record.subagentId))]).toEqual(['ae63ead9521ee0d28']);
    expect(records.some((record) => record.subagentId === 'bey1yc1n7')).toBe(false);
    /**
     * ⚠️ 这一条钉的是**「没有终态通知的子智能体也拿得到最终用量」**（2026-10-06 修）：
     * 这个真派发只发过**派发帧**（没有 `task_notification`），而改前派发帧**提前返回、什么都不记**
     * ⇒ 它不在收尾的重交名单里，用量永远是 `null`（子任务条恒「用量未采集」），哪怕转录就在盘上。
     */
    expect(records.at(-1)?.usage).toEqual({ input: 14658, cached: 13568, output: 792, reasoningOutput: null, total: null });
  });

  /**
   * **只有幻影的 wire**（spec §4 **R19** 的后果②）：事件流里那两条 `task_*` 全是 CLI 给**非 Agent
   * 后台任务**发的（真机：子智能体里那条带 `description` 的 Bash），盘上一个转录都没有。
   *
   * 诚实答案是 `{0,0,0}`（**确实没有子智能体**）+ 「轮次 0」，**一句 WARN 都不该有**——
   * 旧行为在这里给的是 `null` + 一条「读不到子智能体 `bey1yc1n7`」的 WARN，等于把一条 Bash 命令
   * 叫成子智能体（用户报的就是这句话的形状）。面板那一侧同样一条记录都不该有。
   */
  it('幻影-only 的 wire ⇒ {0,0,0} 与 0 轮，不落 WARN，面板一条记录都没有', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-phantom-'));
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-phantom-only' },
            // 真机形状逐字：9 位 nanoid、三格全空、名字就是那条 Bash 的 `description`
            { type: 'system', subtype: 'task_started', task_id: 'bey1yc1n7', tool_use_id: 'call_01_8LZpHuCgmKv8s15UluBE8153', description: 'Check latest Vue version on npm' },
            { type: 'system', subtype: 'task_notification', task_id: 'bey1yc1n7', tool_use_id: 'call_01_8LZpHuCgmKv8s15UluBE8153', status: 'completed', summary: 'Check latest Vue version on npm' },
            mainAssistant('a-1', 'main-m-1'),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const records: SubagentRecord[] = [];
    const result = await claudeCodeProvider.run(
      createRunInput({ configHome, onEvent: collectEvents(events), onSubagent: (record) => records.push(record) }),
    );

    // 「确实没有」而不是「没采到」：两格都要是**零**（`null` 是另一句话）
    expect(result.subagentTokens).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(result.subagentTurns).toBe(0);
    // 合计恒等式照旧：主会话那一份一个字节都没被幻影改动
    expect(result.tokens).toEqual({ input: 100, cached: 0, output: 10, reasoningOutput: null, total: null });
    expect(result.turns).toBe(1);
    // 那句话不该出现（旧行为：它点的正是 `bey1yc1n7`）
    expect(events.some((event) => event.type === 'log' && event.text.includes('读不到子智能体'))).toBe(false);
    // 面板那一侧（`messages.jsonl` / SSE）一条记录都不该有
    expect(records).toEqual([]);
  });

  /**
   * **R1 那个价码的关闭口**（spec §4 **R1** / **R19**，2026-10-05）：一个**形状像派发**的子智能体
   * 转录缺失、而盘上另有可读转录时，交出去的**绝不能是部分和**。
   *
   * 旧行为（只枚举目录、不与名单对账）：这里给的是 `task-1` 那一份（4 / 0 / 2）——一个**部分和**，
   * 而它在卡片上与「全量合计」长得一模一样（用户与评审都不可能看出来）。
   * 现在：两格一起 `null`（合计退回主会话口径）+ 一条**点名 `task-2`** 的 WARN。
   */
  it('形状合格的派发缺转录、而盘上另有可读转录 ⇒ 两格 null + 点名它（不拿部分和冒充总数）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-partial-'));
    // 只有 `task-1` 的转录落到了盘上
    writeAgentFile(configHome, 's-partial', 'task-1', [
      assistant('m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-partial' },
            // 两个**形状像派发**的子智能体（真机三格齐），而第二个的转录不在盘上
            dispatchStarted('task-1', { tool_use_id: 'call_1' }),
            dispatchStarted('task-2', { tool_use_id: 'call_2' }),
            mainAssistant('a-1', 'main-m-1'),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const result = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: collectEvents(events) }));

    // 「全量或 null」：读得到的只有 `task-1` ⇒ 分量整格 null（部分和会被读成总数）
    expect(result.subagentTokens).toBeNull();
    expect(result.subagentTurns).toBeNull();
    // 合计退回**主会话**口径（那 4 / 0 / 2 一格都不许混进来）
    expect(result.tokens).toEqual({ input: 100, cached: 0, output: 10, reasoningOutput: null, total: null });
    expect(result.turns).toBe(1);
    // 点名：缺的是 `task-2`（`task-1` 读得到，不该被点名）
    expect(
      events.some((event) => event.type === 'log' && event.text.includes('读不到子智能体') && event.text.includes('task-2')),
    ).toBe(true);
    expect(
      events.some((event) => event.type === 'log' && event.text.includes('读不到子智能体') && event.text.includes('task-1')),
    ).toBe(false);
  });

  /**
   * **只见到收场帧**（没有 `start` 可判形状）这一档的完整处置（R19 + 2026-10-05 复核裁定；
   * 盘上**没有**实例，触发条件未刻画——真机三个 claude 产物的每一个真派发都是 start + 收场成对出现）。
   * 三条一起才是这一档的全部含义：
   *   · **面板照产一行**：「**丢一个真派发比多一条幽灵行更坏**」（用户裁定）；
   *   · **不要求它有转录、也不改两格**：说它是子智能体（`null` + 「读不到」）会把一条幻影的代价转嫁给
   *     真子智能体——正是用户报的症状；所以两格照算（这一档里没有转录 ⇒ 仍是 `{0,0,0}` 与 0 轮）；
   *   · **但必须点一句名**：`[WARN] 只见到收场帧的 task 条目 X 没有转录：这一行的 tok / 缓存命中 /
   *     轮次可能少算它（无法判定它是不是子智能体）`——既不静默少算，也**不叫它子智能体**（R19 的教训）。
   */
  it('只见到收场帧 ⇒ 面板照产一行、两格仍是 {0,0,0}，且落一条**不叫它子智能体**的「可能少算」WARN', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-end-only-'));
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-end-only' },
            // 刻意**没有** `task_started`：只见到收场帧（盘上也没有它的转录）
            { type: 'system', subtype: 'task_notification', task_id: 'task-x', tool_use_id: 'call_x', status: 'completed', summary: '跑完了' },
            mainAssistant('a-1', 'main-m-1'),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const records: SubagentRecord[] = [];
    const result = await claudeCodeProvider.run(
      createRunInput({ configHome, onEvent: collectEvents(events), onSubagent: (record) => records.push(record) }),
    );

    // 前一句：面板照产（收场那一帧 + `finalize` 的重交各一条）
    expect(records.map((record) => record.subagentId)).toEqual(['task-x', 'task-x']);
    // 中一句：不进事实核对名单 ⇒ 两格照算（这一档没有转录 ⇒ 零而不是 null），且**没有**「它读不到」那句
    expect(result.subagentTokens).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(result.subagentTurns).toBe(0);
    expect(events.some((event) => event.type === 'log' && event.text.includes('读不到子智能体'))).toBe(false);
    // 后一句：**判不了的条目必须点名**（静默少算是本仓最不接受的那一类），且文案不叫它子智能体
    const warn = events.find((event) => event.type === 'log' && event.text.includes('只见到收场帧的 task 条目'));
    expect(warn, '判不了的条目必须点一句名（静默少算不接受）').toBeDefined();
    expect(warn?.type === 'log' ? warn.text : '').toContain('task-x');
    expect(warn?.type === 'log' ? warn.text : '').toContain('无法判定它是不是子智能体');
  });

  /**
   * 同一档的**另一半**（2026-10-05 复核 Important 1 的正例）：判不了的条目**在盘上另有可读转录**时，
   * 两格交的是**读到的那些的和**（可能少算了那条判不了的条目），**同时**落同一条「可能少算」WARN。
   *
   * 为什么必须有这一条：这一档里「两格照算」与「点名」是**两句必须同时成立**的话——
   * 少了点名就是**静默的少算**（本仓最不接受的那一类），而把它当形状合格（要求有转录）则会把
   * 一个真子智能体的读数拖成 `null`（用户报的症状）。夹具里那份转录的 id **不在 wire 里**
   * （并集规则照读），正好构成「读到的和 + 一条判不了的条目」这个形状。
   */
  it('只见到收场帧 + 盘上另有可读转录 ⇒ 两格是读到的和（可能少算），并落同一条「可能少算」WARN', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-end-only-sum-'));
    writeAgentFile(configHome, 's-end-only-sum', 'ae63ead9521ee0d28', [
      assistant('m-1', { input_tokens: 13552, cache_read_input_tokens: 0, output_tokens: 114 }),
      assistant('m-2', { input_tokens: 1106, cache_read_input_tokens: 13568, output_tokens: 678 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-end-only-sum' },
            { type: 'system', subtype: 'task_notification', task_id: 'task-x', tool_use_id: 'call_x', status: 'completed', summary: '跑完了' },
            mainAssistant('a-1', 'main-m-1'),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const result = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: collectEvents(events) }));

    // 两格是**读到的那些的和**（这里就是那份转录），**不是** `null`——判不了的条目不许拖垮真读数
    expect(result.subagentTokens).toEqual({ input: 14658, cached: 13568, output: 792, reasoningOutput: null, total: null });
    expect(result.subagentTurns).toBe(2);
    expect(result.tokens).toEqual({ input: 14758, cached: 13568, output: 802, reasoningOutput: null, total: null });
    // 但**可能少算了 `task-x`** 必须说出口（静默少算是不接受的），而它**不能**被叫成子智能体
    const warn = events.find((event) => event.type === 'log' && event.text.includes('只见到收场帧的 task 条目'));
    expect(warn, '判不了的条目必须点一句名（静默少算不接受）').toBeDefined();
    expect(warn?.type === 'log' ? warn.text : '').toContain('task-x');
    expect(warn?.type === 'log' ? warn.text : '').toContain('可能少算它');
    expect(events.some((event) => event.type === 'log' && event.text.includes('读不到子智能体'))).toBe(false);
  });

  it('子智能体文件不在 ⇒ 子那一份 null、合计退回主会话，并落一条点名 WARN', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-row-'));
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-nope' },
            dispatchStarted('task-missing', { tool_use_id: 'call_1' }),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const result = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: (event) => events.push(event) }));
    expect(result.subagentTokens).toBeNull();
    expect(result.tokens).toEqual({ input: 100, cached: 0, output: 10, reasoningOutput: null, total: null });
    expect(events.some((event) => event.type === 'log' && event.text.includes('task-missing'))).toBe(true);
  });

  /**
   * **合计与分量同生共死**（2026-10-04 收尾评审 Important 2）。
   *
   * 为什么单开一条：收尾那条路**声称**覆盖「被中断 / 失败」的运行（见 `finalize` 的 JSDoc），
   * 而那种运行最常见的形状就是**一条 `result` 消息都没有**——`result` 是 CLI 自己的收尾消息，
   * 崩掉 / 被终止时它根本不会到。此时 `mainTokens` 是 `null` ⇒ 合计拿不出来；若分量照旧交出去，
   * 这一行就落成「`tokens: null` + 一个真实的 `subagentTokens`」，而消费方按「主会话 = 合计 − 分量」
   * 推导，那个减法在这里**没有被减数**（两格各自看起来都正常）。
   * codex 早就为同一形状做了同一个选择（`providers/codex/index.ts` 的 `finalize`：
   * `subagentTokens: combined === null ? null : projected.subagentUsage`）。
   */
  it('一条 result 都没到（被中断 / 失败）⇒ 合计与分量一起 null，绝不只交分量', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-row-'));
    // 盘上那份文件**读得到**（下面据此断言：这里的 null 来自「合计拿不出来」，不是读失败）
    writeAgentFile(configHome, 's-no-result', 'task-1', [
      assistant('m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-no-result' },
            dispatchStarted('task-1', { tool_use_id: 'call_1' }),
            // 刻意**没有** `result`：CLI 没来得及收尾（被终止 / 崩了）
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const result = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: (event) => events.push(event) }));
    expect(result.tokens).toBeNull();
    expect(result.subagentTokens).toBeNull();
    // 前提钉：没有「读不到子智能体」的点名 WARN ⇒ 分量之所以是 null，是因为合计拿不出来
    expect(events.some((event) => event.type === 'log' && event.text.includes('读不到子智能体'))).toBe(false);
  });

  /**
   * **子智能体自己的那一格用量**（2026-10-04 用户报的缺陷：抽屉里「Agent」工具下的子任务条永远
   * 显示「用量未采集」，而 dsh / codex 两家都有数）。
   *
   * 为什么这条与上面三条不是同一件事：那三条钉的是**行快照**（`result.subagentTokens`，走
   * 「结果 → 行快照」），本条钉的是**内容流**（`SubagentRecord.usage`，走 `messages.jsonl` →
   * 抽屉里的子任务条）。两格各有自己的接线，少接一根的症状**完全不同**：
   *   · 少 `subagentTokens` ⇒ 列表上的 tok 只有主会话；
   *   · 少 `usage` ⇒ 抽屉里那一格写「用量未采集」（而它是采到了的——CLI 盘上那份文件里就有）。
   *
   * ⚠️ 文件必须在**跑动期**就存在（这里是 SDK 夹具吐消息之前写好的）：真机上 CLI 收到
   * `task_notification` 时那份 jsonl 已经落盘，而 `finalize` 那一次重读只兜住「通知先到、
   * 文件后到」的竞态。用一条只在收尾才认的读数不算修好——界面上那一格要在行还在跑时就对。
   */
  it('子智能体自己的用量：task_notification 到达时读盘填进 SubagentRecord.usage（界面那一格不再「未采集」）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-row-'));
    writeAgentFile(configHome, 's-4', 'task-1', [
      assistant('m-1', { input_tokens: 13596, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant('m-1', { input_tokens: 13596, cache_read_input_tokens: 0, output_tokens: 106 }),
      assistant('m-2', { input_tokens: 1052, cache_read_input_tokens: 13696, output_tokens: 0 }),
      assistant('m-2', { input_tokens: 1052, cache_read_input_tokens: 13696, output_tokens: 2433 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-4' },
            { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'call_1', description: '审查页面', subagent_type: 'general-purpose' },
            {
              type: 'system',
              subtype: 'task_notification',
              task_id: 'task-1',
              tool_use_id: 'call_1',
              status: 'completed',
              summary: '通过',
              // CLI 在这里给的 `usage` 是**另一种形状**（`total_tokens` / `tool_uses` / `duration_ms`），
              // 与契约的三项不同口径 ⇒ 它一个字段都不该被用来填这一格（读数只能来自盘上那份文件）
              usage: { total_tokens: 999, tool_uses: 7, duration_ms: 1234 },
            },
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const records: SubagentRecord[] = [];
    await claudeCodeProvider.run(
      createRunInput({ configHome, onMessage: () => {}, onSubagent: (record) => records.push(record) }),
    );

    const readUsage = { input: 14648, cached: 13696, output: 2539, reasoningOutput: null, total: null };
    /**
     * 三帧、同一条身份（覆盖累积按 `subagentId` 折叠 ⇒ 界面上只有一条子任务）：
     *   ① `task_started` 的派发帧（`running`）；
     *   ② `task_notification` 到达时的终态帧——**不带用量**（2026-10-06 起跑动期不读盘）；
     *   ③ `finalize` 的重交帧——**它才带最终用量**，且兜住「通知先到、CLI 那份 jsonl 还没写完」的竞态。
     */
    expect(records).toHaveLength(3);
    expect(records.map((record) => [record.status, record.usage])).toEqual([
      // 派发那条如实不给用量：那时还谈不上「这一次花了多少」
      ['running', null],
      // 终态通知那条也不给：用量在收尾统一读一次（改前这一条会带上「当时读到的那一份」）
      ['completed', null],
      ['completed', readUsage],
    ]);
    // 读数来自**盘上的会话文件**（不是事件流、也不是 `task_notification.usage` 那个异形载荷）：
    // 只有收尾那条重交帧被标成 `session-file`
    expect(records.map((record) => record.source)).toEqual(['wire', 'wire', 'session-file']);
    // 前提钉：`task_notification` 的异形 `usage` 没有被当成三项读数
    expect(records[2]?.usage).not.toMatchObject({ input: 999 });
  });
});

/**
 * 轮次那一格的**分量**（`subagentTurns`，spec 2026-10-04 §2.2 补注 / §2.3 claude 段 / §2.4）。
 *
 * 口径与 `subagentTokens` 逐字同构，只是取值域换成非负整数：子那一份 = **各子智能体文件里
 * `message.id` 去重后的个数之和**（`readClaudeSubagentUsage` 的 `turns`——与用量同一次读盘、
 * 同一个「全量或 null」判据、同一条点名 WARN），合计仍是 `主会话轮次 + 子那一份`
 * （`turns` 的口径一个字节都没改，它本来就是全树合计）。
 *
 * 为什么这四条必须存在：这一格只决定界面画不画「轮次」那一格的拆分行，而它**缺席**与
 * 「这一行没有子智能体」在界面上长得一模一样（都只有合计那一行）——少接一根线是**静默**的，
 * 与 `subagentTokens` 当初同一条理由。四条各钉一条口径：
 *   ① 成对交回结果（含「侧链记录不重复计数」——那正是「主 + 子」这个加法成立的前提）；
 *   ② 有任何一个子智能体读不到 ⇒ **两格一起** `null` + 点名那条 WARN（绝不拿部分和冒充）；
 *   ③ 合计拿不出来（主会话一次往返都没数到）⇒ **不交孤儿分量**，哪怕盘上读得到；
 *   ④ 运行期**不交**这一格（浮层只有一行），终态两格一起换成权威值。
 */
describe('claude-code 的子智能体轮次（轮次那一格的 claude 段）', () => {

  /**
   * 跑一次「主会话 1 轮 + 每个 taskId 派一次活」的固定形状（②③ 两组共用）。
   * 主会话那一轮由一条带 `message.id` 的 assistant 消息立起——只有 `result` 而没有 assistant 时
   * 主会话轮次是 `num_turns` 兜底，而夹具里没给 ⇒ 主会话那一格是 `null`，`主 + 子` 就算不出来。
   */
  async function runWithTasks(
    configHome: string,
    sessionId: string,
    taskIds: readonly string[],
  ): Promise<{ result: AgentRunResult; events: AgentEvent[] }> {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: sessionId },
            ...taskIds.map((taskId) => dispatchStarted(taskId)),
            mainAssistant(`a-${sessionId}`, `main-${sessionId}`),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const result = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: collectEvents(events) }));
    return { result, events };
  }

  it('终态把「全树轮次」与「子智能体那一份」成对交回结果（侧链记录不重复计数）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-turns-'));
    writeAgentFile(configHome, 's-pair', 'task-1', [
      assistant('sub-m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant('sub-m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
      assistant('sub-m-2', { input_tokens: 6, cache_read_input_tokens: 0, output_tokens: 3 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-pair' },
            dispatchStarted('task-1', { tool_use_id: 'call_1' }),
            mainAssistant('a-1', 'main-m-1'),
            mainAssistant('a-2', 'main-m-2'),
            /**
             * **侧链（子智能体）消息不进主会话轮次**（`countModelRoundTrip` 按 `parent_tool_use_id`
             * 直接退出，与 `result.usage` 排除侧链同口径）：它那一次往返已经按 id 记在子智能体那份
             * 文件里 ⇒ 再数一次就是**双计**，而「主 + 子」这个加法正是靠这条前提成立的。
             */
            { type: 'assistant', uuid: 'a-side', parent_tool_use_id: 'call_1', message: { id: 'side-m-1', content: [{ type: 'text', text: '子智能体的话' }] } },
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const result = await claudeCodeProvider.run(createRunInput({ configHome }));

    // 合计：主 2 轮 + 子 2 轮（子那一份 = 去重后的 `message.id` 个数，不是文件行数 3）
    expect(result.turns).toBe(4);
    // 分量：其中的子那一份 ⇒ 界面画「主会话 2 轮 / 子智能体 2 轮」（2 ≤ 4，逐格成立）
    expect(result.subagentTurns).toBe(2);
    // 同一次读盘的另一格照旧：分量给对了，三元组也必须还是那一份（两格不许各走一条路）
    expect(result.subagentTokens).toEqual({ input: 10, cached: 0, output: 5, reasoningOutput: null, total: null });
  });

  it('有转录读不动 ⇒ 两格一起 null（不拿读到的那些冒充）+ 点名那条 WARN', async () => {
    /**
     * 两次运行**只差一个转录文件可不可读**。为什么必须是同一份夹具的对照：只跑「坏文件」那一趟的话，
     * 「分量是 `null`」既可能是「读失败」（诚实），也可能是「这一格压根没接线」——两者在界面上
     * 同形，只有前者该被接受。
     *
     * ⚠️ 2026-10-05 口径修正：判据从「事件流的每个 id 都要有同名文件」换成「目录里的转录都得读得动」
     * ——事件流里混着 CLI 的**非 Agent task 条目**，它们本来就没有转录。所以这一条现在钉的是
     * **读不动那一档**（空文件），不再钉「事件流 id 找不到同名文件」（那一条见下面的真机回归测试）。
     */
    const withBoth = mkdtempSync(join(tmpdir(), 'claude-turns-'));
    for (const fileId of ['task-1', 'task-2']) {
      writeAgentFile(withBoth, 's-both', fileId, [
        assistant(`${fileId}-m-1`, { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
      ]);
    }
    const both = await runWithTasks(withBoth, 's-both', ['task-1', 'task-2']);
    expect(both.result.turns).toBe(3); // 主 1 轮 + 子 2 轮
    expect(both.result.subagentTurns).toBe(2);

    const withBad = mkdtempSync(join(tmpdir(), 'claude-turns-'));
    writeAgentFile(withBad, 's-one', 'task-1', [
      assistant('task-1-m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
    ]);
    // 第二个转录在、但读不出可用记录（空文件 = 收尾时 CLI 还没写完 / 被中断）⇒ 与「读不动」同一档
    writeAgentFile(withBad, 's-one', 'task-2', []);
    const one = await runWithTasks(withBad, 's-one', ['task-1', 'task-2']);

    // 「全量或 null」：两个转录只读得动一个 ⇒ 分量整格 null，绝不拿读到的那个 1 冒充总数
    expect(one.result.subagentTurns).toBeNull();
    /**
     * 合计照 §2.2 那条回落口径退回**主会话**那一份（1 轮）——机制是「收尾那一格**不交** ⇒ 骨架
     * 保留投影已经给出的主会话轮次」。两格因此是这样一对：**合计有主会话那个数、分量是 `null`**
     * ⇒ 界面退回只有合计的那一行（§2.5），而分量绝不会在合计退回时还留着旧值。
     * 这一条是**既成事实的前提钉**（它由 `turns` 的省略与骨架的「缺省保持」共同给出，不是本次新写的）。
     */
    expect(one.result.turns).toBe(1);
    // 与用量那一格**同一条判据、同一次读盘** ⇒ 两格一起 null（界面因此退回只有合计的那一行）
    expect(one.result.subagentTokens).toBeNull();
    // 点名 WARN：读不动的是哪个子智能体必须说得出来（否则「分量是 null」在日志里点不出人）
    expect(
      one.events.some((event) => event.type === 'log' && event.text.includes('读不到子智能体') && event.text.includes('task-2')),
    ).toBe(true);
  });

  it('合计拿不出来（主会话一次往返都没数到）⇒ 不交孤儿分量，哪怕盘上读得到', async () => {
    /**
     * 同一个文件、同一份夹具，两次运行**只差「主会话有没有数到一轮」**：
     *   · A 数到了 ⇒ 两格成对交出（分量 ≤ 合计）；
     *   · B 没数到 ⇒ 合计没有诚实的值（「计量绝不填 0」是硬口径），分量**也不许单独交出去**：
     *     消费方按「主会话 = 合计 − 分量」推导，缺了被减数会算出一个**不存在的主会话**
     *     （codex 为同一形状做了同一个选择，见 `providers/codex/index.ts` 的 `finalize`）。
     * 这一对是**受控对照**：两次之间只有主会话那一轮不同 ⇒ B 的 `null` 只可能来自那句成对规则。
     */
    const configHome = mkdtempSync(join(tmpdir(), 'claude-turns-'));
    writeAgentFile(configHome, 's-orphan', 'task-1', [
      assistant('sub-m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
    ]);
    const paired = await runWithTasks(configHome, 's-orphan', ['task-1']);
    expect(paired.result.turns).toBe(2); // 主 1 轮 + 子 1 轮
    expect(paired.result.subagentTurns).toBe(1);

    // B：事件流里**没有** assistant 消息（`result` 上也没有 `num_turns`）⇒ 主会话轮次为 null
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-orphan' },
            dispatchStarted('task-1', { tool_use_id: 'call_1' }),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const orphan = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: collectEvents(events) }));

    // 前提钉一：子那一份**读得到**（用量与轮次都在盘上）⇒ 下面的 null 不是「读失败」那一档
    expect(orphan.subagentTokens).toEqual({ input: 4, cached: 0, output: 2, reasoningOutput: null, total: null });
    // 前提钉二：没有点名的读失败 WARN ⇒ 它与「读不到」是两件不同的事
    expect(events.some((event) => event.type === 'log' && event.text.includes('读不到子智能体'))).toBe(false);
    expect(orphan.turns).toBeNull();
    expect(orphan.subagentTurns).toBeNull();
  });

  it('运行期不交这一格（浮层只有一行）：跑动期只给主会话轮次，终态两格一起换成权威值', async () => {
    /**
     * 真机形状：主会话派一次活就算 1 轮，子智能体自己跑好几轮。若运行期就把子那一份交出去，
     * 界面按「主会话 = 合计 − 分量」会算出 `1 − 2 = −1`——`subagentTurns ≤ turns` 那条硬口径
     * 当场被破坏（与 codex 同一档：它的运行期 `turns` 也只有主线程，见 spec §4 **R17**）。
     * claude 的运行期 `turns` 同为主会话口径（`countModelRoundTrip` 按 `parent_tool_use_id` 退出）
     * ⇒ 分量**只在收尾与合计一起给**。
     */
    const configHome = mkdtempSync(join(tmpdir(), 'claude-turns-'));
    writeAgentFile(configHome, 's-live', 'task-1', [
      assistant('sub-m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
      assistant('sub-m-2', { input_tokens: 6, cache_read_input_tokens: 0, output_tokens: 3 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-live' },
            dispatchStarted('task-1', { tool_use_id: 'call_1' }),
            mainAssistant('a-1', 'main-m-1'),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const result = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: collectEvents(events) }));

    const usage = events.filter((event) => event.type === 'usage');
    /**
     * **claude 的事件流里 `turn.subagentId` 恒为 `null`**（2026-10-06 用户裁定：只交最终用量）。
     * 「每个子智能体自己花了多少」走 `SubagentRecord.usage`（收尾重交，判据见
     * `subagent-usage-cache.test.ts`），不再有带会话身份的逐轮读数 ⇒ 这一组同时钉住两件事：
     * **运行期**那两格恒 `null`（界面只画一行），且整条事件流里**一条带会话身份的读数都没有**。
     */
    // 不能是空数组：下面那个循环为空时恒真（那正是「没接线」与「接对了」同形的地方）
    expect(usage.length).toBeGreaterThan(0);
    for (const event of usage) {
      // 没有任何读数带会话身份（那条路已于 2026-10-06 删除）
      expect(event.turn?.subagentId ?? null).toBeNull();
      // 跑动期的合计只有主会话那一份（子智能体的轮次要到收尾读盘才知道）
      expect(event.turns).toBe(1);
      // 每一帧的这一格都是 null ⇒ 界面只画一行（与 `subagentTokens` 在 claude 上今天的行为同形）
      expect(event.subagentTurns).toBeNull();
      expect(event.subagentTokens).toBeNull();
    }
    // 终态：合计 1 + 2 = 3，分量 2（≤ 合计 ⇒ 界面画「主会话 1 轮 / 子智能体 2 轮」）
    expect(result.turns).toBe(3);
    expect(result.subagentTurns).toBe(2);
  });
});

/**
 * **收尾只交最终用量：整条事件流里没有一条带会话身份的读数**（2026-10-06 用户裁定）。
 *
 * 背景：2026-10-05 曾实现「每个子会话**每一轮**发一条带 `turn = { subagentId, round }` 的 `usage`」，
 * 好让子会话节点的时间轴上有逐轮里程碑。那批读数要按轮拆 CLI 落盘的转录文件，而用户的口径是
 * 「通过读取文件的方式，成本过高无必要，**展示最终用量即可**」⇒ 本次删除。
 * claude 因此与 codex 同形：主会话走事件流，**每个子智能体自己的最终用量**走
 * `SubagentRecord.usage`（抽屉里子任务条那一格，收尾重交——见 `subagent-usage-cache.test.ts`）。
 *
 * ⚠️ **删掉的只是事件，行级三格一个字节都没动**（这正是本组 ② 要钉的东西）：`subagentTokens` 仍是
 * 「各转录按 `message.id` 去重后求和」、`subagentTurns` 仍是它们的往返数之和、`tokens` / `turns`
 * 仍是「主 + 子」。
 */
describe('claude-code 收尾只交最终用量（2026-10-06：删掉子会话逐轮读数）', () => {
  /**
   * **两个**子会话、各两轮（task-1 的 `task-1-m-1` 出现两次、后到覆盖 ⇒ 仍是两轮）。
   *
   * ⚠️ 为什么必须是两个：只有一个子会话时「它末轮的累计」与「行级分量」数值恰好相同，
   * 「把会话自己的数写进行级分量」这类缺陷在这份夹具上**分辨不出来**。
   */
  function writeTwoSubagents(configHome: string, sessionId: string): void {
    writeAgentFile(configHome, sessionId, 'task-1', [
      assistant('task-1-m-1', { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant('task-1-m-1', { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 }),
      assistant('task-1-m-2', { input_tokens: 20, cache_read_input_tokens: 200, output_tokens: 5 }),
    ]);
    writeAgentFile(configHome, sessionId, 'task-2', [
      assistant('task-2-m-1', { input_tokens: 7, cache_read_input_tokens: 0, output_tokens: 3 }),
      assistant('task-2-m-2', { input_tokens: 1, cache_read_input_tokens: 40, output_tokens: 2 }),
    ]);
  }

  /**
   * 派两个子会话、主会话立一轮、收尾给一条带结算计量的 `result`——两个判据共用这一份形状。
   */
  async function runTwoSubagents(
    configHome: string,
    sessionId: string,
  ): Promise<{ result: AgentRunResult; events: AgentEvent[] }> {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: sessionId },
            dispatchStarted('task-1', { tool_use_id: 'call_1' }),
            dispatchStarted('task-2', { tool_use_id: 'call_2' }),
            mainAssistant('a-1', 'main-m-1'),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const result = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: collectEvents(events) }));
    return { result, events };
  }

  /** 带会话身份的读数（2026-10-06 之后应当**恒为空**）；`subagentId` 是 `null` 的才是主会话读数 */
  function ownReadings(events: readonly AgentEvent[], subagentId: string): Array<Extract<AgentEvent, { type: 'usage' }>> {
    return events.filter(
      (event): event is Extract<AgentEvent, { type: 'usage' }> =>
        event.type === 'usage' && event.turn?.subagentId === subagentId,
    );
  }

  it('① 一条带会话身份的读数都没有（主会话读数照旧在）', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-own-'));
    writeTwoSubagents(configHome, 's-own');
    const { events } = await runTwoSubagents(configHome, 's-own');

    // 靶子：把逐轮那一段加回去 ⇒ 这两条当场红
    expect(ownReadings(events, 'task-1')).toEqual([]);
    expect(ownReadings(events, 'task-2')).toEqual([]);
    // 前提钉：主会话读数确实在（否则「一条都没有」在「压根没跑」时也成立）
    const mainReadings = events.filter(
      (event): event is Extract<AgentEvent, { type: 'usage' }> =>
        event.type === 'usage' && (event.turn?.subagentId ?? null) === null,
    );
    expect(mainReadings.length).toBeGreaterThan(0);
  });

  it('② 两格照旧：tokens / subagentTokens / subagentTurns / turns 与删除前逐字相同', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-own-'));
    writeTwoSubagents(configHome, 's-own');
    const { result } = await runTwoSubagents(configHome, 's-own');

    // 分量 = **两个**子会话各自的合计（128/240/20）：不是任何一个会话的末轮累计（那是 M2 要拦的形状）
    expect(result.subagentTokens).toEqual({ input: 128, cached: 240, output: 20, reasoningOutput: null, total: null });
    expect(result.subagentTurns).toBe(4);
    // 合计 = 主会话（100/0/10） + 分量，逐格相加；轮次 = 主 1 + 子 4
    expect(result.tokens).toEqual({ input: 228, cached: 240, output: 30, reasoningOutput: null, total: null });
    expect(result.turns).toBe(5);
  });

  it('③ 既有的「全量或 null」与两条点名 WARN 一个字都没变（删读数不许带动它们）', async () => {
    /**
     * A：**行合计读得出来**、而有一个子会话读不出来——「只见到收场帧」那一档（盘上没有它的转录）。
     * 判不了的条目**不参与**两格（分量就是读得到的那些），但必须点名。
     */
    const configHome = mkdtempSync(join(tmpdir(), 'claude-own-partial-'));
    writeAgentFile(configHome, 's-own-a', 'task-1', [
      assistant('task-1-m-1', { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 }),
      assistant('task-1-m-2', { input_tokens: 20, cache_read_input_tokens: 200, output_tokens: 5 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-own-a' },
            dispatchStarted('task-1', { tool_use_id: 'call_1' }),
            // 只见到收场帧（没有 `task_started`）**且**盘上没有它的转录 ⇒ 这个会话读不出来
            { type: 'system', subtype: 'task_notification', task_id: 'task-2', tool_use_id: 'call_2', status: 'completed', summary: '跑完了' },
            mainAssistant('a-1', 'main-m-1'),
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const result = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: collectEvents(events) }));

    expect(result.subagentTokens).toEqual({ input: 120, cached: 200, output: 15, reasoningOutput: null, total: null });
    expect(result.subagentTurns).toBe(2);
    expect(
      events.some(
        (event) => event.type === 'log' && event.text.includes('只见到收场帧的 task 条目') && event.text.includes('task-2'),
      ),
    ).toBe(true);

    /**
     * B：**有转录读不动**（空文件：CLI 还没写完 / 被中断）⇒ 「全量或 null」让**两格一起** `null`
     * （判据在 `readClaudeSubagentUsage` 里，与本次删掉的读数无关）。
     */
    const partialHome = mkdtempSync(join(tmpdir(), 'claude-own-partial-b-'));
    writeAgentFile(partialHome, 's-own-b', 'task-1', [
      assistant('task-1-m-1', { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 }),
    ]);
    // task-2 的转录**在**、但读不出可用记录 ⇒ 与「读不动」同一档
    writeAgentFile(partialHome, 's-own-b', 'task-2', []);
    const partial = await runTwoSubagents(partialHome, 's-own-b');

    // 既有的「全量或 null」与点名 WARN 一个字节都没变
    expect(partial.result.subagentTokens).toBeNull();
    expect(partial.result.subagentTurns).toBeNull();
    expect(
      partial.events.some(
        (event) => event.type === 'log' && event.text.includes('读不到子智能体') && event.text.includes('task-2'),
      ),
    ).toBe(true);
  });
});
