/**
 * v4 / Q2 收口：两个上一脚本没答干净的问题。
 *
 *  ① 那行闸门日志**不带 `--debug-file`** 时去哪一格？（设计稿 §7.8.4 写的是「它在 CLI 的
 *     stdout/stderr 上」；上一脚本里我加了 `--debug-file`，日志被重定向进文件，
 *     于是 stdout/stderr 两条都是 false —— **这不足以反驳设计稿**，必须去掉 `--debug-file` 再测。）
 *
 *  ② 规模告警要「排期数 > 阈值」才会触发。上一脚本的 workflow 只排了 2~3 个 agent，
 *     低于 `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS=8`，**根本没机会告警**——
 *     不能据此说「进不去」。本脚本明确要一个 **12 个 agent** 的 workflow，
 *     再用 `scheduled_agents` / `agent_cap` / `cap_from_guideline` / `workflow_size_warning`
 *     / `tengu_workflow_size_warning_shown` 五个 token 去搜 stdout / stderr / debug 日志。
 *
 * 用法：node probe/v4/q2c-size-warning.mjs
 * 产物：probe/dumps/v4/q2c-size-warning.json
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, redact, writeDump } from './lib/env.mjs';
import { CLAUDE_EXE, deepseekClaudeEnv, makeWorkspace } from './lib/claude.mjs';

const OUT_DIR = join(DUMP_DIR, 'v4');
mkdirSync(OUT_DIR, { recursive: true });

const SETTINGS = { enableWorkflows: true, workflowSizeGuideline: 'medium' };
const GATE_ENV = { CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '8', CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS: '8' };

const WORKSPACE = makeWorkspace();
// 12 个文件 ⇒ 12 个 agent 才有「一个 agent 一个文件」的正当理由，逼排期数超阈值。
for (let index = 1; index <= 12; index += 1) {
  writeFileSync(join(WORKSPACE, `part-${String(index).padStart(2, '0')}.txt`), `line-a-${index}\nline-b-${index}\n`, 'utf8');
}

const PROMPT_STDERR = 'Use a workflow to count the lines in a.txt and b.txt, then report both counts and the total.';
const PROMPT_12 = 'Use a workflow with ONE agent per file for ALL 12 part-*.txt files in this directory (that is exactly 12 agents, scheduled together), each counting that file\'s lines, then sum them. Do not reduce the number of agents.';

const RUNS = [
  { label: 'gate-on-debug-no-file', gate: true, prompt: PROMPT_STDERR, useDebugFile: false, debug: true },
  { label: 'gate-on-12agents-debugfile', gate: true, prompt: PROMPT_12, useDebugFile: true, debug: true },
  { label: 'gate-off-12agents-debugfile', gate: false, prompt: PROMPT_12, useDebugFile: true, debug: true },
];

function run(one, timeoutMs = 280_000) {
  return new Promise((resolve) => {
    const debugFile = join(OUT_DIR, `q2c-${one.label}.debug.log`);
    const env = deepseekClaudeEnv(one.gate ? GATE_ENV : {});
    const args = [
      '-p', one.prompt,
      '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      '--settings', JSON.stringify(SETTINGS),
    ];
    if (one.debug) args.push('--debug');
    if (one.useDebugFile) args.push('--debug-file', debugFile);
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
      let debugLog = '';
      try { debugLog = readFileSync(debugFile, 'utf8'); } catch { debugLog = ''; }
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
      const parsed = [];
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch { parsed.push({ __unparsable: line.slice(0, 200) }); }
      }
      resolve({ one, code, spawnError, timedOut, ms: Date.now() - at, parsed, stderr, debugLog, debugFile, args });
    };
    child.on('error', (error) => done(null, String(error?.message ?? error)));
    child.on('close', (code) => done(code, null));
  });
}

const TOKENS = ['workflow: concurrent agent gate', 'workflow_size_warning', 'tengu_workflow_size_warning_shown', 'scheduled_agents', 'agent_cap', 'cap_from_guideline', 'projected_tokens', 'token_cap'];
const hits = (text, token) => (typeof text === 'string' && text !== '' ? text.split(/\r?\n/).filter((line) => line.includes(token)) : []);

const records = [];
for (const one of RUNS) {
  note(`== ${one.label} ==`);
  const out = await run(one);
  const stdoutRaw = out.parsed.map((m) => JSON.stringify(m)).join('\n');
  const stderrRaw = out.stderr ?? '';
  const debugRaw = out.debugLog ?? '';

  const toolUses = [];
  for (const message of out.parsed) {
    const content = message?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block?.type === 'tool_use') toolUses.push({ name: block.name, input: block.input });
  }
  // workflow 脚本里的 agent() 数量（一个粗代理：数脚本里 agent( 的出现次数）
  const workflowInputs = toolUses.filter((t) => t.name === 'Workflow').map((t) => t.input);
  const scriptAgentCalls = workflowInputs.map((input) => (typeof input?.script === 'string' ? (input.script.match(/agent\(/g) ?? []).length : null));

  const tokenReport = {};
  for (const token of TOKENS) {
    tokenReport[token] = {
      stdout: hits(stdoutRaw, token).slice(0, 4).map((line) => line.slice(0, 400)),
      stderr: hits(stderrRaw, token).slice(0, 4).map((line) => line.slice(0, 400)),
      debugLog: hits(debugRaw, token).slice(0, 4).map((line) => line.slice(0, 400)),
    };
  }

  const result = out.parsed.find((m) => m?.type === 'result') ?? null;
  const record = {
    label: one.label,
    args: out.args,
    gateEnvSet: one.gate,
    exitCode: out.code,
    spawnError: out.spawnError ?? null,
    timedOut: out.timedOut,
    ms: out.ms,
    gate: {
      onStdout: hits(stdoutRaw, 'workflow: concurrent agent gate'),
      onStderr: hits(stderrRaw, 'workflow: concurrent agent gate'),
      inDebugLog: hits(debugRaw, 'workflow: concurrent agent gate'),
    },
    toolUseNames: toolUses.map((t) => t.name),
    workflowToolUsed: workflowInputs.length > 0,
    workflowScriptAgentCalls: scriptAgentCalls,
    tokens: tokenReport,
    resultSummary: result === null ? null : {
      subtype: result.subtype,
      is_error: result.is_error,
      num_turns: result.num_turns,
      result: typeof result.result === 'string' ? result.result.slice(0, 800) : result.result,
      usage: result.usage,
    },
    rawSizes: { stdoutLines: out.parsed.length, stderrLen: stderrRaw.length, debugLen: debugRaw.length },
  };

  writeFileSync(join(OUT_DIR, `q2c-${one.label}.stdout.jsonl`), redact(stdoutRaw), 'utf8');
  writeFileSync(join(OUT_DIR, `q2c-${one.label}.stderr.txt`), redact(stderrRaw), 'utf8');
  if (debugRaw !== '') writeFileSync(join(OUT_DIR, `q2c-${one.label}.debug.raw.log`), redact(debugRaw), 'utf8');

  note(`  exit=${record.exitCode} timedOut=${record.timedOut} ms=${record.ms}`);
  note(`  闸门行 stdout=${record.gate.onStdout.length} stderr=${record.gate.onStderr.length} debugLog=${record.gate.inDebugLog.length}`);
  for (const line of [...record.gate.onStdout, ...record.gate.onStderr, ...record.gate.inDebugLog].slice(0, 3)) note('    逐字：', line.slice(0, 300));
  note(`  Workflow 工具用了=${record.workflowToolUsed} script 里 agent() 次数=${JSON.stringify(scriptAgentCalls)}`);
  for (const token of ['workflow_size_warning', 'tengu_workflow_size_warning_shown', 'scheduled_agents', 'agent_cap', 'cap_from_guideline']) {
    const one2 = tokenReport[token];
    note(`  [${token}] stdout=${one2.stdout.length} stderr=${one2.stderr.length} debug=${one2.debugLog.length}`);
    for (const line of [...one2.stdout, ...one2.debugLog].slice(0, 2)) note('    逐字：', line.slice(0, 300));
  }
  note('  result.result =', JSON.stringify(record.resultSummary?.result)?.slice(0, 300));
  records.push(record);
}

const file = writeDump('v4/q2c-size-warning', {
  at: new Date().toISOString(),
  settings: SETTINGS,
  gateEnv: GATE_ENV,
  workspace: WORKSPACE,
  runs: records,
});
note('落盘：', file);
