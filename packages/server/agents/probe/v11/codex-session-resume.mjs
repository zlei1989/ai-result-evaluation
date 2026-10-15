#!/usr/bin/env node
/**
 * 跨进程续接探针（codex `app-server`）：**`thread/resume` 到底有没有把历史带回来**。
 *
 * 为什么必须两个进程：`resume` 的全部意义是「新进程接上旧会话」。同一个 app-server 进程里
 * 线程本来就活在内存里，证明不了任何事 ⇒ 每一档都是**独立 node 进程 + 独立 app-server 进程**。
 *
 * 定位键：`thread/resume` 的必填入参只有 **`threadId`**（`ThreadResumeParams.required = ['threadId']`，
 * 见 `probe/dumps/v11/codex-schema-plain/v2/ThreadResumeParams.json`），与 cwd 无关；但 cwd 与
 * **`$CODEX_HOME`（子进程环境变量 `CODEX_HOME`）** 必须两半一致——会话产物落在它下面，
 * 换了 home 就等于换了一台机器。
 *
 * 判据三条（同 cc 那支的形状）：
 *   ① **正面**：进程 B（新的 node + 新的 app-server）只带 `thread/resume{threadId}` 问回暗号
 *      —— 答对 ⇒ 历史回来了；
 *   ② **阴性对照**：进程 C 用同样的 `$CODEX_HOME` / cwd，但走 `thread/start`（不开新线程就没别的路）
 *      —— 它**必须答不上来**；答得上来就说明暗号是从别处（工作区 / 全局记忆）泄漏的，①作废；
 *   ③ **隔离**：探针工作区（cwd，模型可写的那一份）里**一个文件都不许含暗号**。
 *
 * 两条**结构**读数（不走模型，零额度）当①的独立第二通道：
 *   · 进程 B 之前先跑一个 `inspect` 进程：`thread/read{includeTurns:true}` 把 rollout 历史读回来
 *     —— 命中暗号 ⇒ 历史确实在盘上、且新进程可读；
 *   · `thread/list{cwd}` 看那个 threadId 能不能被跨进程列出来（「靠什么找 id」的第二条路）。
 *
 * 顺手回答要的那一格：**`turn/steer` 的 `expectedTurnId` 是不是必须由「在途 turn」提供**。
 *   · 阴性：线程 idle（刚跑完，或 `thread/resume` 之后）时拿**那个已完成的 turn id** 去 steer ⇒ 报错原文；
 *   · 阳性：`turn/start` 一起就立刻拿**本次 turn id** 去 steer（prompt 让它先 `sleep 20`，保证在途）⇒ 成不成。
 * 两格一起才说明「不是这个方法坏了，而是前置必须在途」。
 *
 * 用法（凭据**只从环境变量读**，见 `gatewayCredential`）：
 *
 *   set -a; eval "$(grep -E '^export AIEVAL_PROBE' ~/.zshrc)"; set +a
 *   node packages/server/agents/probe/v11/codex-session-resume.mjs
 *
 * 单跑一个 role（排障用）：
 *   … --role=write   --home=<d> --cwd=<d> --nonce=AIEVAL-XXXX [--label=write]
 *   … --role=inspect --home=<d> --cwd=<d> --thread-id=<id> --nonce=AIEVAL-XXXX
 *   … --role=read    --home=<d> --cwd=<d> --thread-id=<id> --nonce=AIEVAL-XXXX
 *   … --role=read    --home=<d> --cwd=<d> --nonce=AIEVAL-XXXX --label=control   # 阴性对照
 *   … --role=steer   --home=<d> --cwd=<d> --label=steer-live                    # steer 阳性臂
 *
 * 产物落 `probe/dumps/v11/`（整个 `dumps/` 已 gitignore）：
 *   `codex-session-resume-<label>.jsonl`  该 role 的**原始帧**（逐行原文，密钥已 redact）
 *   `codex-session-resume-<label>.json`   该 role 的读数摘要
 *   `codex-session-resume-reading.json`   driver 的汇总与三条判据（**跑不成就不落盘、退出码 2**）
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DUMP_DIR, writeDump } from './lib/cc-ask.mjs';
import { startAppServer } from './lib/appserver.mjs';
import { resolveCodexBinary } from '../v10/codex-binary.mjs';

const TAG = '[v11/codex-resume]';
/** 进度行（给人看；driver 只认 stdout 里 `TAG=` 形式的定式行） */
function note(...parts) {
  console.log(TAG, ...parts);
}

/** `--key=value` 开关；未给时回落 fallback */
function flagOf(name, fallback) {
  const hit = process.argv.find((one) => one.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** 网关地址补 `/v1`：与适配器 `ensureV1Suffix` 同一条口径（codex 只走 Responses wire） */
function ensureV1Suffix(raw) {
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * 网关凭据**只从环境变量读**：缺哪个打印哪个并退出（退出码 2）。
 * 绝不回落到宿主配置 —— 那会让「跑不起来」看起来像「探测失败」。
 */
function gatewayCredential() {
  const key = process.env.AIEVAL_PROBE_GATEWAY_API_KEY ?? '';
  const raw = process.env.AIEVAL_PROBE_GATEWAY_BASE_URL ?? process.env.AIEVAL_PROBE_BASE_URL ?? '';
  const missing = [];
  if (key === '') missing.push('AIEVAL_PROBE_GATEWAY_API_KEY');
  if (raw === '') missing.push('AIEVAL_PROBE_GATEWAY_BASE_URL');
  if (missing.length > 0) {
    note(`缺环境变量：${missing.join(' / ')} ⇒ 退出（凭据只从环境变量读，源码里没有明文 key）`);
    process.exit(2);
  }
  return { key, baseUrl: ensureV1Suffix(raw) };
}

const { key: API_KEY, baseUrl: BASE_URL } = gatewayCredential();
const BIN = resolveCodexBinary();
const MODEL = flagOf('model', process.env.AIEVAL_PROBE_CODEX_MODEL ?? 'GLM-5.3');
/** 网关模型名不在 codex 内置目录里 ⇒ 上下文窗口只能由我们告诉它（与适配器同一格） */
const CONTEXT_WINDOW = Number(flagOf('context-window', '1048576'));
const TURN_TIMEOUT_MS = Number(flagOf('turn-timeout-ms', '180000'));
const ROLE_TIMEOUT_MS = TURN_TIMEOUT_MS * 2 + 60_000;

/** 密钥只从环境变量读；落盘 / 打印前按**精确串**替换，不做宽松正则 */
const redact = (value) => (API_KEY.length >= 8 ? String(value).split(API_KEY).join('***') : String(value));
const messageOf = (error) => String(error?.message ?? error);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const INITIALIZE_PARAMS = {
  clientInfo: { name: 'aieval-v11-codex-resume', title: 'aieval v11 codex resume probe', version: '0.0.1' },
  capabilities: { experimentalApi: true, requestAttestation: false },
};

/** 线程级配置：与适配器 `buildCodexConfig` 同一形状（这里只留路由与两格工具开关） */
function threadConfig() {
  return {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval gateway',
        base_url: BASE_URL,
        wire_api: 'responses',
        env_key: 'OPENAI_API_KEY',
        request_max_retries: 1,
      },
    },
    tools: { web_search: false, update_plan: { enabled: true } },
    features: { multi_agent: true },
    model_context_window: CONTEXT_WINDOW,
  };
}

/** 权限档：与适配器执行阶段一致（危险全开 + 批准策略 never —— 评测是非交互的） */
function threadStartParams() {
  return {
    model: MODEL,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    config: threadConfig(),
  };
}

/** 写暗号：**明说不要复述、不要调工具** —— 复述了的话「答复里含暗号」就分不清是历史还是回声 */
function writePrompt(nonce) {
  return `请记住这串暗号：${nonce}。只回复「记住了」三个字，不要复述暗号，也不要调用任何工具。`;
}

/** 问回暗号：没有这段记忆时必须回「不知道」，好让阴性对照的答复可判 */
function readPrompt() {
  return '刚才我让你记的那串暗号是什么？只回复暗号本身（形如 AIEVAL-XXXXXXXX）；如果你没有这段记忆，就只回复「不知道」。不要调用任何工具。';
}

/** 造一个在途窗口：先 shell `sleep 20`，保证 steer 阳性臂发出去时本轮一定还没收场 */
function steerLivePrompt() {
  return [
    '严格按顺序执行两步，不要跳步、不要做别的事：',
    '1. 用 shell 工具执行命令 `sleep 20`；',
    '2. 命令结束后只回复 SLEPT-OK。',
  ].join('\n');
}

/**
 * 拉起一个 app-server 并挂上收帧；返回这一档会话要用的全部出口。
 *
 * `mainThreadId` 故意是**后填**的：`thread/start` 的响应回来之前我们就得订阅（`thread/started`
 * 通知可能早于响应），而终结闸门只认主线程那一轮。
 */
function openAppServer({ home, cwd, label }) {
  const jsonlFile = join(DUMP_DIR, `codex-session-resume-${label}.jsonl`);
  writeFileSync(jsonlFile, '', 'utf8');
  const t0 = Date.now();
  const notifications = [];
  const serverRequests = [];
  const notifiedThreadIds = [];
  const identity = { mainThreadId: null };
  let turnSettled = null;
  let settleTurn = () => undefined;
  const turnDone = new Promise((resolve) => {
    settleTurn = resolve;
  });

  const server = startAppServer({
    command: BIN,
    args: ['app-server'],
    // 该档独立的 codex home：会话 / 配置 / 状态库全落在它下面，用户的 ~/.codex 一个字节都不碰
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: home, OPENAI_API_KEY: API_KEY },
    cwd,
    timeoutMs: 60_000,
    onLine: (line) => {
      appendFileSync(jsonlFile, `${redact(line)}\n`, 'utf8');
    },
    onNotification: (method, params) => {
      notifications.push({ atMs: Date.now() - t0, method, params });
      const id = params?.thread?.id;
      if (method === 'thread/started' && typeof id === 'string') notifiedThreadIds.push(id);
    },
    onTurnCompleted: (params) => {
      // 子线程自己的 `turn/completed` 不结算本次运行（口径同生产 session.ts）
      if (params?.threadId !== identity.mainThreadId) return;
      turnSettled = params.turn ?? null;
      settleTurn(turnSettled);
    },
    onServerRequest: (record) => {
      /**
       * 审批类服务端主动请求**一律不回帧**（本仓既有口径：评测是非交互的，回帧等于替用户批准）。
       * `approvalPolicy: 'never'` 下本来也不该出现，出现即记录。
       */
      serverRequests.push({ id: record.id, method: record.method, atMs: Date.now() - t0 });
    },
  });

  /** 主线程的 `item/completed` 条目（判据「模型说了什么」只认这一条通道） */
  const mainItems = () =>
    notifications
      .filter((one) => one.method === 'item/completed' && one.params?.threadId === identity.mainThreadId)
      .map((one) => ({ atMs: one.atMs, item: one.params?.item ?? null }));

  return {
    server,
    jsonlFile,
    notifications,
    serverRequests,
    setMainThreadId: (id) => {
      identity.mainThreadId = id;
    },
    notifiedThreadIds: () => [...notifiedThreadIds],
    turnSettled: () => turnSettled,
    /** 本轮最终的 `agentMessage` 正文；没产出就是 `null`（**不拿历史里的那条顶替**） */
    finalText: () => {
      const texts = mainItems()
        .filter((one) => one.item?.type === 'agentMessage')
        .map((one) => String(one.item?.text ?? ''));
      return texts.length === 0 ? null : texts[texts.length - 1];
    },
    itemSummary: () => mainItems().map((one) => ({ atMs: one.atMs, type: one.item?.type ?? null, name: one.item?.name ?? null })),
    /**
     * 等本轮收场；三路竞速：本轮的 `turn/completed` / 进程退出 / 超时。
     * 超时本身就是读数（收手并把进程收掉——**绝不悬挂**）。
     */
    waitTurn: async (timeoutMs) => {
      let guard = null;
      let onGuard = () => undefined;
      const guardSignal = new Promise((resolve) => {
        onGuard = resolve;
      });
      guard = setTimeout(() => {
        onGuard('timeout');
        server.close();
      }, timeoutMs);
      const winner = await Promise.race([turnDone.then(() => 'turn'), server.done.then(() => 'exit'), guardSignal]);
      clearTimeout(guard);
      return winner;
    },
    close: () => {
      server.finish();
    },
  };
}

/** `Thread` 里与「这是哪条线程、历史在不在」有关的几格（整份 thread 太大，不搬进产物） */
function trimThread(thread) {
  if (thread === null || typeof thread !== 'object') return null;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return {
    id: thread.id ?? null,
    cwd: thread.cwd ?? null,
    sessionId: thread.sessionId ?? null,
    historyMode: thread.historyMode ?? null,
    ephemeral: thread.ephemeral ?? null,
    model: thread.model ?? null,
    modelProvider: thread.modelProvider ?? null,
    cliVersion: thread.cliVersion ?? null,
    status: thread.status ?? null,
    preview: typeof thread.preview === 'string' ? thread.preview.slice(0, 200) : null,
    path: thread.path ?? null,
    forkedFromId: thread.forkedFromId ?? null,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    turns: turns.length,
    turnIds: turns.map((one) => one?.id ?? null),
    turnStatuses: turns.map((one) => one?.status ?? null),
    turnItemsView: turns.map((one) => one?.itemsView ?? null),
    turnItemTypes: turns.map((one) => (Array.isArray(one?.items) ? one.items.map((item) => item?.type ?? null) : null)),
  };
}

/**
 * 把 `$CODEX_HOME` 整个扫一遍：哪些文件在场、有多大、**暗号落在哪些文件里**。
 * 这就是「thread 的持久物落在哪、形状是什么、能不能一眼看出历史在场」那一问的读数。
 */
function snapshotHome(home, nonce) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(home);
  return files.map((file) => {
    let hasNonce = null;
    if (/\.(jsonl|json|toml|md|txt)$/.test(file)) {
      try {
        hasNonce = readFileSync(file, 'utf8').includes(nonce);
      } catch {
        hasNonce = null;
      }
    }
    return { path: relative(home, file), bytes: statSync(file).size, hasNonce };
  });
}

/** 工作区里有没有文件含暗号（判据 ③：隔离）；只读文本类文件，跳过二进制 */
function scanForNonce(root, nonce) {
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(jsonl|json|toml|md|txt|log|yaml|yml)$/.test(path)) continue;
      try {
        if (readFileSync(path, 'utf8').includes(nonce)) hits.push(relative(root, path));
      } catch {
        /* 读不了就不算命中 */
      }
    }
  };
  walk(root);
  return hits;
}

/** rollout（会话转录）文件：`$CODEX_HOME/sessions/.../rollout-*.jsonl` */
function rolloutFiles(home) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/rollout-.*\.jsonl$/.test(entry.name)) out.push(path);
    }
  };
  walk(home);
  return out.sort();
}

/** 定式收尾：driver 只认这几行；读数的全文在 dump 里 */
function emit(reading) {
  process.stdout.write(`ROLE=${reading.role}\n`);
  process.stdout.write(`THREAD_ID=${reading.threadId ?? ''}\n`);
  process.stdout.write(`TURN_ID=${reading.turnId ?? ''}\n`);
  process.stdout.write(`REPLY=${String(reading.reply ?? '').replaceAll('\n', ' ')}\n`);
  process.stdout.write(`FATAL=${reading.fatal ?? ''}\n`);
}

/** ── role：write（新线程里记住暗号）──────────────────────────────────────────── */
async function roleWrite({ home, cwd, nonce, label }) {
  const session = openAppServer({ home, cwd, label });
  const reading = {
    role: 'write',
    label,
    home,
    cwd,
    nonce,
    threadId: null,
    turnId: null,
    reply: null,
    turnStatus: null,
    turnTimedOut: false,
    turnStartError: null,
    threadStart: null,
    notifiedThreadIds: [],
    items: [],
    homeSnapshot: [],
    rolloutFiles: [],
    firstRolloutHead: null,
    fatal: null,
  };
  try {
    await session.server.request('initialize', INITIALIZE_PARAMS);
    const started = await session.server.request('thread/start', { ...threadStartParams(), cwd });
    reading.threadStart = trimThread(started?.thread ?? null);
    reading.threadId = started?.thread?.id ?? null;
    if (typeof reading.threadId !== 'string' || reading.threadId === '') {
      throw new Error('thread/start 未返回 thread.id');
    }
    session.setMainThreadId(reading.threadId);
    try {
      const turnStart = await session.server.request('turn/start', {
        threadId: reading.threadId,
        input: [{ type: 'text', text: writePrompt(nonce), text_elements: [] }],
      });
      reading.turnId = turnStart?.turn?.id ?? null;
    } catch (error) {
      // 起不了轮次 ⇒ 暗号没种下去，后面两问都无从谈起：这一档算「探针没跑成」
      reading.turnStartError = messageOf(error);
      throw error;
    }
    const winner = await session.waitTurn(TURN_TIMEOUT_MS);
    reading.turnTimedOut = winner === 'timeout';
    reading.turnStatus = session.turnSettled()?.status ?? null;
    reading.reply = session.finalText();
    reading.items = session.itemSummary();
    /**
     * `thread/started` 通知帧里的 id：**收尾之后再读**——那一帧与 `thread/start` 的响应谁先到没有保证，
     * 在响应回来时就取会读到一个空列表（那是探针的时序，不是厂商没发）。
     */
    reading.notifiedThreadIds = session.notifiedThreadIds();
    // 收尾之后再读盘：rollout 是边跑边写的，收尾前读会读到半程
    await sleep(1_500);
    reading.homeSnapshot = snapshotHome(home, nonce);
    reading.rolloutFiles = rolloutFiles(home).map((file) => relative(home, file));
    const first = reading.rolloutFiles[0];
    reading.firstRolloutHead =
      first === undefined ? null : readFileSync(join(home, first), 'utf8').split('\n').slice(0, 2).join('\n').slice(0, 1_500);
  } catch (error) {
    reading.fatal = messageOf(error);
  } finally {
    session.close();
    await sleep(1_200);
    session.server.close();
  }
  const file = writeDump(`codex-session-resume-${label}`, reading);
  note(`write：threadId=${reading.threadId ?? '(未读到)'}｜答复=${JSON.stringify(String(reading.reply ?? '').slice(0, 120))}｜落盘 ${file}`);
  emit(reading);
  return reading;
}

/** ── role：inspect（零模型：跨进程列线程 + 读历史）──────────────────────────── */
async function roleInspect({ home, cwd, threadId, nonce, label }) {
  const session = openAppServer({ home, cwd, label });
  const reading = {
    role: 'inspect',
    label,
    home,
    cwd,
    threadId,
    nonce,
    list: null,
    listError: null,
    read: null,
    readError: null,
    nonceFoundInTurns: null,
    fatal: null,
  };
  try {
    await session.server.request('initialize', INITIALIZE_PARAMS);
    try {
      const listed = await session.server.request('thread/list', { cwd, limit: 10 });
      const data = Array.isArray(listed?.data) ? listed.data : [];
      reading.list = {
        count: data.length,
        ids: data.map((one) => one?.id ?? null),
        containsTarget: data.some((one) => one?.id === threadId),
        previews: data.map((one) => (typeof one?.preview === 'string' ? one.preview.slice(0, 80) : null)),
        cwds: data.map((one) => one?.cwd ?? null),
      };
    } catch (error) {
      reading.listError = messageOf(error);
    }
    try {
      const read = await session.server.request('thread/read', { threadId, includeTurns: true });
      reading.read = trimThread(read?.thread ?? null);
      // 结构判据：rollout 历史里到底有没有那串暗号（不靠模型答话）
      reading.nonceFoundInTurns = JSON.stringify(read ?? {}).includes(nonce);
    } catch (error) {
      reading.readError = messageOf(error);
    }
  } catch (error) {
    reading.fatal = messageOf(error);
  } finally {
    session.close();
    await sleep(600);
    session.server.close();
  }
  const file = writeDump(`codex-session-resume-${label}`, reading);
  note(`inspect：thread/list 命中=${reading.list?.containsTarget ?? '(失败)'}｜thread/read turns=${reading.read?.turns ?? '(失败)'}｜历史含暗号=${reading.nonceFoundInTurns}｜落盘 ${file}`);
  emit(reading);
  return reading;
}

/**
 * ── role：read（`--thread-id` ⇒ resume；不给 ⇒ 阴性对照 thread/start）──────────
 *
 * 两档的**唯一自变量**就是「接不接那条线程」，home / cwd / 模型 / 配置 / 提问逐字相同。
 */
async function roleRead({ home, cwd, threadId, nonce, label }) {
  const resume = typeof threadId === 'string' && threadId !== '';
  const session = openAppServer({ home, cwd, label });
  const reading = {
    role: 'read',
    label,
    mode: resume ? 'resume' : 'control（thread/start，不接历史）',
    home,
    cwd,
    askedThreadId: threadId ?? null,
    nonce,
    threadId: null,
    turnId: null,
    reply: null,
    turnStatus: null,
    turnTimedOut: false,
    resumeError: null,
    resumed: null,
    controlStarted: null,
    turnError: null,
    items: [],
    steerIdle: null,
    fatal: null,
  };
  try {
    await session.server.request('initialize', INITIALIZE_PARAMS);
    if (resume) {
      try {
        const resumed = await session.server.request('thread/resume', {
          threadId,
          cwd,
          model: MODEL,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          config: threadConfig(),
        });
        reading.resumed = trimThread(resumed?.thread ?? null);
        // 结构判据：resume 的响应里带回来的 turns 里有没有那串暗号
        reading.resumedNonceInResponse = JSON.stringify(resumed ?? {}).includes(nonce);
        reading.threadId = resumed?.thread?.id ?? threadId;
      } catch (error) {
        // resume 报错本身就是读数（不是「探针没跑成」）：原文进产物，答复留空
        reading.resumeError = messageOf(error);
        reading.threadId = threadId;
      }
    } else {
      const started = await session.server.request('thread/start', { ...threadStartParams(), cwd });
      reading.controlStarted = trimThread(started?.thread ?? null);
      reading.threadId = started?.thread?.id ?? null;
      if (typeof reading.threadId !== 'string' || reading.threadId === '') throw new Error('thread/start 未返回 thread.id');
    }
    session.setMainThreadId(reading.threadId);

    if (reading.resumeError === null) {
      try {
        const turnStart = await session.server.request('turn/start', {
          threadId: reading.threadId,
          input: [{ type: 'text', text: readPrompt(), text_elements: [] }],
        });
        reading.turnId = turnStart?.turn?.id ?? null;
        const winner = await session.waitTurn(TURN_TIMEOUT_MS);
        reading.turnTimedOut = winner === 'timeout';
        reading.turnStatus = session.turnSettled()?.status ?? null;
        reading.reply = session.finalText();
        reading.items = session.itemSummary();
        // `thread/resume` 之后厂商会不会再补一帧 `thread/started`（拿它当 id 来源的人要知道这一格）
        reading.notifiedThreadIds = session.notifiedThreadIds();
      } catch (error) {
        reading.turnError = messageOf(error);
      }

      /**
       * 顺手坐实 `turn/steer` 的 `expectedTurnId` 语义：线程**idle**（本轮刚收场）时，
       * 拿那个已完成的 turn id 去 steer ⇒ 必须被拒；拒不了就说明「已完成的 turn 也能 steer」。
       */
      if (reading.turnId !== null && reading.turnTimedOut === false) {
        try {
          const steer = await session.server.request('turn/steer', {
            threadId: reading.threadId,
            expectedTurnId: reading.turnId,
            input: [{ type: 'text', text: 'PROBE-STEER-IDLE', text_elements: [] }],
          });
          reading.steerIdle = { ok: true, error: null, result: steer === undefined ? null : '有结果' };
        } catch (error) {
          reading.steerIdle = { ok: false, error: messageOf(error), result: null };
        }
      }
    }
  } catch (error) {
    reading.fatal = messageOf(error);
  } finally {
    session.close();
    await sleep(1_200);
    session.server.close();
  }
  const file = writeDump(`codex-session-resume-${label}`, reading);
  note(
    `${label}：${reading.mode}｜threadId=${reading.threadId ?? '(无)'}｜resume 报错=${reading.resumeError ?? '无'}｜答复=${JSON.stringify(String(reading.reply ?? '').slice(0, 120))}｜steer(idle)=${reading.steerIdle === null ? '(未试)' : reading.steerIdle.ok ? '竟然成功' : `被拒：${String(reading.steerIdle.error).slice(0, 120)}`}｜落盘 ${file}`,
  );
  emit(reading);
  return reading;
}

/** ── role：steer（零到一轮：`turn/steer` 的**阳性**臂，在途 turn 提供 expectedTurnId）── */
async function roleSteer({ home, cwd, label }) {
  const session = openAppServer({ home, cwd, label });
  const reading = {
    role: 'steer',
    label,
    home,
    cwd,
    threadId: null,
    turnId: null,
    reply: null,
    turnStatus: null,
    turnTimedOut: false,
    steerLive: null,
    steeredTextInFrames: null,
    items: [],
    fatal: null,
  };
  try {
    await session.server.request('initialize', INITIALIZE_PARAMS);
    const started = await session.server.request('thread/start', { ...threadStartParams(), cwd });
    reading.threadId = started?.thread?.id ?? null;
    if (typeof reading.threadId !== 'string' || reading.threadId === '') throw new Error('thread/start 未返回 thread.id');
    session.setMainThreadId(reading.threadId);
    const turnStart = await session.server.request('turn/start', {
      threadId: reading.threadId,
      input: [{ type: 'text', text: steerLivePrompt(), text_elements: [] }],
    });
    reading.turnId = turnStart?.turn?.id ?? null;
    // 立刻 steer：prompt 要它先 `sleep 20`，所以在途窗口足够宽
    try {
      const steer = await session.server.request('turn/steer', {
        threadId: reading.threadId,
        expectedTurnId: reading.turnId,
        input: [{ type: 'text', text: 'PROBE-STEER-LIVE', text_elements: [] }],
      });
      reading.steerLive = { ok: true, error: null, result: JSON.stringify(steer ?? null).slice(0, 400) };
    } catch (error) {
      reading.steerLive = { ok: false, error: messageOf(error), result: null };
    }
    const winner = await session.waitTurn(TURN_TIMEOUT_MS);
    reading.turnTimedOut = winner === 'timeout';
    reading.turnStatus = session.turnSettled()?.status ?? null;
    reading.reply = session.finalText();
    reading.items = session.itemSummary();
    // 那句 steer 文本有没有真的进线程（进没进 = 帧里能不能搜到）
    reading.steeredTextInFrames = JSON.stringify(session.notifications.map((one) => ({ method: one.method, params: one.params }))).includes('PROBE-STEER-LIVE');
  } catch (error) {
    reading.fatal = messageOf(error);
  } finally {
    session.close();
    await sleep(1_200);
    session.server.close();
  }
  const file = writeDump(`codex-session-resume-${label}`, reading);
  note(
    `steer：threadId=${reading.threadId ?? '(无)'}｜turnId=${reading.turnId ?? '(无)'}｜在途 steer=${reading.steerLive === null ? '(未试)' : reading.steerLive.ok ? '成功' : `被拒：${String(reading.steerLive.error).slice(0, 140)}`}｜steer 文本进帧=${reading.steeredTextInFrames}｜落盘 ${file}`,
  );
  emit(reading);
  return reading;
}

// ── 入口：driver 或单个 role ──────────────────────────────────────────────────
const role = flagOf('role', 'driver');

if (role !== 'driver') {
  const home = flagOf('home', null);
  const cwd = flagOf('cwd', null);
  const nonce = flagOf('nonce', '');
  const threadId = flagOf('thread-id', null);
  if (home === null || cwd === null) {
    note('单跑 role 时必须给 --home 与 --cwd');
    process.exit(2);
  }
  const label = flagOf('label', role);
  note(`role=${role} label=${label} codex=${BIN} model=${MODEL} home=${home} cwd=${cwd}`);
  if (role === 'write') {
    const reading = await roleWrite({ home, cwd, nonce, label });
    if (reading.fatal !== null) process.exitCode = 2;
  } else if (role === 'inspect') {
    if (threadId === null) {
      note('inspect 必须给 --thread-id');
      process.exit(2);
    }
    const reading = await roleInspect({ home, cwd, threadId, nonce, label });
    if (reading.fatal !== null) process.exitCode = 2;
  } else if (role === 'read') {
    const reading = await roleRead({ home, cwd, threadId, nonce, label });
    if (reading.fatal !== null) process.exitCode = 2;
  } else if (role === 'steer') {
    const reading = await roleSteer({ home, cwd, label });
    if (reading.fatal !== null) process.exitCode = 2;
  } else {
    note(`未知 role：${role}（可选：write / inspect / read / steer）`);
    process.exit(2);
  }
} else {
  // 一次 driver 全程只用两个临时目录：home 是会话产物的定位键，cwd 是工作区那一半
  const home = mkdtempSync(join(tmpdir(), 'aieval-v11-codex-resume-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'aieval-v11-codex-resume-ws-'));
  const nonceA = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  note(`codex=${BIN}`);
  note(`model=${MODEL} 网关=${BASE_URL}（密钥只从环境变量读，不落盘、不打印）`);
  note(`CODEX_HOME = ${home}`);
  note(`cwd        = ${cwd}`);
  note(`暗号 = ${nonceA}（随机：写死一个词会被「猜中」污染判据）`);

  const self = new URL(import.meta.url).pathname;
  const run = (args) => {
    const out = spawnSync(process.execPath, [self, ...args], { encoding: 'utf8', timeout: ROLE_TIMEOUT_MS });
    process.stdout.write(redact(out.stdout ?? ''));
    if ((out.status ?? 0) !== 0) process.stderr.write(redact(out.stderr ?? ''));
    const pick = (tag) =>
      (out.stdout ?? '')
        .split('\n')
        .find((line) => line.startsWith(`${tag}=`))
        ?.slice(tag.length + 1) ?? '';
    return { status: out.status, threadId: pick('THREAD_ID'), turnId: pick('TURN_ID'), reply: pick('REPLY'), fatal: pick('FATAL') };
  };
  const base = [`--home=${home}`, `--cwd=${cwd}`];
  const answered = (reply) => nonceA !== '' && String(reply).includes(nonceA);

  // ① 进程 A：新线程，记住暗号
  const writeA = run([`--role=write`, `--label=write`, ...base, `--nonce=${nonceA}`]);
  // ② 进程 B：零模型，只读：thread/list{cwd} 能不能列出那条线程、thread/read 能不能把历史读回来
  const inspectB =
    writeA.threadId === ''
      ? { status: 1, threadId: '', turnId: '', reply: '', fatal: 'write 没给出 threadId' }
      : run([`--role=inspect`, `--label=inspect`, ...base, `--thread-id=${writeA.threadId}`, `--nonce=${nonceA}`]);
  // ③ 进程 C：全新进程只带 thread/resume 问回来 —— 正面判据
  const readResume =
    writeA.threadId === ''
      ? { status: 1, threadId: '', turnId: '', reply: '', fatal: 'write 没给出 threadId' }
      : run([`--role=read`, `--label=read-resume`, ...base, `--thread-id=${writeA.threadId}`, `--nonce=${nonceA}`]);
  // ④ 进程 D：同样的 home 与 cwd、但走 thread/start —— 阴性对照，它必须答不上来
  const control = run([`--role=read`, `--label=control`, ...base, `--nonce=${nonceA}`]);
  // ⑤ 进程 E：steer 阳性臂（在途 turn 提供 expectedTurnId），与 idle 那一格配成一对
  const steerLive = run([`--role=steer`, `--label=steer-live`, ...base]);

  // 判据 ③：工作区（模型可写的那一份）里一个文件都不许含暗号
  const workspaceHits = scanForNonce(cwd, nonceA);
  const homeHits = scanForNonce(home, nonceA);

  const reading = {
    at: new Date().toISOString(),
    codex: BIN,
    model: MODEL,
    baseUrl: BASE_URL,
    home,
    cwd,
    nonceA,
    writeA,
    inspectB,
    readResume,
    control,
    steerLive,
    isolation: { workspaceFilesWithNonce: workspaceHits, codexHomeFilesWithNonce: homeHits },
    verdict: {
      /** ① 正面：resume 之后模型能答出暗号 */
      resumeRestoredHistory: answered(readResume.reply),
      /** ① 的结构第二通道：新进程 thread/read 从 rollout 里读回的历史含暗号 */
      historyReadableInFreshProcess: null,
      /** ② 阴性对照：不接历史就必须答不上来 */
      controlAnsweredNothing: !answered(control.reply),
      /** ③ 隔离：工作区零命中（codex home 里的命中是**厂商自己的历史**，不是泄漏） */
      workspaceIsolated: workspaceHits.length === 0,
    },
  };
  // 结构那一格要看 inspect 的 dump（driver 只拿得到 stdout 的定式行），故从 dump 里回读
  const inspectDump = join(DUMP_DIR, 'codex-session-resume-inspect.json');
  if (existsSync(inspectDump)) {
    try {
      reading.verdict.historyReadableInFreshProcess = JSON.parse(readFileSync(inspectDump, 'utf8')).nonceFoundInTurns === true;
    } catch {
      reading.verdict.historyReadableInFreshProcess = null;
    }
  }

  // ⚠️ 有 role 没跑起来时**既不落盘也不报判据**：跑不起来 ≠ 探测失败，一份空读数留在 dumps 里
  // 会被下一次会话当真读数读。⇒ 这一档以非 0 退出码收场、不留读数。
  const statuses = [writeA.status, inspectB.status, readResume.status, control.status, steerLive.status];
  const broken = statuses.filter((one) => one !== 0).length;
  const file = broken === 0 ? writeDump('codex-session-resume-reading', reading) : null;

  note('');
  note(`driver：write ${writeA.status}；inspect ${inspectB.status}；read(resume) ${readResume.status}；control ${control.status}；steer ${steerLive.status}`);
  if (file === null) {
    note(`⚠️ ${broken} 个 role 没跑起来 ⇒ 读数作废、不落盘、退出码 2（原因见上面的 FATAL 行与各 role 的 stderr）`);
    process.exitCode = 2;
  } else {
    note(`读数落盘：${file}`);
    note('');
    note('判据三条（外加两条结构 / steer 读数）：');
    note(`  ① 正面（resume 把历史带回来了）：${reading.verdict.resumeRestoredHistory ? '成立' : '不成立'} —— read-resume 的答复${reading.verdict.resumeRestoredHistory ? '含' : '不含'}暗号`);
    note(`     ①b 结构第二通道（新进程 thread/read 从 rollout 读回历史含暗号）：${reading.verdict.historyReadableInFreshProcess === null ? '未读到' : reading.verdict.historyReadableInFreshProcess ? '成立' : '不成立'}`);
    note(`  ② 阴性对照（不接历史就答不上来）：${reading.verdict.controlAnsweredNothing ? '成立' : '不成立'} —— control 那一路必须答不出`);
    note(`  ③ 隔离（探针工作区零命中）：${reading.verdict.workspaceIsolated ? '成立' : '不成立'}；codex home 命中 ${homeHits.length} 个文件（厂商自己的 rollout，属预期）`);
    note('② 不成立时 ① 的结论作废（那说明工作区或别的东西泄漏了暗号，不是历史起了作用）。');
    note(`steer：在途（阳性臂）${steerLive.reply === '' ? '见产物' : ''}见 codex-session-resume-steer-live.json；idle（阴性）见 codex-session-resume-read-resume.json 的 steerIdle`);
  }
}
