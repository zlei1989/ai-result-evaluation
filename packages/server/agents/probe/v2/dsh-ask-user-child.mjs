/**
 * dsh 真机项④（场景②单独重跑）：**子智能体调用 `ask_user_question` 是否被拒**。
 *
 * 上一轮这条因 `RequestTimeoutError: initialize timed out after 10000ms` 没跑起来
 * （冷启动解析 profile 插件树超时，已在 `lib/dsh.mjs` 放开到 60s），这里单独重跑。
 *
 * 设计要求验证的逐字口径（`@deepseek-ai/dsh-tool-ask-user`）：
 * 「A live child agent owned by another agent **cannot call this tool** and must report
 *  unresolved questions in its final result」——错误码 `DELEGATED_CALLER`。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from './lib/gateway.mjs';
import { runDshProbe, summarize } from './lib/dsh.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'aieval-v2-ask2-'));
note('工作区 =', workspace);

const prompt = [
  '调用 subagent 工具（`run_in_background` 用 false，等它返回结果）派生一个子智能体：',
  'description 填 "Ask parent user"，prompt 填下面这段（一字不改）：',
  '---',
  '请调用 ask_user_question 工具向用户提一个问题：id 用 "child_confirm"，question 用「子任务该继续吗？」。',
  '如果这次调用失败或被拒绝，请把失败返回的**原文**一字不改地放进你的最终答复里。',
  '---',
  '拿到子智能体的结果后，用一句话原样转述它报告的失败原文。**你自己不要调用 ask_user_question**。',
].join('\n');

const run = await runDshProbe({ label: 'ask-user-child2', prompt, workspace, settleMs: 90000, timeoutMs: 600000 });

note('通知分布：');
for (const [key, count] of summarize(run.notifications)) note('  ·', key, '×', count);
note('最终答复 =', JSON.stringify(run.result?.finalResponse ?? null).slice(0, 800));
if (run.error !== null) note('run 抛错：', run.error.name, run.error.message.slice(0, 300));

const pairs = [];
for (const one of run.notifications) {
  const event = one?.params?.event;
  if (event?.type === 'tool/call' && event.data?.name === 'ask_user_question') {
    pairs.push({ kind: 'call', callId: event.data.callId, arguments: event.data.arguments });
  }
  if (event?.type === 'tool/result') {
    pairs.push({
      kind: 'result',
      toolCallId: event.data?.message?.toolCallId,
      isError: event.data?.message?.isError ?? null,
      text: event.data?.message?.content ?? null,
    });
  }
}
for (const pair of pairs) note('  ·', pair.kind, JSON.stringify(pair).slice(0, 600));

const file = writeDump('v2/dsh-ask-user-child', {
  at: new Date().toISOString(),
  workspace,
  prompt,
  error: run.error,
  finalResponse: run.result?.finalResponse ?? null,
  pairs,
});
note('→', file);
