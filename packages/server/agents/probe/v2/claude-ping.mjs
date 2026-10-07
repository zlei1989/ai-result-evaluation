/**
 * 最小连通性检查：一条不含工具的短提示词。
 *
 * 为什么要它：`claude-task-tools` 连续三次拿到助手正文 `"Request timed out"`
 * （`terminal_reason: 'api_error'`，且 11 次 `api_retry`），需要把
 * 「上游当前是否可用」与「那个提示词有问题」分开。
 */
import { note } from './lib/gateway.mjs';
import { makeClaudeWorkspace, runClaudeProbe } from './lib/claude.mjs';
import { CLAUDE_BASE_URL } from './lib/claude.mjs';

note('base URL =', CLAUDE_BASE_URL);
const run = await runClaudeProbe({
  label: 'ping',
  prompt: '回答一个字：好',
  workspace: makeClaudeWorkspace(),
  maxTurns: 2,
});
const result = run.messages.filter((one) => one?.type === 'result').at(-1) ?? null;
note('assistant 文本 =', JSON.stringify(run.messages.filter((one) => one?.type === 'assistant').map((one) => one.message?.content)).slice(0, 400));
note('result 摘要 =', JSON.stringify({ terminal_reason: result?.terminal_reason, is_error: result?.is_error, result: result?.result }).slice(0, 400));
