#!/usr/bin/env node
/**
 * codex 补充探针：**只有 `threadId` 在手时，「cwd + 最近一条」这条查找路走不走得通**。
 *
 * 背景：`thread/resume` 的键是 `threadId`（`ThreadResumeParams.required = ['threadId']`，与 cwd 无关）。
 * 想靠 cwd 反查 id 就得用 `thread/list`。而主探针里 `thread/list{cwd}` 在一台只有一条线程的 home 上
 * **返回 0 条**——这一格必须查清是「线程没被索引」还是「过滤器把它筛掉了」，否则会把过滤器误当查不到。
 *
 * 三臂对照，自变量只有两格：
 *   · `start-only`：`thread/start` 之后没有任何 turn；
 *   · `after-turn`：跑完一轮（一次模型调用）之后再查；
 *   · `after-turn + config.toml`：同一台 home 补一份 `$CODEX_HOME/config.toml` 把那个 provider
 *     声明给**进程级**配置，再查一次 —— ②与③的差就是「`thread/list` 认不认线程级 provider」。
 * 每臂都在**新进程**里查（跨进程才是这条路的意义），过滤器组合各查一遍。
 *
 * 用法（`after-turn` 那两臂要凭据；`start-only` 那一臂零成本）：
 *   node packages/server/agents/probe/v11/codex-thread-lookup.mjs
 * 产物：`probe/dumps/v11/codex-thread-lookup*.json`
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DUMP_DIR, writeDump } from './lib/cc-ask.mjs';
import { startAppServer } from './lib/appserver.mjs';
import { resolveCodexBinary } from '../v10/codex-binary.mjs';

const TAG = '[v11/codex-lookup]';
const note = (...parts) => console.log(TAG, ...parts);
const BIN = resolveCodexBinary();

function flagOf(name, fallback) {
  const hit = process.argv.find((one) => one.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const INITIALIZE_PARAMS = {
  clientInfo: { name: 'aieval-v11-codex-lookup', version: '0.0.1' },
  capabilities: { experimentalApi: true },
};

/** 网关地址补 `/v1`（与适配器 `ensureV1Suffix` 同一条口径） */
function ensureV1Suffix(raw) {
  const trimmed = String(raw).replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/** 线程级配置：与主探针 / 适配器同一形状（`after-turn` 那一臂要靠它才不走内置 OpenAI provider） */
function threadConfig() {
  return {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval gateway',
        base_url: ensureV1Suffix(process.env.AIEVAL_PROBE_GATEWAY_BASE_URL ?? process.env.AIEVAL_PROBE_BASE_URL ?? ''),
        wire_api: 'responses',
        env_key: 'OPENAI_API_KEY',
        request_max_retries: 1,
      },
    },
    tools: { web_search: false, update_plan: { enabled: true } },
    features: { multi_agent: true },
  };
}

/** 端口的专属环境（独立 `$CODEX_HOME`；网关凭据只从环境变量进子进程） */
function childEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: home,
    OPENAI_API_KEY: process.env.AIEVAL_PROBE_GATEWAY_API_KEY ?? '',
  };
}

/** 从 dump 里回读一个 role 的读数（driver 只拿得到 stdout 的定式行） */
function readDump(name) {
  const file = join(DUMP_DIR, `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** `thread/start` 不带 turn ⇒ 只落一条零轮 rollout；返回它的 id 与 `path` */
async function roleStart({ home, cwd, label }) {
  const server = startAppServer({ command: BIN, args: ['app-server'], env: childEnv(home), cwd, timeoutMs: 30_000 });
  const reading = { role: 'start', label, home, cwd, threadId: null, path: null, historyMode: null, source: null, error: null };
  try {
    await server.request('initialize', INITIALIZE_PARAMS);
    const started = await server.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    reading.threadId = started?.thread?.id ?? null;
    reading.path = started?.thread?.path ?? null;
    reading.historyMode = started?.thread?.historyMode ?? null;
    reading.source = started?.thread?.source ?? null;
  } catch (error) {
    reading.error = String(error?.message ?? error);
  } finally {
    server.finish();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    server.close();
  }
  const file = writeDump(`codex-thread-lookup-${label}`, reading);
  note(`start：threadId=${reading.threadId ?? '(无)'} path=${reading.path ?? '(无)'} source=${JSON.stringify(reading.source)}｜落盘 ${file}`);
  process.stdout.write(`THREAD_ID=${reading.threadId ?? ''}\n`);
  process.stdout.write(`FATAL=${reading.error ?? ''}\n`);
  return reading;
}

/**
 * 跑一轮（一次模型调用）之后再查索引：分清「线程从没被索引」与「索引要等到跑过 turn」。
 * 三个读数一起看：① 同一进程内 `thread/list{cwd}` 看不看得见；② app-server 子进程的退出码；
 * ③ 新进程（`list` role）看不看得见。
 */
async function roleTurn({ home, cwd, label }) {
  const reading = {
    role: 'turn',
    label,
    home,
    cwd,
    threadId: null,
    turnId: null,
    turnStatus: null,
    reply: null,
    itemTypes: [],
    inProcessList: null,
    childExitCode: null,
    error: null,
  };
  let mainThreadId = null;
  let exitCode = null;
  let settleTurn = () => undefined;
  const turnDone = new Promise((resolve) => {
    settleTurn = resolve;
  });
  const texts = [];
  const itemTypes = [];
  const jsonlFile = join(DUMP_DIR, `codex-thread-lookup-${label}.jsonl`);
  writeFileSync(jsonlFile, '', 'utf8');
  const server = startAppServer({
    command: BIN,
    args: ['app-server'],
    env: childEnv(home),
    cwd,
    timeoutMs: 30_000,
    onLine: (line) => {
      appendFileSync(jsonlFile, `${line}\n`, 'utf8');
    },
    onExit: (info) => {
      exitCode = info.code;
    },
    onNotification: (method, params) => {
      if (method !== 'item/completed' || params?.threadId !== mainThreadId) return;
      itemTypes.push(params?.item?.type ?? null);
      if (params?.item?.type === 'agentMessage') texts.push(String(params.item.text ?? ''));
    },
    onTurnCompleted: (params) => {
      if (params?.threadId !== mainThreadId) return;
      reading.turnStatus = params?.turn?.status ?? null;
      settleTurn('turn');
    },
  });
  try {
    await server.request('initialize', INITIALIZE_PARAMS);
    const started = await server.request('thread/start', {
      model: flagOf('model', process.env.AIEVAL_PROBE_CODEX_MODEL ?? 'GLM-5.3'),
      cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: threadConfig(),
    });
    reading.threadId = started?.thread?.id ?? null;
    mainThreadId = reading.threadId;
    const turnStart = await server.request('turn/start', {
      threadId: reading.threadId,
      input: [{ type: 'text', text: '只回复 ok 两个字，不要调用任何工具。', text_elements: [] }],
    });
    reading.turnId = turnStart?.turn?.id ?? null;
    // 收场闸门：定时器**必须清掉**，否则它会挂住事件循环、进程要等两分钟才退出
    let guard = null;
    const guardSignal = new Promise((resolve) => {
      guard = setTimeout(() => resolve('timeout'), 120_000);
    });
    reading.winner = await Promise.race([turnDone, guardSignal]);
    clearTimeout(guard);
    reading.reply = texts.length === 0 ? null : texts[texts.length - 1];
    reading.itemTypes = itemTypes;
    const listed = await server.request('thread/list', { cwd, limit: 20 });
    const data = Array.isArray(listed?.data) ? listed.data : [];
    reading.inProcessList = { count: data.length, containsTarget: data.some((one) => one?.id === reading.threadId) };
  } catch (error) {
    reading.error = String(error?.message ?? error);
  } finally {
    // 自然退出优先：SIGTERM 之后多等一会儿，看进程自己收不收场（索引可能就写在收场那一步）
    server.finish();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    server.close();
    reading.childExitCode = exitCode;
    reading.jsonlFile = jsonlFile;
  }
  const file = writeDump(`codex-thread-lookup-${label}`, reading);
  note(
    `turn：threadId=${reading.threadId ?? '(无)'}｜turn=${reading.turnStatus ?? '(未结算)'}｜答复=${JSON.stringify(reading.reply)}｜进程内 thread/list 命中=${reading.inProcessList?.containsTarget ?? '(失败)'}（${reading.inProcessList?.count ?? '?'} 条）｜落盘 ${file}`,
  );
  process.stdout.write(`THREAD_ID=${reading.threadId ?? ''}\n`);
  process.stdout.write(`REPLY=${String(reading.reply ?? '').replaceAll('\n', ' ')}\n`);
  process.stdout.write(`FATAL=${reading.error ?? ''}\n`);
  return reading;
}

/** 把 `thread/list` 的各种过滤器组合各发一次，看那一条线程在哪些组合下可见 */
async function roleList({ home, cwd, threadId, label }) {
  const server = startAppServer({ command: BIN, args: ['app-server'], env: childEnv(home), cwd, timeoutMs: 30_000 });
  const variants = [
    { label: 'cwd（缺省 sourceKinds）', params: { cwd, limit: 20 } },
    { label: '无过滤（缺省 sourceKinds + 全 cwd）', params: { limit: 50 } },
    { label: 'cwd + sourceKinds=[appServer]', params: { cwd, limit: 20, sourceKinds: ['appServer'] } },
    { label: 'cwd + sourceKinds=[cli,vscode]', params: { cwd, limit: 20, sourceKinds: ['cli', 'vscode'] } },
    { label: 'cwd + useStateDbOnly', params: { cwd, limit: 20, useStateDbOnly: true } },
  ];
  const rows = [];
  const reading = { role: 'list', label, home, cwd, threadId, rows, error: null };
  try {
    await server.request('initialize', INITIALIZE_PARAMS);
    for (const variant of variants) {
      try {
        const listed = await server.request('thread/list', variant.params);
        const data = Array.isArray(listed?.data) ? listed.data : [];
        rows.push({
          label: variant.label,
          params: variant.params,
          count: data.length,
          ids: data.map((one) => one?.id ?? null),
          containsTarget: data.some((one) => one?.id === threadId),
          sources: data.map((one) => one?.source ?? null),
          cwds: data.map((one) => one?.cwd ?? null),
        });
      } catch (caught) {
        rows.push({ label: variant.label, params: variant.params, error: String(caught?.message ?? caught) });
      }
    }
  } catch (error) {
    reading.error = String(error?.message ?? error);
  } finally {
    server.finish();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    server.close();
  }
  const file = writeDump(`codex-thread-lookup-${label}`, reading);
  note(
    `list（${label}）：${rows
      .map((row) => `${row.label}⇒${row.error === undefined ? `${row.count} 条/${row.containsTarget ? '命中' : '未命中'}` : '报错'}`)
      .join('｜')}｜落盘 ${file}`,
  );
  process.stdout.write(`FATAL=${reading.error ?? ''}\n`);
  return reading;
}

const role = flagOf('role', 'driver');

if (role === 'start') {
  const reading = await roleStart({ home: flagOf('home'), cwd: flagOf('cwd'), label: flagOf('label', 'start') });
  if (reading.error !== null) process.exitCode = 2;
} else if (role === 'turn') {
  const reading = await roleTurn({ home: flagOf('home'), cwd: flagOf('cwd'), label: flagOf('label', 'turn') });
  if (reading.error !== null) process.exitCode = 2;
} else if (role === 'list') {
  const reading = await roleList({
    home: flagOf('home'),
    cwd: flagOf('cwd'),
    threadId: flagOf('thread-id', ''),
    label: flagOf('label', 'list'),
  });
  if (reading.error !== null) process.exitCode = 2;
} else {
  // 两台独立 home：①只有 thread/start；②跑过一轮。自变量只有这一个。
  const home1 = mkdtempSync(join(tmpdir(), 'aieval-v11-codex-lookup-home-'));
  const cwd1 = mkdtempSync(join(tmpdir(), 'aieval-v11-codex-lookup-ws-'));
  const home2 = mkdtempSync(join(tmpdir(), 'aieval-v11-codex-lookup2-home-'));
  const cwd2 = mkdtempSync(join(tmpdir(), 'aieval-v11-codex-lookup2-ws-'));
  note(`codex=${BIN}`);
  note(`① start-only：CODEX_HOME=${home1} cwd=${cwd1}`);
  note(`② after-turn：CODEX_HOME=${home2} cwd=${cwd2}`);

  const self = new URL(import.meta.url).pathname;
  const run = (args) => {
    const out = spawnSync(process.execPath, [self, ...args], { encoding: 'utf8', timeout: 180_000 });
    process.stdout.write(out.stdout ?? '');
    if ((out.status ?? 0) !== 0) process.stderr.write(out.stderr ?? '');
    const pick = (tag) =>
      (out.stdout ?? '')
        .split('\n')
        .find((line) => line.startsWith(`${tag}=`))
        ?.slice(tag.length + 1) ?? '';
    return { status: out.status, threadId: pick('THREAD_ID'), reply: pick('REPLY') };
  };

  // ① 零轮线程：新进程里查得到吗
  const startOnly = run([`--role=start`, `--label=start-only`, `--home=${home1}`, `--cwd=${cwd1}`]);
  const listStartOnly =
    startOnly.threadId === ''
      ? { status: 1, threadId: '' }
      : run([`--role=list`, `--label=list-start-only`, `--home=${home1}`, `--cwd=${cwd1}`, `--thread-id=${startOnly.threadId}`]);
  // ② 跑过一轮的线程：新进程里查得到吗
  const afterTurn = run([`--role=turn`, `--label=turn`, `--home=${home2}`, `--cwd=${cwd2}`]);
  const listAfterTurn =
    afterTurn.threadId === ''
      ? { status: 1, threadId: '' }
      : run([`--role=list`, `--label=list-after-turn`, `--home=${home2}`, `--cwd=${cwd2}`, `--thread-id=${afterTurn.threadId}`]);
  /**
   * ③ 同一台 home，多写一份 `$CODEX_HOME/config.toml` 把那个 provider 声明给**进程级**配置，再查一次。
   * 自变量只有这一格：`thread/start` 的 `config` 是**线程级**覆盖，进程配置里认不认得那个 provider
   * 决定 `thread/list` 认不认这条线程——两臂一比就把「行没进库」与「库里有、查不到」分开。
   */
  const configToml = [
    'model_provider = "aieval"',
    '',
    '[model_providers.aieval]',
    'name = "aieval gateway"',
    `base_url = "${ensureV1Suffix(process.env.AIEVAL_PROBE_GATEWAY_BASE_URL ?? '')}"`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    '',
  ].join('\n');
  writeFileSync(join(home2, 'config.toml'), configToml, 'utf8');
  const listWithConfigToml =
    afterTurn.threadId === ''
      ? { status: 1, threadId: '' }
      : run([`--role=list`, `--label=list-with-config-toml`, `--home=${home2}`, `--cwd=${cwd2}`, `--thread-id=${afterTurn.threadId}`]);

  const reading = {
    at: new Date().toISOString(),
    codex: BIN,
    startOnly: {
      home: home1,
      cwd: cwd1,
      ran: startOnly,
      reading: readDump('codex-thread-lookup-start-only'),
      listed: readDump('codex-thread-lookup-list-start-only'),
    },
    afterTurn: {
      home: home2,
      cwd: cwd2,
      ran: afterTurn,
      reading: readDump('codex-thread-lookup-turn'),
      listed: readDump('codex-thread-lookup-list-after-turn'),
      configToml,
      listedWithConfigToml: readDump('codex-thread-lookup-list-with-config-toml'),
    },
  };
  const statuses = [startOnly.status, listStartOnly.status, afterTurn.status, listAfterTurn.status, listWithConfigToml.status];
  const broken = statuses.filter((one) => one !== 0).length;
  note(
    `driver：start ${startOnly.status}；list(零轮) ${listStartOnly.status}；turn ${afterTurn.status}；list(有轮) ${listAfterTurn.status}；list(补 config.toml) ${listWithConfigToml.status}`,
  );
  const file = broken === 0 ? writeDump('codex-thread-lookup', reading) : null;
  note('');
  if (file === null) {
    note(`⚠️ ${broken} 个 role 没跑起来 ⇒ 读数作废、不落盘、退出码 2`);
    process.exitCode = 2;
  } else {
    const hit = (listed) => listed?.rows?.find((row) => row.label.startsWith('cwd（缺省'))?.containsTarget ?? null;
    note(`读数落盘：${file}`);
    note(`① 只有 thread/start（零轮）：新进程 thread/list{cwd} 命中 = ${hit(reading.startOnly.listed)}`);
    note(`② 跑过一轮（provider 只在 thread/start 的线程级 config 里）：新进程 thread/list{cwd} 命中 = ${hit(reading.afterTurn.listed)}`);
    note(`③ 同一台 home 补一份 $CODEX_HOME/config.toml 声明那个 provider：命中 = ${hit(reading.afterTurn.listedWithConfigToml)}`);
    note('⇒ ②与③的差 = `thread/list` 只认**进程级配置里认得**的 provider；我们的 provider 是线程级给的 ⇒ 靠 cwd 反查 id 这条路上不可用');
  }
}
