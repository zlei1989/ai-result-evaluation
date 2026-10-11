/**
 * is-10 端点诊断：附件支持问题定性——「网关问题」还是「协议问题」。
 *
 * 背景：is-09 探针证明 likecode 网关（defaultJudge）对 anthropic `document` 附件块
 * **静默丢弃**（200 但模型自述没看到附件）、对 openai `file` 块显式 400。本脚本回答
 * 定性问题：换官方 DeepSeek 端点后附件块读不读得到——
 *   · 官方端点读得到、likecode 读不到 ⇒ **网关问题**（likecode 的实现缺附件块）；
 *   · 官方端点也读不到 / 拒绝 ⇒ **协议问题**（或模型/端点都不支持该形态）。
 *
 * 矩阵：两个端点 × 四种「意图与证据分开输入」机制，每格发**最小请求**，证据里埋随机
 * 哨兵词（12 位 hex，不可能被猜中），判据 = 模型复述哨兵词：
 *   a) document(PlainTextSource) 附件块 —— 生产 `wireContent` 的 anthropic 形态；
 *   b) content 数组里两个纯 text 块（意图 + 证据，不用 document/file）；
 *   c) 两条 user 消息（意图一条、证据一条）；
 *   d) 顶层 system 字符串带证据、意图走 user。
 * 另加两条 openai 协议测试：
 *   · openai file content part 最小请求（官方 DeepSeek `/v1/chat/completions`）：失败
 *     （4xx / 网络）就跳过并记录，不影响矩阵结论；
 *   · 端点 C（配置里 openai 协议的 deepseek 供应商，likecode 网关，GLM-5.3）× 机制
 *     b/c/d 的 openai wire 形态（text part 双块 / 两条 user 消息 / system 角色消息带证据）。
 *     该供应商 baseUrl 缺 `/v1`（is-09 已证生产拼法 404），诊断按网关真实路由
 *     `/v1/chat/completions` 补 `/v1` 后测——补的是**诊断脚本**的路由，不是产品代码。
 *
 * 机制 (a) 走**生产代码路径**（jiti 加载 `text-api.ts` 的 `callTextApiConversation`，
 * 附件块经生产 `wireContent` 翻译），与上线后评分发出的形状逐字一致；机制 (b)–(d)
 * 是诊断专用形状（生产代码今天不产生它们），用直连 fetch 按 Anthropic Messages API
 * 规范构造。配置读 `@aieval/core` 的 `loadConfig()`（`~/.aieval/config.json`）。
 *
 * 端点解析：
 *   · 端点 A（官方 DeepSeek）：配置里 protocolType=anthropic 且 baseUrl 以
 *     `https://api.deepseek.com` 开头的供应商（模型 deepseek-flash）；
 *   · 端点 B（likecode 网关）：defaultJudge 对应的供应商。
 * 端点 A 缺配置 ⇒ 该格记 SKIP（凭据不在配置里就不猜），不因此退出非 0。
 *
 * 密钥只从配置读，全程不回显、不落盘。每格响应里抓取模型的自述（thinking / text 原文
 * 片段）作为证据；响应原文可能含密钥回显（登录页等），故只截取内容块，不打印整份正文。
 *
 * 用法：node .scratch/include-steps/probe/diagnose-endpoint.mjs
 * 退出码：所有**已尝试**的格都拿到判决（PASS / FAIL / 4xx 的 FAIL）⇒ 0；
 * 任一格遇到网络 / 超时（没拿到网关答复）⇒ 1。SKIP（缺配置）不算失败。
 */
import { createJiti } from 'jiti';
import { randomBytes } from 'node:crypto';

const WORKTREE_ROOT = new URL('../../../', import.meta.url).pathname;
const jiti = createJiti(import.meta.url, { interopDefault: true, esmResolve: true });

const textApi = await jiti.import(`${WORKTREE_ROOT}packages/server/evaluator/src/text-api.ts`);
const core = await jiti.import(`${WORKTREE_ROOT}packages/server/core/src/index.ts`);

const config = core.loadConfig();
const { defaultJudge } = config.settings;
const defaultProvider = config.providers.find((p) => p.id === defaultJudge.providerId);
if (!defaultProvider) {
  console.error(`defaultJudge.providerId「${defaultJudge.providerId}」在 providers 里找不到`);
  process.exit(2);
}
// 端点 A：官方 DeepSeek 的 anthropic 供应商；端点 B：defaultJudge 的供应商
const official = config.providers.find(
  (p) => p.protocolType === 'anthropic' && p.baseUrl.trim().startsWith('https://api.deepseek.com'),
);
const endpoints = [
  {
    id: 'A-官方DeepSeek',
    baseUrl: official?.baseUrl,
    apiKey: official?.apiKey,
    modelId: official?.models[0]?.id ?? 'deepseek-flash',
    available: Boolean(official),
    skipReason: official ? null : '配置里没有官方 DeepSeek 的 anthropic 供应商',
  },
  {
    id: 'B-likecode网关',
    baseUrl: defaultProvider.baseUrl,
    apiKey: defaultProvider.apiKey,
    modelId: defaultJudge.modelId,
    available: true,
    skipReason: null,
  },
];

const ANTHROPIC_VERSION = '2023-06-01';
const INTENT = '请只输出证据内容里出现的哨兵词（以 SI-DIAG- 开头的完整字符串）。不要输出任何其它内容。';
const evidenceText = (sentinel) => [
  '本段是探针证据内容。',
  `唯一哨兵词：${sentinel}`,
  '其余内容与探针无关，无需理会。',
].join('\n');

/** 生产 endpoint() 的 anthropic 拼法（与 text-api.ts 同口径）：剥尾斜杠、剥 /v1 再拼 /v1/messages */
function anthropicUrl(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base.replace(/\/v1$/, '')}/v1/messages`;
}

/** 直连一次 anthropic 最小请求；返回 { status, texts, excerpt }（不回显密钥） */
async function fetchAnthropic(endpoint, body) {
  const res = await fetch(anthropicUrl(endpoint.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': endpoint.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: res.status, texts: '', excerpt: `非 JSON 响应：${raw.slice(0, 200)}` };
  }
  const blocks = parsed.content ?? [];
  const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  const thinking = blocks.filter((b) => b.type === 'thinking' && typeof b.thinking === 'string').map((b) => b.thinking).join('');
  return { status: res.status, texts, excerpt: (texts + (thinking ? ` [thinking] ${thinking}` : '')).replace(/\s+/g, ' ').slice(0, 400) };
}

/**
 * 机制 (a)：生产形态——`callTextApiConversation` 一条 user 消息，content 为
 * [意图 text 块, attachment 附件块]（wireContent 翻成 document/PlainTextSource）。
 */
async function mechanismA(endpoint, sentinel) {
  const text = await textApi.callTextApiConversation(
    { protocolType: 'anthropic', baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, modelId: endpoint.modelId },
    {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: INTENT },
          { type: 'attachment', text: evidenceText(sentinel), filename: 'diagnosis-attachment.txt' },
        ],
      }],
      signal: AbortSignal.timeout(120_000),
    },
  );
  return { status: 200, texts: text, excerpt: text.replace(/\s+/g, ' ').slice(0, 400) };
}

/**
 * 机制 (a) 生产调用失败时的**原始响应取证**：用同一生产 wire 形状直打一次，把响应原文
 * （含模型对「有没有附件」的自述）取回来——「没有 text 块」可能是模型没看到附件后
 * 空回复，也可能是网关把 document 块丢掉了，模型自述才能区分。
 */
async function rawEvidenceA(endpoint, sentinel) {
  const body = {
    model: endpoint.modelId,
    max_tokens: 16384,
    stream: false,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: INTENT },
        {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: evidenceText(sentinel) },
        },
      ],
    }],
  };
  return fetchAnthropic(endpoint, body);
}

/** 机制 (b)：content 数组两个纯 text 块 */
function bodyB(sentinel) {
  return {
    model: null, // 占位，调用处填
    max_tokens: 1024,
    stream: false,
    messages: [{ role: 'user', content: [{ type: 'text', text: INTENT }, { type: 'text', text: evidenceText(sentinel) }] }],
  };
}/** 机制 (c)：两条 user 消息 */
function bodyC(sentinel) {
  return {
    model: null,
    max_tokens: 1024,
    stream: false,
    messages: [
      { role: 'user', content: INTENT },
      { role: 'user', content: evidenceText(sentinel) },
    ],
  };
}

/** 机制 (d)：顶层 system 带证据，意图走 user */
function bodyD(sentinel) {
  return {
    model: null,
    max_tokens: 1024,
    stream: false,
    system: evidenceText(sentinel),
    messages: [{ role: 'user', content: INTENT }],
  };
}

const mechanisms = [
  { id: 'a-document附件块(生产形态)', run: mechanismA, body: null },
  { id: 'b-双text块', run: null, body: bodyB },
  { id: 'c-两条user消息', run: null, body: bodyC },
  { id: 'd-system带证据', run: null, body: bodyD },
];

const results = [];
let transportErrors = 0;
for (const endpoint of endpoints) {
  if (!endpoint.available) {
    results.push({ endpoint: endpoint.id, mechanism: '-', verdict: 'SKIP', reason: endpoint.skipReason });
    console.log(`[SKIP] ${endpoint.id}: ${endpoint.skipReason}`);
    continue;
  }
  for (const mech of mechanisms) {
    const sentinel = `SI-DIAG-${randomBytes(6).toString('hex')}`;
    const startedAt = Date.now();
    try {
      let readback;
      if (mech.run) {
        readback = await mech.run(endpoint, sentinel);
      } else {
        const body = mech.body(sentinel);
        body.model = endpoint.modelId;
        readback = await fetchAnthropic(endpoint, body);
      }
      const pass = readback.texts.includes(sentinel);
      const verdict = readback.status === 200 && pass ? 'PASS' : 'FAIL';
      results.push({ endpoint: endpoint.id, mechanism: mech.id, verdict, status: readback.status, durationMs: Date.now() - startedAt, excerpt: readback.excerpt });
      console.log(`[${verdict}] ${endpoint.id} × ${mech.id} (${Date.now() - startedAt}ms)`);
      if (verdict === 'FAIL') console.log(`  证据: status=${readback.status} ${readback.excerpt}`);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      const entry = { endpoint: endpoint.id, mechanism: mech.id, verdict: 'ERROR', durationMs: Date.now() - startedAt, error: message };
      // 机制 (a) 的生产调用失败后补抓原始响应（模型自述「有没有附件」）
      if (mech.run) {
        try {
          const ev = await rawEvidenceA(endpoint, sentinel);
          entry.gatewayRawResponse = ev;
        } catch (evError) {
          entry.gatewayRawResponse = { error: String(evError) };
        }
      }
      if (entry.gatewayRawResponse?.error) {
        transportErrors += 1;
      }
      results.push(entry);
      console.error(`[ERROR] ${endpoint.id} × ${mech.id} ${message}`);
      if (entry.gatewayRawResponse) console.error(`  原始响应取证: ${JSON.stringify(entry.gatewayRawResponse)}`);
    }
  }
}

// 端点 C：配置里 openai 协议的供应商（likecode 网关，GLM-5.3）；路由按网关真实形态补 /v1
const openaiProvider = config.providers.find((p) => p.protocolType === 'openai');

/**
 * 直连一次 openai 最小请求（chat/completions）。
 * 路由口径：网关真实路由是 `/v1/chat/completions`（is-09 实测 `/chat/completions` 404），
 * 故这里在剥掉尾斜杠后**显式补 `/v1`**——修的是诊断脚本对真实网关路由的还原，
 * 不是产品 `endpoint()` 的拼法（产品对缺 `/v1` 的供应商仍会 404，那是既有旁证，见 DIAGNOSIS.md）。
 */
async function fetchOpenAI(endpoint, body) {
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.text();
  let text = '';
  let excerpt = `非 JSON 响应：${raw.slice(0, 200)}`;
  try {
    const parsed = JSON.parse(raw);
    text = parsed?.choices?.[0]?.message?.content ?? '';
    excerpt = res.status === 200 ? String(text).replace(/\s+/g, ' ').slice(0, 400) : raw.slice(0, 200);
  } catch {
    // excerpt 已带原文片段
  }
  return { status: res.status, texts: text, excerpt };
}

if (openaiProvider) {
  const endpointC = {
    id: 'C-likecode网关-openai协议',
    baseUrl: openaiProvider.baseUrl,
    apiKey: openaiProvider.apiKey,
    modelId: openaiProvider.models[0]?.id,
    available: true,
    skipReason: null,
  };
  const openaiMechanisms = [
    {
      id: 'b-双text-part',
      body: (sentinel) => ({
        model: null,
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: INTENT }, { type: 'text', text: evidenceText(sentinel) }] }],
      }),
    },
    {
      id: 'c-两条user消息',
      body: (sentinel) => ({
        model: null,
        stream: false,
        messages: [{ role: 'user', content: INTENT }, { role: 'user', content: evidenceText(sentinel) }],
      }),
    },
    {
      id: 'd-system消息带证据',
      body: (sentinel) => ({
        model: null,
        stream: false,
        messages: [{ role: 'system', content: evidenceText(sentinel) }, { role: 'user', content: INTENT }],
      }),
    },
  ];
  for (const mech of openaiMechanisms) {
    const sentinel = `SI-DIAG-${randomBytes(6).toString('hex')}`;
    const startedAt = Date.now();
    try {
      const body = mech.body(sentinel);
      body.model = endpointC.modelId;
      const readback = await fetchOpenAI(endpointC, body);
      const pass = readback.texts.includes(sentinel);
      const verdict = readback.status === 200 && pass ? 'PASS' : 'FAIL';
      results.push({ endpoint: endpointC.id, mechanism: mech.id, verdict, status: readback.status, durationMs: Date.now() - startedAt, excerpt: readback.excerpt });
      console.log(`[${verdict}] ${endpointC.id} × ${mech.id} (${Date.now() - startedAt}ms)`);
      if (verdict === 'FAIL') console.log(`  证据: status=${readback.status} ${readback.excerpt}`);
    } catch (error) {
      transportErrors += 1;
      const message = String(error instanceof Error ? error.message : error);
      results.push({ endpoint: endpointC.id, mechanism: mech.id, verdict: 'ERROR', durationMs: Date.now() - startedAt, error: message });
      console.error(`[ERROR] ${endpointC.id} × ${mech.id} ${message}`);
    }
  }
} else {
  results.push({ endpoint: 'C-likecode网关-openai协议', mechanism: '-', verdict: 'SKIP', reason: '配置里没有 openai 协议的供应商' });
  console.log('[SKIP] C-likecode网关-openai协议：配置里没有 openai 协议的供应商');
}

// openai file content part 单条最小请求（官方 DeepSeek /v1/chat/completions，key 复用官方供应商）
if (official) {
  const sentinel = `SI-DIAG-${randomBytes(6).toString('hex')}`;
  const startedAt = Date.now();
  try {
    const body = {
      model: 'deepseek-flash',
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: INTENT },
          { type: 'file', file: { file_data: Buffer.from(evidenceText(sentinel), 'utf8').toString('base64'), filename: 'diagnosis.txt' } },
        ],
      }],
    };
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${official.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await res.text();
    let text = '';
    let excerpt = `非 JSON 响应：${raw.slice(0, 200)}`;
    try {
      const parsed = JSON.parse(raw);
      text = parsed?.choices?.[0]?.message?.content ?? '';
      // 非 2xx 时取错误原文做证据（不回显密钥：只截 200 字）
      excerpt = res.status === 200 ? String(text).replace(/\s+/g, ' ').slice(0, 400) : raw.slice(0, 200);
    } catch {
      // excerpt 已带原文片段
    }
    const pass = res.status === 200 && text.includes(sentinel);
    const verdict = pass ? 'PASS' : 'FAIL';
    results.push({ endpoint: '官方DeepSeek-openai协议', mechanism: 'openai-file-part', verdict, status: res.status, durationMs: Date.now() - startedAt, excerpt });
    console.log(`[${verdict}] 官方DeepSeek-openai协议 × openai-file-part (${Date.now() - startedAt}ms)`);
    if (verdict === 'FAIL') console.log(`  证据: status=${res.status} ${excerpt}`);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    results.push({ endpoint: '官方DeepSeek-openai协议', mechanism: 'openai-file-part', verdict: 'SKIP(失败跳过)', durationMs: Date.now() - startedAt, error: message });
    console.log(`[SKIP] 官方DeepSeek-openai协议 × openai-file-part：${message}`);
  }
} else {
  results.push({ endpoint: '官方DeepSeek-openai协议', mechanism: 'openai-file-part', verdict: 'SKIP', reason: '配置里没有官方 DeepSeek 供应商（无 key）' });
  console.log('[SKIP] 官方DeepSeek-openai协议 × openai-file-part：配置里没有官方 DeepSeek 供应商（无 key）');
}

console.log('\n== 矩阵结论 ==');
console.log(JSON.stringify(results, null, 2));
if (transportErrors > 0) {
  console.error(`有 ${transportErrors} 格遇到网络/超时（未拿到网关答复），诊断不完整`);
  process.exit(1);
}
console.log('诊断完成：全部已尝试的格都有判决');
