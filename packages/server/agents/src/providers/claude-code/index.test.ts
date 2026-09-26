// @vitest-environment node
/**
 * claude-code 适配器：注入落点、凭据隔离正反两面、事件贯通、超时释放顺序、加载降级。
 * 全部走假 SDK 注入 —— 单测不碰真实 CLI、不碰真实 API、不产生费用。
 * 另含两条控制方追加的回归钉：投影 `failure` 非空的出口（三个适配器共用）、以及
 * `onGraceExceeded` 这条 `release.ts ↔ turn.ts` 接缝上的抛错路径。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@aieval/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeClaudeSdk,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import { claudeCodeProvider } from './index';
import { CLAUDE_PACKAGE_NAME } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(recorder.env?.CLAUDE_CONFIG_DIR).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.env?.HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    /**
     * 任务跟踪工具必须**常开**（用户口径 2026-09-30）。
     * 为什么这条守卫值得存在：不开它时 claude 的工具表里**一个 `Task*` 都没有**
     * （A/B 实测 26 → 30），`task` 族在 claude 侧恒为空 —— 那是**静默的空**，
     * 界面上与「这一轮没做规划」长得一模一样，跨家比较会因此失真。
     */
    expect(recorder.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');
    expect(recorder.options?.model).toBe('claude-x');
    expect(recorder.options?.cwd).toBe('D:/tmp/rows/row-1/workspace');
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
    //   · 判据反过来（`!includes`）⇒ 第三方模型拿到网关不实现的工具（§5.6.4：网关对这类命名空间
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

  it('cwd 做 realpath 归一：8.3 短名路径不得原样交给 SDK（终审 H1 的另一半）', async () => {
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
      // 用一条可读的跳过原因，而不是悄悄 return：静默跳过会让「守卫还在不在」无从判断
      expect
        .soft(`本机 tmpdir 不含 8.3 短名（${shortRoot}），H1 的归一用例在此环境不可构造`)
        .toContain('~');
      return;
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
      rmSync(probeRoot, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
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

  it('用户终止：顺序为 interrupt → turn 终结 → dispose（§5.6.5）', async () => {
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
 */
describe('claude-code 的思考强度', () => {
  it('给了 effort ⇒ options.effort 原样带上；没给 ⇒ 该键不存在', async () => {
    const withEffort = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: withEffort, events: [] }) },
    });
    await claudeCodeProvider.run(createRunInput({ effort: 'max' }));
    expect(withEffort.options?.effort).toBe('max');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: bare, events: [] }) } });
    await claudeCodeProvider.run(createRunInput());
    expect(bare.options).not.toBeNull();
    expect(Object.hasOwn(bare.options ?? {}, 'effort')).toBe(false);
  });
});
