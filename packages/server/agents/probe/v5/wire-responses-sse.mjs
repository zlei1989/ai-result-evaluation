/**
 * v5 修正件 A：**直接**问上游 `/v1/responses` 要一次带推理的响应（不经 codex），
 * 把「厂商那一侧到底给了什么」单独留档。
 *
 * 为什么必须有这一步：本探针要回答「思考内容从哪个字段到达」，而**字段名是上游定的**。
 * 少了这一层，「app-server 没给推理」有两种完全不同的成因分不开：
 *   (a) 上游本来就没回推理正文； (b) 上游回了，codex 没投影成 `item/reasoning/*`。
 *
 * 采集口径：SSE **逐行原文**落盘（`data: ` 前缀与 JSON 一起留），只额外做「事件类型清单 + 计数」，
 * 不重新序列化——上一轮就是因为 parse 后重排，把「键不存在」与「键为 null」抹平而误诊。
 *
 * 用法：node probe/v5/wire-responses-sse.mjs
 * 前置：环境里有 `AIEVAL_PROBE_DEEPSEEK_API_KEY`（见 run.ps1 的用法；本脚本自带同款解析）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DUMP = join(HERE, '..', 'dumps', 'v5');
const SCRATCH = join(DUMP, 'tmp', 'wire');
mkdirSync(SCRATCH, { recursive: true });

/** 密钥：环境变量优先；否则按凭据库里的缩进映射解析（**不打印**） */
function loadKey() {
  const fromEnv = process.env.AIEVAL_PROBE_DEEPSEEK_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  const file = join(homedir(), '.dsh', '.credentials.yaml');
  if (!existsSync(file)) throw new Error(`拿不到凭据：设 AIEVAL_PROBE_DEEPSEEK_API_KEY，或提供 ${file}`);
  const hit = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m.exec(readFileSync(file, 'utf8'));
  if (hit === null) throw new Error(`${file} 里没有 DEEPSEEK_API_KEY`);
  return hit[1];
}
const apiKey = loadKey();
const redact = (text) => text.split(apiKey).join('***');

const MODEL = 'deepseek-reasoner';
const PROMPT = '请先用一句话说明你的推理过程，再给出结论：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？';

/**
 * 两个存档：一个走**流式**（看有没有 `response.reasoning_text.delta` 这类逐字增量），
 * 一个走**非流式**（看终态 item 的逐字形状：`content[].type` / `summary` / `encrypted_content`）。
 * 两个都用 `reasoning: { effort: 'high', summary: 'auto' }`——`summary` 的合法枚举只有
 * `auto` / `concise` / `detailed`（`none` 会被网关 422，见同目录报告）。
 */
const archives = [];

archives.push(await call({ label: 'stream-summary-auto', stream: true, summary: 'auto' }));
archives.push(await call({ label: 'nonstream-summary-auto', stream: false, summary: 'auto' }));
// 顺带把「网关对 summary 的合法枚举」钉一次：`none` 的原始报错原文
archives.push(await call({ label: 'stream-summary-none', stream: true, summary: 'none' }));

const file = join(DUMP, 'wire-responses-sse.json');
writeFileSync(file, `${redact(JSON.stringify({ at: new Date().toISOString(), model: MODEL, prompt: PROMPT, archives }, null, 2))}\n`, 'utf8');
console.log('[v5/wire] 落盘：', file);
for (const one of archives) {
  console.log(
    `[v5/wire] ${one.label.padEnd(24)} http=${one.status} bytes=${one.bytes} events=${one.eventTypeCounts ? JSON.stringify(one.eventTypeCounts) : '-'} error=${one.errorBody ? one.errorBody.slice(0, 120) : '-'}`,
  );
}

/** 发一次请求并把**原文**留档 */
async function call({ label, stream, summary }) {
  const body = {
    model: MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
    reasoning: { effort: 'high', summary },
    stream,
  };
  const file = join(SCRATCH, `${label}.sse.txt`);
  writeFileSync(file, '', 'utf8');
  const at = Date.now();
  const response = await fetch('https://api.deepseek.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const chunks = [];
  if (response.body === null) {
    appendFileSync(file, '<响应体为空>\n', 'utf8');
  } else {
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk));
      appendFileSync(file, redact(Buffer.from(chunk).toString('utf8')), 'utf8');
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const eventTypeCounts = {};
  for (const hit of text.matchAll(/"type"\s*:\s*"([a-z0-9_.]+)"/g)) {
    eventTypeCounts[hit[1]] = (eventTypeCounts[hit[1]] ?? 0) + 1;
  }
  // SSE 的事件名（`event: xxx`）也单独数一份：有些网关只给事件名不给 `type`
  const sseEventNames = {};
  for (const hit of text.matchAll(/^event:\s*(\S+)/gm)) sseEventNames[hit[1]] = (sseEventNames[hit[1]] ?? 0) + 1;

  return {
    label,
    request: { url: 'https://api.deepseek.com/v1/responses', body },
    status: response.status,
    contentType: response.headers.get('content-type'),
    ms: Date.now() - at,
    bytes: text.length,
    eventTypeCounts: Object.keys(eventTypeCounts).length === 0 ? null : eventTypeCounts,
    sseEventNames: Object.keys(sseEventNames).length === 0 ? null : sseEventNames,
    errorBody: response.ok ? null : redact(text).slice(0, 1200),
    rawFile: file,
    /** 明文推理的**逐字样本**：`reasoning_text` 块里最长的一段 */
    reasoningTextSample: longestReasoningText(text),
    reasoningTextLengths: [...text.matchAll(/"type"\s*:\s*"reasoning_text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((hit) => unescapeJson(hit[1]).length),
    summaryEmptyArraySeen: /"summary"\s*:\s*\[\s*\]/.test(text),
    encryptedContentSeen: text.includes('encrypted_content'),
  };
}

/** 取最长的一段 `reasoning_text`（空占位 `text:""` 不是正文——上一轮踩过这个坑） */
function longestReasoningText(text) {
  let best = '';
  for (const hit of text.matchAll(/"type"\s*:\s*"reasoning_text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const value = unescapeJson(hit[1]);
    if (value.length > best.length) best = value;
  }
  return best.slice(0, 400) || null;
}

function unescapeJson(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}
