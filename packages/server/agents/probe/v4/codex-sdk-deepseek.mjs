/**
 * v4 Q1b：用**适配器真正用的那条路**（`@openai/codex-sdk@0.156.1` 的 `Codex` → `startThread` →
 * `runStreamed`）跑真实 turn，看它现在能不能起来。
 *
 * Q1a 已把范围收窄到「exe 侧 × home 侧」：
 *   仓库内 exe + 仓库外 home ❌ ｜ 仓库外 exe + 任意 home ✅ ｜ 仓库内 exe + 仓库内 home ✅
 * 所以这里按四格各跑一次（一次只动一个变量），每格都记：抛没抛、抛的原文、收到几条事件、退出码。
 *
 * 用法：node probe/v4/codex-sdk-deepseek.mjs
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, spawnCapture } from './lib/codex-exec.mjs';
import { DEEPSEEK_OPENAI_BASE_URL, appendJsonl, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const VENDOR = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc`;
const SDK_EXE = join(VENDOR, 'bin', 'codex.exe');
/** 仓库外的整棵 vendor 副本（由 `codex-156-exe-location.mjs` 复制并验证可跑）。 */
const OUTSIDE_EXE = 'D:\\zhanglei1120\\v4probe-outside\\vendor156\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const STAGE = join(HERE, '..', 'dumps', 'v4', 'tmp');
const OUTSIDE = 'D:\\zhanglei1120\\v4probe-outside\\sdk';
const key = loadDeepSeekKey();

const { Codex } = await import('@openai/codex-sdk');

function config() {
  return {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval deepseek',
        base_url: DEEPSEEK_OPENAI_BASE_URL,
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    tools: { web_search: false, update_plan: { enabled: true } },
    features: { multi_agent: false },
  };
}

const results = { at: new Date().toISOString(), sdkVersion: null, binaries: { sdkExe: SDK_EXE, outsideExe: OUTSIDE_EXE }, cases: [] };
results.binaries.sdkExeExists = existsSync(SDK_EXE);
results.binaries.outsideExeExists = existsSync(OUTSIDE_EXE);

const sdkPkg = await import('node:module').then(({ createRequire }) => {
  const require = createRequire(import.meta.url);
  return require('@openai/codex-sdk/package.json');
}).catch(() => null);
results.sdkVersion = sdkPkg?.version ?? '（package.json 拿不到：exports 未导出，属预期）';

/** 一次 SDK turn：返回「抛没抛 / 抛的原文 / 事件条数 / 事件 type 序列 / usage 原文」。 */
async function sdkTurn(name, { model, home, cwd, codexPathOverride, features = { multi_agent: false }, timeoutMs = 240_000 }) {
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const env = buildEnv({ codexHome: home, apiKey: key });
  const caseOut = { name, model, home, cwd, codexPathOverride: codexPathOverride ?? null, threw: null, events: 0, eventTypes: [], itemTypes: [], usageRaw: null, eventRecords: [] };
  try {
    const codex = new Codex({
      apiKey: key,
      baseUrl: DEEPSEEK_OPENAI_BASE_URL,
      config: { ...config(), features },
      env,
      ...(codexPathOverride ? { codexPathOverride } : {}),
    });
    const thread = codex.startThread({
      model,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      workingDirectory: cwd,
    });
    const run = await thread.runStreamed('用一句话回答：1+1 等于几？', { signal: AbortSignal.timeout(timeoutMs) });
    for await (const event of run.events) {
      caseOut.events += 1;
      caseOut.eventTypes.push(event?.type ?? 'unknown');
      if (event?.item?.type) caseOut.itemTypes.push(event.item.type);
      if (event?.type === 'turn.completed') caseOut.usageRaw = event.usage ?? null;
      caseOut.eventRecords.push({ case: name, event });
    }
    caseOut.threw = null;
  } catch (error) {
    caseOut.threw = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
  }
  appendJsonl('v4/codex-sdk-events', caseOut.eventRecords.map((one) => one.event));
  note(`SDK 用例 ${name} →`, caseOut.threw ? `抛错：${caseOut.threw.name}` : '未抛错', `事件=${caseOut.events}`);
  if (caseOut.threw) note('   原文：', caseOut.threw.message.slice(0, 400));
  results.cases.push(caseOut);
  return caseOut;
}

// ① 适配器的真实形状：SDK 自己找 exe（仓库内那份）+ CODEX_HOME 在 %TEMP% 之外还是之内？——这里用 C: 盘 TEMP 之外的用户目录
await sdkTurn('① SDK 默认 exe + home 在 C: 用户目录', {
  model: 'deepseek-chat',
  home: 'C:\\Users\\zhanglei1120\\.codex-v4sdk\\home',
  cwd: 'C:\\Users\\zhanglei1120\\.codex-v4sdk\\cwd',
});

// ② 适配器的真实形状 + 把 scratch 放到工作区做对照（对应 Q1a 的「仓库内 exe + 仓库内 home ✅」）
await sdkTurn('② SDK 默认 exe + home 在仓库内', {
  model: 'deepseek-chat',
  home: join(STAGE, 'sdk-home'),
  cwd: join(STAGE, 'sdk-cwd'),
});

// ③ codexPathOverride 指向仓库外的副本 + home 在仓库外（可达的绕行）
await sdkTurn('③ codexPathOverride=仓库外副本 + home 在仓库外', {
  model: 'deepseek-chat',
  home: join(OUTSIDE, 'home'),
  cwd: join(OUTSIDE, 'cwd'),
  codexPathOverride: OUTSIDE_EXE,
});

// ④ 模型名换成 gpt-5.5（题面要求试的第二个模型名；SDK 默认 exe + 仓库内 home）
await sdkTurn('④ 模型 gpt-5.5（SDK 默认 exe + 仓库内 home）', {
  model: 'gpt-5.5',
  home: join(STAGE, 'sdk-home-gpt55'),
  cwd: join(STAGE, 'sdk-cwd-gpt55'),
});

const file = writeDump('v4/codex-sdk-deepseek', results);
note('落盘：', file);
