/**
 * A 线：把二进制里扫到的**思考相关开关**逐个上真机，看哪个能让 `item.type === 'reasoning'` 出现。
 *
 * 候选（来自 `codex-knobs-scan.mjs` 的字符串命中）：
 *   · `show_raw_agent_reasoning`（15/16 处）—— 名字直译就是"把原始推理也显示出来"；
 *   · `hide_agent_reasoning`（20/22 处）—— 与上者成对；
 *   · `model_reasoning_summary`（21/22 处）—— 已单独测过（detailed/concise/none 均无效果）。
 *
 * 判据：事件流里 `item.type === 'reasoning'` 的条数与 `.text` 长度；同时留 `agent_message` 作对照
 * （确保 turn 真的跑完了，不是"失败得早所以没有"）。
 *
 * 用法：node probe/v4/codex-reasoning-knobs.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEEPSEEK_OPENAI_BASE_URL, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';
import { buildExecArgs, spawnCapture } from './lib/codex-exec.mjs';

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const CODEX_EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const SCRATCH = join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', 'tmp', 'reason-knobs');
mkdirSync(SCRATCH, { recursive: true });

const apiKey = loadDeepSeekKey();
const PROMPT = '请先用一句话说明你的推理过程，再给出结论：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？';

const CASES = [
  { label: 'control', extra: {} },
  { label: 'raw-reasoning-true', extra: { show_raw_agent_reasoning: true } },
  { label: 'raw-reasoning+summary-detailed', extra: { show_raw_agent_reasoning: true, model_reasoning_summary: 'detailed' } },
  { label: 'hide-reasoning-false', extra: { hide_agent_reasoning: false } },
  { label: 'hide-false+raw-true', extra: { hide_agent_reasoning: false, show_raw_agent_reasoning: true } },
];

const results = [];
for (const one of CASES) {
  const caseDir = join(SCRATCH, one.label);
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
          wire_api: 'responses',
          requires_openai_auth: true,
          request_max_retries: 1,
        },
      },
      tools: { web_search: false },
      ...one.extra,
    },
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
  for (const line of run.stdoutLines) { try { events.push(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ } }
  const items = events.filter((e) => String(e.type).startsWith('item.')).map((e) => e.item);
  const reasoning = items.filter((i) => i?.type === 'reasoning');
  const rejected = /is ignored|unrecognized configuration|unknown configuration field/i.test(run.stderrLines.join('\n'));

  const row = {
    label: one.label,
    extra: one.extra,
    exitCode: run.exitCode,
    configWarned: rejected,
    itemTypes: [...new Set(items.map((i) => i?.type))],
    reasoningCount: reasoning.length,
    reasoningTexts: reasoning.map((i) => String(i.text ?? '').slice(0, 200)),
    agentMessageCount: items.filter((i) => i?.type === 'agent_message').length,
    stderrHead: run.stderrLines.slice(0, 5),
  };
  results.push(row);
  writeFileSync(join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', `codex-reason-knob-${one.label}.jsonl`), `${run.stdoutLines.join('\n')}\n`, 'utf8');
  note(`${one.label.padEnd(30)} exit=${run.exitCode} 配置告警=${rejected ? '有' : '无'} reasoning=${reasoning.length} agent_message=${row.agentMessageCount}`);
}

const hit = results.find((r) => r.reasoningCount > 0);
const verdict = hit !== undefined
  ? `✅ **找到了**：\`${hit.label}\` 下出现 reasoning item（${hit.reasoningCount} 条）⇒ 思考内容可以走事件流，不必带外取`
  : '❌ 这五个开关都没能让 reasoning item 出现 ⇒ 思考内容仍只能带外取（中继/会话文件）';
note('判定：', verdict);

const file = writeDump('v4/codex-reasoning-knobs', {
  at: new Date().toISOString(),
  exe: CODEX_EXE,
  upstream: DEEPSEEK_OPENAI_BASE_URL,
  model: 'deepseek-reasoner',
  results,
  verdict,
});
note('落盘：', file);
