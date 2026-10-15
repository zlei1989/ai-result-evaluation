/**
 * v11 探针（**第 2 问**）：dsh 用同一 `sessionId` 在**另一个进程**里能不能真的带回历史？
 *
 * 为什么这一问最要紧：SDK 的 `prompt(sessionId, …)` 文档写着 *"an unknown id creates it"*
 * ——**未知 id 会静默新建一个空会话**。于是"能恢复"与"安静地开了个新的"在表面上长得一样，
 * 是个典型的**假绿**。判据必须能在两者之间分出来。
 *
 * 判据（本探针的核心）：**暗号回读**。
 *   1. 进程 A（`--role=write`）用 `sessionId` 让模型记住一串随机暗号；
 *   2. 进程 A **退出**（`harness.close()`，运行时进程随之消失）；
 *   3. 进程 B（`--role=read`，**新的 node 进程**）用**同一个 `DSH_HOME` 与同一个 `sessionId`**
 *      问它"刚才那串暗号是什么"。
 *   ⇒ 答出暗号 = 真的跨进程恢复了历史；答"不知道"或另起一句 = 静默空会话（假绿）。
 *
 * 三件事必须钉住，少一件结论就不可信：
 *   · **两个 role 必须是两个进程**（`--role=driver` 用 `spawnSync` 各起一次），同进程里连跑两次
 *     测的是运行时实例还活着，不是"跨进程"；
 *   · **`DSH_HOME` 两次必须同一个**（会话的持久物只能落在这里）；
 *   · **暗号必须随机**（写死一个词的话，模型可能只是猜中/复述提示词）。
 *
 * 用法：`node packages/server/agents/probe/v11/dsh-session-resume.mjs`（driver，跑全套）
 *      或 `--role=write|read --home=<dir> --session=<id> --nonce=<str>`（单跑一半，便于对照）
 *      或 `--role=wire --home=<dir> --session=<id>`（**wire 方法全表**：把本机那版 SDK 的
 *         stdio wire 上所有能发的名字逐个发一遍，记原文错误；**不调模型**，所以单跑即可）
 * 产物：`probe/dumps/v2/dsh-session-resume-*.ndjson`（原始通知）与 `...-reading.json`
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from './lib/cc-ask.mjs';
import { readDeepSeekKey, writeSettings } from '../v2/lib/dsh.mjs';
import { appendJsonl } from '../v2/lib/gateway.mjs';

const MODEL = process.env.AIEVAL_PROBE_DSH_MODEL ?? 'deepseek-flash';

/**
 * wire 全表的候选名。
 *
 * 为什么要**逐个真发**而不是只读派发源码：源码只证明"服务端认识哪几个"，
 * 不证明"客户端那条 `request()` 打得到"。判据是服务端回的原文错误
 * （`unknown DeepSeek Harness SDK runtime method: <name>`，见
 * `dsh-sdk-jsonrpc-server/lib/index.js:200`）——认得的名字会走到业务分支、错误形状完全不同。
 *
 * `session/prompt` **故意不在表里**：它是唯一认得的 `session/*`，且发出去会真排一轮
 * 模型回合（不是零成本探测）。它已经在 `write` / `read` 两档里被真机走过了。
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

function flagOf(name, fallback) {
  const hit = process.argv.find((one) => one.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
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

/** 造一个最小的探测工作区（dsh 要一个 cwd）。 */
function makeWorkspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, 'notes.txt'), 'probe workspace\n', 'utf8');
  return root;
}

/**
 * 跑一次（一个 role）。
 * 与 `v2/lib/dsh.mjs` 的 `runDshProbe` 同口径，差别只有两处：
 *   · `DSH_HOME` 由调用方给（**两次必须同一个**，否则测的不是跨进程）；
 *   · `harness.run(prompt, { sessionId })`——**显式带 sessionId**（`runDshProbe` 没这一格）。
 */
async function runRole({ role, home, sessionId, prompt }) {
  const sdk = await import('@deepseek-ai/dsh-sdk-client');
  const workspace = makeWorkspace(`aieval-v11-dsh-${role}-`);
  const key = readDeepSeekKey();
  // 两份落盘必须在 `new DeepSeekHarness()` **之前**（否则 profile 里没有插件行）。
  // ⚠️ 本探针**不写** `profiles/sdk/cordis.patch.yml`：它要求 overlay 是**顶层 YAML 数组**，
  // 而在"这次不要挂任何插件"时写出来的文件只剩一行注释 ⇒ boot 直接失败
  // （`Error: dsh: overlay …/cordis.patch.yml must be a top-level YAML array of loader patch entries`，
  // 外层只看得到 `TransportClosedError … JSON-RPC input closed`）。不写这个文件就不产生 overlay。
  writeSettings(home, MODEL, 200000, 8192);
  const notifications = [];
  const harness = new sdk.DeepSeekHarness({
    cwd: workspace,
    dshHome: home,
    processCwd: workspace,
    model: MODEL,
    initializeTimeoutMs: 60000,
    env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: key },
  });
  let result = null;
  let error = null;
  let subscription = null;
  try {
    await harness.start();
    subscription = harness.client.subscribe((notification) => {
      notifications.push(notification);
      return true;
    });
    // 这一格是本探针的全部：`sessionId` 显式给，且两次进程给的是同一个。
    // **三条形状必须分开**（本节读数的重点）：
    //   · `harness.run(prompt, { sessionId })` —— 适配器今天用的那条，文档写"fresh (or named) session"；
    //     实测在会话**已存在**时抛 `session "…" already exists`；
    //   · `harness.session(sessionId).run(prompt)` —— 文档逐字 "explicit id to **reuse**"，
    //     实测**同样**撞 `already exists`；
    //   · `client.prompt(sessionId, blocks)` —— 低层那条，文档写 "target session; an unknown id creates it"，
    //     它不负责收尾 ⇒ 要自己排空通知流到本轮 `turn/end`。
    if (role === 'wire') {
      // 逐个真发，把服务端回的原文记下来。零成本：这些名字服务端都不认识，
      // 派发在 `handleRequest` 的 default 分支就结束了，不会起会话、不会调模型。
      const probes = [];
      for (const method of WIRE_CANDIDATES) {
        try {
          const result = await harness.client.request(method, {}, 15000);
          probes.push({ method, ok: true, result });
        } catch (caught) {
          probes.push({
            method,
            ok: false,
            name: caught?.constructor?.name ?? typeof caught,
            code: caught?.code ?? null,
            message: String(caught?.message ?? caught).slice(0, 300),
          });
        }
      }
      result = probes;
    } else if (role === 'read') {
      await harness.client.prompt(sessionId, [{ type: 'text', text: prompt }]);
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (notifications.some((one) => one?.params?.event?.type === 'turn/end')) break;
      }
      const replies = notifications
        .filter((one) => one?.params?.event?.type === 'assistant/message')
        .flatMap((one) => textsOf(one?.params?.event?.data));
      result = replies.at(-1) ?? null;
    } else {
      result = await harness.run(prompt, { sessionId });
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
  const dump = appendJsonl(`v2/dsh-session-resume-${role}`, notifications);
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  const sessionsSeen = [...new Set(notifications.map((one) => one?.params?.sessionId).filter((one) => typeof one === 'string'))];
  note(`${role}：通知 ${notifications.length} 条 → ${dump}`);
  if (role === 'wire') {
    for (const one of result) {
      note(`  ${one.ok ? '认得 ' : '不认得'} ${one.method} ⇒ ${one.ok ? JSON.stringify(one.result).slice(0, 120) : `${one.name} [${one.code}] ${one.message}`}`);
    }
  }
  note(`${role}：答复 = ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`);
  note(`${role}：通知里出现过的 sessionId = ${JSON.stringify(sessionsSeen)}`);
  if (error !== null) note(`${role} run 抛错：`, error.name, error.message.slice(0, 300));
  return { role, sessionId, text: String(text), notifications: notifications.length, sessionsSeen, error, dump };
}

const role = flagOf('role', 'driver');

if (role === 'driver') {
  const home = mkdtempSync(join(tmpdir(), 'aieval-v11-dsh-resume-home-'));
  const sessionId = `probe-resume-${Date.now()}`;
  const nonce = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  note(`DSH_HOME = ${home}（两次进程同一个）`);
  note(`sessionId = ${sessionId}｜暗号 = ${nonce}`);
  const run = (roleName, prompt) => {
    const out = spawnSync(
      process.execPath,
      [new URL(import.meta.url).pathname, `--role=${roleName}`, `--home=${home}`, `--session=${sessionId}`, `--nonce=${nonce}`, `--prompt=${prompt}`],
      { encoding: 'utf8' },
    );
    process.stdout.write(out.stdout ?? '');
    if ((out.status ?? 0) !== 0) process.stderr.write(out.stderr ?? '');
    return out.status;
  };
  // 步骤 1：进程 A 让模型记住暗号
  const writeStatus = run('write', `请记住这串暗号：${nonce}。只回复「记住了」三个字，不要复述暗号。`);
  // 步骤 2：进程 B（全新的 node 进程）用同一个 DSH_HOME 与同一个 sessionId 问回来
  const readStatus = run('read', '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。');
  const reading = { home, sessionId, nonce, writeStatus, readStatus };
  const file = writeDump('dsh-session-resume-reading', reading);
  note('');
  note(`driver：write 退出码 ${writeStatus}；read 退出码 ${readStatus}`);
  note(`读数落盘：${file}`);
  note('判据：read 的答复里**含暗号** ⇒ 真跨进程恢复；只回「不知道」或另起一句 ⇒ 静默空会话（假绿）。');
} else {
  const home = flagOf('home', null);
  const sessionId = flagOf('session', null);
  const prompt = flagOf('prompt', 'ping');
  if (home === null || sessionId === null) {
    note('单跑 role 时必须给 --home 与 --session');
    process.exit(2);
  }
  const reading = await runRole({ role, home, sessionId, prompt });
  const file = writeDump(`dsh-session-resume-reading-${role}`, reading);
  note(`读数落盘：${file}`);
  note(`判据：read 的答复里含 --nonce 给的暗号 ⇒ 真恢复；否则是空会话。`);
}
