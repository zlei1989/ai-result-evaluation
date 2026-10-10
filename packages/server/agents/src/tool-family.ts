/**
 * **工具名 → 族** 的映射表，本仓唯一一份。
 *
 * 为什么单独一个文件：这张表有两个消费方（`message.ts` 的工具块归一、`activity.ts` 的摘要词表），
 * 而它们互相依赖（`message.ts` 要 `toolCallSummary`、`activity.ts` 要 `classifyTool`）。
 * 表留在任何一边都会造成**循环 import**——运行时表现为「某个函数是 undefined」，
 * 只在某一条 import 顺序下复现，是最难查的一类。表放这里，两边都只依赖它。
 *
 * 判据是**按名字查表、不按家判**：名字是否出现由各家的配置与模型决定，不影响映射本身
 * （`MultiEdit` / `LS` / `PowerShell` / `subagent_fork` 在当前工具表里不出现，但它们是同族的
 * 另一种叫法，映射要在表里）。按名字查不到就落 `null`，消费方走通用渲染——**不猜一个族**：
 * 猜错的表现是「同一族的卡片在某一家上显示成别的族」，而所有包的用例照样全绿。
 */
import type { ToolFamily } from '@aieval/contracts';

const TOOL_FAMILY_BY_NAME: Record<string, ToolFamily> = {
  // claude-code
  Read: 'read-file',
  Write: 'write-file',
  Edit: 'edit-file',
  MultiEdit: 'edit-file',
  NotebookEdit: 'edit-file',
  Grep: 'search-content',
  Glob: 'list-files',
  LS: 'list-files',
  Bash: 'run-shell',
  PowerShell: 'run-shell',
  WebSearch: 'web-search',
  WebFetch: 'web-search',
  Task: 'spawn-agent',
  Agent: 'spawn-agent',
  TaskCreate: 'task',
  TaskUpdate: 'task',
  TaskList: 'task',
  TaskGet: 'task',
  TodoWrite: 'task',
  AskUserQuestion: 'ask-user',
  // codex（真名只在会话文件里；事件流的条目名也在这里登记，事件流那条通道只有派生名可用）
  exec_command: 'run-shell',
  shell: 'run-shell',
  command_execution: 'run-shell',
  write_stdin: 'run-shell',
  web_search: 'web-search',
  spawn_agent: 'spawn-agent',
  collab_tool_call: 'spawn-agent',
  update_plan: 'task',
  request_user_input: 'ask-user',
  // dsh
  // `bash` 与 `pwsh` 是**同一件事的两个名字**（0.2.0-rc.2 里 `pwsh` 与 `bash` 都是 DSH 自带的
  // 命令工具，真机这批数据里出现的全是 `bash`）⇒ 两个名字都要登记，只留一个会让另一家的
  // 调用落进「不认识的工具」那一档（摘要退化成紧凑 JSON、族标签也不显示）。
  read: 'read-file',
  write: 'write-file',
  edit: 'edit-file',
  grep: 'search-content',
  glob: 'list-files',
  pwsh: 'run-shell',
  bash: 'run-shell',
  web_fetch: 'web-search',
  subagent: 'spawn-agent',
  subagent_fork: 'spawn-agent',
  todo_write: 'task',
  ask_user_question: 'ask-user',
};

/**
 * 按工具名归族；判不出来返回 `null`。
 * `mcp__<server>__<tool>` 形态（三家一致的命名）**不进这十族**：它承载的是任意 MCP 工具，
 * 猜一个族等于编一个事实（归不进任何一族就 `family: null`、`name` 保留原名）。
 */
export function classifyTool(name: string): ToolFamily | null {
  return TOOL_FAMILY_BY_NAME[name] ?? null;
}
