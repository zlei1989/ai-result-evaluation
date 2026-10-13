// @vitest-environment node
/**
 * 提问端口的**四条硬规则**（实现在 `ask-user.ts`，每条一个用例）。
 *
 * 为什么这四条要独立成一份用例：它们是「模型问到用户」这一格的**全部**语义，四条各自守一件不同的事
 * ——零回归（没挂应答面就一个字都不动）、收场判定（三个赛跑者）、看门狗豁免（等人期间不被自己的
 * 静止超时收掉）、抛错不传染（一次问答故障不毁掉一行产物）。前两条是纯 promise（不需要任何厂商夹具），
 * 后两条只有经过运行骨架才看得见，故用一套**合成 hooks**（不经过任何厂商消息形状，与 `turn.test.ts`
 * 同一手法）走一次 `runTurn`。
 *
 * 末尾另加一组「同一次提问里两题共用一个标题」：它不是第五件语义，而是这四条的前置闸门
 * ——配对键只有 `header`，撞车的那一问在结构上就答不准，故必须在问人之前整场拦下。
 */
import type { AgentEvent, AskUserQuestion } from '@aieval/contracts';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAskUserPort, DEFAULT_ASK_USER_BUDGET_MS } from './ask-user';
import { collectEvents, createRunInput, settleWithFakeTimers } from './testing/agent-fixtures';
import { runTurn, type TurnHooks } from './turn';
import type { AgentKind, AskUserReply, AskUserRequest } from './types';

/** 一份契约形状的问题（端口只搬运，不解释它） */
const QUESTION: AskUserQuestion = {
  header: '选路径',
  prompt: '用哪条路径？',
  options: [
    { label: '选项 A', description: '快一点', recommended: true },
    { label: '选项 B', description: null, recommended: false },
  ],
  multiSelect: false,
  allowOther: true,
  secret: false,
};

/** 一次提问：厂商原始工具名 + 调用 id + 厂商自己的等待预算 + 子智能体身份 */
const REQUEST: AskUserRequest = {
  questions: [QUESTION],
  toolName: 'AskUserQuestion',
  callId: 'call_ask_1',
  vendorBudgetMs: null,
  subagentId: null,
};

const ANSWER: AskUserReply = {
  outcome: 'answered',
  answers: [{ header: '选路径', selected: ['选项 A'], custom: null }],
};
const ANSWERED = { outcome: 'unavailable', answers: null } as const;

/**
 * 收走这一次的 console 输出。
 * 渲染手法与日志器一致（对象交给 Node 的 inspector）：`String(error)` 只剩 `Error: x`，
 * 而「抛错必须带堆栈」这条判据要看到的正是堆栈，自己序列化会把它丢掉。
 */
function captureConsole(): string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 4 }))).join(' '));
  };
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(record);
  }
  return lines;
}

/** 一套合成 hooks：消费期由「适配器」问一次，答复回来之后流继续（用例决定何时收尾） */
interface AskHarness {
  hooks: TurnHooks;
  /** 适配器从端口拿到的答复（按顺序）；用例靠它断言收场方式 */
  replies: AskUserReply[];
  /** 端口**冒出来**的异常（按顺序）。这一格必须是空的：「回调抛错 ⇒ 折成无人应答」是硬规则 */
  askFailures: unknown[];
  /** 看门狗叫停过几次（`interrupt` 被调用 = 判了静止超时） */
  interrupts: () => number;
  /** 放手：让流结束（看门狗自己不会调它；只有用例调） */
  release: () => void;
}

function createAskHarness(options: { request: AskUserRequest; kind?: AgentKind }): AskHarness {
  const replies: AskUserReply[] = [];
  const askFailures: unknown[] = [];
  let interrupts = 0;
  let release: () => void = () => {};
  const hooks: TurnHooks = {
    kind: options.kind ?? 'cc',
    start: async (context) => {
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stream = (async function* () {
        // 第一条事件进消费相：看门狗的两级计时都从这一刻起表（豁免要跟这个时刻比才有意义）
        yield 'tick';
        /**
         * 厂商问了：适配器这一格等用户回答（真实接法就是这一句）。
         * 抛错单独记账而不是让它顺着迭代器冒出去：端口**不抛**是这一格的口径之一，
         * 冒出去时用例要在这一行上直接说清原因，而不是红在一个离真因很远的地方。
         */
        try {
          replies.push(await context.askUser.ask(options.request));
        } catch (error) {
          askFailures.push(error);
        }
        yield 'after-answer';
        // 之后挂住：用例据此断言「答复回来之后重新起表」，而不是「挂过一次就再也不排了」
        await released;
      })();
      return {
        stream,
        // 投影一律「没有输出」：这两条用例判的是「等人期间不算静止」与「抛错不改变结论」，
        // 不该靠事件流制造「有输出」把看门狗的空闲计时重置掉
        project: () => ({ drafts: [], tokens: null, turns: null, failure: null }),
        interrupt: () => {
          interrupts += 1;
          release();
        },
        dispose: async () => {
          release();
        },
      };
    },
  };
  return { hooks, replies, askFailures, interrupts: () => interrupts, release: () => release() };
}

/** 这一份 promise 落定了没有（假定时器下不能用 await 等，会把用例挂死） */
function track<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

beforeEach(() => {
  captureConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('提问端口：四条硬规则', () => {
  it('规则 1：没传回调 ⇒ 立即「无人应答」，不挂起、不登记等待、不发噪音日志', async () => {
    vi.useFakeTimers();
    const lines = captureConsole();
    const waits: string[] = [];
    const port = createAskUserPort(createRunInput({}), {
      kind: 'cc',
      wait: {
        enter: () => waits.push('enter'),
        leave: () => waits.push('leave'),
      },
    });

    expect(port.available).toBe(false);
    await expect(port.ask(REQUEST)).resolves.toEqual(ANSWERED);
    // 「不挂起」＝一个定时器都没排；「不登记等待」＝一次都没进那块豁免判据表
    //（登记了就会挂起看门狗，而这一格一个字都不该动到既有行为）
    expect(vi.getTimerCount()).toBe(0);
    expect(waits).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('规则 2：与「行终止」「这一问的预算」赛跑，三条收场各自落定', async () => {
    vi.useFakeTimers();

    // ① 正常答复：回调先到，答复原样返回（端口不解释它，只搬运）
    const answered = createAskUserPort(createRunInput({ onAskUser: async () => ANSWER }), { kind: 'cc' });
    await expect(answered.ask({ ...REQUEST, vendorBudgetMs: 30_000 })).resolves.toEqual(ANSWER);

    // ② 预算到点：厂商给了自己的预算就以它为准（到点厂商那边自己就收场了，再等没有意义）
    const waited: AskUserReply[] = [];
    const byVendorBudget = createAskUserPort(
      createRunInput({ onAskUser: () => new Promise<AskUserReply>(() => {}) }),
      { kind: 'cc' },
    );
    const vendorRun = byVendorBudget.ask({ ...REQUEST, vendorBudgetMs: 30_000 });
    void vendorRun.then((reply) => waited.push(reply));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(waited).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(waited).toEqual([{ outcome: 'timeout', answers: null }]);

    // ③ 厂商没给预算 ⇒ 用我们自己的缺省预算兜底（同样要能到点，不能无限等）
    const byDefaultBudget = createAskUserPort(
      createRunInput({ onAskUser: () => new Promise<AskUserReply>(() => {}) }),
      { kind: 'cc' },
    );
    const defaultRun = byDefaultBudget.ask({ ...REQUEST, vendorBudgetMs: null });
    const defaultSettled = track(defaultRun);
    await vi.advanceTimersByTimeAsync(DEFAULT_ASK_USER_BUDGET_MS - 1);
    expect(defaultSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(defaultRun).resolves.toEqual({ outcome: 'timeout', answers: null });

    // ④ 行终止：随轮次取消（这一行已经不跑了，答复给谁都没有意义）
    const controller = new AbortController();
    const canceled = createAskUserPort(
      createRunInput({ onAskUser: () => new Promise<AskUserReply>(() => {}), signal: controller.signal }),
      { kind: 'cc' },
    );
    const canceledRun = canceled.ask(REQUEST);
    controller.abort();
    await expect(canceledRun).resolves.toEqual({ outcome: 'canceled', answers: null });
  });

  it('规则 3：等待期间不被判静止（两级都挂起），答复回来之后重新起表', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    let answer: (reply: AskUserReply) => void = () => {};
    const harness = createAskHarness({ request: REQUEST });
    const input = createRunInput({
      // 两级都给小值：豁免漏了任何一级，下面那一段推进都会当场收场
      watchdog: { idleTimeoutMs: 5_000, turnWallClockMs: 9_000 },
      onEvent: collectEvents(events),
      onAskUser: () =>
        new Promise<AskUserReply>((resolve) => {
          answer = resolve;
        }),
    });
    const running = runTurn(input, harness.hooks);
    const settled = track(running);

    // 等到提问登记完成（第一条事件进消费相、适配器问到用户）
    await vi.advanceTimersByTimeAsync(0);
    // 人一直没答：远远越过空闲与单轮两条上限，都不许判静止 —— 这一行正等着人，它还在动
    await vi.advanceTimersByTimeAsync(200_000);
    expect(settled()).toBe(false);
    expect(harness.interrupts()).toBe(0);

    // 答完：这一行又动了，看门狗重新起表（挂过一次就再也不排的话，此后真挂死没人发现）
    answer(ANSWER);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.replies).toEqual([ANSWER]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled()).toBe(false);
    const result = await settleWithFakeTimers(running, { stepMs: 1_000, steps: 10 });
    expect(result.exitReason).toBe('timed-out');
    expect(harness.interrupts()).toBe(1);
  });

  it('规则 4：回调抛错 ⇒ 落「无人应答」+ ERROR（堆栈与三格上下文），不改变结果的 ok / 退出原因', async () => {
    const events: AgentEvent[] = [];
    const lines = captureConsole();
    const harness = createAskHarness({ request: REQUEST });
    const input = createRunInput({
      onEvent: collectEvents(events),
      onAskUser: () => {
        throw new Error('问答网关 502');
      },
    });
    const running = runTurn(input, harness.hooks);
    // 答复是「无人应答」而不是异常：抛错被折进收场，运行照常往前走
    await vi.waitFor(() => {
      expect(harness.replies.length + harness.askFailures.length).toBe(1);
    });
    harness.release();
    const result = await running;

    expect(harness.askFailures, '端口把回调的抛错冒了出来——它必须折成「无人应答」返回').toEqual([]);
    expect(harness.replies).toEqual([{ outcome: 'unavailable', answers: null }]);
    // 「没人答」与「行失败」是两件事：一次问答故障不毁掉一行产物
    expect(result.ok).toBe(true);
    expect(result.exitReason).toBe('completed');
    expect(result.error).toBeUndefined();

    const errorLine = lines.find((line) => line.includes('提问回调抛错'));
    expect(errorLine, '回调抛错必须有一条 ERROR 日志').toBeDefined();
    expect(errorLine).toContain('问答网关 502'); // 堆栈（原文）
    expect(errorLine).toContain('at '); // 堆栈的调用点
    expect(errorLine).toContain('cc'); // kind
    expect(errorLine).toContain('AskUserQuestion'); // toolName
    expect(errorLine).toContain('questionCount: 1'); // 问题数
  });
});

/** 按标题造一题；其余格照抄 `QUESTION`（端口只读 `header`，用例不该被无关格绊住） */
function questionWith(header: string): AskUserQuestion {
  return { ...QUESTION, header };
}

const UNANSWERED = { outcome: 'unavailable', answers: null } as const;

/**
 * **发出前**的拦截：同一次提问里两题共用一个标题。
 *
 * 为什么这一组不能只钉「重复时落无人应答」：契约的配对键只有 `header`，所以这条拦截的正确性有一半是
 * **不许多吃**——标题两两不同时必须照常问人；另一半是它必须发生在问人之前（回调一次都不被调用、
 * 等待一格都不登记），否则人已经对着一个答不准的弹层在答题了。
 */
describe('提问端口：同一次提问里两题共用一个标题', () => {
  it('三条题目里两条同名 ⇒ 整场落「无人应答」，一次都不问人、不登记等待，并点名那个标题', async () => {
    const lines = captureConsole();
    const waits: string[] = [];
    const asked: AskUserRequest[] = [];
    const port = createAskUserPort(
      createRunInput({
        onAskUser: async (request) => {
          asked.push(request);
          return ANSWER;
        },
      }),
      {
        kind: 'cc',
        wait: {
          enter: () => waits.push('enter'),
          leave: () => waits.push('leave'),
        },
      },
    );

    await expect(
      port.ask({ ...REQUEST, questions: [questionWith('选路径'), questionWith('选范围'), questionWith('选路径')] }),
    ).resolves.toEqual(UNANSWERED);
    // 「不问人」不是「问了但没人答」：回调一次都不该被调用，等待一格都不该登记
    //（登记了就会挂起看门狗，而这一问根本没人看）
    expect(asked).toEqual([]);
    expect(waits).toEqual([]);

    const warnLine = lines.find((line) => line.includes('共用一个标题'));
    expect(warnLine, '标题撞车必须有一条 WARN 日志点名，否则这是静默丢弃').toBeDefined();
    expect(warnLine).toContain('选路径'); // 撞的是哪个标题
    expect(warnLine).toContain('questionCount: 3'); // 整场几题
  });

  it('标题两两不同 ⇒ 照常问人（拦截面不许多吃）', async () => {
    const port = createAskUserPort(createRunInput({ onAskUser: async () => ANSWER }), { kind: 'cc' });

    await expect(
      port.ask({ ...REQUEST, questions: [questionWith('选路径'), questionWith('选范围'), questionWith('选风格')] }),
    ).resolves.toEqual(ANSWER);
  });

  it('两题都是空标题 ⇒ 与同名一样拦下（厂商没给标题时归一成空串，两题不可分）', async () => {
    const port = createAskUserPort(createRunInput({ onAskUser: async () => ANSWER }), { kind: 'cc' });

    await expect(port.ask({ ...REQUEST, questions: [questionWith(''), questionWith('')] })).resolves.toEqual(UNANSWERED);
  });

  it('没挂应答面时标题撞车不额外打日志（规则 1 的「一个字都不多打」优先）', async () => {
    const lines = captureConsole();
    const port = createAskUserPort(createRunInput({}), { kind: 'cc' });

    await expect(port.ask({ ...REQUEST, questions: [questionWith('选路径'), questionWith('选路径')] })).resolves.toEqual(UNANSWERED);
    expect(lines).toEqual([]);
  });
});
