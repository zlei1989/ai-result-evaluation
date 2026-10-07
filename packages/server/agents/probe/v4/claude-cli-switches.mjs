/**
 * v4 / Q2 顺带项：**CLI 用什么开关能把内部日志放出来？**
 *
 * 做法（两条独立证据）：
 *   ① `claude.exe --help` 的原文里所有与「日志/调试/详细」相关的开关；
 *   ② 打包 exe 里 `CLAUDE_CODE_` 前缀的**全部**环境变量名（683 个），以及其中与 debug/log 相关的那些。
 *
 * 为什么要落盘而不是只在终端里看一眼：设计稿要求「凡某字段不存在/为空，先打印原始形态」，
 * 开关清单是后续所有「日志没出现」结论的对照基线。
 *
 * 用法：node probe/v4/claude-cli-switches.mjs
 * 产物：probe/dumps/v4/claude-cli-switches.json
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { note, writeDump } from './lib/env.mjs';
import { CLAUDE_EXE } from './lib/claude.mjs';

// ① --help 原文（只留 stderr/stdout 两块，不去解析）
const help = spawnSync(CLAUDE_EXE, ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
const helpText = `${help.stdout ?? ''}${help.stderr ?? ''}`;
const LOG_SWITCH_PATTERN = /debug|verbose|log|telemetry|otel|trace|diag/i;
const helpLines = helpText.split(/\r?\n/);
const switchLines = helpLines.filter((line) => /^\s{2}(-|--)/.test(line)).map((line) => line.trim());
const logSwitches = switchLines.filter((line) => LOG_SWITCH_PATTERN.test(line));
note(`--help：${helpLines.length} 行；开关 ${switchLines.length} 个；其中与日志/调试相关 ${logSwitches.length} 个`);
for (const line of logSwitches) note('  ', line);

// ② exe 里的 CLAUDE_CODE_* 环境变量名全量
const raw = readFileSync(CLAUDE_EXE, 'latin1');
const envNames = [...new Set([...raw.matchAll(/CLAUDE_CODE_[A-Z0-9_]+/g)].map((hit) => hit[0]))].sort();
const logEnvNames = envNames.filter((name) => LOG_SWITCH_PATTERN.test(name));
note(`exe 内 CLAUDE_CODE_* 去重后 ${envNames.length} 个；其中与日志/调试相关 ${logEnvNames.length} 个`);
for (const name of logEnvNames) note('  ', name);

const file = writeDump('v4/claude-cli-switches', {
  at: new Date().toISOString(),
  exe: CLAUDE_EXE,
  helpLineCount: helpLines.length,
  switchLines,
  logSwitches,
  claudeCodeEnvNames: envNames,
  claudeCodeEnvCount: envNames.length,
  logEnvNames,
});
note('落盘：', file);
