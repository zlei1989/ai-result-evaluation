/**
 * 「包含步骤」协议附件形态的硬守卫探针：评分附件形态是否可启用的**网关侧**前置判据。
 *
 * 判据不是「200 被接受」，而是**附件内容真的被网关读进上下文**：给附件里埋一个
 * 随机哨兵词，让模型只输出附件里的哨兵词——返回里出现该词才算 PASS。随机 12 位十六进制
 * 哨兵不可能被模型猜出，所以「复述出哨兵」只能来自读了附件。
 *
 * 终态：生产文本通路**不发送**协议附件——评分证据（diff / events.jsonl / messages.jsonl）
 * 一律以独立 text 块下发（`wireContent` 把 attachment 块翻成带 `## filename` 标题的 text 块，
 * 见 `packages/server/evaluator/src/text-api.ts`）。这个降级是探针结论的直接后果：DeepSeek 系
 * 端点不实现 document/file 协议附件（官方端点替换成占位、likecode 网关静默丢弃、openai 显式
 * 400，哨兵词复述判据；取证见本目录 `REPORT.md` 与 `DIAGNOSIS.md`）。
 *
 * 因此本探针**不再经生产 `wireContent` 发请求**——那只会测到 text 块降级（trivially PASS），
 * 而不是网关对协议附件的读取。它直接构造两协议的**协议附件 wire 形状**
 * （anthropic `document` 块 / openai `file` part）直打网关。本探针留作**网关升级后的复验工具**：
 * 网关支持协议附件块后先重跑它（判据不变：哨兵词复述），两协议全 PASS 才能把 `wireContent`
 * 的降级换回协议附件形态。openai 侧复验时另需供应商 baseUrl 带 `/v1`（既有配置缺它，见
 * DIAGNOSIS 旁证 1；探针按网关真实路由直打）。
 *
 * 两种失败要分得开，处置不同：
 *   · **显式拒绝**（非 2xx）：网关明说不要这个块——同样判 FAIL，但病因可查；
 *   · **静默丢弃**（2xx 但模型自述没看到附件 / 复述不出哨兵）：最危险的一种，
 *     评分证据在网关处无声消失——这也是本探针存在的理由。
 *
 * 密钥只从既有配置读取（`~/.aieval/config.json`），全程不回显、不落盘。
 *
 * 用法：node .scratch/include-steps/probe/attachment-gateway.mjs
 * 退出码：任一协议的探针不 PASS 即非 0；网络/超时也非 0（不静默降级）。
 */
import { createJiti } from 'jiti';
import { randomBytes } from 'node:crypto';

const WORKTREE_ROOT = new URL('../../../', import.meta.url).pathname;
const jiti = createJiti(import.meta.url, { interopDefault: true, esmResolve: true });

const core = await jiti.import(`${WORKTREE_ROOT}packages/server/core/src/index.ts`);

const config = core.loadConfig();
const { defaultJudge } = config.settings;
if (!defaultJudge) {
  console.error('配置里没有 settings.defaultJudge，探针无法确定实际使用的评分网关');
  process.exit(2);
}
const defaultProvider = config.providers.find((p) => p.id === defaultJudge.providerId);
if (!defaultProvider) {
  console.error(`defaultJudge.providerId「${defaultJudge.providerId}」在 providers 里找不到`);
  process.exit(2);
}

/**
 * 待探的路由表：defaultJudge 的供应商必在；另一协议的供应商（若有）也加入，
 * 两个协议各一次最小附件请求。同一供应商不重复。
 */
const routes = [
  {
    label: 'defaultJudge',
    protocolType: defaultProvider.protocolType,
    baseUrl: defaultProvider.baseUrl,
    apiKey: defaultProvider.apiKey,
    modelId: defaultJudge.modelId,
  },
  ...config.providers
    .filter((p) => p.id !== defaultProvider.id && (p.protocolType === 'anthropic' || p.protocolType === 'openai'))
    .map((p) => ({
      label: p.name,
      protocolType: p.protocolType,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      modelId: p.models[0]?.id,
    }))
    .filter((r) => r.modelId),
];

/** 一次探针请求的意图与附件正文（两协议同构：意图 text + 附件原文，附件里埋哨兵词） */
function probeContent(sentinel) {
  return {
    intent: '请只输出附件文件正文里出现的哨兵词（以 SI-PROBE- 开头的完整字符串）。不要输出任何其它内容。',
    attachment: [
      '本文件是网关附件探针的附件内容。',
      `唯一哨兵词：${sentinel}`,
      '其余内容与探针无关，无需理会。',
    ].join('\n'),
  };
}

/**
 * anthropic 协议的协议附件 wire 形状：意图 text 块 + `document` 附件块（source.type=text）。
 * 判据在**原始响应正文**里找哨兵词：哨兵不可猜，出现在正文（text 或 thinking 块）即证明
 * 网关把附件内容递给了模型；2xx 而正文无哨兵 = 静默丢弃。
 */
async function probeAnthropicAttachment(route, sentinel) {
  const { intent, attachment } = probeContent(sentinel);
  const root = route.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const body = {
    model: route.modelId,
    max_tokens: 16384,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: intent },
          { type: 'document', source: { type: 'text', media_type: 'text/plain', data: attachment } },
        ],
      },
    ],
  };
  const res = await fetch(`${root}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': route.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) return { verdict: `FAIL(显式拒绝 ${res.status})`, excerpt: raw.replace(/\s+/g, ' ').slice(0, 300) };
  return raw.includes(sentinel)
    ? { verdict: 'PASS', excerpt: raw.replace(/\s+/g, ' ').slice(0, 300) }
    : { verdict: 'FAIL(静默丢弃)', excerpt: raw.replace(/\s+/g, ' ').slice(0, 300) };
}

/**
 * openai 协议的协议附件 wire 形状：意图 text part + `file` 附件 part（file_data=base64）。
 * 直打网关真实路由 `/v1/chat/completions`（生产配置的 baseUrl 缺 `/v1` 是既有配置问题，
 * 见 DIAGNOSIS 旁证 1）。判据同上：2xx 且正文复述哨兵才 PASS。
 */
async function probeOpenAIAttachment(route, sentinel) {
  const { intent, attachment } = probeContent(sentinel);
  const root = route.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const body = {
    model: route.modelId,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: intent },
          {
            type: 'file',
            file: { file_data: Buffer.from(attachment, 'utf8').toString('base64'), filename: 'probe-attachment.txt' },
          },
        ],
      },
    ],
  };
  const res = await fetch(`${root}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${route.apiKey}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) return { verdict: `FAIL(显式拒绝 ${res.status})`, excerpt: raw.replace(/\s+/g, ' ').slice(0, 300) };
  return raw.includes(sentinel)
    ? { verdict: 'PASS', excerpt: raw.replace(/\s+/g, ' ').slice(0, 300) }
    : { verdict: 'FAIL(静默丢弃)', excerpt: raw.replace(/\s+/g, ' ').slice(0, 300) };
}

const results = [];
for (const route of routes) {
  const startedAt = Date.now();
  const sentinel = `SI-PROBE-${randomBytes(6).toString('hex')}`;
  try {
    const probe = route.protocolType === 'anthropic' ? probeAnthropicAttachment : probeOpenAIAttachment;
    const { verdict, excerpt } = await probe(route, sentinel);
    results.push({
      label: route.label,
      protocolType: route.protocolType,
      modelId: route.modelId,
      verdict,
      durationMs: Date.now() - startedAt,
      matchedSentinel: verdict === 'PASS',
      responseExcerpt: excerpt,
    });
    console.log(`[${verdict.startsWith('PASS') ? 'PASS' : 'FAIL'}] ${route.label} (${route.protocolType}/${route.modelId}) ${verdict} ${Date.now() - startedAt}ms`);
    if (verdict !== 'PASS') console.log(`  返回摘录: ${excerpt}`);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    results.push({
      label: route.label,
      protocolType: route.protocolType,
      modelId: route.modelId,
      verdict: 'FAIL(网络/超时)',
      durationMs: Date.now() - startedAt,
      productionError: message,
    });
    console.error(`[FAIL] ${route.label} (${route.protocolType}/${route.modelId}) ${message}`);
  }
}

const passed = results.filter((r) => r.verdict === 'PASS');
console.log('\n== 结论 ==');
console.log(JSON.stringify(results, null, 2));
if (passed.length !== results.length) {
  console.error(`探针不通过：${results.length - passed.length}/${results.length} 项未 PASS——协议附件形态不得启用`);
  process.exit(1);
}
console.log(`探针通过：${results.length}/${results.length} 项 PASS——可考虑把 wireContent 的 text 块降级换回协议附件形态`);
