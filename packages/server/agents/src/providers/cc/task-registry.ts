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
  /**
   * 那一帧的**厂商原文**（未归类的字段原样保留）。
   *
   * 为什么台账要带着它：结果入账后要把那条调用所在的逻辑消息**重投一份快照**，而重投的合成帧
   * 没有自己的原文 ⇒ 若那一格写 `null`，`messages.jsonl` 里同一 `mergeKey` 的**最后一条**就成了
   * 「没有厂商原文」的那一份（读侧按 last-wins 折叠，于是整帧信封——model / usage / stop_reason ——
   * 在折叠视图里丢掉）。带着它重投，折叠后仍是真原文。
   */
  raw: unknown;
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
      // `indexOf === -1` 时 `splice(-1, 1)` 删的是**最后一行**（错删别人而不是删不掉它）——先判再删
      const at = entries.indexOf(entry);
      if (at !== -1) entries.splice(at, 1);
      return;
    }
    // 空串与 `null` 同档（「这次没谈这一格」）：它不该覆盖已经落地的真标题
    //（`mergePending` 里那条同源规则是「空串不算谈过」，两处判据必须一致）
    if (patch.subject !== null && patch.subject !== '') entry.subject = patch.subject;
    if (patch.status !== null) entry.status = patch.status;
    if (patch.owner !== null) entry.owner = patch.owner;
    for (const blocked of patch.addBlockedBy) {
      if (!entry.blockedBy.includes(blocked)) entry.blockedBy.push(blocked);
    }
  };

  /**
   * 合进补丁账：同一 id 的多次未见过的改动按到达顺序合并。
   *
   * ⚠️ **空串与 `null` 在这里也是同一档**（`||` 而不是 `??`）：`TaskUpdate{subject: ''}` 是
   * 「这次没谈标题」，若用 `??` 它会把先到的那条真标题**吃掉**，而落地口（`applyPatch`）
   * 又不认空串 ⇒ 结果是「先到的真标题丢了、新的也没落地」。两处判据必须同源。
   */
  const mergePending = (id: string, patch: TaskPatch): void => {
    const existing = pendingById.get(id);
    pendingById.set(
      id,
      existing === undefined
        ? patch
        : {
          subject: patch.subject || existing.subject,
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

  /**
   * `TaskUpdate` 的入参 → 一次改动（`deleted` 走移除那一支，状态那一格不再参与）。
   *
   * ⚠️ **「这次没谈状态」必须与「谈了但认不出」分开**：`taskStepStatusOf` 的契约是
   * 「认不出一律 `'unknown'`」（它为「厂商给了一个我们不认识的串」而设）⇒ 把 `null` 直接喂给它，
   * 得到的永远是 `'unknown'`、永远不是 `null`，而 `applyPatch` 只在 `status !== null` 时才落值
   * ⇒ 一次**只改 `owner` / `addBlockedBy` / `subject`** 的调用会把那一行从 `inProgress`
   * 打回 `unknown`（面板上那条任务「做着做着变成未知」）。`TaskPatch.status` 的 `null`
   * 语义就是「这次调用没谈到这一格」，这里必须先判缺席再翻译。
   */
  const patchOf = (input: Record<string, unknown> | null): TaskPatch => {
    const status = readString(input, 'status');
    return {
      subject: readString(input, 'subject'),
      // 缺席 ⇒ `null`（不碰已有状态）；给了 ⇒ 按族里唯一那份映射翻译（认不出才是 `'unknown'`）
      status: status === null ? null : taskStepStatusOf(status),
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

  /**
   * 这条 `TaskCreate` 的入参**够不够建一行**：`subject` 或 `description` 至少有一个非空串。
   *
   * 为什么不够就**不建行**（文件头那条「认不出的形状一个字节都不动」的落点）：一次 schema 非法的
   * `TaskCreate`（`input` 是 `null` / 数组 / 缺 `subject`）在厂商那一侧会回一条工具错误，**没有**
   * `task.id` 可认领 ⇒ 建出来的那一行标题永远空着、`createdBy` 永远配不上结果，而它此后会出现在
   * **每一个** `Task*` 块的整表载荷里（面板上多一条没人能删的空任务）。
   * 与 `TaskUpdate` 那一支同一条处置：**没见过的 id 只记补丁账、不凭空造行**；
   * 这一支是「造不出有内容的一行就不造」。
   */
  const inputCreatesRow = (input: Record<string, unknown> | null): boolean =>
    (readString(input, 'subject') ?? '') !== '' || (readString(input, 'description') ?? '') !== '';

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
        const input = asRecord(call.input);
        // 入参认不出（连标题都读不出）⇒ 不建行，但仍记下这次调用：它的结果到达时才知道真标题
        if (inputCreatesRow(input)) entries.push(entryOf(call.callId, input));
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
        if (id === null || id === '') return false;
        const subject = readString(task, 'subject');
        const entry = entries.find((row) => row.createdBy === callId)
          /**
           * 入参那一侧没建行（认不出标题）而**结果这一侧有真标题** ⇒ 现在补建。
           * 为什么值得这一支：结果里的 `{task:{id, subject}}` 是**权威**的（入参只是模型写的），
           * 不补建就等于「模型第一次写坏了标题，这一项此后在整表里根本不存在」。
           */
          ?? (subject !== null && subject !== ''
            ? (() => {
              const created = entryOf(callId, { subject });
              entries.push(created);
              return created;
            })()
            : undefined);
        // 认不出、或这一行已经认过 id、或这个 id 已被别的行占了 ⇒ 不动（宁可停在入参那一步）
        if (entry === undefined || entry.id !== null) return false;
        if (findById(id) !== undefined) return false;
        entry.id = id;
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
