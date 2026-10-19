/**
 * **回到某一轮**的传输面（功能服务层）：把「回到第 N 轮」翻成一次编排调用。
 *
 * 三条分工与追问（`follow-up.ts`）逐字同源：
 *   1. **存在性检查在 api 层**（`assertRowExists` ⇒ 行不存在 404），**能力与可用性在编排层**
 *      （不支持的家、没有可续会话 / 工作区或用例已删 / 正在跑 ⇒ `CONFLICT` 409）。
 *      界面不该给它按钮；真调到了要明确报出来，而不是静默成功；
 *   2. **上限与空消息/空附件在这里拦**（与追问同一条口径）：界面能被绕开；
 *   3. **同步返回「已经在准备中」的快照**：续跑是分钟级的，HTTP 不挂在那儿等它跑完。
 *
 * 与追问的差别只有三格定位（`segment` / `turn` / `keepAt` / `dropFrom`）：它们从消息账本里来，
 * 由界面在轮末 Marker 上给出。**不在这里重算厂商条目**——`keepAt` 是那条消息的 `vendorId`，
 * 编排层与适配器都不解释它。
 */
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  ServiceError,
  type EvalRun,
  type InjectAttachment,
} from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { checkpointRow as checkpointRowInOrchestrator } from '@aieval/evaluator';
import { assertRowExists } from './run-artifacts';

const log = createLogger('checkpoint');

/** 一次「回到某一轮」的请求体（路由层 zod 校验之后交过来的形状） */
export interface CheckpointRequestInput {
  runId: string;
  rowId: string;
  segment: number;
  turn: number;
  keepAt: string;
  dropFrom: string | null;
  text: string;
  attachments?: readonly InjectAttachment[] | undefined;
  messageId?: string | undefined;
}

/**
 * 回到某一轮：旧内容标作废（只追加标记、不改账本原文），再从这一点续跑一段。
 *
 * 与追问同一套拒绝分档：行不存在 ⇒ 404；请求本身不合法 ⇒ 400；
 * 这一家不支持 / 这一行此刻不能续跑 ⇒ 409（中文原因逐字透出，界面按它给禁用原因）。
 */
export function checkpointRow(request: CheckpointRequestInput): EvalRun {
  assertRowExists(request.runId, request.rowId);
  const attachments = request.attachments ?? [];
  if (request.text.trim() === '' && attachments.length === 0) {
    throw new ServiceError('INVALID_QUERY', '回到某一轮之后至少要有一句话或一个附件，说明接下来要做什么');
  }
  if (attachments.length > ATTACHMENT_MAX_PER_MESSAGE) {
    throw new ServiceError(
      'INVALID_QUERY',
      `单条消息最多 ${String(ATTACHMENT_MAX_PER_MESSAGE)} 个附件（这一条有 ${String(attachments.length)} 个）`,
    );
  }

  const run = checkpointRowInOrchestrator(request.runId, request.rowId, {
    segment: request.segment,
    turn: request.turn,
    keepAt: request.keepAt,
    dropFrom: request.dropFrom,
    text: request.text,
    attachments,
    ...(request.messageId === undefined ? {} : { messageId: request.messageId }),
  });
  log.info('回到某一轮', {
    runId: request.runId,
    rowId: request.rowId,
    segment: request.segment,
    turn: request.turn,
    attachmentCount: attachments.length,
  });
  return run;
}
