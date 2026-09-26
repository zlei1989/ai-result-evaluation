/**
 * `wire_api` 的取值矩阵：codex 到底还认哪些值？
 *
 * 背景：`wire_api = "chat"` 被 0.154.0 **直接拒绝**（配置校验阶段就失败，与网络无关）：
 *   `Error loading config.toml: `wire_api = "chat"` is no longer supported.`
 *   `How to fix: set `wire_api = "responses"` in your provider config.`
 * ⇒ 必须回答两件事，缺一条结论就不成立：
 *   ① **适配器实际 spawn 的那份**（`@openai/codex-sdk` 自带的 0.156.1）是不是也一样拒绝？
 *   ② 有没有**别的拼写**能走 chat（`chat_completions` / `openai` / `openai-chat` / `completions`）？
 *
 * 判据：**配置校验的通过与否**（跑 `codex exec` 时 CLI 会在校验阶段就失败或继续），
 * 与网络无关 ⇒ 可在不花模型调用的前提下逐值判定。
 *
 * 用法：node probe/v4/codex-wire-api-matrix.mjs
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { note, writeDump } from './lib/env.mjs';
import { buildExecArgs, spawnCapture } from './lib/codex-exec.mjs';

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const SCRATCH = join(REPO, 'packages', 'server', 'agents', 'probe', 'dumps', 'v4', 'tmp', 'wire-matrix');
mkdirSync(SCRATCH, { recursive: true });

const EXES = {
  '0.154.0（全局 CLI）': 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
  '0.156.1（SDK 自带 = 适配器实际用的那份）': 'D:\\zhanglei1120\\Github\\ai-result-evaluation\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
};

/** 候选拼写：已知被拒的那个 + 几种可能的别名 + 已知可用的对照。 */
const VALUES = ['chat', 'chat_completions', 'openai', 'openai-chat', 'completions', 'responses'];

const results = [];
for (const [exeLabel, exe] of Object.entries(EXES)) {
  for (const value of VALUES) {
    const caseDir = join(SCRATCH, `${exeLabel.replace(/[^A-Za-z0-9-]/g, '_')}-${value}`);
    const cwd = join(caseDir, 'cwd');
    const home = join(caseDir, 'home');
    for (const dir of [cwd, home]) mkdirSync(dir, { recursive: true });

    const args = buildExecArgs({
      config: {
        model_provider: 'aieval',
        model_providers: {
          aieval: {
            name: 'probe',
            // 故意指向**不可达**的地址：本脚本只判"配置校验过不过"，不判网络
            base_url: 'http://127.0.0.1:1/v1',
            wire_api: value,
            requires_openai_auth: true,
            request_max_retries: 1,
          },
        },
      },
      model: 'probe-model',
      sandboxMode: 'danger-full-access',
      cwd,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
    });

    const run = await spawnCapture(exe, args, { env: { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home }, cwd, timeoutMs: 60_000, stdin: 'say ok' });
    const stderr = run.stderrLines.join('\n');
    const rejected = /is no longer supported|unknown variant|invalid value|Error loading config/i.test(stderr);
    const row = {
      exe: exeLabel,
      wireApi: value,
      exitCode: run.exitCode,
      configRejected: rejected,
      // 只留判据相关的一行，避免把整个 stderr 塞进 dump
      reason: (stderr.split('\n').find((line) => /no longer supported|unknown variant|invalid value|Error loading config/i.test(line)) ?? '').slice(0, 200),
    };
    results.push(row);
    note(`${exeLabel.split('（')[0]} ${value.padEnd(18)} exit=${String(run.exitCode).padEnd(4)} 配置被拒=${rejected ? '是' : '否'} ${row.reason.slice(0, 80)}`);
  }
}

const chatAccepted = results.filter((r) => /chat|completions|openai/i.test(r.wireApi) && r.wireApi !== 'openai-chat' ? !r.configRejected : false);
const onlyResponses = results.every((r) => (r.wireApi === 'responses' ? !r.configRejected : r.configRejected));

const verdict = onlyResponses
  ? '**只有 `responses` 被接受**：chat 及其所有候选拼写在**两份二进制**上都被配置校验**直接拒绝**'
    + ' ⇒ "改成 chat 接口"在本机 codex 上**不可行**（会让每一次运行都在启动阶段失败）'
  : `有非 responses 取值被接受：${JSON.stringify(results.filter((r) => r.wireApi !== 'responses' && !r.configRejected))}`;
note('判定：', verdict);

const file = writeDump('v4/codex-wire-api-matrix', {
  at: new Date().toISOString(),
  note: 'base_url 故意不可达：本脚本只判配置校验，不判网络。',
  values: VALUES,
  results,
  chatAccepted,
  onlyResponses,
  verdict,
});
note('落盘：', file);
