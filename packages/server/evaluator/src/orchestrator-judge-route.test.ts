// @vitest-environment node
/**
 * 评分尺子只有一个来源：全局默认
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：评分尺子只有一个来源：全局默认、runRow：评分通路（开关决定谁去驱动那把尺子）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import { JUDGE_OUTPUT_JSON_SCHEMA } from '@aieval/contracts';
import {
  registerOrchestratorHooks,
  TEST_TIMEOUT_MS,
  until,
  seedRunnableRun,
  judgeReplyJson,
  providerOfRoute,
  loadConfig,
  readEvents,
  rowEventsFile,
  saveConfig,
  abortRow,
  drainRunningTasks,
  runRow,
  getRun,
  fakeAgents,
  fakeJudge,
  makeProviderFixture,
  releaseAllAgents,
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

describe('评分尺子只有一个来源：全局默认', { timeout: TEST_TIMEOUT_MS }, () => {
  it('路由与行上记录的都是全局默认那一家（不是「用例空着就记空串」）', async () => {
    const { run, provider } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const call = fakeJudge.calls[0];
    expect(call).toBeDefined();
    expect(providerOfRoute(call!.route, loadConfig().providers).id).toBe(call!.judgeProviderId);
    expect(call!.judgeProviderId).toBe(provider.id);
    expect(call!.route.modelId).toBe('judge-model');
    expect(getRun(run.id).rows[0]?.score?.judgeProviderId).toBe(provider.id);
  });

  /**
   * M1 的那个窗口：编排层原先取一次 `settings` 快照，而 `resolveJudgeRoute` 在评分时刻
   * 又 `loadConfig()` 一次。窗口 = 整段 agent 执行时间（秒到分钟）：用户在设置页换掉默认评分模型，
   * 记在行上的 `judgeProviderId`（旧）与真正发出的 `route.modelId`（新）就不是同一把尺子。
   * 修法：评分前**现取一次** `loadConfig()`（与 `resolveJudgeRoute` 内部那次之间没有 await）。
   */
  it('评分前改默认评分模型：行上记录的 providerId 与真正生效的路由仍是同一把尺子（M1 的窗口）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    const second = makeProviderFixture({
      name: '换上去的评分供应商',
      models: [{ id: 'judge-model-new', source: 'manual' }],
    });
    // 让 agent 停在「执行中」：这个窗口在生产上就是整段 agent 执行时间
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    const running = runRow(run.id, rowId);
    await until(() => fakeAgents.gates.size === 1, '假适配器进入挂起态');

    // 用户在**评分之前**去设置页把默认评分模型换成第二家
    const config = loadConfig();
    saveConfig({
      ...config,
      providers: [...config.providers, second],
      settings: { ...config.settings, defaultJudge: { providerId: second.id, modelId: 'judge-model-new' } },
    });
    releaseAllAgents();
    await running;

    const call = fakeJudge.calls[0];
    expect(call).toBeDefined();
    // 两处必须指向同一个供应商，且是**评分时刻真正生效**的那一家（新配置）——记录旧的那份就是漂移
    expect(providerOfRoute(call!.route, loadConfig().providers).id).toBe(call!.judgeProviderId);
    expect(call!.judgeProviderId).toBe(second.id);
    const score = getRun(run.id).rows[0]?.score;
    expect(score?.judgeProviderId).toBe(second.id);
    expect(score?.judgeModelId).toBe('judge-model-new');
  });
});


/**
 * 第 7 步的两条通路（spec §7.3 / §7.4）。
 *
 * 本组用例统一用**候选 = codex（openai）+ 评分智能体 = claude-code（anthropic）**：假适配器的脚本
 * 按 `kind` 索引，两家同 kind 时无法分阶段驱动（`fakeAgents.scripts.set` 会同时命中候选与评审者）。
 * 分家的另一面是「评分模型那一对来自一条 anthropic 供应商」——`seedRunnableRun` 的 `judgeAgentKind`
 * 会自动把它接上。
 */
describe('runRow：评分通路（开关决定谁去驱动那把尺子）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('开关关闭 → 走纯文本通路（既有行为零改动）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    await runRow(run.id, run.rows[0]?.id ?? '');
    expect(fakeJudge.calls).toHaveLength(1);
    expect(fakeAgents.calls).toHaveLength(1); // 只有候选那一次，评分没有再起一次 agent
    expect(getRun(run.id).rows[0]?.score?.judgeAgentKind).toBeNull();
  });

  it('开关打开 → 走智能体通路，评分智能体在该行工作区里跑，judgeAgentKind 落库', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'claude-code' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('claude-code', { finalText: judgeReplyJson() });

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.score?.judgeAgentKind).toBe('claude-code');
    // 满分 30（评分表 A1 20 + A2 10），全部达成 ⇒ 30：编排层把 `run.rubric` 那份快照交给了评分器，
    // 引用的正是夹具那张表的键——传错（或漏传）时这一条会先红
    expect(row?.score?.totalScore).toBe(30);
    expect(fakeJudge.calls).toHaveLength(0); // 纯文本通路一次都没走
    // 两次适配器调用：候选（codex）一次、评分（claude-code）一次
    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'claude-code']);
    expect(fakeAgents.calls[1]?.cwd).toBe(row?.workspacePath);
    expect(fakeAgents.calls[1]?.configHome).toContain('.judgehome');
    expect(fakeAgents.calls[0]?.configHome).toContain('.agenthome');
    /**
     * 权限档按**阶段**分给（用户口径，2026-09-28）：候选要能改代码、装依赖、跑测试，
     * 评审者只能看。为什么这两条必须钉在**编排层**：适配器那一侧两档都正确实现，也可能被
     * 编排层传反——而传反的后果是**静默**的：候选改不动文件（在空 diff 上被评分，p6 冒烟 A1 的形状），
     * 或者评审者把工作区改了（「查看改动」抽屉显示的不再是候选的产出）。别处没有任何观测量能区分。
     */
    expect(fakeAgents.calls[0]?.permission).toBe('full');
    expect(fakeAgents.calls[1]?.permission).toBe('read-only');
    // 阴性面（F2）：评分前后的改动摘要一致时**一条 WARN 都不该有**。少了这条断言，「无条件告警」
    // 的实现（不管摘要变没变都发那条 WARN）在整套用例面前照样全绿——而它会天天误报。
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.some((event) => event.type === 'log' && event.text.includes('工作区被改动'))).toBe(false);
  });

  /**
   * **能力决定带不带 schema**（spec D4：「谁知道能力、谁决定」只有一个答案，写在编排层）。
   *
   * 为什么这两条必须成对出现，缺一条就退化成假绿：
   *   · 只有 claude-code 那一条绿 ⇒ 「无脑都传」的实现照样绿（它本来就能收这一格），
   *     「按能力决定」与「无脑都传」在这条用例面前**没有任何区别**；
   *   · 只有 dsh 那一条绿 ⇒ 「谁也不传」的实现照样绿——那正是本任务开工前线上每一分的形状
   *     （`structuredOutput` 恒 `false`、整条链路只在测试里被点亮），而当时整套用例是全绿的。
   * 两条一起，四种写法（都传 / 都不传 / 按能力 / 传反）才两两分得开。
   */
  it('评分智能体支持结构化输出 ⇒ 没有降级日志，且这一分记 structuredOutput=true', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'claude-code' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('claude-code', { finalText: judgeReplyJson() });

    await runRow(run.id, rowId);

    // 先把调用顺序钉住，再按索引取那一次：不钉的话，「断言看错了那一次调用」会以一条与能力判断
    // 无关的红/绿出现（候选那一次永远不带 schema，取错索引时 dsh 那条也会以另一种方式假绿）
    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'claude-code']);
    // 端到端①（R34/R38）：评分阶段那一次 `run()` 的入参里**有** `outputSchema`，且逐格等于契约里那一份
    // ——不是另拼一份、也不是 `{}`：schema 少一格，CLI 侧的约束就静默消失，而分数照出、行照样绿
    expect(fakeAgents.calls[1]?.outputSchema).toEqual(JUDGE_OUTPUT_JSON_SCHEMA);
    expect(getRun(run.id).rows[0]?.score?.structuredOutput).toBe(true);
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.some((event) => event.type === 'log' && event.text.includes('不支持结构化输出'))).toBe(false);
  });

  it('评分智能体不支持（dsh）⇒ 一条降级日志，且这一分记 structuredOutput=false', async () => {
    // 候选仍是 codex/openai；`judgeAgentKind: 'dsh'` 会把评分模型接上一条 anthropic 供应商（dsh 只吃它）
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'dsh' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('dsh', { finalText: judgeReplyJson() });

    await runRow(run.id, rowId);

    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'dsh']);
    // 端到端②（R34/R38）：dsh 那一次 `run()` 的入参里**没有**这一格。
    // 观测点是夹具刻意的 `undefined`（而不是 `false` / `null`）：它把「没给」与「给了 null」分开——
    // 后者在三家适配器里都同义于「没给」，却会被 T6 的记账记成 `true`（Task 9 统一收口的口径）。
    expect(fakeAgents.calls[1]?.outputSchema).toBeUndefined();
    expect(getRun(run.id).rows[0]?.score?.structuredOutput).toBe(false);
    // 降级**必须留痕**（spec D4）：降级是允许的，静默降级不是——「这一分是在提示词契约下拿到的、
    // 不是 schema 约束下拿到的」必须能从该行日志里读出来，否则一组分数里混着两种口径而无人知晓。
    // 断「恰好一条」而不是「至少一条」：同一件事被发两遍同样会把日志抽屉读乱。
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    const degradation = events.filter((event) => event.type === 'log' && event.text.includes('不支持结构化输出'));
    expect(degradation).toHaveLength(1);
  });

  it('开关打开但没配默认评分智能体 → 该行 failed + CONFLICT，且评分智能体一次都没起', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: null });
    await runRow(run.id, run.rows[0]?.id ?? '');
    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('CONFLICT');
    expect(row?.error?.message).toContain('没有配置默认评分智能体');
    expect(fakeAgents.calls).toHaveLength(1); // 只有候选那一次
  });

  it('评分智能体的协议与评分模型不匹配 → 该行 failed + CONFLICT，点名两家', async () => {
    // 候选仍是 codex/openai；评分模型那一对来自 anthropic 供应商 ⇒ codex（只吃 openai）驱动不了它
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'codex' });
    await runRow(run.id, run.rows[0]?.id ?? '');
    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    // 文案取自 `protocolMismatchMessage`（**四个判定点共用同一份**，计划 Task 2 Step 2）：
    // 前缀点明「谁只接受什么」，再点明「被拒绝的那个模型属于哪种协议」。断言两半都要有——
    // 只钉前缀的话，`accepted` 那一段写错（比如把集合当单值用）也照样绿。
    expect(row?.error?.message).toMatch(/Codex 只接受 OpenAI 兼容协议/);
    expect(row?.error?.message).toContain('judge-model');
    expect(row?.error?.message).toContain('Anthropic 兼容协议');
  });

  /**
   * **「评分不限时间」的形状**（用户口径，2026-09-28）：评分智能体长时间不返回时，这一行**不再**自己
   * 超时——外层兜底 + 硬停随「单行超时」一起删除。它停在 `judging`，唯一的出口是用户点「终止」。
   *
   * 这一条同时是「有人把兜底超时加回来」的守卫：加回来的话，下面 3 秒后的状态断言就会看到
   * 行离开 `judging` 并落 `timed-out`，立刻红。
   * ⚠️ 夹具同样用 `mode: 'gate'` 而不是 `hang`（理由见上一条用例）：`hang` 会让这一行永不落定，
   * 其条目留在 `runTasks` 里把后续用例的 `drainRunningTasks()` 一起拖死。
   */
  it('评分智能体长时间不返回 ⇒ 不再有兜底超时（停在 judging），用户终止后才收场', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'claude-code',
    });
    const rowId = run.rows[0]?.id ?? '';
    // 候选（codex）照默认脚本正常完成；评分（claude-code）挂住等放行
    fakeAgents.scripts.set('claude-code', { mode: 'gate' });

    const running = runRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'judging', '行进入 judging', TEST_TIMEOUT_MS);
    // 挂住 3 秒：状态一个字都没变，也没有超时归因
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const hanging = getRun(run.id).rows[0];
    expect(hanging?.status).toBe('judging');
    expect(hanging?.error).toBeNull();

    abortRow(run.id, rowId);
    const settled = getRun(run.id).rows[0];
    expect(settled?.status).toBe('canceled');
    expect(settled?.error).toBeNull();
    // 收尾：abort 让 gate 放行，那一次运行随之落定（不留孤儿）
    await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    await drainRunningTasks();
  }, TEST_TIMEOUT_MS);




});
