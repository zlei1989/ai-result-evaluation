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
});

export const SettingsSchema = z.object({
  theme: ThemeModeSchema,
  /** 工作区根目录（绝对路径）；目录不存在时由服务端创建 */
  workspaceRoot: z.string().min(1),
  /** 全局默认评分模型；未配置时为 null（此时用例页的「AI 生成」与评测评分不可用） */
  defaultJudge: DefaultJudgeSchema.nullable(),
  /** 默认评分智能体：null = 未配置（此时「使用智能体评分」的评测会在创建时被拦下） */
  defaultJudgeAgent: AgentKindSchema.nullable(),
  /**
   * 送评分模型的 diff 体积上限（字节），超出按文件裁剪并标注截断。
   *
   * 注意这里**没有**「单行超时」这一格了（用户口径，2026-09-28）：执行与评分都不限时间，
   * 一行只会因为「跑完 / 失败 / 用户点终止」结束。旧 `config.json` 里多出来的 `rowTimeoutMs`
   * 由 zod 的默认行为**丢弃**（对象 schema 会 strip 未知键），因此不需要迁移脚本。
   */
  diffBudgetBytes: z.number().int().positive(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** 部分更新：所有字段可选；空对象合法（无改动） */
export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** 默认值：workspaceRoot 的 `~` 由服务端在读取时展开为真实家目录 */
export const SETTINGS_DEFAULTS: Settings = {
  theme: 'auto',
  workspaceRoot: '~/.runs',
  defaultJudge: null,
  defaultJudgeAgent: null,
  diffBudgetBytes: 262_144,
};
