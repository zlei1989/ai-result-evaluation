/**
 * v4 / Q2 收口（补）：`--debug` **不带 `--debug-file`** 时，那行闸门日志去哪一格？
 *
 * 为什么必须补这一跑：上一脚本里 `gate-on-debug-no-file` 那一次**模型没调用 Workflow**
 * （提示词引用的 a.txt/b.txt 在那个新工作区里不存在，模型拒绝了），
 * 而闸门日志只在 Workflow 工具真被调用时才打 ⇒ 那一次的「两条都是 false」**不构成证据**。
 * 本脚本用已经证明能驱动 Workflow 的 12 文件提示词重跑。
 *
 * 判据：`--debug` 下闸门行出现在 stdout / stderr / 还是只落在文件里。
 *
 * 用法：node probe/v4/q2d-debug-channel.mjs
 * 产物：probe/dumps/v4/q2d-debug-channel.json
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, redact, writeDump } from './lib/env.mjs';
import { CLAUDE_EXE, deepseekClaudeEnv, makeWorkspace } from './lib/claude.mjs';

const OUT_DIR = join(DUMP_DIR, 'v4');
mkdirSync(OUT_DIR, { recursive: true });

const SETTINGS = { enableWorkflows: true, workflowSizeGuideline: 'medium' };
const GATE_ENV = { CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '8', CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS: '8' };
const PROMPT_12 = 'Use a workflow with ONE agent per file for ALL 12 part-*.txt files in this directory (that is exactly 12 agents, scheduled together), each counting that file\'s lines, then sum them. Do not reduce the number of agents.';

const WORKSPACE = makeWorkspace();
for (let index = 1; index <= 12; index += 1) {
  writeFileSync(join(WORKSPACE, `part-${String(index).padStart(2, '0')}.txt`), `line-a-${index}\nline-b-${index}\n`, 'utf8');
}

/** 跑前 / 跑后各扫一次可能落 debug 日志的目录，找出本次新增的文件。 */
function snapshotDirs() {
  const roots = [join(WORKSPACE, '.claude'), join(process.env.USERPROFILE ?? '', '.claude'), join(process.env.TEMP ?? '', 'claude')];
  const found = new Map();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!/\.(log|txt|json)$/i.test(entry.name)) continue;
        try { found.set(full, statSync(full).mtimeMs); } catch { /* 忽略竞态 */ }
      }
    }
  }
  return found;
}

function run(label, extraArgs, timeoutMs = 280_000) {
  return new Promise((resolve) => {
    const env = deepseekClaudeEnv(GATE_ENV);
    const args = [
      '-p', PROMPT_12,
      '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      '--settings', JSON.stringify(SETTINGS),
      ...extraArgs,
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
        try { parsed.push(JSON.parse(line)); } catch { parsed.push({ __unparsable: line.slice(0, 200) }); }
      }
      resolve({ label, args, code, spawnError, timedOut, ms: Date.now() - at, parsed, stderr });
    };
    child.on('error', (error) => done(null, String(error?.message ?? error)));
    child.on('close', (code) => done(code, null));
  });
}

const records = [];
for (const one of [
  { label: 'debug-no-file-12agents', args: ['--debug'] },
  { label: 'no-debug-12agents', args: [] },
]) {
  note(`== ${one.label} ==`);
  const before = snapshotDirs();
  const out = await run(one.label, one.args);
  const after = snapshotDirs();
  const newFiles = [...after.entries()].filter(([file, mtime]) => !before.has(file) || before.get(file) !== mtime).map(([file]) => file);

  const stdoutRaw = out.parsed.map((m) => JSON.stringify(m)).join('\n');
  const stderrRaw = out.stderr ?? '';
  const gateIn = (text) => (typeof text === 'string' ? text.split(/\r?\n/).filter((line) => line.includes('workflow: concurrent agent gate')) : []);
  const toolUses = [];
  for (const message of out.parsed) {
    const content = message?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block?.type === 'tool_use') toolUses.push(block.name);
  }
  // 新增文件里也搜一遍
  const fileHits = {};
  for (const file of newFiles) {
    try {
      const text = readFileSync(file, 'utf8');
      const lines = gateIn(text);
      if (lines.length > 0) fileHits[file] = lines.slice(0, 3);
    } catch { /* 二进制/读不到就跳过 */ }
  }

  const record = {
    label: one.label,
    args: out.args,
    exitCode: out.code,
    spawnError: out.spawnError ?? null,
    timedOut: out.timedOut,
    ms: out.ms,
    workflowToolUsed: toolUses.includes('Workflow'),
    toolUseNames: toolUses,
    gateOnStdout: gateIn(stdoutRaw),
    gateOnStderr: gateIn(stderrRaw),
    newOrChangedFiles: newFiles,
    gateInNewFiles: fileHits,
    dshTempProbe: null,
  };
  writeFileSync(join(OUT_DIR, `q2d-${one.label}.stdout.jsonl`), redact(stdoutRaw), 'utf8');
  writeFileSync(join(OUT_DIR, `q2d-${one.label}.stderr.txt`), redact(stderrRaw), 'utf8');
  note(`  exit=${record.exitCode} timedOut=${record.timedOut} ms=${record.ms} Workflow 用了=${record.workflowToolUsed}`);
  note(`  闸门行 stdout=${record.gateOnStdout.length} stderr=${record.gateOnStderr.length}`);
  for (const line of [...record.gateOnStdout, ...record.gateOnStderr].slice(0, 3)) note('    逐字：', line.slice(0, 300));
  note(`  新增/变动文件 ${newFiles.length} 个；其中含闸门行的 = ${JSON.stringify(Object.keys(fileHits))}`);
  records.push(record);
}

const file = writeDump('v4/q2d-debug-channel', {
  at: new Date().toISOString(),
  settings: SETTINGS,
  gateEnv: GATE_ENV,
  workspace: WORKSPACE,
  runs: records,
});
note('落盘：', file);
