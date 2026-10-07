/**
 * 真实事件探测（spec §5.6.3 的实施前置 / §11 第 5 步）。
 * 做什么：对指定的一家智能体跑一条最小任务，把**原始事件流**与**注入对象原文** dump 到 probe/dumps/。
 * 怎么跑（人工，需要真实凭据，会产生真实费用，每家只跑一次）：
 *   node packages/server/agents/probe/raw-events.mts --kind=claude-code
 *   node packages/server/agents/probe/raw-events.mts --kind=codex
 *   node packages/server/agents/probe/raw-events.mts --kind=dsh
 *   node packages/server/agents/probe/raw-events.mts --kind=dsh --mode=entry   # Step 0：只 dump 入口形态，不联网、不计费
 * 注意：
 *  - 本文件**不在** `src/` 下，因此不进 `pnpm typecheck` / `pnpm test`（单测一律不碰真实 API）；
 *  - 它刻意不 import 本包的实现：探测要看到未经我们投影的原始事件（字段名以它为准，§5.6.3）；
 *  - dump 里可能混进密钥：写盘前一律 redact（把密钥替换成 ***）；
 *  - Node 24 直接跑 .mts（类型剥离），不需要额外工具链；
 *  - `--mode=entry` 只 dump 静态入口形态（导出面 / 签名文本 / 通知外形），**不 spawn、不联网**，
 *    因此它可以在没有凭据的环境里跑（Step 0 的五问主要靠它）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DUMP_DIR = join(HERE, 'dumps');
const MAX_EVENTS = 500;
const SELF_REQUIRE = createRequire(import.meta.url);

interface ProbeEnv {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  cwd: string;
  prompt: string;
  /** 该行的独立配置目录（§5.6.4 不变量 3）。默认临时目录；`AIEVAL_PROBE_CONFIG_HOME` 可覆盖。 */
  configHome: string;
  /** 覆盖 HOME 的显式开关。默认关闭：**已登录的 CLI 靠真实的 `$HOME/<tool>` 找凭据**，
   *  换掉 HOME 会让三家一起变成「没登录」。开了会在 dump 的 `env.homeOverridden` 里留痕。 */
  overrideHome: boolean;
}

interface ProbeResult {
  injected: unknown;
  events: unknown[];
  notes?: string[];
}

// 三家的 base URL 口径（与 §5.6.4 的表一致；这里独立实现，避免探测依赖被测代码）
const trimSlash = (url: string): string => url.replace(/\/+$/, '');
const stripV1 = (url: string): string => trimSlash(url).replace(/\/v1$/, '');
const ensureV1 = (url: string): string => (/\/v1$/.test(trimSlash(url)) ? trimSlash(url) : `${trimSlash(url)}/v1`);
const keepV1 = (url: string): string => trimSlash(url);

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((raw) => raw.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

/**
 * 读一个环境变量：**先看该家专属的名字，再退回通用名字**。
 * 为什么需要专属名：三家的 wire 协议不同（Anthropic Messages / OpenAI Responses / Chat Completions 或
 * 厂商自有 route），同一个网关很难同时讲三种；本机实测的唯一可用网关只讲 `/v1/messages`。
 * 通用名（`AIEVAL_PROBE_BASE_URL` 等）仍然有效，专属名只是它的逐家覆盖。
 */
function readEnv(kind: string, name: string, fallback = ''): string {
  const scoped = process.env[`AIEVAL_PROBE_${name}_${kind.toUpperCase().replace(/-/g, '_')}`];
  if (scoped !== undefined && scoped !== '') return scoped;
  const shared = process.env[`AIEVAL_PROBE_${name}`];
  return shared === undefined || shared === '' ? fallback : shared;
}

function requireEnv(kind: string, name: string): string {
  const value = readEnv(kind, name);
  if (value === '') {
    console.error(`[probe] 缺少环境变量 AIEVAL_PROBE_${name}（或 AIEVAL_PROBE_${name}_${kind.toUpperCase().replace(/-/g, '_')}）`);
    process.exit(2);
  }
  return value;
}

/** 把密钥从产物里抹掉：dump 会被人打开看，也可能被贴进报告 */
function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret !== '') output = output.split(secret).join('***');
  }
  return output;
}

function writeDump(kind: string, payload: unknown, secrets: readonly string[]): string {
  mkdirSync(DUMP_DIR, { recursive: true });
  const file = join(DUMP_DIR, `${kind}.json`);
  writeFileSync(file, redact(JSON.stringify(payload, null, 2), secrets), 'utf8');
  return file;
}

/** 读安装态包的某个文件（Step 0 的「让真实包自己说话」）：找不到就返回一句可读的说明，不抛。 */
function readInstalledFile(packageName: string, relative: string): string {
  const entry = resolvePackageEntry(packageName);
  if (entry !== null) {
    // 从**入口**向上找包根，再拼相对路径：`exports` 没映射子路径时也能读到
    let dir = dirname(entry);
    for (let hop = 0; hop < 4; hop += 1) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const candidate = resolve(dir, relative);
        if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
        break;
      }
      dir = dirname(dir);
    }
  }
  const direct = tryResolve(`${packageName}/${relative.replace(/^\.\//, '')}`);
  if (direct !== null && existsSync(direct)) return readFileSync(direct, 'utf8');
  return `<不存在：${packageName}/${relative}>`;
}

/** 取一个包的精确安装版本与解析路径（「到底装的哪一个」是实测结论的一部分）。 */
function packageFacts(packageName: string, fromPackage?: string): Record<string, unknown> {
  // `require.resolve` 的 paths 选项要指向**真实路径**（pnpm 的 .pnpm 目录），指向符号链接根会解析失败
  const bases = fromPackage === undefined ? [] : [realPackageDir(fromPackage)];
  const manifestPath =
    tryResolve(`${packageName}/package.json`) ??
    (bases.length === 0 ? null : tryResolve(`${packageName}/package.json`, bases)) ??
    // 包的 `exports` 没映射 `./package.json` 时（claude / codex 的 SDK 都不映射）反推包目录
    (() => {
      const entry = resolvePackageEntry(packageName);
      if (entry === null) return null;
      // 入口在 <pkg>/dist/index.js 或 <pkg>/sdk.mjs 这类位置：向上找到带 package.json 的那一级
      let dir = dirname(entry);
      for (let hop = 0; hop < 4; hop += 1) {
        const candidate = join(dir, 'package.json');
        if (existsSync(candidate)) return candidate;
        dir = dirname(dir);
      }
      return null;
    })();
  if (manifestPath === null) return { error: `<无法解析 ${packageName}/package.json>` };
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    // 版本号必须是**这个包自己的**：反推包目录时可能落到上层目录
    if (manifest.name !== packageName) return { error: `反推到的 manifest 不是 ${packageName}（拿到 ${String(manifest.name)}）` };
    return { version: manifest.version, resolved: manifestPath, bin: manifest.bin ?? null };
  } catch (error) {
    return { error: String((error as Error).message).slice(0, 300) };
  }
}

/** 一个包的**真实目录**（解开 pnpm 的符号链接）。 */
function realPackageDir(packageName: string): string {
  const manifestPath = SELF_REQUIRE.resolve(`${packageName}/package.json`);
  return dirname(manifestPath);
}

/** `require.resolve` 的不会抛版本；`paths` 给了就按它解析（pnpm 传递依赖要这么做）。 */
function tryResolve(specifier: string, paths?: string[]): string | null {
  try {
    return paths === undefined ? SELF_REQUIRE.resolve(specifier) : SELF_REQUIRE.resolve(specifier, { paths });
  } catch {
    return null;
  }
}

/**
 * **ESM 的**解析（`import.meta.resolve`）。
 * 为什么需要它：codex 的 SDK 是 ESM-only（`exports` 只有 `import` 条件），`require.resolve` 对它一律
 * MODULE_NOT_FOUND —— 探测脚本是 ESM，只有 `import.meta.resolve` 才能看到它。
 */
function tryResolveEsm(specifier: string): string | null {
  try {
    const resolved = import.meta.resolve(specifier);
    return typeof resolved === 'string' && resolved !== '' ? fileURLToPath(resolved) : null;
  } catch {
    return null;
  }
}

/** 按「ESM 优先、CJS 兜底」解析一个包的入口。 */
function resolvePackageEntry(packageName: string): string | null {
  return tryResolveEsm(packageName) ?? tryResolve(packageName);
}

/** 读 .d.ts 里的指定符号块（Step 0 的「三个真实签名」）：逐字取原文，不做解释。 */
function extractDeclarations(source: string, pattern: RegExp, limit = 6): string[] {
  return source.split('\n').filter((line) => pattern.test(line)).slice(0, limit);
}

// ─────────────────────────────────────── claude-code ───────────────────────────────────────

async function probeClaudeCode(env: ProbeEnv): Promise<ProbeResult> {
  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query: (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown> & {
      interrupt?: () => unknown;
    };
  };
  const configHome = env.configHome;
  const injected = {
    env: {
      CLAUDE_CONFIG_DIR: configHome,
      ANTHROPIC_BASE_URL: stripV1(env.baseUrl),
      ANTHROPIC_API_KEY: env.apiKey,
      ANTHROPIC_AUTH_TOKEN: env.apiKey,
      homeOverridden: env.overrideHome,
    },
    options: { cwd: env.cwd, model: env.modelId, settingSources: [], maxTurns: 8 },
  };
  const query = sdk.query({
    prompt: env.prompt,
    options: {
      ...injected.options,
      // 默认保留宿主环境（凭据在宿主的 ~/.claude 与宿主 env 里）；覆盖项只加不删
      env: { ...process.env, ...injected.env },
      abortController: new AbortController(),
    },
  });
  const events: unknown[] = [];
  for await (const message of query) {
    events.push(message);
    if (events.length >= MAX_EVENTS) {
      await query.interrupt?.();
      break;
    }
  }
  return { injected, events };
}

// ─────────────────────────────────────── codex ───────────────────────────────────────

/** codex 需要一份**完整**的 model_providers 条目；这里按 §5.6.4 的注入口径构造。 */
function codexConfig(baseUrl: string, requiresOpenAiAuth: boolean): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    name: 'aieval gateway',
    base_url: baseUrl,
    wire_api: 'responses',
    request_max_retries: 1,
    ...(requiresOpenAiAuth ? { requires_openai_auth: true } : {}),
  };
  return {
    model_provider: 'aieval',
    model_providers: { aieval: provider },
    disable_response_storage: true,
    tools: { multi_agent: false, web_search: false },
  };
}

async function probeCodex(env: ProbeEnv): Promise<ProbeResult> {
  const sdk = (await import('@openai/codex-sdk')) as {
    Codex: new (options: Record<string, unknown>) => {
      startThread: (options: Record<string, unknown>) => {
        runStreamed: (
          prompt: string,
          options: { signal: AbortSignal },
        ) => Promise<{ events: AsyncIterable<unknown> }>;
      };
    };
  };
  const baseUrl = ensureV1(env.baseUrl);
  // `requires_openai_auth` 这一格由 `AIEVAL_PROBE_CODEX_OPENAI_AUTH=0` 关掉：第三方网关不需要它，
  // 且开着时 CLI 只认自己的 OpenAI 鉴权（§5.6.4 说「缺它不发 Bearer」是**针对 OpenAI 官方**的口径）。
  const requiresOpenAiAuth = readEnv('codex', 'CODEX_OPENAI_AUTH', '1') !== '0';
  const config = codexConfig(baseUrl, requiresOpenAiAuth);
  const threadOptions = {
    model: env.modelId,
    workingDirectory: env.cwd,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
  };
  const injected = {
    client: { baseUrl, config, requiresOpenAiAuth },
    env: {
      CODEX_HOME: env.configHome,
      homeOverridden: env.overrideHome,
    },
    thread: threadOptions,
  };
  // 先做一次**有界**的连通性探测：codex CLI 对不可达的网关会自己重试很久，
  // 没有这一步，「网关打不通」会以「整个探测脚本挂死」的形式出现（本机实测：>5 分钟无输出）。
  const notes: string[] = [];
  const probe = await reachable(baseUrl, Number(readEnv('codex', 'REACH_MS', '8000')));
  notes.push(`base_url 连通性：${probe}`);
  const client = new sdk.Codex({
    apiKey: env.apiKey,
    baseUrl,
    config,
    env: { ...process.env, ...injected.env },
  });
  const thread = client.startThread(threadOptions);
  const abort = new AbortController();
  const events: unknown[] = [];
  const budgetMs = Number(readEnv('codex', 'TIMEOUT_MS', '120000'));
  let timedOut = false;
  // 消费者：正常迭代直到流结束或达到 MAX_EVENTS
  const consume = (async (): Promise<void> => {
    const { events: stream } = await thread.runStreamed(env.prompt, { signal: abort.signal });
    for await (const event of stream) {
      events.push(event);
      if (events.length >= MAX_EVENTS) break;
    }
  })();
  const timer = (async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, budgetMs);
    });
    if (events.length === 0) timedOut = true;
    abort.abort();
  })();
  try {
    await Promise.race([consume, timer]);
  } catch (error) {
    notes.push(`事件流抛错：${String((error as Error)?.message ?? error).slice(0, 400)}`);
  } finally {
    abort.abort();
  }
  if (timedOut) notes.push(`事件流在 ${budgetMs}ms 内一条事件都没产出（abort 已发出）`);
  return { injected, events, notes };
}

/** 有界的连通性探测：给一个根地址发 HEAD/GET，返回一句可读结论（超时/拒绝/HTTP 码）。 */
async function reachable(baseUrl: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(baseUrl, { method: 'GET', signal: controller.signal });
    return `HTTP ${response.status}`;
  } catch (error) {
    return `不可达（${String((error as Error)?.message ?? error).slice(0, 160)}）`;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────── dsh ───────────────────────────────────────

async function probeDsh(env: ProbeEnv): Promise<ProbeResult> {
  const sdk = (await import('@deepseek-ai/dsh-sdk-client')) as Record<string, unknown>;
  // 第一件事：dump 真实出口面。探测脚本刻意不 import 本包的实现，所以「形状对不对」只能由它自己当场说清楚；
  // 初稿在这里断言 `sdk.createRuntime` 并调用它 —— 真实包没有这个导出，第一步就 TypeError（评审 H1）。
  const exportNames = Object.keys(sdk).sort();
  const Harness = sdk.DeepSeekHarness;
  if (typeof Harness !== 'function') {
    throw new Error(`[probe] dsh 出口面与 Step 0 的 dump 不符，实测导出：${exportNames.join(' / ')}`);
  }
  const notes: string[] = [];
  // 实测：本 SDK 的 `resolveDshLaunch` 只认 `dshBin` / `profile` / `patches` / `dshHome` / `processCwd` / `env`；
  // **没有** `DEEPSEEK_BASE_URL` 这一格（`lib/index.js:161-190` 逐行核过）——route 由 CLI 自己的
  // `--profile sdk` 与它自己的 LLM 适配器决定。因此下面不再注入 `DEEPSEEK_BASE_URL`（注了也不会被读）。
  notes.push(
    'route 不由环境变量决定：SDK 的 resolveDshLaunch 只把 env 透传给子进程，base URL 来自 dsh 自身的 profile/适配器',
  );
  // 实测（四格对照，见探测报告 §5）：`dshHome` 一旦指向空目录，凭据库里就没有 key，
  // 运行会以 `turn/end(kind:'error')` 收场（`llm-deepseek: no API key for provider route "deepseek-official"`）；
  // 此时**只有环境变量 `DEEPSEEK_API_KEY` 能救**（格 3 成功、格 2 失败）。这正是 §5.6.4 不变量 3
  // （每行独立 configHome）与 dsh 凭据落点的真实交互，必须显式注入。
  const dshApiKey = readEnv('dsh', 'DEEPSEEK_API_KEY');
  const injected = {
    env: {
      DSH_HOME: env.configHome,
      homeOverridden: env.overrideHome,
      DEEPSEEK_API_KEY: dshApiKey === '' ? '<未提供>' : '<已注入>',
    },
    options: {
      cwd: env.cwd,
      model: env.modelId,
      dshHome: env.configHome,
      processCwd: env.cwd,
      // provider 由 `AIEVAL_PROBE_DSH_PROVIDER` 指定；不给就让 SDK 用它自己的默认值（`deepseek-official`）
      ...(readEnv('dsh', 'DSH_PROVIDER') === '' ? {} : { provider: readEnv('dsh', 'DSH_PROVIDER') }),
    },
  };
  const events: unknown[] = [];
  const harness = new (Harness as new (options: Record<string, unknown>) => {
    run: (input: string, options: Record<string, unknown>) => Promise<unknown>;
    close: () => Promise<void>;
    client?: { subscribe?: unknown };
  })({
    ...injected.options,
    // `env` 是「整体替换父进程环境」语义（lib/types/types.d.ts）⇒ 展开宿主环境后覆盖注入项
    env: {
      ...process.env,
      ...injected.env,
      ...(dshApiKey === '' ? {} : { DEEPSEEK_API_KEY: dshApiKey }),
    },
  });
  let runResult: unknown = null;
  let runError: unknown = null;
  try {
    runResult = await harness.run(env.prompt, {
      onNotification: (notification: unknown) => {
        if (events.length < MAX_EVENTS) events.push(notification);
      },
    });
  } catch (error) {
    // 失败通道也 dump：Step 2 判定标准第 5 条要的正是「一次失败的运行长什么样」
    runError = {
      name: (error as Error)?.constructor?.name ?? typeof error,
      message: String((error as Error)?.message ?? error).slice(0, 2000),
      code: (error as { code?: unknown })?.code ?? null,
    };
  } finally {
    // dsh 没有中途取消（`cancelMidTurn: false`，SDK 的 close JSDoc 写着没有 wire-level cancel）：
    // 结束探测靠关闭运行时（否则会留下孤儿子进程）
    try {
      await harness.close();
    } catch (error) {
      notes.push(`close() 抛错：${String((error as Error)?.message ?? error).slice(0, 300)}`);
    }
  }
  // RunResult 本身也要 dump：失败可能写在它上面（例如 `finalResponse` 为空、`events` 里有失败态），
  // 而不是一条失败通知——这正是 Step 2 判定标准第 5 条要核的事（评审 L2）
  events.push({ __runResult: runResult, __runError: runError, __exportNames: exportNames });
  return { injected, events, notes };
}

// ─────────────────────────────────────── Step 0：入口形态 ───────────────────────────────────────

/**
 * Step 0：先 dump 真实入口形态，**不 spawn、不联网**。
 * 回答计划里 Step 0 的五问；产出的 `dumps/<kind>-entry.json` 就是 Task 12 回写的依据。
 */
async function entryDump(kind: string): Promise<void> {
  const notes: string[] = [];
  const payload: Record<string, unknown> = { kind, mode: 'entry', at: new Date().toISOString() };

  if (kind === 'dsh') {
    const moduleNamespace = (await import('@deepseek-ai/dsh-sdk-client')) as Record<string, unknown>;
    const exportNames = Object.keys(moduleNamespace).sort();
    const apiTypes = readInstalledFile('@deepseek-ai/dsh-sdk-client', 'lib/types/api.d.ts');
    const clientTypes = readInstalledFile('@deepseek-ai/dsh-sdk-client', 'lib/types/client.d.ts');
    const typesTypes = readInstalledFile('@deepseek-ai/dsh-sdk-client', 'lib/types/types.d.ts');
    const launchTypes = readInstalledFile('@deepseek-ai/dsh-sdk-client', 'lib/types/launch.d.ts');
    // 传递依赖（pnpm 把它们平铺在 sdk-client 自己的 node_modules 兄弟位）：
    // 只有从 sdk-client 的**真实解析路径**出发才找得到，从本脚本出发一律 MODULE_NOT_FOUND。
    const siblingTypes = (packageName: string, relative: string): string => {
      try {
        const clientManifest = SELF_REQUIRE.resolve('@deepseek-ai/dsh-sdk-client/package.json');
        const file = resolve(dirname(clientManifest), '..', packageName, relative);
        return existsSync(file) ? readFileSync(file, 'utf8') : `<不存在：${file}>`;
      } catch (error) {
        return `<解析失败：${String((error as Error).message).slice(0, 200)}>`;
      }
    };
    const protocolTypes = siblingTypes('dsh-sdk-protocol', join('lib', 'types', 'types.d.ts'));
    const sessionTypes = siblingTypes('dsh-session', join('lib', 'types', 'types.d.ts'));
    const llmTypes = siblingTypes('dsh-llm', join('lib', 'types', 'types.d.ts'));
    payload.exports = exportNames;
    payload.packageFacts = {
      client: packageFacts('@deepseek-ai/dsh-sdk-client'),
      // dsh CLI 是 SDK 的**同版本**依赖：SDK 自己 spawn 的就是它（`resolveDshLaunch` 走
      // `installedDshNodeLaunch()` ⇒ `@deepseek-ai/dsh` 的 bin）。版本不匹配会被 SDK 当场拒绝。
      dsh: packageFacts('@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-client'),
      session: packageFacts('@deepseek-ai/dsh-session', '@deepseek-ai/dsh-sdk-client'),
      llm: packageFacts('@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-sdk-client'),
    };
    payload.question1_valueExports = {
      actual: exportNames,
      createRuntimePresent: exportNames.includes('createRuntime'),
      repoAssumptionMatches: exportNames.includes('createRuntime'),
    };
    payload.question2_signatures = {
      'DeepSeekHarness constructor / run / close':
        extractDeclarations(apiTypes, /constructor\(options|run\(input|close\(\)|get client\(|start\(\)/) ?? [],
      'RunOptions.onNotification': extractDeclarations(apiTypes, /RunOptions|onNotification/),
      'HarnessClient.subscribe / close': extractDeclarations(clientTypes, /subscribe\(|close\(\)|subscribeSessionTree/),
      'NotificationSubscription': extractDeclarations(clientTypes, /next\(\)|tryNext\(\)|interface NotificationSubscription/),
      'DeepSeekHarnessOptions / HarnessClientOptions': extractDeclarations(typesTypes, /^\s{4}\w+\??:/).slice(0, 24),
      'resolveDshLaunch（真实实现）': extractDeclarations(launchTypes, /resolveDshLaunch|installedDshBin|resolveDshNodeLaunch/),
    };
    payload.question3_notification_shape = {
      HarnessNotification: extractDeclarations(typesTypes, /interface HarnessNotification|method:|params:/),
      RunResult: extractDeclarations(typesTypes, /interface RunResult|sessionId|finalResponse|events:|notifications:/),
    };
    payload.question4_failureChannel = {
      notificationMethods: extractDeclarations(protocolTypes, /^\s*'[a-z.]+':/),
      errorClasses: extractDeclarations(clientTypes, /class \w*Error|There is no wire-level cancel/),
      RunResultMarkers: extractDeclarations(typesTypes, /finalResponse|empty when none/),
      turnEndReasons: extractDeclarations(sessionTypes, /kind: '(completed|aborted|blocked|error|max-tokens|interrupted|forked)'/),
      // 用量载荷的真正落点：`session.event` 的 event.type === 'assistant/message' 上的 `usage?: TokenUsage`
      sessionEventUsageSite: extractDeclarations(sessionTypes, /usage\?: TokenUsage|interface SessionEventMap|'assistant\/message'|'turn\/end'/),
      tokenUsageShape: extractDeclarations(llmTypes, /inputTokens|outputTokens|cacheReadTokens|cacheWriteTokens|reasoningTokens|totalTokens/),
    };
    payload.question5_injectionSites = {
      clientOptions: extractDeclarations(typesTypes, /dshBin\?|profile\?|patches\?|dshHome\?|processCwd\?|env\?|initializeTimeoutMs\?|requestTimeoutMs\?|shutdownTimeoutMs\?|disposeEofGraceMs\?|disposeGraceMs\?/),
      harnessOptions: extractDeclarations(typesTypes, /cwd\?|provider\?|model\?|reasoningEffort\?|maxTokens\?/),
      envSemantics: extractDeclarations(typesTypes, /replaces the parent environment|reads that object at spawn/),
      launchImplementation: extractDeclarations(
        readInstalledFile('@deepseek-ai/dsh-sdk-client', 'lib/index.js'),
        /resolveDshLaunch|dshHome|DSH_HOME|profile =|installedDshNodeLaunch/,
        12,
      ),
    };
  } else if (kind === 'claude-code') {
    const moduleNamespace = (await import('@anthropic-ai/claude-agent-sdk')) as Record<string, unknown>;
    payload.exports = Object.keys(moduleNamespace).sort();
    payload.packageFacts = packageFacts('@anthropic-ai/claude-agent-sdk');
    payload.typesDirectory = readInstalledFile('@anthropic-ai/claude-agent-sdk', 'sdk.d.ts').slice(0, 4000);
  } else if (kind === 'codex') {
    const moduleNamespace = (await import('@openai/codex-sdk')) as Record<string, unknown>;
    payload.exports = Object.keys(moduleNamespace).sort();
    payload.packageFacts = packageFacts('@openai/codex-sdk');
    payload.typesDirectory = readInstalledFile('@openai/codex-sdk', 'dist/index.d.ts').slice(0, 4000);
  } else {
    console.error(`[probe] --mode=entry 不支持 --kind=${kind}`);
    process.exit(2);
  }

  payload.notes = notes;
  const file = writeDump(`${kind}-entry`, payload, [process.env.AIEVAL_PROBE_API_KEY ?? '']);
  console.log(`[probe] ${kind} 入口形态 → ${file}（${JSON.stringify(payload.exports ?? [])}）`);
}

// ─────────────────────────────────────── 入口 ───────────────────────────────────────

const PROBES: Record<string, (env: ProbeEnv) => Promise<ProbeResult>> = {
  'claude-code': probeClaudeCode,
  codex: probeCodex,
  dsh: probeDsh,
};
const ENTRY_KINDS = ['claude-code', 'codex', 'dsh'];

const kind = readArg('kind') ?? 'claude-code';
const mode = readArg('mode') ?? 'events';

if (mode === 'entry') {
  const kinds = ENTRY_KINDS.includes(kind) ? [kind] : ENTRY_KINDS;
  for (const one of kinds) await entryDump(one);
  process.exit(0);
}

const probe = PROBES[kind];
if (probe === undefined) {
  console.error(`[probe] 未知的 --kind=${kind}；可选：${Object.keys(PROBES).join(' / ')}`);
  process.exit(2);
}

const env: ProbeEnv = {
  baseUrl: readEnv(kind, 'BASE_URL'),
  apiKey: readEnv(kind, 'API_KEY'),
  modelId: requireEnv(kind, 'MODEL'),
  cwd: requireEnv(kind, 'CWD'),
  prompt: readEnv(kind, 'PROMPT', '回答一个字：好。不要调用任何工具，不要写文件。'),
  configHome:
    readEnv(kind, 'CONFIG_HOME') === ''
      ? mkdtempSync(join(tmpdir(), 'aieval-probe-'))
      : readEnv(kind, 'CONFIG_HOME'),
  overrideHome: readEnv(kind, 'OVERRIDE_HOME', '0') === '1',
};

const result = await probe(env);
const file = writeDump(
  kind,
  {
    kind,
    at: new Date().toISOString(),
    baseUrl: env.baseUrl,
    modelId: env.modelId,
    cwd: env.cwd,
    configHome: env.configHome,
    homeOverridden: env.overrideHome,
    injected: result.injected,
    notes: result.notes ?? [],
    eventCount: result.events.length,
    events: result.events,
  },
  [env.apiKey],
);

const counts = new Map<string, number>();
for (const event of result.events) {
  const event_ = event as { type?: unknown; method?: unknown };
  const type =
    typeof event_.method === 'string'
      ? `method:${event_.method}`
      : typeof event_.type === 'string'
        ? String(event_.type)
        : '<无 type/method>';
  counts.set(type, (counts.get(type) ?? 0) + 1);
}
const rawText = JSON.stringify(result.events);
console.log(`[probe] ${kind}：${result.events.length} 条事件 → ${file}`);
console.log('[probe] 事件类型分布（原样粘进探测报告的「实测事件类型」一节）：');
for (const [type, count] of counts) console.log(`  ${type} × ${count}`);
console.log(`[probe] 事件流里出现 "usage"：${rawText.includes('usage')}；出现 "token"：${rawText.includes('token')}`);
