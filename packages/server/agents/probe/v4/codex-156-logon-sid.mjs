/**
 * v4：机制假设 —— **写受限令牌（write-restricted token）**。
 *
 * 它能把前面所有实证一次性解释掉，所以值得单独一测：
 *   · Windows 的 `CreateRestrictedToken(WRITE_RESTRICTED)` 用**登录会话 SID** 当 restricting SID；
 *     写受限令牌做写访问检查时**只看 restricting SID**，普通 ACE（Everyone / Authenticated Users /
 *     沙箱组）**一概不算**——这正好解释了为什么我们往 C: TEMP 上补 Everyone/沙箱组 FullControl 也没用；
 *   · 仓库树的 DACL 里恰好有一格 `S-1-4-782634161-72841695: …, Write, …`（前一轮已 dump 出 SDDL），
 *     而 TEMP / 用户目录 / ProgramData / D: 仓库外都没有这一格 —— 与「只有仓库内可写」逐格吻合；
 *   · 0.154.0 不受影响 ⇒ 它不做这个受限写（版本差异）。
 *
 * 判据：把**当前进程令牌里真实存在的** S-1-4- 与 S-1-5-5- 前缀 SID 逐个签到 C: TEMP 的 home 上，
 * 看 0.156.1 能不能起来。起来了 ⇒ 机制闭合；起不来 ⇒ 假设推翻，只保留「边界」这条实证结论。
 *
 * 用法：node probe/v4/codex-156-logon-sid.mjs
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const V156 = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const key = loadDeepSeekKey();

const results = { at: new Date().toISOString(), token: {}, repoAcl: {}, candidates: [], cases: [] };

async function run(exe, args, options) {
  return spawnCapture(exe, args, options);
}

// ① 当前进程令牌里的组 SID（`whoami /groups` 给的是可读形态）
const groups = await run('whoami', ['/groups', '/fo', 'csv', '/nh'], { env: buildEnv({}), timeoutMs: 60_000 });
results.token.whoamiGroupsCsv = groups.stdout.trim();
const tokenSids = new Set(
  [...groups.stdout.matchAll(/"(S-1-[0-9-]+)"/g)].map((hit) => hit[1]),
);

// ② 仓库根的 SDDL（只取 S-1-4-*/S-1-5-5-* 这类「会话/登录」标识）
const acl = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${REPO}').Sddl`], {
  env: buildEnv({}),
  timeoutMs: 60_000,
});
results.repoAcl.sddl = acl.stdout.trim();
const repoSessionSids = [...new Set([...acl.stdout.matchAll(/(S-1-4-[0-9-]+|S-1-5-5-[0-9-]+)/g)].map((hit) => hit[1]))];

// ③ 候选 = 既在仓库 ACL 里、又在当前令牌组里（写受限令牌的 restricting SID 必然在令牌里）
results.candidates = repoSessionSids.filter((sid) => tokenSids.has(sid));
results.repoAcl.sessionSids = repoSessionSids;
results.token.matchedSids = results.candidates;
note('仓库 ACL 里的会话 SID：', repoSessionSids.join(' | ') || '（无）');
note('当前令牌组里的会话 SID：', [...tokenSids].filter((sid) => /^S-1-(4|5-5)-/.test(sid)).join(' | ') || '（无）');
note('两者交集（候选 restricting SID）：', results.candidates.join(' | ') || '（空）');

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

async function runCase(name, { home, grants = [], timeoutMs = 150_000 }) {
  mkdirSync(home, { recursive: true });
  const cwd = join(home, '..', 'cwd');
  mkdirSync(cwd, { recursive: true });
  const grantOut = [];
  for (const sid of grants) {
    const one = await run('icacls', [home, '/grant', `${sid}:(OI)(CI)M`, '/T', '/Q'], { env: buildEnv({}), timeoutMs: 60_000 });
    grantOut.push({ sid, exitCode: one.exitCode, stdout: one.stdout.trim(), stderr: one.stderr.trim() });
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
  const out = await run(V156, args, {
    env: buildEnv({ codexHome: home, apiKey: key, extra: { RUST_LOG: 'debug' } }),
    cwd,
    timeoutMs,
  });
  const ok = out.exitCode === 0 && out.stdoutLines.length > 0;
  results.cases.push({
    name,
    home,
    grants,
    grantOut,
    ok,
    ...summarize(out, 5),
    sqliteLine: out.stderr.split(/\r?\n/).find((one) => /state db|state DB|state runtime/i.test(one)) ?? null,
  });
  note(`用例 ${name} →`, `exit=${out.exitCode}`, ok ? '✅ 成功' : '❌ 失败');
  if (!ok) note('   ', out.stderr.split(/\r?\n/).filter((one) => one.trim() !== '').slice(0, 2).join(' | '));
}

// ④ 逐个候选 SID 做「C: TEMP + 该 SID 可写」的对照
let index = 0;
for (const sid of results.candidates) {
  index += 1;
  await runCase(`候选 ${index}：C: TEMP + 授 ${sid} Modify`, {
    home: join(tmpdir(), `aieval-v4-logon-${index}`, 'home'),
    grants: [`*${sid}`],
  });
}
if (results.candidates.length === 0) {
  note('没有交集候选，跳过授权对照（这本身就是结论的一半：令牌里没有仓库 ACL 的那一格）');
}

// ⑤ 对照：同一个 C: TEMP 位置、不授任何 SID（确认该位置本身确实失败）
await runCase('对照：C: TEMP，不授 SID', { home: join(tmpdir(), 'aieval-v4-logon-control', 'home') });

// ⑥ 显式候选：仓库 SDDL 里那一格 S-1-4 SID，以及本进程 `whoami /logonid` 报出来的登录会话 SID
//    （交集为空时也照样测这两格——「谁能让它可写」比「谁在令牌里」更接近判据）
const logonIdLine = (await run('whoami', ['/logonid'], { env: buildEnv({}), timeoutMs: 60_000 })).stdout;
const logonSid = /S-1-5-5-[0-9-]+/.exec(logonIdLine)?.[0] ?? null;
results.token.logonSid = logonSid;
note('whoami /logonid →', logonIdLine.trim());
for (const sid of ['S-1-4-782634161-72841695', logonSid].filter(Boolean)) {
  await runCase(`显式：C: TEMP + 授 ${sid} Modify`, {
    home: join(tmpdir(), `aieval-v4-sid-${sid.replaceAll(/[^0-9]/g, '').slice(-6)}`, 'home'),
    grants: [`*${sid}`],
  });
}

const file = writeDump('v4/codex-156-logon-sid', results);
note('落盘：', file);
