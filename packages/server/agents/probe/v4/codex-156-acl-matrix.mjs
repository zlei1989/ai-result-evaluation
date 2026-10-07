/**
 * v4：把「0.156.1 只在仓库内的 $CODEX_HOME 上跑得起来」这条边界变成**可判定的 ACL 假设**。
 *
 * 边界已知（`codex-156-location-matrix.mjs`）：
 *   D: 仓库内 ✅ ｜ D: 仓库外 ❌ ｜ C: 用户目录 ❌ ｜ C: TEMP（长/短名）❌ ｜ C: ProgramData ❌
 *   ⇒ 不是盘符、不是 TEMP、不是 cwd（F/G 两格已把 cwd 排除）。
 * 唯一看得见的差别在**继承来的 ACL**：仓库树上有 `NT AUTHORITY\Authenticated Users: Modify`，
 * 而 TEMP / 用户目录 / ProgramData 只有「当前用户 FullControl + SYSTEM/Administrators」。
 * 假设：0.156.1 的 state db 是在一个**比当前用户更窄的身份**下打开的（沙箱身份），
 * 于是只有「Authenticated Users / CodexSandboxUsers 可写」的目录才过得去。
 *
 * 判据（一次只加一个变量）：在 **C: TEMP** 上分别补 ACE，看 0.156.1 能不能起来。
 *   · 补 `Authenticated Users:(OI)(CI)M` → 起来 ⇒ 假设成立（身份是受限令牌，保留 Authenticated Users）
 *   · 只补 `CodexSandboxUsers:(OI)(CI)M` → 起来 ⇒ 身份换成沙箱组
 *   · 都不起来 ⇒ 假设被推翻，得换别的解释
 *
 * 用法：node probe/v4/codex-156-acl-matrix.mjs
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, makeScratch, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const V156 = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const DUMP_ROOT = join(HERE, '..', 'dumps', 'v4');
const key = loadDeepSeekKey();

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

const results = { at: new Date().toISOString(), aclProbe: [], cases: [] };

/** icacls 是系统自带 exe；这里只用它**加**一个 ACE，不动别的。 */
async function icacls(args) {
  const run = await spawnCapture('icacls', args, { env: buildEnv({}), timeoutMs: 60_000 });
  return { args, exitCode: run.exitCode, stdout: run.stdout.trim(), stderr: run.stderr.trim() };
}

/** 先看两条 SID 在这个机器上是什么。 */
results.aclProbe.push(await icacls(['C:\\Users\\zhanglei1120\\AppData\\Local\\Temp']));
results.aclProbe.push(await icacls([`${REPO}\\packages\\server\\agents\\probe\\dumps\\v4`]));

async function runCase(name, { grants = [], timeoutMs = 150_000 }) {
  const scratch = makeScratch('aieval-v4-acl-');
  const home = scratch.home;
  const cwd = scratch.cwd;
  const grantResults = [];
  for (const sid of grants) {
    grantResults.push(await icacls([home, '/grant', `${sid}:(OI)(CI)M`, '/T', '/Q']));
  }
  if (grants.length > 0) results.aclProbe.push(await icacls([home]));

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
  const stderrLines = run.stderr.split(/\r?\n/).filter((one) => one.trim() !== '');
  const ok = run.exitCode === 0 && run.stdoutLines.length > 0;
  const caseOut = {
    name,
    grants,
    grantResults,
    home,
    ok,
    ...summarize(run, 6),
    stderrHead: stderrLines.slice(0, 4),
    sqliteLine: stderrLines.find((one) => /state db|state DB|state runtime/i.test(one)) ?? null,
  };
  note(`用例 ${name} →`, `exit=${run.exitCode}`, `stdout行=${run.stdoutLines.length}`, ok ? '✅ 成功' : '❌ 失败');
  if (caseOut.sqliteLine) note('   sqlite:', caseOut.sqliteLine.slice(0, 220));
  results.cases.push(caseOut);
  return caseOut;
}

// 基线（无任何补充 ACE，C: TEMP）
await runCase('基线：C: TEMP，不加 ACE', {});
// ① 补 Authenticated Users: Modify
await runCase('① 补 Authenticated Users:(OI)(CI)M', { grants: ['*S-1-5-11'] });
// ② 补 CodexSandboxUsers: Modify
await runCase('② 补 CodexSandboxUsers:(OI)(CI)M', { grants: ['CodexSandboxUsers'] });
// ③ 两个都补
await runCase('③ 两个都补', { grants: ['*S-1-5-11', 'CodexSandboxUsers'] });

const file = writeDump('v4/codex-156-acl-matrix', results);
note('落盘：', file);
