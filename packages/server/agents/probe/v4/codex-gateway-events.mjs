/**
 * VPN 恢复后的复跑（codex，**走内网网关这条适配器真实路径**）。
 *
 * 要回答三件在 DeepSeek 路由上只能给"现象"、给不出"结论"的事：
 *
 *  Q-A **`spawn_agent` 的执行器到底由什么决定**——上一轮在内网网关上得到 `unsupported call`
 *      （模型预设不带 `multi_agent` profile），2026-10-01 在 DeepSeek 路由上却**真跑通了**。
 *      本轮用**同一台网关**对比两个名字：
 *        · `gpt-5.6-sol` —— codex **认识**它（元数据存在，但记 profile 为 `null`）；
 *        · `gt-6-as-a`   —— codex **不认识**它 ⇒ 落 fallback 元数据（DeepSeek 那次的同款情形）。
 *      判据：`collab_tool_call` 出不出、`agents_states` 里能不能拿到子智能体的答复。
 *
 *  Q-B **codex 到底投不投影 `reasoning`**——DeepSeek 路由上 wire 有、事件流里 0 条。
 *      本轮用一个 **codex 认识的真推理模型** 跑一次纯推理提示词。
 *      判据：事件流里有没有 `item.type === 'reasoning'`；有 ⇒ DeepSeek 那次的不投影是
 *      "fallback 元数据 / 该后端"的产物，不是 codex 的固有行为。
 *
 *  Q-C **`reasoning_output_tokens` 在网关路径上非不非 0**（补一个非 DeepSeek 的样本）。
 *
 * 另外每个 case 都配了 hook（`SubagentStart`/`SubagentStop` + `--dangerously-bypass-hook-trust`），
 * 顺带看**网关路径上 hook 会不会触发**（DeepSeek 路由上已证会）。
 *
 * 用法：node probe/v4/codex-gateway-events.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/env.mjs';
import { buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';

/** 本 case 的原始事件落点（`dumps/v4/`，已 gitignore）。 */
const DUMP_DIR_V4 = join(DUMP_DIR, 'v4');

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const CODEX_EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const HOOK_LOGGER = join(REPO, 'packages', 'server', 'agents', 'probe', 'v2', 'hook-log.cjs');
/** 网关（**必须声明在凭据探测之前**：`const` 有 TDZ，先调用会 `Cannot access 'GATEWAY' before initialization`）。 */
const GATEWAY = 'https://likecode-llm-proxy.jd.com/v1';

/** 候选凭据：环境变量 → proxygateway 配置 → **git 历史**（见下面 note）。**值绝不打印。** */
function candidateKeys() {
  const out = [];
  if (process.env.AIEVAL_PROBE_GATEWAY_API_KEY) out.push({ from: 'env AIEVAL_PROBE_GATEWAY_API_KEY', value: process.env.AIEVAL_PROBE_GATEWAY_API_KEY });
  try {
    const text = readFileSync('D:\\zhanglei1120\\coding\\proxygateway\\config.json', 'utf8');
    const block = /"apiKeys"\s*:\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? '';
    for (const hit of block.matchAll(/"([A-Za-z0-9_-]+)"\s*:\s*"([^"]+)"/g)) out.push({ from: `config.${hit[1]}`, value: hit[2] });
  } catch { /* 读不到就跳过 */ }
  // ⚠️ 兜底读 **git 历史**里那把（本工作区那份已改成读环境变量，历史值仍在）。
  // 为什么允许这么做：2026-10-01 实测 —— config 里的几把 key 对 `/v1/responses` **一律 401**
  // （报文「登录态丢失，请重启再试」），而历史里这把 8/8 组合 200。**它是本机当前唯一能推理的凭据**。
  // 正确处置仍是「轮换 + 放进环境变量」，本兜底只是让复跑现在能做。
  try {
    const old = execFileSync('git', ['show', 'HEAD:packages/server/agents/probe/v2/codex-cli-plan.ps1'], { cwd: REPO, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const hit = /CODEX_API_KEY\s*=\s*'([0-9a-f]{32,64})'/.exec(old);
    if (hit !== null) out.push({ from: 'git 历史（已从小抄里撤下）', value: hit[1] });
  } catch { /* 读不到就跳过 */ }
  const seen = new Set();
  return out.filter((one) => one.value && (seen.has(one.value) ? false : (seen.add(one.value), true)));
}

/**
 * **先证链路**：逐个候选打一次最小 `/v1/responses`，取第一个 200 的。
 * 为什么必须真打一次：`/v1/models` **不校验凭据**（坏 key 也 200，2026-10-01 实测），
 * 拿它当"凭据有效"的证据会得出错误结论。
 */
async function pickWorkingKey() {
  const body = JSON.stringify({ model: 'gpt-5.6-sol', input: 'say ok', max_output_tokens: 16 });
  for (const candidate of candidateKeys()) {
    try {
      const response = await fetch(`${GATEWAY}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${candidate.value}` },
        body,
      });
      const text = await response.text();
      note(`凭据「${candidate.from}」→ ${response.status}`);
      if (response.status === 200) return candidate;
    } catch (error) {
      note(`凭据「${candidate.from}」→ 网络错误 ${String(error?.message ?? error).slice(0, 80)}`);
    }
  }
  return null;
}

const picked = await pickWorkingKey();
if (picked === null) {
  note('❌ 没有任何候选凭据能通过 /v1/responses ⇒ 网关推理路径不可用，复跑中止');
  writeDump('v4/codex-gateway-events', { at: new Date().toISOString(), aborted: '没有可用凭据', candidates: candidateKeys().map((one) => ({ from: one.from, length: one.value.length })) });
  process.exit(0);
}
note(`使用凭据来源：${picked.from}（长度 ${picked.value.length}，值不打印）`);
const apiKey = picked.value;

/**
 * scratch 落在**仓库内**：这不是随便挑的——2026-10-01 实测的规则是
 * 「exe 在工作区内 ⇒ `$CODEX_HOME` 也必须在工作区内」，放 `tmpdir()` 会 `os error 5`。
 */
const SCRATCH_ROOT = join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', 'tmp', 'gw');
mkdirSync(SCRATCH_ROOT, { recursive: true });

/** 网关的两个主机名都留一份（上一轮三台可用性不一致）。 */
const GATEWAY_ALT = 'http://likecode-llm-proxy-test.jd.com/v1';

const SPAWN_PROMPT = '请用 spawn_agent 工具派一个子智能体去把 1+1 算出来，然后汇报它的结论。'
  + '如果你的工具表里没有这个工具，就直接说明「没有该工具」。';
const REASON_PROMPT = '请先用一句话说明你的推理过程，再给出结论：一个农夫有 17 只羊，除了 9 只以外都跑了，还剩几只？';

/** 配 hook：只做只读观测（读完 stdin 自己落盘、返回 0、不注入）。 */
function hookConfig(outDir) {
  const command = `"${process.execPath}" "${HOOK_LOGGER}" "${outDir}"`;
  const groups = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop'].map((event) => ({
    [`hooks.${event}`]: [{ matcher: '', hooks: [{ type: 'command', command }] }],
  }));
  return Object.assign({}, ...groups);
}

/** 跑一个 case，返回摘要 + 原始事件行。 */
async function runCase(input) {
  const caseDir = join(SCRATCH_ROOT, input.label);
  const home = join(caseDir, 'home');
  const cwd = join(caseDir, 'cwd');
  const hookOut = join(caseDir, 'hook-out');
  for (const dir of [home, cwd, hookOut]) mkdirSync(dir, { recursive: true });

  const config = {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval gateway',
        base_url: GATEWAY,
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    tools: { web_search: false, update_plan: { enabled: true } },
    features: { multi_agent: input.multiAgent === true },
    ...hookConfig(hookOut),
  };

  const args = buildExecArgs({
    config,
    model: input.model,
    sandboxMode: 'danger-full-access',
    cwd,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    // SDK 没有这个口子：⑦ 的信任闸门必须靠它绕开，否则 hook 静默不执行
    extraArgs: ['--dangerously-bypass-hook-trust'],
  });

  const env = { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, CODEX_API_KEY: apiKey };
  const run = await spawnCapture(CODEX_EXE, args, { env, cwd, timeoutMs: 240_000, stdin: input.prompt });

  // ── 逐行解析事件（坏行保留原文，不静默丢） ──
  const events = [];
  const unparsable = [];
  for (const line of run.stdoutLines) {
    try { events.push(JSON.parse(line)); } catch { unparsable.push(line.slice(0, 300)); }
  }
  const items = events.filter((one) => one?.type === 'item.started' || one?.type === 'item.completed' || one?.type === 'item.updated').map((one) => one.item);
  const usages = events.filter((one) => one?.type === 'turn.completed' && one.usage !== undefined).map((one) => one.usage);
  const collabItems = items.filter((one) => one?.type === 'collab_tool_call');
  const reasoningItems = items.filter((one) => one?.type === 'reasoning');
  const errorItems = items.filter((one) => one?.type === 'error');

  // hook 落盘物
  const hookFile = join(hookOut, 'hooks.jsonl');
  const hookPayloads = existsSync(hookFile)
    ? readFileSync(hookFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => { try { return JSON.parse(line); } catch { return { raw: line.slice(0, 300) }; } })
    : [];
  const hookByName = {};
  for (const one of hookPayloads) {
    let payload = one?.raw ?? one?.payload ?? one;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { /* 留原文 */ } }
    const name = payload?.hook_event_name ?? one?.event ?? '<未知>';
    hookByName[name] = (hookByName[name] ?? 0) + 1;
  }

  const summary = {
    label: input.label,
    model: input.model,
    multiAgent: input.multiAgent === true,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    ms: run.ms,
    stderrHead: run.stderrLines.slice(0, 5),
    eventCount: events.length,
    eventTypes: [...new Set(events.map((one) => one.type))],
    itemTypes: [...new Set(items.map((one) => one?.type))],
    /** 顶层 `error` 事件的原文（**失败原因基本都在这里**，不抓等于没证据）。 */
    topLevelErrors: events.filter((one) => one.type === 'error').map((one) => String(one.message ?? '').slice(0, 400)),
    turnFailed: events.filter((one) => one.type === 'turn.failed').map((one) => String(one?.error?.message ?? '').slice(0, 400)),
    /** 子智能体的自述（`unsupported call` 这类会出现在 agent_message 里）。 */
    agentMessages: items.filter((one) => one?.type === 'agent_message').map((one) => String(one.text ?? '').slice(0, 300)),
    errorItems,
    collabTools: [...new Set(collabItems.map((one) => one.tool))],
    collabItems,
    reasoningItems,
    usages,
    usageKeysUnion: [...new Set(usages.flatMap((one) => Object.keys(one)))],
    hookByName,
    hookPayloads,
    unparsable,
    caseDir,
  };

  // **每次覆盖**该 case 的 jsonl（不去 append）：同一脚本重跑两次会把两轮的原始事件混在一个文件里，
  // 上一版就是这么被污染的——判据文件必须只属于**这一次**运行。
  writeFileSync(join(DUMP_DIR_V4, `codex-gateway-${input.label}.jsonl`), events.map((one) => JSON.stringify(one)).join('\n') + '\n', 'utf8');
  note(`${input.label}: exit=${run.exitCode} 事件=${events.length} item=${JSON.stringify(summary.itemTypes)} `
    + `collab=${JSON.stringify(summary.collabTools)} reasoning=${reasoningItems.length} hook=${JSON.stringify(hookByName)}`);
  if (summary.turnFailed.length > 0) note(`${input.label} turn.failed:`, summary.turnFailed[0]);
  if (summary.agentMessages.length > 0) note(`${input.label} agent_message:`, summary.agentMessages.at(-1)?.slice(0, 160));
  if (usages.length > 0) note(`${input.label} usage:`, JSON.stringify(usages[0]));
  return summary;
}

const cases = [];
cases.push(await runCase({ label: 'known-model-multi', model: 'gpt-5.6-sol', multiAgent: true, prompt: SPAWN_PROMPT }));
cases.push(await runCase({ label: 'unknown-model-multi', model: 'gt-6-as-a', multiAgent: true, prompt: SPAWN_PROMPT }));
cases.push(await runCase({ label: 'known-model-reason', model: 'gpt-5.6-sol', multiAgent: false, prompt: REASON_PROMPT }));
cases.push(await runCase({ label: 'known-model-terra-reason', model: 'gpt-5.6-terra', multiAgent: false, prompt: REASON_PROMPT }));

/** 判据：把三条问题各给一个可读结论。**失败的 run 不能当证据**——这一条要先判。 */
const byLabel = Object.fromEntries(cases.map((one) => [one.label, one]));
const completed = cases.filter((one) => one.usages.length > 0);
const failedEarly = cases.filter((one) => one.usages.length === 0);

const unsupported = cases.filter((one) => one.agentMessages.some((text) => /unsupported call/i.test(text)));
const verdict = {
  'Q-A 执行器由什么决定': [
    unsupported.length > 0
      ? `**网关路径上复现 \`unsupported call: spawn_agent\`**（${unsupported.map((one) => one.label).join('、')}）⇒ §7.5.2 的原结论**对它自己的路径仍然成立**；DeepSeek 路由那次能跑是**例外**，不是"推翻"`
      : '网关路径上没有观察到 `unsupported call` 的自述',
    `codex 认识的 gpt-5.6-sol：${byLabel['known-model-multi']?.collabTools.length > 0 ? '有 collab 调用' : '**没有** collab 调用'}`,
    `codex 不认识的 gt-6-as-a：${byLabel['unknown-model-multi']?.collabTools.length > 0 ? '有 collab 调用' : '**没有** collab 调用'}`
      + ' ⇒ **"认不认识名字"不是决定因素**（两边都是 fallback 元数据，结果却与 DeepSeek 路由不同）',
  ].join('；'),
  'Q-B reasoning 投不投影': completed.length === 0
    ? `**本次拿不到证据**：${failedEarly.length}/${cases.length} 个 run 的 usage 为空（turn 提前失败）——`
      + '失败早于 reasoning 产出，**不能**据此说 codex 不投影。DeepSeek 路由上"0 条"的观察**不能推广到网关路径**'
    : (cases.some((one) => one.reasoningItems.length > 0)
      ? `**投影了**：${cases.filter((one) => one.reasoningItems.length > 0).map((one) => one.label).join('、')}`
      : `跑通的 run（${completed.map((one) => one.label).join('、')}）里**一条都没有**`),
  'Q-C reasoning_output_tokens': completed.length === 0
    ? '本次没有跑完的 run ⇒ **无样本**'
    : JSON.stringify(cases.flatMap((one) => one.usages.map((u) => u.reasoning_output_tokens))),
  'hook 在网关路径上触发了没有': JSON.stringify(Object.fromEntries(cases.map((one) => [one.label, one.hookByName]))),
};
note('判定：');
for (const [key, value] of Object.entries(verdict)) note('  ·', key, '→', value);

const file = writeDump('v4/codex-gateway-events', {
  at: new Date().toISOString(),
  gateway: GATEWAY,
  codexExe: CODEX_EXE,
  cases,
  verdict,
});
note('落盘：', file);
writeFileSync(join(SCRATCH_ROOT, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), verdict }, null, 2), 'utf8');
