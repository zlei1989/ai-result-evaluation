/**
 * dsh 真机项④：`ask_user_question` 的**非正常收场**。
 *
 * 设计稿 §7.6.2 ⑩ 的两条硬约束都只有**文档级**依据（dsh 的 README/逐字文案），没有真机样本：
 *  - `outcome: 'unavailable'` ——「if no answer handler accepts it, the model receives an error」、
 *    「Without one, the tool call **fails with an error instead of degrading**」；
 *  - `outcome: 'rejected'` ——「A live child agent owned by another agent **cannot call this tool**
 *    and must report unresolved questions in its final result」（错误码 `DELEGATED_CALLER`）。
 *
 * 本仓（`approvalPolicy: 'never'`、无人应答）**必然走 `unavailable` 分支**——这是已知边界，
 * 但"必然"此前只是推断。本脚本跑两次：
 *  ① 主智能体直接问 → 抓 `tool/result` 的错误原文；
 *  ② 让子智能体去问 → 抓 `DELEGATED_CALLER`。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from './lib/gateway.mjs';
import { runDshProbe, summarize } from './lib/dsh.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'aieval-v2-ask-'));
note('工作区 =', workspace);

/** 从通知里抽出 `ask_user_question` 的调用与结果。 */
function askUserPairs(notifications) {
  const calls = new Map();
  const pairs = [];
  for (const one of notifications) {
    const event = one?.params?.event;
    if (event?.type === 'tool/call' && event.data?.name === 'ask_user_question') {
      calls.set(event.data.callId, event.data);
      pairs.push({ callId: event.data.callId, arguments: event.data.arguments, result: null, turn: event.data.turn, step: event.data.step });
    }
    if (event?.type === 'tool/result') {
      const id = event.data?.message?.toolCallId;
      const hit = pairs.find((pair) => pair.callId === id);
      if (hit !== undefined) hit.result = event.data;
    }
  }
  return pairs;
}

// ── 场景①：主智能体直接问用户（本仓没有应答面） ────────────────────────────────
const directPrompt = [
  '调用 ask_user_question 工具，问用户一个问题：',
  'id 用 "confirm"，question 用「是否继续？（A 继续 / B 停止）」，header 用「确认」，',
  'options 给两项：label「A 继续」与 label「B 停止」（各带一句 description）。',
  '拿到结果后，用一句话原样报告工具的返回内容（成功还是报错、报错原文是什么），不要重试。',
].join('\n');

const direct = await runDshProbe({ label: 'ask-user-direct', prompt: directPrompt, workspace, settleMs: 0 });
const directPairs = askUserPairs(direct.notifications);
note('直接问：调用', directPairs.length, '次；最终答复 =', JSON.stringify(direct.result?.finalResponse ?? null).slice(0, 300));
for (const pair of directPairs) {
  note('  arguments =', String(pair.arguments).slice(0, 300));
  note('  result.isError =', pair.result?.message?.isError ?? '【无 result】');
  note('  result.text =', JSON.stringify(pair.result?.message?.content ?? null).slice(0, 700));
}
note('直接问场景通知分布：');
for (const [key, count] of summarize(direct.notifications)) note('  ·', key, '×', count);

// ── 场景②：子智能体去问（应被拒：DELEGATED_CALLER） ────────────────────────────
const childPrompt = [
  '调用 subagent 工具（run_in_background 用 false，等它返回）派生一个子智能体：',
  'description 填 "Ask parent user"，prompt 填：',
  '「调用 ask_user_question 工具问用户一个问题（id 用 "child_confirm"，question 用「子任务该继续吗？」）。',
  '如果这个调用失败，就把失败的原文一字不改地写进你的最终答复里。」',
  '拿到子智能体的结果后，用一句话原样转述它报告的失败原文，不要自己重试 ask_user_question。',
].join('\n');

const child = await runDshProbe({ label: 'ask-user-child', prompt: childPrompt, workspace, settleMs: 60000 });
const childPairs = askUserPairs(child.notifications);
note('子任务问：调用', childPairs.length, '次；最终答复 =', JSON.stringify(child.result?.finalResponse ?? null).slice(0, 500));
for (const pair of childPairs) {
  note('  arguments =', String(pair.arguments).slice(0, 300));
  note('  result.isError =', pair.result?.message?.isError ?? '【无 result】');
  note('  result.text =', JSON.stringify(pair.result?.message?.content ?? null).slice(0, 700));
}
note('子任务问场景通知分布：');
for (const [key, count] of summarize(child.notifications)) note('  ·', key, '×', count);

const file = writeDump('v2/dsh-ask-user', {
  at: new Date().toISOString(),
  workspace,
  direct: { prompt: directPrompt, pairs: directPairs, error: direct.error, finalResponse: direct.result?.finalResponse ?? null },
  child: { prompt: childPrompt, pairs: childPairs, error: child.error, finalResponse: child.result?.finalResponse ?? null },
});
note('→', file);
