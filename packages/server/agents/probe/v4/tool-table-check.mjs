/**
 * 三个「※ 待真机确认」标记的收尾核对（**本地、不花模型调用**）：
 *   ① 两轴表里 claude 的 `ExitPlanMode(cc)※` 与 dsh 的 `exit_plan_mode(dsh)※`：
 *      这两个工具名到底在不在**入站工具表**里？（判据同 A/B 做法）
 *   ② claude 打包二进制里 `ExitPlanMode` / `TodoWrite` / `AskUserQuestion` 的字符串计数
 *      （判据：**计数为 0 = 这个名字在厂商产物里根本不存在**，不是"我们没采到"）。
 *
 * 为什么要有这一条：「不许把'没采到'读成'没有'」是硬口径——反过来，
 * 「二进制与入站工具表里都数不到」才是**可以下结论**的证据等级。
 *
 * 用法：node probe/v4/tool-table-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/env.mjs';

const V2 = join(DUMP_DIR, 'v2');

/** 从一份 dump 里把出现过的工具名抠出来（`"name":"xxx"` 与 `"name": "xxx"` 两种都收）。 */
function toolNamesOf(file) {
  const text = readFileSync(file, 'utf8');
  const names = new Set();
  for (const hit of text.matchAll(/"name"\s*:\s*"([A-Za-z0-9_.\-]+)"/g)) names.add(hit[1]);
  return [...names].sort();
}

const files = {
  claudeInbound: join(V2, 'claude-inbound-tools.json'),
  dshToolTable: join(V2, 'dsh-tool-table-and-stream.json'),
  dshTools: join(V2, 'dsh-tools.json'),
};

const claudeNames = existsSync(files.claudeInbound) ? toolNamesOf(files.claudeInbound) : null;
const dshNames = [...new Set([
  ...(existsSync(files.dshToolTable) ? toolNamesOf(files.dshToolTable) : []),
  ...(existsSync(files.dshTools) ? toolNamesOf(files.dshTools) : []),
])].sort();

/** claude 打包二进制的字符串计数（latin1 扫描，判据是计数）。 */
const CLAUDE_EXE = 'd:\\\\.nvm4w\\\\nodejs\\\\node_modules\\\\@anthropic-ai\\\\claude-code\\\\bin\\\\claude.exe'.replaceAll('\\\\', '\\');
const NEEDLES = [
  'ExitPlanMode',
  'TodoWrite',
  'AskUserQuestion',
  'ReportFindings',
  'CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS',
  'CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS',
  'workflow: concurrent agent gate',
];
const binaryCounts = {};
if (existsSync(CLAUDE_EXE)) {
  const latin = readFileSync(CLAUDE_EXE).toString('latin1');
  for (const needle of NEEDLES) binaryCounts[needle] = latin.split(needle).length - 1;
} else {
  binaryCounts.error = `找不到 ${CLAUDE_EXE}`;
}

const report = {
  at: new Date().toISOString(),
  claudeExe: CLAUDE_EXE,
  binaryCounts,
  claudeInboundToolCount: claudeNames?.length ?? null,
  claudeInboundToolNames: claudeNames,
  claudeHas: {
    ExitPlanMode: claudeNames?.includes('ExitPlanMode') ?? null,
    TodoWrite: claudeNames?.includes('TodoWrite') ?? null,
    AskUserQuestion: claudeNames?.includes('AskUserQuestion') ?? null,
    TaskCreate: claudeNames?.includes('TaskCreate') ?? null,
    ReportFindings: claudeNames?.includes('ReportFindings') ?? null,
    Workflow: claudeNames?.includes('Workflow') ?? null,
  },
  dshToolNames: dshNames,
  dshHas: {
    exit_plan_mode: dshNames.includes('exit_plan_mode'),
    ask_user_question: dshNames.includes('ask_user_question'),
    todo_write: dshNames.includes('todo_write'),
    subagent: dshNames.includes('subagent'),
  },
};

note('claude 二进制字符串计数：', JSON.stringify(binaryCounts));
note('claude 入站工具表项数：', report.claudeInboundToolCount);
note('claude 关键工具在不在：', JSON.stringify(report.claudeHas));
note('dsh 工具名样本：', JSON.stringify(dshNames));
note('dsh 关键工具在不在：', JSON.stringify(report.dshHas));

const file = writeDump('v4/tool-table-check', report);
note('落盘：', file);
note('（dump 目录里有', readdirSync(V2).length, '个 v2 产物被扫过）');
