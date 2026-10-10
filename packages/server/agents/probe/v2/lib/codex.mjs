/**
 * codex 真机探测的共享外壳：用**真实的 `@openai/codex-sdk`**（适配器唯一入口）跑一条任务，
 * 把 SDK 透传的 CLI 事件逐条落盘。
 *
 * 网关口径（本轮实测）：`http://likecode-llm-proxy-test.jd.com/v1`，`wire_api: 'responses'`，
 * 凭据走 `apiKey`（codex 的 `requires_openai_auth` 会把它变成 Bearer）。
 *
 * ⚠️ 与既有护栏口径**刻意不同**：本探测按"要看到什么就开什么"配置，
 * 因此默认把 `multi_agent`、`tools.update_plan.enabled`、`tools.experimental_request_user_input.enabled`、
 * `features.default_mode_request_user_input` 全开——探测的目的是**观察厂商会产出什么**，
 * 不是复述本仓当前的护栏。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendJsonl, note } from './gateway.mjs';

export const CODEX_BASE_URL = process.env.AIEVAL_V2_CODEX_BASE_URL ?? 'http://likecode-llm-proxy-test.jd.com/v1';
export const CODEX_API_KEY = process.env.AIEVAL_V2_CODEX_API_KEY ?? '96c7851a09d2618659786746e124a8f02b3f3a0f';
export const CODEX_MODEL = process.env.AIEVAL_V2_CODEX_MODEL ?? 'GPT-5.5';

/** 造一个最小工作区。 */
export function makeCodexWorkspace(tag = 'codex') {
  const root = mkdtempSync(join(tmpdir(), `aieval-v2-${tag}-`));
  writeFileSync(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
  writeFileSync(join(root, 'app.js'), "function greet(name) {\n  return 'hello ' + name;\n}\n", 'utf8');
  return root;
}

/** codex 的 provider 配置块（与适配器 `buildCodexConfig` 同形，但按探测需要打开开关）。 */
export function codexConfig({ extraTools = {}, extraFeatures = {}, baseUrl = CODEX_BASE_URL } = {}) {
  return {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval gateway',
        base_url: baseUrl,
        wire_api: 'responses',
        request_max_retries: 1,
        requires_openai_auth: true,
      },
    },
    disable_response_storage: true,
    tools: { web_search: false, ...extraTools },
    features: { multi_agent: false, ...extraFeatures },
  };
}

/**
 * 跑一条 codex 任务，返回 `{ events, types, error, threadId }`。
 *
 * 注意：SDK 的 `runStreamed` 对不可达/不可用的网关**没有上界**（实测），
 * 所以这里必须自带时限，否则探测会变成挂死。
 */
export async function runCodexProbe({
  label,
  prompt,
  workspace,
  model = CODEX_MODEL,
  config,
  timeoutMs = 300000,
  maxEvents = 800,
}) {
  const sdk = await import('@openai/codex-sdk');
  // CODEX_HOME 必须**先存在**：实测缺它时 CLI 直接以退出码 1 收场
  // （`CODEX_HOME points to "…", but that path does not exist`），SDK 一条事件都拿不到
  const codexHome = join(workspace, '..', `${label}-codex-home`);
  mkdirSync(codexHome, { recursive: true });
  const client = new sdk.Codex({
    apiKey: CODEX_API_KEY,
    baseUrl: CODEX_BASE_URL,
    config: config ?? codexConfig(),
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  const thread = client.startThread({
    model,
    workingDirectory: workspace,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
  });

  const abort = new AbortController();
  const events = [];
  let error = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);
  try {
    const { events: stream } = await thread.runStreamed(prompt, { signal: abort.signal });
    for await (const event of stream) {
      events.push(event);
      if (events.length >= maxEvents) break;
    }
  } catch (caught) {
    error = { name: caught?.constructor?.name ?? typeof caught, message: String(caught?.message ?? caught).slice(0, 1500) };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }

  const file = appendJsonl(`v2/${label}`, events);
  const types = new Map();
  for (const event of events) types.set(event?.type, (types.get(event?.type) ?? 0) + 1);
  note(`${label}：事件 ${events.length} 条 → ${file}`);
  note(`${label} 事件类型：`, JSON.stringify([...types]));
  if (error !== null) note(`${label} 抛错：`, error.name, error.message.slice(0, 300));
  if (timedOut) note(`${label} 触发 ${timeoutMs}ms 上限（已 abort）`);
  return { events, types: [...types], error, timedOut, model, file };
}

/** 打印事件里所有出现过的 `item.type` 与它们的字段形状（用于回答"落到哪个 item"）。 */
export function itemShapes(events) {
  const shapes = new Map();
  for (const event of events) {
    const item = event?.item;
    if (item === undefined) continue;
    const key = `${event?.type} + item.type=${item.type}`;
    if (!shapes.has(key)) shapes.set(key, { count: 0, keys: Object.keys(item), sample: item });
    shapes.get(key).count += 1;
  }
  return shapes;
}

/** 只保留目录名，避免把临时路径写进报告时误导读者。 */
export function shortPath(value) {
  return typeof value === 'string' ? dirname(value) : value;
}

/** SDK 自带的那一份 codex（0.156.1）——适配器 spawn 的就是它，不是 PATH 上的 0.154.0。 */
export const BUNDLED_CODEX_EXE = join(
  process.cwd(),
  '..',
  '..',
  '..',
  'node_modules',
  '.pnpm',
  '@openai+codex@0.156.1-win32-x64',
  'node_modules',
  '@openai',
  'codex',
  'vendor',
  'x86_64-pc-windows-msvc',
  'bin',
  'codex.exe',
);

/**
 * 用**CLI 路径**跑一条 codex 任务（`exec --json`，与适配器同一份二进制）。
 *
 * 为什么探测要走 CLI：经 SDK 时本机恒定失败于
 * `failed to initialize in-process app-server client: 拒绝访问。(os error 5)`
 * （与 claude 的 SDK 路径 EPERM 同源：本机进程树 + 沙箱对管道/命名管道的限制）。
 * CLI 路径拿到的仍是**厂商原文**（`--json` 的 JSONL），可用于回答 event/item 形状的问题。
 */
export function runCodexCli({
  label,
  prompt,
  workspace,
  model = CODEX_MODEL,
  baseUrl = CODEX_BASE_URL,
  extraConfig = {},
  timeoutMs = 600000,
}) {
  const codexHome = join(workspace, '..', `${label}-cli-codex-home`);
  mkdirSync(codexHome, { recursive: true });
  const config = {
    model_provider: 'aieval',
    'model_providers.aieval.name': 'aieval',
    'model_providers.aieval.base_url': baseUrl,
    'model_providers.aieval.wire_api': 'responses',
    'model_providers.aieval.requires_openai_auth': 'true',
    'model_providers.aieval.request_max_retries': '1',
    ...extraConfig,
  };
  const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', model];
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${value}`);
  args.push(prompt);

  let stdout = '';
  let stderr = '';
  let failure = null;
  try {
    stdout = execFileSync(BUNDLED_CODEX_EXE, args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_API_KEY: CODEX_API_KEY },
    });
  } catch (error) {
    failure = String(error?.message ?? error).slice(0, 400);
    stdout = String(error?.stdout ?? '');
    stderr = String(error?.stderr ?? '');
  }

  const events = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* `--json` 之外的行（进度/警告）忽略 */
    }
  }
  const types = new Map();
  for (const event of events) types.set(event?.type, (types.get(event?.type) ?? 0) + 1);
  note(`${label}：事件 ${events.length} 条；类型 ${JSON.stringify([...types])}`);
  if (failure !== null) note(`${label} CLI 异常：`, failure.slice(0, 200));
  if (stderr.trim() !== '') note(`${label} stderr 前 200 字：`, stderr.trim().slice(0, 200));
  return { events, types: [...types], failure, stderr, args, codexHome };
}
