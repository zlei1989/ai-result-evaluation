/**
 * v4：最后一个机制候选 —— 失败的判据是不是「$CODEX_HOME 物理上落在一个 **git 工作树**里」。
 *
 * 这一条能 100% 拟合前面所有实证（含 junction 那两格）：
 *   仓库内任意深度 ✅ ｜ 仓库外（含 D: 同盘、含 junction 指到仓库外）❌
 * 本脚本用 `git init` 在仓库外造一个工作树，看能否把失败点变成成功点；
 * 同时补一格「预建全部 sqlite 文件」的对照，用来分辨失败是否只是「创建」那一步。
 *
 * 用法：node probe/v4/codex-156-git-hypothesis.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const V156 = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const OUTSIDE = 'D:\\zhanglei1120\\v4probe-outside';
const key = loadDeepSeekKey();

const results = { at: new Date().toISOString(), gitInits: [], cases: [] };

async function git(...args) {
  const run = await spawnCapture('git', args, { env: buildEnv({}), timeoutMs: 120_000 });
  results.gitInits.push({ args, exitCode: run.exitCode, stdout: run.stdout.trim(), stderr: run.stderr.trim() });
  note('git', args.join(' '), '→', run.exitCode);
  return run;
}

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

async function runCase(name, { home, cwd, precreateDbs = false, timeoutMs = 150_000 }) {
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (precreateDbs) {
    for (const base of ['state_5', 'logs_2', 'memories_1', 'queue_1', 'goals_1', 'thread_history_1']) {
      for (const suffix of ['', '-wal', '-shm']) writeFileSync(join(home, `${base}.sqlite${suffix}`), '');
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
  const out = await spawnCapture(V156, args, {
    env: buildEnv({ codexHome: home, apiKey: key, extra: { RUST_LOG: 'debug' } }),
    cwd,
    timeoutMs,
  });
  const ok = out.exitCode === 0 && out.stdoutLines.length > 0;
  results.cases.push({
    name,
    home,
    cwd,
    precreateDbs,
    ok,
    ...summarize(out, 5),
    sqliteLine: out.stderr.split(/\r?\n/).find((one) => /state db|state DB|state runtime/i.test(one)) ?? null,
  });
  note(`用例 ${name} →`, `exit=${out.exitCode}`, ok ? '✅ 成功' : '❌ 失败');
  return ok;
}

// ① 仓库外：父目录 `git init` 之后再跑（home 落在工作树内）
const GIT_PARENT = join(OUTSIDE, 'gitparent');
mkdirSync(GIT_PARENT, { recursive: true });
await git('-C', GIT_PARENT, 'init');
await runCase('① 仓库外 + 父目录 git init', { home: join(GIT_PARENT, 'home'), cwd: join(GIT_PARENT, 'cwd') });

// ② 仓库外：`git init` 直接在 home 上
const GIT_HOME = join(OUTSIDE, 'githome');
await git('-C', GIT_HOME, 'init');
await runCase('② 仓库外 + home 自己 git init', { home: GIT_HOME, cwd: GIT_HOME });

// ③ C: TEMP + 预建全部 sqlite（分辨卡在「创建」还是「使用」）
await runCase('③ C: TEMP + 预建全部 sqlite 文件', {
  home: join(tmpdir(), 'aieval-v4-alldb', 'home'),
  cwd: join(tmpdir(), 'aieval-v4-alldb', 'cwd'),
  precreateDbs: true,
});

// ④ 对照：仓库外、无 git（复现失败）
await runCase('④ 对照：仓库外无 git', { home: join(OUTSIDE, 'plain', 'home'), cwd: join(OUTSIDE, 'plain', 'cwd') });

// ⑤ 对照：仓库内（复现成功）
await runCase('⑤ 对照：仓库内', {
  home: join(HERE, '..', 'dumps', 'v4', 'tmp', 'git-hypo-home'),
  cwd: join(HERE, '..', 'dumps', 'v4', 'tmp', 'git-hypo-cwd'),
});

const file = writeDump('v4/codex-156-git-hypothesis', results);
note('落盘：', file);
