#!/usr/bin/env node
/**
 * 最小复现（**不经 codex**）：自定义 Responses 网关回程的 `function_call` 少了 `namespace` 字段。
 *
 * 为什么需要它：codex 侧的现象是 `unsupported call: browser_navigate`，但那是**下游**读数；
 * 网关同事要判是不是自己的问题，只需要看**自己回出去的报文**。本脚本直接按 codex 的形状发一条
 * 带「命名空间工具」的请求，然后把回程每个 output item 的 `type` / `name` / `namespace` 打出来——
 * 期望形状是 `{"type":"function_call","name":"probe_echo","namespace":"mcp__probe",…}`。
 *
 * 用法（在仓库根）：
 *   node packages/server/agents/probe/v10/gateway-namespace-repro.mjs
 * 凭据取宿主 `~/.aieval/config.json` 的第一条 openai 供应商（可用 --base / --key / --model 覆盖）。
 * 只打印字段有无，**不打印密钥**。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, ...rest] = raw.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  }),
);

const host = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8'));
const provider = (host.providers ?? []).find((one) => one.protocolType === 'openai') ?? {};
const BASE = String(ARGS['base'] ?? provider.baseUrl ?? '').replace(/\/+$/, '');
const KEY = String(ARGS['key'] ?? provider.apiKey ?? '');
const MODEL = String(ARGS['model'] ?? provider.models?.[0]?.id ?? '');
if (BASE === '' || KEY === '' || MODEL === '') throw new Error('拿不到网关地址 / 密钥 / 模型：用 --base / --key / --model 指定');

/** 与 codex 发出去的形状逐字一致：一台 namespace 工具 + 一个普通 function 当对照 */
const TOOLS = [
  {
    type: 'namespace',
    name: 'mcp__probe',
    description: 'Tools in the mcp__probe namespace.',
    tools: [{
      type: 'function',
      name: 'probe_echo',
      description: '回显给定字符串',
      strict: false,
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    }],
  },
  {
    type: 'function',
    name: 'plain_marker',
    description: '对照用的普通函数工具（不需要调用）',
    strict: false,
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: [], additionalProperties: false },
  },
];

const body = {
  model: MODEL,
  input: [{
    role: 'user',
    content: [{ type: 'input_text', text: '请调用 probe_echo 工具（参数 value 传 "hello"），然后只回复工具返回的原文，不要加任何其它字。' }],
  }],
  tools: TOOLS,
  store: false,
};

const response = await fetch(`${BASE}/v1/responses`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, accept: 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120_000),
});
const text = await response.text();
console.log(`[repro] POST ${BASE}/v1/responses → HTTP ${response.status}（model=${MODEL}）`);
if (response.status >= 400) {
  console.log('[repro] 上游原文：', text.slice(0, 500));
  process.exit(1);
}
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  console.log('[repro] 响应不是 JSON：', text.slice(0, 300));
  process.exit(1);
}

const items = parsed.output ?? [];
console.log(`[repro] 回程 output 条目 ${items.length} 条：`);
let missing = 0;
for (const item of items) {
  const hasNamespace = Object.hasOwn(item, 'namespace') && item.namespace !== null;
  const line = `   type=${item.type} name=${item.name ?? '-'} namespace=${hasNamespace ? JSON.stringify(item.namespace) : '(缺这一格)'}`;
  console.log(line);
  if (item.type === 'function_call' && item.name !== 'plain_marker' && !hasNamespace) missing += 1;
}
console.log('');
if (missing > 0) {
  console.log('[repro] ❌ 复现：命名空间工具的 function_call 回程**没有 `namespace` 字段**。');
  console.log('         期望形状：{"type":"function_call","name":"probe_echo","namespace":"mcp__probe","arguments":"{…}","call_id":"…"}');
  console.log('         现状形状：{"type":"function_call","name":"probe_echo","arguments":"{…}","call_id":"…"}');
  console.log('         ⇒ 下游 codex 按「默认命名空间 + name」查注册表，查不到，回 `unsupported call: probe_echo`。');
} else {
  console.log('[repro] ✅ 回程带上了 `namespace`（或本次模型没发起调用，看上面的 output 条目）。');
}
