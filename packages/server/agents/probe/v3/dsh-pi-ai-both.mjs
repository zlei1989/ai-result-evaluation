/**
 * **两条 wire 的真机端到端**，都用**产品自己的供应商记录**跑。
 *
 * 为什么要读 `~/.aieval/config.json` 而不是自己编一份：探测与生产必须是同一份事实——
 * 自编的 baseUrl / model 一旦与产品不同，「跑通了」证明的是另一件事。本机产品的两条记录是：
 *   · `deepseek`（protocolType **openai**，baseUrl `https://api.deepseek.com/`，模型 `deepseek-flash`）
 *   · `deepseek-anthropic`（protocolType **anthropic**，baseUrl `https://api.deepseek.com/anthropic`）
 * 两条 baseUrl 形态**恰好覆盖 D8 的两个归一化方向**：
 *   · openai：`https://api.deepseek.com/` **没有** `/v1` ⇒ `ensureV1Suffix` 必须补上，否则打到 `{root}/responses`；
 *   · anthropic：`…/anthropic` 本来就没有 `/v1` ⇒ `stripV1Suffix` 是恒等，pi-ai 追加 `/v1/messages`。
 *
 * 判据（两条 wire 各自独立判定，缺一不可）：
 *   · `result.finalResponse` 非空；
 *   · 通知里有 `turn/end` 且 `reason.kind === 'completed'`；
 *   · 采到 `assistant/message` 的 usage（「跑完了但没计量」不算通过）。
 *
 * 用法：`node probe/v3/dsh-pi-ai-both.mjs [anthropic|openai|both]`（默认 both）。
 */
import { loadProductProvider, note, writeDump } from './lib/gateway.mjs';
import { extractUsage, runPiAiRoute, ROUTE_API_KEY_ENV, ROUTE_KEY } from './lib/harness.mjs';

const which = process.argv[2] ?? 'both';
const prompt = '回答一个字：好。不要调用任何工具，不要写文件。';

/** 跑一条协议并折成结论（不抛：失败也要能落盘）。 */
async function probe(protocolType) {
  const provider = loadProductProvider(protocolType);
  note(`供应商「${provider.name}」：协议=${protocolType}，baseUrl=${provider.baseUrl}，模型=${provider.model}`);
  const run = await runPiAiRoute({
    label: `pi-ai-${protocolType}`,
    protocolType,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    contextWindow: provider.contextWindow,
    maxTokens: provider.maxOutputTokens,
    prompt,
  });
  const { usages, failures } = extractUsage(run.notifications);
  const completed = run.notifications.some((one) => one?.params?.event?.type === 'turn/end'
    && one?.params?.event?.data?.reason?.kind === 'completed');
  const ok = run.error === null && completed && usages.length > 0
    && typeof run.result?.finalResponse === 'string' && run.result.finalResponse !== '';
  return {
    protocolType,
    provider: { name: provider.name, baseUrl: provider.baseUrl, model: provider.model },
    overlay: run.overlay,
    finalResponse: run.result?.finalResponse ?? null,
    error: run.error,
    completed,
    usages,
    failures,
    summary: run.summary,
    ok,
  };
}

const targets = which === 'both' ? ['anthropic', 'openai'] : [which];
const verdicts = [];
for (const target of targets) {
  note(`──────── ${target} ────────`);
  verdicts.push(await probe(target));
  note(verdicts.at(-1).ok ? `✅ ${target} 跑通（含计量）` : `❌ ${target} 未跑通`);
}

const file = writeDump('v3/dsh-pi-ai-verdict', {
  at: new Date().toISOString(),
  routeKey: ROUTE_KEY,
  apiKeyEnv: ROUTE_API_KEY_ENV,
  verdicts,
});
note('结论落盘：', file);
process.exitCode = verdicts.every((one) => one.ok) ? 0 : 1;
