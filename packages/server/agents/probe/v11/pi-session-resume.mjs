/**
 * 跨进程续接探针（pi）：**文件型** `SessionManager` 到底能不能把历史带回来。
 *
 * 为什么必须两个进程：适配器今天用的是 `SessionManager.inMemory()`（`providers/pi/index.ts:735`）
 * ⇒ `sessionFile === undefined`、盘上什么都没有。换文件型 manager 的意义正是「新进程接上旧会话」，
 * 同一个进程里连问两次证明不了任何事。
 *
 * 为什么**不是**脚本式假上游：这条判据要的是「厂商把上一轮的转录重新灌进模型上下文」，
 * 假上游只能证明「请求发出去了」，证明不了「上下文里有暗号」。所以走**真机**（真模型、真网关）。
 *
 * 判据是**暗号回读**，不是「有没有报错」：
 *   ① 进程 A 让模型记住一串随机暗号（暗号只在对话里，工作区里一个字都不留）；
 *   ② 进程 B（**新的 node 进程**）用 `SessionManager.open(A 的会话文件)` 问回来 —— 正面；
 *   ③ 进程 D（新的 node 进程、**同一 cwd、同一 sessionDir、只是不打开那个文件**）—— 阴性对照，
 *      它必须答不上来。没有 ③，「答对了」可能来自工作区残留或别的东西泄漏，而不是转录回来了；
 *   ④ **按行隔离**：进程 G 在**另一个 sessionDir**（刻意复用同一个 cwd —— 这是更难的那一半）
 *      写下暗号 C，进程 H 在同一个 sessionDir 里 `continueRecent` —— 必须答 C，
 *      **不许**答出 A / B。这一格证明「不同会话目录」本身就足以隔开两行，不需要别的机制；
 *   ⑤ 附带格：同一 cwd + 同一 sessionDir 里再写一次（模拟 `retryRow` 重建工作区）之后
 *      `continueRecent` 续的是**哪一次** —— 它取「最近一条」，会把上一次尝试接上来。
 *
 * 每格还有一份**不花额度**的机制层读数：`prompt()` 之前读厂商自己的
 * `manager.buildSessionContext()`，看投影出来的上下文里有没有暗号。为什么要它——模型的答复会抖
 * （真机 12 个问回格里见过 2 格「投影里有暗号、模型仍答『不知道』」），只取答复会把
 * 「机制坏了」与「模型这一把没答对」混成一条。投影判机制、答复判端到端，两者各自成立才算数。
 *
 * 用法（凭据**只从环境变量读**，见 `requireCredential`）：
 *
 *   set -a; eval "$(grep -E '^export AIEVAL_PROBE' ~/.zshrc)"; set +a
 *   node packages/server/agents/probe/v11/pi-session-resume.mjs
 *
 * 单跑一格（排障用）：
 *   … node pi-session-resume.mjs --role=write    --cwd=<d> --config-dir=<d> --session-dir=<d> --nonce=<n> --label=<名>
 *   … node pi-session-resume.mjs --role=open     --cwd=<d> --config-dir=<d> --session-file=<f> --nonce=<n> --label=<名>
 *   … node pi-session-resume.mjs --role=continue --cwd=<d> --config-dir=<d> --session-dir=<d> --nonce=<n> --label=<名>
 *   … node pi-session-resume.mjs --role=fresh    --cwd=<d> --config-dir=<d> --session-dir=<d> --nonce=<n> --label=<名>   # 阴性对照
 *   … node pi-session-resume.mjs --role=default-dir --cwd=<d>          # 默认落点（配合 PI_CODING_AGENT_DIR）
 *   ⚠️ `--nonce` 只在问回那一档给：不给就**读不出投影判据**（不是「投影里没有」），脚本会明说。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本探针用的模型档：与其它 v11 真机探针同格，可用环境变量覆盖。 */
const MODEL = process.env.AIEVAL_PROBE_PI_MODEL ?? process.env.AIEVAL_PROBE_CC_MODEL ?? 'DeepSeek-V4.1-Flash-a';

/** 单次提示词的墙钟上限：真机一轮问答够用，挂住时也能收场（超时本身就是读数）。 */
const PROMPT_TIMEOUT_MS = 180_000;

/** 本探针的工具白名单：只留 `read`——不让「模型自己去盘上找暗号」变成第三条解释。 */
const TOOLS = ['read'];

/** dump 根：`probe/dumps/v11/`（整个 dumps 已 gitignore）。 */
const DUMP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dumps', 'v11');

/** 统一进度前缀（v11 目录多支探针共用）。 */
function note(...parts) {
  console.log('[v11/pi]', ...parts);
}

const SECRETS = [process.env.AIEVAL_PROBE_GATEWAY_API_KEY].filter((one) => typeof one === 'string' && one.length >= 8);

/** 把已知凭据从产物里抹掉（读数会落盘，绝不带 key）。 */
function redact(value) {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) out = out.split(secret).join('***');
  return out;
}

function writeDump(name, payload) {
  const file = join(DUMP_DIR, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, redact(JSON.stringify(payload, null, 2)), 'utf8');
  return file;
}

function flagOf(name, fallback) {
  const hit = process.argv.find((one) => one.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/**
 * live 档要的凭据：**只从环境变量读**。
 * 缺哪一个就打印哪一个的名字并退出——不要回落到读宿主配置文件，那会让「跑不起来」看起来像「探测失败」。
 */
function requireCredential() {
  const key = process.env.AIEVAL_PROBE_GATEWAY_API_KEY;
  const baseUrl = process.env.AIEVAL_PROBE_GATEWAY_BASE_URL;
  const missing = [];
  if (typeof key !== 'string' || key === '') missing.push('AIEVAL_PROBE_GATEWAY_API_KEY');
  if (typeof baseUrl !== 'string' || baseUrl === '') missing.push('AIEVAL_PROBE_GATEWAY_BASE_URL');
  if (missing.length > 0) {
    note(`缺环境变量：${missing.join(' / ')} ⇒ 退出（本探针不走假上游，必须真机）。`);
    process.exit(2);
  }
  return { key, baseUrl };
}

/**
 * 装配一份与适配器同形的会话（`providers/pi/index.ts:606-742` 的窄版）：
 * 凭据只进内存（`InMemoryCredentialStore` + `modelsPath: null`）、注册一个逐行 provider、
 * 资源装载器**关掉扩展发现**（`noExtensions`，探测不需要那条面）。
 *
 * `manager` 由调用方给：这正是本探针的自变量（`open` / `create` / `continueRecent`）。
 */
async function assemble({ cwd, configHome, manager }) {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const { key, baseUrl } = requireCredential();

  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const providerId = 'aieval-pi-probe';
  runtime.registerProvider(providerId, {
    name: 'AIEval Gateway',
    baseUrl,
    api: 'anthropic-messages',
    models: [{
      id: MODEL,
      name: MODEL,
      api: 'anthropic-messages',
      baseUrl,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 8_192,
      compat: { supportsStrictTools: true },
    }],
  });
  await runtime.setRuntimeApiKey(providerId, key);
  const model = runtime.getModel(providerId, MODEL);

  const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: configHome,
    noExtensions: true,
    settingsManager,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => true });

  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: configHome,
    modelRuntime: runtime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    tools: TOOLS,
  });
  return { session, runtime, providerId };
}

/** 墙钟上限收场：厂商侧没有 park deadline，「挂住」这一档必须靠我们自己的预算（超时本身就是读数）。 */
async function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise.then(() => 'done', () => 'done'), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从原始事件流里抽「这一轮模型说了什么」：助手 `message_end` 是权威快照（正文在 `content[]` 的
 * `text` 块里）。`stopReason` / `errorMessage` 一起带上——pi 的 `prompt()` **永不抛**，
 * 失败只体现在这两格上，不看它们就会把「没答上来」误读成「模型选择不答」。
 */
function assistantTurnsOf(events) {
  const turns = [];
  for (const event of events) {
    if (event?.type !== 'message_end') continue;
    const message = event?.message;
    if (message?.role !== 'assistant') continue;
    const text = (Array.isArray(message.content) ? message.content : [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    turns.push({
      text,
      stopReason: message.stopReason ?? null,
      errorMessage: message.errorMessage ?? null,
    });
  }
  return turns;
}

/**
 * 跑一格。
 *
 * @param {object} input
 * @param {'write' | 'open' | 'continue' | 'fresh'} input.role `write` = 新会话并记住暗号；其余都是问回来。
 * @param {string} input.cwd 工作目录（同一行的各进程必须一致）。
 * @param {string} input.configHome 行配置目录（= 厂商 `agentDir`）。
 * @param {string | null} input.sessionDir 会话目录（`write` / `fresh` / `continue` 用）。
 * @param {string | null} input.sessionFile 要打开的会话文件（`open` 用）。
 * @param {string} input.nonce 随机暗号（`write` 要它；其余格用来判命中）。
 * @param {string} input.label 这一格的 dump 名（**每格必须不同**：同名会把上一格的读数覆盖掉）。
 */
async function runRole({ role, cwd, configHome, sessionDir, sessionFile, nonce, label }) {
  const sdk = await import('@earendil-works/pi-coding-agent');
  /** 自变量只有这一格：文件型 manager 的三条构造路径，加阴性对照的 `create`。 */
  const manager = role === 'open'
    ? sdk.SessionManager.open(sessionFile)
    : role === 'continue'
      ? sdk.SessionManager.continueRecent(cwd, sessionDir)
      : sdk.SessionManager.create(cwd, sessionDir);

  /**
   * **不花模型额度的那一格判据**：厂商自己从会话文件里投影出来的模型上下文里有没有暗号。
   *
   * 为什么要它：模型答复是端到端读数，但**它会抖**——代理模型偶发答「不知道」时，
   * 只看答复会把「机制坏了」与「模型这一把没答对」混成一条。投影是在 `prompt()` 之前读的、
   * 不经过模型，所以两者不一致时能立刻分辨是哪一层。
   */
  const projected = manager.buildSessionContext().messages.map((message) => ({
    role: message.role ?? null,
    text: typeof message.content === 'string'
      ? message.content
      : (Array.isArray(message.content) ? message.content : [])
        .map((block) => (block?.type === 'text' ? block.text : `[${block?.type ?? '?'}]`))
        .join(' '),
  }));
  // ⚠️ `nonce !== ''` 那一半不能省：空串是任何字符串的子串，省略它会让**每一格**都报「投影里有暗号」
  // （阴性对照因此假绿——这正是本探针要防的那类读数）。
  const projectionHasNonce = nonce !== '' && JSON.stringify(projected).includes(nonce);
  // 不给 `--nonce` 时那一格**读不出机制判据**（不是「投影里没有」）——要说出来，别让它静默显示成 `false`
  if (role !== 'write' && nonce === '') note(`${label}：没给 --nonce ⇒ 这一格的「投影含暗号」判据读不出（不是否）。`);

  const { session, runtime, providerId } = await assemble({ cwd, configHome, manager });
  const events = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  const prompt = role === 'write'
    ? `请记住这串暗号：${nonce}。只回复「记住了」三个字，不要复述暗号。`
    : '刚才我让你记的那串暗号是什么？只回复暗号本身；如果你没有这段记忆，就只回复「不知道」。';
  const outcome = await withTimeout(session.prompt(prompt), PROMPT_TIMEOUT_MS);
  unsubscribe();

  const turns = assistantTurnsOf(events);
  const reply = turns.map((turn) => turn.text).join('\n');
  const reading = {
    label,
    role,
    cwd,
    configHome,
    sessionDir,
    sessionFile,
    nonce,
    // 会话身份与落点：`sessionFile` 就是「文件型 manager」与我们今天 `inMemory()` 的唯一可见差别
    sessionId: session.sessionId,
    sessionFileAfter: session.sessionFile ?? null,
    isPersisted: manager.isPersisted(),
    defaultSessionDir: manager.getSessionDir(),
    headerCwd: manager.getHeader()?.cwd ?? null,
    entryCount: manager.getEntryCount(),
    // 机制层读数（`prompt` 之前取的）
    projectedMessageCount: projected.length,
    projectionHasNonce,
    projected,
    // 「恢复历史但装错了工具表」是这条路上的另一个坑，顺手读一份对照
    activeTools: session.getActiveToolNames(),
    outcome,
    turns,
    reply,
  };
  session.dispose();
  runtime.unregisterProvider(providerId);

  const file = writeDump(`pi-session-resume-${label}`, reading);
  note(`${role}(${label})：sessionFile = ${reading.sessionFileAfter ?? '(无)'}｜条目 ${reading.entryCount}｜投影 ${projected.length} 条（含暗号 ${projectionHasNonce ? '是' : '否'}）｜答复 = ${JSON.stringify(reply.slice(0, 200))}｜落盘 ${file}`);

  // 答复与落点走 stdout 的定式行，driver 只认这几行（其余是给人看的 noise）
  process.stdout.write(`SESSION_FILE=${reading.sessionFileAfter ?? ''}\n`);
  process.stdout.write(`SESSION_ID=${reading.sessionId ?? ''}\n`);
  process.stdout.write(`ENTRIES=${reading.entryCount}\n`);
  process.stdout.write(`PROJECTION_HAS_NONCE=${projectionHasNonce ? '1' : '0'}\n`);
  process.stdout.write(`REPLY=${reply.replaceAll('\n', ' ')}\n`);
  return reading;
}

const role = flagOf('role', 'driver');

/**
 * 单独一格：**不显式给 `sessionDir` 时厂商把会话落到哪**。
 *
 * 为什么要单起一个进程问它：`getDefaultSessionDir` **没有**从包出口导出（只在
 * `dist/core/session-manager.js:296` 与内部模块里），所以「默认落点」只能靠
 * `SessionManager.create(cwd)` 造一条 manager 再读 `getSessionDir()` —— 那正是 SDK 在
 * 调用方不给 `sessionManager` 时自己走的那一步（`dist/core/sdk.js:76`）。
 * 默认 agentDir 由 `PI_CODING_AGENT_DIR` 决定，所以这一格由调用方把该变量指到行配置目录，
 * **不碰真实家目录**。
 */
if (role === 'default-dir') {
  const cwd = flagOf('cwd', process.cwd());
  const sdk = await import('@earendil-works/pi-coding-agent');
  const manager = sdk.SessionManager.create(cwd);
  process.stdout.write(`DEFAULT_DIR=${manager.getSessionDir()}\n`);
  process.stdout.write(`AGENT_DIR_ENV=${process.env.PI_CODING_AGENT_DIR ?? ''}\n`);
} else if (role !== 'driver') {
  const cwd = flagOf('cwd', null);
  const configHome = flagOf('config-dir', null);
  const sessionDir = flagOf('session-dir', null);
  const sessionFile = flagOf('session-file', null);
  const nonce = flagOf('nonce', '');
  if (cwd === null || configHome === null) {
    note('单跑 role 时必须给 --cwd 与 --config-dir');
    process.exit(2);
  }
  if (role === 'open' && sessionFile === null) {
    note('role=open 必须给 --session-file');
    process.exit(2);
  }
  if (role !== 'open' && sessionDir === null) {
    note(`role=${role} 必须给 --session-dir`);
    process.exit(2);
  }
  await runRole({ role, cwd, configHome, sessionDir, sessionFile, nonce, label: flagOf('label', role) });
} else {
  /**
   * 两个「行目录」：`cwd` 是行工作区、`configHome` 是行配置目录、`sessionDir` 是会话落点。
   * **row2 刻意复用 row1 的 cwd**——这是隔离开关更难的那一半：证明「只把会话目录分开」就够，
   * 不需要 cwd 也不同。
   */
  const root = mkdtempSync(join(tmpdir(), 'aieval-v11-pi-resume-'));
  const row1 = join(root, 'row1');
  const row2 = join(root, 'row2');
  const cwd1 = join(row1, 'workspace');
  const cwd2 = join(row2, 'workspace');
  const cfg1 = join(row1, '.agenthome');
  const cfg2 = join(row2, '.agenthome');
  const dir1 = join(cfg1, 'sessions');
  const dir2 = join(cfg2, 'sessions');
  for (const dir of [cwd1, cwd2, cfg1, cfg2, dir1, dir2]) mkdirSync(dir, { recursive: true });

  const nonceA = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const nonceB = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const nonceC = `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  note(`row1 = ${row1}｜row2 = ${row2}（row2 刻意复用 row1 的 cwd = ${cwd1}）`);
  note(`会话目录 row1 = ${dir1}｜row2 = ${dir2}`);
  note(`暗号 A/B/C 全随机：写死一个词会被「猜中」污染判据`);

  /** 纯本地一格（不花模型额度）：厂商**默认**会话目录怎么派生——它取决于 agentDir × cwd 两格。 */
  const self = new URL(import.meta.url).pathname;
  const run = (args, env) => {
    const out = spawnSync(process.execPath, [self, ...args], { encoding: 'utf8', ...(env === undefined ? {} : { env }) });
    process.stdout.write(out.stdout ?? '');
    if ((out.status ?? 0) !== 0) process.stderr.write(out.stderr ?? '');
    const pick = (tag) => (out.stdout ?? '').split('\n').find((line) => line.startsWith(`${tag}=`))?.slice(tag.length + 1) ?? '';
    return {
      status: out.status,
      sessionFile: pick('SESSION_FILE'),
      sessionId: pick('SESSION_ID'),
      entries: Number(pick('ENTRIES') || 0),
      projectionHasNonce: pick('PROJECTION_HAS_NONCE') === '1',
      reply: pick('REPLY'),
      defaultDir: pick('DEFAULT_DIR'),
    };
  };
  /**
   * 默认落点这一格单起一个**独立的家目录**：`SessionManager.create(cwd)` 会把默认会话目录
   * `mkdirSync` 出来，指到 `cfg1` / `cfg2` 就会在真读数的那两个目录里多一个空子目录。
   * 三条读数覆盖两个轴：换家目录、换 cwd 各看一次。
   */
  const homeA = join(root, 'defaulthome-a');
  const homeB = join(root, 'defaulthome-b');
  mkdirSync(homeA, { recursive: true });
  mkdirSync(homeB, { recursive: true });
  const defaultDirRow1 = run([`--role=default-dir`, `--cwd=${cwd1}`], { ...process.env, PI_CODING_AGENT_DIR: homeA });
  const defaultDirSameCwdOtherHome = run([`--role=default-dir`, `--cwd=${cwd1}`], { ...process.env, PI_CODING_AGENT_DIR: homeB });
  const defaultDirSameHomeOtherCwd = run([`--role=default-dir`, `--cwd=${cwd2}`], { ...process.env, PI_CODING_AGENT_DIR: homeA });
  note(`厂商默认会话目录（homeA × cwd1）= ${defaultDirRow1.defaultDir}`);
  note(`厂商默认会话目录（homeB × cwd1）= ${defaultDirSameCwdOtherHome.defaultDir}`);
  note(`厂商默认会话目录（homeA × cwd2）= ${defaultDirSameHomeOtherCwd.defaultDir}`);

  const base1 = [`--cwd=${cwd1}`, `--config-dir=${cfg1}`, `--session-dir=${dir1}`];
  const base2 = [`--cwd=${cwd1}`, `--config-dir=${cfg2}`, `--session-dir=${dir2}`];
  const answered = (reply, nonce) => nonce !== '' && reply.includes(nonce);

  // ① 进程 A：文件型 manager 新建一条会话，记住暗号 A
  const writeA = run([`--role=write`, ...base1, `--label=a-write`, `--nonce=${nonceA}`]);
  // ② 进程 B：全新 node 进程，用 open(A 的会话文件) 问回来 —— 正面判据
  const readOpen = writeA.sessionFile === ''
    ? { status: null, sessionFile: '', sessionId: '', entries: 0, projectionHasNonce: false, reply: '' }
    : run([`--role=open`, `--cwd=${cwd1}`, `--config-dir=${cfg1}`, `--label=b-open-a`, `--nonce=${nonceA}`, `--session-file=${writeA.sessionFile}`]);
  // ③ 进程 C：同一 cwd、同一 sessionDir 里 `continueRecent` —— 此刻目录里只有 A 那条
  const continue1 = run([`--role=continue`, ...base1, `--label=c-continue-a`, `--nonce=${nonceA}`]);
  // ④ 进程 D：同一 cwd、同一 sessionDir、**不打开那个文件**而是 create 一条新的 —— 阴性对照
  const readFresh = run([`--role=fresh`, ...base1, `--label=d-fresh`]);
  // ⑤ 进程 E：同一 cwd + 同一 sessionDir 再写一条（模拟 retryRow 重建工作区），暗号 B
  const writeB = run([`--role=write`, ...base1, `--label=e-write-b`, `--nonce=${nonceB}`]);
  // ⑥ 进程 F：此刻目录里最新的是 B ⇒ `continueRecent` 取的是「最近一条」
  const continue2 = run([`--role=continue`, ...base1, `--label=f-continue-b`, `--nonce=${nonceB}`]);
  // ⑦ 进程 G/H：隔离格 —— **同一个 cwd**、换成 row2 的 sessionDir 写暗号 C，再在 row2 里 continue
  const writeC = run([`--role=write`, ...base2, `--label=g-write-c`, `--nonce=${nonceC}`]);
  const continue3 = run([`--role=continue`, ...base2, `--label=h-continue-c`, `--nonce=${nonceC}`]);

  /** 落点形状：目录里几个文件、多大、头一行是什么（「一眼看出历史在场」的判据）。 */
  const layoutOf = (dir) => readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((file) => statSync(file).isFile())
    .map((file) => {
      const stat = statSync(file);
      const firstLine = readFileSync(file, 'utf8').split('\n')[0] ?? '';
      let header = null;
      try {
        header = JSON.parse(firstLine);
      } catch {
        header = firstLine.slice(0, 200);
      }
      return { name: file.slice(dir.length + 1), bytes: stat.size, header: redact(header) };
    });

  const reading = {
    root,
    cwd1,
    cwd2,
    dir1,
    dir2,
    nonceA,
    nonceB,
    nonceC,
    defaultSessionDirRow1HomeA: defaultDirRow1.defaultDir,
    defaultSessionDirSameCwdOtherHome: defaultDirSameCwdOtherHome.defaultDir,
    defaultSessionDirSameHomeOtherCwd: defaultDirSameHomeOtherCwd.defaultDir,
    writeA,
    readOpen,
    readFresh,
    continue1,
    writeB,
    continue2,
    writeC,
    continue3,
    layoutRow1: layoutOf(dir1),
    layoutRow2: layoutOf(dir2),
    verdict: {
      openRestoredHistory: answered(readOpen.reply, nonceA),
      controlAnsweredNothing: !answered(readFresh.reply, nonceA) && !answered(readFresh.reply, nonceB)
        && !answered(readFresh.reply, nonceC),
      isolatedBySessionDir: answered(continue3.reply, nonceC)
        && !answered(continue3.reply, nonceA) && !answered(continue3.reply, nonceB),
      continueFollowedWhich: answered(continue1.reply, nonceA) ? 'A（唯一那条）' : '没续上 A',
      continueAfterRewriteFollowed: answered(continue2.reply, nonceB)
        ? 'B（最近一次）'
        : answered(continue2.reply, nonceA) ? 'A（更早那次）' : '都没续上',
      /**
       * 机制层（不花额度的那一格）：投影里有没有暗号，与模型答复**各自成立**才算数。
       * 投影有、答复没有 ⇒ 这一把是模型抖了，不是机制坏了；投影没有 ⇒ 机制真的没接上。
       */
      mechanismByProjection: {
        open: readOpen.projectionHasNonce,
        fresh: readFresh.projectionHasNonce,
        continueAfterFirstWrite: continue1.projectionHasNonce,
        continueAfterRewrite: continue2.projectionHasNonce,
        isolatedContinue: continue3.projectionHasNonce,
      },
    },
  };
  // ⚠️ 有 role 没跑起来时**既不落盘也不报判据**：`requireCredential` 的 loud-fail 只保证
  // 「不会静默回落到宿主配置」，拦不住「没跑成」被当成「探测失败」、更拦不住一份空读数在 dumps 里
  // 被下一次会话当真读数读。所以这一档以**非 0 退出码**收场，并且**不留读数**。
  const cells = [writeA, readOpen, readFresh, continue1, writeB, continue2, writeC, continue3];
  const broken = cells.filter((one) => one.status !== 0).length;
  const file = broken === 0 ? writeDump('pi-session-resume-reading', reading) : null;

  note('');
  note(`driver：${cells.map((one, index) => `${index + 1}=${one.status}`).join(' ')}`);
  note(`row1 会话目录：${reading.layoutRow1.map((one) => `${one.name}(${one.bytes}B)`).join('、') || '(空)'}`);
  note(`row2 会话目录：${reading.layoutRow2.map((one) => `${one.name}(${one.bytes}B)`).join('、') || '(空)'}`);
  const openSessionFile = existsSync(dir1) ? writeA.sessionFile : '';
  note(`open 打开的会话文件 = ${openSessionFile}`);
  if (file === null) {
    note(`⚠️ ${broken} 个 role 没跑起来 ⇒ **跑不起来 ≠ 探测失败**：读数作废、不落盘、退出码 2。`);
    process.exitCode = 2;
  } else {
    note(`读数落盘：${file}`);
    note('');
    note('判据（与 cc / dsh 那两支同形）：');
    note(`  ① 正面（open 会话文件把历史带回来了）：${reading.verdict.openRestoredHistory ? '成立' : '不成立'} —— 新进程用 open(A 的文件) 答${reading.verdict.openRestoredHistory ? '出' : '不出'}暗号 A`);
    note(`  ② 阴性对照（同 cwd + 同 sessionDir、只是不开那个文件）：${reading.verdict.controlAnsweredNothing ? '成立' : '不成立'} —— 必须一个暗号都答不出`);
    note(`  ③ 隔离（同 cwd、换 sessionDir）：${reading.verdict.isolatedBySessionDir ? '成立' : '不成立'} —— 只答出本目录那条的暗号 C`);
    note(`  ④ 附带格（同目录 continueRecent 续哪一次）：首次 ${reading.verdict.continueFollowedWhich}；重建后再续 ${reading.verdict.continueAfterRewriteFollowed}`);
    note(`  ⑤ 机制层对照（厂商自己投影出来的上下文里有没有暗号）：${JSON.stringify(reading.verdict.mechanismByProjection)}`);
    note('     ⑤ 与答复不一致时以 ⑤ 判机制、以答复判端到端；两者都成立才算「跨进程续接」闭合。');
    note('');
    note('② 不成立时 ① 的结论作废（那说明工作区或别的东西泄漏了暗号，不是转录起了作用）。');
  }
}
