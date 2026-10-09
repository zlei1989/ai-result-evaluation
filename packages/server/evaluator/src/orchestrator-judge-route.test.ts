// @vitest-environment node
/**
 * 评分尺子只有一个来源：全局默认
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：评分尺子只有一个来源：全局默认、runRow：评分通路（开关决定谁去驱动那把尺子）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import { JUDGE_OUTPUT_JSON_SCHEMA, type AgentKind } from '@aieval/contracts';
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
    // 阴性面（F2）：评分前后的改动摘要一致时**一条污染记录都不该有**（2026-10-07 起它同时也是
    // 「该行不许因污染被判失败」的阴性面）。少了这条断言，「无条件告警」的实现（不管摘要变没变都发
    // 那条记录）在整套用例面前照样全绿——而它会天天误报。
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.some((event) => event.type === 'log' && event.text.includes('改动了工作区'))).toBe(false);
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
  });

  /**
   * **总是表达「我想要 schema」，能不能给由适配器报回来**（A1；在此之前是编排层预读注册表的能力表、
   * 替不支持的家把这一格扣下）。判据只剩一个来源：适配器在结果里报的 `applied.structuredOutput`。
   *
   * 为什么这两条必须成对出现，缺一条就退化成假绿：
   *   · 只有 claude-code 那一条绿 ⇒ 「谁也不传」的实现照样绿——那正是本任务开工前线上每一分的形状
   *     （`structuredOutput` 恒 `false`、整条链路只在测试里被点亮），而当时整套用例是全绿的；
   *   · 只有 dsh 那一条绿 ⇒ 「降级不留痕」或「记账不看 `applied`」的实现照样绿——它必须同时钉住
   *     两件事：dsh 那一次 `run()` **也**收到了 schema（不再被扣下），而这一分仍记 `false`。
   * 两条一起，四种写法（都传 / 都不传 / 按能力扣下 / 传反）才两两分得开。
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
    expect(events.some((event) => event.type === 'log' && event.text.includes('没有把结构化输出落到实处'))).toBe(false);
  });

  it('评分智能体不支持（dsh）⇒ 一条降级日志，且这一分记 structuredOutput=false', async () => {
    // 候选仍是 codex/openai；`judgeAgentKind: 'dsh'` 会把评分模型接上一条 anthropic 供应商（dsh 只吃它）
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'dsh' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('dsh', { finalText: judgeReplyJson() });

    await runRow(run.id, rowId);

    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'dsh']);
    // 端到端②（R34/R38）：dsh 那一次 `run()` 的入参里**也**有这一格（A1 的关键：编排层不再替它
    // 决定「这家给不了」）。降级是适配器按自己的能力做的，唯一痕迹是它报回的 `applied`
    // ——下面那条日志与 `structuredOutput=false` 都从它来，而不是从我们传没传 schema 推的。
    expect(fakeAgents.calls[1]?.outputSchema).toEqual(JUDGE_OUTPUT_JSON_SCHEMA);
    expect(getRun(run.id).rows[0]?.score?.structuredOutput).toBe(false);
    // 降级**必须留痕**：降级是允许的，静默降级不是——「这一分是在提示词契约下拿到的、
    // 不是 schema 约束下拿到的」必须能从该行日志里读出来，否则一组分数里混着两种口径而无人知晓。
    // 断「恰好一条」而不是「至少一条」：同一件事被发两遍同样会把日志抽屉读乱。
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    const degradation = events.filter((event) => event.type === 'log' && event.text.includes('没有把结构化输出落到实处'));
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

/**
 * 评分强度（spec §5.3）：`settings.defaultJudge.effort` 由 `resolveJudgeEffort()` 读一次，两条分支各自递下去。
 *
 * 为什么必须在**编排层**再钉一次：`judge.test.ts` / `judge-agent.test.ts` 只能证明「值交到评分器手里
 * 之后会透下去」，证明不了「编排层把配置里的值交给了评分器」。少了这一段，用户在设置页选了 `max`
 * 而每一分都记 `null`——分数照出、日志干净、界面上只有一个「未指定」，与「确实没配」长得一模一样
 * （本任务最典型的静默失败面）。两条通路各一条：它们是两个独立的传值点。
 */
describe('评分强度：唯一读点 → 两条通路', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * 把全局默认评分模型那一格的强度改成 `effort`：走与生产同一条落盘路径（`saveConfig`）。
   * `defaultJudgeAgent` 给了就一起改——越域档位那两条要用 dsh（它的域是 off/low/high/max，没有 `medium`）。
   */
  function seedJudgeEffort(effort: string, defaultJudgeAgent?: AgentKind): void {
    const config = loadConfig();
    const judge = config.settings.defaultJudge;
    if (judge === null || judge === undefined) throw new Error('夹具必须先配好默认评分模型');
    saveConfig({
      ...config,
      settings: {
        ...config.settings,
        defaultJudge: { ...judge, effort },
        ...(defaultJudgeAgent === undefined ? {} : { defaultJudgeAgent }),
      },
    });
  }

  /** 把默认评分模型换成一对**悬空**的 id（供应商已被删除）：钉「两道门不许互相顶掉」的归因 */
  function seedDanglingJudge(): void {
    const config = loadConfig();
    saveConfig({
      ...config,
      settings: { ...config.settings, defaultJudge: { providerId: 'gone', modelId: 'judge-model', effort: 'medium' } },
    });
  }

  it('文本通路：配置里的强度到达 judgeRow', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    seedJudgeEffort('max');

    await runRow(run.id, run.rows[0]?.id ?? '');

    const call = fakeJudge.calls[0];
    expect(call).toBeDefined();
    // 强度是**请求参数**：它只该出现在 `judgeEffort` 这一格上，而不是长在尺子（route）上
    expect(call?.judgeEffort).toBe('max');
  });

  it('智能体通路：同一个强度到达适配器，并记进这一分（配置 → run → 落盘的分数）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'claude-code' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('claude-code', { finalText: judgeReplyJson() });
    seedJudgeEffort('max');

    await runRow(run.id, rowId);

    // 先把调用顺序钉住再按索引取：候选（codex）那一次不该带评分强度，取错索引会让这条断言失去意义
    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'claude-code']);
    expect(fakeAgents.calls[1]?.effort).toBe('max');
    // 端到端：这一分记的是那个档（这一段走的是**真实** judgeRowByAgent 与真实 finalizeScore，只有适配器是假的）
    expect(getRun(run.id).rows[0]?.score?.judgeEffort).toBe('max');
  });

  /**
   * **未配置强度**（用户没配思考强度时的默认路径）的反面对照：一个强度键都不该出现。
   * 为什么必须有这一条：上面两条只证明「配了就带下去」，证明不了「没配就不带」——
   * 把条件展开改成 `judgeEffort: judgeEffort ?? 'high'` 这类「未配就塞个缺省档」的写法时，
   * 上面两条照样全绿，而后果正是本任务要防的那种静默：**用户没配强度，却每次评分被记成一个显式档**
   * （与「确实配了这一档」在数据上再也分不开）。判据是**值**（`FakeTextCall` 无条件记这一格）。
   */
  it('未配置强度 ⇒ 文本通路一个强度键都不带（未指定不是某一档）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const call = fakeJudge.calls[0];
    expect(call).toBeDefined();
    expect(call?.judgeEffort).toBeUndefined();
  });

  it('未配置强度 ⇒ 智能体通路不带这一格，且这一分记 null（不许凭空塞缺省档）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'claude-code' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('claude-code', { finalText: judgeReplyJson() });

    await runRow(run.id, rowId);

    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'claude-code']);
    expect(fakeAgents.calls[1]?.effort).toBeUndefined();
    // 端到端那一半：落盘的分数记 `null`（这一段走真实 judgeRowByAgent 与真实 finalizeScore）
    expect(getRun(run.id).rows[0]?.score?.judgeEffort).toBeNull();
  });

  /**
   * **第二道门**（spec §5.4 / D8）在编排层这一侧的落点：手改 config.json 写成 `dsh + medium`
   * （dsh 的域是 off/low/high/max，没有 medium）。不拦的话要跑到 dsh 的
   * `UNSUPPORTED_REASONING_EFFORT` 才失败，症状离真因很远。
   * 两条通路**各自**有一道（它们是两个独立的调用点），故两条都要钉；判据都要有区分力：
   * 行必须 `failed` + `CONFLICT` + 指名评分配置，且**一次评分都不花**。
   */
  it('文本通路：越域档位 ⇒ 该行 failed + CONFLICT 并指名评分配置，评分器一次都没被调用', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', judgeAgentKind: 'dsh' });
    // 默认判 null 没配智能体 ⇒ 域是规范五档，medium 合法；这条用例要的是 dsh 那一份域（没有 medium）
    seedJudgeEffort('medium');

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('CONFLICT');
    expect(row?.error?.message).toContain('medium');
    expect(row?.error?.message).toMatch(/评分配置/);
    // 一次评分请求都不该花出去：档位是**调模型之前**就该拦下的配置问题
    expect(fakeJudge.calls).toHaveLength(0);
  });

  it('智能体通路：越域档位 ⇒ 该行 failed + CONFLICT，评分智能体一次都没起', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'dsh' });
    seedJudgeEffort('medium');
    fakeAgents.scripts.set('dsh', { finalText: judgeReplyJson() });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('CONFLICT');
    expect(row?.error?.message).toContain('medium');
    expect(row?.error?.message).toMatch(/评分配置/);
    // 只有候选那一次：评分那一次**没有起**（档位问题在起 CLI 之前就拦下了）
    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex']);
  });

  /**
   * 两道门**不许互相顶掉**：评分模型是悬空引用时，用户看到的必须是路由那句「供应商不存在」。
   * ⚠️ 这条**不是顺序守卫**（顺序在这条路上不可观测）：档位校验自己找模型记录用的判据与
   * `resolveJudgeRoute()` 逐字相同 ⇒ 凡是路由会抛的情形它都查不到模型、直接跳过，谁先谁后结果一样。
   * 它钉的是**归因**：两句话只能出路由那一句。
   */
  it('评分模型是悬空引用 ⇒ 报模型问题，不提档位（两道门不许互相顶掉）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', judgeAgentKind: 'dsh' });
    seedDanglingJudge();

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('供应商不存在');
    expect(row?.error?.message).not.toContain('思考强度');
    expect(fakeJudge.calls).toHaveLength(0);
  });
});
