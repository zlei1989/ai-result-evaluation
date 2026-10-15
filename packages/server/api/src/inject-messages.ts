/**
 * 人工消息的**传输面**（功能服务层）：一行的队列快照、发送、改期（「立即发送」）、撤回，以及附件落盘。
 *
 * 四格口径：
 *
 *   1. **真相源是 `@aieval/evaluator` 的队列表，本层不缓存任何一份**：快照直读表，写动作直调表，
 *      本层只做三件事——校验「这一行在不在」、把结论折成 HTTP 结局、把附件落进该行的附件根。
 *      缓存一份的代价是「撤回成功了但快照还是旧的」这类两处不一致，而它不是偶发、是必然。
 *   2. **三个动作都先校验行存在**：不校验的话，给一个拼错的 `rowId` 登记消息会**静默**成功，
 *      而那条消息永远等不到取件（编排层按 `(runId, rowId)` 取件）——用户看到「已排队」，
 *      模型永远收不到。404 至少让客户端知道该刷新。
 *   3. **附件根按这一轮自己记录的 `workspaceBase` 解析**，不按当前设置里的根：用户改过工作区根
 *      之后，在跑的轮次与新上传的附件仍应落在同一棵树下（与 `run-artifacts` 同一口径）。
 *   4. **上限（单文件 20 MB / 单条消息 10 个）在这里拦，不在界面上拦**：界面能被绕开，
 *      而超限的中文原因要点名是哪一条限制（用户要据此决定「删几个」还是「换个更小的」）。
 *
 * 撤回的错误分档：`not-found` ⇒ 404、`consumed` 与厂商侧的 `unsupported` / `unknown` ⇒ 409
 * （后两者**什么都没改变**，那一条仍在厂商队列里等下一次机会）。客户端据此提示，
 * 并**重读快照**——它才是「那一条现在在哪一态」的权威读侧：撤不回来的那一条会以 `consumed`
 * 出现（带上了原因），撤销成功的那一条会以 `gone` 出现。
 */
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ServiceError,
  type EvalRun,
  type InjectAttachment,
  type InjectMessage,
  type InjectMessagePromoteAccepted,
  type InjectMessageRef,
  type InjectMessageRetractAccepted,
  type InjectMessageSendAccepted,
  type InjectMessageSendRequest,
} from '@aieval/contracts';
import {
  createLogger,
  listAttachmentFileNames,
  rowAttachmentDir,
  writeAttachmentFile,
} from '@aieval/core';
import {
  listInjectMessages as listInjectEntries,
  promoteInjectMessage as promoteInQueue,
  registerInjectMessage,
  retractInjectMessage as retractInQueue,
  type InjectQueueEntry,
  type InjectRetractResult,
} from '@aieval/evaluator';
import { assertRowExists } from './run-artifacts';
import { getRunView } from './runs';

const log = createLogger('inject-messages');

/** 这一条不在表里时给的中文原因 */
function entryMissing(messageId: string): ServiceError {
  return new ServiceError('NOT_FOUND', `这一行里没有这条人工消息（${messageId}）`);
}

/** 校验这一行在不在，并取出这一轮的快照（附件根要按它的 `workspaceBase` 解析） */
function requireRun(runId: string, rowId: string): EvalRun {
  assertRowExists(runId, rowId);
  return getRunView(runId);
}

/** 表里找这一条（找不到抛 404）。用于「动作成功了，把改动后的那一条回给客户端」 */
function requireEntry(runId: string, rowId: string, messageId: string): InjectQueueEntry {
  const entry = listInjectEntries(runId, rowId).find((item) => item.messageId === messageId);
  if (entry === undefined) throw entryMissing(messageId);
  return entry;
}

/**
 * 这一行的队列快照（**含终态**）：`gone` 与 `consumed` 那两条带着 `outcome` / `reason` 一起回
 * ——「这一条为什么从队列里消失」「哪一条撤不回来了」正是客户端要在界面上说出来的话，
 * 而这两件事的表侧真相只有这一份。裁剪掉它们等于让客户端去猜。
 */
export function getInjectMessages(runId: string, rowId: string): InjectMessage[] {
  assertRowExists(runId, rowId);
  const entries = listInjectEntries(runId, rowId);
  log.debug('读人工消息快照', { runId, rowId, count: entries.length });
  return entries;
}

/**
 * 登记一条人工消息（发送）。
 *
 * **幂等由表负责**（`messageId` 是幂等键）：重复提交回**同一条** + `created: false`，
 * 不新增、不再投递。本层不做第二次去重——两处判重必然漂，而漂的那一次就是「模型看到两遍」。
 */
export function sendInjectMessage(request: InjectMessageSendRequest): InjectMessageSendAccepted {
  assertRowExists(request.runId, request.rowId);
  const { entry, created } = registerInjectMessage({
    runId: request.runId,
    rowId: request.rowId,
    messageId: request.messageId,
    text: request.text,
    attachments: request.attachments,
    requires: request.requires,
  });
  log.info(created ? '人工消息已登记' : '人工消息重复登记（幂等命中）', {
    runId: request.runId,
    rowId: request.rowId,
    messageId: request.messageId,
    requires: request.requires,
    attachmentCount: request.attachments.length,
  });
  return { created, message: entry };
}

/**
 * 「立即发送」：把这一条的要求由「排队」改成「立即」（**单向**，只能变早不能变晚）。
 *
 * 两档成功结局都回 200（`already-round` = 它本来就要求立即发送，重复点同一颗按钮）；
 * 已经交出去的那一条回 409——边界已经用掉了，改投递时机这句话对它没有意义。
 */
export function promoteInjectMessage(ref: InjectMessageRef): InjectMessagePromoteAccepted {
  assertRowExists(ref.runId, ref.rowId);
  const result = promoteInQueue(ref.runId, ref.rowId, ref.messageId);
  if (result === 'not-found') throw entryMissing(ref.messageId);
  if (result === 'not-queued') {
    throw new ServiceError('CONFLICT', '这一条已经交给智能体了，改不了投递时机');
  }
  log.info('人工消息改期', { runId: ref.runId, rowId: ref.rowId, messageId: ref.messageId, outcome: result });
  return { outcome: result, message: requireEntry(ref.runId, ref.rowId, ref.messageId) };
}

/**
 * 表那一侧的分派结论 → HTTP 结局（纯函数：七个 `kind` 各自的状态码与文案可以直接断言，
 * 不必先造出七种表状态——其中三种今天根本造不出来：`consumed` 要厂商侧先吃掉、
 * `unsupported` / `unknown` 要适配器交回那两档）。
 *
 * 三档错误的取舍：**「什么都没改变」不许回 200**（客户端会把 200 读成「撤掉了」，
 * 于是界面上少一条、模型那边还在），故它们走 409 + 各自一句中文；`not-found` 走 404。
 */
export function retractHttpResult(result: InjectRetractResult, messageId: string): InjectMessageRetractAccepted {
  switch (result.kind) {
    case 'removed':
      return { outcome: 'removed', message: result.entry };
    case 'retracted':
      return { outcome: 'retracted', message: result.entry };
    case 'gone':
      return { outcome: 'already-retracted', message: result.entry };
    case 'not-found':
      throw entryMissing(messageId);
    case 'consumed':
      throw new ServiceError('CONFLICT', result.entry.reason ?? '这一条已经交给智能体了，撤不回来');
    case 'unsupported':
      throw new ServiceError('CONFLICT', '这一家不支持按条撤回，这条消息仍在厂商的队列里（只能整条队列一起清）');
    case 'unknown':
      throw new ServiceError('CONFLICT', '撤回没能确认结果，这条消息仍留在队列里，可以再试一次');
  }
}

/**
 * 撤回一条（与「删除未投递项」是**同一个动作**）：服务端按当前状态分派——还在我们表里的直接摘掉，
 * 已经交给厂商的走这一家的撤回面，已经被模型吃掉的明确拒绝。
 *
 * 拆成两个动作的代价是把服务端的真相复制一份到客户端，两份必然漂：界面只有一个「删除」按钮。
 */
export async function retractInjectMessage(ref: InjectMessageRef): Promise<InjectMessageRetractAccepted> {
  assertRowExists(ref.runId, ref.rowId);
  const result = await retractInQueue(ref.runId, ref.rowId, ref.messageId);
  return retractHttpResult(result, ref.messageId);
}

/** 落一个附件要的那几格：行身份 + 上传流里的三格（文件名 / 类型 / 字节） */
export interface SaveInjectAttachmentInput {
  runId: string;
  rowId: string;
  /** 客户端为这条草稿生成的 id：附件的落点是 `attachments/<messageId>/` */
  messageId: string;
  fileName: string;
  /** `File.type`；浏览器认不出时是空串 ⇒ 落 `null`（与 `AttachmentBlock.mimeType` 同口径） */
  mimeType: string;
  bytes: Uint8Array;
}

/** 字节数 → 可读 MB（错误文案里点名「这个是多大」，用户才知道要删还是换） */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * multipart 正文里除文件本体之外的余量：一段 boundary、几个表单字段与文件名撑不到 1 MB，
 * 故「声明长度 ≤ 单文件上限 + 余量」一定不是「文件本体超限」这一种失败。
 */
const UPLOAD_OVERHEAD_BYTES = 1024 * 1024;

/**
 * 上传请求体的**粗筛**：在 `request.formData()` **之前**按 `content-length` 拦明显超标的请求。
 *
 * 为什么需要它：`formData()` 会把整个请求体读进内存（Route Handler 没有 body 上限，那正是附件不走
 * Server Action 的原因），而 20 MB 只是**业务**上限——没有这道粗筛，一个 1 GB 的 POST 会先被完整
 * 读进内存、再被业务上限拒掉。粗筛的价值是「早一点拒绝」，**不是安全边界**：
 * `content-length` 由客户端给（可以缺席、也可以说谎），缺席时这一格直接放行，由业务上限收口。
 */
export function assertUploadContentLength(contentLength: string | null): void {
  if (contentLength === null) return;
  const declared = Number(contentLength);
  if (!Number.isFinite(declared) || declared < 0) return;
  const limit = ATTACHMENT_MAX_FILE_BYTES + UPLOAD_OVERHEAD_BYTES;
  if (declared <= limit) return;
  throw new ServiceError(
    'INVALID_QUERY',
    `单个附件不能超过 ${formatMegabytes(ATTACHMENT_MAX_FILE_BYTES)}（这次上传的正文是 ${formatMegabytes(declared)}）`,
  );
}

/**
 * 把一个上传的附件落到**该行的附件根**（`rowDir/attachments/<messageId>/`），返回它的清单项。
 *
 * 四件事的顺序是刻意的：
 *   1. **校验行存在**（`workspaceBase` 也从这里来）：轮不存在时不该在磁盘上建出一棵树；
 *   2. **先拦大小、再拦条数**：大小是这一份文件自己的问题（换一份就好），条数是这一条消息的累计
 *      问题（要删几个）——两句话对用户的下一步动作不同，`size` 先答更直接的那个；
 *   3. **磁盘上的文件名由 core 净化**：它来自用户，`..` 与分隔符必须在落盘那一步之前就断掉；
 *   4. **`mimeType` 空串落 `null`**：浏览器说不出来时写空串，界面会把它当成一个「有值的类型」
 *      显示出来（一个空白标签），而真实语义是「不知道」。
 *
 * ⚠️ **已知边界**：20 MB 是**业务上限**，不是内存上限——`request.formData()` 已经把这个请求体
 * 整份读进内存（Route Handler 没有 body 上限，那正是附件不走 Server Action 的原因），
 * 所以本函数拦的是「存不存」，不是「读不读」。读之前的粗筛归 `assertUploadContentLength`
 * （按 `content-length` 拦明显超标的请求）；真要在读之前就设硬上限，得换掉 `formData()` 的
 * 流式解析——那超出本函数的职责。
 */
export function saveInjectAttachment(input: SaveInjectAttachmentInput): InjectAttachment {
  const run = requireRun(input.runId, input.rowId);
  if (input.bytes.byteLength > ATTACHMENT_MAX_FILE_BYTES) {
    throw new ServiceError(
      'INVALID_QUERY',
      `单个附件不能超过 ${formatMegabytes(ATTACHMENT_MAX_FILE_BYTES)}（这个是 ${formatMegabytes(input.bytes.byteLength)}）`,
    );
  }
  // 目录名拼装由 core 负责，`messageId` 的形状校验也在那一道门里（拼路径前先校验，见 core 的同名注释）
  const dir = rowAttachmentDir(run.workspaceBase, input.runId, input.rowId, input.messageId);
  const existing = listAttachmentFileNames(dir);
  if (existing.length >= ATTACHMENT_MAX_PER_MESSAGE) {
    throw new ServiceError(
      'INVALID_QUERY',
      `单条消息最多 ${String(ATTACHMENT_MAX_PER_MESSAGE)} 个附件（这一条已经有 ${String(existing.length)} 个）`,
    );
  }

  const written = writeAttachmentFile({ dir, name: input.fileName, bytes: input.bytes });
  const mimeType = input.mimeType === '' ? null : input.mimeType;
  log.info('人工消息附件已受理', {
    runId: input.runId,
    rowId: input.rowId,
    messageId: input.messageId,
    name: written.name,
    bytes: input.bytes.byteLength,
    existing: existing.length,
  });
  return {
    kind: mimeType?.startsWith('image/') === true ? 'image' : 'file',
    path: written.path,
    mimeType,
  };
}
