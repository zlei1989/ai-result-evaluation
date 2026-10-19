/**
 * 行与事件**共用**的两份值域：行状态、MCP 通道。
 *
 * 为什么下沉成叶子：`run.ts` 要用它们，`agent-event.ts` 也要用（status 事件与 `vendor-system.mcpChannel`），
 * 而 `agent-event → run → agent-message → agent-event` 是个环。环上的模块在包根评估顺序里会撞 TDZ，
 * 症状是 `pnpm dev` 起来就退、任何页面都打不开，而**类型检查与按文件跑的用例都看不出来**。
 *
 * 值域只此一份：两处各写一个枚举必然漂移，漂移的表现是「同一个通道在两个地方叫两个名字」。
 *
 * ⚠️ **不要往这个文件里加任何 `./` 依赖**——它存在的全部理由就是不再引任何东西。
 */
import { z } from 'zod';

export const EvalRowStatusSchema = z.enum([
  'pending', 'preparing', 'running', 'judging', 'judged',
  'failed', 'timed-out', 'canceled', 'skipped', 'interrupted',
]);
export type EvalRowStatus = z.infer<typeof EvalRowStatusSchema>;

export const ROW_MCP_CHANNELS = ['vendor-status', 'vendor-startup-status', 'vendor-tool-table'] as const;
export const RowMcpChannelSchema = z.enum(ROW_MCP_CHANNELS);
export type RowMcpChannel = z.infer<typeof RowMcpChannelSchema>;
