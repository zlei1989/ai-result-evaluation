/**
 * 应用设置契约（服务端落盘 + 客户端展示共用）。
 * 注意：这是**服务端真源**——主题偏好虽然也在客户端 localStorage 里留一份用于首帧即时渲染，
 * 但判定真源仍是这里，客户端那份只是缓存。
 */
import { z } from 'zod';
import { AgentKindSchema } from './agent';

/** 主题偏好：auto=跟随操作系统、light=明亮、dark=暗色 */
export const ThemeModeSchema = z.enum(['auto', 'light', 'dark']);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

/** 默认评分模型：两个 id 必须成对出现，未配置时为 null */
export const DefaultJudgeSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  /**
   * 评分时**要求**的思考强度档位（可选）。缺省 = 未指定 ⇒ 一个强度键都不加（网关默认）。
   * 它的可选域由「模型声明 ∩ 评分智能体域」决定（`contracts/src/effort.ts`），
   * 存的是**上游词汇原样**（关闭档就是 `off`）。
   */
  effort: z.string().min(1).optional(),
});

export const SettingsSchema = z.object({
  theme: ThemeModeSchema,
  /** 工作区根目录（绝对路径）；目录不存在时由服务端创建 */
  workspaceRoot: z.string().min(1),
  /**
   * 用例根目录（绝对路径）：**一用例一文件**存在它下面（`<casesRoot>/<case-id>.json`）。
   * 用例已不再进 `config.json` 的 `cases` 数组，这里是它在磁盘上的唯一落点
   * （口径见 core 的 `case-store.ts`：原子写、容忍 BOM、id 形状校验）。
   * 「默认值从配置里取」这条优先级由服务端 `resolveCasesRoot` 承担：
   * 这一格为空 / 缺失时回落到 `AIEVAL_CASES_ROOT`，再回落到 `~/.aieval-cases`。
   */
  casesRoot: z.string().min(1),
  /**
   * 用例变更时是否自动在后台提交并推送（`casesRoot` 是 git 仓库时才有意义）。
   * 关掉之后用例照常落盘，但要到设置页点「提交」才进 git —— 两态都必须让用户看得见，
   * 不能出现「以为提交了、其实没提交」。
   */
  casesAutoCommit: z.boolean(),
  /** 全局默认评分模型；未配置时为 null（此时用例页的「AI 生成」与评测评分不可用） */
  defaultJudge: DefaultJudgeSchema.nullable(),
  /** 默认评分智能体：null = 未配置（此时「使用智能体评分」的评测会在创建时被拦下） */
  defaultJudgeAgent: AgentKindSchema.nullable(),
  /**
   * 送评分模型的 diff 体积上限（字节），超出按文件裁剪并标注截断。
   *
   * 注意这里**没有**「单行超时」这一格了（用户口径，2026-09-28）：执行与评分都不限时间，
   * 一行只会因为「跑完 / 失败 / 用户点终止」结束。旧 `config.json` 里多出来的 `rowTimeoutMs`
   * 在读盘时就被丢掉——**丢键的不是本 schema**：`loadConfig` 故意不做 schema 校验（一条手改坏的
   * 值不该让设置页打不开），它按 `SETTINGS_DEFAULTS` 的键表过滤（多出来的键丢掉，见 core 的
   * `normalizeSettings`）。本 schema 的 strip 语义只在**本文件被 `parse` 时**生效（契约测试走的
   * 正是那条路）。两条路径都不会把旧键带进运行时，故**不需要迁移脚本**。
   */
  diffBudgetBytes: z.number().int().positive(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** 部分更新：所有字段可选；空对象合法（无改动） */
export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** 默认值：workspaceRoot / casesRoot 的 `~` 由服务端在读取时展开为真实家目录 */
export const SETTINGS_DEFAULTS: Settings = {
  theme: 'auto',
  workspaceRoot: '~/.aieval-runs',
  casesRoot: '~/.aieval-cases',
  casesAutoCommit: true,
  defaultJudge: null,
  defaultJudgeAgent: null,
  diffBudgetBytes: 262_144,
};
