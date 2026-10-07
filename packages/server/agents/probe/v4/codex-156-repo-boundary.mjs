/**
 * v4：把「0.156.1 只在仓库内 $CODEX_HOME 上跑得起来」这一步收敛成**路径串**还是**物理位置**。
 *
 * 已证（前三个矩阵）：
 *   D: 仓库内 ✅ ｜ D: 仓库外 ❌ ｜ C: 用户目录/TEMP/ProgramData ❌ ｜ 加 ACE 也不管用 ❌
 *   ⇒ 不是盘符、不是 TEMP、不是 cwd、不是「沙箱组/认证用户能否写」。
 * 本脚本用 **junction** 把「路径串」与「物理目录」拆开：
 *   ① 链接在仓库里、实体在仓库外：`<repo>\…\v4\tmp\junc\home` → 实体 `D:\zhanglei1120\v4probe-outside\phys`
 *      · 若 ✅ ⇒ 判据是**路径串**（0.156.1 对 workspace 前缀做了判定）
 *      · 若 ❌ ⇒ 判据是**物理位置**（继承来的 ACL / 目录本身的性质）
 *   ② 链接在 C: TEMP、实体在仓库里：`C:\…\Temp\junc-repo\home` → 实体 `<repo>\…\v4\tmp\phys-repo`
 *      · 这是 ① 的反向对照
 *   ③ 仓库内、但不在 `tmp` 这个名字下：`<repo>\.probe-v4-tmp\home`
 *      · 排除「父目录恰好叫 tmp」这种巧合
 *   ④ 仓库外、但父目录叫 `tmp`：`D:\zhanglei1120\v4probe-outside\tmp\home`
 *      · ③ 的正向对照
 *
 * 用法：node probe/v4/codex-156-repo-boundary.mjs
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
const OUTSIDE = 'D:\\zhanglei1120\\v4probe-outside';
const C_TEMP = 'C:\\Users\\zhanglei1120\\AppData\\Local\\Temp';
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

const results = { at: new Date().toISOString(), links: [], cases: [] };

async function mklink(name, link, target) {
  mkdirSync(target, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  const run = await spawnCapture('cmd', ['/c', 'mklink', '/J', link, target], { env: buildEnv({}), timeoutMs: 60_000 });
  const out = { name, link, target, exitCode: run.exitCode, stdout: run.stdout.trim(), stderr: run.stderr.trim() };
  results.links.push(out);
  note(`junction ${name}:`, out.exitCode === 0 ? '✅' : '❌', out.stdout || out.stderr);
  return out;
}

async function runCase(name, { home, cwd, note: extra = null, timeoutMs = 150_000 }) {
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
  const run = await spawnCapture(V156, args, {
    env: buildEnv({ codexHome: home, apiKey: key, extra: { RUST_LOG: 'debug' } }),
    cwd,
    timeoutMs,
  });
  const stderrLines = run.stderr.split(/\r?\n/).filter((one) => one.trim() !== '');
  const ok = run.exitCode === 0 && run.stdoutLines.length > 0;
  const caseOut = {
    name,
    note: extra,
    home,
    cwd,
    ok,
    ...summarize(run, 6),
    sqliteLine: stderrLines.find((one) => /state db|state DB|state runtime/i.test(one)) ?? null,
  };
  note(`用例 ${name} →`, `exit=${run.exitCode}`, `stdout行=${run.stdoutLines.length}`, ok ? '✅ 成功' : '❌ 失败');
  results.cases.push(caseOut);
  return caseOut;
}

mkdirSync(STAGE, { recursive: true });

// ① 链接在仓库内、实体在仓库外
const juncRepo = join(STAGE, 'junc');
await mklink('repo-link → outside', juncRepo, join(OUTSIDE, 'phys'));
await runCase('① 仓库内 junction → 仓库外实体', { home: join(juncRepo, 'home'), cwd: join(juncRepo, 'cwd') });

// ② 链接在 C: TEMP、实体在仓库内
const juncTemp = join(C_TEMP, 'aieval-v4-junc-repo');
await mklink('temp-link → repo', juncTemp, join(STAGE, 'phys-repo'));
await runCase('② C: TEMP junction → 仓库内实体', { home: join(juncTemp, 'home'), cwd: join(juncTemp, 'cwd') });

// ③ 仓库内、父目录不叫 tmp
await runCase('③ 仓库内 .probe-v4-tmp（父目录不叫 tmp）', {
  home: join(REPO, '.probe-v4-tmp', 'home'),
  cwd: join(REPO, '.probe-v4-tmp', 'cwd'),
  note: '仓库根目录下的自有 scratch',
});

// ④ 仓库外、父目录叫 tmp
await runCase('④ 仓库外 D:\\zhanglei1120\\v4probe-outside\\tmp（父目录叫 tmp）', {
  home: join(OUTSIDE, 'tmp', 'home'),
  cwd: join(OUTSIDE, 'tmp', 'cwd'),
});

// ⑤ 直接放在仓库根下的一级目录（最浅的仓库内位置）
await runCase('⑤ 仓库根下一级 .probe-v4-root\\home', {
  home: join(REPO, '.probe-v4-root', 'home'),
  cwd: join(REPO, '.probe-v4-root', 'cwd'),
});

const file = writeDump('v4/codex-156-repo-boundary', results);
note('落盘：', file);
