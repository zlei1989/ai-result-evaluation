// @vitest-environment node
/**
 * 智能体评分通路：拼词、日志前缀、失败面。
 * 适配器被 mock 成 `fakeAgentsModule()`（`testing/fixtures.ts`），它的行为由 `fakeAgents.scripts` 驱动。
 * 注意 `vi.mock` 的工厂**会被提升**：里面不能引用顶层的 import，只能动态 import（与 orchestrator.test.ts 同形）。
 *
 * 本节守卫的三条口径（每一条都对应一个会静默出错的写法）：
 *   1. 四条提示词要素与输出契约必须逐字在提示词里——少一条，智能体就会凭猜打分；
 *   2. 「没采到最终答复」与「空答复」是两回事，文案必须分得开（`null` 判据不能简化成 falsy）；
 *   3. 适配器失败（`ok:false`）必须**先于**读 `finalText` 判掉：claude-code 的采集点在 `is_error`
 *      分支之前，出错时 `finalText` 里是**厂商的错误文本**，先读它会把「没问到」当「答错了」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JUDGE_OUTPUT_CONTRACT, ServiceError, type AgentEvent, type Rubric } from '@aieval/contracts';
import { fakeAgents, resetFakeAgents } from './testing/fixtures';
import { JudgeAgentError, buildAgentJudgePrompt, judgeRowByAgent, type AgentJudgeInput } from './judge-agent';

vi.mock('@aieval/agents', async () => {
  const { fakeAgentsModule } = await import('./testing/fixtures');
  return fakeAgentsModule();
});

const ROUTE = { protocolType: 'openai' as const, baseUrl: 'https://fake.invalid/v1', apiKey: 'k', modelId: 'm1' };

/** 评分表夹具：两项，满分 30 */
const RUBRIC: Rubric = {
  groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }, { id: 'A2', goal: '补 Javadoc', weight: 10 }] }],
};

/** 一份合法的评分 JSON 答复（判定形状由评分表推出来，不手抄引用键） */
function judgeReplyJson(achieved = true): string {
  return JSON.stringify({
    judgments: RUBRIC.groups[0]!.items.map((item) => ({
      id: item.id,
      achieved,
      reason: `${item.goal}：假评分智能体给 ${achieved ? '达成' : '未达成'}`,
    })),
    verdict: '假评分智能体的总评',
  });
}

/**
 * 一次最小调用；`finalText` 由各用例通过 `fakeAgents.scripts` 设定；`signal` 只在测「已停止」时传。
 * `overrides` 让「某一格入参不同会怎样」不必手抄整个 `AgentJudgeInput`（当前用于 `outputSchema`）。
 */
function callJudge(
  signal: AbortSignal = new AbortController().signal,
  overrides: Partial<AgentJudgeInput> = {},
): ReturnType<typeof judgeRowByAgent> {
  return judgeRowByAgent({
    kind: 'codex',
    cwd: process.cwd(),
    configHome: process.cwd(),
    route: ROUTE,
    judgeProviderId: 'judge-provider',
    baselineCommit: 'a'.repeat(40),
    rubric: RUBRIC,
    taskPrompt: '把 README 改成中文',
    signal,
    onEvent: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  resetFakeAgents();
});

describe('judgeRowByAgent', () => {
  it('提示词带上基线 commit、只读要求与输出契约（本通路存在的理由都在这几行里）', () => {
    const prompt = buildAgentJudgePrompt({
      taskPrompt: '把 README 改成中文',
      rubric: RUBRIC,
      baselineCommit: 'a'.repeat(40),
    });
    // ① 基线：不说基线，智能体就不知道该跟什么比
    expect(prompt).toContain('a'.repeat(40));
    // ② 按需读、不要整段打印 —— 这正是本通路能处理大 diff 的原因
    expect(prompt).toContain('不要试图把它整段打印出来');
    // ③ 只读要求：工作区是候选的产出（spec §7.4 的处置）
    expect(prompt).toContain('只读评审');
    // ④ 输出契约与文本通路**逐字同一份**（单一真源；抄一份必然漂移）
    expect(prompt).toContain(JUDGE_OUTPUT_CONTRACT);
    // ⑤ 题面与**评分表**（组名 / 引用键 / 满分）都要在：判据换成了按表逐项取，
    //    提示词里少一段，评审者就只能凭猜打分——而猜出来的分与文本通路不可比
    expect(prompt).toContain('把 README 改成中文');
    expect(prompt).toContain(RUBRIC.groups[0]!.name);
    expect(prompt).toContain('A1');
    expect(prompt).toContain('满分 30 分');
  });

  it('finalText 是合法评分 JSON 时出分，judgeAgentKind 记为实际 kind', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: judgeReplyJson() });
    const score = await callJudge();
    expect(score.judgeAgentKind).toBe('codex');
    // 满分 30（20 + 10）、全部达成 ⇒ 30：与文本通路同一把尺子（总分按权重加总，不是旧体系的百分制）
    expect(score.totalScore).toBe(30);
    expect(score.maxScore).toBe(30);
    // 「哪把尺子打的」必须原样记账：这里有值，文本通路的同一格是 null（同一份契约、两条通路）
    expect(score.judgeProviderId).toBe('judge-provider');
    expect(score.judgeModelId).toBe('m1');
    // 提示词**真的送到了**适配器手里：本通路存在的理由（基线、按需读、只读）全在这份文本里，
    // 而「拼得出来」与「拼出来的那一份被传进 run()」是两件事——后者此前没有任何守卫。
    // 逐字相等顺带钉住题面与评分表没有串位（传反了这条立刻红）。
    expect(fakeAgents.calls[0]?.prompt).toBe(
      buildAgentJudgePrompt({
        taskPrompt: '把 README 改成中文',
        rubric: RUBRIC,
        baselineCommit: 'a'.repeat(40),
      }),
    );
    expect(fakeAgents.calls[0]?.prompt).toContain('a'.repeat(40));
    expect(fakeAgents.calls[0]?.prompt).toContain('只读评审');
  });

  /**
   * 思考强度（spec §1.3：评分强度**可配**，跨轮次可比改由记账保证）。它与窗口那两格**不同类**：
   * 强度是**请求参数**（走 `judgeEffort` 入参），不是连接事实（route 上没有这一格）。
   * 为什么正反两条都要：只钉「给了会透」看不出「没给会不会凭空塞一个缺省档」（那会让「未指定」
   * 在适配器眼里变成一次显式要求）；只钉「没给是 undefined」则看不出这一格根本没接线。
   * 记账那两格同理：`null` 与档名都是合法值，留一个 `null` 占位不会被任何别的断言发现。
   */
  it('给了 judgeEffort ⇒ 原样透给适配器的 effort，并记进 ScoreResult', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: judgeReplyJson() });
    const score = await callJudge(undefined, { judgeEffort: 'max' });
    expect(fakeAgents.calls[0]?.effort).toBe('max');
    expect(score.judgeEffort).toBe('max');
  });

  it('没给 judgeEffort ⇒ 透给适配器的 effort 是 undefined（未指定，不是关闭），记账为 null', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: judgeReplyJson() });
    const score = await callJudge();
    // 判据是**值**而不是「键在不在」：夹具无条件记下这一格（`FakeAgentCall.effort`），
    // 而仓内三家适配器都按值分支——「键不存在」这条形状今天没有消费者，也就没有可观测后果
    expect(fakeAgents.calls[0]?.effort).toBeUndefined();
    expect(score.judgeEffort).toBeNull();
  });

  /**
   * 评分自己的用量与耗时（2026-10-08，用户口径：评分详情里那一段说的是**评分的花销**，
   * 不是被评那一行的执行花销）。这条通路的两格**取适配器自报值**——与候选行 `EvalRow.tokens` /
   * `durationMs` 同一份原料，故两者可以直接对着看。
   * 耗时用夹具的 `durationMs` 钉一个具体数字：不钉的话「取自报值」「写死 0」「取我们的掐表」
   * 在假适配器那几毫秒的墙钟面前没有区别。
   */
  it('适配器自报的用量与耗时进 ScoreResult', async () => {
    fakeAgents.scripts.set('codex', {
      mode: 'ok',
      finalText: judgeReplyJson(),
      tokens: { input: 111, cached: 222, output: 33 },
      durationMs: 8_500,
    });
    const score = await callJudge();
    expect(score.judgeTokens).toEqual({ input: 111, cached: 222, output: 33 });
    expect(score.judgeDurationMs).toBe(8_500);
  });

  it('适配器没采到用量 ⇒ judgeTokens 为 null（绝不填 0）', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: judgeReplyJson(), tokens: null });
    expect((await callJudge()).judgeTokens).toBeNull();
  });

  it('finalText 为 null → JUDGE_PARSE_FAILED（该家没回传最终消息）', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: null });
    await expect(callJudge()).rejects.toThrowError(/没有给出可读的最终答复/);
  });

  it('答复是散文 → JUDGE_PARSE_FAILED，并把原文留在 context.raw', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: '我觉得这个改动还不错' });
    await expect(callJudge()).rejects.toMatchObject({
      code: 'JUDGE_PARSE_FAILED',
      context: { raw: '我觉得这个改动还不错' },
    });
  });

  it('适配器自报失败 → JudgeAgentError（不是 ServiceError：AGENT_* 不是契约的错误码）', async () => {
    fakeAgents.scripts.set('codex', { mode: 'error' });
    await expect(callJudge()).rejects.toBeInstanceOf(JudgeAgentError);
    await expect(callJudge()).rejects.toMatchObject({ agentCode: 'AGENT_FAILED' });
  });

  it('失败时即使适配器给了最终答复也先按失败处置（claude-code 会把厂商错误文本写进 finalText）', async () => {
    // 契约违例的复现：ok:false 却带着一段**看起来可解析**的答复。若把 finalText 的判据放在 ok 之前，
    // 这一行会拿到一个「厂商错误文本被当成评分」的结果，而状态是成功。
    fakeAgents.scripts.set('codex', { mode: 'error', finalText: judgeReplyJson() });
    const error = await callJudge().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JudgeAgentError);
    expect((error as JudgeAgentError).agentCode).toBe('AGENT_FAILED');
  });

  it('适配器违约（ok:false 且不给 error）也要有可读归因，不能是空白原因', async () => {
    fakeAgents.scripts.set('codex', { mode: 'error', omitError: true });
    const error = await callJudge().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JudgeAgentError);
    expect((error as JudgeAgentError).agentCode).toBe('AGENT_FAILED');
    expect((error as Error).message).toMatch(/适配器未给出原因/);
  });

  it('AUTH_FAILED / RATE_LIMITED 原样带出（不折成解析失败——「没问到」与「答错了」是两回事）', async () => {
    // 走**真实**路径：夹具按脚本给出上游归因码，断言的是 judgeRowByAgent 的透传，而不是构造函数的赋值
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AUTH_FAILED' });
    const auth = await callJudge().catch((caught: unknown) => caught);
    expect(auth).toBeInstanceOf(JudgeAgentError);
    expect((auth as JudgeAgentError).agentCode).toBe('AUTH_FAILED');
    // 「没问到」不能长得像「答错了」：它不是契约的 ServiceError（那会把归因折进 ErrorCode 空间）
    expect(auth).not.toBeInstanceOf(ServiceError);

    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'RATE_LIMITED' });
    const rateLimited = await callJudge().catch((caught: unknown) => caught);
    expect(rateLimited).toBeInstanceOf(JudgeAgentError);
    expect((rateLimited as JudgeAgentError).agentCode).toBe('RATE_LIMITED');
  });

  it('评分通路把只读档交给适配器（提示词里的「只读评审」只是要求，这一格才是执行层的强制）', async () => {
    /**
     * 为什么单开一条：`buildAgentJudgePrompt` 里那句「只读评审」与这里的 `permission: 'read-only'`
     * 是**两条缺一不可**的：只有提示词时，一个不守规矩的评审者照样能改工作区；只有这一格时，
     * 它会把「写被拒」当成环境故障。而两者都写错（或都漏）时，全套用例照样绿——分数照出，
     * 只是「查看改动」抽屉显示的不再是候选的产出（编排层的摘要对照会 WARN，那是事后发现，不是拦截）。
     */
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: judgeReplyJson() });
    await callJudge();
    expect(fakeAgents.calls).toHaveLength(1);
    expect(fakeAgents.calls[0]?.permission).toBe('read-only');
  });

  it('带 outputSchema ⇒ 原样传给适配器；codex 报回 applied=true ⇒ 记 structuredOutput=true', async () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
    fakeAgents.scripts.set('codex', { finalText: judgeReplyJson() });

    const score = await callJudge(new AbortController().signal, { outputSchema: schema });

    // ① 转发：本模块只转发、不做能力判断（能不能给由适配器按自己的能力决定，A1），故给什么就传什么
    expect(fakeAgents.calls[0]?.outputSchema).toEqual(schema);
    // ② 记账：这一格是「这一分是不是在 schema 约束下拿到的」的唯一落点，判据取自**结果里的 `applied`**。
    // 没有它，`finalizeScore` 里写死 `false` 也能让全套用例全绿（false 是合法 boolean，类型检查看不见）。
    expect(score.structuredOutput).toBe(true);
  });

  /**
   * 「适配器说没落到实处」与「我们传没传 schema」是两件事（A1）。夹具的 `applied` 是**照它自己的
   * `metadata.capability.structuredOutput` 现算的**（Task 1 的产物，见 `testing/fixtures.ts`），
   * 所以降级只能用一家能力为 false 的 kind（dsh）来造。这一条正是新判据的鉴别器：**我们确实传了
   * schema，而分数必须记 false**——旧的「入参里有没有这一格」在这条用例面前恒 true。
   */
  it('适配器降级 ⇒ ScoreResult.structuredOutput 记 false（判据是 applied，不是「我们传没传」）', async () => {
    const schema = { type: 'object' };
    fakeAgents.scripts.set('dsh', { finalText: judgeReplyJson() });

    const score = await callJudge(new AbortController().signal, { kind: 'dsh', outputSchema: schema });

    expect(score.structuredOutput).toBe(false);
    // 前提：我们**确实**表达了「想要 schema」（否则这条用例测的是另一件事）
    expect(fakeAgents.calls[0]?.outputSchema).toEqual(schema);
  });

  it('不带 outputSchema ⇒ 不传该格；applied=false ⇒ 记 structuredOutput=false', async () => {
    fakeAgents.scripts.set('codex', { finalText: judgeReplyJson() });

    const score = await callJudge();

    expect(fakeAgents.calls[0]?.outputSchema).toBeUndefined();
    // 记账判据与上面同一条：结果里的 `applied`（没要 schema ⇒ 适配器如实报 false）。
    // 本模块不再按「入参里有没有这一格」自己推断——那是第二个真相，必然与 `applied` 漂移。
    expect(score.structuredOutput).toBe(false);
  });

  /**
   * 显式 `null` 与「没给」同义（R39b）：这一格的类型不含 `null`，但运行期真能传进来（mock / JSON
   * 反序列化 / 断言过的调用方），而**三家适配器都把 `null` 当「没给」**——编排层若在这里把 `null`
   * 转出去，就会出现「声称要了 schema、实际一个字段都没传出去」的自相矛盾：适配器照旧报
   * `applied=false`，而我们的入参里躺着一个被下游忽略的格。
   */
  it('outputSchema 显式为 null ⇒ 同样不传该格；applied=false ⇒ 记 structuredOutput=false（空值口径与三家适配器一致）', async () => {
    fakeAgents.scripts.set('codex', { finalText: judgeReplyJson() });

    const score = await callJudge(new AbortController().signal, {
      outputSchema: null as unknown as Record<string, unknown>,
    });

    // ① 转发：`null` 与「没给」走同一条路（夹具无条件记录这一格的值，故 false 值会露出来）
    expect(fakeAgents.calls[0]?.outputSchema).toBeUndefined();
    // ② 记账：判据是 `applied`——这一格没传出去，适配器就报 false，分数不能声称自己被 schema 约束
    expect(score.structuredOutput).toBe(false);
  });

  /**
   * 网关把 schema 那一格丢掉时的形状：模型照旧回散文。判据必须是 JUDGE_PARSE_FAILED（答错了），
   * **不是** INTERNAL（我们自己坏了）——「没问到」与「答错了」在界面上长得一样是既有 spec 明禁的。
   */
  it('模型回了散文（网关没透传 schema）⇒ 仍是 JUDGE_PARSE_FAILED，不是 INTERNAL', async () => {
    fakeAgents.scripts.set('codex', { finalText: '我觉得这个实现还不错' });

    const error = await callJudge(new AbortController().signal, { outputSchema: { type: 'object' } })
      .catch((caught: unknown) => caught);

    expect((error as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
  });

  /**
   * 摘要**不戴**前缀、`text` 戴（用户口径 2026-09-29：「删除 [评分智能体] 前缀，我从『评分中』
   * tag 可以了解阶段」）。两个方向都要钉住，各自有靶子：
   *   ① 卡片底部那一行读的是 `summary` —— 它必须是**事件自己那句话**，戴上转发前缀就是噪声；
   *   ② 没有摘要的源事件也要给出一句不带前缀的摘要（否则消费方退回读 `text`，前缀又漏到卡片上）；
   *   ③ 抽屉读的是 `text` —— 它继续戴前缀（连续时间线里只有它能分清哪几行是评委说的）。
   */
  it('日志事件的摘要不带 [评分智能体] 前缀（text 仍带，供抽屉区分）', async () => {
    const collected: AgentEvent[] = [];
    fakeAgents.scripts.set('codex', {
      mode: 'ok',
      finalText: judgeReplyJson(),
      rawEvents: [
        {
          seq: 9,
          at: '2026-09-26T00:00:00.000Z',
          type: 'log',
          stream: 'stdout',
          text: '{"method":"session.event","params":{"sessionId":"s-1"}}',
          summary: '调用工具 read：README.md',
        },
        // 源事件没有摘要（codex 的纯文本增量、stderr 的 WARN 都是这种）：摘要要退回它自己的文本
        { seq: 10, at: '2026-09-26T00:00:00.000Z', type: 'log', stream: 'stderr', text: '[WARN] 用量负载不完整' },
      ],
    });

    await judgeRowByAgent({
      kind: 'codex',
      cwd: process.cwd(),
      configHome: process.cwd(),
      route: ROUTE,
      judgeProviderId: 'p1',
      baselineCommit: 'a'.repeat(40),
      rubric: RUBRIC,
      taskPrompt: 't',
      signal: new AbortController().signal,
      onEvent: (event) => collected.push(event),
    });

    const logs = collected.filter((event) => event.type === 'log');
    expect(logs.map((event) => (event.type === 'log' ? event.summary : ''))).toEqual([
      '调用工具 read：README.md',
      '[WARN] 用量负载不完整',
    ]);
    expect(logs.map((event) => (event.type === 'log' ? event.text : ''))).toEqual([
      '[评分智能体] {"method":"session.event","params":{"sessionId":"s-1"}}',
      '[评分智能体] [WARN] 用量负载不完整',
    ]);
  });

  it('日志事件加 [评分智能体] 前缀后转发，其余类型逐字段透传（日志抽屉里能区分候选与评审者的输出）', async () => {
    const collected: AgentEvent[] = [];
    fakeAgents.scripts.set('codex', {
      mode: 'ok',
      finalText: judgeReplyJson(),
      // 夹具的 FakeAgentScript 在 finish() 之前把它们逐条投给 input.onEvent
      events: [
        { stream: 'stdout', text: '我先看看 git diff' },
        { stream: 'stderr', text: '警告：改动很大' },
      ],
      // 非 log 类型原样透传：只有 log 加前缀。usage / error 被顺手加上 text 前缀的话，
      // 前者会污染计量事件（多出一个字段），后者会把「结论」写成一条日志的样子。
      rawEvents: [
        { seq: 7, at: '2026-09-26T00:00:00.000Z', type: 'usage', tokens: { input: 1, cached: 0, output: 2 }, turns: 1 },
        { seq: 8, at: '2026-09-26T00:00:00.000Z', type: 'error', message: '适配器自己报的错' },
      ],
    });

    await judgeRowByAgent({
      kind: 'codex',
      cwd: process.cwd(),
      configHome: process.cwd(),
      route: ROUTE,
      judgeProviderId: 'p1',
      baselineCommit: 'a'.repeat(40),
      rubric: RUBRIC,
      taskPrompt: 't',
      signal: new AbortController().signal,
      onEvent: (event) => collected.push(event),
    });

    const logs = collected.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs).toEqual(['[评分智能体] 我先看看 git diff', '[评分智能体] 警告：改动很大']);
    // 逐字段相等（不是「包含」）：多加一个 text 字段就会被这条抓住
    expect(collected.find((event) => event.type === 'usage')).toEqual({
      seq: 7,
      at: '2026-09-26T00:00:00.000Z',
      type: 'usage',
      tokens: { input: 1, cached: 0, output: 2 },
      turns: 1,
    });
    expect(collected.find((event) => event.type === 'error')).toEqual({
      seq: 8,
      at: '2026-09-26T00:00:00.000Z',
      type: 'error',
      message: '适配器自己报的错',
    });
  });

  it('空答复（finalText 是空串）与「没采到」（null）的文案必须能区分', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: '' });
    await expect(callJudge()).rejects.toThrowError(/返回了空答复/);

    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: null });
    await expect(callJudge()).rejects.toThrowError(/没有给出可读的最终答复/);
  });

  /**
   * 适配器**违约抛异常**（`turn.ts` 明写 run() 不抛，故这是纵深防御，终审 ADD-3）。
   *
   * 为什么必须折成 `JudgeAgentError`：上抛会被 `runRow` 折成 `INTERNAL`
   * （`EvalRow.error.code = INTERNAL`），也就是把「适配器违约」记到我们自己头上；
   * 而候选阶段的同形违约走 `classifyStop` 的 agentError 分支、归因码取自适配器——
   * 两条通路的归因口径必须一致。第二条用例覆盖 abort 之后抛的那一半：
   * 那种形状交给编排层记账去区分「用户终止」（signal 不带原因，这里判不了）。
   */
  it('适配器违约直接抛异常 → 归因到适配器（AGENT_FAILED），不折成 INTERNAL', async () => {
    fakeAgents.scripts.set('codex', { mode: 'throw' });

    const caught = await callJudge().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(JudgeAgentError);
    expect((caught as JudgeAgentError).agentCode).toBe('AGENT_FAILED');
    // 适配器抛出的原文进 message（中文归因 + 原文），因为它是**我们自己**要与适配器作者对话的内容
    expect((caught as Error).message).toContain('假适配器：run() 直接抛了异常');
  });

  it('适配器在「已停止」之后抛异常 → 记为被停止（AGENT_CANCELED），不由本层判成失败', async () => {
    fakeAgents.scripts.set('codex', { mode: 'throw' });
    const controller = new AbortController();
    controller.abort();

    const caught = await callJudge(controller.signal).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(JudgeAgentError);
    expect((caught as JudgeAgentError).agentCode).toBe('AGENT_CANCELED');
  });

  /**
   * 评分这一轮的 route 也带上模型声明的窗口（spec §4.2 / D1）。
   * 为什么值得单独钉：候选行那条路由由编排层组装，而评分这条由 `resolveJudgeRoute()` 组装后
   * **原样**交给适配器 —— 少传一格的后果是**静默**的（评分照样出分，只是 cc 不加 `[1m]`、
   * codex 不写 `model_context_window`），界面上一个字都看不出来。
   * 强度**不在**这条路由上（spec §5.3）：它是**请求参数**，走 `judgeEffort` 入参——
   * 与候选侧 `AgentRunInput.effort` 同一条口径（`TextRoute` 只承载连接事实）。
   * 给了强度的那一路见上面「给了 judgeEffort ⇒ 原样透给适配器」。
   * ⚠️ 真正拦住「route 长出一格强度」的是 `judge-route.test.ts` 里那两条 `toEqual`（route **逐格**相等）
   * ——`FakeAgentCall` 只记 route 派生出来的值、手里没有 route 对象，故本用例名不能宣称它钉住了
   * route 的形状（原名「强度…不在 route 上」就是名不副实：它唯一的强度断言在**入参**那一格上）。
   */
  it('评分路由里的窗口与输出上限到达适配器输入；这一次没给强度 ⇒ 入参这一格没有值', async () => {
    fakeAgents.scripts.set('codex', { finalText: judgeReplyJson() });

    await callJudge(new AbortController().signal, {
      route: { ...ROUTE, contextWindow: 1_048_576, maxOutputTokens: 131_072 },
    });

    expect(fakeAgents.calls[0]?.contextWindow).toBe(1_048_576);
    expect(fakeAgents.calls[0]?.maxOutputTokens).toBe(131_072);
    // 这一次没给 judgeEffort ⇒ 这一格没有值；route 上则**压根没有**强度这一格（上面那三条注释是判据）
    expect(fakeAgents.calls[0]?.effort).toBeUndefined();
  });
});
