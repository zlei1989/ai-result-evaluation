/**
 * v4 探测 #2：**打开子智能体文本转发**（`forwardSubagentText: true`）之后，侧链 `assistant` 消息是不是
 * 「每条都到、每条都带 usage」—— 这是「不读文件也能给子会话算出三元组 + 轮次」的唯一凭据。
 *
 * 判据（逐条打印原始形态，不下结论在前）：
 *   ① 侧链 assistant 条数 vs 主循环 assistant 条数；
 *   ② 每条侧链消息的 `message.id` / `parent_tool_use_id` / `message.usage` 原文；
 *   ③ 按 `parent_tool_use_id` 分组、按 `message.id` 去重（同 id 后到覆盖先到）后：**该子会话的三元组累计与
 *      去重 id 数（= 它自己的轮次数）**；
 *   ④ 与 `system/task_notification.usage.total_tokens` 对账（差多少、方向如何）；
 *   ⑤ 与探测 #1（未打开转发）的侧链条数对比：转发开关到底多给了什么。
 *
 * 用法：node probe/v4/claude-subagent-usage-forward.mjs
 * 产物：probe/dumps/v4/claude-subagent-usage-fwd.jsonl（原始流）+ .json（分析）
 */
import { note, writeDump } from './lib/env.mjs';
import { DEEPSEEK_MODEL, runClaudeSdk } from './lib/claude.mjs';

const PROMPT = [
  'Call the Task tool exactly once to launch one subagent.',
  'The subagent instruction must be: "Run this exact shell command and report its stdout only: node -e \\"console.log(6*7)\\""',
  'After the subagent returns, reply with exactly: DONE',
].join(' ');

const out = await runClaudeSdk({
  label: 'subagent-usage-fwd',
  prompt: PROMPT,
  model: DEEPSEEK_MODEL,
  maxTurns: 20,
  timeoutMs: 300_000,
  // 关键的一格：让子智能体的文本/思考也转发（默认只转发 tool_use / tool_result 块）
  extraOptions: { forwardSubagentText: true },
});

const messages = out.messages;
const trioOf = (usage) => {
  if (usage === null || typeof usage !== 'object') return null;
  const input = usage.input_tokens;
  const cached = usage.cache_read_input_tokens ?? usage.cached_input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return { input, cached: typeof cached === 'number' ? cached : 0, output };
};
const isAllZero = (t) => t !== null && t.input === 0 && t.cached === 0 && t.output === 0;

const assistants = messages.filter((one) => one?.type === 'assistant');
const side = assistants.filter((one) => typeof one?.parent_tool_use_id === 'string' && one.parent_tool_use_id !== '');

/** 每个子会话：按 message.id 去重（后到覆盖先到），得到累计三元组 + 去重 id 数 */
const perParent = new Map();
for (const one of side) {
  const parent = one.parent_tool_use_id;
  const bucket = perParent.get(parent) ?? { byId: new Map(), messages: 0, seenUsage: 0, zeroOnly: 0 };
  bucket.messages += 1;
  const t = trioOf(one.message?.usage);
  if (t === null) {
    bucket.byId = bucket.byId;
  } else if (isAllZero(t)) {
    bucket.zeroOnly += 1;
  } else {
    bucket.seenUsage += 1;
    const id = one.message?.id;
    if (typeof id === 'string' && id !== '') bucket.byId.set(id, t);
  }
  perParent.set(parent, bucket);
}

const summary = [...perParent.entries()].map(([parent, bucket]) => {
  let input = 0, cached = 0, output = 0;
  for (const t of bucket.byId.values()) { input += t.input; cached += t.cached; output += t.output; }
  return {
    parentToolUseId: parent,
    侧链消息条数: bucket.messages,
    带非零usage的条数: bucket.seenUsage,
    全0快照条数: bucket.zeroOnly,
    去重后轮次数: bucket.byId.size,
    累计三元组: bucket.byId.size === 0 ? null : { input, cached, output },
  };
});

const notifications = messages
  .filter((one) => one?.type === 'system' && (one?.subtype === 'task_notification' || one?.subtype === 'task_progress'))
  .map((one) => ({ subtype: one.subtype, taskId: one.task_id, usage: one.usage ?? null }));

const sideSample = side.map((one) => ({
  parent: one.parent_tool_use_id,
  id: one.message?.id ?? null,
  usage: one.message?.usage ?? '（缺失）',
  contentTypes: Array.isArray(one.message?.content) ? one.message.content.map((b) => b?.type) : null,
}));

const record = {
  at: new Date().toISOString(),
  model: DEEPSEEK_MODEL,
  forwardSubagentText: true,
  error: out.error,
  messageCount: messages.length,
  主循环assistant条数: assistants.length - side.length,
  侧链assistant条数: side.length,
  每个子会话: summary,
  侧链逐条样例: sideSample.slice(0, 12),
  任务通知: notifications,
  对照探测1: '探测 #1（未开转发）侧链只有 1 条（contentTypes=[tool_use]）',
  jsonl: out.file,
};

const file = writeDump('v4/claude-subagent-usage-fwd', record);

note('=== 探测 #2 速览（forwardSubagentText: true）===');
note('  主循环 assistant =', record.主循环assistant条数, '| 侧链 assistant =', record.侧链assistant条数);
note('  每个子会话 =', JSON.stringify(summary, null, 2));
note('  任务通知 =', JSON.stringify(notifications, null, 2));
note('  侧链逐条（前 12）=', JSON.stringify(sideSample.slice(0, 12), null, 2));
note('  落盘：', file);
