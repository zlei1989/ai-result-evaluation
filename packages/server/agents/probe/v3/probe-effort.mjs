/**
 * 档位接受度（v3）：`reasoningEfforts` 的 **wire 拼写**必须真机确认，不能拿类型面代替。
 *
 * 为什么这是 D5 的判据：注册表给 DSH 声明四档 `off/low/high/max`，而 pi-ai 把档位**原样**透传成
 * `reasoning: { effort: <拼写> }`（responses）/ 由档位名推预算（anthropic），**不做枚举校验**。
 * 网关不认的拼写会在**请求期**炸——正是本仓最忌讳的「界面能选、运行时才失败」。
 *
 * 两个观察面：
 *   · **HTTP 层**（本脚本）：`reasoning.effort` 取各拼写时网关的 status/报错原文；
 *   · **harness 层**（`probe-effort-harness.mjs`）：真实 pi-ai 路由跑一遍，看它到底发了什么。
 * 只有前者能回答「网关认哪些词」，只有后者能回答「pi-ai 会发哪个词」。
 *
 * 注意：`max` 不在 OpenAI SDK 的 `ReasoningEffort` 类型里（`none|minimal|low|medium|high|xhigh|null`），
 * 所以它是否被接受**只能**靠实测。
 */
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_MODEL,
  DEEPSEEK_OPENAI_BASE_URL,
  loadDeepSeekKey,
  note,
  writeDump,
} from './lib/gateway.mjs';

const KEY = loadDeepSeekKey();
/** DeepSeek 官方 API 的 Responses wire（2026-09-30 实测 200；pi-ai 会追加 `/responses`）。 */
const RESPONSES_URL = `${DEEPSEEK_OPENAI_BASE_URL}/responses`;
/** 同一条 Messages wire（pi-ai 会追加 `/v1/messages?beta=true`）。 */
const MESSAGES_URL = `${DEEPSEEK_ANTHROPIC_BASE_URL}/v1/messages`;
const MODEL = process.env.AIEVAL_PROBE_MODEL ?? DEEPSEEK_MODEL;

async function post(label, url, headers, body, timeoutMs = 90_000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = (await response.text()).slice(0, 400).replaceAll('\n', ' ');
    note(`${label} → HTTP ${response.status} ${text.slice(0, 160)}`);
    return { label, status: response.status, head: text };
  } catch (error) {
    const detail = String(error?.cause?.code ?? error?.message ?? error).slice(0, 200);
    note(`${label} → ERR ${detail}`);
    return { label, status: null, error: detail };
  }
}

const auth = { authorization: `Bearer ${KEY}` };
const results = [];

// 一、responses wire：逐个拼写试 `reasoning.effort`
for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
  results.push(await post(
    `responses reasoning.effort=${effort}`,
    RESPONSES_URL,
    auth,
    { model: MODEL, input: '回答一个字：好', max_output_tokens: 32, reasoning: { effort } },
  ));
}

// 二、anthropic wire：`thinking` 的三种形状（pi-ai 的 off / 预算路径都会用到）
const anthropic = { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' };
results.push(await post('messages thinking=disabled', MESSAGES_URL, anthropic, {
  model: MODEL, max_tokens: 64, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: '回答一个字：好' }],
}));
results.push(await post('messages thinking=enabled(1024)', MESSAGES_URL, anthropic, {
  model: MODEL, max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: '回答一个字：好' }],
}));
// 不带 thinking 字段（= 省略 off 键那条路的形状），作为对照
results.push(await post('messages 无 thinking 字段', MESSAGES_URL, anthropic, {
  model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: '回答一个字：好' }],
}));

const file = writeDump('v3/effort-matrix', { at: new Date().toISOString(), model: MODEL, results });
note('落盘：', file);
