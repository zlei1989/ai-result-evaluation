/**
 * 智能体 id 与标签的**唯一真源**（原在 `run.ts`，为解开 `score.ts` ⇄ `run.ts` 的互引而拆出）。
 * 为什么单独一个文件：`ScoreResult` 要记「这一分是哪个智能体打的」，而 `run.ts` 已经 import
 * `score.ts`——把这张表留在 `run.ts` 会逼出一个模块环（zod 层面不一定炸，但依赖方向已经错了）。
 * 口径不变：真源仍然只有一份，`run.ts` 与包根都只是**再导出**。
 * 注意：清单顺序 = `agents` 注册表的 `listAgentProviders()` 顺序 = 前端下拉顺序，三者必须同序。
 */
import { z } from 'zod';

/** 三家智能体 id 的**唯一真源** */
export const AGENT_KINDS = ['claude-code', 'codex', 'dsh'] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = (typeof AGENT_KINDS)[number];

/** 智能体中文标签（设置页与候选池共用） */
export const AGENT_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
};
