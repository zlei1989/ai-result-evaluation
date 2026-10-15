#!/usr/bin/env node
/**
 * 跨家「暗号回读」驱动器的 **dsh 支**：两次可能都跑——**本仓 pin 那一版**与**仓外装的新版**。
 *
 * 为什么这一家要分两支：`session/resume` 这条官方 wire 方法**自 `0.2.1-alpha.3` 起才有**，
 * 本仓 pin 的客户端是 `0.2.1-alpha.3` ⇒ 正面那一格**跑得起来**；装到 `0.2.0-rc.2` 及更早时才只能反断言。
 * 处置与本仓的既有口径一致：
 *  · **不给 `--sdk-dir`** ⇒ 跑 `dsh-session-resume.mjs`（本仓装的那版），正面记 **`not-runnable`**，
 *    并以**反断言**收场：同一个 `sessionId` 在新进程里**必须带不回来**（两种形状都要拒），
 *    阴性对照（新 id、新进程）**必须答不出**；
 *  · **给了 `--sdk-dir`（或 `AIEVAL_PROBE_DSH_SDK_DIR`）** ⇒ 跑 `dsh-session-resume-alpha3.mjs`，
 *    那一支是完整的「正面 / 阴性对照 / 围栏」三档（客户端从那个独立安装目录解析，本仓 lockfile 一个字节不动）。
 *
 * 两支的投影判据都是**盘上的会话日志**：`$DSH_HOME/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd`
 * ——拼接的 zstd 帧，必须**按魔数切帧逐帧解**（Node 的 `zstdDecompressSync` 只解第一帧就返回，
 * 一份真实日志只会解出 session header，看起来像「这个会话什么都没记」）。逻辑复用 `lib/dsh-session-log.mjs`。
 *
 * ⚠️ 两支都不写 `profiles/sdk/cordis.patch.yml`（overlay 必须是顶层 YAML 数组，写出来只剩一行注释 ⇒ boot 直接失败）。
 * ⚠️ 凭据：模型侧走 `~/.dsh/.credentials.yaml`（引擎自己的 `readDeepSeekKey`），不打印、不落盘。
 *
 * 用法：
 *   node packages/server/agents/probe/v11/resume-readback/dsh-arm.mjs
 *   node …/dsh-arm.mjs --sdk-dir=/tmp/<仓外装的那份>
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSessionLog } from '../lib/dsh-session-log.mjs';
import {
  flagOf,
  gateOf,
  hitOf,
  note,
  pick,
  readProbeDump,
  reading,
  runArmCli,
  runProbe,
} from './criteria.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** pin 那一版的引擎（本仓装 `0.2.1-alpha.3`）。 */
const ENGINE_PINNED = join(HERE, '..', 'dsh-session-resume.mjs');
/** 新版客户端的引擎（`session/resume` 自 `0.2.1-alpha.3` 起存在）。 */
const ENGINE_ALPHA3 = join(HERE, '..', 'dsh-session-resume-alpha3.mjs');

/** 引擎写读数的定名规则。 */
const dumpOfPinned = (role) => `dsh-session-resume-reading-${role}`;
const dumpOfAlpha3 = (role) => `dsh-session-resume-alpha3-${role}`;

/** 派发器「不认得这个名字」的原文（认得的方法会走到业务分支，错误形状完全不同）。 */
const UNKNOWN_METHOD_MARK = 'unknown DeepSeek Harness SDK runtime method';

/** 写 / 问的提示词：**暗号绝不紧邻中文标点**（拼接用模板串、传参走 argv 数组，不经过 shell）。 */
const writePrompt = (nonce) => `请记住这串暗号：${nonce} 。只回复「记住了」三个字，不要复述暗号。`;
const ASK = '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。';

/** 子进程 stderr 的末行（读数里要留下「跑不起来」的原文）。 */
function tail(text) {
  const rows = String(text ?? '').trim().split('\n').filter((one) => one !== '');
  return rows.length === 0 ? '' : rows[rows.length - 1].slice(0, 200);
}

/** 造一个只含安全字符的会话 id：这样 `encodeSegment(id) === id`，目录名可以直接当 id 用。 */
function mintSessionId(tag) {
  return `t9c-${tag}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 找一个会话 id 的日志文件。目录形状是 `<home>/sessions/<projectKey>/<encodeSegment(id)>/session.v4.jsonl.zstd`；
 * `projectKey`（cwd 的转义）**有损**、不自己算，只在它下面一层的目录名上认 id
 * （id 由本模块铸、只含 `[A-Za-z0-9._-]` ⇒ 转义是恒等）。
 *
 * @param home `DSH_HOME`。
 * @param sessionId 会话 id。
 * @returns 日志文件路径表（同一 id 正常只有一份）。
 */
function findSessionLogs(home, sessionId) {
  const root = join(home, 'sessions');
  if (sessionId === '' || !existsSync(root)) return [];
  const found = [];
  let projects = [];
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((one) => one.isDirectory());
  } catch {
    return [];
  }
  for (const project of projects) {
    const dir = join(root, project.name, sessionId);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/^session\.v\d+\.jsonl\.zstd$/.test(name)) found.push(join(dir, name));
    }
  }
  return found;
}

/**
 * 读一份会话日志的机制层读数（**不花额度**）：帧数、解压后字节、记录数、暗号出现次数。
 *
 * @param home `DSH_HOME`。
 * @param sessionId 会话 id。
 * @param nonce 暗号。
 */
function logReading(home, sessionId, nonce) {
  const files = findSessionLogs(home, sessionId);
  if (files.length === 0) return { found: false, sessionId, nonceHits: 0, bytes: 0 };
  const path = files[0];
  try {
    const { frames, bytes, text, records } = readSessionLog(path);
    return {
      found: true,
      sessionId,
      path,
      frames,
      bytes,
      records: records.length,
      nonceHits: nonce === '' ? 0 : text.split(nonce).length - 1,
      // 转录里确实出现暗号的那一小段原文（暗号替换成 <NONCE>，免得读数被暗号刷屏）
      snippet: text.includes(nonce) ? text.split(nonce).join('<NONCE>').slice(0, 200) : null,
    };
  } catch (caught) {
    return { found: true, sessionId, path, error: String(caught?.message ?? caught).slice(0, 200), nonceHits: 0, bytes: 0 };
  }
}

/** 把 `text` 字段当 JSON 解一次（pin 那一版把 role 的返回值整份塞进 `text`）。 */
function jsonOf(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

/**
 * **本仓 pin（`0.2.1-alpha.3`）**那一支：正面跑得起来（wire 上有 `session/resume`）。
 *
 * 三个反断言，缺一条结论就不成立：
 *  ① wire 全表里 `session/resume` 必须回 `unknown … method`（机制层：这条方法在这版上不存在）；
 *  ② 同一个 `sessionId` 在**新进程**里复用必须被拒（两种形状各一次：`harness.run` 与 `client.prompt`），
 *     不许静默新建一个空会话把「带不回来」伪装成「答不出」；
 *  ③ 阴性对照（**新 id、新进程**）必须答不出。
 *
 * 顺带记一条机制事实：那个 id 的**会话日志确实在盘上、且含暗号**——所以「带不回来」不是「没落盘」，
 * 缺的是**接续接面**。
 */
export async function runDshPinnedArm({ nonce, timeoutMs = 300_000 }) {
  const home = mkdtempSync(join(tmpdir(), 'aieval-readback-dsh-pin-home-'));
  const broken = [];
  const raw = {};

  const role = (label, args, { carrier = true } = {}) => {
    const run = runProbe({ script: ENGINE_PINNED, args, timeoutMs });
    if (run.stdout !== '') process.stdout.write(run.stdout);
    if (run.exit !== 0 && run.stderr !== '') process.stderr.write(run.stderr);
    const dump = readProbeDump(label);
    const reasons = [];
    if (run.timedOut) reasons.push(`${label} 到 ${timeoutMs}ms 上限被杀`);
    if (run.spawnError !== null) reasons.push(`${label} 起不来：${run.spawnError}`);
    if (run.exit !== 0) reasons.push(`${label} 退出码 ${String(run.exit)}${run.stderr === '' ? '' : `（stderr 末行：${tail(run.stderr)}）`}`);
    if (dump === null) reasons.push(`${label} 没落读数`);
    if (carrier) broken.push(...reasons);
    return { label, run, dump, health: reasons };
  };

  // ① wire 全表：`session/resume` 在不在（零模型、零成本：不认识的名字在派发器 default 分支就结束）
  const idA = mintSessionId('dsh-write');
  const wire = role(dumpOfPinned('wire'), ['--role=wire', `--home=${home}`, `--session=${idA}`, `--nonce=${nonce}`]);
  const wireTable = jsonOf(wire.dump?.text ?? '') ?? [];
  const wireResume = Array.isArray(wireTable) ? wireTable.find((one) => one?.method === 'session/resume') ?? null : null;
  const wireRecognized = wireResume === null ? null : wireResume.ok === true || !String(wireResume.message ?? '').includes(UNKNOWN_METHOD_MARK);
  raw.wire = { exit: wire.run.exit, ms: wire.run.ms, count: wireTable.length, sessionResume: wireResume };

  // ② 写半边：新 id 让模型记住暗号（这一格是真跑得成的）
  const write = role(dumpOfPinned('write'), ['--role=write', `--home=${home}`, `--session=${idA}`, `--nonce=${nonce}`, `--prompt=${writePrompt(nonce)}`]);
  const writeResult = jsonOf(write.dump?.text ?? '');
  raw.write = {
    exit: write.run.exit,
    ms: write.run.ms,
    sessionId: writeResult?.sessionId ?? idA,
    finalResponse: writeResult?.finalResponse ?? null,
    error: write.dump?.error ?? null,
  };
  if (write.dump?.error != null) broken.push(`write 抛错：${String(write.dump.error.message ?? write.dump.error).slice(0, 200)}`);
  if ((writeResult?.finalResponse ?? null) === null) broken.push('write 没给出 finalResponse');

  // 机制事实：转录在盘上、且含暗号（「带不回来」不是「没落盘」）
  const logWritten = logReading(home, idA, nonce);
  raw.sessionLog = logWritten;

  // ③ 反断言（形状一）：同一个 id 走 `harness.run` ⇒ 必须被拒
  const reuseHarness = role(dumpOfPinned('write'), ['--role=write', `--home=${home}`, `--session=${idA}`, `--nonce=${nonce}`, `--prompt=${ASK}`], { carrier: false });
  const reuseHarnessError = reuseHarness.dump?.error == null ? null : String(reuseHarness.dump.error.message ?? reuseHarness.dump.error);
  const reuseHarnessAnswer = jsonOf(reuseHarness.dump?.text ?? '')?.finalResponse ?? null;

  // ④ 反断言（形状二）：同一个 id 走低层 `client.prompt`（文档写「未知 id 会新建」）⇒ 必须同样被拒
  const reusePrompt = role(dumpOfPinned('read'), ['--role=read', `--home=${home}`, `--session=${idA}`, `--nonce=${nonce}`, `--prompt=${ASK}`], { carrier: false });
  const reusePromptError = reusePrompt.dump?.error == null ? null : String(reusePrompt.dump.error.message ?? reusePrompt.dump.error);
  const reusePromptText = reusePrompt.dump?.text ?? null;
  raw.reuse = {
    harness: { exit: reuseHarness.run.exit, error: reuseHarnessError, answer: reuseHarnessAnswer },
    clientPrompt: { exit: reusePrompt.run.exit, error: reusePromptError, text: reusePromptText },
  };

  // ⑤ 阴性对照：**新 id、新进程**（不指向任何已有会话）⇒ 必须答不出
  const idC = mintSessionId('dsh-control');
  const control = role(dumpOfPinned('read'), ['--role=read', `--home=${home}`, `--session=${idC}`, `--nonce=${nonce}`, `--prompt=${ASK}`]);
  const controlText = control.dump?.error == null ? String(control.dump?.text ?? '') : '';
  if (control.dump?.error != null) broken.push(`对照抛错：${String(control.dump.error.message ?? control.dump.error).slice(0, 200)}`);
  const logControl = logReading(home, idC, nonce);
  raw.control = { exit: control.run.exit, ms: control.run.ms, sessionId: idC, text: controlText, log: logControl };

  const answerC = hitOf(controlText, nonce);
  const fences = [
    {
      name: '反断言：同一 id 在新进程里复用（harness.run 形状）',
      expected: '被拒（本仓 pin 上没有 session/resume ⇒ 不许静默新建空会话）',
      ok: reuseHarnessError !== null && !hitOf(reuseHarnessAnswer ?? '', nonce).ok,
      detail: reuseHarnessError === null
        ? `**没被拒**（答复 ${JSON.stringify(String(reuseHarnessAnswer ?? '').slice(0, 80))}）`
        : `被拒原文：${reuseHarnessError.slice(0, 200)}`,
      evidence: [`session_id = ${idA}`, `DSH_HOME = ${home}`],
    },
    {
      name: '反断言：同一 id 在新进程里复用（client.prompt 形状）',
      expected: '被拒（这一形状的文档写「未知 id 会新建」⇒ 最容易变成静默空会话）',
      ok: reusePromptError !== null && !hitOf(reusePromptText ?? '', nonce).ok,
      detail: reusePromptError === null
        ? `**没被拒**（text ${JSON.stringify(String(reusePromptText ?? '').slice(0, 120))}）`
        : `被拒原文：${reusePromptError.slice(0, 200)}`,
      evidence: [`session_id = ${idA}`],
    },
    {
      name: '反断言：wire 全表里 session/resume 认不认得',
      expected: `不认得（回 ${UNKNOWN_METHOD_MARK}）`,
      ok: wireRecognized === false,
      detail: wireResume === null
        ? `wire 全表里没有这一条（表长 ${wireTable.length}）`
        : `原文：${String(wireResume.message ?? JSON.stringify(wireResume)).slice(0, 200)}`,
      evidence: [`本仓 pin 的客户端 = @deepseek-ai/dsh-sdk-client 0.2.1-alpha.3`],
    },
    {
      name: '读数：那个 id 的会话日志在不在盘上、含不含暗号',
      expected: '在盘上且含暗号（⇒「带不回来」不是「没落盘」）',
      ok: logWritten.found === true && logWritten.nonceHits > 0,
      detail: logWritten.found
        ? `${logWritten.path}｜帧 ${logWritten.frames}｜解压 ${logWritten.bytes} 字节｜记录 ${logWritten.records} 条｜暗号 ${logWritten.nonceHits} 次`
        : '盘上没找到这个 id 的会话日志',
      evidence: [logWritten.snippet ?? '(无原文)'],
    },
  ];
  const sides = {
    resume: {
      projection: reading(null, `正面这一格跑不起来：${notRunnableReason(wireResume, wireRecognized)}`, [
        `wire 表长 ${wireTable.length}｜session/resume = ${JSON.stringify(wireResume)}`,
        `会话日志：${logWritten.path ?? '(不在)'}`,
      ]),
      reply: reading(null, `正面这一格跑不起来（同上）；反断言见围栏：两种复用形状都必须被拒`, [
        `反断言原文：${String(reuseHarnessError ?? reusePromptError ?? '(无)').slice(0, 200)}`,
      ]),
      question: ASK,
      notRun: notRunnableReason(wireResume, wireRecognized),
    },
    control: {
      projection: reading(
        broken.length === 0 ? (logControl.found ? logControl.nonceHits > 0 : null) : null,
        logControl.found
          ? `对照那一轮新建的会话日志（${logControl.path}）${logControl.nonceHits > 0 ? `**含**暗号 ${logControl.nonceHits} 次` : '不含暗号'}`
          : '对照那一轮的会话日志不在盘上 ⇒ 读不出',
        [`session_id C = ${idC}`],
      ),
      reply: reading(
        broken.length === 0 ? answerC.ok : null,
        answerC.ok ? `阴性对照竟然答出暗号（命中方式 ${answerC.mode}）⇒ 泄漏` : '答不出',
        [`答复：${JSON.stringify(controlText.slice(0, 200))}`],
      ),
      question: ASK,
      notRun: null,
    },
  };

  if (broken.length > 0) {
    sides.control.projection = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, sides.control.projection.evidence);
    sides.control.reply = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, sides.control.reply.evidence);
  }

  return {
    key: 'dsh-pinned',
    family: 'dsh(pin)',
    variant: 'dsh @0.2.1-alpha.3（**本仓 pin**；正面跑得起来）',
    engine: ENGINE_PINNED,
    nonce,
    dirs: { home },
    env: { AIEVAL_PROBE_DSH_MODEL: process.env.AIEVAL_PROBE_DSH_MODEL ?? '(未设，引擎回落 deepseek-flash)' },
    sides,
    fences,
    broken,
    raw,
    verdict: gateOf({ resume: sides.resume, control: sides.control, broken }),
  };
}

/** 正面那一格为什么跑不起来（版本门）—— 原文与版本事实一起给，别让人读成「不支持」。 */
function notRunnableReason(wireResume, wireRecognized) {
  if (wireRecognized === false) {
    return `本仓 pin 的 @deepseek-ai/dsh-sdk-client 0.2.1-alpha.3 的 wire 上不认 session/resume（原文：${String(wireResume?.message ?? '').slice(0, 160)}）⇒ 这一支的正面跑不起来（解析到的客户端比 0.2.1-alpha.3 更旧）`;
  }
  return '本仓 pin 的客户端上 session/resume 的机制读数没读出来（wire 表没跑成或形状变了）⇒ 正面那一格无从判定';
}

/**
 * **仓外新版（`0.2.1-alpha.3` 起）**那一支：完整的正面 / 阴性对照 / 两条围栏。
 *
 * 投影判据为什么读**盘上会话日志**而不是通知流：resume 之后订阅到的通知流**不回放历史**（只有本轮事件），
 * 拿通知流当恢复证据会得到假红。所以机制判据是三条事实的合取：
 *  ① `session/resume` **没被拒**（拒绝原文为空）；
 *  ② 新的一轮追加写进了**同一条**会话日志（同一 id、文件变大）；
 *  ③ 那份日志里含上一轮的暗号。
 *
 * @param input.sdkDir 仓外装的那份客户端的安装目录（`--sdk-dir=` / `AIEVAL_PROBE_DSH_SDK_DIR`）。
 */
export async function runDshAlpha3Arm({ nonce, sdkDir, timeoutMs = 300_000 }) {
  if (typeof sdkDir !== 'string' || sdkDir === '') throw new Error('runDshAlpha3Arm 需要 sdkDir');
  const root = mkdtempSync(join(tmpdir(), 'aieval-readback-dsh-a3-'));
  const home = join(root, 'dsh-home');
  const otherHome = join(root, 'dsh-home-other');
  const cwd = join(root, 'workspace');
  for (const dir of [home, otherHome, cwd]) mkdirSync(dir, { recursive: true });

  const broken = [];
  const raw = {};
  const sdkArgs = [`--sdk-dir=${sdkDir}`];
  const base = [`--home=${home}`, `--cwd=${cwd}`, `--nonce=${nonce}`];

  const role = (label, args, { carrier = true } = {}) => {
    const run = runProbe({ script: ENGINE_ALPHA3, args: [...sdkArgs, ...args], timeoutMs });
    if (run.stdout !== '') process.stdout.write(run.stdout);
    const dump = readProbeDump(dumpOfAlpha3(label));
    // 拒绝档（resume 被拒）也会以退出码 1 收场，那不是「跑不起来」⇒ stderr 只在**读不出**时透出
    if (dump === null && run.stderr !== '') process.stderr.write(run.stderr);
    const reasons = [];
    if (run.timedOut) reasons.push(`${label} 到 ${timeoutMs}ms 上限被杀`);
    if (run.spawnError !== null) reasons.push(`${label} 起不来：${run.spawnError}`);
    if (dump === null) reasons.push(`${label} 没落读数（退出码 ${String(run.exit)}${run.stderr === '' ? '' : `；stderr 末行 ${tail(run.stderr)}`}）`);
    if (carrier) broken.push(...reasons);
    return {
      label,
      run,
      dump,
      health: reasons,
      refusal: pick(run.stdout, 'REFUSAL'),
      reply: pick(run.stdout, 'REPLY'),
      sessionId: pick(run.stdout, 'SESSION_ID'),
    };
  };

  // ① 写半边：客户端自己铸 id、记住暗号
  const write = role('write', ['--role=write', ...base]);
  const idA = write.sessionId;
  const logA0 = idA === '' ? { found: false, nonceHits: 0, bytes: 0 } : logReading(home, idA, nonce);
  raw.write = { exit: write.run.exit, ms: write.run.ms, sessionId: idA, reply: write.reply, refusal: write.refusal, log: logA0 };
  if (write.dump?.error != null) broken.push(`write 抛错：${String(write.dump.error.message ?? write.dump.error).slice(0, 200)}`);
  if (idA === '') broken.push('write 没给出 sessionId');

  // ② 正面：新进程 + 同 DSH_HOME + session/resume 问回来
  const resume = idA === '' ? null : role('resume', ['--role=resume', ...base, `--session=${idA}`]);
  const logA1 = idA === '' ? { found: false, nonceHits: 0, bytes: 0 } : logReading(home, idA, nonce);
  const resumeRefusal = resume === null ? null : (resume.refusal !== '' ? resume.refusal : (resume.dump?.error == null ? null : String(resume.dump.error.message ?? resume.dump.error)));
  raw.resume = resume === null ? null : {
    exit: resume.run.exit,
    ms: resume.run.ms,
    sessionId: resume.sessionId,
    reply: resume.reply,
    refusal: resumeRefusal,
    log: logA1,
    nonceInNotifications: resume.dump?.nonceInNotifications ?? null,
  };

  // 模型抖了一次就重问一次（新进程、同 resume）
  let replyRetry = null;
  if (broken.length === 0 && resume !== null && resumeRefusal === null && !hitOf(resume.reply, nonce).ok) {
    const retry = role('resume', ['--role=resume', ...base, `--session=${idA}`], { carrier: false });
    replyRetry = retry.refusal === '' ? retry.reply : null;
    raw.resumeRetry = { reply: retry.reply, refusal: retry.refusal, exit: retry.run.exit };
    note(`正面答复落空 ⇒ 按口径重问一次：${JSON.stringify(replyRetry ?? '(重问被拒)')}`);
  }

  // ③ 反面（阴性对照）：同 home 同 cwd、全新会话
  const control = role('control', ['--role=control', ...base]);
  const idC = control.sessionId;
  const logC = idC === '' ? { found: false, nonceHits: 0, bytes: 0 } : logReading(home, idC, nonce);
  raw.control = { exit: control.run.exit, ms: control.run.ms, sessionId: idC, reply: control.reply, log: logC };
  if (control.dump?.error != null) broken.push(`对照抛错：${String(control.dump.error.message ?? control.dump.error).slice(0, 200)}`);

  // ④ 围栏：resume 一个从未存在的 id / 换一个空的 DSH_HOME ⇒ 都必须 not found（不许静默新建空会话）
  const unknown = role('fence-unknown', ['--role=fence-unknown', ...base, `--session=t9c-never-existed-${Date.now()}`], { carrier: false });
  const otherHomeRun = role('fence-other-home', ['--role=resume', '--home=' + otherHome, `--cwd=${cwd}`, `--nonce=${nonce}`, `--session=${idA}`], { carrier: false });
  const fences = [
    {
      name: '围栏：resume 一个从未存在的 id',
      expected: 'not found（不许静默新建一个空会话）',
      ok: unknown.refusal.includes('not found'),
      detail: `拒绝原文：${unknown.refusal.slice(0, 200) || '(没有拒绝原文)'}`,
      evidence: [],
    },
    {
      name: '围栏：换一个空的 $DSH_HOME 再 resume 同一个 id',
      expected: 'not found（隔离的另一半：持久化记录在那个 home 下）',
      ok: otherHomeRun.refusal.includes('not found'),
      detail: `拒绝原文：${otherHomeRun.refusal.slice(0, 200) || '(没有拒绝原文)'}`,
      evidence: [otherHome, `session_id = ${idA}`],
    },
  ];

  // ⑤ 两条并行判据
  const projectionOk = resumeRefusal === null && resume !== null
    ? logA0.found && logA1.found && logA1.bytes > logA0.bytes && logA1.nonceHits > 0
    : false;
  const answerB = hitOf(`${resume?.reply ?? ''}\n${replyRetry ?? ''}`, nonce);
  const answerC = hitOf(control.reply, nonce);
  const sides = {
    resume: {
      projection: reading(
        broken.length > 0 ? null : projectionOk,
        resumeRefusal !== null
          ? `session/resume 被拒 ⇒ 接不回来（原文：${String(resumeRefusal).slice(0, 200)}）`
          : `resume 没被拒；同一条会话日志 ${logA0.bytes} → ${logA1.bytes} 字节（记录 ${logA0.records} → ${logA1.records} 条），含暗号 ${logA1.nonceHits} 次；通知流里含暗号 = ${String(resume?.dump?.nonceInNotifications ?? '(未读到)')}——本轮答复里本来就带暗号，这一格分不出「回放历史」，故恢复判据只取**盘上转录 + 暗号回读**`,
        [`会话日志：${logA1.path ?? '(不在)'}`, `session_id A = ${idA}`, `本条读数时间（ms）：write ${write.run.ms} / resume ${resume?.run.ms ?? '(未跑)'}`],
      ),
      reply: reading(
        broken.length > 0 ? null : resumeRefusal === null ? answerB.ok : false,
        resumeRefusal !== null
          ? `resume 被拒 ⇒ 这一轮压根没问成（不是「模型答不出」）`
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
        broken.length === 0 ? (logC.found ? logC.nonceHits > 0 : null) : null,
        logC.found
          ? `对照那一轮新建的会话日志（${logC.path}）${logC.nonceHits > 0 ? `**含**暗号 ${logC.nonceHits} 次` : '不含暗号'}，身份与 A ${idC !== idA ? '不同' : '**相同**'}`
          : '对照那一轮的会话日志不在盘上 ⇒ 读不出',
        [`session_id C = ${idC}`],
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
    for (const side of [sides.resume, sides.control]) {
      side.projection = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, side.projection.evidence);
      side.reply = reading(null, `跑不起来 ⇒ 读不出：${broken.join('；')}`, side.reply.evidence);
    }
  }

  return {
    key: 'dsh-alpha3',
    family: 'dsh(alpha3)',
    variant: `dsh @0.2.1-alpha.3（仓外装：${sdkDir}；session/resume 是官方 wire）`,
    engine: ENGINE_ALPHA3,
    nonce,
    dirs: { root, home, otherHome, cwd, sdkDir },
    env: { AIEVAL_PROBE_DSH_MODEL: process.env.AIEVAL_PROBE_DSH_MODEL ?? '(未设，引擎回落 deepseek-flash)' },
    sides,
    fences,
    broken,
    raw,
    verdict: gateOf({ resume: sides.resume, control: sides.control, broken }),
  };
}

/**
 * `node dsh-arm.mjs` 直接跑这一家：永远跑 pin 那一支；给了 `--sdk-dir`（或环境变量）再跑新版那一支。
 * 单臂模式只落 pin 那一支的读数（新版那一支由驱动器按 family 落盘）。
 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('dsh-arm.mjs')) {
  const sdkDir = flagOf('sdk-dir', process.env.AIEVAL_PROBE_DSH_SDK_DIR ?? null);
  note(`引擎（pin）= ${ENGINE_PINNED}`);
  note(sdkDir === null ? '没给 --sdk-dir ⇒ 只跑本仓 pin 那一支（正面只能反断言）' : `新版引擎 = ${ENGINE_ALPHA3}（sdk-dir=${sdkDir}）`);
  await runArmCli({
    family: 'dsh-pinned',
    run: async ({ nonce, timeoutMs }) => {
      const pinned = await runDshPinnedArm({ nonce, timeoutMs });
      if (sdkDir !== null) await runDshAlpha3Arm({ nonce, timeoutMs, sdkDir });
      return pinned;
    },
  });
}
