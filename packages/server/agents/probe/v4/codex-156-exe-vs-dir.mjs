/**
 * v4：分辨「仓库内 exe 起不来」到底卡在**那个文件**还是**那个目录**。
 *
 * 已证（`codex-156-exe-location.mjs`）：
 *   仓库内 exe + 仓库外 home ❌ ｜ 仓库外 exe + 仓库外 home ✅ ｜ 仓库外 exe + 仓库内 home ✅
 *   ⇒ 判据在 **exe 侧**，不在 CODEX_HOME 侧。（此前「仓库内 home 才行」是这两个因素重合造成的假象。）
 * 现在把 exe 侧再拆开：
 *   (a) **复制**整棵 vendor 到仓库内另一处 + home 在仓库外 ⇒ ✅ 说明卡在「那个目录」；❌ 说明卡在「仓库内」
 *   (b) **就地复制**成 `vendor\…\bin\codex-copy.exe`（同目录、不同文件）+ home 在仓库外
 *       ⇒ ✅ 说明卡在**原文件**（pnpm 硬链接 / 文件属性）；❌ 说明卡在**目录**
 *   (c) 原本的 exe + home 在仓库外（复现失败）
 *   (d) 原本的 exe + home 在仓库内（复现成功）
 * 顺带记录原 exe 的硬链接数与文件属性，供 (b) 的结论落地。
 *
 * 用法：node probe/v4/codex-156-exe-vs-dir.mjs
 */
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const VENDOR = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc`;
const ORIGINAL = join(VENDOR, 'bin', 'codex.exe');
const INPLACE_COPY = join(VENDOR, 'bin', 'codex-copy.exe');
const REPO_COPY_ROOT = join(HERE, '..', 'dumps', 'v4', 'tmp', 'vendor156-repo-copy', 'x86_64-pc-windows-msvc');
const OUTSIDE = 'D:\\zhanglei1120\\v4probe-outside';
const STAGE = join(HERE, '..', 'dumps', 'v4', 'tmp');
const key = loadDeepSeekKey();

const results = { at: new Date().toISOString(), files: {}, cases: [] };

/** Windows 上没有 lstat 的硬链接数字段，用 `fsutil hardlink list` 数成员。 */
async function hardlinkInfo(file) {
  const run = await spawnCapture('fsutil', ['hardlink', 'list', file], { env: buildEnv({}), timeoutMs: 60_000 });
  const lines = run.stdout.split(/\r?\n/).filter((one) => one.trim() !== '');
  return { exitCode: run.exitCode, members: lines, count: lines.length };
}

results.files.original = { path: ORIGINAL, ...hardlinkInfo ? await hardlinkInfo(ORIGINAL) : null, size: statSync(ORIGINAL).size };

// (b) 就地复制：同目录、新文件名
copyFileSync(ORIGINAL, INPLACE_COPY);
results.files.inplaceCopy = { path: INPLACE_COPY, size: statSync(INPLACE_COPY).size, hardlinks: await hardlinkInfo(INPLACE_COPY) };

// (a) 复制整棵 vendor 到仓库内另一处
for (const rel of [
  ['bin', 'codex.exe'],
  ['bin', 'codex-code-mode-host.exe'],
  ['codex-path', 'rg.exe'],
  ['codex-resources', 'codex-command-runner.exe'],
  ['codex-resources', 'codex-windows-sandbox-setup.exe'],
  ['codex-package.json'],
]) {
  const from = join(VENDOR, ...rel);
  if (!existsSync(from)) continue;
  const to = join(REPO_COPY_ROOT, ...rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
const REPO_COPY_EXE = join(REPO_COPY_ROOT, 'bin', 'codex.exe');
results.files.repoCopy = { path: REPO_COPY_EXE, exists: existsSync(REPO_COPY_EXE), hardlinks: await hardlinkInfo(REPO_COPY_EXE) };

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
    ok,
    ...summarize(out, 5),
    sqliteLine: out.stderr.split(/\r?\n/).find((one) => /state db|state DB|state runtime/i.test(one)) ?? null,
  });
  note(`用例 ${name} →`, `exit=${out.exitCode}`, `stdout行=${out.stdoutLines.length}`, ok ? '✅ 成功' : '❌ 失败');
  if (!ok) note('   ', out.stderr.split(/\r?\n/).filter((one) => one.trim() !== '').slice(0, 2).join(' | '));
  return ok;
}

// (a) 仓库内复制 + 仓库外 home
await runCase('(a) 仓库内复制整棵 vendor + 仓库外 home', {
  exe: REPO_COPY_EXE,
  home: join(OUTSIDE, 'exe-vs-dir', 'home-a'),
  cwd: join(OUTSIDE, 'exe-vs-dir', 'cwd-a'),
});

// (b) 原目录里的就地复制 + 仓库外 home
await runCase('(b) 原 bin 目录里的 codex-copy.exe + 仓库外 home', {
  exe: INPLACE_COPY,
  home: join(OUTSIDE, 'exe-vs-dir', 'home-b'),
  cwd: join(OUTSIDE, 'exe-vs-dir', 'cwd-b'),
});

// (c) 原 exe + 仓库外 home（复现失败）
await runCase('(c) 原 exe + 仓库外 home（复现失败）', {
  exe: ORIGINAL,
  home: join(OUTSIDE, 'exe-vs-dir', 'home-c'),
  cwd: join(OUTSIDE, 'exe-vs-dir', 'cwd-c'),
});

// (d) 原 exe + 仓库内 home（复现成功）
await runCase('(d) 原 exe + 仓库内 home（复现成功）', {
  exe: ORIGINAL,
  home: join(STAGE, 'exe-vs-dir-home-d'),
  cwd: join(STAGE, 'exe-vs-dir-cwd-d'),
});

// 清掉塞进 node_modules 的那个临时拷贝（产物目录保持干净）
try {
  unlinkSync(INPLACE_COPY);
  results.inplaceCopyRemoved = true;
} catch (error) {
  results.inplaceCopyRemoved = `失败：${error?.message ?? String(error)}`;
}

const file = writeDump('v4/codex-156-exe-vs-dir', results);
note('落盘：', file);
