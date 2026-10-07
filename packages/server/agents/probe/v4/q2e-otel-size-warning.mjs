/**
 * v4 / Q2 判据③ 收口：**规模告警到底发到哪儿去了？**
 *
 * 已有证据（`q2c`）：12 个 agent 排期（阈值 `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS=8`，guideline medium=10）
 * 却把 `workflow_size_warning` / `scheduled_agents` / `agent_cap` / `cap_from_guideline`
 * 在 CLI 的 stdout / stderr / debug 日志里**一个都搜不到**。
 *
 * 本脚本再来一步：起一个**最小 OTLP/HTTP 接收器**，把 claude 的遥测打开
 * （`CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_EXPORTER_OTLP_ENDPOINT=127.0.0.1:<port>`），
 * 看那个 `tengu_workflow_size_warning_shown` 事件**是否真的被发出**。
 *
 * 三种可能的结果，都要如实区分：
 *   - 收到了 ⇒ 告警确实产生，只是不进 SDK 消息流（判据③ = 进不去，但量确实存在）；
 *   - 没收到 ⇒ 在 `-p` 非交互路径下这一格**根本没产生**（更彻底：§7.8.1③ 的告警完全不存在）；
 *   - 接收器压根没被访问 ⇒ 说明遥测没接通，**本脚本不构成证据**（要如实说）。
 *
 * 用法：node probe/v4/q2e-otel-size-warning.mjs
 * 产物：probe/dumps/v4/q2e-otel-size-warning.json
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, redact, writeDump } from './lib/env.mjs';
import { CLAUDE_EXE, deepseekClaudeEnv, makeWorkspace } from './lib/claude.mjs';

const PORT = 7983;
const OUT_DIR = join(DUMP_DIR, 'v4');
mkdirSync(OUT_DIR, { recursive: true });

const received = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    received.push({ url: request.url, method: request.method, contentType: request.headers['content-type'] ?? null, bytes: body.length, body: body.slice(0, 400_000) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
note('OTLP 接收器已监听 127.0.0.1:' + PORT);

const SETTINGS = { enableWorkflows: true, workflowSizeGuideline: 'medium' };
const WORKSPACE = makeWorkspace();
for (let index = 1; index <= 12; index += 1) {
  writeFileSync(join(WORKSPACE, `part-${String(index).padStart(2, '0')}.txt`), `line-a-${index}\nline-b-${index}\n`, 'utf8');
}
const PROMPT_12 = 'Use a workflow with ONE agent per file for ALL 12 part-*.txt files in this directory (that is exactly 12 agents, scheduled together), each counting that file\'s lines, then sum them. Do not reduce the number of agents.';

const env = deepseekClaudeEnv({
  CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '8',
  CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS: '8',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT}`,
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORT_INTERVAL: '1000',
  OTEL_METRIC_EXPORT_INTERVAL: '1000',
  CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS: '8000',
  OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
});

const args = [
  '-p', PROMPT_12,
  '--output-format', 'stream-json', '--verbose',
  '--dangerously-skip-permissions',
  '--settings', JSON.stringify(SETTINGS),
  '--debug',
  '--debug-file', join(OUT_DIR, 'q2e-otel.debug.log'),
];

const at = Date.now();
const child = spawn(CLAUDE_EXE, args, { env, cwd: WORKSPACE, windowsHide: true });
child.stdin.end();
let stdout = '';
let stderr = '';
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 280_000);
child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
const code = await new Promise((resolve) => {
  child.on('error', () => resolve(null));
  child.on('close', (value) => resolve(value));
});
clearTimeout(timer);
// 给遥测导出留一点刷新时间
await new Promise((resolve) => setTimeout(resolve, 6000));
server.close();

const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
const parsed = [];
for (const line of lines) {
  try { parsed.push(JSON.parse(line)); } catch { parsed.push({ __unparsable: line.slice(0, 200) }); }
}
const toolUses = [];
for (const message of parsed) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) if (block?.type === 'tool_use') toolUses.push(block.name);
}
const allBodies = received.map((one) => one.body).join('\n');
const stdoutRaw = parsed.map((m) => JSON.stringify(m)).join('\n');
const debugRaw = (() => { try { return readFileSync(join(OUT_DIR, 'q2e-otel.debug.log'), 'utf8'); } catch { return ''; } })();
const TOKENS = ['tengu_workflow_size_warning_shown', 'workflow_size_warning', 'scheduled_agents', 'agent_cap', 'cap_from_guideline', 'workflow: concurrent agent gate'];
const tokenReport = {};
for (const token of TOKENS) {
  tokenReport[token] = {
    inOtelBodies: allBodies.includes(token),
    inStdout: stdoutRaw.includes(token),
    inStderr: stderr.includes(token),
    inDebugLog: debugRaw.includes(token),
  };
}

const record = {
  at: new Date().toISOString(),
  port: PORT,
  exitCode: code,
  timedOut,
  ms: Date.now() - at,
  workflowToolUsed: toolUses.includes('Workflow'),
  toolUseNames: toolUses,
  otlpRequests: received.map((one) => ({ url: one.url, method: one.method, contentType: one.contentType, bytes: one.bytes })),
  otlpRequestCount: received.length,
  tokenReport,
  // 逐字留一段遥测正文，便于「先打印原始形态」——但只留与 workflow 相关的行
  workflowRelatedBodyLines: allBodies.split(/\r?\n/).filter((line) => /workflow|agent_cap|tengu_/.test(line)).slice(0, 10).map((line) => line.slice(0, 600)),
  stderrTail: stderr.slice(-2000),
  rawSizes: { stdoutLines: parsed.length, stderrLen: stderr.length, otelBytes: allBodies.length, debugLen: debugRaw.length },
};

writeFileSync(join(OUT_DIR, 'q2e-otel.stdout.jsonl'), redact(stdoutRaw), 'utf8');
writeFileSync(join(OUT_DIR, 'q2e-otel.stderr.txt'), redact(stderr), 'utf8');
writeFileSync(join(OUT_DIR, 'q2e-otel.bodies.raw.txt'), redact(allBodies.slice(0, 2_000_000)), 'utf8');
const file = writeDump('v4/q2e-otel-size-warning', record);
note(`exit=${code} timedOut=${timedOut} ms=${record.ms} Workflow 用了=${record.workflowToolUsed}`);
note(`OTLP 收到请求 ${record.otlpRequestCount} 个：`, JSON.stringify(record.otlpRequests.slice(0, 10)));
note('token 命中表 =', JSON.stringify(tokenReport, null, 2));
note('落盘：', file);
