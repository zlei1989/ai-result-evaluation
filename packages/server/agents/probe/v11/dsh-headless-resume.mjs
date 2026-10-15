/**
 * v11 探针（**dsh 跨进程续接的第四条路**）：`dsh --profile headless --session-id` 能不能真接上历史？
 *
 * 为什么另开一支：`dsh-session-resume.mjs` 走的是 SDK stdio 那条 wire（`session/prompt`），
 * 那条链**没有 adopt 分支**（`dsh-sdk-jsonrpc-server/lib/index.js:203-231` 只看进程内 Map），
 * 已实测三条形状全报 `already exists`。而**同一份持久化层**其实有正经的 adopt 路径，
 * 只是入口不在 SDK 上：`dsh --profile headless --session-id <id>` 的 one-shot runner
 * 会 `sessionQuery.observeSession(id)` → `agents.resume({ resumeSessionId })`
 * （`dsh-headless/lib/index.js:241-276`）。本探针测的就是这一支。
 *
 * **不是**"换一种写法调 SDK"——它是**另一条进程形状**：不挂 jsonrpc-server，
 * 直接把一条 task 交给 runner，结果打到 stdout。所以本支照 `cc-session-resume.mjs` 的形状
 * （两个 role 必须两个进程、暗号随机、有阴性对照、跑不成不落盘且退出码 2）另起一支，
 * 而不是往 SDK 那支里塞。
 *
 * 判据（暗号回读 + 阴性对照 + 围栏）：
 *   ① `write`：**不给 `--session-id`**（runner 自己铸 id，从 `--json` 的开场 `session` 事件读回来）
 *      让模型记住暗号 A。⚠️ 给未知 id 会给 `--session-id` 直接报错，所以造会话那一档不能带它；
 *   ② `adopt`：**新进程**、同 `DSH_HOME`、同 cwd、`--session-id` 用①读回来的那个 id 问回暗号 A
 *      —— 正面判据；
 *   ③ `control`：同 `DSH_HOME`、同 cwd、**不给 `--session-id`**（全新会话）问暗号 A
 *      —— 阴性对照，它必须答不上来（否则"答对了"可能只是工作区/别处泄漏）；
 *   ④ `unknown`：`--session-id` 给一个**从未存在**的 id —— 文档说"unknown id is an error"，
 *      这一档钉"adopt 不是静默新建"；
 *   ⑤ `cwd-mismatch`：同 id、**换一个 cwd** —— 文档说 adopt 会比对记录的 cwd 并拒绝，
 *      这一档钉"adopt 认出的是那条记录本身，不是'有日志就放行'"。
 *
 * 三件事必须钉住（与 SDK 那支同口径）：两半必须是**两个进程**、`DSH_HOME` 两次**同一个**、
 * **暗号随机**。另外 headless 比 SDK 多一格：**cwd 也必须同一个**（它是 adopt 的判据之一）。
 *
 * 用法：`node packages/server/agents/probe/v11/dsh-headless-resume.mjs`（driver，跑全套）
 *      或 `--role=write|adopt|control|unknown|cwd-mismatch --home=<dir> --cwd=<dir>
 *          --nonce=<str> [--session=<id>] [--cwd2=<dir>] [--prompt=<str>]`（单跑一半）
 * 产物：`probe/dumps/v11/dsh-headless-resume-<role>.json` 与 `...-reading.json`。
 *
 * ⚠️ 凭据只从 `~/.dsh/.credentials.yaml` 读（`readDeepSeekKey`，与其它 dsh 探针同格），
 * 不打印、不落盘；本探针**不写**任何用户真实配置（`DSH_HOME` 是临时目录）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { note, writeDump } from './lib/cc-ask.mjs';
import { readDeepSeekKey, writeSettings } from '../v2/lib/dsh.mjs';

/** 与 base 的 `agent-default-model` 行一致（`provider: deepseek-official / model: deepseek-flash`）。 */
const MODEL = process.env.AIEVAL_PROBE_DSH_MODEL ?? 'deepseek-flash';

/** 单次 headless 运行的墙钟上限：冷启动 harness + 一轮短问答，挂住时超时本身就是读数。 */
const RUN_TIMEOUT_MS = 240_000;

function flagOf(name, fallback) {
  const hit = process.argv.find((one) => one.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/**
 * 解析出本机安装的 `dsh` 可执行入口。
 *
 * 为什么要绕一道 `createRequire(sdk-client 的入口)`：探针目录的 `node_modules` 里只有
 * `@deepseek-ai/dsh-sdk-client`，`@deepseek-ai/dsh` 是**它**的依赖（pnpm 只把软链建在
 * 它的 `node_modules` 下）。按 SDK 自己的口径解析（`lib/index.js:120-160` 的
 * `installedDshNodeLaunch`）才不会在某次 pnpm 提升变化后指错包。
 */
function dshBinPath() {
  const sdkEntry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client');
  const dshManifest = createRequire(sdkEntry).resolve('@deepseek-ai/dsh/package.json');
  return join(dirname(dshManifest), 'lib', 'bin.js');
}

/** 造一个最小的探测工作区（headless 要一个 cwd，且它会把这个 cwd 记进会话 header）。 */
function makeWorkspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, 'notes.txt'), 'probe workspace\n', 'utf8');
  return root;
}

/** 从 headless 的 `--json` 事件流里挑出答复：`final` 是终态原文，`text` 是增量投影。 */
function replyOf(stdout) {
  const texts = [];
  let final = null;
  let sessionId = null;
  let error = null;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 非 JSON 行（诊断/杂音）不参与判据
    }
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
    if (event.type === 'text' && typeof event.text === 'string') texts.push(event.text);
    if (event.type === 'final' && typeof event.text === 'string') final = event.text;
    if (event.type === 'error') error = typeof event.message === 'string' ? event.message : JSON.stringify(event);
  }
  return { final, texts, sessionId, error };
}

/**
 * 跑一次 headless（一个 role）。
 *
 * 环境只给三样：`DSH_HOME`（隔离的临时 home）、`DEEPSEEK_API_KEY`（凭据）、继承的宿主环境。
 * **不给** cwd 以外的定位键：headless 的 adopt 判据是 home × cwd × sessionId，多给别的会污染解释。
 */
function runHeadless({ home, cwd, sessionId, prompt }) {
  const key = readDeepSeekKey();
  writeSettings(home, MODEL, 200000, 8192);
  const args = [dshBinPath(), '--profile', 'headless', '--json'];
  if (sessionId !== null) args.push('--session-id', sessionId);
  args.push(prompt);
  const out = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: key },
  });
  const stdout = out.stdout ?? '';
  const stderr = out.stderr ?? '';
  const reply = replyOf(stdout);
  return {
    status: out.status,
    signal: out.signal ?? null,
    timedOut: out.error?.code === 'ETIMEDOUT',
    reply: reply.final ?? reply.texts.join('\n'),
    streamSessionId: reply.sessionId,
    streamError: reply.error,
    stderrTail: stderr.split('\n').filter((one) => one.trim() !== '').slice(-6),
  };
}

const PROMPTS = {
  write: (nonce) => `请记住这串暗号：${nonce}。只回复「记住了」三个字，不要复述暗号。`,
  ask: () => '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。',
};

const role = flagOf('role', 'driver');

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
  const text =
    prompt ?? (role === 'write' ? PROMPTS.write(nonce) : PROMPTS.ask());
  // `cwd-mismatch` 档：同 id、同 home，但换一个工作目录（adopt 应当按记录里的 cwd 拒绝）
  const effectiveCwd = role === 'cwd-mismatch' ? (cwd2 ?? makeWorkspace('aieval-v11-dsh-hl-cwd2-')) : cwd;
  // ⚠️ `write` 是**造**会话那一档：`--session-id` 给一个**未知** id 直接报错
  // （实测原文 `session "…" does not exist; omit --session-id to start a new Session`），
  // 所以这一档**不给 id**，让 runner 自己铸一个，再从 `--json` 的开场 `session` 事件里读回来。
  const session =
    role === 'write' || role === 'control'
      ? null
      : role === 'unknown'
        ? `probe-unknown-${Date.now()}`
        : sessionId;
  const run = runHeadless({ home, cwd: effectiveCwd, sessionId: session, prompt: text });
  const reading = { role, home, cwd: effectiveCwd, requestedSessionId: session, nonce, ...run };
  const file = writeDump(`dsh-headless-resume-${role}`, reading);
  note(`${role}：退出码 ${run.status}｜会话 = ${run.streamSessionId ?? '(未读到)'}｜答复 = ${JSON.stringify(String(run.reply).slice(0, 200))}`);
  note(`${role}：stderr 尾 = ${JSON.stringify(run.stderrTail)}`);
  note(`${role}：落盘 ${file}`);
  // 定式行给 driver 认（其余是给人看的 noise）；`STATUS` 是**内层 dsh** 的退出码
  process.stdout.write(`STATUS=${run.status}\n`);
  process.stdout.write(`SESSION_ID=${run.streamSessionId ?? ''}\n`);
  process.stdout.write(`REPLY=${String(run.reply).replaceAll('\n', ' ')}\n`);
  process.stdout.write(`STDERR=${run.stderrTail.join(' ⏎ ').replaceAll('\n', ' ')}\n`);
  // 内层 dsh 失败必须透出到**本探针进程**的退出码：否则 driver 只看得到 0，
  // 「这一档没跑成」会被当成「探测失败」（`cc-session-resume.mjs` 那条口径的落点）。
  if (run.status !== 0) process.exitCode = 1;
} else {
  // 一次 driver 全程用两个临时目录：home 是会话持久物的根，cwd 是 adopt 的第二个判据
  const home = mkdtempSync(join(tmpdir(), 'aieval-v11-dsh-hl-home-'));
  const cwd = makeWorkspace('aieval-v11-dsh-hl-ws-');
  const cwd2 = makeWorkspace('aieval-v11-dsh-hl-cwd2-');
  const sessionId = `probe-hl-${Date.now()}`;
  const nonceA = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  note(`DSH_HOME = ${home}（所有 role 同一个）`);
  note(`cwd      = ${cwd}（adopt 的第二个判据，必须同一个）`);
  note(`暗号 = ${nonceA}（随机：写死一个词会被"猜中"污染判据）`);
  note(`会话 id 由 write 那一档自己铸（给未知 id 会直接报错），${sessionId} 只是兜底`);

  const self = new URL(import.meta.url).pathname;
  const run = (args) => {
    const out = spawnSync(process.execPath, [self, ...args], { encoding: 'utf8' });
    process.stdout.write(out.stdout ?? '');
    if ((out.status ?? 0) !== 0) process.stderr.write(out.stderr ?? '');
    const pick = (tag) =>
      (out.stdout ?? '').split('\n').find((line) => line.startsWith(`${tag}=`))?.slice(tag.length + 1) ?? '';
    return {
      // `exit` 是本探针进程的退出码（内层 dsh 失败时会非 0）；`dshStatus` 是内层 dsh 自己的
      exit: out.status,
      dshStatus: Number(pick('STATUS')),
      sessionId: pick('SESSION_ID'),
      reply: pick('REPLY'),
      stderr: pick('STDERR'),
    };
  };
  const base = [`--home=${home}`, `--cwd=${cwd}`, `--nonce=${nonceA}`];
  const answered = (one) => one.reply.includes(nonceA);

  // ① 进程 A：**不给 id**（runner 自己铸），记住暗号；id 从开场 `session` 事件里读回来
  const write = run([`--role=write`, ...base]);
  const adoptedId = write.sessionId === '' ? sessionId : write.sessionId;
  // ② 进程 B：全新 node 进程 + 同 home + 同 cwd + **上面读回来的那个 id** —— 正面判据
  const adopt = run([`--role=adopt`, ...base, `--session=${adoptedId}`]);
  // ③ 进程 C：同 home + 同 cwd + **不给 id**（全新会话）—— 阴性对照
  const control = run([`--role=control`, ...base]);
  // ④ 进程 D：从未存在过的 id —— 文档说 unknown id is an error
  const unknown = run([`--role=unknown`, ...base, `--session=${adoptedId}`]);
  // ⑤ 进程 E：同 id 换 cwd —— adopt 应当按记录里的 cwd 拒绝
  const cwdMismatch = run([`--role=cwd-mismatch`, ...base, `--session=${adoptedId}`, `--cwd2=${cwd2}`]);

  const verdict = {
    writeSucceeded: write.exit === 0 && write.sessionId !== '',
    adoptRestoredHistory: answered(adopt),
    controlAnsweredNothing: !answered(control),
    unknownIdRefused: unknown.dshStatus !== 0 && !answered(unknown),
    cwdMismatchRefused: cwdMismatch.dshStatus !== 0 && !answered(cwdMismatch),
  };
  const reading = { home, cwd, cwd2, adoptedId, nonceA, write, adopt, control, unknown, cwdMismatch, verdict };

  // ⚠️ 与 `cc-session-resume.mjs` 同口径：**跑不起来 ≠ 探测失败**。write/adopt/control
  // 三档是本支的判据载体；它们没跑成时既不落盘也不报判据，退出码 2 收场，
  // 免得一份空读数是下次会话当真读数读。④⑤ 两档**预期非 0**，不进这一判。
  const carriers = [write, adopt, control];
  const broken = carriers.filter((one) => one.exit !== 0).length;
  const file = broken === 0 ? writeDump('dsh-headless-resume-reading', reading) : null;

  note('');
  note(`driver：write dsh=${write.dshStatus} exit=${write.exit}；adopt dsh=${adopt.dshStatus} exit=${adopt.exit}；control dsh=${control.dshStatus} exit=${control.exit}；unknown dsh=${unknown.dshStatus}；cwd-mismatch dsh=${cwdMismatch.dshStatus}`);
  note(`driver：adopt 用的会话 id = ${adoptedId}`);
  if (file === null) {
    note(`⚠️ 有 ${broken} 个判据载体没跑成 ⇒ 读数作废、不落盘、退出码 2。`);
    process.exitCode = 2;
  } else {
    note(`读数落盘：${file}`);
    note('');
    note('判据四条：');
    note(`  ① 正面（--session-id 把历史带回来了）：${verdict.adoptRestoredHistory ? '成立' : '不成立'}`);
    note(`  ② 阴性对照（不给 id 就答不上来）：${verdict.controlAnsweredNothing ? '成立' : '不成立'}`);
    note(`  ③ 未知 id 被拒（不是静默新建）：${verdict.unknownIdRefused ? '成立' : '不成立'}`);
    note(`  ④ 换 cwd 被拒（adopt 按记录比对）：${verdict.cwdMismatchRefused ? '成立' : '不成立'}`);
    note('');
    note('② 不成立时 ① 的结论作废（说明暗号从别处泄漏了，不是转录起了作用）。');
  }
}
