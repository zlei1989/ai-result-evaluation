/**
 * 用例同步契约：后台把用例文件提交并推送到远端这件事的**下行状态**与**人工动作**。
 *
 * 为什么状态是一份「快照」而不是事件流：同步是**尽力而为的后台动作**（保存用例不阻塞、也不等它），
 * 用户真正要回答的问题只有三个——「现在能不能提交」「上次成不成」「差多少」。三个问题都在这一格里，
 * 故不需要事件列表，也不需要持久化（进程重启后这份内存状态归零，磁盘上的 git 事实才是真源）。
 *
 * `undefined` 与 `null` 的分工是刻意的，别合并：
 *   · `null` = **未知**（本次没探到，例如离线、没有上游）——界面据此仍显示「拉取」按钮，点了会看到原因；
 *   · `0`    = **确知相等**（探到了，远端没有新提交）——界面据此**不**显示按钮。
 * 把「没探到」写成 0，界面就会把一次离线说成「远端没有新提交」。
 */
import { z } from 'zod';

/** 人工动作：提交（把待提交的用例文件逐文件提交并推送）/ 拉取（对齐远端后再推送本地提交） */
export const CASE_SYNC_ACTIONS = ['commit', 'pull'] as const;
export const CaseSyncActionSchema = z.enum(CASE_SYNC_ACTIONS);
export type CaseSyncAction = z.infer<typeof CaseSyncActionSchema>;

/** 一次同步的状态快照（`GET /api/cases/sync-status` 与两个动作接口的响应同一形状） */
export interface CaseSyncStatus {
  /** `casesRoot` **本身**是不是 git 仓库根（不是则整块功能不可用，开关置灰） */
  isRepo: boolean;
  /** 仓库有没有配置远端（没有则只提交到本地，「拉取」按钮不存在） */
  hasRemote: boolean;
  /**
   * 现在**为什么提交不了**（非 git 仓库 / 未配置评分配置）；null = 可以提交。
   * 「没有远端」不在这里：它挡不住提交，只挡推送（见 `hasRemote`）。
   */
  blockedReason: string | null;
  /** 后台是否正在跑一次同步（手动按钮的 loading 也读它） */
  running: boolean;
  /** 最近一次尝试的时间（ISO）；从未跑过为 null */
  lastAttemptAt: string | null;
  /** 最近一次成功的时间（ISO；含「无变更可提交」的成功） */
  lastSuccessAt: string | null;
  /** 最近一次成功提交的短 hash（无提交可做时为 null） */
  lastCommit: string | null;
  /** 最近一次失败的中文原因（成功后清空） */
  lastError: string | null;
  /** 待提交的**用例**文件数（新增 / 修改 / 删除都算） */
  pendingCount: number;
  /** 被忽略的无关变更数（casesRoot 下的非用例文件；它们永不进提交，但要让用户看得见） */
  ignoredCount: number;
  /** 远端领先的提交数；**null = 本次没探到**（离线 / 没有上游），不是「没有」 */
  remoteAhead: number | null;
  /** 本地未推送的提交数 */
  localAhead: number;
}
