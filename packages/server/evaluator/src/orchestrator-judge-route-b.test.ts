// @vitest-environment node
/**
 * 评分尺子只有一个来源：全局默认（切分后的第二块）
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：评分尺子只有一个来源：全局默认、runRow：评分通路（开关决定谁去驱动那把尺子）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import {
  registerOrchestratorHooks,
  TEST_TIMEOUT_MS,
  until,
  seedRunnableRun,
  judgeReplyJson,
  logTextOf,
  readEvents,
  rowEventsFile,
  abortRow,
  runRow,
  getRun,
  fakeAgents,
  fakeJudge,
} from './testing/orchestrator-harness';

vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock());
vi.mock('./judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./judge')>();
  return (await import('./testing/orchestrator-seams')).judgeMock(actual);
});
vi.mock('./run-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-store')>();
  return (await import('./testing/orchestrator-seams')).runStoreMock(actual);
});

registerOrchestratorHooks();

describe('runRow：评分通路（开关决定谁去驱动那把尺子）', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * **FIX-3：用户终止发生在「评分智能体正在跑」的时候**（终审补的守卫）。
   *
   * 为什么必须单独钉：`judgeStageAttempt` 的 catch 里，`AGENT_CANCELED` 这一支现在**只**代表用户终止
   * ——原来「终止发生在评分阶段」这条路径**一条用例都没有**，而界面上写错会变成
   * 「用户明明按了终止，行却显示别的东西」（两者的处置完全相反）。
   */
  it('评分智能体在跑时用户终止 → 该行 canceled、恰好一条 end{canceled}、不被记成超时', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'claude-code',
    });
    const rowId = run.rows[0]?.id ?? '';
    // 协作适配器：挂住直到 signal 被 abort，然后如实报 canceled（与既有的兜底用例同一形状）
    fakeAgents.scripts.set('claude-code', { mode: 'gate' });

    // 与文本通路那条同理：`abortRow` 是同步落库的，只看行状态的话「signal 没递给适配器、
    // 评审者还挂在半空」的实现照样绿 ⇒ 单独钉住「这一行任务真的收尾了」，且要有界
    //（拿掉 signal 时它永远不会返回，用例必须在 10 秒内明确变红，而不是拖满 60s 上限）。
    let rowTaskDone = false;
    const running = runRow(run.id, rowId).finally(() => { rowTaskDone = true; });
    // 等待上限放到 20 秒：本机的工作区准备（真 git 复制）实测 2–7 秒，默认的 5 秒会偶发把
    // 「还没到 judging」报成守卫失败（实测踩过：变异验证里它就假红过一次）
    await until(() => getRun(run.id).rows[0]?.status === 'judging', '行进入 judging', 20_000);
    // 前提复检：此刻起的必须是**评分**那一次（否则下面测到的可能还是候选阶段）
    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'claude-code']);

    abortRow(run.id, rowId);
    expect(getRun(run.id).rows[0]?.status).toBe('canceled'); // 同步落库（界面靠这一帧画卡片）
    await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    expect(rowTaskDone).toBe(true);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('canceled');
    // 用户终止不该留下任何归因（`error` 为 null 就是「用户自己停的」的形状）
    expect(row?.error).toBeNull();
    // 事件日志是唯一真相源：**恰好一条** end，且理由是 canceled（迟到的收尾不许再补一条）
    const ends = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId)).filter((event) => event.type === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ type: 'end', exitReason: 'canceled' });
  });
  /**
   * **ADD-1：行收尾之后吐出来的评审者日志不再落盘**（与候选阶段的 `settled` 同一口径）。
   *
   * 为什么必须有这一条：`judgeStageAttempt` 一落定，调用方立刻写终态；而适配器可能还在收尾
   * （`dispose` 只能尽力让迭代结束，见 `turn.ts`），它随后吐出的日志会**无条件**追加进
   * `events.jsonl`——日志抽屉里于是出现「这一行已经结束了，却还在往外冒日志」。
   * 夹具的 `mode: 'late'` 就是那个形状：睡够一段时间，然后在**已经收尾之后**投递一条日志。
   * 收尾由**用户终止**触发（2026-09-28 起没有兜底超时了，这也是这一行唯一可能的收尾方式）。
   */
  it('行收尾之后适配器才吐出来的日志不再落盘（迟到事件闸门）', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'claude-code',
    });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('claude-code', { mode: 'late', lateMs: 3_600, lateText: '迟到的日志：编排层已经收尾了' });

    const running = runRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'judging', '行进入 judging', TEST_TIMEOUT_MS);
    abortRow(run.id, rowId);
    expect(getRun(run.id).rows[0]?.status).toBe('canceled');
    // 等那一次迟到的投递**真的发生**（不等到的话下面那条否定断言是空转）
    await until(() => fakeAgents.calls.at(-1)?.finishedAt !== null, '迟到的运行已收尾', 10_000);
    await running;

    const texts = logTextOf(run.id, rowId);
    expect(texts).not.toContain('迟到的日志'); // 闸门之后的那一条**不许**落盘
  }, TEST_TIMEOUT_MS);
  // Review Focus 第 4 条：抽屉按需现算 diff，评审者改过工作区就会显示成候选的产出
  // 2026-10-07（用户裁决）：从「落一条 WARN」升级为**该行失败**——那一份分建立在一个被评审者
  // 改过的现场上，收下它就等于把一个不可信的分数当成正常分数
  it('评分智能体改了工作区 → 该行 failed（污染不再只是 WARN）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'claude-code' });
    const rowId = run.rows[0]?.id ?? '';
    // 只有评分智能体（claude-code）写文件；候选（codex）不写 —— 这样「评分前/后摘要不一致」
    // 唯一的成因就是评审者动了工作区
    fakeAgents.scripts.set('claude-code', {
      files: [{ path: 'judge-touched.txt', content: '评审者写的\n' }],
      finalText: judgeReplyJson(),
    });

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    // 归因码取适配器那一家（`AGENT_FAILED`），文案里点名「改动了工作区」与两个摘要
    expect(row?.error?.code).toBe('AGENT_FAILED');
    expect(row?.error?.message).toContain('改动了工作区');
    expect(row?.error?.stage).toBe('judge');
    // 行事件里也留着现场（分数没被收下，但过程要能复盘）
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.some((event) => event.type === 'log' && event.text.includes('改动了工作区'))).toBe(true);
  });
  /**
   * **FIX-1 的另一半：用户终止必须真的能切断文本评分**，且只留一条 `end`。
   *
   * 修复前：文本通路拿不到 signal ⇒ 按终止只把状态**同步**改成 `canceled`，调用继续飞到返回为止
   * （那一段就是 `rescoreRefusal` 的 `settling` 要挡的窗口）。接上 signal 之后，这次调用会**当场**
   * 以「已中止」结束，而它绝不许：① 改回状态；② 再补一条 `end`；③ 让 `settleFailed` 折出一条
   * `error` 事件（`settleFailed` 的 `error` 是无条件发布的——只按终态守卫拦不住它）。
   * 2026-09-28 起这**也是**评分阶段唯一的收尾方式：兜底超时删除后，挂住的文本调用没有别的出口。
   */
  it('文本评分在飞时用户终止 → 该行 canceled、恰好一条 end{canceled}、不留 error 事件', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    fakeJudge.mode = 'abort'; // 真实 fetch 的形状：abort 一到就拒绝

    // 这一行任务**有没有真的收尾**必须单独钉住：`abortRow` 是同步落库的，行状态与 signal 无关
    // ⇒ 只看状态的话，「signal 没递下去、调用还挂在半空」的实现照样绿（那正是修复前的形状）。
    let rowTaskDone = false;
    const running = runRow(run.id, rowId).finally(() => { rowTaskDone = true; });
    await until(() => getRun(run.id).rows[0]?.status === 'judging', '行进入 judging', 20_000);

    abortRow(run.id, rowId);
    expect(getRun(run.id).rows[0]?.status).toBe('canceled');
    // 有界等待：signal 没递下去时这次调用永远不会返回，用例必须在 10 秒内明确变红，
    // 而不是拖满套件级的 60s 上限（红得慢的守卫迟早会被当成环境噪声删掉）
    await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    expect(rowTaskDone).toBe(true);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('canceled');
    expect(row?.error).toBeNull();
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    const ends = events.filter((event) => event.type === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ type: 'end', exitReason: 'canceled' });
    // 用户终止不是「失败」：一条 error 事件都不该有（`settleFailed` 那条路是无条件发的）
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });
});
