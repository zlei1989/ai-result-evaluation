#!/usr/bin/env node
/**
 * 跨家「暗号回读」**统一驱动器**：同一套判据对四家跑，每家有**正反两面**（resume / 不 resume），
 * 每面**两条并行判据**——**投影（机制）**与**答复（端到端）**。
 *
 * 为什么要统一驱动器：四家的单家探针各自证明过「这家能跨进程续接」，但每家的判据形状、读数文件名、
 * 阴性对照的写法都不一样 ⇒ 「四家横向可比」这件事本身没人证。这一支把四家放进**同一套判据口径**下：
 *  · 投影（机制）：厂商侧的可查事实——cc 读 `projects` 下的转录、codex 读 `thread/read` 与 rollout、
 *    pi 读厂商自己的 `buildSessionContext()`、dsh 读盘上的会话日志；反面要求这些投影里**不含**上一轮的暗号；
 *  · 答复（端到端）：模型**答出**（正面）/ **答不出**（反面）暗号；
 *  · **单次答不出不算「不支持」**：投影成立而答复落空时自动重问一次，两次答复都进读数（`model-flaked`）；
 *  · **跑不起来 ≠ 探测失败**：载体进程没跑成时该家记 `inconclusive` 并列出原因，绝不降级成「不支持」。
 *
 * 四家的引擎仍是**现成的单家探针**（本目录只加不改）：`cc|codex|pi|dsh-session-resume.mjs`
 * 与 `dsh-session-resume-alpha3.mjs`。驱动器负责的是编排（暗号、隔离目录、进程数）、判据归一与矩阵。
 *
 * dsh 分两格：**本仓 pin（`0.2.1-alpha.3`）** 那一格跑得起来（wire 上有 `session/resume`）；
 * 给了 `--sdk-dir=`（或 `AIEVAL_PROBE_DSH_SDK_DIR`）时另跑一格外装版本（按那一版自己的能力走）。
 *
 * 用法（凭据只从环境变量读）：
 *   set -a; eval "$(grep -E '^export AIEVAL_PROBE' ~/.zshrc)"; set +a
 *   node packages/server/agents/probe/v11/resume-readback/driver.mjs
 *   … --families=cc,pi --sdk-dir=/tmp/<仓外装的那份> --timeout-ms=300000
 *
 * 退出码：`0` = 被选中的家都跑起来了；`2` = 有家没跑起来（读数里那些格作废，**不许**当「不支持」读）。
 * 某一格**跑不起来**（例如 dsh pin 的正面）**不改**退出码：它是一个已记录的环境事实（版本门），
 * 由反断言承载，并在 `notRun` 里逐字写明原因。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCcArm } from './cc-arm.mjs';
import { runCodexArm } from './codex-arm.mjs';
import { runDshAlpha3Arm, runDshPinnedArm } from './dsh-arm.mjs';
import { runPiArm } from './pi-arm.mjs';
import { DUMP_ROOT, GATE_LABEL, flagOf, gateOf, mark, note, renderArm, writeReadbackDump } from './criteria.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 家名 → 臂。dsh 展开成两格（pin + 可选的外装新版），故它的工厂单独处理。 */
const FACTORIES = {
  cc: async ({ nonce, timeoutMs }) => [await runCcArm({ nonce, timeoutMs })],
  codex: async ({ nonce, timeoutMs }) => [await runCodexArm({ nonce, timeoutMs })],
  pi: async ({ nonce, timeoutMs }) => [await runPiArm({ nonce, timeoutMs })],
  dsh: async ({ nonce, timeoutMs, sdkDir }) => {
    const arms = [await runDshPinnedArm({ nonce, timeoutMs })];
    if (sdkDir !== null) arms.push(await runDshAlpha3Arm({ nonce, timeoutMs, sdkDir }));
    return arms;
  },
};

/** 终端里的显示宽度：CJK 与全角标点算 2 格（不这么算，矩阵表会被中文顶歪）。 */
function width(text) {
  let total = 0;
  for (const ch of String(text)) total += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return total;
}

/** 按显示宽度补齐（表里用）。 */
function pad(text, target) {
  const gap = target - width(text);
  return gap <= 0 ? String(text) : `${text}${' '.repeat(gap)}`;
}

/** 一格读数 → 矩阵里的短记号（正面期待「含 / 答出」，反面期待「不含 / 答不出」；原始三态在 dump 里）。 */
function cell(one, expect, yes, no) {
  if (one === null || one === undefined || one.ok === null) return '⬜ 读不出';
  return one.ok === expect ? `✅ ${yes}` : `❌ ${no}`;
}

/** 一家的四个读数摊成矩阵的一行。 */
function rowOf(arm) {
  return {
    key: arm.key ?? arm.family,
    variant: arm.variant,
    projectionResume: cell(arm.sides.resume.projection, true, '含暗号', '没带'),
    replyResume: cell(arm.sides.resume.reply, true, '答出', '没答出'),
    projectionControl: cell(arm.sides.control.projection, false, '不含', '含暗号'),
    replyControl: cell(arm.sides.control.reply, false, '答不出', '答出'),
    gate: arm.verdict.gate,
    gateLabel: GATE_LABEL[arm.verdict.gate] ?? arm.verdict.gate,
    fences: arm.fences.map((one) => `${mark(one.ok)} ${one.name}`),
    broken: arm.broken,
  };
}

/** 打印矩阵表（列宽按显示宽度算）。 */
function printMatrix(rows, notRun) {
  const header = ['家 / 变体', '正面：投影（机制）', '正面：答复（模型）', '反面：投影', '反面：答复', '判定'];
  const body = rows.map((row) => [
    row.key,
    row.projectionResume,
    row.replyResume,
    row.projectionControl,
    row.replyControl,
    row.gate,
  ]);
  const table = [header, ...body];
  const widths = header.map((_, index) => Math.max(...table.map((line) => width(line[index]))) + 2);
  note('');
  note('四家 × 两面 × 两条判据（正面期待「含暗号 / 答出」，反面期待「不含 / 答不出」）：');
  for (const line of table) note(`  ${line.map((text, index) => pad(text, widths[index])).join('')}`);
  for (const [key, reason] of Object.entries(notRun)) note(`  ⬜ ${key}：${reason}`);
}

/**
 * 一家的「原文关键读数」：四家的 `raw` 形状不同，故按格摊平只取前几格 + 暗号；
 * 全部原文在各自的 `resume-readback-<family>.json` 里。
 */
function highlightsOf(arm) {
  const lines = [`暗号 = ${arm.nonce}`];
  for (const [key, value] of Object.entries(arm.raw ?? {})) {
    if (value === null || value === undefined) continue;
    lines.push(`${key} = ${JSON.stringify(value).slice(0, 260)}`);
    if (lines.length >= 7) break;
  }
  return lines;
}

// ───────────────────────────── 入口 ─────────────────────────────

const familiesFlag = flagOf('families', 'cc,codex,pi,dsh');
const families = familiesFlag.split(',').map((one) => one.trim()).filter((one) => one !== '');
const timeoutMs = Number(flagOf('timeout-ms', '300000'));
const sdkDir = flagOf('sdk-dir', flagOf('dsh-sdk-dir', process.env.AIEVAL_PROBE_DSH_SDK_DIR ?? null));
const nonce = flagOf('nonce', `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`);

const unknown = families.filter((one) => !Object.hasOwn(FACTORIES, one));
if (unknown.length > 0) {
  note(`不认识的家：${unknown.join(', ')}（可选：${Object.keys(FACTORIES).join(' / ')}）`);
  process.exit(2);
}

// 凭据**只从环境变量读**：缺了就直接收场（跑不起来 ≠ 探测失败，别让四家各自以自己的形状失败）
const needsGateway = families.some((one) => one !== 'dsh');
const missingEnv = [
  ...(needsGateway && (process.env.AIEVAL_PROBE_GATEWAY_API_KEY ?? '') === '' ? ['AIEVAL_PROBE_GATEWAY_API_KEY'] : []),
  ...(needsGateway && (process.env.AIEVAL_PROBE_GATEWAY_BASE_URL ?? '') === '' ? ['AIEVAL_PROBE_GATEWAY_BASE_URL'] : []),
];
if (missingEnv.length > 0) {
  note(`缺环境变量：${missingEnv.join(' / ')} ⇒ 退出（凭据只从环境变量读；先 set -a; eval "$(grep -E '^export AIEVAL_PROBE' ~/.zshrc)"; set +a）`);
  process.exit(2);
}

note(`驱动器 = ${join(HERE, 'driver.mjs')}`);
note(`家 = ${families.join(', ')}｜暗号 = ${nonce}（随机）｜单进程墙钟上限 ${timeoutMs}ms`);
note(`模型档：cc=${process.env.AIEVAL_PROBE_CC_MODEL ?? '(默认)'}｜codex=${process.env.AIEVAL_PROBE_CODEX_MODEL ?? '(默认)'}｜pi=${process.env.AIEVAL_PROBE_PI_MODEL ?? '(默认)'}｜dsh=${process.env.AIEVAL_PROBE_DSH_MODEL ?? '(默认)'}`);
note(`dsh 的外装新版客户端 = ${sdkDir ?? '(未给 --sdk-dir ⇒ 只跑本仓 pin 那一格，正面只能反断言)'}`);
note(`读数落点 = ${DUMP_ROOT}（gitignore）`);

const arms = [];
const notRun = {};
const failures = [];

for (const family of families) {
  note('');
  note(`▶ 跑 ${family} …`);
  try {
    const produced = await FACTORIES[family]({ nonce, timeoutMs, sdkDir });
    for (const arm of produced) {
      arms.push({ ...arm, verdict: arm.verdict ?? gateOf({ resume: arm.sides.resume, control: arm.sides.control, broken: arm.broken }) });
      // 一家的读数只在该家载体都跑起来时落盘（`runArmCli` 同一条口径）；跑不起来的原因进矩阵
      if (arm.broken.length === 0) writeReadbackDump(arm.key ?? arm.family, arm);
      if (typeof arm.sides.resume.notRun === 'string' && arm.sides.resume.notRun !== '') notRun[`${arm.family} 的正面`] = arm.sides.resume.notRun;
      if (arm.broken.length > 0) failures.push(`${arm.family}：${arm.broken.join('；')}`);
    }
  } catch (caught) {
    const message = `${family} 这一家整个抛错：${String(caught?.stack ?? caught).slice(0, 400)}`;
    failures.push(message);
    notRun[family] = message;
  }
}
if (families.includes('dsh') && sdkDir === null) {
  notRun['dsh 的外装新版那一格'] = '没给 --sdk-dir（或 AIEVAL_PROBE_DSH_SDK_DIR）⇒ 仓外那版客户端不可达';
}

const complete = failures.length === 0;

note('');
note('════════════════ 统一读数 ════════════════');
const rows = arms.map(rowOf);
printMatrix(rows, notRun);

for (const arm of arms) {
  note('');
  note(renderArm(arm));
  note('  原文关键读数：');
  for (const line of highlightsOf(arm)) note(`    ${line}`);
}

const matrix = {
  at: new Date().toISOString(),
  driver: join(HERE, 'driver.mjs'),
  nonce,
  families,
  timeoutMs,
  dshSdkDir: sdkDir,
  env: {
    gatewayBaseUrl: process.env.AIEVAL_PROBE_GATEWAY_BASE_URL ?? null,
    ccModel: process.env.AIEVAL_PROBE_CC_MODEL ?? null,
    codexModel: process.env.AIEVAL_PROBE_CODEX_MODEL ?? null,
    piModel: process.env.AIEVAL_PROBE_PI_MODEL ?? null,
    dshModel: process.env.AIEVAL_PROBE_DSH_MODEL ?? null,
  },
  /**
   * `complete === true` 只表示**没有进程级的跑不起来**（四家的载体都真跑成了）。
   * 某一格是否可达由每家的 `verdict.gate` 与 `notRun` 各自表达——dsh pin 的正面是版本门，不是故障。
   */
  complete,
  failures,
  notRun,
  rows,
  arms,
};
const file = writeReadbackDump('matrix', matrix);

note('');
note('════════════════ 收尾 ════════════════');
note(`矩阵落盘：${file}`);
note(`complete = ${String(complete)}（只表示没有进程级跑不起来，不表示每家都「支持」）`);
if (!complete) {
  note(`⚠️ 有 ${failures.length} 处跑不起来 ⇒ 对应读数作废、不许当「不支持」读：`);
  for (const one of failures) note(`   · ${one}`);
  note('退出码 2');
  process.exitCode = 2;
} else {
  note(`判定：${rows.map((one) => `${one.key}=${one.gate}`).join('｜')}`);
  note('判据口径：投影判机制、答复判端到端，两条各自成立才算数；单次答不出按 `model-flaked` 记，不算「不支持」。');
}
