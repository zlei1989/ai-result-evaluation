/**
 * v6 探针：**app-server 方式下能不能让 codex 走 `/v1/chat/completions`？**
 *
 * 用户口径（2026-10-07）：codex 不再用 responses，改用 chat 协议；先测「app-server 方式下
 * chat/completions 能否拿到思考内容，以及子智能体用量」，可以就改。
 *
 * 两问分开答，判据各自独立：
 *   A 组（`only=wire`）：把**线程级 config** 的 `wire_api` 换成 `chat` 及其别名，app-server 认不认？
 *   B 组（`only=live`）：这条路真跑起来时，思考内容与**子智能体用量**拿不拿得到（responses 对照）。
 *
 * A 组的判据设计（关键，避免「静默忽略」被误判成「接受」）：
 *   base_url **一律指向本地 relay**，relay 只记录「收到了哪个路径的请求」并回 404。
 *     · 配置层被拒 ⇒ `thread/start` 直接报错，relay **一个请求都收不到**；
 *     · 配置层被接受 ⇒ relay 会收到请求 ⇒ **请求路径**就是「它到底打哪个端点」的直接证据。
 *   ⇒ 两种失败形态（报错 vs 静默忽略）能分开，不靠推断、不需要真上游、不花模型调用。
 *
 * B 组的判据：真上游（DeepSeek 官方）+ `wire_api: responses`，派一个前台子智能体，逐条记录
 *   `item/reasoning/*`（思考内容）、`thread/tokenUsage/updated` 的 **threadId 分布**（用量是不是
 *   按线程报、子线程有没有自己那份）、`thread/list{ancestorThreadId}`（线程树枚举）。
 *
 * 落盘（`probe/dumps/v6/`，已 gitignore）：
 *   · `codex-chat-wire-appserver-<case>.jsonl` —— 原始帧逐行原文（不 parse 后重排）；
 *   · `codex-chat-wire-appserver.json` —— 汇总与判定。
 *
 * 用法：
 *   node probe/v6/codex-chat-wire-appserver.mjs            # 两组都跑
 *   node probe/v6/codex-chat-wire-appserver.mjs only=wire  # 只跑 A 组（离线，零模型调用）
 *   node probe/v6/codex-chat-wire-appserver.mjs only=live  # 只跑 B 组（需密钥）
 * 前置：B 组要有 `AIEVAL_PROBE_DEEPSEEK_API_KEY`（`run.ps1` 从 `~/.dsh/.credentials.yaml` 注入）。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppServer } from '../v5/lib/client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 工作区根：`probe/v6` → 上三级 = `packages/server/agents` → 再上两级 = 仓库根 */
const REPO = join(HERE, '..', '..', '..', '..', '..');
const DUMP = join(HERE, '..', 'dumps', 'v6');
const SCRATCH = join(DUMP, 'tmp');

/**
 * codex 可执行文件：**按 pnpm 目录名解析**而不是写死版本号
 * （适配器实际 spawn 的就是这一份；版本升级后本探针不用改）。
 */
function resolveCodexExe() {
  const pnpmRoot = join(REPO, 'node_modules', '.pnpm');
  const platformDir = readdirSync(pnpmRoot).find(
    (name) => name.startsWith('@openai+codex@') && name.endsWith('-win32-x64'),
  );
  if (platformDir === undefined) throw new Error(`${pnpmRoot} 下没有 @openai/codex 的 win32-x64 平台包`);
  return join(pnpmRoot, platformDir, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
}

const CODEX_EXE = resolveCodexExe();
const MODEL = 'deepseek-reasoner';
const BASE_URL = 'https://api.deepseek.com/v1';
/** A 组的线上游不存在：base_url 指向本地 relay，relay 只记录不实现语义 */
const WIRE_VALUES = ['chat', 'chat_completions', 'openai-chat', 'completions', 'responses'];
/** A 组单 case 的观察窗口：`turn/start` 是异步的，relay 收到请求可能晚一点 */
const RELAY_WINDOW_MS = 25_000;
/** B 组单 case 上限（带子智能体的一轮真机 1~5 分钟） */
const LIVE_TIMEOUT_MS = 300_000;

/** B 组提示词：要求它派一个**前台**子智能体，并在子任务里真用一次 shell（这样才有子线程用量可看） */
const LIVE_PROMPT = [
  '严格按顺序执行：',
  '1. 用你可用的子智能体/委派工具（subagent / spawn_agent 之类）派一个**前台**子智能体（不要后台运行）：',
  '   description = "Child runs a command"',
  '   prompt = "先用 shell 执行 `echo CHILD-TOOL-RAN` 拿到输出，把输出原样写进你的最终答复。"',
  '2. 等它返回后，只回复一个词：done',
].join('\n');

const apiKey = process.env.AIEVAL_PROBE_DEEPSEEK_API_KEY ?? '';
/** 落盘前的替换表：只认**精确**的密钥串，不做宽松正则 */
const SECRETS = [apiKey].filter((one) => one.length >= 8);
const redact = (text) => SECRETS.reduce((out, secret) => out.split(secret).join('***'), text);

const only = process.argv.find((arg) => arg.startsWith('only='))?.slice('only='.length) ?? '';
const wantsWire = only === '' || only === 'wire';
const wantsLive = only === '' || only === 'live';

mkdirSync(DUMP, { recursive: true });
mkdirSync(SCRATCH, { recursive: true });

/** 一个 case 的 scratch 目录（`$CODEX_HOME` 与 cwd 都必须落在工作区内，见 v5 探针的三条硬约束） */
function prepareCase(label) {
  const dir = join(SCRATCH, label);
  const home = join(dir, 'home');
  const cwd = join(dir, 'cwd');
  rmSync(dir, { recursive: true, force: true });
  for (const one of [home, cwd]) mkdirSync(one, { recursive: true });
  return { home, cwd };
}

/**
 * 只记录不实现语义的 HTTP relay：把收到的**请求行**存下来，回一个 404。
 * 判据是「有没有请求」与「请求路径是什么」，所以不需要实现任何上游行为。
 */
function startRelay() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', bodyHead: redact(body).slice(0, 300) });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'v6 探针 relay：只记录请求路径，不实现上游语义' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => server.close(),
      });
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 组：一个 wire 取值一个 case；`thread/start` 的成败 + relay 收到的请求路径 = 判据 */
async function runWireCase(value) {
  const label = `wire-${value}`;
  const { home, cwd } = prepareCase(label);
  const jsonlFile = join(DUMP, `codex-chat-wire-appserver-${label}.jsonl`);
  writeFileSync(jsonlFile, '', 'utf8');

  const relay = await startRelay();
  const notifications = [];
  let exitCode = null;
  const server = startAppServer({
    binary: CODEX_EXE,
    /**
     * `env_key: 'OPENAI_API_KEY'` 必须能在环境里取到值，否则 CLI 在**取 Bearer** 这一步就失败
     * （`EnvVar` 错误）、一个请求都发不出去 ⇒ 那会让「responses 对照」看起来像「没打到 relay」。
     * A 组不打真上游，故给一个**假值**即可（relay 只记路径）。
     */
    env: { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, OPENAI_API_KEY: 'v6-probe-dummy-key' },
    cwd,
    timeoutMs: 30_000,
    onExit: (info) => {
      exitCode = info.code;
    },
    onLine: (line) => {
      appendFileSync(jsonlFile, `${redact(line)}\n`, 'utf8');
      try {
        const message = JSON.parse(line);
        if (typeof message.method === 'string') notifications.push({ method: message.method, params: message.params ?? null });
      } catch {
        /* 解析不了的行已经落盘，判定不用它 */
      }
    },
  });

  let threadError = null;
  let threadId = null;
  let turnError = null;
  try {
    await server.request('initialize', {
      clientInfo: { name: 'aieval-v6-chat-wire-probe', title: 'aieval v6 chat wire probe', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    try {
      const thread = await server.request('thread/start', {
        model: MODEL,
        cwd,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        config: {
          model_provider: 'aieval',
          model_providers: {
            aieval: {
              name: 'v6-relay',
              base_url: relay.baseUrl,
              wire_api: value,
              env_key: 'OPENAI_API_KEY',
              request_max_retries: 1,
            },
          },
          tools: { web_search: false },
        },
      });
      threadId = thread?.thread?.id ?? null;
    } catch (failure) {
      threadError = String(failure?.message ?? failure);
    }
    // 配置被接受时才会走到这里：起一轮，让 CLI 真去打上游（relay 记下它打的路径）
    if (threadId !== null) {
      try {
        await server.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: 'say ok', text_elements: [] }],
        });
      } catch (failure) {
        turnError = String(failure?.message ?? failure);
      }
      // 收到第一个请求就往下走（不必等满窗口）；一个都没有才等到窗口结束
      const deadline = Date.now() + RELAY_WINDOW_MS;
      while (relay.requests.length === 0 && Date.now() < deadline) await sleep(500);
    }
  } catch (failure) {
    threadError = threadError ?? String(failure?.message ?? failure);
  } finally {
    server.finish();
    await sleep(300);
    relay.close();
  }

  const accepted = threadError === null;
  const relayUrls = relay.requests.map((one) => `${one.method} ${one.url}`);
  /** 三态判定：被拒 / 接受且真打了某端点 / 接受但一个请求都没发出去 */
  const verdict = !accepted
    ? '❌ 配置层被拒'
    : relayUrls.length === 0
      ? '⚠️ 配置被接受，但观察窗口内没有请求到达 relay'
      : `✅ 配置被接受，实打端点：${[...new Set(relayUrls)].join('、')}`;

  return {
    label,
    wireApi: value,
    accepted,
    verdict,
    threadId,
    threadError,
    turnError,
    exitCode,
    relayRequests: relay.requests,
    notificationMethods: [...new Set(notifications.map((one) => one.method))],
    jsonlFile,
  };
}

/** B 组：真上游 + responses wire，量「思考内容」与「子智能体用量」到底拿不拿得到 */
async function runLiveCase() {
  const label = 'live-responses-subagent';
  const { home, cwd } = prepareCase(label);
  const jsonlFile = join(DUMP, `codex-chat-wire-appserver-${label}.jsonl`);
  writeFileSync(jsonlFile, '', 'utf8');

  const notifications = [];
  let exitCode = null;
  let mainThreadId = null;
  let turnCompleted = false;
  /**
   * **只认主线程那一轮的 `turn/completed`**：子线程自己的 turn 会先结束（真机实测：子线程那条
   * 早到，主线程还在 `inProgress`），拿「任何线程的 turn/completed」当闸门会让收尾提前发生
   * —— 主线程终态与最终答复都读不到。这正是生产 `session.ts` 那条「终结只认本轮」的口径。
   */
  let settleMainTurn = () => undefined;
  const mainTurnDone = new Promise((resolve) => {
    settleMainTurn = resolve;
  });
  const server = startAppServer({
    binary: CODEX_EXE,
    env: { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, OPENAI_API_KEY: apiKey },
    cwd,
    timeoutMs: 60_000,
    onExit: (info) => {
      exitCode = info.code;
    },
    onLine: (line) => {
      appendFileSync(jsonlFile, `${redact(line)}\n`, 'utf8');
      try {
        const message = JSON.parse(line);
        if (typeof message.method !== 'string') return;
        const params = message.params ?? null;
        notifications.push({ method: message.method, params });
        // 主线程的 turn/completed 才算本轮收尾；子线程自己的那一轮不算（见生产 session.ts 口径）
        if (message.method === 'turn/completed' && params?.threadId === mainThreadId) {
          turnCompleted = true;
          settleMainTurn(params);
        }
      } catch {
        /* 解析不了的行已经落盘 */
      }
    },
  });

  const startedMs = Date.now();
  let timedOut = false;
  let error = null;
  let threadList = null;
  const threadReads = {};
  let onTimeout = () => undefined;
  const timeoutSignal = new Promise((resolve) => {
    onTimeout = resolve;
  });
  const guard = setTimeout(() => {
    timedOut = true;
    onTimeout('timeout');
    server.close();
  }, LIVE_TIMEOUT_MS);

  try {
    await server.request('initialize', {
      clientInfo: { name: 'aieval-v6-live-probe', title: 'aieval v6 live probe', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const thread = await server.request('thread/start', {
      model: MODEL,
      cwd,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      config: {
        model_provider: 'aieval',
        model_providers: {
          aieval: {
            name: 'deepseek-official',
            base_url: BASE_URL,
            wire_api: 'responses',
            env_key: 'OPENAI_API_KEY',
            request_max_retries: 1,
          },
        },
        tools: { web_search: false },
        features: { multi_agent: true },
      },
    });
    mainThreadId = thread?.thread?.id ?? null;
    if (mainThreadId === null) throw new Error('thread/start 未返回 thread.id');

    await server.request('turn/start', {
      threadId: mainThreadId,
      input: [{ type: 'text', text: LIVE_PROMPT, text_elements: [] }],
    });

    // 等到**主线程**本轮终结（`turn/completed` 只作信号，收尾还要用同一个进程读回）
    await Promise.race([mainTurnDone, server.done, timeoutSignal]);
    // 子线程的通知可能晚于主线程终态到达：留一个短窗口再收尾（收尾失败也不影响已收到的证据）
    await sleep(2_000);

    const listed = await server.request('thread/list', { ancestorThreadId: mainThreadId, limit: 100 });
    threadList = listed?.data ?? [];
    for (const ref of [mainThreadId, ...threadList.map((one) => one?.id).filter((one) => typeof one === 'string')]) {
      try {
        threadReads[ref] = await server.request('thread/read', { threadId: ref, includeTurns: true });
      } catch (failure) {
        threadReads[ref] = { error: String(failure?.message ?? failure) };
      }
    }
  } catch (failure) {
    error = String(failure?.message ?? failure);
  } finally {
    clearTimeout(guard);
    if (timedOut) server.close();
    else {
      server.finish();
      await sleep(300);
    }
  }

  return {
    label,
    mainThreadId,
    exitCode,
    timedOut,
    turnCompleted,
    error,
    durationMs: Date.now() - startedMs,
    jsonlFile,
    ...summarizeLive(notifications, mainThreadId, threadList, threadReads),
  };
}

/** 把原始通知折算成判定要用的读数（思考内容、用量按线程的分布、线程树、工具调用） */
function summarizeLive(notifications, mainThreadId, threadList, threadReads) {
  const reasoningCompleted = [];
  const textDeltaByItem = new Map();
  const usageByThread = new Map();
  const itemTypes = {};
  const toolCalls = [];
  const errors = [];
  /** 每条 `turn/completed` 的归属（主/子线程都记：判据「终结只认本轮」的直接证据） */
  const turnCompletions = [];
  /** 答复条目按线程收（主线程那一条就是本轮的最终答复） */
  const agentMessagesByThread = new Map();

  for (const one of notifications) {
    const params = one.params ?? {};
    if (one.method === 'item/reasoning/textDelta') {
      const itemId = String(params.itemId ?? '<无>');
      textDeltaByItem.set(itemId, (textDeltaByItem.get(itemId) ?? 0) + 1);
      continue;
    }
    if (one.method === 'item/completed' || one.method === 'item/started') {
      const item = params.item ?? {};
      const type = String(item.type ?? '<无>');
      itemTypes[type] = (itemTypes[type] ?? 0) + 1;
      if (type === 'reasoning' && one.method === 'item/completed') {
        reasoningCompleted.push({
          threadId: params.threadId ?? null,
          itemId: item.id ?? null,
          hasSummaryKey: Object.hasOwn(item, 'summary'),
          hasContentKey: Object.hasOwn(item, 'content'),
          summary: item.summary ?? null,
          content: item.content ?? null,
        });
      }
      // 工具调用的名字是「子智能体工具到底叫什么」的直接证据
      if (one.method === 'item/completed' && ['commandExecution', 'mcpToolCall', 'functionCall', 'customToolCall', 'collabToolCall', 'collabAgentToolCall', 'webSearch'].includes(type)) {
        toolCalls.push({
          threadId: params.threadId ?? null,
          type,
          name: item.name ?? item.tool ?? item.command ?? null,
          status: item.status ?? null,
          // 子智能体工具带接收方线程与各子智能体的终态（`wait` 的 message 里就是子智能体的结论）
          receiverThreadIds: item.receiverThreadIds ?? null,
          agentsStates: item.agentsStates ?? null,
        });
      }
      if (one.method === 'item/completed' && type === 'agentMessage') {
        const holder = agentMessagesByThread.get(String(params.threadId ?? '<无>')) ?? [];
        holder.push({ itemId: item.id ?? null, textHead: String(item.text ?? '').slice(0, 240), chars: String(item.text ?? '').length });
        agentMessagesByThread.set(String(params.threadId ?? '<无>'), holder);
      }
      continue;
    }
    if (one.method === 'turn/completed') {
      turnCompletions.push({
        threadId: params.threadId ?? null,
        turnId: params.turn?.id ?? null,
        status: params.turn?.status ?? null,
        error: params.turn?.error ?? null,
        itemsView: params.turn?.itemsView ?? null,
      });
      continue;
    }
    if (one.method === 'thread/tokenUsage/updated') {
      const total = params.tokenUsage?.total ?? null;
      usageByThread.set(String(params.threadId ?? '<无>'), {
        totalTokens: total?.totalTokens ?? null,
        inputTokens: total?.inputTokens ?? null,
        cachedInputTokens: total?.cachedInputTokens ?? null,
        outputTokens: total?.outputTokens ?? null,
        reasoningOutputTokens: total?.reasoningOutputTokens ?? null,
      });
      continue;
    }
    if (one.method === 'error' || one.method === 'turn/failed') errors.push({ method: one.method, params });
  }

  const childIds = (threadList ?? []).map((one) => String(one?.id ?? '<无>'));
  const usageThreadIds = [...usageByThread.keys()];
  const childUsage = childIds.filter((id) => usageByThread.has(id));
  const mainUsage = mainThreadId !== null && usageByThread.has(mainThreadId);
  const reasoningWithText = reasoningCompleted.filter((one) => Array.isArray(one.content) && one.content.some((part) => String(part).trim() !== ''));

  return {
    /** 判据 ① 思考内容：有正文的 reasoning 条目 */
    thinking: {
      completedCount: reasoningCompleted.length,
      withTextCount: reasoningWithText.length,
      firstContentHead: reasoningWithText[0]?.content?.[0]?.slice(0, 160) ?? null,
      firstContentChars: reasoningWithText[0]?.content?.[0]?.length ?? null,
      textDeltaItems: [...textDeltaByItem.entries()].map(([itemId, count]) => ({ itemId, count })),
      summaryEverNonEmpty: reasoningCompleted.some((one) => Array.isArray(one.summary) && one.summary.length > 0),
    },
    /** 判据 ② 用量：按线程的分布（子线程有没有自己那一份） */
    usage: {
      usageThreadIds,
      byThread: Object.fromEntries(usageByThread),
      mainThreadReported: mainUsage,
      childThreadIds: childIds,
      childThreadsWithUsage: childUsage,
      childThreadsMissingUsage: childIds.filter((id) => !usageByThread.has(id)),
    },
    threadList: (threadList ?? []).map((one) => ({
      id: one?.id ?? null,
      parentThreadId: one?.parentThreadId ?? null,
      agentNickname: one?.agentNickname ?? null,
      status: one?.status ?? null,
      subAgentSpawn: one?.subAgentSpawn ?? null,
    })),
    threadReadSummary: Object.fromEntries(
      Object.entries(threadReads).map(([id, value]) => [
        id,
        value?.error !== undefined
          ? { error: value.error }
          : {
              status: value?.thread?.status ?? null,
              turns: (value?.thread?.turns ?? []).map((turn) => ({
                itemsView: turn?.itemsView ?? null,
                status: turn?.status ?? null,
                itemTypes: (turn?.items ?? []).map((item) => item?.type ?? null),
              })),
            },
      ]),
    ),
    itemTypes,
    /** 每条 turn/completed 的归属：主线程那条才是本轮结论（子线程那条早到，见 runLiveCase 的注释） */
    turnCompletions,
    /** 各线程的答复条目（主线程那一份 = 本轮最终答复） */
    agentMessagesByThread: Object.fromEntries(agentMessagesByThread),
    toolCalls,
    errors,
    notificationMethods: [...new Set(notifications.map((one) => one.method))],
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const startedAt = new Date().toISOString();
const summary = { at: startedAt, probe: 'codex-chat-wire-appserver', codexExe: CODEX_EXE, model: MODEL, wireCases: [], live: null };

if (wantsWire) {
  console.log('[v6] A 组：线程级 config 的 wire_api 取值矩阵（离线，relay 只记录请求路径）');
  for (const value of WIRE_VALUES) {
    const row = await runWireCase(value);
    summary.wireCases.push(row);
    console.log(`  ${value.padEnd(16)} ${row.verdict}`);
    if (row.threadError !== null) console.log(`       thread/start 错误原文：${row.threadError.slice(0, 300)}`);
    if (row.relayRequests.length > 0) console.log(`       relay 收到：${row.relayRequests.map((one) => `${one.method} ${one.url}`).join('、')}`);
  }
}

if (wantsLive) {
  if (apiKey === '') {
    console.log('[v6] B 组跳过：缺 AIEVAL_PROBE_DEEPSEEK_API_KEY（用 run.ps1 跑，或自己设这个环境变量）');
  } else {
    console.log('[v6] B 组：真机 responses 下的思考内容与子智能体用量（派一个前台子智能体）');
    const row = await runLiveCase();
    summary.live = row;
    console.log(`  turn=${row.turnCompleted ? 'completed' : `未收到(timedOut=${row.timedOut})`} 用时=${Math.round(row.durationMs / 1000)}s`);
    console.log(`  思考：条目 ${row.thinking.completedCount}、有正文 ${row.thinking.withTextCount}、首段 ${row.thinking.firstContentChars ?? '-'} 字`);
    console.log(`  用量：线程 ${row.usage.usageThreadIds.length} 个有读数；子线程 ${row.usage.childThreadIds.length} 个，其中有用量 ${row.usage.childThreadsWithUsage.length} 个`);
    console.log(`  线程树：${row.threadList.length} 个后代`);
  }
}

const file = join(DUMP, 'codex-chat-wire-appserver.json');
writeFileSync(file, `${redact(JSON.stringify(summary, null, 2))}\n`, 'utf8');
console.log('[v6] 汇总：', file);
