/**
 * v4 / Q4：重采**入站 `/v1/messages` 请求体的 `tools[]` 全文**（含 description 与 input_schema）。
 *
 * 为什么要自己起一个最小服务（与 v2 `claude-inbound-tools.mjs` 同一手法）：
 * `system/init` 的 `tools[]` **只有名字**，没有描述与 schema；而本题要回答的
 * 「`Workflow` 工具的 opt-in 措辞」必须靠 `description` 原文才能定。
 *
 * 手法：把 `ANTHROPIC_BASE_URL` 指到本机抓包服务（只读入站请求、立刻回 400），
 * 于是请求**到不了模型**，但 `tools[]` 已经在请求体里了——这样采到的工具表与模型是否可驱动无关。
 *
 * A/B 只切一个变量：`CLAUDE_CODE_ENABLE_TODO_TOOLS`（v2 经内网网关测出「无增量」，
 * 本轮换后端复测）。另外对**两个模型名**各测一遍，回答「工具表是模型相关还是后端相关」。
 *
 * 用法：node probe/v4/q4-inbound-tools.mjs
 * 产物：probe/dumps/v4/q4-inbound-tools.json
 */
import { createServer } from 'node:http';
import { note, writeDump } from './lib/env.mjs';
import { deepseekClaudeEnv, makeWorkspace } from './lib/claude.mjs';

const PORT = 7981;
const captured = [];

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
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

const workspace = makeWorkspace();
const prompt = '回答一个字：好。不要调用任何工具。';

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
      env: {
        ...deepseekClaudeEnv(extraEnv),
        // 覆盖：把 base URL 指到抓包服务，凭据换成占位串（真 key 不参与本次请求）
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
        ANTHROPIC_API_KEY: 'probe',
        ANTHROPIC_AUTH_TOKEN: 'probe',
      },
      abortController: abort,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
    },
  });
  try {
    for await (const message of query) void message;
  } catch (error) {
    note(`${label} 迭代结束（预期：400）：`, String(error?.message ?? error).slice(0, 160));
  }
  const got = captured.slice(before);
  note(`${label}：捕获 ${got.length} 个请求，工具数 = ${got.map((one) => one.toolCount).join(' / ')}`);
  return got;
}

/** 取最后一帧（最完整的一份 tools[]）。 */
const last = (frames) => frames.at(-1) ?? { tools: [], toolCount: 0 };

const perModel = {};
for (const model of ['deepseek-chat', 'claude-sonnet-4-5']) {
  const off = await capture(`默认[${model}]`, {}, model);
  const on = await capture(`开开关[${model}]`, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, model);
  const offNames = last(off).tools.map((tool) => tool.name);
  const onNames = last(on).tools.map((tool) => tool.name);
  const added = onNames.filter((name) => !offNames.includes(name));
  const removed = offNames.filter((name) => !onNames.includes(name));
  note(`【${model}】默认 ${offNames.length} 项 / 开开关 ${onNames.length} 项；新增 ${JSON.stringify(added)}；移除 ${JSON.stringify(removed)}`);
  note(`【${model}】默认工具名 = ${JSON.stringify(offNames)}`);
  perModel[model] = {
    off: { toolCount: last(off).toolCount, toolNames: offNames, tools: last(off).tools },
    on: { toolCount: last(on).toolCount, toolNames: onNames, tools: last(on).tools },
    added,
    removed,
  };
}

server.close();

/** 本题关心的几个名字在不在（含 `Task*` 前缀族与 `Workflow`）。 */
const WATCHED = ['AskUserQuestion', 'TodoWrite', 'Task', 'TaskStop', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Workflow'];
const presence = {};
for (const [model, pair] of Object.entries(perModel)) {
  presence[model] = Object.fromEntries(WATCHED.map((name) => [
    name,
    { off: pair.off.toolNames.includes(name), on: pair.on.toolNames.includes(name) },
  ]));
}

const file = writeDump('v4/q4-inbound-tools', {
  at: new Date().toISOString(),
  port: PORT,
  prompt,
  presence,
  perModel,
});
note('presence =', JSON.stringify(presence, null, 2));
note('落盘：', file);
