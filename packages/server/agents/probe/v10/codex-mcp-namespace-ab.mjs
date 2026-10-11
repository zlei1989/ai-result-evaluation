#!/usr/bin/env node
/**
 * A/B：`type: "namespace"` 的工具到底是谁吃掉的——**网关**还是 codex。
 *
 * 背景：真机请求体里 MCP 工具的形状是
 *   `{"type":"namespace","name":"mcp__probe","description":…,"tools":[{"type":"function","name":"probe_echo",…}]}`
 * （与 `multi_agent_v1` 同形），而同一批 `tools[]` 里的**普通 function** 工具模型看得见（它会去调
 * `list_mcp_resources`）。于是有两种解释：① 网关转发时把 namespace 条目丢了；② 模型自己不认这种条目。
 *
 * 判据：给同一个模型两批工具，只改 MCP 那一台的形状，问它「列出你的工具名」——
 *   · A 臂 namespace（codex 的真实形状）
 *   · B 臂 扁平 function `mcp__probe__probe_echo`（同一台工具的传统形状）
 * 每臂都带一个**普通 function 探针**（`plain_marker`）当对照：它在两臂都该出现，
 * 否则说明"模型没列全"，本探针的读数就不可信。
 *
 * 用法：node packages/server/agents/probe/v10/codex-mcp-namespace-ab.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const config = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8'));
const provider = (config.providers ?? []).find((item) => item.protocolType === 'openai');
if (provider === undefined) throw new Error('宿主配置里没有 openai 供应商');
const BASE = String(provider.baseUrl).replace(/\/+$/, '');
const KEY = String(provider.apiKey);
const MODEL = process.env['PROBE_MODEL'] ?? provider.models?.[0]?.id ?? 'GLM-5.3';
const redact = (text) => String(text).split(KEY).join('***');

const PROMPT = '请把你当前可用的工具名字**原样列出来**（用逗号分隔），不要调用任何工具，不要解释。';
const marker = (name) => ({
  type: 'function',
  name,
  description: '对照探针工具，不需要调用',
  strict: false,
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: [], additionalProperties: false },
});
const ECHO_PARAMS = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };

const ARMS = {
  A_namespace: [
    { type: 'namespace', name: 'mcp__probe', description: 'MCP server probe 暴露的工具', tools: [{ type: 'function', name: 'probe_echo', description: '回显', strict: false, parameters: ECHO_PARAMS }] },
    marker('plain_marker'),
  ],
  B_flat_function: [
    { type: 'function', name: 'mcp__probe__probe_echo', description: '回显', strict: false, parameters: ECHO_PARAMS },
    marker('plain_marker'),
  ],
};

/** 发一次非流式请求，取最终答复文本 */
async function ask(tools, label) {
  const body = {
    model: MODEL,
    input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
    tools,
    store: false,
  };
  const response = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (response.status >= 400) return { label, status: response.status, error: redact(text).slice(0, 400) };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { label, status: response.status, raw: redact(text).slice(0, 400) };
  }
  const out = (parsed.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? '')
    .join('');
  return { label, status: response.status, answer: out.slice(0, 600) };
}

for (const [label, tools] of Object.entries(ARMS)) {
  const one = await ask(tools, label);
  console.log(`[${label}] http=${one.status}`);
  if (one.error !== undefined) console.log('   错误：', one.error);
  else console.log('   答复：', one.answer);
  console.log(`   含 plain_marker=${String(one.answer ?? '').includes('plain_marker')} 含 probe_echo=${String(one.answer ?? '').includes('probe_echo')}`);
}
