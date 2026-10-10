/**
 * v4 / Q2 前置：在打包 `claude.exe` 里逐字核对 Workflow 闸门相关文案是否仍在。
 *
 * 为什么只做「字符串在不在 + 上下文」而不是直接下结论：待实测项里，
 * 「二进制里有这行日志文案」是上一轮**唯一的**证据；本轮必须先复核这条证据在当前
 * 版本（2.1.283，上一轮是 2.1.281 附近）里是否还成立，再去真机跑。
 *
 * 输出：`probe/dumps/v4/claude-exe-strings.json`
 * 用法：node probe/v4/claude-exe-strings.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { note, writeDump } from './lib/env.mjs';

/** 全局 claude CLI（题面给定路径）。 */
const EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

if (!existsSync(EXE)) throw new Error(`找不到 claude.exe：${EXE}`);

const NEEDLES = [
  'workflow: concurrent agent gate',
  'CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS',
  'CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS',
  'CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS',
  'CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS',
  'CLAUDE_CODE_WORKFLOWS',
  'CLAUDE_CODE_DISABLE_WORKFLOWS',
  'CLAUDE_CODE_WORKFLOW_LAUNCH_SHA256',
  'workflowSizeGuideline',
  'scheduled_agents',
  'agent_cap',
  'cap_from_guideline',
  'enableWorkflows',
  'ultracode',
  'CLAUDE_CODE_ENABLE_TODO_TOOLS',
  'CLAUDE_CODE_ENABLE_TASKS',
  'AskUserQuestion',
  'TodoWrite',
  'TaskCreate',
  'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
];

// 245MB 的二进制按 latin1 读成字符串（字节↔码点 1:1，不做 UTF-8 解码，避免多字节错位）。
const raw = readFileSync(EXE, 'latin1');

/** 取 needle 第 n 次出现的上下文。 */
function contexts(needle, window = 220, maxHits = 3) {
  const hits = [];
  let from = 0;
  while (hits.length < maxHits) {
    const at = raw.indexOf(needle, from);
    if (at < 0) break;
    hits.push({ at, context: raw.slice(Math.max(0, at - window), at + needle.length + window).replace(/[\u0000-\u0008\u000b-\u001f]/g, '·') });
    from = at + 1;
  }
  return hits;
}

const report = { exe: EXE, bytes: statSync(EXE).size, needles: {} };
for (const needle of NEEDLES) {
  const hits = contexts(needle);
  report.needles[needle] = { count: raw.split(needle).length - 1, hits };
  note(`${needle} → ${report.needles[needle].count} 次`);
}

const file = writeDump('v4/claude-exe-strings', report);
note('落盘：', file);
