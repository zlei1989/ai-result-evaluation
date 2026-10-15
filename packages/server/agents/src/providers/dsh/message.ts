/**
 * dsh 的**消息归一**：把会话通知折成统一的 `AgentMessage`
 * 与 `SubagentRecord`。事件投影仍在 `events.ts`（行级审计与摘要），本文件只管内容级视图。
 *
 * 取值路径逐条（真机逐字核过，见 `probe/dumps/v3/` 与 `probe/dumps/v11/`）：
 *   · 正文与思考：`session.event` → `params.event.type === 'assistant/message'` →
 *     `data.message.content[]` 的 `{type:'text'|'reasoning'}`。⚠️ `reasoning` 块**也带 `text` 字段**
 *     ⇒ 一律先按 `type` 过滤，绝不按 `text` 取值（否则推理正文会混进最终答复）。
 *   · 信封：`data.message.id` → `vendorId`；`data.turn` → `turn`（**用户轮号**）；
 *     `data.step` → `step`。
 *   · `roundTrip`：**按会话单调编号**——厂商的 `data.step` 是「**每个 turn 内从 1 数**」
 *     （真机：`turn=1 step=1,2` 与 `turn=2 step=1,2`），所以不能直接拿它当往返号（跨 turn 会撞号）。
 *     下面那个 `dshTurnAttribution` 是**唯一实现**（消息的 `roundTrip` 与 `usage.turn.round`
 *     必须是同一个数）：它用「该会话见过的 `step/start` 次数」当权威、用 `step` 补缺口。
 *     dsh 是四家里唯一同时给出厂商轮号与步骤号的家，故这两个信封格只有它非 `null`。
 *   · 工具调用：`tool/call` → `data.{callId, name, arguments}`，`arguments` 是 **JSON 字符串**，
 *     这里解析成对象（解析不了就原样保留字符串：宁可不结构化，也不丢事实）。
 *   · 工具结果：`tool/result` → `data.message.{toolCallId, content[], isError}`；**结构化结果在
 *     `data.meta` 里**（`content[]` 只是给模型看的那份文本）——有 `meta` 就不要退回去解析文本。
 *   · 思考 token：`reasoningTokens` 在本仓这条路由上永远不写（`llm-pi-ai` 的 `mapUsage()` 有意不投影）
 *     ⇒ 那一格恒 `null`（能力位记 `not-projected-by-vendor`），**不许**拿 `outputTokens` 去凑。
 *   · 时间：只能用会话事件的 `time`（毫秒）算跨度，来源标 `'events'`；`apiMs` / `ttftMs` 恒 `null`。
 *
 * 子任务：
 *   · 身份取 `agentId`（与 `childSessionId` 同值，真机核过）；收场之前 `subagent.started` 只给
 *     `childSessionId` ⇒ 那时用它认人，收场时两者同值、记录被完整快照覆盖。
 *   · 名称与类型（`kind`）在另一条会话事件 `subagent/catalog`（`childId` / `mode` / `label`）；
 *     `subagent.finished` 另有 `provider`（跑这个子会话的提供方名）——它**不是** `kind`，
 *     契约里那一格是「派发方式」，`provider` 只进日志载荷。
 *   · 终态**两格合读**：`status`（只有 `ok` / `error`）与 `stopReason`（五档）。`status` 单独读
 *     两个方向都会骗人——取消是 `error` + `aborted`（字面像失败），截断是 `ok` + `max-tokens`
 *     （字面像成功）。映射表只覆盖实测档位，未观测档记 `unknown` + `statusMissing: 'unverified'`。
 *   · `outcome` 只取 `lastAssistantMessage` 里 `type === 'text'` 的块（取消时可能只有 `reasoning`）。
 *   · 子任务级用量不在子任务通知里 ⇒ 按 `params.sessionId` 把子会话的 `assistant/message.data.usage`
 *     分组求和（那是子会话自己的往返用量），`source` 记 `'wire'`。
 */
import type { SubagentRecord, UsageTokens, UsageTurn } from '@aieval/contracts';
import { asRecord, readNumber, readString } from '../../json';
import {
  textBlockDraft,
  thinkingBlockDraft,
  toolCallBlockDraft,
  toolResultBlockDraft,
  type MessageBlockDraft,
  type MessageDraft,
} from '../../message';
import { sumUsageTokens } from '../../usage';
import {
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_SUBAGENT_STARTED_METHOD,
  readUsageTokens,
} from './protocol';

/** `subagent/catalog` 记住的名称与运行方式（键是 `childId`，与 `agentId` 同值） */
const catalog = new Map<string, { label: string | null; mode: string | null }>();

/** 子会话用量：`sessionId → 该会话累计用量`（子任务通知不带用量，只能这样分组求和） */
const sessionUsage = new Map<string, UsageTokens>();

/**
 * 子会话轮次：`sessionId → 该会话已观察到的 `step/start` 次数`。
 *
 * 为什么需要第二张表：本行的 `turns` 是**全树**口径（`events.ts` 的 `step/start` 那一支不按会话
 * 分叉，是既成口径），而「轮次」那一格现在要拆出**子智能体那一份** ⇒ 只能按会话另记一遍。
 * 与 `sessionUsage` 同住这里而不是写进 `events.ts` 的 `TurnState`：它是**模块级的按会话关联表**
 * （同一个进程里并行跑着好几行），与 `sessionUsage` 是同一类东西、同一处清理；塞进 `TurnState`
 * 会让「别家的会话」也进这一行的表。
 */
/** 测试隔离：清空全部模块级关联表（身份 / 用量 / 往返号 / 权限档 / 父子关系） */
export function resetDshMessageStateForTesting(): void {
  catalog.clear();
  sessionPermissions.clear();
  sessionUsage.clear();
  sessionRounds.clear();
  childSessions.clear();
  parentSessions.clear();
}

/**
 * 供测试隔离用：清空关联表。
 * 别名保留给既有用例（它们从 `./events` import 这个名字）——**只留一个实现**，
 * 两张表一起清，避免「清了名字表、忘了用量表」那种跨用例串味。
 */
export const resetSubagentCatalogForTesting = resetDshMessageStateForTesting;

/** 查一条 catalog（名称与 mode 的唯一来源；查不到就是没到，不是「没有名字」） */
export function lookupDshSubagentCatalog(childId: string): { label: string | null; mode: string | null } | null {
  return catalog.get(childId) ?? null;
}

/** 记一条 `subagent/catalog`（名称与 mode 只在这一条里到达） */
export function rememberDshSubagentCatalog(data: Record<string, unknown> | null): void {
  const childId = readString(data, 'childId');
  if (childId === null || childId === '') return;
  catalog.set(childId, { label: readString(data, 'label'), mode: readString(data, 'mode') });
}

/** 当前通知所属的会话 id（子会话的事件与主会话在同一条流里，靠这一格区分） */
export function dshSessionIdOf(notification: Record<string, unknown> | null): string | null {
  return readString(asRecord(notification?.params), 'sessionId');
}

/**
 * 归一 `assistant/message`：每个内容块一条**快照**块草稿。
 *
 * **块位次取「这一块在 `content[]` 里的下标」**，不是「已产出块的个数」——两者只在
 * 「每个元素都产出块」时相同：
 *   · 空文本块 / 认不出的类型块**不产出块**，用个数发号会让它后面每一个块的号都少 1；
 *   · 而旁路增量那一侧（`stream-tap.ts` 的 `positionOf`）给**每个** `block-start` 都占一个号
 *     （它发号时还不知道这一块最终有没有内容）⇒ 两侧错开一个号。
 * 错开的后果不是「少一个块」：同一个块位次是合并槽位的键，正文因此落进**两个**槽位
 * （真机读数：`content[] = [空 text, '正文甲']` ⇒ 合并后 `['正文甲', '正文甲']`），
 * 界面上同一段正文画两次、且两条都留在产物里。
 *
 * 反过来说，这一格与增量侧**同空间**的判据就是「第几个见过的块」：`content[]` 是厂商装配器按
 * 流内块序排出来的（`BlockAssembler.blocks()`：one block per seen index），空块也占一格 ⇒
 * 下标天然等于「第几个块」，与增量侧的「第几个 `block-start`」逐格对齐。
 * ⚠️ 它与 `stream[]` 里的 `chunk.index` **不是**同一把尺子（那是流下标，允许跳号）：
 * 拿它发号会让跳号场景下的增量与快照再次错开。
 */
export function dshAssistantMessageDraft(
  notification: Record<string, unknown> | null,
  sessionId: string | null,
  roundTrip: number,
): MessageDraft | null {
  const params = asRecord(notification?.params);
  const data = asRecord(asRecord(params?.event)?.data);
  const message = asRecord(data?.message);
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const blocks: MessageBlockDraft[] = [];
  for (let position = 0; position < content.length; position += 1) {
    const block = asRecord(content[position]);
    const type = readString(block, 'type');
    if (type === 'text') {
      const text = readString(block, 'text');
      // 空文本块**不产出块、但占位次**（`position` 由下标来，不因跳过而少算）
      if (text !== null && text !== '') blocks.push(textBlockDraft(text, 'snapshot', { kind: 'index', index: position }));
      continue;
    }
    if (type === 'reasoning') {
      const text = readString(block, 'text');
      blocks.push(
        thinkingBlockDraft(
          text === '' ? null : text,
          // 本路由把完整推理正文整块投送（`reasoning-chunks` 也带全文）⇒ 档位是 `'full'`；
          // 整块都没文本时是「有思考但无文本」，不是「没有思考」
          text === null || text === '' ? 'none' : 'full',
          'snapshot',
          null,
          { kind: 'index', index: position },
        ),
      );
      continue;
    }
    if (type === 'tool-call') {
      /**
       * 调用 id 的字段名**两条通道不同**，必须都认：
       *   · `assistant/message` 的 `content[]` 里是 `id`（`ToolCallBlock{type,id,name,arguments}`，
       *     厂商 `dsh-llm` 的类型逐字如此）；
       *   · `tool/call` 那条**事件**的 `data` 里才是 `callId`（见 `dshToolCallDraft`）。
       * 只读 `callId` 的后果是这一块从快照里整个消失（紧随的 `tool/call` 事件只补得上内容、
       * 补不回它占的那一格），它后面每一个块的位次也跟着少 1。
       *
       * 工具调用块自己用 `callId` 当槽位键（不占 `index` 号），而增量侧给它占了一个号——
       * 这不冲突：`index` 号只发给文本 / 思考块，工具块的身份是 `callId`，两者各自与对侧对齐。
       */
      const callId = readString(block, 'callId') ?? readString(block, 'id');
      if (callId === null) continue;
      const name = readString(block, 'name') ?? '';
      blocks.push(toolCallBlockDraft(callId, name, parseDshToolArguments(block?.arguments), 'dsh'));
    }
  }
  if (blocks.length === 0) return null;
  return {
    vendorId: readString(message, 'id'),
    role: 'assistant',
    source: 'wire',
    roundTrip,
    turn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    parentCallId: null,
    // 子会话的事件带的是子会话自己的 id ⇒ 那一份 sessionId 就是子智能体身份（主会话为 null）
    subagentId: dshSubagentIdOf(sessionId),
    chunk: 'snapshot',
    /**
     * 这条消息**自己那一次调用**的用量：`data.usage` 就是它（**被中断的那一次可能没有这一格**
     * ⇒ 那时读数是 `null`，不是 0）。**不参与行级累计**（那是 `events.ts` 的 `state.usage*` 与
     * `cumulativeTokens` 的事），也不是「到这一步为止」的快照。子会话消息走同一个函数 ⇒ 同样带上。
     * 读数（含「缓存两格缺席即 0」）只有 `protocol.ts` 一份实现。
     */
    usage: readUsageTokens(data?.usage)?.tokens ?? null,
    blocks,
    raw: notification,
  };
}

/**
 * 归一 stream-tap 的增量伪事件（`aieval/delta`，机制见 `stream-tap.ts`）：一条 `chunk: 'delta'`
 * 的消息草稿。块序号用**预换算的 content 位次**（tap 读取器按该次尝试的块首见顺序发号），
 * 与 `dshAssistantMessageDraft` 给快照块的 `blocks.length` 是**同一个空间** ⇒ 同一条逻辑消息的
 * 增量与快照落进同一个槽位，快照到达即覆盖收尾（「只实现 snapshot 也能正确渲染」不破）。
 *
 * 与快照侧的三处刻意差异：
 *  · `source: 'hook'`——数据来自挂进厂商进程的插件（stream-tap），不是 stdio 通知线；
 *    快照仍然 `'wire'`。同一条逻辑消息折叠后留最后一条 ⇒ 终态是 `'wire'`；
 *  · `usage: null`——增量帧不带用量（流里的 usage 快照与 `assistant/message.data.usage`
 *    同源，等快照那一次带值即可，合并器「带值覆盖、缺省保留」）；
 *  · 思考增量的档位随通道：`reasoning-delta` 给的是**完整推理正文** ⇒ `'full'`。
 */
export function dshStreamDeltaDraft(
  notification: Record<string, unknown> | null,
  sessionId: string | null,
  roundTrip: number,
): MessageDraft | null {
  const params = asRecord(notification?.params);
  const data = asRecord(asRecord(params?.event)?.data);
  const delta = asRecord(data?.delta);
  if (delta === null) return null;
  const text = readString(delta, 'text') ?? '';
  if (text === '') return null;
  const position = readNumber(delta, 'position');
  if (position === null) return null;
  const identity = { kind: 'index' as const, index: position };
  return {
    vendorId: null,
    role: 'assistant',
    source: 'hook',
    roundTrip,
    /**
     * 增量帧上**没有**轮次两格（厂商 `AssistantStreamFrame` 的 `chunk` 变体不带 `turn`/`step`）；
     * 归属走 `roundTrip` 那一格（由 `dshTurnAttribution` 按会话已观察到的 step 数给出），
     * 与快照同源 ⇒ 同一轮里两条落进同一个载体。
     */
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: dshSubagentIdOf(sessionId),
    chunk: 'delta',
    usage: null,
    blocks:
      readString(delta, 'kind') === 'reasoning'
        ? [thinkingBlockDraft(text, 'full', 'delta', null, identity)]
        : [textBlockDraft(text, 'delta', identity)],
    raw: notification,
  };
}

/**
 * 归一 `tool/call`：一条工具调用消息。
 * `arguments` 是 JSON 字符串（真机逐字 `{"job_id": "pwsh-16", …}`）⇒ 解析成对象再落 `input`；
 * 解析不了（截断 / 纯文本）时**原样保留字符串**——不丢事实，也不编一个空对象。
 */
export function dshToolCallDraft(
  notification: Record<string, unknown> | null,
  sessionId: string | null,
  roundTrip: number,
): MessageDraft | null {
  const params = asRecord(notification?.params);
  const data = asRecord(asRecord(params?.event)?.data);
  const callId = readString(data, 'callId');
  if (callId === null || callId === '') return null;
  return {
    vendorId: callId,
    role: 'assistant',
    source: 'wire',
    roundTrip,
    turn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    parentCallId: null,
    subagentId: dshSubagentIdOf(sessionId),
    chunk: 'snapshot',
    // 工具调用消息：消息级用量只可能挂在模型产出（`assistant/message`）上 ⇒ 这一格恒 null
    usage: null,
    blocks: [toolCallBlockDraft(callId, readString(data, 'name') ?? '', parseDshToolArguments(data?.arguments), 'dsh')],
    raw: notification,
  };
}

/**
 * 归一 `tool/result`：一条工具结果消息。
 * 结构化结果取 `data.meta`（真机：`read` 给 `{lines[], totalLines}`、`glob` 给 `{shape:'paths',…}`、
 * `grep` 给 `{shape:'matches',…}`、`write` 给 `{operation, diffs[]}`、`edit` 给 `{diffs[…]}`）；
 * shell 类工具（`bash` / `pwsh`）的 `meta` 只投影 `{cwd}`（真机逐条核过）⇒ 退出码**不在**它里面。
 *
 * ⚠️ **非零退出必须从 `job/settled` 补进来**：厂商对它们写的是
 * `message.isError: false` + 正文尾部的 `[exit code: N]`（工具描述里明写「Non-zero exits are
 * reported, not errored」），而**结构化**的退出码在同一次运行的 `job/settled` 上
 * （`data.detail = "exit code: N"`、`data.toolCall.callId` 与本条的 `message.toolCallId` 同值；
 * 真机顺序是 `job/registered → job/settled → tool/result` ⇒ 投影本条时那个数已经在手）。
 * 不补的后果是这条结果块被界面画成 **ok**——四家里只有 dsh 这一档连 `isError` 都不置，
 * 一次失败的命令在对话视图里看不出来（四家横向对照见 FAQ 的「非零退出」条）。
 * 播报口径与 codex 同尺：**只置块级 `isError`，不给活动行加摘要**（非零退出里多数是探测类命令的正常返回）。
 */
export function dshToolResultDraft(
  notification: Record<string, unknown> | null,
  sessionId: string | null,
  roundTrip: number,
  /** 同一次运行里 `job/settled` 报的失败判据（没有就是 `null`）——见上面的说明 */
  jobFailed: boolean | null = null,
): MessageDraft | null {
  const params = asRecord(notification?.params);
  const data = asRecord(asRecord(params?.event)?.data);
  const message = asRecord(data?.message);
  const callId = readString(message, 'toolCallId');
  if (callId === null || callId === '') return null;
  const text = contentText(message?.content);
  return {
    vendorId: readString(message, 'id'),
    role: 'tool',
    source: 'wire',
    roundTrip,
    turn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    // dsh 没有「调用级」归属（子任务归属只有会话 id 层级）⇒ 这一格恒 `null`
    parentCallId: null,
    subagentId: dshSubagentIdOf(sessionId),
    chunk: 'snapshot',
    // 工具结果消息：消息级用量恒没有（它不来自任何一次模型调用）
    usage: null,
    blocks: [
      toolResultBlockDraft(callId, text, {
        structured: data?.meta ?? null,
        // 厂商的 `isError` 为准；它没报错而**结构化退出码非零**时也按失败记（见上面的 JSDoc）
        isError: message?.isError === true || jobFailed === true,
      }),
    ],
    raw: notification,
  };
}

/**
 * 主子会话判定：**子会话 id 就是子任务身份**。
 *
 * 探测（逐条核过）：`subagent.started` 的 `params.childSessionId` 与随后
 * 子会话事件里的 `params.sessionId` **同值**（都是那个裸 UUID），而主会话是另一种形状
 * （`session-<32 位 hex>`）。所以归属判据是「这张表里登记过的 id 才是子会话」，
 * 登记来源见 `dshSubagentRecord`。
 *
 * `parentSessionIds` 是**否决表**：`subagent.*` 通知的 `parentSessionId` 明确说了「谁是父会话」，
 * 于是同一个 id 即使曾被当成子会话登记过（同一进程里跑过多次运行的残留），也不会把主会话的消息
 * 错认成子智能体的。判据是**登记事实**，不是猜测。
 *
 * 两个读者，判据只有一份：消息信封的 `subagentId`（`dshAssistantMessageDraft` 等）与
 * **本行最终答复**（`events.ts` 的 `assistant/message` 只在主会话那一支写 `state.finalText`）——
 * 后者漏了这道过滤的表现是「子智能体的话顶掉本行答复」，而评分通路只读最终答复。
 *
 * ⚠️ 这两张表是**模块级**的（跨 run 累积），而真机上每一条子任务的身份都是新 UUID
 * ⇒ 同一个进程里跑多行不会串味；测试隔离走 `resetDshMessageStateForTesting`。
 *
 * **登记刻意不清理**（代价是长驻进程里表只增不减，量级是每 run 几十个 UUID）：
 * 「这一轮结束了」不等于「这条子会话的话说完了」——后台子智能体可能在主会话收尾后才把最后几条
 * 事件送到，而追问会**接着同一条会话**再跑一段 ⇒ 那时这些事件照样进同一条通知流。清早了它们
 * 会被当成主会话的话（归属丢失，而 `finalText` 那道过滤也就跟着失效）。要清理得先有一个
 * 「这条会话再也不会说话了」的判据，今天没有。
 */
const childSessions = new Set<string>();
const parentSessions = new Set<string>();

/** 子会话身份（`null` = 主会话或登记表里没有它）；身份表与判定见上面那一段 */
export function dshSubagentIdOf(sessionId: string | null): string | null {
  if (sessionId === null || parentSessions.has(sessionId)) return null;
  return childSessions.has(sessionId) ? sessionId : null;
}

/** 第一个非空字符串；都没有返回 null（**不编**） */
function firstNonEmpty(...values: (string | null)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== '') return value;
  }
  return null;
}

/**
 * 取 `content[]` 里 `type === 'text'` 的非空块，按顺序用换行拼接（绝不按 `text` 字段取值）。
 *
 * ⚠️ **`content` 本身是字符串也要认**（R6-B 的 F5）：同名的两份读法原先不一致（`protocol.ts` 那份认
 * 字符串、这份不认），于是厂商一旦给字符串形态，`tool/result` 的结果块文本会**静默变成空串**。
 */
function contentText(content: unknown): string {
  // 字符串形态：整串就是正文（厂商在某些工具上直接给文本）
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter((entry) => entry !== '')
    .join('\n');
}

/**
 * `arguments` 是 JSON 字符串 ⇒ 解析成对象；解析不了就原样返回（不丢事实、不编空对象）。
 *
 * 导出给投影用（`events.ts` 的 `noteDshDispatchStart` 要从入参里取任务描述）：
 * 同一个字段的读法只留一份，两边各写一遍必然在「解析失败怎么办」上分叉。
 */
export function parseDshToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * 子任务**身份**（`childSessionId` 为主，`agentId` / `subagentId` 一并容忍——见 `protocol.ts`）。
 *
 * 三个名字指的是**同一个东西**（子会话身份），而哪一格有值随版本/通道而变 ⇒ 全认。
 * 独立成函数是为了让「派发那一格」按同一个身份取值（`dshSubagentRecord` 与 `events.ts`
 * 的派发认领共用它，不各写一份）。
 */
export function dshSubagentIdentity(notification: Record<string, unknown> | null): string | null {
  const params = asRecord(notification?.params);
  return firstNonEmpty(
    readString(params, 'subagentId'),
    readString(params, 'agentId'),
    readString(params, 'childSessionId'),
  );
}

/**
 * 子任务**运行行**的唯一构造点：`subagent.started` 与「目录项晚到」两条通路共用。
 *
 * 为什么要有第二条通路：任务名（catalog 的 `label`）与派生它的那次调用（`parentCallId`）都可能在
 * `subagent.started` **之后**才拿到 ⇒ 派发时那条行既没有名字、也指不出派发点，界面上落不进任何一轮
 * （没有卡片、也没有「进入」入口）。目录项到达后按同一身份再投一条，这一行才可达。
 *
 * `name` / `kind` 一律现查关联表（**不接收调用方传值**）：catalog 是它们的唯一来源，
 * 传值会让同一身份的两次投递有机会写出两个名字。
 */
export function dshSubagentStartRecord(childId: string, parentCallId: string | null): SubagentRecord {
  const entry = catalog.get(childId);
  return {
    subagentId: childId,
    name: entry?.label ?? null,
    // 类型：`mode`（`one-shot` / `continuable`）来自 catalog
    kind: entry?.mode ?? null,
    source: 'wire',
    parentCallId,
    // 嵌套父链：真机通知不带父 id ⇒ 给不出就是 null，不猜
    parentSubagentId: null,
    status: 'running',
    statusMissing: null,
    outcome: null,
    usage: null,
  };
}

/**
 * 归一 `subagent.started` / `subagent.finished`：一行一子任务。
 *
 * 状态**两格合读**的映射表（`status` × `stopReason`）：
 *
 * | `status` | `stopReason` | 归一 | 依据 |
 * |---|---|---|---|
 * | `ok` | `completed` | `completed` | 真机成功路径 |
 * | `ok` | `max-tokens` | `failed` | 真机：字面"成功"实为被输出上限截断 = 没做完 |
 * | `error` | `aborted` | `stopped` | 真机：字面"失败"实为主动取消 |
 * | `error` | `error` | `failed` | 真机档位（与 `status` 同向） |
 * | 其余组合 | — | `unknown` + `statusMissing: 'unverified'` | 未观测档（含 `refusal`）：**不猜** |
 */
export function dshSubagentRecord(
  notification: Record<string, unknown> | null,
  /**
   * 派生它的那次 `subagent` 调用 id（由投影按「目录项 label ↔ 在飞派发的 description」对账出来）。
   * 对账不出就是 `null`——界面那时按「派发入参的任务名 == 子任务名」认派发点。
   */
  parentCallId: string | null = null,
): SubagentRecord | null {
  const method = readString(notification, 'method');
  const isStart = method === DSH_SUBAGENT_STARTED_METHOD;
  if (!isStart && method !== DSH_SUBAGENT_FINISHED_METHOD) return null;
  const params = asRecord(notification?.params);
  const childSessionId = readString(params, 'childSessionId');
  const parentSessionId = readString(params, 'parentSessionId');
  const agentId = readString(params, 'agentId');
  const identity = dshSubagentIdentity(notification);
  if (identity === null || identity === '') return null;
  /**
   * **把身份登记成子会话**（归属判据的唯一来源）：子会话的 `assistant/message` / `tool/*`
   * 带的 `params.sessionId` 就是这个身份 ⇒ 登记之后它们才会被归到这条子任务上，
   * 而不是被当成主会话的话（或被丢掉）。
   *
   * 三个候选名都登记：真机给 `childSessionId`（`subagent.finished` 另有同值的 `agentId`），
   * 而**登记多一个不存在的 id 是无害的**（没有任何事件会带它），漏登记才有害。
   */
  for (const candidate of [identity, agentId, childSessionId]) {
    if (candidate !== null && candidate !== '') childSessions.add(candidate);
  }
  // 父会话进否决表：主会话的正文消息因此不会被当成子智能体的话（同一进程跑多次运行时的残留也在内）
  if (parentSessionId !== null && parentSessionId !== '') parentSessions.add(parentSessionId);

  const entry = catalog.get(identity);
  const base = {
    subagentId: identity,
    name: entry?.label ?? null,
    /**
     * 派发方式（契约那一格的语义）：`mode`（`one-shot` / `continuable`）来自 catalog。
     *
     * ⚠️ `subagent.finished` 的载荷里还有一个 `provider`（厂商口径：跑这个子会话的提供方名），
     * 它**不是**这一格——契约里 `kind` 是「派发方式」（如 `spawn_agent` / `subagent` / `Task`），
     * 而 `provider` 在契约里没有落点。把它写进 `kind` 的后果是：同一个子任务在跑动期显示
     * `one-shot`、收尾那一刻变成 `spawn`（界面把这一格渲染成「派发方式」），
     * 而 catalog 的 `mode` 此后在任何字段里都不再保留。`provider` 只进日志载荷（`events.ts`）。
     */
    kind: entry?.mode ?? null,
    source: 'wire' as const,
    /**
     * 派生它的那次工具调用 id（`parentCallId`）。
     *
     * 厂商的 `subagent.started` / `subagent.finished` 载荷里**没有这一格**（真机：只有
     * `childSessionId` / `parentSessionId`，SDK 的 `recordSessionRelationship` 也只读两个 sessionId），
     * 而 `subagent` 工具调用的 `callId` 是另一种形状 ⇒ 归给本函数的这一格**只可能是我们对账出来的**
     * （投影按「目录项 `label` ↔ 在飞派发的 `description`」唯一命中）：对账不出就是 `null`，
     * 界面那时退回「派发入参的任务名 == 子任务名」这条判据。
     */
    parentCallId,
    /**
     * 嵌套父链：`subagent.*` 通知给的 `parentSessionId` 只说明「谁派发了它」，
     * 而契约这一格要的是**父级子任务身份**——只有「派发者本身也是一条子会话」时才有值。
     * 判据现成（`parentSessions` / `childSessions` 两张表都在），但真机上还没见过嵌套派发的样本
     * ⇒ 今天一律给 `null`（**不猜**）。要接上它，先跑一次「子智能体再派子智能体」的真机读数，
     * 看 `parentSessionId` 是不是等于那条父**子会话**的 id。
     */
    parentSubagentId: null,
  };
  if (isStart) {
    // 与「目录项晚到」那条通路共用同一个构造点：两条投递的 name / kind / parentCallId 因此不可能漂移
    return dshSubagentStartRecord(identity, parentCallId);
  }
  const { status, statusMissing } = mapDshSubagentStatus(readString(params, 'status'), readString(params, 'stopReason'));
  return {
    // `kind` 与运行行、与「目录项晚到」那条补投**同一个取值**（都是 catalog 的 `mode`）：
    // 终态记录比派发记录更瘦的写法会让同一格在收尾那一刻换词
    ...base,
    status,
    statusMissing,
    // `outcome` 只取 `type === 'text'` 的块（取消时可能只有 `reasoning` ⇒ 保持 `null`，不拿推理顶替）
    outcome: subagentOutcome(params),
    usage: sessionUsage.get(identity) ?? null,
  };
}

function mapDshSubagentStatus(
  status: string | null,
  stopReason: string | null,
): { status: SubagentRecord['status']; statusMissing: SubagentRecord['statusMissing'] } {
  if (stopReason === 'completed') return { status: status === 'ok' ? 'completed' : 'failed', statusMissing: null };
  if (stopReason === 'max-tokens') return { status: 'failed', statusMissing: null };
  if (stopReason === 'aborted') return { status: 'stopped', statusMissing: null };
  if (stopReason === 'error') return { status: 'failed', statusMissing: null };
  // `refusal` 与任何未观测组合：给一个可渲染的值，同时**显式**说明没采到（不猜、也不留 null）
  return { status: 'unknown', statusMissing: 'unverified' };
}

function subagentOutcome(params: Record<string, unknown> | null): string | null {
  const blocks = params?.lastAssistantMessage;
  if (!Array.isArray(blocks)) return null;
  const text = contentText(blocks);
  return text === '' ? null : text;
}

/**
 * 记一条子会话的 `assistant/message` 用量（子任务通知不带用量 ⇒ 收场时按会话求和）。
 * 同一个会话的多条 `assistant/message` 各自是一次往返 ⇒ 逐条相加，可选格读不到就是 `null`。
 *
 * 读法与行级合计**同源**（`readUsageTokens`）：缓存两格缺席即 0（厂商条件写入）、
 * `totalTokens` 是**这一条自己的合计** ⇒ 同样相加。两处各写一份读数必然漂移，而漂移的症状是
 * 「合计里子会话那一份比主会话口径小一截」，界面上看不出哪一边错。
 * 读不动的形状（缺 input / output）整条跳过——那一条的用量在两边都不算数，口径一致。
 */
export function noteDshSessionUsage(sessionId: string | null, usage: unknown): void {
  if (sessionId === null || sessionId === '') return;
  const reading = readUsageTokens(usage);
  if (reading === null) return;
  const tokens = reading.identityHolds ? reading.tokens : { ...reading.tokens, total: null };
  const previous = sessionUsage.get(sessionId);
  const total = tokens.total ?? null;
  sessionUsage.set(sessionId, {
    input: (previous?.input ?? 0) + tokens.input,
    cached: (previous?.cached ?? 0) + tokens.cached,
    output: (previous?.output ?? 0) + tokens.output,
    reasoningOutput: tokens.reasoningOutput ?? previous?.reasoningOutput ?? null,
    total: total === null ? previous?.total ?? null : (previous?.total ?? 0) + total,
  });
}

/**
 * 某个会话**到目前为止**的累计用量（没有这一格就是 `null`）。
 *
 * 给「run 基线」用：`sessionUsage` 是模块级的、跨 run 不清（同一个子会话 id 在追问/续接的下一
 * 个 run 里会被重新登记），所以本 run 的**分量**必须是「当前累计 − 本 run 登记它时的累计」，
 * 否则第二个 run 的分量把前一个 run 一起算进去（真机形状：行快照上会出现「合计 60 / 子分量 2010」）。
 */
export function dshSessionUsageOf(sessionId: string): UsageTokens | null {
  return sessionUsage.get(sessionId) ?? null;
}

/**
 * 本 run 内该会话**新增**的用量：当前累计减基线；这一轮一条都没新增时给 `null`
 * （与「累计值是 0」是两件事——后者是厂商真报了 0）。
 */
function sessionUsageInRun(sessionId: string, baseline: ReadonlyMap<string, UsageTokens> | undefined): UsageTokens | null {
  const current = sessionUsage.get(sessionId);
  if (current === undefined) return null;
  const base = baseline?.get(sessionId);
  if (base === undefined) return current;
  const delta: UsageTokens = {
    input: Math.max(0, current.input - base.input),
    cached: Math.max(0, current.cached - base.cached),
    output: Math.max(0, current.output - base.output),
    reasoningOutput:
      current.reasoningOutput === null && base.reasoningOutput === null
        ? null
        : Math.max(0, (current.reasoningOutput ?? 0) - (base.reasoningOutput ?? 0)),
    total: null,
  };
  // 三格全是 0 且本轮没新增 ⇒ 「没报」而不是「报了 0」
  const empty = delta.input === 0 && delta.cached === 0 && delta.output === 0;
  const sameTotal = current.total === base.total;
  return empty && sameTotal ? null : delta;
}

/**
 * 记一条会话的 `step/start`（= 该会话又跑了一次模型往返）。
 *
 * 调用点只有一处：`events.ts` 里 `state.turns += 1` 那一行**旁边**。为什么必须同处：
 * `turns` 是合计、这一格是分量，两者若在**不同的分支**上计数，迟早出现分量 > 合计那种破
 * 「`subagentTurns ≤ turns`」的形状——而它在界面上只表现为「那一行不画第二行」，不报错。
 *
 * `data` 用来同步「这是哪个 turn 的第几步」（见 `dshTurnAttribution` 的说明）：
 * `step/start` 的载荷里有 `{turn, step}`，不给也能跑（那就只按次数累计）。
 */
export function noteDshSessionTurn(sessionId: string | null, data: Record<string, unknown> | null = null): void {
  if (sessionId === null || sessionId === '') return;
  const state = sessionRoundState(sessionId);
  state.count += 1;
  // 顺手把这一步的往返号发出去：`step/start` 之后可能没有消息（空的往返），号也不能因此缺位
  const turn = readNumber(data, 'turn');
  const step = readNumber(data, 'step');
  if (turn !== null && step !== null && step >= 1) assignRound(state, turn, step);
}

/**
 * 按会话记的**权限档**（厂商把它当会话属性：`permission/preset` 只在会话起手投一条，
 * 续接 / 追问段既不重投也不改）。为什么要跨 run 记住它：追问段那条 `vendor-system` 若交 `null`，
 * 读侧（环境抽屉取**最后一条**）就会把权限档抹成「未暴露」——而实际档位并没有变。
 */
const sessionPermissions = new Map<string, string>();

/** 记一条会话的权限档（`permission/preset` 那一支调用） */
export function noteDshSessionPermission(sessionId: string | null, preset: string): void {
  if (sessionId === null || sessionId === '' || preset === '') return;
  sessionPermissions.set(sessionId, preset);
}

/**
 * 该会话的权限档：本段观测到的优先，否则用**同一进程里早先那段**记下的（跨进程拿不到，
 * 那时返回 `null`——观测不到就是观测不到，不猜）。
 */
export function dshSessionPermissionOf(sessionId: string | null): string | null {
  if (sessionId === null || sessionId === '') return null;
  return sessionPermissions.get(sessionId) ?? null;
}

/**
 * **跨进程播种**：把这条会话已跑过的往返数交给发号表 ⇒ 新进程续接时从 `n+1` 起，而不是从 1 起。
 *
 * 只抬高 `highWater`（已分配出去的最大号），不动 `count`（那把尺子量的是**本进程**观察到的
 * `step/start`，轮次分量读它）；重复播种（同一条会话被多次 resume）取较大值，幂等。
 */
export function seedDshSessionRoundHighWater(sessionId: string | null, steps: number | null): void {
  if (sessionId === null || sessionId === '' || steps === null || steps <= 0) return;
  const state = sessionRoundState(sessionId);
  if (steps > state.highWater) state.highWater = steps;
}

/** 该会话到目前为止见过的 step 数（= 它自己的最后一个 step；一次都没见过就是 `null`） */
export function dshSessionRoundOf(sessionId: string | null): number | null {
  if (sessionId === null || sessionId === '') return null;
  const state = sessionRounds.get(sessionId);
  return state === undefined || state.count === 0 ? null : state.count;
}

/** 按会话的往返计数状态（模块级；同一个进程里并行着好几行，键是厂商的会话 id） */
interface DshSessionRoundState {
  /**
   * 已观察到的 `step/start` **次数**（轮次分量读它）。
   *
   * 与 `turns`（全树合计）**同一条驱动**：每一次 `step/start` 都 +1，重复投送也各记一次——
   * 两格因此逐格满足 `subagentTurns ≤ turns`。
   */
  count: number;
  /**
   * `"<turn>:<step>"` → 已分配的往返号。
   *
   * 为什么要有这张表：往返号必须**幂等且单调**。同一条读数可能被投影不止一次（重复投送、迟到、
   * 或快照与增量各走一遍），而厂商的 `step` 是「每个 turn 内从 1 数」⇒ 任何按算术推出来的号都会在
   * 乱序 / 重复时回退或撞号（回退的表现是同一条逻辑消息的增量与快照落进两个载体）。按**首次见到**
   * 的顺序发号就没有这个空间：同一个 `(turn, step)` 永远拿回同一个号，新的组合只会拿到更大的号。
   */
  assigned: Map<string, number>;
  /** 已分配出去的最大往返号（不带 `step` 的出口与它同号：那就是「最后一次往返」） */
  highWater: number;
}

const sessionRounds = new Map<string, DshSessionRoundState>();

function sessionRoundState(sessionId: string): DshSessionRoundState {
  const existing = sessionRounds.get(sessionId);
  if (existing !== undefined) return existing;
  const created: DshSessionRoundState = { count: 0, assigned: new Map<string, number>(), highWater: 0 };
  sessionRounds.set(sessionId, created);
  return created;
}

/**
 * 给一条带 `(turn, step)` 的读数发往返号：**首次见到的顺序**（同一个组合幂等）。
 *
 * 顺序到达时它与厂商的 step 序数一一对应（`turn=1` 的 1..N 接着 `turn=2` 的 1..M）；
 * 乱序 / 重复 / 缺事件时它只保证**唯一且单调**——那正是合并键需要的性质。
 */
function assignRound(state: DshSessionRoundState, turn: number, step: number): number {
  const key = String(turn) + ':' + String(step);
  const existing = state.assigned.get(key);
  if (existing !== undefined) return existing;
  state.highWater += 1;
  state.assigned.set(key, state.highWater);
  return state.highWater;
}

/**
 * 这一条读数属于**哪个会话的第几次模型往返**。
 *
 * 为什么是**唯一实现**：消息的 `roundTrip` 与 `usage.turn.round` 必须是同一个数——两处各算一遍，
 * 漂移的表现就是「用量那一行落在与它同号的轮次之外」。
 *
 * ⚠️ **厂商的 `step` 是「每个 turn 内从 1 数」，不是「每会话 1..N」**（真机读数：同一会话两段
 * `turn=1 step=1,2` 与 `turn=2 step=1,2`，会话日志与原始通知两处都是这个形状）。直接拿 `step`
 * 当往返号，第二段的两条读数会与第一段**撞号**（都是 1、2），而**不带 `step` 的出口**
 * （stream-tap 增量、`turn/end`）走的是会话计数（3、4）⇒ 同一条逻辑消息的增量与快照落进**两个
 * 载体**：界面上同一段答复出现两次、而第一段那条被后一段覆盖掉。
 *
 * 所以这里的口径是「**按 `(turn, step)` 首次见到的顺序发号**」（见 `assignRound`）：
 *   · 带 `(turn, step)` 的读数（`step/start` / `assistant/message` / `assistant/attempt`）拿它自己的号，
 *     同一个组合**幂等**——重复投送、迟到、快照与增量各投影一遍，都落回同一个载体；
 *   · 新的组合只会拿到**更大**的号 ⇒ 跨 turn 不撞号（真机形状：`turn=1 step=1,2` 与 `turn=2 step=1,2`
 *     ⇒ 1/2/3/4），也不受「某几步的 `step/start` 厂商根本不投」影响（那种缺口不会让后一步与
 *     前一步撞号）；
 *   · 不带 `(turn, step)` 的出口（`turn/end`、tap 增量）取 `highWater`——它与**最后一次**分配的号相同，
 *     正是「这条读数属于最后一次往返」。
 *
 * `count`（`step/start` 次数）与这套号是两把尺子：它给轮次分量用（与 `turns` 同一条驱动），
 * 重复投送会各记一次，而号只认组合。
 */
export function dshTurnAttribution(sessionId: string | null, data: Record<string, unknown> | null): UsageTurn | null {
  if (sessionId === null || sessionId === '') return null;
  const turn = readNumber(data, 'turn');
  const step = readNumber(data, 'step');
  if (turn !== null && step !== null && step >= 1) {
    return { subagentId: dshSubagentIdOf(sessionId), round: assignRound(sessionRoundState(sessionId), turn, step) };
  }
  const state = sessionRounds.get(sessionId);
  const round = state === undefined ? null : state.highWater > 0 ? state.highWater : dshSessionRoundOf(sessionId);
  // `null` = 这条会话一次 step/start 都没见过（**不拿本行累计号顶替**：那会把读数挂到别的会话上）
  return round === null ? null : { subagentId: dshSubagentIdOf(sessionId), round };
}

/**
 * 本行「**已收场却没报用量**」的子会话 id（白名单 ∩ 已收场 − 有用量）：**事实缺失**那一档。
 *
 * 为什么单独抽出来而不是写在 `dshSubagentUsage` 里：这个判据有**两个**读者——
 * `dshSubagentUsage` 用它决定「整格交 `null`」，收尾那条**点名 WARN** 用它说清「是谁没报」
 * （第三档要求 `null` 必须伴随一条点名的 WARN，codex / claude 都有）。
 * 两处各写一遍必然漂移，而漂移的症状正是本仓最不接受的那一类：结果里是 `null`、日志里却点不出人
 * （或反过来，WARN 点了名而那一格其实有数）。
 */
export function dshSilentChildSessions(input: {
  childSessions: ReadonlySet<string>;
  finishedSessions: ReadonlySet<string>;
  /** 本 run 登记这些子会话时的累计用量快照（见 `noteChildSession`）：判「本轮有没有报」要减掉它 */
  childUsageBaseline?: ReadonlyMap<string, UsageTokens>;
  /**
   * 释放前那次等待没确认整棵子树收场（见 `DshProjectionRunState.subagentsUnsettled`）：
   * 这一刻**没收到 `subagent.finished` 的子会话等同于「不会再有读数」**——它们即将被掐死，
   * 「还在跑、以后会报」按 0 计入是假话。所以这一档把「未收场」也算进「事实缺失」。
   */
  subagentsUnsettled?: boolean;
}): string[] {
  const silent: string[] = [];
  for (const sessionId of input.childSessions) {
    if (input.subagentsUnsettled === true && !input.finishedSessions.has(sessionId)) {
      silent.push(sessionId);
      continue;
    }
    if (!input.finishedSessions.has(sessionId)) continue;
    // 「本报过用量」= **本 run 内**有新增（跨 run 的累计值不算：那是上一个 run 的事）
    if (sessionUsageInRun(sessionId, input.childUsageBaseline) !== null) continue;
    silent.push(sessionId);
  }
  return silent;
}

/**
 * 本行的**子智能体那一份**用量。
 *
 * 为什么按**本行的**子会话白名单（参数 `input.childSessions`）求和、而不是「主会话之外的全部」：
 * `sessionUsage` 是**模块级**的（同一个 Node 进程里并行跑着好几行），主会话之外还有**别的行**的会话
 * ⇒ 只有本行的白名单能把这一行圈出来。
 *
 * ⚠️ 别与本文件顶部那个**模块级**的 `childSessions` 混淆：那是**子会话身份表**（供
 * `dshSubagentIdOf` 判归属，跨 run 累积、刻意不清），不是本行的白名单——
 * 同名不同物，这里读的**只有参数**那一份。
 *
 * 三档（「全量或 null」）：
 *   · 没有子会话 ⇒ `{0,0,0}`（确实没有，不是 null）；
 *   · 子会话**已收场**却一条用量都没有 ⇒ `null`（事实缺失，宁可不出数；**谁没报**见
 *     `dshSilentChildSessions`——收尾那条点名 WARN 与这里是**同一个判据**）；
 *   · 仍在跑的子会话 ⇒ 按「到目前为止」计入（还没有用量就先当 0，它还会报）。
 */
export function dshSubagentUsage(input: {
  childSessions: ReadonlySet<string>;
  finishedSessions: ReadonlySet<string>;
  childUsageBaseline?: ReadonlyMap<string, UsageTokens>;
  /**
   * 释放前那次 `session/wait` 没确认整棵子树收场（见 `DshProjectionRunState.subagentsUnsettled`）：
   * 未收场的子会话等同于「不会再有读数」⇒ 整格交 `null`。
   *
   * ⚠️ **显式声明这一格**：调用方传的本来就是 `DshRunState`（它有这一格），而不声明时是靠
   * 「传进来的就是那个对象」在 `dshSilentChildSessions` 里被读到的——类型面看不见的依赖会在
   * 「展开成新字面量」的重构里被静默丢掉，后果正是「没采到」被说成「确实没有」（`null` → `{0,0,0}`）。
   */
  subagentsUnsettled?: boolean;
}): UsageTokens | null {
  if (input.childSessions.size === 0) return sumUsageTokens([]);
  // 第二档：整格交 null。判据只有一份（`dshSilentChildSessions`），收尾那条 WARN 与它同源
  if (dshSilentChildSessions(input).length > 0) return null;
  const parts: UsageTokens[] = [];
  for (const sessionId of input.childSessions) {
    // **本 run 的增量**（跨 run 的累计值不能进这一格：追问/续接的第二个 run 会把前一轮一起算上）
    const usage = sessionUsageInRun(sessionId, input.childUsageBaseline);
    if (usage !== null) parts.push(usage);
  }
  return sumUsageTokens(parts);
}

/**
 * 本行的**子智能体那一份**轮次。
 *
 * 为什么不是「拿 `turns` 减主会话的轮次」：主会话的轮次没有任何一处单独记过（`turns` 是全树累加），
 * 而按会话记一笔是**同一个计数点**上的顺手动作 ⇒ 两格由同一条 `step/start` 驱动，
 * `subagentTurns ≤ turns` 是构造上的。
 *
 * 三档与 `dshSubagentUsage` **逐字相同**（同一份白名单、**同一个**事实缺失谓词）：
 *   · 没有子会话 ⇒ `0`（确实没有，不是 `null`）；
 *   · 子会话已收场却一条 `step` 都没有 ⇒ `null`（判据 `dshSilentChildSessions`——与用量**共用**，
 *     绝不另写一个谓词：两处各写一遍必然漂移，漂移的症状是「结果是 null、日志里却点不出人」）；
 *   · 仍在跑的子会话 ⇒ 按「到目前为止」计入（还没数到就先当 0，它还会跑）。
 *
 * ⚠️ **判据取「有没有报到用量」而不是「有没有 `step/start`」**：后者看起来更贴题，但它是**第二个
 * 谓词**，会与用量的档位分歧（一个子会话报了用量却没有 `step` 那条边界上，两格会一格有数一格
 * `null`，而 WARN 只说得清其中一格）。「已收场却什么都没报」在真机上是同一个事实，用同一个谓词
 * 表达它才是对的。
 */
export function dshSubagentTurns(input: {
  childSessions: ReadonlySet<string>;
  finishedSessions: ReadonlySet<string>;
  /** 本 run 登记这些子会话时的往返计数快照（同 `childUsageBaseline`：分量只算本 run 那一段） */
  childTurnsBaseline?: ReadonlyMap<string, number>;
  /** 与 `dshSubagentUsage` 同一格、同一条理由（见那边的说明）：整格交 `null` 的第二个触发条件 */
  subagentsUnsettled?: boolean;
}): number | null {
  if (input.childSessions.size === 0) return 0;
  if (dshSilentChildSessions(input).length > 0) return null;
  let turns = 0;
  for (const sessionId of input.childSessions) {
    const counted = dshSessionRoundOf(sessionId) ?? 0;
    const base = input.childTurnsBaseline?.get(sessionId) ?? 0;
    turns += Math.max(0, counted - base);
  }
  return turns;
}
