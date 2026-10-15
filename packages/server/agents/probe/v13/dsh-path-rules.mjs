/**
 * v13 探针：厂商**会话日志落点的两条路径规则**——`projectKey(cwd)` 与 `encodeSegment(sessionId)`。
 *
 * 为什么要单独一支（不走适配器）：适配器的 `sessionId` 由 `mintSessionId()` 铸、形状恒是
 * `session-<32hex>`，**永远触发不了转义那一支**；而 `cwd` 在编排层那边由 `join()` 拼、也恒是
 * 规范化过的。要在真机上看到这两条规则，只能由这里**直接给**厂商一个带 `~` / 中文的会话 id
 * 与一个带尾随斜杠的 cwd。
 *
 * 判据是磁盘上真实出现的目录名（`<DSH_HOME>/sessions/`），不是任何一方文档。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeUpstream } from './lib/upstream.mjs';

/** 自定义会话 id：`~` 与中文都落在厂商「不安全码元走 `~XXXX`」那一档 */
const CUSTOM_SESSION_ID = 'probe~会话~id';
/** 工作区目录：含空格与中文（`projectKey` 的转义那一支） */
const WORKSPACE_LEAF = '工作 区';

/** 生成一份最小 overlay（与适配器 `buildDshRoutePatch` 的同名段逐字同形，去掉插件那几行）。 */
function buildOverlay(baseUrl) {
  return [
    '# v13 探针写入：路由 / 模型 / 档位',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      aieval-route:',
    '        api: anthropic-messages',
    `        baseURL: "${baseUrl}"`,
    '        apiKeyEnv: AIEVAL_ROUTE_API_KEY',
    '        models:',
    '          - id: "probe-model"',
    '            contextWindow: 131072',
    '            maxTokens: 8192',
    '            reasoningEfforts:',
    '              off: null',
    '              low: "low"',
    '              high: "high"',
    '              max: "max"',
    '',
  ].join('\n');
}

const root = mkdtempSync(join(tmpdir(), 'dsh-probe-v13-'));
const workspace = join(root, WORKSPACE_LEAF);
const configHome = join(root, '.dshhome');
mkdirSync(workspace, { recursive: true });
mkdirSync(configHome, { recursive: true });
// 尾随斜杠：SDK 在 `new HarnessSession` 之前就把 cwd 走了 `resolve(cwd)`；本行的 cwd 原样带斜杠
const cwdWithTrailingSlash = `${workspace}/`;
const overlayPath = join(configHome, 'aieval-route.patch.yml');
const upstream = await startFakeUpstream({ reply: '探针收尾。' });
writeFileSync(overlayPath, buildOverlay(upstream.url), { encoding: 'utf8', mode: 0o600 });

const env = { ...process.env, DSH_HOME: configHome, AIEVAL_ROUTE_API_KEY: 'probe-placeholder' };
delete env.DEEPSEEK_API_KEY;
delete env.DEEPSEEK_BASE_URL;

const sdk = await import('@deepseek-ai/dsh-sdk-client');
const harness = new sdk.DeepSeekHarness({
  cwd: cwdWithTrailingSlash,
  dshHome: configHome,
  processCwd: workspace,
  model: 'probe-model',
  provider: 'aieval-route',
  patches: [overlayPath],
  initializeTimeoutMs: 60_000,
  env,
});

const report = { root, workspace, cwdWithTrailingSlash, customSessionId: CUSTOM_SESSION_ID };
try {
  await harness.start();
  const session = harness.session(CUSTOM_SESSION_ID);
  const result = await session.run('回一句话就好。');
  report.result = { sessionId: result.sessionId, finalResponse: String(result.finalResponse ?? '').slice(0, 80) };
  report.effectiveCwd = await session.getWorkingDirectory();
} catch (error) {
  report.error = { name: error?.constructor?.name ?? typeof error, message: String(error?.message ?? error).slice(0, 400) };
} finally {
  try {
    await harness.close();
  } catch (error) {
    report.closeError = String(error?.message ?? error).slice(0, 200);
  }
  upstream.close();
}

const sessionsRoot = join(configHome, 'sessions');
report.sessionsTree = (() => {
  try {
    return readdirSync(sessionsRoot).map((dir) => ({ dir, sessions: readdirSync(join(sessionsRoot, dir)) }));
  } catch {
    return null;
  }
})();
report.upstreamRequests = upstream.records.length;

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`[probe] 保留现场：${root}\n`);
process.stdout.write(`[probe] 规范化后的 cwd = ${resolve(workspace)}\n`);
// 现场留给人工核对；清理交给调用方（`rmSync` 的具体路径就是上面打印出来的那个）
if (process.env.AIEVAL_PROBE_KEEP !== '1') {
  rmSync(root, { recursive: true, force: true });
  process.stdout.write('[probe] 已清理现场（AIEVAL_PROBE_KEEP=1 可保留）\n');
}
