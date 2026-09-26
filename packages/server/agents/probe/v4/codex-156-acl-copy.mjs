/**
 * v4：最后一个机制假设 —— 「物理位置」是不是就是**仓库树继承来的那套 ACE**。
 *
 * 已证（`codex-156-repo-boundary.mjs`）：
 *   ① `<repo>\…\junc\home`（junction 实体在仓库外）→ ❌
 *   ② `C:\…\Temp\junc-repo\home`（junction 实体在仓库内）→ ✅
 *   ⇒ 判据是**物理目录**，不是路径串。剩下最像的解释是仓库树的 DACL。
 * ③④⑤ 已排除「父目录恰好叫 tmp」与「必须在 dumps/v4 下」。
 *
 * 本脚本做两格对照，判据是「把仓库根的 DACL 原样搬到 C: TEMP 的 home 上，能不能起来」：
 *   · 补 Everyone / 沙箱两个账户的 FullControl → 若 ✅ ⇒ 是**权限**，且权限对象不是 Authenticated Users / 沙箱组
 *   · 把仓库根的 SDDL 原样 Set-Acl 上去      → 若 ✅ ⇒ 是仓库 DACL 里的某一格（后续可二分）
 *   · 都不行                                → 权限解释被推翻，如实登记「机制未定，只给出边界」
 *
 * 用法：node probe/v4/codex-156-acl-copy.mjs
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const V156 = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const STAGE = join(HERE, '..', 'dumps', 'v4', 'tmp');
const key = loadDeepSeekKey();

const results = { at: new Date().toISOString(), aclOps: [], cases: [], repoAcl: null };

/** 用 powershell 读/写 DACL（SDDL 原文一并落盘，便于人工核对）。 */
async function ps(command) {
  const run = await spawnCapture('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: buildEnv({}),
    timeoutMs: 90_000,
  });
  return { command, exitCode: run.exitCode, stdout: run.stdout.trim(), stderr: run.stderr.trim() };
}

const repoAcl = await ps(`(Get-Acl -LiteralPath '${REPO}').Sddl`);
results.repoAcl = repoAcl;

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

async function runCase(name, { home, aclCommands = [], timeoutMs = 150_000 }) {
  mkdirSync(home, { recursive: true });
  const aclOut = [];
  for (const command of aclCommands) aclOut.push(await ps(command.replaceAll('{HOME}', home)));
  results.aclOps.push({ name, aclOut });
  const cwd = join(dirname(home), 'cwd');
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
  const run = await spawnCapture(V156, args, {
    env: buildEnv({ codexHome: home, apiKey: key, extra: { RUST_LOG: 'debug' } }),
    cwd,
    timeoutMs,
  });
  const ok = run.exitCode === 0 && run.stdoutLines.length > 0;
  results.cases.push({
    name,
    home,
    ok,
    ...summarize(run, 5),
    sqliteLine: run.stderr.split(/\r?\n/).find((one) => /state db|state DB|state runtime/i.test(one)) ?? null,
  });
  note(`用例 ${name} →`, `exit=${run.exitCode}`, ok ? '✅ 成功' : '❌ 失败');
  if (!ok) note('   ', run.stderr.split(/\r?\n/).filter((one) => one.trim() !== '').slice(0, 2).join(' | '));
}

mkdirSync(STAGE, { recursive: true });

await runCase('基线：C: TEMP，不加 ACE', { home: join(STAGE, 'acl-baseline', 'home') });

await runCase('① C: TEMP + Everyone/沙箱两账户 FullControl', {
  home: join(STAGE, 'acl-everyone', 'home'),
  aclCommands: [
    "icacls '{HOME}' /grant '*S-1-1-0:(OI)(CI)F' /T /Q",
    "icacls '{HOME}' /grant 'CodexSandboxOffline:(OI)(CI)F' /T /Q",
    "icacls '{HOME}' /grant 'CodexSandboxOnline:(OI)(CI)F' /T /Q",
    "icacls '{HOME}' /grant 'CodexSandboxUsers:(OI)(CI)F' /T /Q",
  ],
});

await runCase('② C: TEMP + 把仓库根 DACL 原样搬过来', {
  home: join(STAGE, 'acl-copy', 'home'),
  aclCommands: [
    `$a = Get-Acl -LiteralPath '${REPO}'; Set-Acl -LiteralPath '{HOME}' -AclObject $a; (Get-Acl -LiteralPath '{HOME}').Sddl`,
  ],
});

// 对照：把仓库树的 DACL 也搬到 home 的**父目录**上（确认不是「必须落在仓库内的子目录」）
await runCase('③ C: TEMP + 仓库 DACL 同时搬到父目录', {
  home: join(STAGE, 'acl-copy-parent', 'home'),
  aclCommands: [
    `$a = Get-Acl -LiteralPath '${REPO}'; Set-Acl -LiteralPath '${join(STAGE, 'acl-copy-parent')}' -AclObject $a; (Get-Acl -LiteralPath '{HOME}').Sddl`,
  ],
});

const file = writeDump('v4/codex-156-acl-copy', results);
note('落盘：', file);
