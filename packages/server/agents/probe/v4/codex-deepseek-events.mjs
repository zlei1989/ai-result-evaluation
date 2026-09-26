/**
 * v4 Q2 + Q3：DeepSeek 路由上的**事件全集**与 **item 全集**，以及 `reasoning` / `collab_tool_call` 到底出不出现。
 *
 * 口径（本仓硬规矩）：凡「某字段不存在/为空」的结论，**先打印原始形态**再下结论。所以本脚本：
 *   ① 直接 spawn codex.exe（argv 与 SDK 同形，`exec --experimental-json`），按 `run` 收**逐字 stdout**；
 *   ② 原始行一律原样追加进 `probe/dumps/v4/codex-deepseek-events.jsonl`（不 parse 再序列化）；
 *   ③ 另落一份 `…-events.json`：每个 run 的 argv、退出码、stderr、事件 type 全集、item type 全集、
 *      每种 type 的首条原文、全部 `turn.completed.usage` 原文、全部 `reasoning` item 原文；
 *   ④ 补一条 **wire 层**证据：直接问 DeepSeek `/v1/responses` 要一份原始响应，用来区分
 *      「wire 上就没有 reasoning 条目」与「codex 把 reasoning 丢了」——没有这一步，③ 的结论不成立。
 *
 * 跑哪些：模型 × multi_agent 各一格（题面要求 deepseek-reasoner / deepseek-chat；另加 gpt-5.5 与
 * DeepSeek 自己报出来的两个合法名，把「模型名边界」一次钉住）。每个 run 硬超时 240s。
 *
 * 用法：node probe/v4/codex-deepseek-events.mjs
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { DEEPSEEK_OPENAI_BASE_URL, appendJsonl, fetchWithTimeout, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
/** 0.154.0（全局 CLI）：本轮 turnaround 的主力，上一轮的结论也基于它，便于对照。 */
const V154 = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
/** 0.156.1（适配器实际 spawn 的那份）：home 放在工作区内时才起得来（见 Q1 的边界）。 */
const V156 = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const STAGE = join(HERE, '..', 'dumps', 'v4', 'tmp');
const key = loadDeepSeekKey();

const PROMPT = '请先用一句话说明你的推理过程，再给出结论：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？';

function buildConfig(multiAgent) {
  return {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval deepseek',
        base_url: DEEPSEEK_OPENAI_BASE_URL,
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    tools: { web_search: false, update_plan: { enabled: true } },
    features: { multi_agent: multiAgent },
  };
}

const runs = [];
const rawLinesAll = [];

async function codexRun(label, { exe, exeLabel, model, multiAgent = false, prompt = PROMPT, timeoutMs = 240_000, extraArgs = [] }) {
  const home = join(STAGE, `events-${label}`);
  const cwd = join(home, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const args = buildExecArgs({
    config: buildConfig(multiAgent),
    model,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    cwd,
    skipGitRepoCheck: true,
  });
  for (const one of extraArgs) args.push(one);
  args.push(prompt);
  const out = await spawnCapture(exe, args, {
    env: buildEnv({ codexHome: home, apiKey: key }),
    cwd,
    timeoutMs,
  });

  // 逐字保留：原始行按出现顺序进 JSONL（`run` 标签写进同一行，避免破坏「原文」这条判据）
  const originalLines = out.stdoutLines;
  for (const line of originalLines) rawLinesAll.push(line);

  const parsed = [];
  const unparsable = [];
  for (const line of originalLines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      unparsable.push(line);
    }
  }
  const eventTypes = [...new Set(parsed.map((one) => one?.type ?? 'unknown'))];
  const itemTypes = [...new Set(parsed.map((one) => one?.item?.type).filter((one) => one !== undefined))];
  const firstOfType = {};
  for (const one of parsed) if (firstOfType[one?.type] === undefined) firstOfType[one?.type] = one;
  const usageAll = parsed.filter((one) => one?.type === 'turn.completed').map((one) => one.usage ?? null);
  const reasoningItems = parsed.filter((one) => one?.item?.type === 'reasoning').map((one) => one.item);
  const collabItems = parsed.filter((one) => one?.item?.type === 'collab_tool_call').map((one) => one.item);

  const record = {
    label,
    exe: exeLabel,
    model,
    multiAgent,
    home,
    prompt,
    argv: args,
    exitCode: out.exitCode,
    signal: out.signal,
    timedOut: out.timedOut,
    ms: out.ms,
    stderrRaw: out.stderr,
    events: parsed.length,
    unparsableLines: unparsable,
    eventTypes,
    itemTypes,
    firstOfType,
    usageAll,
    usageKeysUnion: [...new Set(usageAll.flatMap((one) => (one === null ? [] : Object.keys(one))))],
    reasoningItems,
    collabItems,
  };
  runs.push(record);
  note(`run ${label} →`, `exe=${exeLabel}`, `model=${model}`, `multi_agent=${multiAgent}`, `exit=${out.exitCode}`, `事件=${parsed.length}`);
  note('   eventTypes:', eventTypes.join(', ') || '（无事件）');
  note('   itemTypes :', itemTypes.join(', ') || '（无 item）');
  if (out.exitCode !== 0) note('   stderr:', out.stderr.split(/\r?\n/).filter((one) => one.trim() !== '').slice(0, 3).join(' | '));
  return record;
}

mkdirSync(STAGE, { recursive: true });

// ── Q2：两个题面指定模型，各在 0.154.0 与 0.156.1 上各跑一次（0.156.1 只在工作区内 home 下可跑）
await codexRun('154-chat', { exe: V154, exeLabel: '0.154.0', model: 'deepseek-chat' });
await codexRun('154-reasoner', { exe: V154, exeLabel: '0.154.0', model: 'deepseek-reasoner' });
await codexRun('156-chat', { exe: V156, exeLabel: '0.156.1', model: 'deepseek-chat' });
await codexRun('156-reasoner', { exe: V156, exeLabel: '0.156.1', model: 'deepseek-reasoner' });

// 模型名边界（DeepSeek 的错误串自己列出了合法名，这里逐格验证）
await codexRun('154-gpt55', { exe: V154, exeLabel: '0.154.0', model: 'gpt-5.5' });
await codexRun('154-v4pro', { exe: V154, exeLabel: '0.154.0', model: 'deepseek-v4-pro' });
await codexRun('154-flash', { exe: V154, exeLabel: '0.154.0', model: 'deepseek-flash' });

// ── Q3：multi_agent=true（0.154.0 与 0.156.1 各一次，且给一个**明确要求派生**的 prompt）
const AGENT_PROMPT = '请用 spawn_agent 工具派一个子智能体去把 1+1 算出来，然后汇报它的结论。如果你的工具表里没有这个工具，就直接说明「没有该工具」。';
await codexRun('154-multi-chat', { exe: V154, exeLabel: '0.154.0', model: 'deepseek-chat', multiAgent: true, prompt: AGENT_PROMPT });
await codexRun('156-multi-chat', { exe: V156, exeLabel: '0.156.1', model: 'deepseek-chat', multiAgent: true, prompt: AGENT_PROMPT });
await codexRun('154-multi-reasoner', { exe: V154, exeLabel: '0.154.0', model: 'deepseek-reasoner', multiAgent: true, prompt: AGENT_PROMPT });

// ── ④ wire 层对照：DeepSeek `/v1/responses` 原文里有没有 reasoning 条目
const wire = {};
for (const model of ['deepseek-reasoner', 'deepseek-chat']) {
  try {
    const response = await fetchWithTimeout(
      `${DEEPSEEK_OPENAI_BASE_URL}/responses`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          input: '请先说明推理过程，再给出结论：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？',
          max_output_tokens: 512,
          ...(model === 'deepseek-reasoner' ? { reasoning: { effort: 'medium' } } : {}),
        }),
      },
      180_000,
    );
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 就只留原文 */
    }
    wire[model] = {
      status: response.status,
      outputItemTypes: Array.isArray(json?.output) ? json.output.map((one) => one?.type ?? 'unknown') : null,
      outputItemTypesBreakdown: Array.isArray(json?.output)
        ? json.output.map((one) => ({ type: one?.type, contentType: one?.content?.map?.((c) => c?.type) ?? null, hasSummary: Array.isArray(one?.summary), summaryLen: Array.isArray(one?.summary) ? one.summary.length : null }))
        : null,
      usageRaw: json?.usage ?? null,
      reasoningRaw: Array.isArray(json?.output) ? json.output.filter((one) => one?.type === 'reasoning') : null,
      bodyHead: text.slice(0, 900),
    };
    note(`wire ${model} →`, response.status, `output types=${JSON.stringify(wire[model].outputItemTypes)}`);
  } catch (error) {
    wire[model] = { error: String(error?.message ?? error) };
    note(`wire ${model} ✗`, wire[model].error);
  }
}

const jsonlFile = appendJsonl('v4/codex-deepseek-events', rawLinesAll);
const file = writeDump('v4/codex-deepseek-events', {
  at: new Date().toISOString(),
  binaries: { '0.154.0': V154, '0.156.1': V156 },
  jsonl: jsonlFile,
  runs,
  wire,
  unionOfEventTypes: [...new Set(runs.flatMap((one) => one.eventTypes))],
  unionOfItemTypes: [...new Set(runs.flatMap((one) => one.itemTypes))],
  unionOfUsageKeys: [...new Set(runs.flatMap((one) => one.usageKeysUnion))],
  reasoningItemsTotal: runs.reduce((sum, one) => sum + one.reasoningItems.length, 0),
  collabItemsTotal: runs.reduce((sum, one) => sum + one.collabItems.length, 0),
});
note('事件 type 全集：', [...new Set(runs.flatMap((one) => one.eventTypes))].join(', '));
note('item  type 全集：', [...new Set(runs.flatMap((one) => one.itemTypes))].join(', '));
note('usage 键全集：', [...new Set(runs.flatMap((one) => one.usageKeysUnion))].join(', '));
note('reasoning item 总数：', runs.reduce((sum, one) => sum + one.reasoningItems.length, 0));
note('collab_tool_call 总数：', runs.reduce((sum, one) => sum + one.collabItems.length, 0));
note('JSONL：', jsonlFile);
note('落盘：', file);
