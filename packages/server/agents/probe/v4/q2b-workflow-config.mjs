/**
 * v4 / Q2 补充：两个「不进 CLI stdout/stderr 也一样要回答」的子问题。
 *
 *   ① `workflowSizeGuideline` 这个 SDK setting **到底吃不吃**？
 *      手法：把 base URL 指到本机抓包服务，对比不同 setting 下 `Workflow` 工具的
 *      `description` 原文（描述里逐字有 "This session has the default workflow size guideline: medium
 *      — keep workflows under 10 agents"）。这能一次回答「档位是不是 5/10/50」「表达不了 8」。
 *   ② 规模告警的载荷字段（`scheduled_agents`/`agent_cap`/`cap_from_guideline`/`workflow_size_warning`）
 *      **有没有进 SDK 的消息流**（判据③）。
 *
 * 用法：node probe/v4/q2b-workflow-config.mjs
 * 产物：probe/dumps/v4/q2b-workflow-config.json、claude-q2b-sdk-stream.jsonl
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEEPSEEK_ANTHROPIC_BASE_URL, DUMP_DIR, note, writeDump } from './lib/env.mjs';
import { deepseekClaudeEnv, makeWorkspace, runClaudeSdk } from './lib/claude.mjs';

const PORT = 7982;
const captured = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      captured.push({ model: parsed.model ?? null, tools: parsed.tools ?? [] });
    } catch (error) {
      captured.push({ parseError: String(error?.message ?? error).slice(0, 200) });
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'probe: captured' } }));
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
note('抓包服务已监听 127.0.0.1:' + PORT);

const workspace = makeWorkspace();

/** 用抓包服务采一份 `Workflow` 描述（请求到不了模型，但 tools[] 已在请求体里）。 */
async function captureDescription(label, settings) {
  const before = captured.length;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const abort = new AbortController();
  const query = sdk.query({
    prompt: '回答一个字：好。',
    options: {
      cwd: workspace,
      model: 'deepseek-chat',
      maxTurns: 1,
      env: {
        ...deepseekClaudeEnv(),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
        ANTHROPIC_API_KEY: 'probe',
        ANTHROPIC_AUTH_TOKEN: 'probe',
      },
      settings,
      abortController: abort,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
    },
  });
  try { for await (const message of query) void message; } catch { /* 预期 400 */ }
  const frames = captured.slice(before);
  const last = frames.at(-1) ?? { tools: [] };
  const tool = last.tools.find((one) => one.name === 'Workflow') ?? null;
  const description = tool?.description ?? '';
  // 逐字抓那句「规模指引」；`—` 是 em dash，可能被编码搞坏，故用宽松匹配
  const sentence = /This session has the[^.]*?guideline[^.]*?\./.exec(description)?.[0] ?? '（描述里找不到该句）';
  const note2 = /keep workflows under (\d+) agents/.exec(description)?.[1] ?? null;
  note(`${label}：工具数=${last.tools.length} Workflow 在=${tool !== null}；档位句= ${JSON.stringify(sentence)}`);
  return { label, settings, toolCount: last.tools.length, workflowPresent: tool !== null, guidelineSentence: sentence, agentsUnder: note2, descriptionTail: description.slice(-420) };
}

const settingCases = [
  { label: '无 settings', settings: undefined },
  { label: 'enableWorkflows:true + guideline:medium', settings: { enableWorkflows: true, workflowSizeGuideline: 'medium' } },
  { label: 'enableWorkflows:false', settings: { enableWorkflows: false } },
  { label: 'guideline:small', settings: { workflowSizeGuideline: 'small' } },
  { label: 'guideline:large', settings: { workflowSizeGuideline: 'large' } },
  { label: 'guideline:unrestricted', settings: { workflowSizeGuideline: 'unrestricted' } },
  { label: 'guideline:8（设计稿想要的数字）', settings: { workflowSizeGuideline: '8' } },
];
const descriptions = [];
for (const one of settingCases) descriptions.push(await captureDescription(one.label, one.settings));
server.close();

// ── 判据③：SDK 消息流里有没有规模告警 ────────────────────────────────────────────
const GATE_ENV = { CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '8', CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS: '8' };
const SDK_SETTINGS = {
  env: { ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL },
  enableWorkflows: true,
  workflowSizeGuideline: 'medium',
};
const sdkRun = await runClaudeSdk({
  label: 'q2b-sdk-stream',
  prompt: 'use a workflow to count the lines in notes.txt and report the total',
  workspace,
  extraEnv: GATE_ENV,
  extraOptions: { settings: SDK_SETTINGS },
  maxTurns: 6,
  timeoutMs: 300_000,
});

const WARNING_TOKENS = ['scheduled_agents', 'agent_cap', 'cap_from_guideline', 'workflow_size_warning', 'tengu_workflow_size_warning_shown', 'workflow: concurrent agent gate'];
const streamRaw = readFileSync(join(DUMP_DIR, 'v4', 'claude-q2b-sdk-stream.jsonl'), 'utf8');
const streamHits = WARNING_TOKENS.filter((token) => streamRaw.includes(token));
const gateInStream = streamRaw.includes('workflow: concurrent agent gate');
const sdkToolUses = [];
for (const message of sdkRun.messages) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) if (block?.type === 'tool_use') sdkToolUses.push(block.name);
}

note('判据③ SDK 消息流里命中的告警/闸门 token =', JSON.stringify(streamHits));
note('  闸门日志行在 SDK 消息流里 =', gateInStream);
note('  SDK 侧工具调用 =', JSON.stringify(sdkToolUses));

const file = writeDump('v4/q2b-workflow-config', {
  at: new Date().toISOString(),
  descriptions,
  sdkStream: {
    label: 'q2b-sdk-stream',
    gateEnv: GATE_ENV,
    settings: SDK_SETTINGS,
    messageCount: sdkRun.messages.length,
    messageTypes: sdkRun.messages.map((one) => `${one?.type}${one?.subtype ? `/${one.subtype}` : ''}`),
    error: sdkRun.error,
    toolUseNames: sdkToolUses,
    warningTokensFound: streamHits,
    gateLineFound: gateInStream,
    resultSummary: sdkRun.result === null ? null : {
      subtype: sdkRun.result.subtype,
      is_error: sdkRun.result.is_error,
      result: typeof sdkRun.result.result === 'string' ? sdkRun.result.result.slice(0, 800) : sdkRun.result.result,
      usage: sdkRun.result.usage,
    },
    jsonl: sdkRun.file,
  },
});
note('落盘：', file);
