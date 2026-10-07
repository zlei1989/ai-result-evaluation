/**
 * v4 / Q1(b) + Q5：**SDK 路径**（`query()`）能否跑通 DeepSeek 的 anthropic 端点。
 *
 * 判据：
 *   ① `query()` 是否被驱动完一轮、有没有 `type:"result"`；
 *   ② `result.usage` 的**原始键名**（Q5 要求：即使 DeepSeek 不返回 `thinking_tokens`，
 *      也要先打印原始 usage 形态再下结论）；
 *   ③ 抛错时逐字留 message/stack。
 *
 * 用法：node probe/v4/q1b-sdk-anthropic.mjs
 * 产物：probe/dumps/v4/q1b-sdk.json、probe/dumps/v4/claude-q1b-sdk.jsonl
 */
import { note, writeDump } from './lib/env.mjs';
import { DEEPSEEK_MODEL, runClaudeSdk } from './lib/claude.mjs';

const PROMPT = 'Reply with exactly this and nothing else: ok';

const runs = [];
for (const model of [DEEPSEEK_MODEL, 'deepseek-reasoner']) {
  const label = `q1b-sdk-${model}`;
  const out = await runClaudeSdk({
    label,
    prompt: PROMPT,
    model,
    maxTurns: 1,
    timeoutMs: 300_000,
  });

  const usage = out.result?.usage ?? null;
  const modelUsage = out.result?.modelUsage ?? null;
  const record = {
    label,
    model,
    messageCount: out.messages.length,
    messageTypes: out.messages.map((one) => `${one?.type}${one?.subtype ? `/${one.subtype}` : ''}`),
    error: out.error,
    initToolNames: Array.isArray(out.init?.tools) ? out.init.tools : null,
    result: out.result,
    // Q5：原始键名，不做任何解释
    usageKeys: usage === null ? 'usage 为 null/不存在' : Object.keys(usage),
    usageRaw: usage,
    outputTokensDetails: usage?.output_tokens_details ?? '（usage.output_tokens_details 不存在）',
    modelUsageKeys: modelUsage === null ? 'modelUsage 为 null/不存在' : Object.keys(modelUsage),
    modelUsageRaw: modelUsage,
    workspace: out.workspace,
    jsonl: out.file,
  };
  note(`== ${label} ==`);
  note('  messageTypes =', JSON.stringify(record.messageTypes));
  note('  error =', JSON.stringify(record.error));
  note('  result.subtype =', out.result?.subtype, '| result.result =', JSON.stringify(out.result?.result));
  note('  usage 原始键名 =', JSON.stringify(record.usageKeys));
  note('  usage 原始形态 =', JSON.stringify(usage));
  note('  output_tokens_details =', JSON.stringify(record.outputTokensDetails));
  runs.push(record);
}

const file = writeDump('v4/q1b-sdk', { at: new Date().toISOString(), prompt: PROMPT, runs });
note('落盘：', file);
