/**
 * B 线：**子智能体的消息能不能展示？**——查"子线程自己的会话文件（rollout）里有什么"。
 *
 * 已知：`SubagentStop` hook 的载荷里带 **`agent_transcript_path`**（子会话 rollout 的绝对路径），
 * 也就是说**生产环境不需要猜路径**——hook 直接把子线程的会话文件递给我们。
 * 未知（本题要回答的）：那份文件里**有没有子智能体的消息/工具调用/思考**，还是只有一行终态。
 *
 * 做法：在 DeepSeek 路由上真派一个子智能体（该路由上 `spawn_agent` 可用），并让子任务**用一次工具**
 * （这样"子智能体的工具调用"才有东西可看）。跑完把 `$CODEX_HOME/sessions/**` 下**所有** rollout 列出来，
 * 逐份统计记录类型，并把**子线程那份**的 assistant 消息与工具调用摘出来。
 *
 * 判据：
 *   ① 是否出现**两份及以上** rollout（父 + 子）；
 *   ② 子线程那份里有没有 `response_item`/`event_msg` 之类的**逐条事件**（而不是只有 summary）；
 *   ③ 能不能从里面恢复出子智能体的 `assistant` 消息文本与 `function_call`。
 *
 * 用法：node probe/v4/codex-subagent-transcript.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEEPSEEK_OPENAI_BASE_URL, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';
import { buildExecArgs, spawnCapture } from './lib/codex-exec.mjs';

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const CODEX_EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const HOOK_LOGGER = join(REPO, 'packages', 'server', 'agents', 'probe', 'v2', 'hook-log.cjs');
const SCRATCH = join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', 'tmp', 'subagent-transcript');
mkdirSync(SCRATCH, { recursive: true });

const apiKey = loadDeepSeekKey();
const home = join(SCRATCH, 'home');
const cwd = join(SCRATCH, 'cwd');
const hookOut = join(SCRATCH, 'hook-out');
for (const dir of [home, cwd, hookOut]) mkdirSync(dir, { recursive: true });

const PROMPT = [
  '严格按顺序执行：',
  '1. 用 subagent 工具派一个前台子智能体（run_in_background = false）：',
  '   description = "Child runs a tool"',
  '   prompt = "先用 pwsh 执行 `echo CHILD-TOOL-RAN` 拿到输出，再把输出原样写进你的最终答复。"',
  '2. 等它返回后，只回复一个词：done',
].join('\n');

const hookCommand = `"${process.execPath}" "${HOOK_LOGGER}" "${hookOut}"`;
const hookConfig = Object.fromEntries(
  ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop'].map((event) => [
    `hooks.${event}`,
    [{ matcher: '', hooks: [{ type: 'command', command: hookCommand }] }],
  ]),
);

const args = buildExecArgs({
  config: {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'deepseek',
        base_url: DEEPSEEK_OPENAI_BASE_URL,
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    tools: { web_search: false },
    features: { multi_agent: true },
    ...hookConfig,
  },
  model: 'deepseek-chat',
  sandboxMode: 'danger-full-access',
  cwd,
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
  extraArgs: ['--dangerously-bypass-hook-trust'],
});

const run = await spawnCapture(CODEX_EXE, args, {
  env: { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, CODEX_API_KEY: apiKey },
  cwd,
  timeoutMs: 300_000,
  stdin: PROMPT,
});

// ── 会话文件清点 ───────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
const sessionsRoot = join(home, 'sessions');
const rollouts = existsSync(sessionsRoot) ? walk(sessionsRoot) : [];

/** 逐份 rollout 统计：行数、记录类型分布、能不能恢复出 assistant 文本与 function_call。 */
function inspectRollout(file) {
  const rows = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const typeCounts = {};
  const payloadTypes = {};
  const assistantTexts = [];
  const functionCalls = [];
  for (const line of rows) {
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    const t = String(row.type ?? '<无 type>');
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    const payload = row.payload ?? row;
    const pt = String(payload?.type ?? '<无 payload.type>');
    payloadTypes[pt] = (payloadTypes[pt] ?? 0) + 1;
    // assistant 输出文本
    if (payload?.type === 'message' && payload?.role === 'assistant') {
      for (const part of payload.content ?? []) if (part?.type === 'output_text' && part.text) assistantTexts.push(String(part.text).slice(0, 200));
    }
    // 工具调用
    if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call' || payload?.type === 'local_shell_call') {
      functionCalls.push({ type: pt, name: payload.name ?? null, args: String(payload.arguments ?? '').slice(0, 160) });
    }
  }
  return {
    file: relative(SCRATCH, file),
    bytes: statSync(file).size,
    lines: rows.length,
    typeCounts,
    payloadTypeCounts: payloadTypes,
    assistantTextCount: assistantTexts.length,
    assistantTexts: assistantTexts.slice(0, 6),
    functionCallCount: functionCalls.length,
    functionCalls: functionCalls.slice(0, 6),
  };
}

const inspected = rollouts.map(inspectRollout);

// ── hook 载荷（拿 agent_transcript_path 与子线程 id） ──────────────────────────
const hookFile = join(hookOut, 'hooks.jsonl');
const hookPayloads = existsSync(hookFile)
  ? readFileSync(hookFile, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => { try { return JSON.parse(l); } catch { return { raw: l.slice(0, 200) }; } })
  : [];

note(`会话文件 ${rollouts.length} 份；hook 载荷 ${hookPayloads.length} 条`);
for (const one of inspected) {
  note(` · ${one.file} 行=${one.lines} assistant=${one.assistantTextCount} 工具调用=${one.functionCallCount}`);
  note(`   payload 类型：${JSON.stringify(one.payloadTypeCounts)}`);
}

const twoOrMore = inspected.length >= 2;
const childLike = inspected.filter((one) => one.assistantTextCount > 0 && one.functionCallCount > 0);
const verdict = {
  '① 是否有父+子两份': twoOrMore ? `✅ ${inspected.length} 份` : `⚠️ 只有 ${inspected.length} 份`,
  '② 子那份是否逐条事件': inspected.some((one) => one.lines > 5) ? '✅ 有逐条记录（见 payload 类型分布）' : '⚠️ 记录很少',
  '③ 能否恢复子智能体的消息与工具调用': childLike.length > 0
    ? `✅ 能：${childLike.map((one) => one.file).join('、')} 里各有 assistant 文本与 function_call`
    : '❌ 没能从会话文件里恢复出子智能体的消息/工具调用',
  'hook 是否给出子会话路径': hookPayloads.some((p) => JSON.stringify(p).includes('agent_transcript_path')) ? '✅ 是' : '⚠️ 未见',
};
for (const [k, v] of Object.entries(verdict)) note(`判定 ${k}：${v}`);

const file = writeDump('v4/codex-subagent-transcript', {
  at: new Date().toISOString(),
  exe: CODEX_EXE,
  upstream: DEEPSEEK_OPENAI_BASE_URL,
  exitCode: run.exitCode,
  sessionsRoot,
  rolloutCount: rollouts.length,
  inspected,
  hookPayloads,
  verdict,
});
note('落盘：', file);
writeFileSync(join(SCRATCH, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), verdict }, null, 2), 'utf8');
