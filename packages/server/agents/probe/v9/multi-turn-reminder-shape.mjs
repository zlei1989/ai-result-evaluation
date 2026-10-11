/**
 * v9 探针：**多轮里 Claude Code 的 `<system-reminder>` 会不会累积**。
 *
 * 为什么需要：`anthropicToOpenAI` 现在把中途 `role:"system"` 整条丢掉；若改成「就地转 user」，
 * 出站报文就会开始携带这些 reminder。于是决定副作用大小的唯一问题是：
 * **客户端每一轮是只带当轮那一份 reminder，还是把历史各轮的都带着？**
 *   · 只带当轮 ⇒ 只是每条 reminder 各留一次，成本 ≈ 每轮 +1850 token（且落在尾部，缓存友好）；
 *   · 带全部历史 ⇒ 会随轮次线性累积（含每轮过期的 `tokens left` 与旧日期）。
 *
 * 做法：本地假网关**主动回 `tool_use`（Bash）**逼客户端跑工具并进入下一轮，
 * 再逐条请求数 `messages[]` 里 `role:"system"` 的条数与 reminder 特征串的出现次数。
 *
 * 用法：`node packages/server/agents/probe/v9/multi-turn-reminder-shape.mjs [--turns=3]`
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DUMP_DIR = join(HERE, '..', 'dumps', 'v9');

/** 让客户端跑几轮工具再收场（最后一轮回文本收尾） */
const TOOL_TURNS = Number((process.argv.find((one) => one.startsWith('--turns=')) ?? '--turns=2').slice('--turns='.length));

/** reminder 的特征串：技能清单头 + token 预算帧 + 环境块 */
const MARKERS = {
  '清单头': 'The following skills are available for use with the Skill tool:',
  'token预算帧': 'tokens left</total_tokens>',
  '环境块': 'Primary working directory:',
  '日期': "Today's date is",
};

function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function textReply(model, text) {
  return sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_p', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function toolReply(model, index) {
  const id = `toolu_probe_${index}`;
  return sse([
    ['message_start', { type: 'message_start', message: { id: `msg_t${index}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Bash', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo probe' }) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function startGateway() {
  const records = [];
  let mainSeen = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (b) => chunks.push(b));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const isMain = Array.isArray(body?.tools) && body.tools.length > 0;
      if (isMain) mainSeen += 1;
      records.push({ path: request.url ?? '', body, isMain, mainIndex: isMain ? mainSeen : 0 });
      const model = String(body?.model ?? 'probe');
      const payload = !isMain
        ? textReply(model, 'ok')
        : mainSeen <= TOOL_TURNS
          ? toolReply(model, mainSeen)
          : textReply(model, '收尾');
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(payload);
    });
  });
  return {
    records,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`);
        });
      }),
    close: () => server.close(),
  };
}

function hostAnthropic() {
  const config = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8'));
  const provider = (config.providers ?? []).find((one) => one.protocolType === 'anthropic');
  if (provider?.baseUrl === undefined || provider.apiKey === undefined) throw new Error('宿主配置里没有 anthropic 供应商');
  return { apiKey: provider.apiKey, modelId: provider.models?.[0]?.id ?? 'probe-model' };
}

async function main() {
  const { apiKey, modelId } = hostAnthropic();
  const gateway = startGateway();
  const relayUrl = await gateway.listen();
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const root = mkdtempSync(join(tmpdir(), 'aieval-v9-multiturn-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  const skillDir = join(configHome, 'skills', 'tang-poem-meal');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: tang-poem-meal\ndescription: 探针技能\n---\n正文。\n', 'utf8');

  const env = { ...process.env };
  env.HOME = configHome;
  env.USERPROFILE = configHome;
  env.CLAUDE_CONFIG_DIR = configHome;
  env.ANTHROPIC_BASE_URL = relayUrl;
  env.ANTHROPIC_API_KEY = apiKey;
  env.ANTHROPIC_AUTH_TOKEN = apiKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const messages = [];
  try {
    const query = sdk.query({
      prompt: '请连续执行两次 `echo probe`，然后总结。',
      options: {
        cwd,
        env,
        model: modelId,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['user', 'project', 'local'],
        settings: { env: { ANTHROPIC_BASE_URL: relayUrl, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: apiKey } },
        abortController: controller,
      },
    });
    for await (const message of query) {
      messages.push(message);
      if (messages.length > 500) break;
    }
  } catch (error) {
    console.log(`查询抛错（不影响抓包）：${String(error?.message ?? error).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
  gateway.close();

  const mains = gateway.records.filter((one) => one.isMain);
  console.log(`\n主请求 ${mains.length} 条（假网关被要求先回 ${TOOL_TURNS} 轮工具调用）`);
  for (const record of mains) {
    const list = record.body?.messages ?? [];
    const roles = list.map((one) => one?.role ?? '?');
    const systemCount = roles.filter((role) => role === 'system').length;
    const allText = JSON.stringify(list);
    const counts = Object.fromEntries(Object.entries(MARKERS).map(([name, marker]) => [name, allText.split(marker).length - 1]));
    console.log(`\n  --- 第 ${record.mainIndex} 个主请求：messages ${list.length} 条，role:"system" ${systemCount} 条 ---`);
    console.log(`    roles: ${JSON.stringify(roles)}`);
    console.log(`    各特征串出现次数：${JSON.stringify(counts)}`);
  }
  mkdirSync(DUMP_DIR, { recursive: true });
  writeFileSync(join(DUMP_DIR, 'multi-turn-mains.json'), JSON.stringify(mains.map((one) => one.body), null, 2).split(apiKey).join('***'), 'utf8');
  console.log(`\n原文落盘：probe/dumps/v9/multi-turn-mains.json`);
  rmSync(root, { recursive: true, force: true });
}

await main();
