/**
 * 前提验证：**把 codex 的 `wire_api` 从 `responses` 换成 `chat`，推理正文会不会进事件流？**
 *
 * 为什么必须先验再改代码：
 *   · 已实测的是——**上游** `/chat/completions` 对推理模型回 `reasoning_content`（`hasReasoningContent: true`）；
 *   · **未**实测的是——**codex** 会不会把 chat wire 的 `reasoning_content` 投影成 `item.type === 'reasoning'`。
 *     这两件事不是一回事：responses wire 上上游同样给了明文，codex 却没投影。
 * ⇒ 若 chat wire 下事件流仍无 reasoning item，那么"改 chat 就解决思考问题"这个前提**不成立**，
 *   改代码只会换来"看起来解决了"。
 *
 * 判据（逐条打印原始形态，不靠推断）：
 *   ① chat wire 的 turn 能不能跑完（exit=0 + `agent_message`）；
 *   ② 事件流里有没有 `item.type === 'reasoning'`，其 `.text` 是否非空；
 *   ③ 对照：同一 prompt 在 `responses` 下的读数（应有 0 条）。
 *
 * 用法：node probe/v4/codex-chat-wire-reasoning.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEEPSEEK_OPENAI_BASE_URL, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';
import { buildExecArgs, spawnCapture } from './lib/codex-exec.mjs';

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const CODEX_EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const SCRATCH = join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', 'tmp', 'chat-wire');
mkdirSync(SCRATCH, { recursive: true });

const apiKey = loadDeepSeekKey();
const PROMPT = '请先用一句话说明你的推理过程，再给出结论：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？';

const CASES = [
  { label: 'chat-reasoner', wire: 'chat', model: 'deepseek-reasoner' },
  { label: 'chat-chat', wire: 'chat', model: 'deepseek-chat' },
  { label: 'responses-reasoner(对照)', wire: 'responses', model: 'deepseek-reasoner' },
];

const results = [];
for (const one of CASES) {
  const caseDir = join(SCRATCH, one.label.replace(/[^A-Za-z0-9-]/g, '_'));
  const home = join(caseDir, 'home');
  const cwd = join(caseDir, 'cwd');
  for (const dir of [home, cwd]) mkdirSync(dir, { recursive: true });

  const args = buildExecArgs({
    config: {
      model_provider: 'aieval',
      model_providers: {
        aieval: {
          name: 'deepseek',
          base_url: DEEPSEEK_OPENAI_BASE_URL,
          wire_api: one.wire,
          requires_openai_auth: true,
          request_max_retries: 1,
        },
      },
      tools: { web_search: false },
    },
    model: one.model,
    sandboxMode: 'danger-full-access',
    cwd,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
  });

  const run = await spawnCapture(CODEX_EXE, args, {
    env: { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, CODEX_API_KEY: apiKey },
    cwd,
    timeoutMs: 240_000,
    stdin: PROMPT,
  });

  const events = [];
  const unparsable = [];
  for (const line of run.stdoutLines) { try { events.push(JSON.parse(line)); } catch { unparsable.push(line.slice(0, 240)); } }
  const items = events.filter((e) => String(e.type).startsWith('item.')).map((e) => e.item);
  const reasoningItems = items.filter((i) => i?.type === 'reasoning');
  const agentMessages = items.filter((i) => i?.type === 'agent_message');
  const errors = events.filter((e) => e.type === 'error').map((e) => String(e.message).slice(0, 260));

  writeFileSync(join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', `codex-chatwire-${one.label.replace(/[^A-Za-z0-9-]/g, '_')}.jsonl`), `${run.stdoutLines.join('\n')}\n`, 'utf8');

  const row = {
    label: one.label,
    wire: one.wire,
    model: one.model,
    exitCode: run.exitCode,
    eventTypes: [...new Set(events.map((e) => e.type))],
    itemTypes: [...new Set(items.map((i) => i?.type))],
    reasoningItemCount: reasoningItems.length,
    reasoningItems: reasoningItems.slice(0, 2),
    agentMessageCount: agentMessages.length,
    errors,
    unparsable,
    stderrHead: run.stderrLines.slice(0, 6),
  };
  results.push(row);
  note(`${one.label.padEnd(28)} wire=${one.wire.padEnd(9)} exit=${run.exitCode} item=${JSON.stringify(row.itemTypes)} reasoning=${reasoningItems.length}`);
  if (errors.length > 0) note(`   error: ${errors[0]}`);
}

const chatCase = results.find((r) => r.wire === 'chat' && r.reasoningItemCount > 0);
const control = results.find((r) => r.wire === 'responses');
const verdict = chatCase !== undefined
  ? `✅ 前提成立：chat wire（${chatCase.label}）下事件流**出现 reasoning item**（${chatCase.reasoningItemCount} 条），`
    + `而 responses 对照为 ${control?.reasoningItemCount ?? 'n/a'} 条 ⇒ 换成 chat wire 确实能让思考正文进事件流`
  : '❌ **前提不成立**：chat wire 下事件流**仍然没有** reasoning item ⇒ 换 wire 解决不了"拿不到思考正文"；'
    + '（可拿到的仍是上游响应体这一条带外通道，见 v2 §2.2.1）';
note('判定：', verdict);

const file = writeDump('v4/codex-chat-wire-reasoning', {
  at: new Date().toISOString(),
  exe: CODEX_EXE,
  upstream: DEEPSEEK_OPENAI_BASE_URL,
  prompt: PROMPT,
  results,
  verdict,
});
note('落盘：', file);
