/**
 * claude 真机项②：抓**入站 `/v1/messages` 请求体的 `tools[]` 全文**（含 description 与 input_schema）。
 *
 * 为什么要自己起一个最小服务：`system/init` 的 `tools[]` 只有**名字**，没有描述与 schema。
 * 而若干格必须靠描述原文才能定：
 *  - 开放问题：`ReportFindings` 的语义（"待真机确认"，暂按 `deliver/agent` 占位）；
 *  - `TaskCreate` 的输入形状（`id` 从哪来）；
 *  - `AskUserQuestion` 到底在不在（feature-gated 还是 preset 未启用）；
 *  - `Bash` 的 `timeout` 参数等族结构落点。
 *
 * 做法与抓 codex 工具表**同一手法**（三家用法见 `docs/protocols/comparison.md`）:
 * 起一个只读入站请求、立刻回 400 的最小服务，把 `tools[]` 落盘。
 * 同一次运行做 A/B（默认 vs `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`），**只切那一个变量**。
 */
import { createServer } from 'node:http';
import { note, writeDump } from './lib/gateway.mjs';
import { runClaudeProbe } from './lib/claude.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 7997;
const captured = [];

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      captured.push({
        url: request.url,
        model: parsed.model ?? null,
        toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
        tools: parsed.tools ?? [],
      });
    } catch (error) {
      captured.push({ url: request.url, parseError: String(error?.message ?? error).slice(0, 200) });
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'probe: captured' } }));
  });
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
note('抓包服务已监听 127.0.0.1:' + PORT);

const workspace = mkdtempSync(join(tmpdir(), 'aieval-v2-cctools-'));
const prompt = '回答一个字：好。不要调用任何工具。';

/**
 * 逐个模型跑 A/B。
 * 为什么不能只测一个模型：已有结论是「工具表还受**模型 preset** 影响；
 * 判据以『同一次 A/B 的增量』为准」——本次先用 `Claude-Sonnet-4.6` 得到「无增量」，
 * 必须换模型再验一次，才能判断那条 26→30 的旧结论是**模型相关**还是**已失效**。
 */
const MODELS = (process.argv.slice(2).filter((arg) => arg.startsWith('--model=')).map((arg) => arg.slice(8)));
const models = MODELS.length === 0 ? ['Claude-Sonnet-4.6', 'claude-haiku-4-5', 'Claude-Opus-4.8'] : MODELS;

/** 直接把 base URL 指向抓包服务：请求到不了模型，但 `tools[]` 已经在请求体里了。 */
async function capture(label, extraEnv, model) {
  const before = captured.length;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const abort = new AbortController();
  const query = sdk.query({
    prompt,
    options: {
      cwd: workspace,
      model,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      settingSources: [],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
        ANTHROPIC_API_KEY: 'probe',
        ANTHROPIC_AUTH_TOKEN: 'probe',
        ...extraEnv,
      },
      abortController: abort,
    },
  });
  try {
    for await (const _message of query) {
      // 只为了把请求发出去；回 400 后迭代会结束或抛错，两种都可接受
      void _message;
    }
  } catch (error) {
    note(`${label} 迭代结束（预期：400）：`, String(error?.message ?? error).slice(0, 160));
  }
  const got = captured.slice(before);
  note(`${label}：捕获 ${got.length} 个请求，工具数 = ${got.map((one) => one.toolCount).join(' / ')}`);
  return got;
}

/** 取最后一帧（最完整的一份 tools[]）。 */
const last = (frames) => frames.at(-1) ?? { tools: [] };

const perModel = {};
for (const model of models) {
  const off = await capture(`默认[${model}]`, {}, model);
  const on = await capture(`开开关[${model}]`, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, model);
  const offNames = last(off).tools.map((tool) => tool.name);
  const onNames = last(on).tools.map((tool) => tool.name);
  const added = onNames.filter((name) => !offNames.includes(name));
  const removed = offNames.filter((name) => !onNames.includes(name));
  note(`【${model}】默认 ${offNames.length} 项 / 开开关 ${onNames.length} 项；新增 ${JSON.stringify(added)}；移除 ${JSON.stringify(removed)}`);
  perModel[model] = {
    off: { toolNames: offNames, tools: last(off).tools },
    on: { toolNames: onNames, tools: last(on).tools },
    added,
    removed,
  };
}

server.close();

const file = writeDump('v2/claude-inbound-tools', {
  at: new Date().toISOString(),
  port: PORT,
  models,
  perModel,
});
note('→', file);
