/**
 * 设计稿 §7.7.2 / §7.7.7 / §9.3 的 dsh 行（真机项）：
 * `assistant/message → data.usage.reasoningTokens` **从未被观测到** ⇒ `usageCapability.thinkingTokens`
 * 对 dsh 一直只能声明 `'unverified'`。
 *
 * 本脚本用**真实 harness + 我们自己的 pi-ai 路由**跑两档，判据是**逐字看 usage 的键**：
 *   A) openai-responses + `deepseek-reasoner`（`wire-usage-shape.mjs` 已证上游这条 wire 会给
 *      `output_tokens_details.reasoning_tokens = 31`）⇒ 看 dsh 是否把它投影成 `reasoningTokens`；
 *   B) anthropic-messages + `deepseek-reasoner`（上游这条 wire **完全没有**思考 token 字段）⇒ 对照档，
 *      用于区分「dsh 不投影」与「上游不给」——这正是 §9.4.1 要求的"先证明链路"。
 *
 * 用法：node probe/v4/dsh-reasoning-tokens.mjs
 */
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_OPENAI_BASE_URL, note, writeDump } from './lib/env.mjs';
import { runDshTurn } from './lib/dsh-harness.mjs';

const PROMPT = 'A farmer has 17 sheep and all but 9 run away. How many are left? Think step by step, then answer with just the number.';

/** 把一次 run 的 assistant/message usage 全部抠出来（逐字）。 */
function usagesOf(notifications) {
  const rows = [];
  for (const one of notifications) {
    const event = one?.params?.event;
    if (event?.type === 'assistant/message' && event?.data?.usage !== undefined) {
      rows.push({
        usage: event.data.usage,
        usageKeys: Object.keys(event.data.usage),
        reasoningKeys: Object.keys(event.data.usage).filter((key) => /reason/i.test(key)),
      });
    }
  }
  return rows;
}

const cases = [
  { label: 'reasoning-openai-responses', protocolType: 'openai', baseUrl: DEEPSEEK_OPENAI_BASE_URL, model: 'deepseek-reasoner' },
  { label: 'reasoning-anthropic-messages', protocolType: 'anthropic', baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL, model: 'deepseek-reasoner' },
];

const results = [];
for (const one of cases) {
  note('===== 跑', one.label, `(${one.protocolType} / ${one.model}) =====`);
  const run = await runDshTurn({ ...one, prompt: PROMPT, effort: 'high', timeoutMs: 300_000 });
  const usages = usagesOf(run.notifications);
  note(`${one.label} usage 样本 ${usages.length} 条：`, JSON.stringify(usages.slice(0, 4)));
  results.push({
    ...one,
    error: run.error,
    notifications: run.notifications.length,
    dumpFile: run.dumpFile,
    usages,
    reasoningFieldPresent: usages.some((row) => row.reasoningKeys.length > 0),
    reasoningValues: [...new Set(usages.flatMap((row) => row.reasoningKeys.map((key) => row.usage[key])))],
  });
}

const verdict = {
  openaiResponses: results[0].reasoningFieldPresent
    ? `dsh **投影了** 思考 token：字段 ${JSON.stringify(results[0].usages[0]?.reasoningKeys ?? [])}，取值 ${JSON.stringify(results[0].reasoningValues)}`
    : 'dsh **没有**把上游的 reasoning_tokens 投影进 TokenUsage（上游给了、dsh 不给）',
  anthropicMessages: results[1].reasoningFieldPresent
    ? `dsh 在 anthropic 线上也给了思考 token：取值 ${JSON.stringify(results[1].reasoningValues)}`
    : 'anthropic 线上没有这一格（与上游一致：DeepSeek 的 anthropic wire 本来就不返回思考 token）',
};

note('判定 A（openai-responses）：', verdict.openaiResponses);
note('判定 B（anthropic）：', verdict.anthropicMessages);

const file = writeDump('v4/dsh-reasoning-tokens', { at: new Date().toISOString(), prompt: PROMPT, results, verdict });
note('落盘：', file);
