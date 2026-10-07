/**
 * codex 的 reasoning item 为什么在 `exec` 事件流里不出现？两个互斥成因，本脚本把它们分开：
 *
 *   (a) **codex 不映射**：wire 层有 reasoning，但 CLI 从不把它投影成 `item.type==='reasoning'`（硬限制）；
 *   (b) **上游没给摘要**：codex 的 `ReasoningItem` 语义是"推理**摘要**"（summary），
 *       而本次上游回的 `summary` 是**空数组**（`"summary":[]`）⇒ 没有东西可映射。
 *
 * 怎么分开：`codex debug models` 的模型元数据里有一格 **`default_reasoning_summary`**
 * （属于"模型面对模型的摘要档位"），对应 CLI 的推理摘要配置。若把它调成 `detailed` 后
 * **reasoning item 出现** ⇒ (b) 成立（是"上游没给摘要"，不是"codex 不投影"）；
 * 若调了仍然没有 ⇒ 至少在当前后端上偏向 (a)。
 *
 * 判据一律"打印原始形态"：wire 层的 `summary` 与事件流的 item 类型都要逐字留档。
 *
 * 用法：node probe/v4/codex-reasoning-summary.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEEPSEEK_OPENAI_BASE_URL, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';
import { buildExecArgs, spawnCapture } from './lib/codex-exec.mjs';

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const CODEX_EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const SCRATCH = join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', 'tmp', 'reason-summary');
mkdirSync(SCRATCH, { recursive: true });

const apiKey = loadDeepSeekKey();
const PROMPT = '请先用一句话说明你的推理过程，再给出结论：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？';

/** 两个 case 只差一格：推理摘要档位。 */
const CASES = [
  { label: 'control', summary: undefined },
  { label: 'summary-detailed', summary: 'detailed' },
  { label: 'summary-concise', summary: 'concise' },
  { label: 'summary-none', summary: 'none' },
];

const results = [];
for (const one of CASES) {
  const caseDir = join(SCRATCH, one.label);
  const home = join(caseDir, 'home');
  const cwd = join(caseDir, 'cwd');
  for (const dir of [home, cwd]) mkdirSync(dir, { recursive: true });

  const config = {
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
    ...(one.summary === undefined ? {} : { model_reasoning_summary: one.summary }),
    tools: { web_search: false },
  };

  const args = buildExecArgs({
    config,
    model: 'deepseek-reasoner',
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
  for (const line of run.stdoutLines) {
    try { events.push(JSON.parse(line)); } catch { unparsable.push(line.slice(0, 200)); }
  }
  const items = events.filter((e) => String(e.type).startsWith('item.')).map((e) => e.item);
  const reasoningItems = items.filter((i) => i?.type === 'reasoning');
  const errors = events.filter((e) => e.type === 'error').map((e) => String(e.message).slice(0, 200));

  const row = {
    label: one.label,
    summarySetting: one.summary ?? '<未设置>',
    exitCode: run.exitCode,
    eventTypes: [...new Set(events.map((e) => e.type))],
    itemTypes: [...new Set(items.map((i) => i?.type))],
    reasoningItemCount: reasoningItems.length,
    reasoningItems,
    errors,
    unparsable,
    stderrHead: run.stderrLines.slice(0, 4),
  };
  results.push(row);
  note(`${one.label.padEnd(18)} exit=${run.exitCode} item=${JSON.stringify(row.itemTypes)} reasoning=${reasoningItems.length}`);
  appendJsonlSafe(one.label, run.stdoutLines);
}

/** 原始事件按 case 落盘（覆盖写，避免两次运行混在一个文件里）。 */
function appendJsonlSafe(label, lines) {
  writeFileSync(join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', `codex-reason-summary-${label}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

const anyReasoning = results.some((r) => r.reasoningItemCount > 0);
const verdict = anyReasoning
  ? `**reasoning item 出现了**（${results.filter((r) => r.reasoningItemCount > 0).map((r) => `${r.label}×${r.reasoningItemCount}`).join('、')}）`
    + ' ⇒ 成因是 (b)：**上游没给非空的 summary** 时 codex 就不产出该 item；「codex 从不投影」的说法不成立'
  : '设置摘要在本后端上**仍然没有** reasoning item ⇒ 至少在该后端上偏向成因 (a)：**codex 的 exec 事件流不映射 reasoning**'
    + '（注意：这仍不能排除"该后端不给 summary"这一层，见 wire 层原始形态）';
note('判定：', verdict);

const file = writeDump('v4/codex-reason-summary', {
  at: new Date().toISOString(),
  exe: CODEX_EXE,
  model: 'deepseek-reasoner',
  wire: DEEPSEEK_OPENAI_BASE_URL,
  prompt: PROMPT,
  results,
  verdict,
});
note('落盘：', file);
