/**
 * 跨进程续接探针（cc）：`resume` 到底有没有把**历史**带回来。
 *
 * 为什么必须两个进程：`resume` 的全部意义是"新进程接上旧会话"。同一个进程里连跑两次
 * `query()` 拿到的是同一个 SDK 客户端的缓存，证明不了任何事。
 *
 * 定位键（同一行隔离下 `resume` 看得见的范围）是 **`CLAUDE_CONFIG_DIR`**，**cwd 不是隔离键**：
 * 同一个 configDir 下换一个 cwd 照样按 `session_id` 接上（返回的 id 不变、原转录被继续追加），
 * 换 configDir 才被拒。本探针一次跑里 configDir 与 cwd 都固定，两支单跑也必须给同一个 configDir，
 * 否则"接上了"与"接不上"都无从解释。
 *
 * 判据是**暗号回读**，不是"有没有报错"：
 *   ① 进程 A 让模型记住一串随机暗号（暗号**只存在于对话里**，绝不落进工作区任何文件）；
 *   ② 进程 B（**新的 node 进程**）只带 `resume: <A 的 session_id>` 问回来；
 *   ③ **阴性对照** 进程 C：同样的 cwd 与 configDir、**但不传 `resume`** —— 它必须答不上来。
 * 没有第 ③ 步，"答对了"可能只是工作区里留了什么，而不是历史回来了。
 *
 * 还有一格顺手坐实静态推断：**同一 cwd 里连跑两次（模拟 `retryRow` 重建工作区）后用 `continue: true`**
 * ——看它续的是**哪一次**。`continue` 取的是"当前目录最近一条"，行内重跑会误续到上一次尝试。
 *
 * 用法（凭据**只从环境变量读**，见 `requireGatewayCredential`）：
 *
 *   AIEVAL_PROBE_GATEWAY_API_KEY=… AIEVAL_PROBE_GATEWAY_BASE_URL=… \
 *     node packages/server/agents/probe/v11/cc-session-resume.mjs
 *
 * 单跑一半（排障用）：
 *   … node cc-session-resume.mjs --role=write --config-dir=<d> --cwd=<d> --nonce=<n>
 *   … node cc-session-resume.mjs --role=read  --config-dir=<d> --cwd=<d> --resume=<id>
 *   … node cc-session-resume.mjs --role=read  --config-dir=<d> --cwd=<d>            # 阴性对照
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeOptions, note, parseFlags, requireGatewayCredential, runQuery, writeDump } from './lib/cc-ask.mjs';

/** 本探针用的模型档：与其它 v11 真机探针同格，可用环境变量覆盖。 */
const MODEL = process.env.AIEVAL_PROBE_CC_MODEL ?? 'claude-sonnet-4-5';

/** 单次 `query()` 的墙钟上限：真机一轮问答够用，挂住时也能收场（超时本身就是读数）。 */
const QUERY_TIMEOUT_MS = 180_000;

function flagOf(name, fallback) {
  const hit = process.argv.find((one) => one.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** 把一次 `runQuery` 的结果摊成"模型说了什么"：取 assistant 正文与 `result` 摘要，拼成一段。 */
function replyTextOf(run) {
  const parts = [];
  for (const message of run.messages) {
    if (message?.type !== 'assistant') continue;
    for (const block of message?.message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (typeof run.result?.result === 'string') parts.push(run.result.result);
  return parts.join('\n');
}

/**
 * 跑一个 role。
 *
 * @param {object} input
 * @param {'write' | 'read'} input.role `write` = 新会话并记住暗号；`read` = 问回暗号。
 * @param {string} input.configDir 与 `CLAUDE_CONFIG_DIR` 同一个（两次进程必须一致）。
 * @param {string} input.cwd 工作目录（两次进程必须一致）。
 * @param {string} input.nonce 随机暗号（`write` 要它、`read` 用它判命中）。
 * @param {string | null} input.resume 要接的 session id；`null` = 不接（阴性对照那一档）。
 * @param {boolean} input.useContinue `continue: true` 那一档（同一 cwd 里"最近一条"）。
 */
async function runRole({ role, configDir, cwd, nonce, resume, useContinue }) {
  const { key, baseUrl } = requireGatewayCredential();
  // `claudeOptions` 自己会把这些拼进 options.env / cwd / settings，隔离口径（settingSources: []）也在它里面
  const options = claudeOptions({
    workspace: { root: cwd, configHome: configDir },
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: MODEL,
    },
    model: MODEL,
    mode: 'bypassPermissions',
    extraOptions: {
      ...(resume === null ? {} : { resume }),
      ...(useContinue ? { continue: true } : {}),
    },
  });

  const prompt =
    role === 'write'
      ? `请记住这串暗号：${nonce}。只回复「记住了」三个字，不要复述暗号。`
      : '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。';

  const run = await runQuery({ label: `cc-session-resume-${role}`, prompt, options, timeoutMs: QUERY_TIMEOUT_MS });
  const reply = replyTextOf(run);
  const sessionId = typeof run.init?.session_id === 'string' ? run.init.session_id : null;
  const reading = { role, configDir, cwd, nonce, resume, useContinue, sessionId, reply, timedOut: run.timedOut, error: run.error };
  const file = writeDump(`cc-session-resume-${role}`, reading);
  note(`${role}：session_id = ${sessionId ?? '(未读到)'}｜答复 = ${JSON.stringify(reply.slice(0, 200))}｜落盘 ${file}`);

  // 答复与 id 走 stdout 的定式行，driver 只认这两行（其余是给人看的 noise）
  process.stdout.write(`SESSION_ID=${sessionId ?? ''}\n`);
  process.stdout.write(`REPLY=${reply.replaceAll('\n', ' ')}\n`);
  return reading;
}

const role = flagOf('role', 'driver');

if (role !== 'driver') {
  const configDir = flagOf('config-dir', null);
  const cwd = flagOf('cwd', null);
  const nonce = flagOf('nonce', '');
  const resume = flagOf('resume', null);
  const useContinue = flagOf('continue', null) !== null;
  if (configDir === null || cwd === null) {
    note('单跑 role 时必须给 --config-dir 与 --cwd');
    process.exit(2);
  }
  await runRole({ role, configDir, cwd, nonce, resume, useContinue });
} else {
  // 一次 driver 全程只用两个临时目录：configDir 是 `resume` 唯一的定位键，cwd 只是工作区
  // （换 cwd 不影响会话能不能接上，故它不参与隔离；固定它只是为了让读数里少一个变量）
  const configDir = mkdtempSync(join(tmpdir(), 'aieval-v11-cc-resume-config-'));
  const cwd = mkdtempSync(join(tmpdir(), 'aieval-v11-cc-resume-ws-'));
  const nonceA = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const nonceB = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  note(`CLAUDE_CONFIG_DIR = ${configDir}`);
  note(`cwd               = ${cwd}`);
  note(`暗号 A = ${nonceA}｜暗号 B = ${nonceB}（两次都随机：写死一个词会被"猜中"污染判据）`);

  const self = new URL(import.meta.url).pathname;
  const run = (args) => {
    const out = spawnSync(process.execPath, [self, ...args], { encoding: 'utf8' });
    process.stdout.write(out.stdout ?? '');
    if ((out.status ?? 0) !== 0) process.stderr.write(out.stderr ?? '');
    const pick = (tag) => (out.stdout ?? '').split('\n').find((line) => line.startsWith(`${tag}=`))?.slice(tag.length + 1) ?? '';
    return { status: out.status, sessionId: pick('SESSION_ID'), reply: pick('REPLY') };
  };
  const base = [`--config-dir=${configDir}`, `--cwd=${cwd}`];
  const answered = (reply, nonce) => nonce !== '' && reply.includes(nonce);

  // ① 进程 A：新会话，记住暗号 A
  const writeA = run([`--role=write`, ...base, `--nonce=${nonceA}`]);
  // ② 进程 B：全新 node 进程，只带 resume 问回来 —— 正面判据
  const readB = writeA.sessionId === '' ? { status: null, sessionId: '', reply: '' } : run([`--role=read`, ...base, `--resume=${writeA.sessionId}`]);
  // ③ 进程 C：同样的 cwd 与 configDir、不传 resume —— 阴性对照，它必须答不上来
  const readC = run([`--role=read`, ...base]);
  // ④ 进程 D/E：同一 cwd 里再跑一次新会话（模拟 retryRow 重建工作区），然后 continue 看它续的是哪一次
  const writeB = run([`--role=write`, ...base, `--nonce=${nonceB}`]);
  const readContinue = run([`--role=read`, ...base, `--continue=1`]);

  const reading = {
    configDir,
    cwd,
    nonceA,
    nonceB,
    writeA,
    readB,
    readC,
    writeB,
    readContinue,
    verdict: {
      resumeRestoredHistory: answered(readB.reply, nonceA),
      controlAnsweredNothing: !answered(readC.reply, nonceA) && !answered(readC.reply, nonceB),
      continueFollowedWhich: answered(readContinue.reply, nonceB) ? 'B（最近一次）' : answered(readContinue.reply, nonceA) ? 'A（更早那次）' : '都没续上',
    },
  };
  // ⚠️ 有 role 没跑起来时**既不落盘也不报判据**：`requireGatewayCredential` 的 loud-fail 只保证
  // "不会静默回落到宿主配置"，拦不住"没跑成"被当成"探测失败"、更拦不住一份空读数在 dumps 里
  // 被下一次会话当真读数读。所以这一档要以**非 0 退出码**收场，并且**不留读数**。
  const statuses = [writeA.status, readB.status, readC.status, writeB.status, readContinue.status];
  const broken = statuses.filter((one) => one !== 0).length;
  const file = broken === 0 ? writeDump('cc-session-resume-reading', reading) : null;

  note('');
  note(`driver：writeA 退出码 ${writeA.status}；readB ${readB.status}；readC ${readC.status}；writeB ${writeB.status}；continue ${readContinue.status}`);
  if (file === null) {
    note(`⚠️ ${broken} 个 role 没跑起来 ⇒ **跑不起来 ≠ 探测失败**：读数作废、不落盘、退出码 2。`);
    process.exitCode = 2;
  } else {
    note(`读数落盘：${file}`);
    note('');
    note('判据三条：');
    note(`  ① 正面（resume 把历史带回来了）：${reading.verdict.resumeRestoredHistory ? '成立' : '不成立'} —— readB 的答复${reading.verdict.resumeRestoredHistory ? '含' : '不含'}暗号 A`);
    note(`  ② 阴性对照（不传 resume 就答不上来）：${reading.verdict.controlAnsweredNothing ? '成立' : '不成立'} —— readC 必须答不出`);
    note(`  ③ 附带格（continue 续的是哪一次）：${reading.verdict.continueFollowedWhich}`);
    note('');
    note('② 不成立时 ① 的结论作废（那说明工作区或别的东西泄漏了暗号，不是转录起了作用）。');
  }
}
