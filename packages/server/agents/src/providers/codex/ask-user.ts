/**
 * codex 的提问接线：厂商那条服务端请求（`item/tool/requestUserInput`）→ 提问端口 → 该家的应答帧。
 *
 * 为什么单列成模块：字段名、配对键、空答案这三件事都只能按厂商 schema 逐字办（`app-server
 * generate-json-schema --experimental`），散在 `client.ts` / `session.ts` / `index.ts` 三处必然漂移，
 * 而漂移的表现是「问出去了没人答得上」——静默的。落点选在这里还因为它是**纯变换**：入参是原始
 * params 与一个提问端口，出参是应答帧，不碰进程、不碰时钟 ⇒ 可以脱开厂商夹具单测。
 *
 * 三条逐字事实（都不是猜的）：
 *   · **答案按题目 id 配对**：`{answers: {<question.id>: {answers: string[]}}}`，不是按序号、也不是
 *     按标题。厂商的键集合是 `autoResolutionMs/isBlocking/itemId/questions/threadId/turnId`；
 *   · **没有答案就回空表** `{answers: {}}`：这是厂商原生的「无答案」语义（模型据此继续按最佳判断
 *     干活）。**不回帧则更硬**——`isBlocking: false` 与 `autoResolutionMs: null` 都不让它自己收场，
 *     它会一直等那一帧 ⇒ 「没人答 / 等超时 / 本次运行终止」三条收场都必须回一帧空的；
 *   · **审批类请求仍然只归类不回帧**：本仓评测是非交互的（`approvalPolicy: never`），
 *     回帧等于替用户批准。分界线就是这里的 `method` 判据，别放宽成「带 id 的都回」。
 *
 * ⚠️ **厂商自己到点收场 ⇒ `auto-resolved` 这条映射在本家不成立**（不猜、也不假装）：
 * `autoResolutionMs` 在 0.156.1 已 `@deprecated`，实测下发值恒为 `null`，而 `isBlocking: false`
 * 同样不让厂商收场——它只会一直等我们那一帧。因此这一问的每一个 `outcome`（含我们自己的等待预算
 * 到点落的那一档）都由**我们**给帧，没有一条路径能落「厂商自动决议」。收束通知
 * `serverRequest/resolved` 是「这一帧被收下了」的回执，不是厂商自己收场的判据。
 */
import { createLogger } from '@aieval/core';
import type { AskUserQuestion } from '@aieval/contracts';
import type { AskUserPort } from '../../ask-user';
import type { AskUserReply } from '../../types';

const logger = createLogger('agents/codex/ask-user');

/** 厂商下发的提问请求方法名（`ServerRequest` 的成员之一） */
export const CODEX_ASK_METHOD = 'item/tool/requestUserInput';

/** 模型实际调的那件工具名：`AskUserRequest.toolName` 要报出厂商原文 */
export const CODEX_ASK_TOOL_NAME = 'request_user_input';

/**
 * 厂商的一题（本模块要读的那几格）。
 *
 * 两个配对键各有各的用处，都在这一格里：`id` 是**回帧**的键（`{answers: {<id>: {answers: []}}}`），
 * `header` 是**本仓契约**的键（`AskUserAnswer.header`，卡片与答复回填都按它配）。
 */
export interface CodexAskQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label?: string; description?: string | null }> | null;
  isOther?: boolean;
  isSecret?: boolean;
}

/**
 * 厂商的提问参数（只声明本模块要读的字段，不引厂商类型）。
 *
 * `autoResolutionMs` 只是**读出来交给端口当厂商预算**：今天它恒为 `null`，正数才是「厂商自己会
 * 到点收场」那一档（那一档若真的出现，收场依据是收束通知，不是这个数）。
 */
export interface CodexAskParams {
  itemId: string;
  threadId: string;
  isBlocking: boolean;
  autoResolutionMs?: number | null;
  questions: CodexAskQuestion[];
}

/** 面向上层的一句判断：这条服务端请求是不是提问 */
export function isCodexAskRequest(method: string): boolean {
  return method === CODEX_ASK_METHOD;
}

/** 把入参收窄成厂商的提问形状（**不做字段级校验**：缺格由下面各自的兜底承担，不猜语义） */
export function asCodexAskParams(params: unknown): CodexAskParams | null {
  if (typeof params !== 'object' || params === null) return null;
  const record = params as Record<string, unknown>;
  if (typeof record['itemId'] !== 'string' || !Array.isArray(record['questions'])) return null;
  return record as unknown as CodexAskParams;
}

/**
 * 厂商的问题项 → 契约的问题形状。字段名逐字映过来（`question` → `prompt`、`isOther` → `allowOther`、
 * `isSecret` → `secret`）；**厂商没有的两格如实落 `false`**——「哪一项推荐」与「能不能多选」都不在
 * 这一家的线上，编个默认值会让族载荷与判据一起说谎。
 */
export function codexQuestionsOf(params: CodexAskParams): AskUserQuestion[] {
  return params.questions.map((question) => ({
    header: question.header,
    prompt: question.question,
    options: (question.options ?? []).map((option) => ({
      label: option.label ?? '',
      description: option.description ?? null,
      recommended: false,
    })),
    multiSelect: false,
    allowOther: question.isOther === true,
    secret: question.isSecret === true,
  }));
}

/**
 * 答复 → 该家的应答帧。
 *
 * 两种形状：`answers === null`（无人应答 / 等超时 / 随行取消）⇒ **整张空表**；否则按题目 id 逐题填，
 * 某一题没人选时那一格是**空数组**——「问了但没人选」与「没有人答」是两件事，合成一个就再也分不开。
 * 标签与自由输入**都进 `answers` 数组**：厂商那一侧只有一个字符串数组，没有「自由输入」这个维度。
 * ⚠️ **边界：多选的「选项 + 自由输入并存」在这一家分不开**——两者进同一个数组后，模型看到的就是
 * 一串平铺的字符串，分不出哪几条是选中的标签、哪一条是用户自己写的。这是厂商形状的结构边界，
 * 不另造一个厂商读不懂的字段：两半都保留（信息不丢），只是区分度比另三家低。
 */
export function codexAnswerFrameOf(
  reply: AskUserReply,
  questions: readonly AskUserQuestion[],
  ids: readonly string[],
): unknown {
  if (reply.answers === null) return { answers: {} };
  const answers: Record<string, { answers: string[] }> = {};
  for (const [index, question] of questions.entries()) {
    const id = ids[index] ?? '';
    const answer = reply.answers.find((one) => one.header === question.header);
    answers[id] = {
      answers: answer === undefined ? [] : [...answer.selected, ...(answer.custom === null ? [] : [answer.custom])],
    };
  }
  return { answers };
}

export interface CodexAskResponderOptions {
  port: AskUserPort;
  /**
   * 本次运行的主线程 id（**取值函数**：这个 id 要等 `thread/start` 才落定，而客户端在它之前就建好了）。
   * 厂商侧对子线程发起的调用有它自己的门禁（`request_user_input can only be used by the root thread`）
   * ⇒ `threadId` 不是主线程时这一问按「子智能体不能向用户提问」收场：不调端口（它会把这一问登记成
   * 人正在答），也照旧回一帧空答案，免得厂商等。
   */
  mainThreadId: () => string | null;
  /**
   * 提问请求到手时的投递口：把**提问那一半**投进内容账本（`message.ts` 的 `askUserCallDraft`）。
   *
   * 为什么必须由这一层投：这一家的提问是 server→client 请求，**不进通知流**，账本里那一半
   * 没有第二个来源。缺省 = 不投（纯变换的单测不需要账本）。
   *
   * 只对**交到提问端口的那些请求**调用（主线程那一支，见下面 `mainThreadId` 的判据）：
   * 子线程发起的提问我们压根不问人，投一张「向用户提问」的卡片会把它说成一次真的人机问答。
   * 端口自己有没有收下这一问（同题撞名 ⇒ 整场落「无人应答」）不在这里判——那一档的答复由
   * 编排层照常落账本，卡片与它成对出现才如实。
   */
  onAskRequest?: ((params: CodexAskParams) => void) | undefined;
}

/**
 * 这一家的服务端请求应答者：直接把它交给 `createAppServerClient` 的 `onServerRequest`
 * （或 `startCodexSession` 的同名入参），返回值即那一帧的 `result`。
 */
export type CodexAskResponder = (request: {
  id: number | string;
  method: string;
  params: unknown;
}) => Promise<unknown | null>;

/**
 * 造这一家的服务端请求应答者：**只认提问那一条方法**，别的（审批等）返回 `null` ⇒ 客户端不写帧。
 *
 * 返回 `null` 与返回一个空答案帧是**两件事**，正是本模块的分界线：前者是「这一类请求本仓不应答」，
 * 后者是「应答了，但没有人给答案」。
 */
export function createCodexAskResponder(options: CodexAskResponderOptions): CodexAskResponder {
  return async (request) => {
    if (!isCodexAskRequest(request.method)) return null;
    const params = asCodexAskParams(request.params);
    if (params === null) return { answers: {} };
    const questions = codexQuestionsOf(params);
    const ids = params.questions.map((question) => question.id);
    // 子线程发起的提问不落到人面前（见 `CodexAskResponderOptions.mainThreadId`）
    /**
     * 子线程发起的提问不落到人面前（见 `CodexAskResponderOptions.mainThreadId`）。
     *
     * ⚠️ **判据只在主线程 id 已知时成立**：它要等 `thread/start` 返回才落定，而那一瞬间之前的请求
     * （重连、厂商重投）在 `null` 上与「不是主线程」不可分——一律挡掉会把一次真提问静默降级成
     * 「无人应答」。厂商侧对子线程本来就有它自己的门禁（`… can only be used by the root thread`），
     * 故 `null` 期间按主线程处置、照旧问人，只落一条点名的 WARN 供排障。
     */
    const root = options.mainThreadId();
    if (root === null) {
      logger.warn('提问请求早于主线程 id 落定，按主线程处置', { threadId: params.threadId, itemId: params.itemId });
    } else if (params.threadId !== root) {
      return codexAnswerFrameOf({ outcome: 'unavailable', answers: null }, questions, ids);
    }
    options.onAskRequest?.(params);
    const reply = await options.port.ask({
      questions,
      toolName: CODEX_ASK_TOOL_NAME,
      callId: params.itemId,
      // 厂商自己的等待预算（今天恒为 null）；没给就不填数，端口按缺省预算兜底
      vendorBudgetMs: params.autoResolutionMs ?? null,
      // 到这里的提问都属于主线程（子线程那一支上面就返回了）；子任务归属由骨架按 callId 回填
      subagentId: null,
    });
    return codexAnswerFrameOf(reply, questions, ids);
  };
}
