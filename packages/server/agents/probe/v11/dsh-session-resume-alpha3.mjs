/**
 * v11 探针（**T0**）：dsh 升到 `@deepseek-ai/dsh-sdk-client@0.2.1-alpha.3` 之后，
 * 官方的 wire 方法 `session/resume` 到底能不能把历史带回来？
 *
 * 为什么另开一支而不改 `dsh-session-resume.mjs`：那支测的是**本仓 pin 的 `0.2.0-rc.2`**
 * ——那版的 wire 上只有 `initialize` / `session/prompt` / `shutdown` 三个名字，
 * 它的 `--role=wire` 档断言「14 个候选名逐条 `-32603 unknown … method`」是**对的**。
 * 本支测的是**另一个版本**（`0.2.1-alpha.3` 起才有 `session/resume`），判据完全相反：
 * 同一个 `session/resume` 应当**不再**回 `unknown … method`。
 *
 * 两条判据（缺一件结论就不成立）：
 *
 * **判据一（机制）**：`--role=wire` —— 把 14 个候选名逐个真发。
 * 判据不是「成功/失败」（这些名字大多本来就该失败），而是**派发器认不认得这个名字**：
 * 认得的名字会走到业务分支（校验入参 / 查持久化），错误原文与
 * `unknown DeepSeek Harness SDK runtime method: <name>` 完全不是一个形状。
 *
 * **判据二（端到端）**：暗号回读 + 阴性对照 + 四条围栏（driver 各起一个真 node 进程）：
 *   ① `write`：**新 id**（客户端自己铸）让模型记住随机暗号；
 *   ② `resume`：**新 node 进程** + 同 `DSH_HOME` + 同 cwd + `session/resume{id}` → `session/prompt`
 *      问暗号 —— 正面判据；同一会话里**连问两次**（单次回读会被「模型抖了一下」污染）；
 *   ③ `control`：同 `DSH_HOME` + 同 cwd 但**不 resume**（全新会话）问暗号 —— 阴性对照，
 *      它必须答不上来（否则「答对了」可能只是工作区或别处泄漏）；
 *   ④ `prompt-existing`：同一个已存 id **不走 resume** 直接 prompt —— 钉「`already exists` 没变」；
 *   ⑤ `fence-unknown`：resume 一个**从未存在**的 id —— 钉「不是静默新建一个空会话」；
 *   ⑥ `fence-double-resume`：同一进程里 resume 两次 —— 钉「已 open/opening 会被拒」，
 *      这条就是「adopt 必须在该 id 的第一条 prompt 之前」的机制依据；
 *   ⑦ `fence-cwd-mismatch`：同 id、同 `DSH_HOME`、**换一个 cwd** 再 resume —— 钉这条 wire 上
 *      **有没有** headless 那样一道 cwd 比对闸；
 *   ⑧ `fence-other-home`：同 id、同 cwd、**换一个空的 `DSH_HOME`** —— 钉「resume 读的是那条
 *      持久化记录」，这就是隔离判据的另一半（换一个行目录必须答不出）。
 *
 * 三件事必须钉住（与 `dsh-session-resume.mjs` 同口径）：两个 role 必须是**两个进程**、
 * `DSH_HOME` 必须同一个、暗号必须**随机**。
 *
 * ⚠️ 手工单跑传 `--prompt=` 时的一格假红：暗号**别紧邻中文标点**。`bash` 3.2 会把
 * `$N。` 里的变量与那个标点一起吃掉（`N=AIEVAL-X` 时 `"…$N。…"` 展开出来的是两个字节
 * `\x80\x82`），而写进转录的提示词就成了 `请记住这串暗号：\ufffd\ufffd只回复…`
 * ——模型照实答「不知道」，看起来像 resume 失败。写 `${N}。` 或把暗号挪开就没事。
 * 探针内部走 `spawnSync` 的 args 数组、不经过 shell，所以这一格只影响手工单跑。
 *
 * ⚠️ **版本与解析入口**：本探针**默认按包名 import**（= 用本仓装的那一版，即
 * `@deepseek-ai/dsh-sdk-client@0.2.1-alpha.3`）——**不带参数跑本探针就是这一格的
 * 跨进程真机判据**。要跑**别的版本**时给 `--sdk-dir=<dir>`（或 `AIEVAL_PROBE_DSH_SDK_DIR`）
 * 指向一个**独立安装目录**，那个目录由
 * `npm i --prefix <dir> @deepseek-ai/dsh-sdk-client@<版本>` 在仓库外装出来，
 * 本仓的 `package.json` / `pnpm-lock.yaml` 一个字节都不动。
 *
 * 用法：`node packages/server/agents/probe/v11/dsh-session-resume-alpha3.mjs --sdk-dir=<dir>`
 *      或 `--role=wire|write|resume|resume-twice|control|prompt-existing|fence-unknown|fence-double-resume|fence-cwd-mismatch|fence-other-home --home=<dir> --cwd=<dir> --session=<id> --nonce=<str>`
 * 产物：`probe/dumps/v11/dsh-session-resume-alpha3-*.json`。
 *
 * ⚠️ 凭据只从 `~/.dsh/.credentials.yaml` 读（`readDeepSeekKey`，与其它 dsh 探针同格），
 * 不打印、不落盘；`DSH_HOME` 一律是临时目录。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DUMP_DIR, note, writeDump } from './lib/cc-ask.mjs';
import { readDeepSeekKey, writeSettings } from '../v2/lib/dsh.mjs';

/** 与 base 的 `agent-default-model` 行一致（`provider: deepseek-official / model: deepseek-flash`）。 */
const MODEL = process.env.AIEVAL_PROBE_DSH_MODEL ?? 'deepseek-flash';

/** 单个 role 进程的墙钟上限：冷启动 harness + 一两次短问答，挂住时超时本身就是读数。 */
const RUN_TIMEOUT_MS = 240_000;

/**
 * wire 全表的候选名，与 `dsh-session-resume.mjs` **逐字同表**（判据才有可比性）。
 * `session/prompt` 故意不在表里：它认得，且发出去会真排一轮模型回合（不是零成本探测）。
 */
const WIRE_CANDIDATES = Object.freeze([
  'session/open',
  'session/resume',
  'session/adopt',
  'session/attach',
  'session/load',
  'session/get',
  'session/create',
  'session/stat',
  'session/list',
  'session/history',
  'session/follow',
  'session/close',
  'agents/resume',
  'sessions/list',
]);

/** 派发器「不认得这个名字」的原文（`dsh-sdk-jsonrpc-server/lib/index.js` 的 default 分支）。 */
const UNKNOWN_METHOD_MARK = 'unknown DeepSeek Harness SDK runtime method';

const PROMPTS = {
  write: (nonce) => `请记住这串暗号：${nonce}。只回复「记住了」三个字，不要复述暗号。`,
  ask: () => '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。',
};

function flagOf(name, fallback) {
  const hit = process.argv.find((one) => one.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/**
 * 载入要测的那一版客户端。
 *
 * 不给 `--sdk-dir` 时按**包名** import（本仓装的那版）；给了就从那个独立安装目录里解析入口。
 * 这条分支是「测另一个版本而不动本仓 lockfile」的全部机关。
 */
async function loadSdk(sdkDir) {
  if (sdkDir === null) return import('@deepseek-ai/dsh-sdk-client');
  const entry = join(sdkDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js');
  return import(pathToFileURL(entry).href);
}

/** 造一个最小的探测工作区（dsh 要一个 cwd，且它会把这个 cwd 记进会话 header）。 */
function makeWorkspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, 'notes.txt'), 'probe workspace\n', 'utf8');
  return root;
}

/** 递归收一棵载荷里所有 `text` 字段（形状会随事件族变，深挖比写死路径稳）。 */
function textsOf(node, acc = []) {
  if (node === null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const one of node) textsOf(one, acc);
    return acc;
  }
  if (typeof node.text === 'string') acc.push(node.text);
  for (const value of Object.values(node)) textsOf(value, acc);
  return acc;
}

/**
 * 跑一个 role（= 一个真 node 进程内的一个 dsh 运行时）。
 *
 * 环境只给三样：`DSH_HOME`（隔离的临时 home）、`DEEPSEEK_API_KEY`（凭据）、继承的宿主环境。
 * `env` 是**整体替换**语义，所以必须展开宿主环境再覆盖。
 */
async function runRole({ role, sdkDir, home, cwd, sessionId, nonce, prompt }) {
  const sdk = await loadSdk(sdkDir);
  writeSettings(home, MODEL, 200000, 8192);
  const key = readDeepSeekKey();
  const notifications = [];
  const harness = new sdk.DeepSeekHarness({
    cwd,
    dshHome: home,
    processCwd: cwd,
    model: MODEL,
    initializeTimeoutMs: 60000,
    env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: key },
  });
  let subscription = null;
  let result = null;
  let error = null;
  const steps = [];
  try {
    await harness.start();
    subscription = harness.client.subscribe((notification) => {
      notifications.push(notification);
      return true;
    });
    if (role === 'wire') {
      // 逐个真发，把服务端回的原文记下来。这些名字大多不认识 ⇒ 派发在 default 分支就结束，
      // 不起会话、不调模型，所以这一档零成本。
      for (const method of WIRE_CANDIDATES) {
        try {
          const value = await harness.client.request(method, {}, 15000);
          steps.push({ method, ok: true, recognized: true, result: value });
        } catch (caught) {
          const message = String(caught?.message ?? caught).slice(0, 300);
          steps.push({
            method,
            ok: false,
            // 判据在这一格：认得的名字会走到业务分支，错误原文不是 `unknown … method`。
            recognized: !message.includes(UNKNOWN_METHOD_MARK),
            name: caught?.constructor?.name ?? typeof caught,
            code: caught?.code ?? null,
            message,
          });
        }
      }
      result = steps;
    } else if (role === 'write' || role === 'control') {
      // 不给 sessionId ⇒ 客户端自己铸一个（`session-<uuid>`），id 从 run 的返回值读回来。
      const run = await harness.run(prompt);
      result = { sessionId: run.sessionId, finalResponse: run.finalResponse };
    } else if (role === 'prompt-existing') {
      // 围栏：同一个已持久化的 id **不走 resume** 直接 prompt。
      const run = await harness.run(prompt, { sessionId });
      result = { sessionId: run.sessionId, finalResponse: run.finalResponse };
    } else if (role === 'resume' || role === 'resume-twice') {
      // 正面：`session/resume{id}` 之后再 prompt。`resumeSession` 内部先 `initialize` 再发那条 wire。
      const session = await harness.resumeSession(sessionId);
      const first = await session.run(prompt);
      const second = role === 'resume-twice' ? await session.run(prompt) : null;
      result = {
        sessionId: first.sessionId,
        finalResponse: first.finalResponse,
        answers: second === null ? [] : [first.finalResponse, second.finalResponse],
        // 顺带读数：resume 之后这一会话的**有效工作目录**是哪来的（见 cwd-mismatch 档）。
        workingDirectory: await session.getWorkingDirectory(),
      };
    } else if (role === 'fence-cwd-mismatch') {
      // 围栏：同 id、同 home、**换一个 cwd** 再 resume（headless 那支会拒；这条 wire 未实测）。
      const session = await harness.resumeSession(sessionId);
      const workingDirectory = await session.getWorkingDirectory();
      const run = await session.run(prompt);
      result = { sessionId: run.sessionId, finalResponse: run.finalResponse, workingDirectory };
    } else if (role === 'fence-double-resume') {
      // 围栏：同一进程里 resume 两次 —— 第二次必须被拒（「已 open 或正在 opening」）。
      await harness.resumeSession(sessionId);
      steps.push({ step: 'first-resume', ok: true });
      try {
        await harness.resumeSession(sessionId);
        steps.push({ step: 'second-resume', ok: true });
      } catch (caught) {
        steps.push({
          step: 'second-resume',
          ok: false,
          name: caught?.constructor?.name ?? typeof caught,
          code: caught?.code ?? null,
          message: String(caught?.message ?? caught).slice(0, 300),
        });
      }
      result = steps;
    } else if (role === 'fence-unknown') {
      // 围栏：resume 一个从未存在过的 id —— 会不会静默新建一个空会话。
      try {
        const session = await harness.resumeSession(sessionId);
        const workingDirectory = await session.getWorkingDirectory();
        const run = await session.run(prompt);
        result = { resumed: true, sessionId: run.sessionId, finalResponse: run.finalResponse, workingDirectory };
      } catch (caught) {
        result = {
          resumed: false,
          name: caught?.constructor?.name ?? typeof caught,
          code: caught?.code ?? null,
          message: String(caught?.message ?? caught).slice(0, 400),
        };
      }
    } else {
      throw new Error(`未知 role：${role}`);
    }
  } catch (caught) {
    error = {
      name: caught?.constructor?.name ?? typeof caught,
      message: String(caught?.message ?? caught).slice(0, 2000),
      code: caught?.code ?? null,
    };
  } finally {
    try {
      await harness.close();
    } catch (caught) {
      note(`${role} close() 抛错：`, String(caught?.message ?? caught).slice(0, 200));
    }
    try {
      subscription?.close();
    } catch {
      /* 关闭订阅失败不影响结论 */
    }
  }
  const allText = textsOf(notifications).join('\n');
  return {
    role,
    home,
    cwd,
    requestedSessionId: sessionId,
    nonce,
    result,
    error,
    notificationCount: notifications.length,
    // 判据的两半：厂商投影（通知流里有没有暗号）与模型答复（最终文本里有没有暗号）。
    nonceInNotifications: nonce === '' ? null : allText.includes(nonce),
    nonceInAnswer: nonce === '' ? null : JSON.stringify(result ?? '').includes(nonce),
    sessionsSeen: [
      ...new Set(notifications.map((one) => one?.params?.sessionId).filter((one) => typeof one === 'string')),
    ],
    // 投影原文的形状（哪一帧带了上一轮的事实）：只留方法名 / 事件类型 / 是否含暗号 + 一小段原文，
    // 免得 dump 变成整份通知流水。暗号在这一栏里被替换成 `<NONCE>`。
    projection: notifications.map((one) => {
      const text = textsOf(one?.params).join(' ⏎ ');
      return {
        method: one?.method ?? null,
        eventType: one?.params?.event?.type ?? null,
        sessionId: one?.params?.sessionId ?? null,
        hasNonce: nonce !== '' && text.includes(nonce),
        text: text.replaceAll(nonce, '<NONCE>').slice(0, 160),
      };
    }),
  };
}

/** 每一档的「拒绝原文」：正面档是 `null`，围栏档是厂商原话（形状随 role 不同，故逐档取）。 */
function refusalOf(role, reading) {
  if (reading.error !== null) return reading.error.message;
  if (reading.result?.resumed === false) return reading.result.message;
  if (role === 'fence-double-resume') return reading.result.find((one) => one.ok === false)?.message ?? null;
  return null;
}

const role = flagOf('role', 'driver');
const sdkDir = flagOf('sdk-dir', process.env.AIEVAL_PROBE_DSH_SDK_DIR ?? null);

if (role !== 'driver') {
  const home = flagOf('home', null);
  const cwd = flagOf('cwd', null);
  const cwd2 = flagOf('cwd2', null);
  const sessionId = flagOf('session', null);
  const nonce = flagOf('nonce', '');
  const prompt = flagOf('prompt', null);
  if (home === null || cwd === null) {
    note('单跑 role 时必须给 --home 与 --cwd');
    process.exit(2);
  }
  const text = prompt ?? (role === 'write' ? PROMPTS.write(nonce) : PROMPTS.ask());
  const effectiveCwd = role === 'fence-cwd-mismatch' ? (cwd2 ?? makeWorkspace('aieval-v11-dsh-a3-cwd2-')) : cwd;
  const reading = await runRole({ role, sdkDir, home, cwd: effectiveCwd, sessionId, nonce, prompt: text });
  const refusal = refusalOf(role, reading);
  const file = writeDump(`dsh-session-resume-alpha3-${role}`, reading);
  note(`${role}：通知 ${reading.notificationCount} 条｜答复 = ${JSON.stringify(String(reading.result?.finalResponse ?? refusal ?? reading.result).slice(0, 220))}`);
  note(`${role}：投影里含暗号 = ${reading.nonceInNotifications}｜答复里含暗号 = ${reading.nonceInAnswer}`);
  if (reading.error !== null) note(`${role} 抛错：${reading.error.name} [${reading.error.code}] ${reading.error.message.slice(0, 300)}`);
  note(`${role}：落盘 ${file}`);
  // 定式行给 driver 认（其余是给人看的 noise）。
  process.stdout.write(`REPLY=${String(reading.result?.finalResponse ?? '').replaceAll('\n', ' ')}\n`);
  process.stdout.write(`ANSWERS=${JSON.stringify(reading.result?.answers ?? [])}\n`);
  process.stdout.write(`SESSION_ID=${reading.result?.sessionId ?? ''}\n`);
  process.stdout.write(`WORKDIR=${reading.result?.workingDirectory ?? ''}\n`);
  process.stdout.write(`REFUSAL=${refusal === null ? '' : String(refusal).replaceAll('\n', ' ')}\n`);
  // 单跑一档失败要透出到本进程退出码，否则 driver 只看得到 0。
  if (reading.error !== null) process.exitCode = 1;
} else {
  // 一次 driver 全程用同一组临时目录：home 是会话持久物的根，cwd 是 adopt 的第二个判据。
  const home = mkdtempSync(join(tmpdir(), 'aieval-v11-dsh-a3-home-'));
  const cwd = makeWorkspace('aieval-v11-dsh-a3-ws-');
  const cwd2 = makeWorkspace('aieval-v11-dsh-a3-cwd2-');
  const otherHome = mkdtempSync(join(tmpdir(), 'aieval-v11-dsh-a3-home2-'));
  const nonce = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const unknownId = `probe-unknown-${Date.now()}`;
  note(`SDK = ${sdkDir ?? '@deepseek-ai/dsh-sdk-client（本仓装的那版）'}`);
  note(`DSH_HOME = ${home}（除 other-home 档外所有 role 同一个）`);
  note(`cwd      = ${cwd}`);
  note(`暗号 = ${nonce}（随机）`);

  const self = new URL(import.meta.url).pathname;
  const sdkArgs = sdkDir === null ? [] : [`--sdk-dir=${sdkDir}`];
  const run = (args) => {
    const out = spawnSync(process.execPath, [self, ...sdkArgs, ...args], {
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
    });
    process.stdout.write(out.stdout ?? '');
    if ((out.status ?? 0) !== 0) process.stderr.write(out.stderr ?? '');
    const pick = (tag) =>
      (out.stdout ?? '').split('\n').find((line) => line.startsWith(`${tag}=`))?.slice(tag.length + 1) ?? '';
    return {
      exit: out.status,
      timedOut: out.error?.code === 'ETIMEDOUT',
      reply: pick('REPLY'),
      answers: JSON.parse(pick('ANSWERS') || '[]'),
      sessionId: pick('SESSION_ID'),
      workdir: pick('WORKDIR'),
      refusal: pick('REFUSAL'),
    };
  };

  // 判据一：wire 全表（不调模型）
  const wire = run([`--role=wire`, `--home=${home}`, `--cwd=${cwd}`]);
  const wireDump = JSON.parse(readFileSync(join(DUMP_DIR, 'dsh-session-resume-alpha3-wire.json'), 'utf8'));
  const wireResume = wireDump.result?.find((one) => one.method === 'session/resume') ?? null;

  // 判据二：五个进程 + 四条围栏
  const base = [`--home=${home}`, `--cwd=${cwd}`, `--nonce=${nonce}`];
  const write = run([`--role=write`, ...base]);
  const sessionId = write.sessionId === '' ? `probe-fallback-${Date.now()}` : write.sessionId;
  const resume = run([`--role=resume`, ...base, `--session=${sessionId}`]);
  const resumeTwice = run([`--role=resume-twice`, ...base, `--session=${sessionId}`]);
  const control = run([`--role=control`, ...base]);
  const promptExisting = run([`--role=prompt-existing`, ...base, `--session=${sessionId}`]);
  const unknown = run([`--role=fence-unknown`, ...base, `--session=${unknownId}`]);
  const doubleResume = run([`--role=fence-double-resume`, ...base, `--session=${sessionId}`]);
  const cwdMismatch = run([`--role=fence-cwd-mismatch`, ...base, `--session=${sessionId}`, `--cwd2=${cwd2}`]);
  const otherHomeRun = run([
    `--role=resume`,
    `--home=${otherHome}`,
    `--cwd=${cwd}`,
    `--nonce=${nonce}`,
    `--session=${sessionId}`,
  ]);

  const answered = (one) => one.reply.includes(nonce);
  const verdict = {
    wireResumeRecognized: wireResume?.recognized === true,
    writeSucceeded: write.exit === 0 && write.sessionId !== '',
    resumeRestoredHistory: answered(resume),
    resumeTwiceBothAnswered: resumeTwice.answers.length === 2 && resumeTwice.answers.every((one) => one.includes(nonce)),
    controlAnsweredNothing: !answered(control),
    promptExistingRefused: promptExisting.refusal.includes('already exists'),
    unknownIdRefused: unknown.refusal.includes('not found'),
    doubleResumeRefused: doubleResume.refusal.includes('already open or opening'),
    cwdMismatchRefused: cwdMismatch.refusal !== '',
    otherHomeRefused: otherHomeRun.refusal.includes('not found'),
  };
  const reading = {
    sdkDir,
    home,
    cwd,
    cwd2,
    otherHome,
    sessionId,
    unknownId,
    nonce,
    wire,
    write,
    resume,
    resumeTwice,
    control,
    promptExisting,
    unknown,
    doubleResume,
    cwdMismatch,
    otherHomeRun,
    verdict,
  };

  // ⚠️ 与 `dsh-headless-resume.mjs` 同口径：**跑不起来 ≠ 探测失败**。write / resume / control
  // 是本支的判据载体；它们没跑成时既不落盘也不报判据，退出码 2 收场，
  // 免得一份空读数是下次会话当真读数读。围栏档**预期被拒**，不进这一判。
  const carriers = [write, resume, control];
  const broken = carriers.filter((one) => one.exit !== 0).length;
  const file = broken === 0 ? writeDump('dsh-session-resume-alpha3-reading', reading) : null;

  note('');
  note('判据读数（原文）：');
  note(`① wire：session/resume 认得 = ${verdict.wireResumeRecognized}｜原文 = ${JSON.stringify(wireResume?.message?.slice(0, 200))}`);
  note(`② 正面 resume：答复 = ${JSON.stringify(resume.reply.slice(0, 200))}`);
  note(`②b 正面连问两次：${JSON.stringify(resumeTwice.answers)}`);
  note(`③ 阴性 control：答复 = ${JSON.stringify(control.reply.slice(0, 200))}`);
  note(`④ 围栏 prompt-existing：${JSON.stringify(promptExisting.refusal.slice(0, 200))}`);
  note(`⑤ 围栏 unknown：${JSON.stringify(unknown.refusal.slice(0, 200))}`);
  note(`⑥ 围栏 double-resume：${JSON.stringify(doubleResume.refusal.slice(0, 200))}`);
  note(`⑦ 围栏 cwd-mismatch：拒 = ${verdict.cwdMismatchRefused}｜有效工作目录 = ${cwdMismatch.workdir}`);
  note(`⑧ 围栏 other-home：${JSON.stringify(otherHomeRun.refusal.slice(0, 200))}`);
  note('');
  if (file === null) {
    note(`⚠️ 有 ${broken} 个判据载体没跑成 ⇒ 读数作废、不落盘、退出码 2。`);
    process.exitCode = 2;
  } else {
    note(`读数落盘：${file}`);
    for (const [name, ok] of Object.entries(verdict)) note(`  ${ok ? '成立' : '不成立'} — ${name}`);
    note('');
    note('③ 不成立时 ② 的结论作废（说明暗号从别处泄漏了，不是转录起了作用）。');
  }
}
