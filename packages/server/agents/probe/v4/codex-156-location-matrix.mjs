/**
 * v4：0.156.1 `exec` 成败的**边界**在哪里。
 *
 * 已知（`codex-156-home-matrix.mjs`）：
 *   · `$CODEX_HOME` 在 `C:\Users\…\AppData\Local\Temp`（短名/长名都试过）→ `os error 5`；
 *   · `$CODEX_HOME` 在 `C:\Users\zhanglei1120\.codex-v4probe`（非 TEMP）→ 同样 `os error 5`；
 *   · `$CODEX_HOME` 在 **D: 盘仓库内** → **成功**（exit 0、5 条事件、home 被写满）。
 * 本脚本按「一次只动一个变量」把边界找出来：盘符？仓库？TEMP？还是 cwd？
 * 每个用例都带 `RUST_LOG=debug`（0.156.1 会自己报 state db 打不开的那一行，用来对照）。
 *
 * 用法：node probe/v4/codex-156-location-matrix.mjs
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const V156 = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const V154 = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
/** 产物根：`probe/dumps/v4/`（HERE=probe/v4 ⇒ 上一级是 probe，再进 dumps）。 */
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

async function runCase(name, { exe = V156, home, cwd, rustLog = 'debug', timeoutMs = 150_000 }) {
  const mkdirErrors = [];
  for (const dir of [home, cwd]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      mkdirErrors.push(`${dir}: ${error?.message ?? String(error)}`);
    }
  }
  if (mkdirErrors.length > 0) {
    note(`用例 ${name} → 连 scratch 都建不出来（这本身是证据）:`, mkdirErrors.join(' | '));
    results.cases.push({ name, exe: exe === V156 ? '0.156.1' : '0.154.0', home, cwd, ok: false, mkdirErrors });
    return null;
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
    env: buildEnv({ codexHome: home, apiKey: key, extra: rustLog === null ? {} : { RUST_LOG: rustLog } }),
    cwd,
    timeoutMs,
  });
  const stderrLines = run.stderr.split(/\r?\n/).filter((one) => one.trim() !== '');
  const sqliteLine = stderrLines.find((one) => /state db|state DB|state runtime/i.test(one)) ?? null;
  const caseOut = {
    name,
    exe: exe === V156 ? '0.156.1' : '0.154.0',
    home,
    cwd,
    ok: run.exitCode === 0 && run.stdoutLines.length > 0,
    ...summarize(run, 6),
    sqliteLine,
    stderrTail: stderrLines.slice(-4),
    homeEntries: existsSync(home) ? readdirSync(home) : null,
  };
  note(`用例 ${name} →`, `exit=${run.exitCode}`, `stdout行=${run.stdoutLines.length}`, caseOut.ok ? '✅ 成功' : '❌ 失败');
  if (caseOut.sqliteLine) note('   sqlite:', sqliteLine.slice(0, 200));
  results.cases.push(caseOut);
  return caseOut;
}

mkdirSync(STAGE, { recursive: true });
const C_TEMP_LONG = join('C:\\Users\\zhanglei1120\\AppData\\Local\\Temp', 'aieval-v4-longhome');

// A/B：把已知的失败点与成功点各再跑一次（带 RUST_LOG=debug，用来对照 sqlite 那一行）
await runCase('A. home=C: 用户目录（已知失败）', { home: join(homedir(), '.codex-v4probe', 'home-A'), cwd: join(homedir(), '.codex-v4probe', 'cwd-A') });
await runCase('B. home=D: 仓库内（已知成功）', { home: join(STAGE, 'home-B'), cwd: join(STAGE, 'cwd-B') });

// C：D: 盘但**仓库外**（分辨「盘符」与「仓库」）
await runCase('C. home=D: 仓库外', { home: 'D:\\zhanglei1120\\v4probe-outside\\home', cwd: 'D:\\zhanglei1120\\v4probe-outside\\cwd' });

// D：C: 盘 TEMP，但用**长路径**（排除 8.3 短名）
await runCase('D. home=C: TEMP 长路径', { home: join(C_TEMP_LONG, 'home'), cwd: join(C_TEMP_LONG, 'cwd') });

// E：C: 盘上另一个非 TEMP、非用户 profile 的目录
await runCase('E. home=C:\\ProgramData\\aieval-v4-probe\\home', { home: 'C:\\ProgramData\\aieval-v4-probe\\home', cwd: 'C:\\ProgramData\\aieval-v4-probe\\cwd' });

// F：home 在成功的 D: 位置，cwd 在 C: TEMP —— cwd 有没有份？
await runCase('F. home=D:（成功位置）+ cwd=C: TEMP', { home: join(STAGE, 'home-F'), cwd: join(C_TEMP_LONG, 'cwd-F') });

// G：home 在失败的 C: 位置，cwd 在 D: 仓库 —— 反向对照
await runCase('G. home=C:（失败位置）+ cwd=D: 仓库', { home: join(homedir(), '.codex-v4probe', 'home-G'), cwd: join(STAGE, 'cwd-G') });

// H：0.154.0 在同一 C: 位置上（确认 0.154.0 不受该位置影响）
await runCase('H. 0.154.0 对照组（home=C: 用户目录）', { exe: V154, home: join(homedir(), '.codex-v4probe', 'home-H154'), cwd: join(homedir(), '.codex-v4probe', 'cwd-H154') });

const file = writeDump('v4/codex-156-location-matrix', results);
note('落盘：', file);
