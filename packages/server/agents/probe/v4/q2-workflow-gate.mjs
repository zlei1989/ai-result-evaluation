/**
 * v4 / Q2：claude 的 **Workflow 并发闸门**到底有没有那行日志、规模告警进不进 SDK 事件流。
 *
 * 背景（设计稿 §7.8.4 / §9.3 的待实测项 D15）：上一轮唯一的证据是「打包 `claude.exe` 里有
 * 那行文案」，**从未真机跑过**。本轮在 DeepSeek 后端上真跑。
 *
 * 二进制里的代码路径（`claude-exe-strings.mjs` 采到，逐字）：
 *   let Ot=a.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS??Fr;
 *   if(a.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS!==void 0)
 *     t(`workflow: concurrent agent gate = ${Ot} (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS)`);
 * ⇒ **只在设了该变量时才打这一行**（`!==void 0`）。判据①就是去真机验这一条。
 *
 * 规模告警在二进制里是**遥测事件**（不是消息流）：
 *   _("workflow_size_warning"); i("tengu_workflow_size_warning_shown",
 *     {axis, scheduled_agents, total_tokens, projected_tokens, agent_cap, token_cap, cap_from_guideline})
 * ⇒ 判据③要判的是：这些字段**有没有以任何形式**进 SDK/CLI 的事件流（预期：进不去）。
 *
 * 判据②：`Workflow` 工具描述逐字要求显式 opt-in（"use a workflow"/"ultracode"），
 * 故两种提示词各试一次；**即便 DeepSeek 驱动不了这个工具，闸门日志出不出现仍是独立问题**。
 *
 * 用法：node probe/v4/q2-workflow-gate.mjs
 * 产物：probe/dumps/v4/q2-workflow-gate.json + q2-<label>.stdout.jsonl/.stderr.txt/.debug.log
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, redact, writeDump } from './lib/env.mjs';
import { CLAUDE_EXE, deepseekClaudeEnv, makeWorkspace } from './lib/claude.mjs';

const GATE_LINE = 'workflow: concurrent agent gate';
/** 设计稿 §7.8.4 要求的 SDK settings 原文。 */
const SETTINGS = { enableWorkflows: true, workflowSizeGuideline: 'medium' };
const GATE_ENV = { CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '8', CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS: '8' };

const WORKSPACE = makeWorkspace();
writeFileSync(join(WORKSPACE, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
writeFileSync(join(WORKSPACE, 'b.txt'), 'four\nfive\n', 'utf8');

const PROMPT_WORKFLOW = 'Use a workflow to count the lines in a.txt and b.txt, then report both counts and the total.';
const PROMPT_ULTRACODE = 'ultracode: count the lines in a.txt and b.txt and report both counts and the total.';

/** 六个跑法：{提示词} × {闸门变量开/关} × {调试开关}。 */
const RUNS = [
  { label: 'gate-on-workflow-plain', gate: true, prompt: PROMPT_WORKFLOW, args: [] },
  { label: 'gate-off-workflow-plain', gate: false, prompt: PROMPT_WORKFLOW, args: [] },
  { label: 'gate-on-workflow-debug', gate: true, prompt: PROMPT_WORKFLOW, args: ['--debug'] },
  { label: 'gate-off-workflow-debug', gate: false, prompt: PROMPT_WORKFLOW, args: ['--debug'] },
  { label: 'gate-on-ultracode-debug', gate: true, prompt: PROMPT_ULTRACODE, args: ['--debug'] },
  { label: 'gate-off-ultracode-debug', gate: false, prompt: PROMPT_ULTRACODE, args: ['--debug'] },
];

const OUT_DIR = join(DUMP_DIR, 'v4');
mkdirSync(OUT_DIR, { recursive: true });

function run(one, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const debugFile = join(OUT_DIR, `q2-${one.label}.debug.log`);
    const extraArgs = one.args.includes('--debug-file') ? [] : [];
    const env = deepseekClaudeEnv(one.gate ? GATE_ENV : {});
    const args = [
      '-p', one.prompt,
      '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      '--settings', JSON.stringify(SETTINGS),
      ...one.args,
      ...extraArgs,
      // 固定一个 debug 落点，免得去猜 `~/.claude/debug` 的路径
      ...(one.args.includes('--debug') ? ['--debug-file', debugFile] : []),
    ];
    const at = Date.now();
    const child = spawn(CLAUDE_EXE, args, { env, cwd: WORKSPACE, windowsHide: true });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const done = (code, spawnError) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
      const parsed = [];
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch { parsed.push({ __unparsable: line.slice(0, 300) }); }
      }
      let debugLog = '';
      try { debugLog = readFileSync(debugFile, 'utf8'); } catch { debugLog = ''; }
      resolve({ one, code, spawnError, timedOut, ms: Date.now() - at, parsed, stderr, debugLog, debugFile });
    };
    child.on('error', (error) => done(null, String(error?.message ?? error)));
    child.on('close', (code) => done(code, null));
  });
}

/** 在一段文本里找闸门日志行，并把**整行原文**留下。 */
function findGate(text) {
  if (typeof text !== 'string' || text === '') return { present: false, lines: [] };
  const lines = text.split(/\r?\n/).filter((line) => line.includes(GATE_LINE));
  return { present: lines.length > 0, lines };
}

/** 规模告警的三个载荷字段名 + 内部日志事件名。 */
const WARNING_TOKENS = ['scheduled_agents', 'agent_cap', 'cap_from_guideline', 'total_tokens', 'projected_tokens', 'token_cap', 'workflow_size_warning', 'tengu_workflow_size_warning_shown'];
function findWarningTokens(text) {
  if (typeof text !== 'string' || text === '') return [];
  return WARNING_TOKENS.filter((token) => text.includes(token));
}

const records = [];
for (const one of RUNS) {
  note(`== ${one.label} == gate=${one.gate} args=${JSON.stringify(one.args)}`);
  const out = await run(one);
  const stdoutRaw = out.parsed.map((m) => JSON.stringify(m)).join('\n');
  const stderrRaw = out.stderr ?? '';
  const debugRaw = out.debugLog ?? '';

  const gateStdout = findGate(stdoutRaw);
  const gateStderr = findGate(stderrRaw);
  const gateDebug = findGate(debugRaw);

  const toolUses = [];
  for (const message of out.parsed) {
    const content = message?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block?.type === 'tool_use') toolUses.push({ name: block.name, input: block.input });
  }
  const result = out.parsed.find((m) => m?.type === 'result') ?? null;

  const record = {
    label: one.label,
    gateEnvSet: one.gate,
    prompt: one.prompt,
    args: ['-p', one.prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--settings', JSON.stringify(SETTINGS), ...one.args],
    exitCode: out.code,
    spawnError: out.spawnError ?? null,
    timedOut: out.timedOut,
    ms: out.ms,
    // 判据①：闸门日志
    gate: {
      inStdout: gateStdout,
      inStderr: gateStderr,
      inDebugLog: gateDebug,
      appearedAnywhere: gateStdout.present || gateStderr.present || gateDebug.present,
    },
    // 判据②：模型有没有真的驱动 Workflow（闸门日志与它无关，但要分开记）
    toolUseNames: toolUses.map((t) => t.name),
    workflowToolUsed: toolUses.some((t) => t.name === 'Workflow'),
    workflowToolInputs: toolUses.filter((t) => t.name === 'Workflow').map((t) => t.input),
    // 判据③：规模告警载荷字段
    warningFields: {
      inStdout: findWarningTokens(stdoutRaw),
      inStderr: findWarningTokens(stderrRaw),
      inDebugLog: findWarningTokens(debugRaw),
    },
    resultSummary: result === null ? null : {
      subtype: result.subtype,
      is_error: result.is_error,
      num_turns: result.num_turns,
      result: typeof result.result === 'string' ? result.result.slice(0, 600) : result.result,
      terminal_reason: result.terminal_reason,
      usage: result.usage,
    },
    rawSizes: { stdoutLines: out.parsed.length, stderrLen: stderrRaw.length, debugLen: debugRaw.length },
    debugFile: debugRaw === '' ? '（无 debug 日志文件）' : out.debugFile,
  };

  writeFileSync(join(OUT_DIR, `q2-${one.label}.stdout.jsonl`), redact(stdoutRaw), 'utf8');
  writeFileSync(join(OUT_DIR, `q2-${one.label}.stderr.txt`), redact(stderrRaw), 'utf8');
  if (debugRaw !== '') writeFileSync(join(OUT_DIR, `q2-${one.label}.debug.raw.log`), redact(debugRaw), 'utf8');

  note(`  exit=${record.exitCode} timedOut=${record.timedOut} ms=${record.ms}`);
  note(`  判据①闸门行 stdout=${gateStdout.present} stderr=${gateStderr.present} debugLog=${gateDebug.present}`);
  for (const line of [...gateStdout.lines, ...gateStderr.lines, ...gateDebug.lines].slice(0, 3)) note('    逐字：', line.slice(0, 300));
  note(`  判据②工具调用 = ${JSON.stringify(record.toolUseNames)} workflowToolUsed=${record.workflowToolUsed}`);
  note(`  判据③告警字段 stdout=${JSON.stringify(record.warningFields.inStdout)} stderr=${JSON.stringify(record.warningFields.inStderr)} debug=${JSON.stringify(record.warningFields.inDebugLog)}`);
  note(`  result.subtype=${record.resultSummary?.subtype} result.result=${JSON.stringify(record.resultSummary?.result)?.slice(0, 300)}`);
  records.push(record);
}

const file = writeDump('v4/q2-workflow-gate', {
  at: new Date().toISOString(),
  settings: SETTINGS,
  gateEnv: GATE_ENV,
  workspace: WORKSPACE,
  runs: records,
});
note('落盘：', file);
