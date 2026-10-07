/**
 * **环境信息模型**（设计 §4.3）：一个智能体运行在什么环境里——与「执行日志」解耦，
 * 但由 `agent-log` 负责展示。
 *
 * 为什么它是独立模型、不是 `AgentLogModel` 的一部分（§4.3 的两条理由，都实测过）：
 *   · **体积**：厂商系统提示词与工具模式串可能是几十 KB（实测单个 `probe/dumps/dsh.json`
 *     就有 237 KB）——并进主模型意味着**每次流式提交都在搬它**；
 *   · **时机**：它只在环境抽屉打开时才需要。
 *   ⇒ 由调用方按需取、按 `Loadable` 注入（「UI 不做取数」同一条边界：UI 只渲染给到的形状）。
 *
 * **落点在 contracts 而不是 ui**（2026-10-03 修正，设计 §4.3 的原文就是这里）：
 * 这些名字里没有一个界面词汇——不存在色档、折叠键、渲染块那一类东西，
 * 全是「这次运行被下发了什么」的事实。放在 ui 里会让**服务端永远造不出这个对象**，
 * 而它是排障要看的第一个东西。UI 侧继续从 `@aieval/ui` 转出同名类型，消费方不必改路径。
 */
import { z } from 'zod';
import { MissingReasonSchema } from './agent-message';

/**
 * 一组环境信息。`source` 是**必须**的：它回答「这条要求是谁下发的」，
 * 而这正是把用户层 / 厂商系统层 / 运行配置 / 实测统计分开展示的全部理由（§4.3 D17）。
 */
export const EnvSourceSchema = z.enum(['user', 'project', 'vendor', 'observed']);
export type EnvSource = z.infer<typeof EnvSourceSchema>;

/**
 * 一条环境信息。`present: false` 时 **`missing` 必填**——「这一格没有」必须带原因，
 * 否则与「有但是空的」在界面上长得一样（v2 §4 的整节口径）。
 */
export const EnvItemSchema = z.discriminatedUnion('present', [
  z.object({
    present: z.literal(true),
    id: z.string(),
    label: z.string(),
    /** 长文本（系统提示词、工具模式串、被禁用的工具名单）按**原文**给 */
    text: z.string(),
    /** 由数据层按上限截断（＝「**UI 不判断大小**」）；`null` = 完整 */
    truncated: z.object({ reason: z.string(), bytes: z.number() }).nullable(),
    /** 约定路径：非空时界面额外给「复制」按钮 */
    copyPath: z.string().optional(),
    at: z.string().nullable(),
  }),
  z.object({
    present: z.literal(false),
    id: z.string(),
    label: z.string(),
    missing: MissingReasonSchema,
  }),
]);
export type EnvItem = z.infer<typeof EnvItemSchema>;

export const EnvGroupSchema = z.object({
  id: z.string(),
  /** 组名由数据层给（**不硬编码在组件里**）：换个消费场景时组名与分组可以不同 */
  title: z.string(),
  source: EnvSourceSchema,
  items: z.array(EnvItemSchema),
});
export type EnvGroup = z.infer<typeof EnvGroupSchema>;

/**
 * 一行摘要（环境抽屉的抬头）：谁 · 哪个模型 · 哪一档权限。
 *
 * 七格全部来自 `EvalRow` / `EvalRun` 的快照字段——**服务端已经存了**，
 * 故这一组不需要读事件流（真机逐字段核过）。
 */
export const AgentEnvironmentSummarySchema = z.object({
  agentKind: z.string(),
  modelId: z.string(),
  /** 我们**要求**的档位，不是实际生效的档位（厂商可能静默降档，spec §9 第 7 条） */
  effort: z.string().nullable(),
  providerName: z.string(),
  baseUrl: z.string(),
  workspaceBase: z.string(),
  baselineCommit: z.string(),
});
export type AgentEnvironmentSummary = z.infer<typeof AgentEnvironmentSummarySchema>;

export const AgentEnvironmentSchema = z.object({
  summary: AgentEnvironmentSummarySchema,
  groups: z.array(EnvGroupSchema),
});
export type AgentEnvironment = z.infer<typeof AgentEnvironmentSchema>;
