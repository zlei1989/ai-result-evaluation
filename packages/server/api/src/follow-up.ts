/**
 * 追问的**传输面**（功能服务层）：人给一行已经跑过的行补一句话，让它接着同一段上下文再跑一段。
 *
 * 四条口径：
 *   1. **存在性检查在 api 层、可用性与拒绝原因在编排层**（与 `retryRow` / `rescoreRow` 同一条分工）：
 *      界面不该给它按钮，真调到了要明确报出来，而不是静默成功；
 *   2. **上限在这里拦**（单条消息 10 个附件，与 `sendInjectMessage` 同一处置）：界面能被绕开，
 *      而超限的中文原因要点名是哪一条限制——用户据此决定「删几个」还是「换个更小的」；
 *   3. **空消息不许发**：一句话都没有、附件也没有的追问交给模型只会得到一句「你发了什么」；
 *   4. **同步返回「已经在准备中」的快照**：追问是分钟级的，HTTP 不能挂在那儿等它跑完——
 *      进度由 SSE 与轮询驱动（与 `retryRow` / `rescoreRow` 同一形状）。
 *
 * `messageId` 由客户端给（它同时是那条草稿的附件目录名）：给了就让账本与行级事件跟它共用同一把钥匙，
 * 没给就现铸一个。**它不承担幂等**——重复提交会撞上编排层的「该行正在运行中」而拒绝，
 * 那正是这里想要的结局（两次追问 = 两段上下文，不是同一条消息的重发）。
 */
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  ServiceError,
  type EvalRun,
  type FollowUpAvailability,
  type InjectAttachment,
} from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { followUpAvailability as followUpAvailabilityInOrchestrator, followUpRow as followUpRowInOrchestrator } from '@aieval/evaluator';
import { assertRowExists } from './run-artifacts';
import { getRunView } from './runs';

const log = createLogger('follow-up');

/** 一次追问的请求体（路由层 zod 校验之后交过来的形状） */
export interface FollowUpRequest {
  runId: string;
  rowId: string;
  /** 人写的那句话（**不含**附件清单：清单在提示词里，由编排层拼） */
  text: string;
  /** 随这句话一起发给智能体的附件（已经落盘的那一份清单，路径是绝对路径） */
  attachments?: readonly InjectAttachment[] | undefined;
  /** 这条草稿的 id（前端生成）：与附件的落点目录、账本、行级事件共用同一把钥匙 */
  messageId?: string | undefined;
}

/**
 * 对一行追问。
 *
 * 两类拒绝分别走两个状态码：**行不存在** ⇒ 404（客户端该去刷新；判据与文案取自
 * `assertRowExists`，与人工消息那一面共用同一份），**请求本身不合法** ⇒ 400
 * （文案点名是哪一条限制）；**这一行此刻不可追问**（没会话 / 工作区没了 / 用例没了 / 附件没了 /
 * 这家不支持续接 / 正在跑）由编排层抛 `CONFLICT`（409），中文原因逐字透出——界面按它给 Tooltip。
 */
export function followUpRow(request: FollowUpRequest): EvalRun {
  assertRowExists(request.runId, request.rowId);
  const attachments = request.attachments ?? [];
  if (request.text.trim() === '' && attachments.length === 0) {
    throw new ServiceError('INVALID_QUERY', '一条追问至少要有一句话或一个附件');
  }
  if (attachments.length > ATTACHMENT_MAX_PER_MESSAGE) {
    throw new ServiceError(
      'INVALID_QUERY',
      `单条消息最多 ${String(ATTACHMENT_MAX_PER_MESSAGE)} 个附件（这一条有 ${String(attachments.length)} 个）`,
    );
  }

  const run = followUpRowInOrchestrator(request.runId, request.rowId, {
    text: request.text,
    attachments,
    ...(request.messageId === undefined ? {} : { messageId: request.messageId }),
  });
  log.info('人工追问', {
    runId: request.runId,
    rowId: request.rowId,
    attachmentCount: attachments.length,
    messageId: request.messageId ?? null,
  });
  return run;
}

/**
 * 一轮里每一行的**追问可用性**（界面入口的读侧）：哪一行此刻能追问、不能的那一行为什么。
 *
 * 存在性检查照旧在 api 层（与 `followUpRow` 同一条分工）：那一轮不存在 ⇒ 404，客户端该去刷新；
 * **可用性与原因一个字都不在这里改写**——判据与文案只在契约里那一份（`canFollowUpRow`），
 * 界面按同一句话给按钮的 `disabled` 与 Tooltip。
 *
 * 为什么要一条专门的读侧：七档拒绝里有一半的事实（工作区还在不在 / 用例还在不在 / 这一家的声明）
 * 在盘上与厂商声明上，浏览器一格都看不到。让界面自己编一句「这一家不支持续接」就是第二份说法——
 * 而那正是本仓反复禁止的那种漂移。
 */
export function getFollowUpAvailability(runId: string): FollowUpAvailability {
  // 先按 api 层的读侧确认这一轮在（不存在即 404）；随后交给编排层取同一份快照，
  // 于是「读侧说能追问」与「写侧真的收下」看到的是同一批行
  const before = getRunView(runId);
  const availability = followUpAvailabilityInOrchestrator(runId);
  log.debug('追问可用性读取', { runId, rowCount: before.rows.length });
  return availability;
}
