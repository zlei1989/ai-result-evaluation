/**
 * 官方文档给出的 claude 侧两条补齐办法，本机实测：
 *
 *  ① **`AskUserQuestion` 为什么不在入站工具表**——官方原话是"它**默认可用**，
 *     但若你指定了 `tools` 数组来限制内置工具，就必须把它显式包含进去"。
 *     我们的抓包**没有**传 `tools`，却仍然 0/4 命中 ⇒ 必须实测"显式列进去到底有没有用"。
 *  ② **`includePartialMessages`**——官方说开了它会产 `stream_event`
 *     （`content_block_delta` + `text_delta`），且 **stream event 的 `parent_tool_use_id` 恒 null、
 *     只覆盖主会话**。这决定 claude 的 `chunk: 'delta'` 与"思考流式"能不能翻盘。
 *
 * 两件事分开做：① 只用**抓包**（请求到不了模型，零成本、与模型无关）；
 * ② 需要**真跑**（增量是响应侧产物）。
 *
 * 用法：node probe/v4/claude-official-remedies.mjs
 */
import { createServer } from 'node:http';
import { note, writeDump } from './lib/env.mjs';
import { deepseekClaudeEnv, makeWorkspace } from './lib/claude.mjs';

const PORT = 7988;
const captured = [];

/** 抓包服务：读入站请求体，立刻回 400（请求到不了模型 ⇒ 与"模型能不能驱动"无关）。 */
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
      captured.push({ parseError: String(error?.message ?? error).slice(0, 160) });
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'probe: captured' } }));
  });
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
note(`抓包服务已监听 127.0.0.1:${PORT}`);

const workspace = makeWorkspace();
const captureEnv = {
  ...deepseekClaudeEnv({}),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  ANTHROPIC_API_KEY: 'probe',
  ANTHROPIC_AUTH_TOKEN: 'probe',
};

/** 一次纯抓包（不发真请求）。 */
async function capture(label, options) {
  const before = captured.length;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  try {
    for await (const message of sdk.query({
      prompt: '回答一个字：好。不要调用任何工具。',
      options: {
        cwd: workspace,
        model: 'deepseek-chat',
        maxTurns: 1,
        env: captureEnv,
        abortController: new AbortController(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        ...options,
      },
    })) void message;
  } catch { /* 预期 400 */ }
  const last = captured.slice(before).at(-1) ?? { toolCount: 0, toolNames: [] };
  note(`【${label}】工具数=${last.toolCount}；AskUserQuestion=${last.toolNames.includes('AskUserQuestion') ? '✅在' : '❌不在'}`);
  return { label, toolCount: last.toolCount, hasAskUserQuestion: last.toolNames.includes('AskUserQuestion'), toolNames: last.toolNames };
}

const cases = [];
cases.push(await capture('基线（不传 tools）', {}));
cases.push(await capture('tools 里显式列 AskUserQuestion', { tools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'] }));
cases.push(await capture('allowedTools 里点名', { allowedTools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'] }));
cases.push(await capture('tools 里再带上 Task 四件套', { tools: ['Read', 'Glob', 'Grep', 'AskUserQuestion', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'] }));
// 新假设：`AskUserQuestion` 需要**存在 canUseTool 回调**才被提供（没有 handler 就不给这个工具）。
cases.push(await capture('tools 列 + canUseTool 回调', {
  tools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
  canUseTool: async (toolName, input) => ({ behavior: 'allow', updatedInput: input }),
}));
cases.push(await capture('只给 canUseTool（不列 tools）', {
  canUseTool: async (toolName, input) => ({ behavior: 'allow', updatedInput: input }),
}));

server.close();

/**
 * ② 真跑一次 `includePartialMessages`：看 `stream_event` 的形状与
 * `content_block_delta.delta.text_delta`，并核对 stream event 里 `parent_tool_use_id` 是否为 null。
 */
async function realStreaming() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const seen = { types: {}, streamEventCount: 0, textDeltaChunks: [], parentToolUseIdValues: new Set(), contentTypeDeltas: {}, deltaSubtypes: {}, thinkingDeltas: [], signatureDeltas: 0 };
  try {
    for await (const message of sdk.query({
      prompt: '用一句话说明：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？',
      options: {
        cwd: workspace,
        model: 'deepseek-chat',
        maxTurns: 1,
        env: deepseekClaudeEnv({}),
        abortController: new AbortController(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        includePartialMessages: true,
      },
    })) {
      seen.types[message.type] = (seen.types[message.type] ?? 0) + 1;
      if (message.type === 'stream_event') {
        seen.streamEventCount += 1;
        const event = message.event ?? {};
        const kind = String(event.type ?? '<无 type>');
        seen.contentTypeDeltas[kind] = (seen.contentTypeDeltas[kind] ?? 0) + 1;
        if (event.type === 'content_block_delta') {
          // 逐个子类型计数：`text_delta` 是正文，但要看清**其余 36 个 delta 是什么**
          // （若有 `thinking_delta`，说明 claude 的思考也能流式拿到）
          const sub = String(event.delta?.type ?? '<无 delta.type>');
          seen.deltaSubtypes[sub] = (seen.deltaSubtypes[sub] ?? 0) + 1;
          if (sub === 'text_delta') seen.textDeltaChunks.push(String(event.delta.text ?? ''));
          if (sub === 'thinking_delta') seen.thinkingDeltas.push(String(event.delta.thinking ?? ''));
          if (sub === 'signature_delta') seen.signatureDeltas += 1;
        }
        seen.parentToolUseIdValues.add(String(message.parent_tool_use_id ?? 'null'));
      }
    }
  } catch (error) {
    note('真跑抛错：', String(error?.message ?? error).slice(0, 200));
  }
  const joined = seen.textDeltaChunks.join('');
  const thinkingJoined = seen.thinkingDeltas.join('');
  note(`【includePartialMessages】stream_event=${seen.streamEventCount} 条；text_delta 片段=${seen.textDeltaChunks.length} 个，拼接长度=${joined.length}`);
  note(`  delta 子类型分布：${JSON.stringify(seen.deltaSubtypes)}`);
  note(`  thinking_delta 片段=${seen.thinkingDeltas.length} 个，拼接长度=${thinkingJoined.length}；signature_delta=${seen.signatureDeltas}`);
  note(`  消息类型分布：${JSON.stringify(seen.types)}`);
  note(`  stream event 的事件类型分布：${JSON.stringify(seen.contentTypeDeltas)}`);
  note(`  stream event 里 parent_tool_use_id 取值集合：${JSON.stringify([...seen.parentToolUseIdValues])}`);
  return {
    ...seen,
    parentToolUseIdValues: [...seen.parentToolUseIdValues],
    textDeltaJoinedLength: joined.length,
    textDeltaSample: seen.textDeltaChunks.slice(0, 8),
    thinkingDeltaJoinedLength: thinkingJoined.length,
    thinkingDeltaSample: seen.thinkingDeltas.slice(0, 4),
  };
}

const streaming = await realStreaming();

const askFix = cases.some((one) => one.label.startsWith('tools') && one.hasAskUserQuestion);
const verdict = {
  '① AskUserQuestion 能不能靠 tools 数组带回来': askFix
    ? `✅ 能：显式列进 \`tools\` 后，入站 tools[] 里有 AskUserQuestion（${cases.find((one) => one.label.startsWith('tools'))?.toolCount} 项）`
    : '❌ 不能：三种写法都没把它带回来 ⇒ 官方的"默认可用"在本机/本版本不成立（另有门控）',
  '② includePartialMessages 能不能给真增量': streaming.streamEventCount > 0 && streaming.textDeltaJoinedLength > 0
    ? `✅ 能：${streaming.streamEventCount} 条 stream_event，text_delta 拼出 ${streaming.textDeltaJoinedLength} 字符 ⇒ claude 的 \`chunk:'delta'\` 可成立（仅主会话）`
    : '❌ 不能：没观察到 stream_event 或 text_delta',
  'parent_tool_use_id 是否恒 null': JSON.stringify(streaming.parentToolUseIdValues) === '["null"]'
    ? '✅ 与官方一致（恒 null）⇒ 增量只覆盖主会话，子智能体增量要另找'
    : `⚠️ 观察到非 null：${JSON.stringify(streaming.parentToolUseIdValues)}`,
};
for (const [k, v] of Object.entries(verdict)) note(`判定 ${k}：${v}`);

const file = writeDump('v4/claude-official-remedies', {
  at: new Date().toISOString(),
  captureCases: cases,
  streaming,
  verdict,
});
note('落盘：', file);
