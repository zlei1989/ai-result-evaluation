/**
 * 收口「30 vs 27」那处数字对不上（v4 的 E 行）。
 *
 * 实测（2026-10-01，本机抓包 ⇒ 与后端无关；请求**到不了模型**）：
 *   · 09-30 那次：30 项，含 `Task` / `Monitor` / `PowerShell` / `PushNotification`；
 *   · 今天（2.1.283）四个模型名一律 **27** 项，逐名 diff 的结果是：
 *     **少** `Task` / `Monitor` / `PowerShell` / `PushNotification`，**多** `Agent`。
 *
 * `Task` → `Agent` 是**改名**（同一件东西，见 Q4 的双名发现）。
 * 剩下三个（`Monitor` / `PowerShell` / `PushNotification`）不像改名，像**被环境开关门控**——
 * 其中最可疑的是 `PowerShell`（claude 需要显式允许才给 pwsh 工具）。
 *
 * 本脚本先**从二进制里把候选环境变量名捞出来**（不靠猜），再逐个开开关重采工具表，
 * 判据是"开了之后那三个名字有没有出现"。
 *
 * 用法：node probe/v4/claude-tool-gates.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { CLAUDE_EXE } from './lib/claude.mjs';
import { note, writeDump } from './lib/env.mjs';
import { deepseekClaudeEnv, makeWorkspace } from './lib/claude.mjs';

/** 从打包 exe 里扫 `CLAUDE_CODE_*` 名字，挑与这三个工具相关的候选。 */
function candidateEnvNames() {
  const latin = readFileSync(CLAUDE_EXE).toString('latin1');
  const names = [...new Set([...latin.matchAll(/CLAUDE_CODE_[A-Z0-9_]{3,60}/g)].map((one) => one[0]))];
  const related = names.filter((name) => /POWERSHELL|MONITOR|PUSH|NOTIF|BACKGROUND|TASK|SHELL|WINDOWS/i.test(name));
  note(`exe 里 CLAUDE_CODE_* 共 ${names.length} 个；与这三个工具相关的候选 ${related.length} 个：`, JSON.stringify(related));
  return { all: names, related };
}

const { related } = candidateEnvNames();

const PORT = 7983;
const captured = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      captured.push({ toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0, toolNames: (parsed.tools ?? []).map((tool) => tool.name) });
    } catch { captured.push({ parseError: true }); }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'probe: captured' } }));
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const workspace = makeWorkspace();
const WATCHED = ['Task', 'Agent', 'Monitor', 'PowerShell', 'PushNotification'];

async function captureWith(extraEnv, label) {
  const before = captured.length;
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  try {
    for await (const message of sdk.query({
      prompt: '回答一个字：好。不要调用任何工具。',
      options: {
        cwd: workspace,
        model: 'Claude-Sonnet-4.6',
        maxTurns: 1,
        env: {
          ...deepseekClaudeEnv(extraEnv),
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
          ANTHROPIC_API_KEY: 'probe',
          ANTHROPIC_AUTH_TOKEN: 'probe',
        },
        abortController: new AbortController(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
      },
    })) void message;
  } catch { /* 预期 400 */ }
  const last = captured.slice(before).at(-1) ?? { toolCount: 0, toolNames: [] };
  const present = Object.fromEntries(WATCHED.map((name) => [name, last.toolNames.includes(name)]));
  note(`${label}：${last.toolCount} 项；${JSON.stringify(present)}`);
  return { label, extraEnv, toolCount: last.toolCount, toolNames: last.toolNames, present };
}

const cases = [];
cases.push(await captureWith({}, '基线（什么都不开）'));
cases.push(await captureWith({ CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' }, '开 PowerShell 工具'));
for (const name of related.filter((one) => /POWERSHELL|MONITOR|PUSH|NOTIF|BACKGROUND/i.test(one)).slice(0, 6)) {
  cases.push(await captureWith({ [name]: '1' }, `开 ${name}`));
}

server.close();

/** 逐格看：哪个开关让哪个名字出现。 */
const baseline = cases[0];
const effects = cases.slice(1).map((one) => ({
  label: one.label,
  toolCount: one.toolCount,
  deltaFromBaseline: one.toolCount - baseline.toolCount,
  gained: one.toolNames.filter((name) => !baseline.toolNames.includes(name)),
  lost: baseline.toolNames.filter((name) => !one.toolNames.includes(name)),
}));
note('各开关的增量：', JSON.stringify(effects, null, 2));

const explained = new Set(effects.flatMap((one) => one.gained));
const stillMissing = ['Task', 'Monitor', 'PowerShell', 'PushNotification'].filter((name) => !baseline.toolNames.includes(name) && !explained.has(name));
const verdict = stillMissing.length === 0
  ? '09-30 与今天的 27 项差异**已被开关解释完**（含 Task→Agent 的改名）'
  : `仍有未解释的缺失：${JSON.stringify(stillMissing)} ⇒ 差异不止"模型名 + 开关"两个轴，可能还含 CLI/SDK 版本或那条采集的参数`;

const file = writeDump('v4/claude-tool-gates', {
  at: new Date().toISOString(),
  cliExe: CLAUDE_EXE,
  relatedEnvNames: related,
  baselineCount: baseline.toolCount,
  cases,
  effects,
  stillMissing,
  verdict,
  note: '09-30 那次的 30 项是 CLI 2.1.281（SDK 自带）；本轮全部是 2.1.283（全局 claude.exe）。'
    + 'Task→Agent 是改名（同一件东西）。',
});
note('判定：', verdict);
note('落盘：', file);
