/**
 * 端点矩阵（v3）：**这个网关到底讲哪几条 wire**。
 *
 * 为什么必须先跑它：`openai` 协议钉在 **Responses** wire 上
 * （`api: openai-responses`）。若该网关不提供 `/v1/responses`，
 * 「真机跑通 responses」就没有靶子，只能如实登记为环境缺口——
 * 而**不是**改用 chat-completions（那是用户口径里明确不要的那条）。
 *
 * 四格对照（同一把密钥、同一个模型族）：
 *   1. `GET  {base}/models`            OpenAI 风格清单（已知 200，复核用）
 *   2. `POST {base}/responses`         Responses wire（Bearer）
 *   3. `POST {base}/chat/completions`  Chat Completions（Bearer，对照用）
 *   4. `POST {origin}/v1/messages`     Anthropic Messages（x-api-key，已知 200，复核用）
 *
 * 只读 + 一次 16 token 的最小推理，不做任何写操作。
 */
import { fetchWithTimeout, GATEWAY_BASE_URL, GATEWAY_ORIGIN, loadGatewayKey, note, writeDump } from './lib/gateway.mjs';

const KEY = loadGatewayKey();
const PROMPT = '回答一个字：好';

/** 一条探测结果；异常一律收敛成字符串，不让脚本在这里挂掉。 */
async function post(label, url, headers, body, timeoutMs = 90_000) {
  try {
    const response = await fetchWithTimeout(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
      timeoutMs,
    );
    const text = (await response.text()).slice(0, 600).replaceAll('\n', ' ');
    note(`${label} → HTTP ${response.status} ${text.slice(0, 200)}`);
    return { label, url, status: response.status, head: text };
  } catch (error) {
    const detail = String(error?.cause?.code ?? error?.message ?? error).slice(0, 200);
    note(`${label} → ERR ${detail}`);
    return { label, url, status: null, error: detail };
  }
}

const results = [];

// 1. 清单：拿真实 model id 来发推理，避免「模型名不存在」污染结论
let modelIds = [];
try {
  const response = await fetchWithTimeout(`${GATEWAY_BASE_URL}/models`, { headers: { authorization: `Bearer ${KEY}` } }, 30_000);
  const text = await response.text();
  const parsed = JSON.parse(text);
  modelIds = (parsed?.data ?? []).map((one) => one?.id).filter((id) => typeof id === 'string');
  note(`GET /v1/models → HTTP ${response.status}，${modelIds.length} 条模型`);
  results.push({ label: 'GET /v1/models', url: `${GATEWAY_BASE_URL}/models`, status: response.status, modelCount: modelIds.length, sample: modelIds.slice(0, 12) });
} catch (error) {
  note('GET /v1/models → ERR', String(error?.message ?? error).slice(0, 200));
  results.push({ label: 'GET /v1/models', url: `${GATEWAY_BASE_URL}/models`, status: null, error: String(error?.message ?? error).slice(0, 200) });
}

// 选一个「像通用对话模型」的 id：优先 glm / gpt / claude / deepseek 字样的第一条
const pick = (pattern) => modelIds.find((id) => pattern.test(id)) ?? modelIds[0];
const chatModel = pick(/glm|gpt|claude|deepseek|qwen/i);
note('用于推理的 model id：', chatModel ?? '【清单为空】');

if (chatModel !== undefined) {
  // 2. Responses wire（Bearer）
  results.push(await post('POST /v1/responses', `${GATEWAY_BASE_URL}/responses`, { authorization: `Bearer ${KEY}` }, {
    model: chatModel,
    input: PROMPT,
    max_output_tokens: 16,
    stream: false,
  }));

  // 3. Chat Completions（对照）
  results.push(await post('POST /v1/chat/completions', `${GATEWAY_BASE_URL}/chat/completions`, { authorization: `Bearer ${KEY}` }, {
    model: chatModel,
    messages: [{ role: 'user', content: PROMPT }],
    max_tokens: 16,
    stream: false,
  }));

  // 4. Anthropic Messages（x-api-key；v2 已实测 200，这里复核它现在是否仍然可用）
  results.push(await post('POST /v1/messages', `${GATEWAY_ORIGIN}/v1/messages`, { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, {
    model: chatModel,
    max_tokens: 16,
    messages: [{ role: 'user', content: PROMPT }],
  }));
}

const file = writeDump('v3/endpoint-matrix', { at: new Date().toISOString(), gateway: GATEWAY_BASE_URL, model: chatModel ?? null, results });
note('落盘：', file);
