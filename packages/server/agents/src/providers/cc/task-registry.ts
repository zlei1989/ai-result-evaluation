/**
 * cc 的**任务台账**：把 `TaskCreate` / `TaskUpdate` 的**逐条 patch** 累积成一张整表，
 * 作为 `task` 族的 `plan` 载荷交给工具调用块。
 *
 * 为什么需要它（另两家不需要）：codex 的 `update_plan`、dsh 的 `todo_write` 入参**本来就是整表**，
 * 一次调用就能算出「本次调用之后的整张清单」；而 claude 的 `Task*` 是一套**工作项注册表**——
 * `TaskCreate` 建一项、`TaskUpdate` 改一项的某个字段（`TaskStep` 契约注释里
 * `id` / `owner` / `blockedBy` 三维「只有 claude 有」说的就是它）。只读单次入参的话，
 * `task` 族在 claude 侧恒为空载荷 ⇒ 界面上永远只有一列通用工具行、没有「计划清单」卡片，
 * 与另两家**不同形**。
 *
 * 五条口径：
 *   · **入参与结果两处都是事实来源，各取它权威的那一半**：`TaskUpdate` 的新状态在**入参**里
 *     （模型写的就是它想要的），而 `TaskCreate` 的 **id 只有结果才有**（工具自己发号）⇒
 *     结果到达后要把 id / subject 回填进那一行；
 *   · **「刚建、还没更新过」记 `pending`**：`TaskCreateOutput` 只有 `{id, subject}`、**没有状态**
 *     （SDK 生成的类型与真机逐字一致），而 `TaskCreateInput` 里也没有状态格 ⇒ 唯一能说话的是
 *     `TaskUpdate` 结果的 `statusChange.from`（真机逐字 `"pending"`）；
 *   · **`deleted` 按移除处置**：面板画的是**清单当前状态**（不是历史），而这个指令的语义就是「这一项没了」。
 *     ⚠️ 与**整表**形状里的处置相反——那里 `deleted` 落 `unknown`（它还在厂商给的表里），两处都**未在真机观测到**；
 *   · **没见过的 id 不凭空造行**：先把它记进补丁账，等它的创建结果把 id 认领回来再合并——
 *     编一个空 `subject` 的行等于给面板加一条谁也不知道是什么的任务；
 *   · **认不出的形状一个字节都不动**（`asRecord` 拿不到、`id` / `to` 缺、id 已被别的行占了，都算）：
 *     宁可停在入参给的那一步，也不拿一个猜出来的整表顶掉真实读到的状态。
 *
 * ⚠️ **本模块只投 `subject` / `status` / `id` / `owner` / `blockedBy` 五格**，且后两格只读入参里
 * 明确出现过的值（`owner`、`addBlockedBy`；`addBlocks` 是反向边，本期不投）。入参没给过的行
 * 拿契约的「有这个概念、当前无人认领 / 没有依赖」（`''` / `[]`）——不拿 `null` 冒充
 * （那在契约里的意思是「这家没有这个概念」，而这一家显然有）。
 */
import type { TaskStep, ToolCallPayload } from '@aieval/contracts';
import { asRecord, readString } from '../../json';
import { taskStepStatusOf } from '../../tool-payload';

/** 被追踪的那次调用所属的**载体**（重投快照时必须落回同一个合并键） */
export interface ClaudeTaskEnvelope {
  roundTrip: number;
  parentCallId: string | null;
  subagentId: string | null;
  vendorId: string | null;
}

/** 一次本族的工具调用（入参是厂商原文；`envelope` 供结果到达后重投那份快照用） */
export interface ClaudeTaskCall {
  callId: string;
  /** 厂商工具名：只有 `TaskCreate` / `TaskUpdate` 入账（其余名字给 `null` 载荷） */
  name: string;
  input: unknown;
  envelope: ClaudeTaskEnvelope;
}

export interface ClaudeTaskRegistry {
  /**
   * 一次工具调用入账，回吐**此刻**的整表载荷。
   * `null` = 这个名字不归本台账管（调用方照旧按族载荷归一算）。
   */
  onCall(call: ClaudeTaskCall): ToolCallPayload | null;
  /** 一次工具调用的结果入账；**台账变了**（调用方需要重投那条调用的快照）给 `true` */
  onResult(callId: string, structured: unknown): boolean;
  /** 被追踪的那次调用；没入账（或不是本族）给 `null` */
  callFor(callId: string): ClaudeTaskCall | null;
  /** 此刻的整张清单（没有任何一行时给空表的 `plan` 载荷——「清单为空」是事实，不是「没有」） */
  payload(): ToolCallPayload;
}

/** 本族的两个工具名（`TaskGet` / `TaskList` 不入账：它们的结果形状真机未观测，见文件头） */
const CREATE_TOOL = 'TaskCreate';
const UPDATE_TOOL = 'TaskUpdate';

/** `TaskUpdate` 带的一次改动（`subject` / `status` / `owner` 为 `null` = 这次调用没谈到那一格） */
interface TaskPatch {
  subject: string | null;
  status: TaskStep['status'] | null;
  deleted: boolean;
  owner: string | null;
  addBlockedBy: readonly string[];
}

export function createClaudeTaskRegistry(): ClaudeTaskRegistry {
  /** 台账的一行：比契约的 `TaskStep` 多「谁建的」这一格（结果按调用 id 回填 id 时要用） */
  interface Entry {
    id: string | null;
    subject: string;
    status: TaskStep['status'];
    owner: string;
    blockedBy: string[];
    createdBy: string;
  }
  /** 表里的行（**创建顺序 = 数组顺序**：面板按它排） */
  const entries: Entry[] = [];
  /** 入账过的调用（`kind` 决定结果该按哪一支解释） */
  const calls = new Map<string, { call: ClaudeTaskCall; kind: 'create' | 'update' }>();
  /** 先到、后到的补丁账：`taskId → 还没能落地的改动`（等它的创建结果把 id 认领回来） */
  const pendingById = new Map<string, TaskPatch>();

  const findById = (id: string): Entry | undefined => entries.find((entry) => entry.id === id);

  /** 把一次改动落到一行上（`deleted` 是移除，不是改状态） */
  const applyPatch = (entry: Entry, patch: TaskPatch): void => {
    if (patch.deleted) {
      entries.splice(entries.indexOf(entry), 1);
      return;
    }
    if (patch.subject !== null && patch.subject !== '') entry.subject = patch.subject;
    if (patch.status !== null) entry.status = patch.status;
    if (patch.owner !== null) entry.owner = patch.owner;
    for (const blocked of patch.addBlockedBy) {
      if (!entry.blockedBy.includes(blocked)) entry.blockedBy.push(blocked);
    }
  };

  /** 合进补丁账：同一 id 的多次未见过的改动按到达顺序合并（后到的非 `null` 格覆盖先到的） */
  const mergePending = (id: string, patch: TaskPatch): void => {
    const existing = pendingById.get(id);
    pendingById.set(
      id,
      existing === undefined
        ? patch
        : {
          subject: patch.subject ?? existing.subject,
          status: patch.status ?? existing.status,
          // 只要有一处说要删，就按删（再说它是「待办」是自相矛盾）
          deleted: existing.deleted || patch.deleted,
          owner: patch.owner ?? existing.owner,
          addBlockedBy: [...existing.addBlockedBy, ...patch.addBlockedBy],
        },
    );
  };

  /** 一条字符串清单格（`addBlockedBy`）：不是数组就是「没谈这一格」 */
  const stringListOf = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];

  /** `TaskUpdate` 的入参 → 一次改动（`deleted` 走移除那一支，状态那一格不再参与） */
  const patchOf = (input: Record<string, unknown> | null): TaskPatch => {
    const status = readString(input, 'status');
    return {
      subject: readString(input, 'subject'),
      status: taskStepStatusOf(status),
      deleted: status === 'deleted',
      owner: readString(input, 'owner'),
      addBlockedBy: stringListOf(input?.addBlockedBy),
    };
  };

  /** `TaskCreate` 的入参 → 新行（`subject` 是工具自己定义的简短标题，没有才退 `description`） */
  const entryOf = (callId: string, input: Record<string, unknown> | null): Entry => ({
    id: null,
    subject: readString(input, 'subject') ?? readString(input, 'description') ?? '',
    status: 'pending',
    owner: '',
    blockedBy: [],
    createdBy: callId,
  });

  /** 此刻的整张清单（没有任何一行时给空表——「清单为空」是事实，不是「没有」） */
  const payloadOf = (): ToolCallPayload => ({
    kind: 'plan',
    steps: entries.map((entry) => ({
      id: entry.id,
      subject: entry.subject,
      status: entry.status,
      owner: entry.owner,
      blockedBy: [...entry.blockedBy],
    })),
    note: null,
  });

  return {
    onCall(call) {
      if (call.name === CREATE_TOOL) {
        entries.push(entryOf(call.callId, asRecord(call.input)));
        calls.set(call.callId, { call, kind: 'create' });
        return payloadOf();
      }
      if (call.name !== UPDATE_TOOL) return null;
      calls.set(call.callId, { call, kind: 'update' });
      const input = asRecord(call.input);
      const patch = patchOf(input);
      const id = readString(input, 'taskId');
      const entry = id === null ? undefined : findById(id);
      // 入参里没有 id（或这个 id 还没被创建结果认领）：不造行，只把改动记下来等它出现
      if (entry === undefined) {
        if (id !== null) mergePending(id, patch);
      } else {
        applyPatch(entry, patch);
      }
      return payloadOf();
    },

    onResult(callId, structured) {
      const tracked = calls.get(callId);
      if (tracked === undefined) return false;
      const record = asRecord(structured);
      if (record === null) return false;
      if (tracked.kind === 'create') {
        const task = asRecord(record.task);
        const id = readString(task, 'id');
        const entry = entries.find((row) => row.createdBy === callId);
        // 认不出、或这一行已经认过 id、或这个 id 已被别的行占了 ⇒ 不动（宁可停在入参那一步）
        if (id === null || id === '' || entry === undefined || entry.id !== null) return false;
        if (findById(id) !== undefined) return false;
        entry.id = id;
        const subject = readString(task, 'subject');
        if (subject !== null && subject !== '') entry.subject = subject;
        const pending = pendingById.get(id);
        if (pending !== undefined) {
          pendingById.delete(id);
          applyPatch(entry, pending);
        }
        return true;
      }
      const taskId = readString(record, 'taskId');
      const to = readString(asRecord(record.statusChange), 'to');
      if (taskId === null || taskId === '' || to === null) return false;
      const patch: TaskPatch = {
        subject: null,
        status: taskStepStatusOf(to),
        deleted: to === 'deleted',
        owner: null,
        addBlockedBy: [],
      };
      const entry = findById(taskId);
      if (entry === undefined) {
        mergePending(taskId, patch);
        return true;
      }
      applyPatch(entry, patch);
      return true;
    },

    callFor(callId) {
      return calls.get(callId)?.call ?? null;
    },

    payload: payloadOf,
  };
}
