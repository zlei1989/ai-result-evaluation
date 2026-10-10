/**
 * 智能体评分通路：把评分交给一个**在该行工作区里跑的智能体会话**，而不是一次文本请求。
 *
 * 为什么需要它（spec §1 第 1 条）：纯文本通路要把「评分标准项表格 + diff」一次性塞进一次
 * 请求。改动超过上下文窗口时只有两条路——请求失败，或按 `diffBudgetBytes` 裁掉一部分文件。后者更危险：
 * **分数照样出得来，只是在残缺输入上得出**，与正常分数在界面上一模一样。
 * 智能体通路的解法是让评审者自己去仓库里看：它按文件读、按需读，输入不再是一段文本。
 *
 * 五条口径：
 *   1. **解析与收口与文本通路共用**（`parseJudgeResponse` + `finalizeScore`）：围栏剥离、缺一项即失败、
 *      总分一律按权重加总——一个字都不改。两条通路给的必须是同一把尺子；
 *   2. **只读要求写进提示词**：工作区是候选的产出，评分智能体改了它就污染「查看改动」抽屉
 *      （抽屉按需现算 diff）。要求只读之外，编排层还会做一次摘要对照（spec §7.4）；
 *   3. **失败面分两类**：适配器自己失败 → `JudgeAgentError`（带 agents 的原始归因码）；
 *      「拿到了答复但解析不了」→ `ServiceError('JUDGE_PARSE_FAILED')` + `context.raw`。
 *      **绝不把 AGENT_* 折成 ServiceError**：它们不是 contracts 的 `ErrorCode`（errors.ts 只有 11 个，
 *      `STATUS_BY_CODE` 是 `Record<ErrorCode, number>`），硬折会逼着为它编造 HTTP 状态，
 *      而且会让「超时」与「答错了」在界面上长得一样；
 *   4. **`finalText === null` 不等于空答复**：前者是这一家没回传最终消息（适配器违约），
 *      后者是它明确回了空串——两种都要失败，但文案要能区分，故判据同时覆盖两者。
 *      **「哪条消息算答复」由适配器归一**（`AgentRunResult.finalText` 的契约：主会话、已收尾、
 *      非空；没采到记 `null`），一致性套件的「最终答复口径（§2.10）」逐家钉住 ⇒ 本层不需要知道
 *      任何一家的采集点在哪，也不要在这里记各家的实现差异；
 *   5. **`ok` 判定先于读答复**：适配器的契约是「`ok:false` 时 `finalText` 不保证是模型答复」
 *      （某一家可能在自己的错误分支之前就采过一段文本，那里躺着的是厂商的错误文本）⇒
 *      先读就会把「没问到」当成「答错了」。这是本层的**顺序契约**，与具体哪一家无关。
 *      同理，`finalText` 只保证「采到过一段可读文本」，不保证是最后一条消息——这里只做
 *      「能不能解析成评分」的判断，不假设它的新鲜度。
 */
import {
  JUDGE_OUTPUT_CONTRACT,
  ServiceError,
  renderRubricForJudge,
  type AgentEvent,
  type AgentKind,
  type AgentMessage,
  type Rubric,
  type ScoreResult,
  type SubagentRecord,
} from '@aieval/contracts';
import { getProvider, type AgentErrorCode, type AgentRunResult } from '@aieval/agents';
import { finalizeScore, parseJudgeResponse, reason, truncateRaw } from './judge';
import type { TextRoute } from './text-api';

/** 转发进该行事件日志时的前缀：日志抽屉里必须能区分候选的输出与评审者的输出 */
const AGENT_LOG_PREFIX = '[评分智能体] ';

/**
 * 评分智能体**自身**的停止 / 失败：不是契约的 `ErrorCode`，故不能折成 `ServiceError`。
 * 携带 agents 的原始归因码（`AgentErrorCode`），由编排层翻译成行的终态：
 * `AGENT_CANCELED` → canceled、`AGENT_TIMED_OUT` → timed-out、其余 → failed。
 */
export class JudgeAgentError extends Error {
  readonly agentCode: AgentErrorCode;

  constructor(agentCode: AgentErrorCode, message: string) {
    super(message);
    this.name = 'JudgeAgentError';
    this.agentCode = agentCode;
  }
}

export interface AgentJudgeInput {
  /** 评分智能体（来自 `settings.defaultJudgeAgent`，由 `requireJudgeAgent` 校验过协议） */
  kind: AgentKind;
  /** 该行工作区（候选改完的状态）—— 评分智能体的 cwd */
  cwd: string;
  /** 评分智能体自己的独立配置目录（`.judgehome`，见 core 的 `rowJudgeHomeDir`） */
  configHome: string;
  /** 复用「默认评分模型」那一对：模型与凭据都在这里 */
  route: TextRoute;
  /**
   * 「这一分是哪把尺子打的」的供应商一格。
   * 为什么不从 `route` 里取：`TextRoute` 里**没有** `providerId`（它只承载调用所需的四项），
   * 而 `ScoreResult.judgeProviderId` 是契约必填——调用方给的必须与文本通路那处**同一个表达式**
   * （两条通路都取 `settings.defaultJudge?.providerId ?? ''`，来自同一份配置快照），两条通路的记账才可比。
   */
  judgeProviderId: string;
  /** 让评分智能体知道拿什么当基线看改动 */
  baselineCommit: string;
  /** 这一轮用的评分表（**快照**，由编排层从 `run.rubric` 传入） */
  rubric: Rubric;
  taskPrompt: string;
  /**
   * 结构化输出：**表达「我想要」**（A1）。能不能给由适配器按自己的能力决定，
   * 骨架降级后在 `result.applied.structuredOutput` 里如实报——本模块**不做能力判断**，
   * 也不读注册表（判据只有一个来源：结果里的 `applied`）。
   */
  outputSchema?: Record<string, unknown>;
  /**
   * 这一次评分要求的思考强度（来自 `settings.defaultJudge.effort`，由调用方读配置后传进来）。
   * 与候选侧的 `AgentRunInput.effort` 同一条口径：**请求参数**，不是连接事实（`TextRoute` 上没有它）；
   * 未指定 = 这一格不存在，由该家适配器自己兜底（dsh 会落到它的缺省档，见 `DSH_DEFAULT_EFFORT`）。
   * 为什么是入参：本模块今天是纯入参的（不读配置、不碰落盘），读点只有 `resolveJudgeEffort()` 一个。
   */
  judgeEffort?: string;
  /**
   * **不再有 `timeoutMs`**（用户口径，2026-09-28「评分不限轮次和时间」）：适配器与外层兜底
   * 两处上限都删了，评审者跑到它自己收场为止，唯一的停止入口是 `signal`（用户点「终止」）。
   */
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /**
   * 评审者交出的**内容消息**（2026-10-10）。与候选阶段的 `onMessage` 同形同口径：
   * 快照落盘、增量只广播（分叉由调用方做，见 `orchestrator.ts`），只是落在**评分自己那条流**
   * （`judge-messages.jsonl`）里——执行日志那条时间轴只讲候选做了什么。
   */
  onMessage?: (message: AgentMessage) => void;
  /** 评审者自己派发的子任务行（同上，走评分那条记录流） */
  onSubagent?: (record: SubagentRecord) => void;
}

/**
 * 拼评分请求。顺序与文本通路的 `buildJudgePrompt` 对齐，但多一段「改动怎么看」——
 * 那一段正是本通路存在的理由：不让模型把改动整段打印出来，而是让它按文件读。
 * 「只读」必须显式写：工作区是候选的产出，被评审者改动之后「查看改动」抽屉显示的就不再是候选的产出。
 */
export function buildAgentJudgePrompt(input: {
  taskPrompt: string;
  rubric: Rubric;
  baselineCommit: string;
}): string {
  return [
    '你是一名资深代码评审专家。你要评的是下面这道考题的候选实现，评分依据是**工作区里的真实改动**。',
    '',
    '## 考题（候选拿到的任务）',
    input.taskPrompt,
    '',
    '## 评分标准项（逐项判定：达成给 true，未达成给 false）',
    renderRubricForJudge(input.rubric),
    '',
    '## 改动在哪、怎么看',
    `当前目录就是候选的工作区，改动相对基线 commit \`${input.baselineCommit}\`：`,
    `- 已跟踪文件的改动：\`git diff ${input.baselineCommit}\`；`,
    '- 新增但未跟踪的文件：`git status --porcelain` 里 `??` 的那些，自己按需读取；',
    '- **改动可能很大，不要试图把它整段打印出来**：按文件读、按需读，先看文件清单再决定读哪些。',
    '',
    '## 硬性要求',
    '1. **只读评审**：不要修改、创建、删除工作区里的任何文件，也不要执行会写文件的命令',
    '   （格式化、安装依赖、跑测试、改配置都不行）。你的产出只有下面这个 JSON。',
    '2. 只依据你在工作区里**真实看到**的代码打分；看不到的部分不要臆测。',
    '3. 把最终答复**作为你最后一条消息的正文**直接给出，不要写进任何文件。',
    '',
    JUDGE_OUTPUT_CONTRACT,
  ].join('\n');
}

/**
 * 给日志事件加前缀——**只加在 `text` 上**（抽屉读的是它）。
 *
 * 摘要**不戴前缀**（用户口径 2026-09-29：「我从『评分中』tag 可以了解阶段」）：卡片底部那一行
 * 显示的是 `summary`，行上本来就有阶段 tag，再戴一遍前缀纯属噪声。于是摘要是**事件自己那句话**：
 * 源事件有摘要就透传，没有就用它自己的文本（`event.summary ?? event.text`，同样是原文）；
 * 这样**卡片上永远不会出现转发前缀**，而机器负载的形状不受影响——消费方的判据只认内容
 *（`[评分智能体] {"method":…}` 与裸 JSON 都不当消息）。
 *
 * 抽屉那一条（`text`）继续戴前缀：它是一条**连续时间线**，往回滚时只有前缀能分清哪几行是评委说的
 * ——行上的 tag 只说「此刻」是什么阶段，说不出历史里某一行是谁说的。
 */
function prefixEvent(event: AgentEvent): AgentEvent {
  if (event.type !== 'log') return event;
  return { ...event, text: `${AGENT_LOG_PREFIX}${event.text}`, summary: event.summary ?? event.text };
}

/**
 * 跑一次智能体评分：启动适配器 → 取最终答复 → 解析 → 收口。
 * 已中止的 signal 也要走一次 `run()`：适配器自己知道「进入即已中止」该怎么收场
 * （`turn.ts` 的对应分支会给 canceled 且不建任何运行时），在这里另写一份判断只会造出第二条真相。
 */
export async function judgeRowByAgent(input: AgentJudgeInput): Promise<ScoreResult> {
  const provider = getProvider(input.kind);
  const prompt = buildAgentJudgePrompt({
    taskPrompt: input.taskPrompt,
    rubric: input.rubric,
    baselineCommit: input.baselineCommit,
  });

  let result: AgentRunResult;
  try {
    result = await provider.run({
      cwd: input.cwd,
      configHome: input.configHome,
      // 评分阶段给**只读档**（见 agents 的 `AgentPermission`）：工作区是候选的产出，
      // 评审者改了它就污染「查看改动」抽屉。提示词里那句「只读评审」是**要求**，这一格是**执行层**的
      // 强制——两者缺一：只有提示词时，一个不守规矩的评审者照样能改；只有这一格时，
      // 它会把「被拒的写操作」当成环境故障，而不是自己的越界。
      permission: 'read-only',
      // 按需带：`undefined` / `null` 时适配器一个字段都不加（三家各自的守卫见 spec §5）。
      // 用条件展开而不是 `outputSchema: input.outputSchema`，是为了不给下游一个「键存在、值是
      // undefined」的格：条件展开之下「没给」在选项对象上就是**没有这个键**。这是写法上的事实，
      // 不是迁就某个消费者——仓内三家适配器都按值分支、夹具也无条件记录值，没有谁在读键的存在性。
      ...(input.outputSchema != null ? { outputSchema: input.outputSchema } : {}),
      // 强度按需带（未给 = 这一格不存在，与候选执行同一条口径）：三家的 wire 翻译各自负责。
      // 写法与理由都与上面那一格相同，不再重复一遍
      ...(input.judgeEffort === undefined ? {} : { effort: input.judgeEffort }),
      prompt,
      route: input.route,
      signal: input.signal,
      onEvent: (event) => {
        input.onEvent(prefixEvent(event));
      },
      /**
       * 内容消息与子任务行原样转出（**不加前缀**）：事件那层的前缀是因为评分与候选的 log 挤在同一条
       * 行级流里，靠 `[评分智能体]` 才能分辨来源；消息与子任务行落在**文件层面就分开**条流里，
       * 再加一个标签只是给每一行都镶一遍同样的字。
       * 可缺（老调用方 / 夹具不传）：与 `onMessage` 在 `AgentRunInput` 里同一条口径——不传就是不消费。
       */
      ...(input.onMessage === undefined ? {} : { onMessage: input.onMessage }),
      ...(input.onSubagent === undefined ? {} : { onSubagent: input.onSubagent }),
    });
  } catch (error) {
    // 契约说 run() 返回 ok:false、**绝不抛**（见 `turn.ts`）；违约也必须归因到**适配器**而不是我们：
    // 上抛会被 `runRow` 折成 `INTERNAL`（`EvalRow.error.code = INTERNAL`），而候选阶段的同形违约
    // 走的是 `classifyStop` 的 agentError 分支（归因码取自适配器）——两条通路的归因口径必须一致。
    // 两种形状分开：抛在 abort 之后 ⇒ 记为「被停止」，让编排层按用户终止收尾
    //（2026-09-28 起评分阶段**只有**用户终止这一条停止通路：两处超时都已删除；
    // 这里也判不了别的，signal 不带原因）；其余 ⇒ AGENT_FAILED，指向适配器。
    // 可达性低（`turn.ts` 明写不抛），故这一条是**纵深防御**：守卫见 judge-agent.test.ts。
    if (input.signal.aborted) {
      throw new JudgeAgentError('AGENT_CANCELED', `评分智能体已被停止（适配器在停止过程中抛了异常）：${reason(error)}`);
    }
    throw new JudgeAgentError('AGENT_FAILED', `评分智能体执行失败（适配器违约抛了异常）：${reason(error)}`);
  }

  // 先判运行结论，再读答复：顺序不能换。claude-code 的采集点在 `is_error` 分支之前，出错时
  // `finalText` 里是厂商的错误文本——先读就会把一次「没问到」当成一次成功的评分（且状态是成功）。
  if (!result.ok) {
    // 适配器违约（ok:false 却不给 error）也要给出可读归因，不能让界面显示空白原因
    const code = result.error?.code ?? 'AGENT_FAILED';
    const message = result.error?.message ?? '评分智能体执行失败（适配器未给出原因）';
    throw new JudgeAgentError(code, message);
  }

  const raw = result.finalText;
  // 「没采到」与「空答复」都要失败，但成因不同、处置不同（换一家 / 补评分项），故文案必须分开。
  // 判据同时覆盖 null 与空串：三条通路都不该写空串（见各家 `project` 的守卫），但 `raw === null`
  // 一条判据挡不住「适配器交了个空答复」这种违约形状，而 `!raw` 又会把两种成因混成一句话。
  // trim 是因为只有空白字符的答复同样不可解析。
  if (raw === null || raw.trim() === '') {
    throw new ServiceError(
      'JUDGE_PARSE_FAILED',
      // 两种成因文案必须能分开：null 是适配器没回传，空串是它回了个空答复
      raw === null
        ? '评分智能体没有给出可读的最终答复（该适配器未回传最终消息）：请确认它能在最后一条消息里输出 JSON'
        : '评分智能体返回了空答复：请检查这个用例的评分标准项，或在设置页换一家评分智能体',
      { context: { kind: input.kind, modelId: input.route.modelId, finalText: raw } },
    );
  }

  let parsed: ReturnType<typeof parseJudgeResponse>;
  try {
    parsed = parseJudgeResponse(raw, input.rubric);
  } catch (error) {
    // 与文本通路同一个折错助手（`judge.ts` 的 `reason`）：`ServiceError` 也走 `Error.message`，
    // 所以这里只需要「是 Error 就取 message」这一条判据（原先多写一档 `instanceof ServiceError` 是死分支）
    const detail = reason(error);
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分解析失败：${detail}`, {
      context: { raw: truncateRaw(raw) },
      cause: error,
    });
  }

  return finalizeScore({
    parsed,
    rubric: input.rubric,
    raw,
    judgeProviderId: input.judgeProviderId,
    judgeModelId: input.route.modelId,
    judgeAgentKind: input.kind,
    // 记账口径与上面那一格同源（两条通路各自表一次态）：记**调用方要求的**强度，
    // 不记「适配器实际跑在哪个档」——三家对「未指定」的处置不同（dsh 落到自己的 `high`、
    // claude / codex 由厂商推断），这类差异无法在结果里如实表达，`null` 只说明我们没要求。
    judgeEffort: input.judgeEffort ?? null,
    // 记账口径（A1）：记**骨架算的** `applied`，不记「我们传没传 schema」。调用方现在总是传
    // （表达「我想要」），能不能给由 `runTurn` 按 `hooks.capability.structuredOutput` 决定
    // （`result.applied.structuredOutput` 就是那个结论，同一个式子在骨架里只算一次），这里原样透传，
    // 于是「声称被 schema 约束」与「实际被约束」不再可能分叉；本模块也因此不读注册表、不做能力判断。
    structuredOutput: result.applied.structuredOutput,
    // 评分**自己**的花销（2026-10-08，用户口径）：与候选行的 `EvalRow.tokens` / `durationMs`
    // 同一份原料（适配器自报值），故两者可以直接对着看。`result.tokens` 为 `null` 时原样记 null
    // ——「这家不报用量」与「一个 token 都没花」是两句相反的话，不许互相兜底。
    judgeTokens: result.tokens,
    judgeDurationMs: result.durationMs,
  });
}
