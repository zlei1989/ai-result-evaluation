#!/usr/bin/env node
/**
 * 跨家「暗号回读」驱动器的 **codex 支**：把现成的 `codex-session-resume.mjs` 当引擎，
 * 按 `--role=` 单跑接口把「正面 / 阴性对照 / 围栏」三档跑齐。
 *
 * 续接形状：`thread/resume{ threadId }` → `turn/start`。要落的键**只有 `threadId`**（与 cwd 无关），
 * 会话产物落在 **`$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-<ts>-<threadId>.jsonl`**。
 * 每一档都是**独立的 node 进程 + 独立的 app-server 进程**：同一个 app-server 进程里线程本来就活在内存里，
 * 证明不了「跨进程」。
 *
 * 两条**互相独立**的投影通道（都不经过模型）：
 *  · `thread/read{ includeTurns: true }`——厂商自己把历史读回来的那份投影里有没有暗号；
 *  · 直接读 `$CODEX_HOME` 下的 rollout 转录文件（按 `threadId` 认领是**哪条**线程的）。
 * 两者只要有一条命中就算机制成立，两条都记进读数（不一致本身也是读数）。
 *
 * 三档：
 *  · **正面**：进程 A 起线程记住随机暗号 → **新进程 + 新 app-server** 只带 `thread/resume` 问回来；
 *  · **反面（阴性对照）**：同样的 `$CODEX_HOME` 与 cwd、走 `thread/start`（不接历史）问回来；
 *  · **围栏**：① 换一个空的 `$CODEX_HOME` 再 `thread/resume` 同一个 id ⇒ 必须被拒（隔离的另一半）；
 *    ② 线程 idle 时拿**已完成的** turn id 去 `turn/steer` ⇒ 必须被拒（`expectedTurnId` 必须在途）。
 *
 * 用法（凭据只从环境变量读：
 * `AIEVAL_PROBE_GATEWAY_API_KEY` / `AIEVAL_PROBE_GATEWAY_BASE_URL` / `AIEVAL_PROBE_CODEX_MODEL`）：
 *   set -a; eval "$(grep -E '^export AIEVAL_PROBE' ~/.zshrc)"; set +a
 *   node packages/server/agents/probe/v11/resume-readback/codex-arm.mjs
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
  scanTree,
} from './criteria.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 引擎：既有的单家探针（**只加不改**）。 */
const ENGINE = join(HERE, '..', 'codex-session-resume.mjs');

/** 问回的原文（与引擎那一档逐字一致）。 */
const ASK = '刚才我让你记的那串暗号是什么？只回复暗号本身（形如 AIEVAL-XXXXXXXX）；如果你没有这段记忆，就只回复「不知道」。不要调用任何工具。';

/** 子进程 stderr 的末行（读数里要留下「跑不起来」的原文）。 */
function tail(text) {
  const rows = String(text ?? '').trim().split('\n').filter((one) => one !== '');
  return rows.length === 0 ? '' : rows[rows.length - 1].slice(0, 200);
}

/**
 * 跑 codex 一家的两面 + 两条围栏。
 *
 * @param input.nonce 随机暗号。
 * @param input.timeoutMs 单个 role 进程的墙钟上限（一个 role = 一个 node + 一个 app-server + 最多一轮模型）。
 */
export async function runCodexArm({ nonce, timeoutMs = 420_000 }) {
  const root = mkdtempSync(join(tmpdir(), 'aieval-readback-codex-'));
  const home = join(root, 'codex-home');
  const otherHome = join(root, 'codex-home-other');
  const cwd = join(root, 'workspace');
  for (const dir of [home, otherHome, cwd]) mkdirSync(dir, { recursive: true });

  const broken = [];
  const raw = {};
  /**
   * 跑一个 role 并立刻读它的读数（`--label` 由我们给 ⇒ 读数文件名可预期、互不覆盖）。
   *
   * `carrier` 决定跑不成时算不算「本家跑不起来」：载体跑不成 ⇒ 读数作废；围栏跑不成只让那条围栏读不出。
   */
  const role = (label, args, { carrier = true } = {}) => {
    const run = runProbe({ script: ENGINE, args, timeoutMs });
    if (run.stdout !== '') process.stdout.write(run.stdout);
    if (run.exit !== 0 && run.stderr !== '') process.stderr.write(run.stderr);
    const dump = readProbeDump(`codex-session-resume-${label}`);
    const reasons = [];
    if (run.timedOut) reasons.push(`${label} 到 ${timeoutMs}ms 上限被杀`);
    if (run.spawnError !== null) reasons.push(`${label} 起不来：${run.spawnError}`);
    if (run.exit !== 0) reasons.push(`${label} 退出码 ${String(run.exit)}${run.stderr === '' ? '' : `（stderr 末行：${tail(run.stderr)}）`}`);
    if (dump === null) reasons.push(`${label} 没落读数`);
    else if ((dump.fatal ?? null) !== null) reasons.push(`${label} fatal：${String(dump.fatal).slice(0, 200)}`);
    if (carrier) broken.push(...reasons);
    return {
      label,
      run,
      dump,
      health: reasons,
      threadId: pick(run.stdout, 'THREAD_ID'),
      turnId: pick(run.stdout, 'TURN_ID'),
      reply: pick(run.stdout, 'REPLY'),
    };
  };

  // ① 正面写半边：新线程、记住暗号
  const write = role('t9c-codex-write', [`--role=write`, `--label=t9c-codex-write`, `--home=${home}`, `--cwd=${cwd}`, `--nonce=${nonce}`]);
  const idA = write.threadId;
  raw.write = { exit: write.run.exit, ms: write.run.ms, threadId: idA, turnId: write.turnId, reply: write.reply };
  if (broken.length === 0 && idA === '') broken.push('write 没给出 threadId');

  // 投影通道之一：厂商自己的读回接口（零模型）
  const inspect = idA === ''
    ? null
    : role('t9c-codex-inspect', [`--role=inspect`, `--label=t9c-codex-inspect`, `--home=${home}`, `--cwd=${cwd}`, `--thread-id=${idA}`, `--nonce=${nonce}`]);
  raw.inspect = inspect === null ? null : {
    exit: inspect.run.exit,
    turns: inspect.dump?.read?.turns ?? null,
    turnItemTypes: inspect.dump?.read?.turnItemTypes ?? null,
    nonceFoundInTurns: inspect.dump?.nonceFoundInTurns ?? null,
    listContainsTarget: inspect.dump?.list?.containsTarget ?? null,
  };

  // 投影通道之二：盘上的 rollout 转录（零模型，谁都能读）
  const rolloutsA = scanTree(join(home, 'sessions'), { nonce, extensions: ['.jsonl'] });
  const rolloutHitFor = (tree, threadId) => (threadId === '' ? null : tree.hits.filter((one) => one.rel.includes(threadId)));

  // ② 正面：新进程 + 新 app-server，只带 thread/resume 问回来
  const resume = idA === ''
    ? null
    : role('t9c-codex-read-resume', [`--role=read`, `--label=t9c-codex-read-resume`, `--home=${home}`, `--cwd=${cwd}`, `--thread-id=${idA}`, `--nonce=${nonce}`]);
  const refusalOnResume = resume?.dump?.resumeError ?? null;
  raw.resume = resume === null ? null : {
    exit: resume.run.exit,
    ms: resume.run.ms,
    threadId: resume.threadId,
    reply: resume.reply,
    mode: resume.dump?.mode ?? null,
    resumeError: refusalOnResume,
    resumedTurns: resume.dump?.resumed?.turns ?? null,
    resumedNonceInResponse: resume.dump?.resumedNonceInResponse ?? null,
    steerIdle: resume.dump?.steerIdle ?? null,
  };
  // resume 走通但那一轮没跑成（例如轮次报错）才算「跑不起来」；resume **被拒**是读数，不是跑不起来
  if (resume !== null && refusalOnResume === null && (resume.dump?.turnStatus ?? null) === null) {
    broken.push(`read-resume 的轮次没收场（turnError=${String(resume.dump?.turnError ?? '(无)').slice(0, 160)}）`);
  }

  // 模型抖了一次就重问一次（新进程、同 thread/resume）
  let replyRetry = null;
  if (broken.length === 0 && refusalOnResume === null && resume !== null && !hitOf(resume.reply, nonce).ok) {
    const retry = role('t9c-codex-read-resume-retry', ['--role=read', '--label=t9c-codex-read-resume-retry', `--home=${home}`, `--cwd=${cwd}`, `--thread-id=${idA}`, `--nonce=${nonce}`], { carrier: false });
    replyRetry = retry.health.length === 0 ? retry.reply : null;
    raw.resumeRetry = { reply: retry.reply, health: retry.health };
    note(`正面答复落空 ⇒ 按口径重问一次：${JSON.stringify(replyRetry ?? '(重问也没跑成)')}`);
  }

  // ③ 反面（阴性对照）：同 home 同 cwd、走 thread/start
  const control = role('t9c-codex-control', [`--role=read`, `--label=t9c-codex-control`, `--home=${home}`, `--cwd=${cwd}`, `--nonce=${nonce}`]);
  const idD = control.threadId;
  const inspectControl = idD === ''
    ? null
    : role('t9c-codex-inspect-control', [`--role=inspect`, `--label=t9c-codex-inspect-control`, `--home=${home}`, `--cwd=${cwd}`, `--thread-id=${idD}`, `--nonce=${nonce}`]);
  const rolloutsD = scanTree(join(home, 'sessions'), { nonce, extensions: ['.jsonl'] });
  raw.control = {
    exit: control.run.exit,
    ms: control.run.ms,
    threadId: idD,
    reply: control.reply,
    mode: control.dump?.mode ?? null,
    turnStatus: control.dump?.turnStatus ?? null,
    nonceFoundInTurns: inspectControl?.dump?.nonceFoundInTurns ?? null,
    rolloutHits: rolloutHitFor(rolloutsD, idD)?.map((one) => one.rel) ?? null,
  };
  if (inspectControl !== null && (inspectControl.dump?.read?.turns ?? null) === null) {
    broken.push('inspect-control 没把对照线程的历史读回来');
  }

  // ④ 围栏
  const fenceOtherHome = idA === ''
    ? null
    : role('t9c-codex-fence-other-home', ['--role=read', '--label=t9c-codex-fence-other-home', `--home=${otherHome}`, `--cwd=${cwd}`, `--thread-id=${idA}`, `--nonce=${nonce}`], { carrier: false });
  const steerIdle = resume?.dump?.steerIdle ?? null;
  const fences = [
    {
      name: '围栏：换一个空的 $CODEX_HOME',
      expected: '被拒（thread/resume 找不到那条线程 ⇒ 不许静默新建空线程）',
      ok: fenceOtherHome !== null && fenceOtherHome.health.length === 0
        && (fenceOtherHome.dump?.resumeError ?? null) !== null
        && !hitOf(fenceOtherHome.reply, nonce).ok,
      detail: fenceOtherHome === null
        ? '这一格没跑（写半边没给出 threadId）'
        : (fenceOtherHome.dump?.resumeError ?? null) !== null
          ? `被拒原文：${String(fenceOtherHome.dump.resumeError).slice(0, 200)}`
          : `竟然接上了（答复 ${JSON.stringify(fenceOtherHome.reply.slice(0, 80))}）⇒ 换 home 也算同一条线程`,
      evidence: [otherHome, `thread_id = ${idA}`],
    },
    {
      name: '围栏：idle 时拿已完成的 turn id 去 turn/steer',
      expected: '被拒（expectedTurnId 必须是当前在途那一轮）',
      ok: steerIdle !== null && steerIdle.ok === false && String(steerIdle.error ?? '') !== '',
      detail: steerIdle === null
        ? '这一格没跑（正面 read 没跑到那一步）'
        : steerIdle.ok === false
          ? `被拒原文：${String(steerIdle.error).slice(0, 200)}`
          : '竟然接受了一个已完成 turn 的 steer',
      evidence: [`turn_id = ${resume?.turnId ?? '(无)'}`],
    },
  ];

  // ⑤ 两条并行判据
  const rolloutHitsA = rolloutHitFor(rolloutsA, idA);
  const projectionChannels = {
    vendorThreadRead: inspect?.dump?.nonceFoundInTurns ?? null,
    resumeResponseTurns: resume?.dump?.resumedNonceInResponse ?? null,
    rolloutFile: rolloutHitsA === null ? null : rolloutHitsA.length > 0,
  };
  const answerB = hitOf(`${resume?.reply ?? ''}\n${replyRetry ?? ''}`, nonce);
  const answerD = hitOf(control.reply, nonce);
  const projectionOkOf = (channel) => {
    const values = Object.values(channel).filter((one) => one !== null && one !== undefined);
    return values.length === 0 ? null : values.some((one) => one === true);
  };
  const sides = {
    resume: {
      projection: reading(
        broken.length > 0
          ? null
          : refusalOnResume === null
            ? projectionOkOf(projectionChannels)
            : false,
        refusalOnResume === null
          ? `三条投影通道（厂商读回接口 / resume 响应里的 turns / 盘上 rollout 文件）：${JSON.stringify(projectionChannels)}`
          : `resume 被厂商拒绝 ⇒ 接不回来（原文：${String(refusalOnResume).slice(0, 200)}）；历史本身在盘上：${JSON.stringify(projectionChannels)}`,
        [
          `rollout 命中：${JSON.stringify((rolloutHitsA ?? []).map((one) => `${one.rel}（含暗号 ${one.hitLines} 行）`))}`,
          `thread_id A = ${idA}`,
          `含暗号的 rollout 文件数：${rolloutsA.hits.length}`,
        ],
      ),
      reply: reading(
        broken.length > 0 ? null : refusalOnResume === null ? answerB.ok : false,
        refusalOnResume !== null
          ? `resume 被拒 ⇒ 这一轮压根没问成（不是「模型答不出」）：${String(refusalOnResume).slice(0, 200)}`
          : answerB.ok
            ? `答出暗号（命中方式 ${answerB.mode}）`
            : `没答出暗号${replyRetry === null ? '' : '（含重问一次）'}`,
        [`问回原文：${ASK}`, `第一次答复：${JSON.stringify(String(resume?.reply ?? '').slice(0, 200))}`, `重问答复：${JSON.stringify(replyRetry ?? '(未重问)')}`],
      ),
      question: ASK,
      notRun: null,
    },
    control: {
      projection: reading(
        broken.length === 0 ? projectionOkOf({
          vendorThreadRead: inspectControl?.dump?.nonceFoundInTurns ?? null,
          rolloutFile: rolloutHitFor(rolloutsD, idD) === null ? null : (rolloutHitFor(rolloutsD, idD) ?? []).length > 0,
        }) : null,
        `对照线程（thread_id ${idD === '' ? '(没读出来)' : idD}）的通道：厂商读回 = ${String(inspectControl?.dump?.nonceFoundInTurns ?? '(未读到)')}｜身份与 A ${idD !== idA ? '不同' : '**相同**'}`,
        [`thread_id D = ${idD}`, `对照线程的 rollout：${JSON.stringify(rolloutHitFor(rolloutsD, idD)?.map((one) => one.rel) ?? [])}`],
      ),
      reply: reading(
        broken.length === 0 ? answerD.ok : null,
        answerD.ok ? `阴性对照竟然答出暗号（命中方式 ${answerD.mode}）⇒ 泄漏` : '答不出',
        [`答复：${JSON.stringify(control.reply.slice(0, 200))}`],
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
    key: 'codex',
    family: 'codex',
    variant: 'codex（@openai/codex app-server；thread/resume{threadId}，转录 $CODEX_HOME/sessions/**/rollout-*.jsonl）',
    engine: ENGINE,
    nonce,
    dirs: { root, home, otherHome, cwd },
    env: { AIEVAL_PROBE_CODEX_MODEL: process.env.AIEVAL_PROBE_CODEX_MODEL ?? '(未设，引擎回落 GLM-5.3)' },
    sides,
    fences,
    broken,
    raw,
    verdict: gateOf({ resume: sides.resume, control: sides.control, broken }),
  };
}

/** `node codex-arm.mjs` 直接跑这一家。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('codex-arm.mjs')) {
  note(`引擎 = ${ENGINE}`);
  await runArmCli({ family: 'codex', run: runCodexArm });
}
