/**
 * v4：把「仓库内才成功」这条边界再拆一层 —— 是**仓库本身**，还是「$CODEX_HOME 与 **exe 目录**同处一棵树」？
 *
 * 为什么必须问这一格：前面每一格的成功用例里，exe（`<repo>\node_modules\.pnpm\…\codex.exe`）
 * 与 CODEX_HOME **同在仓库树内**，这两个解释在数据上完全重合、无法区分。
 * 判据：把整棵 vendor 复制到**仓库外**再跑，两格对照：
 *   ① 仓库外 exe + 仓库外 home → 若 ✅ ⇒ 判据是「home 在 exe 树内」，仓库本身无关
 *   ② 仓库外 exe + 仓库内 home → 若 ✅ ⇒ 判据是「home 在仓库内」（与 exe 无关）
 *   （前四轮的「仓库内 exe + 仓库内 home ✅ / 仓库外 home ❌」已在别的 dump 里）
 *
 * 用法：node probe/v4/codex-156-exe-location.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const VENDOR = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc`;
const OUTSIDE = 'D:\\zhanglei1120\\v4probe-outside';
const COPY_ROOT = join(OUTSIDE, 'vendor156', 'x86_64-pc-windows-msvc');
const STAGE = join(HERE, '..', 'dumps', 'v4', 'tmp');
const key = loadDeepSeekKey();

const results = { at: new Date().toISOString(), copy: null, cases: [] };

// 复制整棵 vendor（逐文件 mkdir，上一版因为没建目标目录而崩在半路）
const FILES = [
  ['bin', 'codex.exe'],
  ['bin', 'codex-code-mode-host.exe'],
  ['codex-path', 'rg.exe'],
  ['codex-resources', 'codex-command-runner.exe'],
  ['codex-resources', 'codex-windows-sandbox-setup.exe'],
  ['codex-package.json'],
];
const copied = [];
for (const rel of FILES) {
  const from = join(VENDOR, ...rel);
  const to = join(COPY_ROOT, ...rel);
  if (!existsSync(from)) {
    copied.push({ rel: rel.join('/'), ok: false, reason: '源不存在' });
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  copied.push({ rel: rel.join('/'), ok: true, to });
}
results.copy = { from: VENDOR, to: COPY_ROOT, copied };

const EXE_OUTSIDE = join(COPY_ROOT, 'bin', 'codex.exe');

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

async function runCase(name, { exe, home, cwd, timeoutMs = 150_000 }) {
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const args = buildExecArgs({
    config: config(),
    model: 'deepseek-chat',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    cwd,
    skipGitRepoCheck: true,
  });
  args.push('reply with the single word: ok');
  const out = await spawnCapture(exe, args, {
    env: buildEnv({ codexHome: home, apiKey: key, extra: { RUST_LOG: 'debug' } }),
    cwd,
    timeoutMs,
  });
  const ok = out.exitCode === 0 && out.stdoutLines.length > 0;
  results.cases.push({
    name,
    exe,
    home,
    cwd,
    ok,
    ...summarize(out, 5),
    sqliteLine: out.stderr.split(/\r?\n/).find((one) => /state db|state DB|state runtime/i.test(one)) ?? null,
  });
  note(`用例 ${name} →`, `exit=${out.exitCode}`, ok ? '✅ 成功' : '❌ 失败');
  if (!ok) note('   ', out.stderr.split(/\r?\n/).filter((one) => one.trim() !== '').slice(0, 2).join(' | '));
  return ok;
}

// ① 仓库外 exe + 仓库外 home
await runCase('① 仓库外 exe + 仓库外 home', {
  exe: EXE_OUTSIDE,
  home: join(OUTSIDE, 'vendor156', 'home'),
  cwd: join(OUTSIDE, 'vendor156', 'cwd'),
});

// ② 仓库外 exe + 仓库内 home
await runCase('② 仓库外 exe + 仓库内 home', {
  exe: EXE_OUTSIDE,
  home: join(STAGE, 'exeloc-home'),
  cwd: join(STAGE, 'exeloc-cwd'),
});

// ③ 对照：仓库内 exe + 仓库外 home（复现失败）
await runCase('③ 仓库内 exe + 仓库外 home', {
  exe: join(VENDOR, 'bin', 'codex.exe'),
  home: join(OUTSIDE, 'vendor156', 'home-repo-exe'),
  cwd: join(OUTSIDE, 'vendor156', 'cwd-repo-exe'),
});

const file = writeDump('v4/codex-156-exe-location', results);
note('落盘：', file);
