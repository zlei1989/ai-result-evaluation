/**
 * v4 Q4：`SubagentStart` / `SubagentStop` hook 在 **DeepSeek 路由**上能否触发。
 *
 * 为什么这一轮值得真跑：上一轮定案是「拿不到」，理由是需要网关提供带 multi_agent profile 的模型名。
 * 但 Q3 已经证到：`features.multi_agent: true` + **DeepSeek 官方路由**下，`spawn_agent` **真的跑起来了**
 * （子线程真回了结论）。⇒ 前提变了，hook 这一格必须重测，不能沿用旧结论。
 *
 * 配置与旗标的落法：
 *   · `config.hooks.SubagentStart/SubagentStop = [{ matcher: '', hooks: [{ type: 'command', command }] }]`
 *     —— 经 SDK 的 `flattenConfigOverrides` 会变成 `--config hooks.SubagentStart=[{…}]`；
 *   · `--dangerously-bypass-hook-trust` 只能从 argv 进（SDK 没有任意 flag 透传口），故这里**直接 spawn exe**；
 *   · 落盘器复用 v2 的 `probe/v2/hook-log.cjs`（只读观测：读 stdin、写 hooks.jsonl、回 `{"continue":true}`）。
 *
 * 判据（一次只动一个变量）：
 *   A. 0.154.0 + 带旗标 → hook 应触发（记逐字载荷）
 *   B. 0.154.0 + **不带**旗标 → 信任闸门对照（预期不触发）
 *   C. 0.156.1 + 带旗标 → 版本对照（它的 home 必须在工作区内，见 Q1 的边界）
 *
 * 用法：node probe/v4/codex-hooks-deepseek.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { DEEPSEEK_OPENAI_BASE_URL, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const V154 = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const V156 = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const HOOK_LOGGER = join(HERE, '..', 'v2', 'hook-log.cjs');
const STAGE = join(HERE, '..', 'dumps', 'v4', 'tmp');
const key = loadDeepSeekKey();

const AGENT_PROMPT = '请用 spawn_agent 工具派一个子智能体去把 1+1 算出来，然后汇报它的结论。';

function buildConfig() {
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
    features: { multi_agent: true },
  };
}

const results = {
  at: new Date().toISOString(),
  exe: { '0.154.0': V154, '0.156.1': V156 },
  hookLogger: HOOK_LOGGER,
  hookLoggerExists: existsSync(HOOK_LOGGER),
  nodePath: process.execPath,
  cases: [],
};

async function hookRun(label, { exe, exeLabel, withFlag, timeoutMs = 240_000 }) {
  const home = join(STAGE, `hook-${label}`, 'home');
  const cwd = join(STAGE, `hook-${label}`, 'cwd');
  const outDir = join(HERE, '..', 'dumps', 'v4', `hook-out-${label}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  // 每次运行前清掉上一轮的 hook 日志，保证「本次抓到的载荷」可归因
  const hooksFile = join(outDir, 'hooks.jsonl');
  if (existsSync(hooksFile)) rmSync(hooksFile);

  const command = `${process.execPath} ${HOOK_LOGGER} ${outDir}`;
  // 自检（必须先做）：把**同一条命令行**拿来手工喂一份合成载荷，确认「命令能跑、落盘器能写」。
  // 没有这一步，「hook 载荷 = 0」就分不清是「没触发」还是「命令本身是坏的」——上一版就栽在这里
  // （路径少了一层 `probe`，命令指向不存在的脚本，于是三格全是 0）。
  const selfTest = await spawnCapture(process.execPath, [HOOK_LOGGER, outDir], {
    env: buildEnv({}),
    timeoutMs: 60_000,
    stdin: JSON.stringify({ hook_event_name: 'SelfTest', session_id: 'self-test' }),
  });
  const selfTestWrote = existsSync(hooksFile);

  const hookGroup = [{ matcher: '', hooks: [{ type: 'command', command }] }];
  // 四个事件一起配：**SessionStart / UserPromptSubmit 是本轮的「机制对照」**——
  // 它们与子智能体无关；只要它们有载荷，就说明「配置被接受 + 信任闸门已开 + 命令真的被执行」，
  // 此时 SubagentStart/Stop 的 0 载荷才能被判为「这三个子智能体事件确实不触发」。
  const config = {
    ...buildConfig(),
    hooks: {
      SessionStart: hookGroup,
      UserPromptSubmit: hookGroup,
      SubagentStart: hookGroup,
      SubagentStop: hookGroup,
    },
  };
  const args = buildExecArgs({
    config,
    model: 'deepseek-chat',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    cwd,
    skipGitRepoCheck: true,
  });
  if (withFlag) args.push('--dangerously-bypass-hook-trust');
  args.push(AGENT_PROMPT);

  const out = await spawnCapture(exe, args, {
    env: buildEnv({ codexHome: home, apiKey: key }),
    cwd,
    timeoutMs,
  });
  const parsed = out.stdoutLines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const hookLines = existsSync(hooksFile)
    ? readFileSync(hooksFile, 'utf8').split(/\r?\n/).filter((one) => one !== '')
    : [];
  const hookPayloadsAll = hookLines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [{ raw: line }];
    }
  });
  // 自检那条（SelfTest）不算 codex 触发的载荷
  const hookPayloads = hookPayloadsAll.filter((one) => one?.event !== 'SelfTest');
  const caseOut = {
    label,
    exeLabel,
    withFlag,
    hookCommand: command,
    selfTest: {
      exitCode: selfTest.exitCode,
      stdout: selfTest.stdout.trim(),
      stderr: selfTest.stderr.trim(),
      wroteHooksFile: selfTestWrote,
    },
    home,
    cwd,
    outDir,
    argv: args,
    exitCode: out.exitCode,
    timedOut: out.timedOut,
    ms: out.ms,
    stderrRaw: out.stderr,
    events: parsed.length,
    eventTypes: [...new Set(parsed.map((one) => one?.type ?? 'unknown'))],
    itemTypes: [...new Set(parsed.map((one) => one?.item?.type).filter((one) => one !== undefined))],
    errorItems: parsed.filter((one) => one?.item?.type === 'error').map((one) => one.item),
    collabTools: [...new Set(parsed.filter((one) => one?.item?.type === 'collab_tool_call').map((one) => one.item.tool))],
    collabItems: parsed.filter((one) => one?.item?.type === 'collab_tool_call').map((one) => one.item),
    hookLineCount: hookLines.length,
    hookLineCountFromCodex: hookPayloads.length,
    hookPayloads,
    hookPayloadsAll,
    hookEventsByName: hookPayloads.reduce((acc, one) => {
      const name = one?.event ?? 'unknown';
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {}),
  };
  results.cases.push(caseOut);
  note(
    `hook 用例 ${label} →`,
    `exit=${out.exitCode}`,
    `事件=${parsed.length}`,
    `collab=${caseOut.collabItems.length}`,
    `hook 载荷=${caseOut.hookLineCountFromCodex}`,
    `（自检落盘=${caseOut.selfTest.wroteHooksFile}）`,
  );
  note('   hook 事件分布:', JSON.stringify(caseOut.hookEventsByName));
  if (hookLines.length > 0) note('   载荷首条:', hookLines[0].slice(0, 300));
  if (out.exitCode !== 0) note('   stderr:', out.stderr.split(/\r?\n/).filter((one) => one.trim() !== '').slice(0, 3).join(' | '));
  return caseOut;
}

mkdirSync(STAGE, { recursive: true });

await hookRun('154-with-flag', { exe: V154, exeLabel: '0.154.0', withFlag: true });
await hookRun('154-no-flag', { exe: V154, exeLabel: '0.154.0', withFlag: false });
await hookRun('156-with-flag', { exe: V156, exeLabel: '0.156.1', withFlag: true });

const file = writeDump('v4/codex-hooks-deepseek', results);
note('落盘：', file);
