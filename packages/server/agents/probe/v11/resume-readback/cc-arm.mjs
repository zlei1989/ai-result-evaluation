#!/usr/bin/env node
/**
 * 跨家「暗号回读」驱动器的 **cc 支**：把现成的 `cc-session-resume.mjs` 当引擎，
 * 按 `--role=` 单跑接口把「正面 / 阴性对照 / 围栏」三档跑齐，并把两条并行判据读出来。
 *
 * 为什么这一支要自己读**转录文件**当投影：cc 的会话持久物就是
 * **`$CLAUDE_CONFIG_DIR/projects/<cwd 的转义>/<session_id>.jsonl`**——文件名就是 session_id。
 * 于是「厂商侧投影里有没有上一轮的事实」有一份**不经过我们任何投影**的原文：直接读那份 jsonl。
 * 定位键（`resume` 看得见的范围）是 **`CLAUDE_CONFIG_DIR`** 一个：**cwd 不是隔离键**——同一个
 * configDir 下换一个 cwd 照样按 `session_id` 接上（下面 ④ 那一格把它记成**读数**而不是围栏）。
 *
 * 三档：
 *  · **正面**：进程 A 记住随机暗号 → **新进程**只带 `resume: <A 的 session_id>` 问回来；
 *    投影 = 被接续那条会话的转录里含暗号；答复 = 模型答出暗号。
 *  · **反面（阴性对照）**：同样的 configDir 与 cwd、**不传 resume** 问回来；
 *    投影 = 这一轮**新建**的那条会话转录里不含暗号、且它的 session_id 与 A 不同；答复 = 答不出。
 *  · **围栏**：换 `CLAUDE_CONFIG_DIR` / 用一个不存在的 `session_id` —— 两档都必须被**拒**，
 *    不许静默新建一个空会话把「答不出」伪装成「不支持」。（「跨 cwd」不是围栏：它按读数记，
 *    因为同一个 configDir 下换 cwd 接得上，那正是「隔离键只有 configDir」这条结论的来源。）
 *
 * ⚠️ 两个坑（都在现成探针里踩过）：
 *  1. 现成探针的读数按 `cc-session-resume-<role>.json` **定名**，同一 role 连跑两次是**后写覆盖先写**
 *     ⇒ 每次 `spawnSync` 回来必须**立刻**读那份读数，否则拿到的是下一格的；
 *  2. 模型会抖：投影成立而答复落空时，按 spec 口径**不算不支持**，本支会**自动重问一次**
 *     （新进程、同 resume），两次答复都进读数。
 *
 * 用法（凭据只从环境变量读）：
 *   set -a; eval "$(grep -E '^export AIEVAL_PROBE' ~/.zshrc)"; set +a
 *   node packages/server/agents/probe/v11/resume-readback/cc-arm.mjs
 *   … node cc-arm.mjs --nonce=AIEVAL-XXXXXXXX --timeout-ms=300000
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gateOf,
  hitOf,
  note,
  pick,
  readProbeDump,
  reading,
  runArmCli,
  runProbe,
  scanFile,
  scanTree,
  shortenPath,
} from './criteria.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 引擎：既有的单家探针（**只加不改**：本支不改它一行，只按 `--role=` 调它）。 */
const ENGINE = join(HERE, '..', 'cc-session-resume.mjs');
/** 引擎写读数的定名规则（`writeDump(\`cc-session-resume-${role}\`)`）。 */
const dumpNameOf = (role) => `cc-session-resume-${role}`;

/** 问回的原文（与引擎 `read` 那一档逐字一致：判据要与引擎口径可比）。 */
const ASK = '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。';

/** 子进程 stderr 的末行（排障用：读数里要留下「跑不起来」的原文）。 */
function tail(text) {
  const rows = String(text ?? '').trim().split('\n').filter((one) => one !== '');
  return rows.length === 0 ? '' : rows[rows.length - 1].slice(0, 200);
}

/**
 * 找一条会话的转录文件：`<configDir>/projects/<cwd 转义>/<session_id>.jsonl`。
 *
 * 目录名（cwd 的转义）不自己算——那是厂商的规则、且带平台前缀差异；
 * 只在 `projects` 下面两跳里按**文件名就是 session_id** 这一条找。
 *
 * @param configDir `CLAUDE_CONFIG_DIR`（会话持久物的根）。
 * @param sessionId 要找的会话 id（空串 ⇒ 找不到）。
 * @returns 绝对路径，或 `null`。
 */
function transcriptOf(configDir, sessionId) {
  if (sessionId === '') return null;
  const root = join(configDir, 'projects');
  let projects = [];
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((one) => one.isDirectory());
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = join(root, project.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 载体健康检查：跑不起来时给出**原因表**（空表 = 这一格真的跑成了）。 */
function healthOf({ run, dump, role, timeoutMs }) {
  const reasons = [];
  if (run.timedOut) reasons.push(`${role} 到 ${timeoutMs}ms 上限被杀`);
  if (run.spawnError !== null) reasons.push(`${role} 起不来：${run.spawnError}`);
  if (run.exit !== 0) reasons.push(`${role} 退出码 ${String(run.exit)}${run.stderr === '' ? '' : `（stderr 末行：${tail(run.stderr)}）`}`);
  if (dump === null) reasons.push(`${role} 没落读数（${dumpNameOf(role)}.json 不在）`);
  else {
    if (dump.timedOut === true) reasons.push(`${role} 内部超时（引擎自己的墙钟上限）`);
    if (dump.error !== null && dump.error !== undefined) {
      reasons.push(`${role} 抛错：${String(dump.error.message ?? dump.error).slice(0, 240)}`);
    }
  }
  return reasons;
}

/**
 * 跑 cc 一家的两面 + 三条围栏。
 *
 * @param input.nonce 随机暗号（正面那一半要让模型记住它、问回时判它）。
 * @param input.timeoutMs 单个 role 进程的墙钟上限。
 * @returns 一家的读数（形状见 `criteria.mjs` 的 `renderArm` / 驱动器）。
 */
export async function runCcArm({ nonce, timeoutMs = 300_000 }) {
  const root = mkdtempSync(join(tmpdir(), 'aieval-readback-cc-'));
  const configDir = join(root, 'agenthome');
  const cwd = join(root, 'workspace');
  const otherConfig = join(root, 'agenthome-other');
  const otherCwd = join(root, 'workspace-other');
  for (const dir of [configDir, cwd, otherConfig, otherCwd]) mkdirSync(dir, { recursive: true });

  const base = [`--config-dir=${configDir}`, `--cwd=${cwd}`];
  const broken = [];
  const raw = {};

  /**
   * 跑一个 role 并**立刻**读它刚写的那份读数。
   * `role` 的三档（write / read）各自一个定名 → 同 role 连跑会覆盖，所以这一步不能延后。
   */
  const role = (name, args) => {
    const run = runProbe({ script: ENGINE, args, timeoutMs });
    const dump = readProbeDump(dumpNameOf(name));
    if (run.stdout !== '') process.stdout.write(run.stdout);
    if (run.exit !== 0 && run.stderr !== '') process.stderr.write(run.stderr);
    return { run, dump, sessionId: pick(run.stdout, 'SESSION_ID'), reply: pick(run.stdout, 'REPLY') };
  };

  // ① 正面那一半的写半边：新会话、记住暗号
  const write = role('write', [`--role=write`, ...base, `--nonce=${nonce}`]);
  raw.write = { exit: write.run.exit, ms: write.run.ms, sessionId: write.sessionId, reply: write.reply };
  broken.push(...healthOf({ run: write.run, dump: write.dump, role: 'write', timeoutMs }));
  const idA = write.sessionId;

  // 正面那一半的转录（写半边的事实：暗号确实进了这条会话的盘上原文）
  const transcriptA = scanFile(transcriptOf(configDir, idA), nonce);
  raw.transcriptWrite = transcriptA;

  // ② 正面：新进程 + resume 问回来
  const resume = idA === ''
    ? null
    : role('read', [`--role=read`, ...base, `--resume=${idA}`, `--nonce=${nonce}`]);
  if (resume !== null) {
    broken.push(...healthOf({ run: resume.run, dump: resume.dump, role: 'read', timeoutMs }));
  }
  const idB = resume?.sessionId ?? '';
  let replyB = resume?.reply ?? '';
  const transcriptB = scanFile(transcriptOf(configDir, idB), nonce);
  raw.resume = {
    exit: resume?.run.exit ?? null,
    ms: resume?.run.ms ?? null,
    sessionId: idB,
    reply: replyB,
    transcript: transcriptB,
  };

  // 模型抖了一次就重问一次（新进程、同 resume）：单次答不出**不算不支持**
  let replyBRetry = null;
  if (broken.length === 0 && transcriptB.hitLines > 0 && !hitOf(replyB, nonce).ok && idA !== '') {
    const retry = role('read', [`--role=read`, ...base, `--resume=${idA}`, `--nonce=${nonce}`]);
    const retryHealth = healthOf({ run: retry.run, dump: retry.dump, role: 'read', timeoutMs });
    if (retryHealth.length === 0) replyBRetry = retry.reply;
    raw.resumeRetry = retryHealth.length === 0
      ? { sessionId: retry.sessionId, reply: retry.reply, transcript: scanFile(transcriptOf(configDir, retry.sessionId), nonce) }
      : { broken: retryHealth };
    note(`正面答复落空 ⇒ 按口径重问一次：${JSON.stringify(replyBRetry ?? '(仍然没跑成)')}`);
  }

  // ③ 反面（阴性对照）：同 configDir 同 cwd、不传 resume
  const control = role('read', [`--role=read`, ...base, `--nonce=${nonce}`]);
  broken.push(...healthOf({ run: control.run, dump: control.dump, role: 'read', timeoutMs }));
  const idC = control.sessionId;
  const transcriptC = scanFile(transcriptOf(configDir, idC), nonce);
  raw.control = { exit: control.run.exit, ms: control.run.ms, sessionId: idC, reply: control.reply, transcript: transcriptC };

  // ④ 围栏：三档都必须被拒（拒 = 引擎读数里的 `error` 非空），不许静默新建空会话
  const fenceRun = (label, args) => {
    const run = runProbe({ script: ENGINE, args, timeoutMs });
    const dump = readProbeDump(dumpNameOf('read'));
    if (run.stdout !== '') process.stdout.write(run.stdout);
    if (run.exit !== 0 && run.stderr !== '') process.stderr.write(run.stderr);
    const refusal = dump?.error === null || dump?.error === undefined ? null : String(dump.error.message ?? dump.error);
    const reply = pick(run.stdout, 'REPLY');
    return { label, refusal, reply, exit: run.exit, timedOut: run.timedOut, sessionId: pick(run.stdout, 'SESSION_ID') };
  };
  const fenceCrossCwd = fenceRun('cross-cwd', [`--role=read`, `--config-dir=${configDir}`, `--cwd=${otherCwd}`, `--resume=${idA}`, `--nonce=${nonce}`]);
  // 跨 cwd 那一格若接上了，两条旁证让结论闭合：返回的 session_id 还是不是 A、A 的原转录有没有被继续追加
  const transcriptAAfter = scanFile(transcriptOf(configDir, idA), nonce);
  const fenceOtherConfig = fenceRun('other-config', [`--role=read`, `--config-dir=${otherConfig}`, `--cwd=${cwd}`, `--resume=${idA}`, `--nonce=${nonce}`]);
  const fenceUnknown = fenceRun('unknown-id', [`--role=read`, ...base, `--resume=00000000-0000-4000-8000-000000000000`, `--nonce=${nonce}`]);
  const fences = [
    {
      // 这一条**不是**围栏而是读数：`resume` 的定位/隔离键只有 configDir 那一半——换 cwd
      // （同一个 configDir）照样按 id 接得上 ⇒ 「跨 cwd 被拒」不是一条成立的围栏，只作读数记。
      kind: 'reading',
      name: '读数：换 cwd 之后还能不能 resume（spec 把定位键写成 configDir × cwd）',
      expected: '被拒（按 spec 口径应当被拒）',
      ok: fenceCrossCwd.refusal !== null && !hitOf(fenceCrossCwd.reply, nonce).ok,
      detail: fenceCrossCwd.refusal === null
        ? `**接上了**（答复 ${JSON.stringify(fenceCrossCwd.reply.slice(0, 80))}）⇒ 同一个 configDir 下换 cwd 仍能按 id 找到会话，隔离键只有 configDir 那一半；旁证：这一格返回的 session_id ${fenceCrossCwd.sessionId === idA ? '就是 A' : `是 ${fenceCrossCwd.sessionId}`}、A 的原转录现在含暗号 ${transcriptAAfter.hitLines} 行（B 那一格之后是 ${transcriptB.hitLines} 行）`
        : `被拒原文：${fenceCrossCwd.refusal.slice(0, 160)}`,
      evidence: [configDir, otherCwd, `session_id = ${idA}`, `A 的转录：${transcriptAAfter.path ?? '(不在)'}`],
    },
    {
      name: '围栏：换 CLAUDE_CONFIG_DIR',
      expected: '被拒（转录不在这个 home 下）',
      ok: fenceOtherConfig.refusal !== null && !hitOf(fenceOtherConfig.reply, nonce).ok,
      detail: fenceOtherConfig.refusal === null
        ? `竟然接上了（答复 ${JSON.stringify(fenceOtherConfig.reply.slice(0, 80))}）`
        : `被拒原文：${fenceOtherConfig.refusal.slice(0, 160)}`,
      evidence: [otherConfig],
    },
    {
      name: '围栏：不存在的 session_id',
      expected: '被拒（不许静默新建空会话）',
      ok: fenceUnknown.refusal !== null && !hitOf(fenceUnknown.reply, nonce).ok,
      detail: fenceUnknown.refusal === null
        ? `没被拒，答复 ${JSON.stringify(fenceUnknown.reply.slice(0, 80))}`
        : `被拒原文：${fenceUnknown.refusal.slice(0, 160)}`,
      evidence: [],
    },
  ];

  // ⑤ 两条并行判据（投影判机制、答复判端到端）
  const answerB = hitOf(`${replyB}\n${replyBRetry ?? ''}`, nonce);
  const answerC = hitOf(control.reply, nonce);
  const sides = {
    resume: {
      projection: reading(
        transcriptB.exists ? transcriptB.hitLines > 0 : null,
        transcriptB.exists
          ? `被接续那条会话的转录（${shortenPath(transcriptB.path)}）含暗号 ${transcriptB.hitLines} 行（写半边 A 的转录含 ${transcriptA.hitLines} 行）`
          : '被接续那条会话的转录不在（session_id 没读出来，或这一格没跑成）⇒ 读不出',
        [transcriptB.path ?? '(无)', transcriptA.path ?? '(A 的转录不在)', `session_id A = ${idA}`, `session_id B = ${idB}`],
      ),
      reply: reading(
        broken.length === 0 ? answerB.ok : null,
        answerB.ok
          ? `答出暗号（命中方式 ${answerB.mode}）`
          : `没答出暗号${replyBRetry === null ? '' : '（含重问一次）'}`,
        [`问回原文：${ASK}`, `第一次答复：${JSON.stringify(replyB.slice(0, 200))}`, `重问答复：${JSON.stringify(replyBRetry ?? '(未重问)')}`],
      ),
      question: ASK,
      notRun: null,
    },
    control: {
      projection: reading(
        broken.length === 0 ? (transcriptC.exists ? transcriptC.hitLines > 0 : null) : null,
        transcriptC.exists
          ? `这一轮新建的会话转录（${shortenPath(transcriptC.path)}）${transcriptC.hitLines > 0 ? `**含**暗号 ${transcriptC.hitLines} 行` : '不含暗号'}，且身份与 A ${idC !== idA ? '不同' : '**相同**'}`
          : '对照那一轮的转录不在 ⇒ 读不出',
        [transcriptC.path ?? '(无)', `session_id C = ${idC}`],
      ),
      reply: reading(
        broken.length === 0 ? answerC.ok : null,
        answerC.ok ? `阴性对照竟然答出暗号（命中方式 ${answerC.mode}）⇒ 泄漏` : '答不出',
        [`答复：${JSON.stringify(control.reply.slice(0, 200))}`],
      ),
      question: ASK,
      notRun: null,
    },
  };

  if (broken.length > 0) {
    sides.resume.projection = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, sides.resume.projection.evidence);
    sides.resume.reply = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, sides.resume.reply.evidence);
    sides.control.projection = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, sides.control.projection.evidence);
    sides.control.reply = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, sides.control.reply.evidence);
  }

  return {
    key: 'cc',
    family: 'cc',
    variant: 'cc（@anthropic-ai/claude-agent-sdk；转录 projects/<cwd>/<session_id>.jsonl）',
    engine: ENGINE,
    nonce,
    dirs: { root, configDir, cwd, otherConfig, otherCwd },
    env: { AIEVAL_PROBE_CC_MODEL: process.env.AIEVAL_PROBE_CC_MODEL ?? '(未设，引擎回落 claude-sonnet-4-5)' },
    sides,
    fences,
    broken,
    raw: {
      ...raw,
      fences: { crossCwd: { ...fenceCrossCwd, transcriptAAfter }, otherConfig: fenceOtherConfig, unknown: fenceUnknown },
      projectsTree: scanTree(join(configDir, 'projects'), { nonce }).hits.map((one) => ({ rel: one.rel, bytes: one.bytes, hitLines: one.hitLines })),
    },
    verdict: gateOf({ resume: sides.resume, control: sides.control, broken }),
  };
}

/** `node cc-arm.mjs` 直接跑这一家（与驱动器同一函数，读数必然同形）。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('cc-arm.mjs')) {
  note(`引擎 = ${ENGINE}`);
  await runArmCli({ family: 'cc', run: runCcArm });
}
