/**
 * v4 探测：**claude 子智能体的用量到底能从哪些通道拿到**（2026-10-05，用户提问驱动）。
 *
 * 要回答的问题：除了「收尾读 CLI 落盘的子会话文件」之外，**流里**有没有别的路？
 * 逐条验（每条都打印原始形态，不下结论在前）：
 *   ① 侧链 `assistant` 消息（`parent_tool_use_id` 非空）的 `message.usage` —— 在不在？是不是全 0 快照？能不能按
 *      `message.id` 去重求出「该子会话到目前」的累计？
 *   ② `system/task_notification` 的 `usage`（登记过 `total_tokens` / `tool_uses` / `duration_ms`
 *      —— 到底是哪些键？够不够填 input/cached/output 三元组？）；
 *   ③ `result.usage` 的覆盖面：把主循环逐条按 id 求和、子链逐条按 id 求和，看 `result.usage` 等于哪一个；
 *   ④ `result.modelUsage`（按模型的合计）的覆盖面与键名；
 *   ⑤ 其余任何提到 token/usage 的流内消息（`system` 各 subtype 的键名全打印）。
 *
 * 口径与判据（本仓的硬规矩）：
 *   · 「按 id 去重求和」与适配器同源（流式快照共享同一个 `message.id`，同 id 后到覆盖先到）；
 *   · **一条都不许编**：缺就说缺，全 0 快照按「还没填好」处理（与 `estimateTokens` 同一条处置）；
 *   · 只跑**一轮**真实任务（成本与时间都要可控）。
 *
 * 用法：node probe/v4/claude-subagent-usage-channels.mjs
 * 产物：probe/dumps/v4/claude-subagent-usage.jsonl（原始流）+ probe/dumps/v4/claude-subagent-usage.json（分析）
 */
import { note, writeDump } from './lib/env.mjs';
import { DEEPSEEK_MODEL, runClaudeSdk } from './lib/claude.mjs';

/** 强制派一个子智能体：任务极小（一条 shell），但必须经过 Task 工具 */
const PROMPT = [
  'Call the Task tool exactly once to launch one subagent.',
  'The subagent instruction must be: "Run this exact shell command and report its stdout only: node -e \\"console.log(6*7)\\""',
  'After the subagent returns, reply with exactly: DONE',
].join(' ');

const out = await runClaudeSdk({
  label: 'subagent-usage',
  prompt: PROMPT,
  model: DEEPSEEK_MODEL,
  maxTurns: 20,
  timeoutMs: 300_000,
});

const messages = out.messages;

// ── 工具：把 usage 归一成一个可比较的三元组（只读原始键名，不做任何猜测）

const trioOf = (usage) => {
  if (usage === null || typeof usage !== 'object') return null;
  const input = usage.input_tokens;
  const cached = usage.cache_read_input_tokens ?? usage.cached_input_tokens;
  const output = usage.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return { input, cached: typeof cached === 'number' ? cached : 0, output };
};

const isAllZero = (t) => t !== null && t.input === 0 && t.cached === 0 && t.output === 0;

/** 按 message.id 去重求和（同 id 后到覆盖先到）—— 与适配器 estimateTokens 同一条规则 */
const sumById = (list) => {
  const byId = new Map();
  for (const one of list) {
    const t = trioOf(one?.usage);
    if (t === null) continue;
    if (isAllZero(t)) continue; // 全 0 快照 = 还没填好
    const id = one?.id;
    if (typeof id !== 'string' || id === '') continue; // 没有归并键就不出数
    byId.set(id, t);
  }
  if (byId.size === 0) return null;
  const total = { input: 0, cached: 0, output: 0 };
  for (const t of byId.values()) {
    total.input += t.input;
    total.cached += t.cached;
    total.output += t.output;
  }
  return { ...total, distinctIds: byId.size };
};

// ── ① 侧链 vs 主循环的 assistant 消息

const assistants = messages.filter((one) => one?.type === 'assistant');
const mainAssistants = assistants.filter((one) => one?.parent_tool_use_id === null || one?.parent_tool_use_id === undefined);
const sideAssistants = assistants.filter((one) => typeof one?.parent_tool_use_id === 'string' && one.parent_tool_use_id !== '');
const sideByParent = new Map();
for (const one of sideAssistants) {
  const key = one.parent_tool_use_id;
  const bucket = sideByParent.get(key) ?? [];
  bucket.push(one.message ?? {});
  sideByParent.set(key, bucket);
}

// ── ② system 各 subtype（尤其 task_notification）；③④ result 的两格

const systems = messages.filter((one) => one?.type === 'system');
const systemShapes = systems.map((one) => ({
  subtype: one?.subtype ?? null,
  keys: Object.keys(one).sort(),
  taskId: one?.task_id ?? null,
  toolUseId: one?.tool_use_id ?? null,
  status: one?.status ?? null,
  usage: one?.usage ?? null,
  summary: typeof one?.summary === 'string' ? one.summary.slice(0, 120) : null,
}));

const result = out.result ?? null;
const mainSum = sumById(mainAssistants.map((one) => one.message ?? {}));
const sideSums = [...sideByParent.entries()].map(([parentId, list]) => ({
  parentToolUseId: parentId,
  sum: sumById(list),
  messages: list.length,
}));
const sideTotal = (() => {
  const all = sideSums.map((one) => one.sum).filter((one) => one !== null);
  if (all.length === 0) return null;
  return all.reduce(
    (acc, one) => ({ input: acc.input + one.input, cached: acc.cached + one.cached, output: acc.output + one.output, distinctIds: acc.distinctIds + one.distinctIds }),
    { input: 0, cached: 0, output: 0, distinctIds: 0 },
  );
})();

const covers = (() => {
  const r = trioOf(result?.usage);
  if (r === null) return 'result.usage 不存在或形状不认识';
  const eq = (a, b) => a !== null && b !== null && a.input === b.input && a.cached === b.cached && a.output === b.output;
  if (eq(r, mainSum)) return 'result.usage == 主循环逐条求和（**不含**侧链）';
  if (eq(r, sideTotal)) return 'result.usage == 侧链逐条求和（含子智能体）';
  if (mainSum !== null && sideTotal !== null
    && r.input === mainSum.input + sideTotal.input
    && r.cached === mainSum.cached + sideTotal.cached
    && r.output === mainSum.output + sideTotal.output) return 'result.usage == 主 + 侧链（含子智能体）';
  return '两者都不等（见下面的原始数字）';
})();

// ── ⑤ 任何提到 usage 的关键字的其他消息

const otherUsageHits = messages
  .filter((one) => one?.type !== 'assistant' && one?.type !== 'system')
  .map((one) => ({ type: one?.type, subtype: one?.subtype ?? null, hasUsage: JSON.stringify(one).includes('"usage"') }))
  .filter((one) => one.hasUsage);

const record = {
  at: new Date().toISOString(),
  model: DEEPSEEK_MODEL,
  prompt: PROMPT,
  error: out.error,
  messageCount: messages.length,
  messageTypes: messages.map((one) => `${one?.type}${one?.subtype ? `/${one.subtype}` : ''}${one?.parent_tool_use_id ? '(side)' : ''}`),
  ch1_sidechain: {
    主循环assistant条数: mainAssistants.length,
    侧链assistant条数: sideAssistants.length,
    侧链分组: sideSums,
    sidechainSample: sideAssistants.slice(0, 3).map((one) => ({
      parent: one.parent_tool_use_id,
      id: one.message?.id ?? null,
      usage: one.message?.usage ?? '（message.usage 缺失）',
      contentTypes: Array.isArray(one.message?.content) ? one.message.content.map((b) => b?.type) : null,
    })),
    // 主循环的样例（对照组，证明「usage 在这条流上本来长什么样」）
    主循环样例usage: mainAssistants.slice(0, 3).map((one) => ({ id: one.message?.id ?? null, usage: one.message?.usage ?? '（缺失）' })),
  },
  ch2_system: systemShapes,
  ch3_result: {
    subtype: result?.subtype ?? null,
    usage: result?.usage ?? '（result.usage 缺失）',
    modelUsage: result?.modelUsage ?? '（result.modelUsage 缺失）',
    主循环求和: mainSum,
    侧链求和: sideTotal,
    覆盖面判定: covers,
    numTurns: result?.num_turns ?? null,
  },
  ch4_otherUsageMessages: otherUsageHits,
  jsonl: out.file,
  workspace: out.workspace,
};

const file = writeDump('v4/claude-subagent-usage', record);

note('=== 结论速览 ===');
note('  消息总数 =', messages.length, '| 主循环 assistant =', mainAssistants.length, '| 侧链 assistant =', sideAssistants.length);
note('  ① 侧链 message.usage 样例 =', JSON.stringify(record['ch1_sidechain'].侧链样例usage, null, 2));
note('  ② system subtype/keys =', JSON.stringify(systemShapes.map((one) => `${one.subtype}:${one.keys.join(',')}`), null, 2));
note('  ③ result.usage =', JSON.stringify(result?.usage ?? null), '| 判定 =', covers);
note('  ③ result.modelUsage =', JSON.stringify(result?.modelUsage ?? null));
note('  ④ 其它带 usage 的消息 =', JSON.stringify(otherUsageHits));
note('  落盘：', file);
