/**
 * v4：0.156.1 `exec` 起不来的**位置假设**矩阵。
 *
 * 已证：
 *   · 0.156.1 `exec` 必失败（`os error 5`），且失败后它的 `$CODEX_HOME` **一个文件都没建**；
 *   · 0.154.0 在同一 cwd/env/argv 形态下把 `$CODEX_HOME` 写得满满当当（state_5.sqlite 等）；
 *   · 目录 ACL 是 `zhanglei1120: FullControl`，`cmd`/node 都写得进去。
 *   · RUST_LOG=trace 里 0.156.1 自己报：`failed to open state db at …\home\state_5.sqlite: … (code: 14) unable to open database file`
 *     以及更早的 `WARNING: proceeding, even though we could not create PATH aliases: 拒绝访问。 (os error 5)`。
 *
 * ⇒ 要分辨的是「**它写不进去**」还是「**它想写的地方不存在/被自己拒绝**」。本脚本一次只动一个变量：
 *   ① $CODEX_HOME 在系统 TEMP（基线，已知失败）；
 *   ② $CODEX_HOME 在**非临时**的稳定目录（用户目录 / 仓库下 probe/dumps/v4/tmp）；
 *   ③ 预建 `state_5.sqlite`（空文件）后再跑 —— 若错误变成别的，说明卡点在「创建」而不是「打开」；
 *   ④ 把整棵 `vendor\x86_64-pc-windows-msvc` **复制**到普通目录再跑（分辨「exe 所在位置」是否有份）。
 *
 * 用法：node probe/v4/codex-156-home-matrix.mjs
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const V156 = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const VENDOR = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc`;
/** 允许的产物根：`probe/dumps/v4/`（gitignored）。 */
const DUMP_ROOT = join(HERE, '..', 'dumps', 'v4');
const STAGE = join(DUMP_ROOT, 'tmp');

const key = loadDeepSeekKey();
const results = { at: new Date().toISOString(), cases: [] };

function config() {
  return {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval deepseek',
        base_url: 'https://api.deepseek.com/v1',
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    tools: { web_search: false },
    features: { multi_agent: false },
  };
}

async function runCase(name, { exe = V156, home, cwd, precreateStateDb = false, timeoutMs = 150_000 }) {
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (precreateStateDb) {
    for (const one of ['state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm']) {
      const file = join(home, one);
      if (!existsSync(file)) writeFileSync(file, '', 'utf8');
    }
  }
  const args = buildExecArgs({
    config: config(),
    model: 'deepseek-chat',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    cwd,
    skipGitRepoCheck: true,
  });
  args.push('reply with the single word: ok');
  const run = await spawnCapture(exe, args, {
    env: buildEnv({ codexHome: home, apiKey: key }),
    cwd,
    timeoutMs,
  });
  const singleLine = (text) => text.split(/\r?\n/).filter((one) => one.trim() !== '').join(' | ');
  const caseOut = {
    name,
    exe: exe === V156 ? '0.156.1' : '0.154.0',
    home,
    cwd,
    precreateStateDb,
    ...summarize(run, 8),
    stderrOneLine: singleLine(run.stderr),
    stdoutLines: run.stdoutLines,
    homeCreated: existsSync(home) ? readdirSync(home) : null,
    ok: run.exitCode === 0 && run.stdoutLines.length > 0,
  };
  note(`用例 ${name} →`, `exit=${run.exitCode}`, `stdout行=${run.stdoutLines.length}`, caseOut.ok ? '✅' : '❌');
  if (!caseOut.ok && caseOut.stderrOneLine) note('   stderr:', caseOut.stderrOneLine.slice(0, 300));
  results.cases.push(caseOut);
  return caseOut;
}

mkdirSync(STAGE, { recursive: true });

// ① 基线：系统 TEMP（os.tmpdir() 给的是 8.3 短名目录）
const base = mkdtempSync(join(tmpdir(), 'aieval-v4-home-'));
await runCase('① home 在系统 TEMP', { home: join(base, 'home'), cwd: join(base, 'cwd') });

// ② home 在**非临时**的稳定目录（用户目录下，长路径）
await runCase('② home 在用户目录（非 TEMP）', {
  home: join(homedir(), '.codex-v4probe', 'home'),
  cwd: join(homedir(), '.codex-v4probe', 'cwd'),
});

// ③ home 在仓库下 probe/dumps/v4/tmp（非 TEMP，且在 D: 盘）
await runCase('③ home 在仓库 probe/dumps/v4/tmp（D: 盘）', {
  home: join(STAGE, 'home-repo'),
  cwd: join(STAGE, 'cwd-repo'),
});

// ④ TEMP 里，但预建 state_5.sqlite
await runCase('④ home 在系统 TEMP + 预建 state_5.sqlite', {
  home: join(base, 'home-pre'),
  cwd: join(base, 'cwd-pre'),
  precreateStateDb: true,
});

// ⑤ 整棵 vendor 复制到普通目录（非 node_modules）后再跑
const COPY_ROOT = join(STAGE, 'vendor-copy', 'x86_64-pc-windows-msvc');
if (!existsSync(join(COPY_ROOT, 'bin', 'codex.exe'))) {
  mkdirSync(join(COPY_ROOT, 'bin'), { recursive: true });
  for (const rel of [
    ['bin', 'codex.exe'],
    ['bin', 'codex-code-mode-host.exe'],
    ['codex-path', 'rg.exe'],
    ['codex-resources', 'codex-command-runner.exe'],
    ['codex-resources', 'codex-windows-sandbox-setup.exe'],
    ['codex-package.json'],
  ]) {
    const from = join(VENDOR, ...rel);
    if (existsSync(from)) copyFileSync(from, join(COPY_ROOT, ...rel));
  }
}
await runCase('⑤ exe 复制到普通目录（非 node_modules）', {
  exe: join(COPY_ROOT, 'bin', 'codex.exe'),
  home: join(base, 'home-copy'),
  cwd: join(base, 'cwd-copy'),
});

// ⑥ 对照组：0.154.0 在用例 ② 的同一位置
await runCase('⑥ 0.154.0 对照组（home 非 TEMP）', {
  exe: 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
  home: join(STAGE, 'home-154'),
  cwd: join(STAGE, 'cwd-154'),
});

const file = writeDump('v4/codex-156-home-matrix', results);
note('落盘：', file);
