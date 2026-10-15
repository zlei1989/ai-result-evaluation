#!/usr/bin/env node
/**
 * 跨家「暗号回读」驱动器的 **pi 支**：把现成的 `pi-session-resume.mjs` 当引擎，
 * 按 `--role=` 单跑接口把「正面 / 阴性对照 / 隔离围栏」三档跑齐。
 *
 * 这一支的投影判据是四家里**最干净**的一条：引擎在 `prompt()` **之前**读厂商自己的
 * `manager.buildSessionContext()`，把「厂商从会话文件里投影出来的模型上下文」整份带回来
 * （定式行 `PROJECTION_HAS_NONCE`）。它不经过模型、不花额度，所以「机制坏了」与「模型这一把没答对」
 * 在这一家可以当场分开：
 *  · 投影里没有暗号 ⇒ 机制真的没接上；
 *  · 投影里有、模型仍答「不知道」⇒ 这一把是模型抖了。
 *
 * 续接形状：`SessionManager.open(<A 写的会话文件>)` 塞回 `createAgentSession`
 * （**不是** `continueRecent`——后者取目录里 mtime 最新的一条，行内重跑会接到上一次尝试）。
 * 定位键是**会话目录**：文件名带不可预知的时间戳 ⇒ id 拼不回路径，落的是**文件路径**。
 *
 * 三档：
 *  · **正面**：进程 A 用文件型 manager 新建会话、记住随机暗号 → **新进程** `open(A 的文件)` 问回来；
 *  · **反面（阴性对照）**：同 cwd、同会话目录，只是**不打开那个文件**（`create` 一条新的）问回来；
 *  · **围栏（隔离的另一半）**：**刻意复用同一个 cwd**、只换行目录（configHome × 会话目录）写暗号 C，
 *    再在那个目录里续问暗号 A —— 必须答不出 A。只测「行内答得出」证明不了两行没共享。
 *
 * 用法（凭据只从环境变量读）：
 *   set -a; eval "$(grep -E '^export AIEVAL_PROBE' ~/.zshrc)"; set +a
 *   node packages/server/agents/probe/v11/resume-readback/pi-arm.mjs
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
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
  shortenPath,
} from './criteria.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 引擎：既有的单家探针（**只加不改**）。 */
const ENGINE = join(HERE, '..', 'pi-session-resume.mjs');

/** 问回的原文（与引擎那一档逐字一致）。 */
const ASK = '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。';

/** 子进程 stderr 的末行（读数里要留下「跑不起来」的原文）。 */
function tail(text) {
  const rows = String(text ?? '').trim().split('\n').filter((one) => one !== '');
  return rows.length === 0 ? '' : rows[rows.length - 1].slice(0, 200);
}

/**
 * 一格（一个 role、一个真 node 进程）的读数。
 *
 * pi 的 `prompt()` **永不抛**：失败只体现在助手回合的 `stopReason` / `errorMessage` 上，
 * 所以载体健康检查必须看它们，光看退出码会把「这一轮压根没跑成」读成「模型选择不答」。
 */
function cellOf({ label, run, timeoutMs }) {
  const dump = readProbeDump(`pi-session-resume-${label}`);
  const reasons = [];
  if (run.timedOut) reasons.push(`${label} 到 ${timeoutMs}ms 上限被杀`);
  if (run.spawnError !== null) reasons.push(`${label} 起不来：${run.spawnError}`);
  if (run.exit !== 0) reasons.push(`${label} 退出码 ${String(run.exit)}${run.stderr === '' ? '' : `（stderr 末行：${tail(run.stderr)}）`}`);
  if (dump === null) reasons.push(`${label} 没落读数`);
  else {
    if (dump.outcome === 'timeout') reasons.push(`${label} 内部超时（引擎自己的墙钟上限）`);
    const last = Array.isArray(dump.turns) ? dump.turns.at(-1) : null;
    if (last !== null && last !== undefined && (last.stopReason === 'error' || (last.errorMessage ?? null) !== null)) {
      reasons.push(`${label} 这一轮报错：stopReason=${String(last.stopReason)} errorMessage=${String(last.errorMessage).slice(0, 160)}`);
    }
  }
  return {
    label,
    health: reasons,
    sessionFile: pick(run.stdout, 'SESSION_FILE'),
    sessionId: pick(run.stdout, 'SESSION_ID'),
    entries: Number(pick(run.stdout, 'ENTRIES') || 0),
    // 三态：定式行缺失（引擎没跑到那一步）⇒ `null`（读不出），不是「投影里没有」
    projectionHasNonce: run.stdout.includes('PROJECTION_HAS_NONCE=') ? pick(run.stdout, 'PROJECTION_HAS_NONCE') === '1' : null,
    reply: pick(run.stdout, 'REPLY'),
    exit: run.exit,
    ms: run.ms,
    dump,
  };
}

/**
 * 跑 pi 一家的两面 + 一条隔离围栏。
 *
 * @param input.nonce 随机暗号。
 * @param input.timeoutMs 单个 role 进程的墙钟上限。
 */
export async function runPiArm({ nonce, timeoutMs = 300_000 }) {
  const root = mkdtempSync(join(tmpdir(), 'aieval-readback-pi-'));
  const row1 = join(root, 'row1');
  const row2 = join(root, 'row2');
  const cwd = join(row1, 'workspace');
  const cfg1 = join(row1, '.agenthome');
  const dir1 = join(cfg1, 'sessions');
  const cfg2 = join(row2, '.agenthome');
  const dir2 = join(cfg2, 'sessions');
  for (const dir of [cwd, cfg1, dir1, cfg2, dir2]) mkdirSync(dir, { recursive: true });

  const broken = [];
  const raw = {};
  /**
   * 一格 = 一个真进程；`--label` 必须逐格不同（引擎按 label 定名读数，同名会互相覆盖）。
   *
   * `carrier` 决定这一格跑不成时算不算「本家跑不起来」：**载体**（正面写半边 / 正面问回 / 阴性对照）
   * 跑不成 ⇒ 本家读数作废；**围栏**跑不成只让那一条围栏读不出，不牵连两面的判据。
   */
  const run = (label, args, { carrier = true } = {}) => {
    const one = runProbe({ script: ENGINE, args, timeoutMs });
    if (one.stdout !== '') process.stdout.write(one.stdout);
    if (one.exit !== 0 && one.stderr !== '') process.stderr.write(one.stderr);
    const cell = cellOf({ label, run: one, timeoutMs });
    if (carrier) broken.push(...cell.health);
    return cell;
  };
  const base1 = [`--cwd=${cwd}`, `--config-dir=${cfg1}`, `--session-dir=${dir1}`];

  // ① 正面写半边：文件型 manager 新建一条会话、记住暗号
  const writeA = run('t9c-pi-a-write', [`--role=write`, ...base1, `--label=t9c-pi-a-write`, `--nonce=${nonce}`]);
  const fileA = writeA.sessionFile;
  raw.write = { exit: writeA.exit, ms: writeA.ms, sessionFile: fileA, sessionId: writeA.sessionId, reply: writeA.reply, entries: writeA.entries };
  const fileScanA = scanFile(fileA, nonce);
  raw.sessionFileWrite = { path: fileScanA.path, exists: fileScanA.exists, bytes: fileScanA.bytes, hitLines: fileScanA.hitLines };

  // ② 正面：新进程 open(A 的会话文件) 问回来
  const openB = fileA === ''
    ? null
    : run('t9c-pi-b-open', [`--role=open`, `--cwd=${cwd}`, `--config-dir=${cfg1}`, `--label=t9c-pi-b-open`, `--nonce=${nonce}`, `--session-file=${fileA}`]);
  const fileScanB = scanFile(openB?.dump?.sessionFileAfter ?? fileA, nonce);
  raw.open = {
    exit: openB?.exit ?? null,
    ms: openB?.ms ?? null,
    sessionFile: openB?.dump?.sessionFileAfter ?? null,
    projectionHasNonce: openB?.projectionHasNonce ?? null,
    reply: openB?.reply ?? '',
  };

  // 模型抖了一次就重问一次（新进程、同 open）：单次答不出**不算不支持**
  let replyBRetry = null;
  if (broken.length === 0 && openB !== null && openB.projectionHasNonce === true && !hitOf(openB.reply, nonce).ok) {
    const retry = run('t9c-pi-b-open-retry', [`--role=open`, `--cwd=${cwd}`, `--config-dir=${cfg1}`, `--label=t9c-pi-b-open-retry`, `--nonce=${nonce}`, `--session-file=${fileA}`], { carrier: false });
    replyBRetry = retry.reply;
    raw.openRetry = { projectionHasNonce: retry.projectionHasNonce, reply: retry.reply };
    note(`正面答复落空 ⇒ 按口径重问一次：${JSON.stringify(replyBRetry)}`);
  }

  // ③ 反面（阴性对照）：同 cwd、同会话目录，只是不打开那个文件
  const freshD = run('t9c-pi-d-fresh', [`--role=fresh`, ...base1, `--label=t9c-pi-d-fresh`, `--nonce=${nonce}`]);
  const fileScanD = scanFile(freshD.sessionFile, nonce);
  raw.control = {
    exit: freshD.exit,
    ms: freshD.ms,
    sessionFile: freshD.sessionFile,
    sessionId: freshD.sessionId,
    projectionHasNonce: freshD.projectionHasNonce,
    reply: freshD.reply,
    sessionFileHasNonce: fileScanD.hitLines,
  };

  // ④ 围栏：刻意复用同一个 cwd、只换行目录（cfg2 × dir2）写暗号 C，再在那里续问暗号 A
  const nonceC = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const writeC = run('t9c-pi-g-write-c', [`--role=write`, `--cwd=${cwd}`, `--config-dir=${cfg2}`, `--session-dir=${dir2}`, `--label=t9c-pi-g-write-c`, `--nonce=${nonceC}`], { carrier: false });
  const continueC = run('t9c-pi-h-continue-c', [`--role=continue`, `--cwd=${cwd}`, `--config-dir=${cfg2}`, `--session-dir=${dir2}`, `--label=t9c-pi-h-continue-c`, `--nonce=${nonce}`], { carrier: false });
  const fences = [
    {
      name: '围栏：换行目录（同 cwd、只换 configHome × 会话目录）',
      expected: '答不出暗号 A（隔离成立的那一半）',
      ok: continueC.projectionHasNonce === false && !hitOf(continueC.reply, nonce).ok,
      detail: `投影含 A = ${String(continueC.projectionHasNonce)}｜答复 = ${JSON.stringify(continueC.reply.slice(0, 120))}｜另一行的暗号 C = ${nonceC}（这一格答出 C 属预期：本目录的历史确实回来了）`,
      evidence: [cfg2, dir2, JSON.stringify(writeC.reply.slice(0, 80))],
    },
  ];
  raw.fence = { nonceC, writeC: { sessionFile: writeC.sessionFile, reply: writeC.reply }, continueC: { projectionHasNonce: continueC.projectionHasNonce, reply: continueC.reply } };

  // ⑤ 两条并行判据
  const answerB = hitOf(`${openB?.reply ?? ''}\n${replyBRetry ?? ''}`, nonce);
  const answerD = hitOf(freshD.reply, nonce);
  const sides = {
    resume: {
      projection: reading(
        openB === null ? null : openB.projectionHasNonce,
        openB === null
          ? '写半边没给出会话文件路径 ⇒ 读不出'
          : openB.projectionHasNonce === true
            ? `厂商自己投影出来的上下文里含暗号（open 打开的是 ${shortenPath(fileA)}）`
            : openB.projectionHasNonce === false
              ? '厂商投影里没有暗号 ⇒ 机制没接上'
              : '引擎没打出投影定式行 ⇒ 读不出',
        [`会话文件：${fileA}`, `文件里含暗号 ${fileScanB.hitLines} 行（${fileScanB.bytes} 字节）`, `投影消息数：${String(openB?.dump?.projectedMessageCount ?? '(未读到)')}`],
      ),
      reply: reading(
        openB === null || broken.length > 0 ? null : answerB.ok,
        answerB.ok ? `答出暗号（命中方式 ${answerB.mode}）` : `没答出暗号${replyBRetry === null ? '' : '（含重问一次）'}`,
        [`问回原文：${ASK}`, `第一次答复：${JSON.stringify(String(openB?.reply ?? '').slice(0, 200))}`, `重问答复：${JSON.stringify(replyBRetry ?? '(未重问)')}`],
      ),
      question: ASK,
      notRun: null,
    },
    control: {
      projection: reading(
        broken.length > 0 ? null : freshD.projectionHasNonce,
        `这一轮新建的会话（${shortenPath(freshD.sessionFile)}）投影里${freshD.projectionHasNonce === true ? '**含**' : '不含'}暗号，文件里含 ${fileScanD.hitLines} 行`,
        [`会话文件：${String(freshD.sessionFile)}`, `投影消息数：${String(freshD.dump?.projectedMessageCount ?? '(未读到)')}`],
      ),
      reply: reading(
        broken.length > 0 ? null : answerD.ok,
        answerD.ok ? `阴性对照竟然答出暗号（命中方式 ${answerD.mode}）⇒ 泄漏` : '答不出',
        [`答复：${JSON.stringify(freshD.reply.slice(0, 200))}`],
      ),
      question: ASK,
      notRun: null,
    },
  };

  if (broken.length > 0) {
    for (const side of [sides.resume, sides.control]) {
      side.projection = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, side.projection.evidence);
      side.reply = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, side.reply.evidence);
    }
  }

  return {
    key: 'pi',
    family: 'pi',
    variant: 'pi（@earendil-works/pi-coding-agent；SessionManager.open，落会话文件路径）',
    engine: ENGINE,
    nonce,
    dirs: { root, cwd, cfg1, dir1, cfg2, dir2 },
    env: { AIEVAL_PROBE_PI_MODEL: process.env.AIEVAL_PROBE_PI_MODEL ?? process.env.AIEVAL_PROBE_CC_MODEL ?? '(未设)' },
    sides,
    fences,
    broken,
    raw,
    verdict: gateOf({ resume: sides.resume, control: sides.control, broken }),
  };
}

/** `node pi-arm.mjs` 直接跑这一家。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('pi-arm.mjs')) {
  note(`引擎 = ${ENGINE}`);
  await runArmCli({ family: 'pi', run: runPiArm });
}
