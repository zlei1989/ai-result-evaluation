/**
 * 收口 v4 里唯一还留着的一处**数字对不上**：同一份 CLI 的工具表到底由什么决定。
 *
 * 三个读数摆在一起，看起来互相矛盾：
 *   · 2026-09-30（CLI **2.1.281**、经内网网关、模型名 `Claude-Sonnet-4.6` 等）：**30 项**，开关无增量；
 *   · 2026-10-01（CLI **2.1.283**、本机抓包、模型名 `deepseek-chat`）：默认 **23** → 开关 **27**（+4）；
 *   · 2026-10-01（同一轮、模型名 `claude-sonnet-4-5`）：**27 项**，开关无增量。
 *
 * 上一轮把它们归成"工具表是模型相关的"。但 **27 与 30 这两个数在"同为 claude 系名字"下也不等**，
 * 所以还有一个变量没被单独切出来：**CLI 版本**（2.1.281 vs 2.1.283）。
 *
 * 本脚本用**同一台机器、同一份 2.1.283、同一个本机抓包服务**（请求到不了模型 ⇒ 与后端无关）
 * 把 09-30 那三个模型名逐字重跑一遍：
 *   · 若得 **30** ⇒ 那个数是名字驱动的，与 CLI 版本无关，"模型相关"成立；
 *   · 若得 **27** ⇒ **CLI 版本也是一个变量**，三行读数要按"名字 × 版本"两个轴记。
 *
 * 用法：node probe/v4/claude-tooltable-names.mjs
 */
import { createServer } from 'node:http';
import { note, writeDump } from './lib/env.mjs';
import { deepseekClaudeEnv, makeWorkspace } from './lib/claude.mjs';

const PORT = 7982;
const captured = [];

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      captured.push({
        model: parsed.model ?? null,
        toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
        toolNames: (parsed.tools ?? []).map((tool) => tool.name),
      });
    } catch (error) {
      captured.push({ parseError: String(error?.message ?? error).slice(0, 200) });
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'probe: captured' } }));
  });
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
note(`抓包服务已监听 127.0.0.1:${PORT}`);

const workspace = makeWorkspace();

async function capture(label, extraEnv, model) {
  const before = captured.length;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const query = sdk.query({
    prompt: '回答一个字：好。不要调用任何工具。',
    options: {
      cwd: workspace,
      model,
      maxTurns: 1,
      env: {
        ...deepseekClaudeEnv(extraEnv),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
        ANTHROPIC_API_KEY: 'probe',
        ANTHROPIC_AUTH_TOKEN: 'probe',
      },
      abortController: new AbortController(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
    },
  });
  try {
    for await (const message of query) void message;
  } catch (error) {
    note(`${label} 迭代结束（预期 400）：`, String(error?.message ?? error).slice(0, 120));
  }
  const got = captured.slice(before);
  const last = got.at(-1) ?? { toolCount: 0, toolNames: [] };
  note(`${label}：捕获 ${got.length} 个请求，工具数 = ${got.map((one) => one.toolCount).join(' / ')}`);
  return last;
}

/** 09-30 那三个名字逐字 + 一个对照（上一轮在 2.1.283 上测出 27 的那个）。 */
const MODELS = ['Claude-Sonnet-4.6', 'claude-haiku-4-5', 'Claude-Opus-4.8', 'claude-sonnet-4-5'];
const perModel = {};
for (const model of MODELS) {
  const off = await capture(`默认[${model}]`, {}, model);
  const on = await capture(`开开关[${model}]`, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, model);
  const added = on.toolNames.filter((name) => !off.toolNames.includes(name));
  perModel[model] = {
    off: { toolCount: off.toolCount, toolNames: off.toolNames },
    on: { toolCount: on.toolCount, toolNames: on.toolNames },
    added,
  };
  note(`【${model}】默认 ${off.toolCount} / 开开关 ${on.toolCount}；新增 ${JSON.stringify(added)}`);
}

server.close();

const counts = Object.fromEntries(Object.entries(perModel).map(([model, pair]) => [model, `${pair.off.toolCount}→${pair.on.toolCount}`]));
const anyThirty = Object.values(perModel).some((pair) => pair.off.toolCount === 30 || pair.on.toolCount === 30);
const anyDelta = Object.values(perModel).some((pair) => pair.added.length > 0);
const verdict = anyThirty
  ? '09-30 的 **30 项在 2.1.283 上可复现** ⇒ 工具表由**模型名**驱动，"模型相关"成立；27/23 是别的名字'
  : `09-30 的 30 项**在 2.1.283 上复现不出来**（本次读数 ${JSON.stringify(counts)}）⇒ **CLI 版本也是变量**，三行读数要按"名字 × 版本"两个轴记`;
note('判定：', verdict);
note('开关有没有增量：', anyDelta ? '有（至少一个名字下 +N）' : '全都没有');

const file = writeDump('v4/claude-tooltable-names', {
  at: new Date().toISOString(),
  port: PORT,
  cliVersion: '2.1.283（全局 claude.exe）',
  note: '本机抓包 ⇒ 请求到不了模型，故读数与后端无关；变量只剩「模型名」与「CLI 版本」。',
  perModel,
  counts,
  verdict,
});
note('落盘：', file);
