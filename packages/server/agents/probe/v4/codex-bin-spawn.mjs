/**
 * v4 Q1a + Q5：**直接** spawn 两份 codex.exe（不经 SDK），走 `stdio:'pipe'`。
 *
 * Q1a 要回答的是「上一轮的 `failed to initialize in-process app-server client: 拒绝访问。(os error 5)`
 * 在**当前 danger-full-access 策略**下还在不在」，所以判据必须是**绕过 SDK 的直接 spawn**：
 *   · 对照组：spawn `process.execPath` 打印一行 —— 若它成功而 codex 失败，说明不是「node 管道」本身断了；
 *   · 试验组：codex.exe `--version`、`--help`、以及一次真实的 `exec`（空 prompt，只走到初始化）。
 *
 * Q5：`exec --json` 与 `exec --experimental-json` 在两个版本上分别是不是合法 flag。
 * 判据用 **flag 放在最前的 `exec <flag> --help`**：clap 先解析到未知 flag 就报
 * `unexpected argument …` 并退出，所以「有 --help 就不会报未知 flag」这个反驳在这里不成立。
 *
 * 用法：node probe/v4/codex-bin-spawn.mjs
 */
import { existsSync } from 'node:fs';
import { buildExecArgs, buildEnv, makeScratch, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const BINS = {
  '0.156.1-sdk': `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`,
  '0.154.0-global': 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
};

const results = { at: new Date().toISOString(), bins: BINS, existed: {}, probes: {}, help: {} };
for (const [label, exe] of Object.entries(BINS)) results.existed[label] = existsSync(exe);

/** 对照组：node 自己的管道能不能用（与 codex 无关的基线）。 */
const nodeControl = await spawnCapture(process.execPath, ['-e', 'console.log("control-ok")'], {
  env: buildEnv({}),
  timeoutMs: 30_000,
});
note('对照组 node -e →', `exit=${nodeControl.exitCode}`, `stdout=${JSON.stringify(nodeControl.stdout.trim())}`);
results.probes.nodeControl = summarize(nodeControl);

for (const [label, exe] of Object.entries(BINS)) {
  if (!existsSync(exe)) {
    note(label, '二进制不存在，跳过');
    continue;
  }
  const perBin = {};

  for (const args of [['--version'], ['--help']]) {
    const run = await spawnCapture(exe, args, { env: buildEnv({}), timeoutMs: 60_000 });
    const key = args.join(' ');
    perBin[key] = summarize(run, 12);
    note(`${label} ${key} →`, `exit=${run.exitCode}`, `spawnError=${run.spawnError ?? 'null'}`, `${run.ms}ms`);
    if (args[0] === '--version') perBin.versionVerbatim = run.stdout.trim() || run.stderr.trim();
    if (args[0] === '--help') perBin.helpFull = run.stdout;
  }

  // Q5：flag 在最前的 `exec <flag> --help` —— 未知 flag 会被 clap 当场拒掉
  for (const flag of ['--json', '--experimental-json']) {
    const run = await spawnCapture(exe, ['exec', flag, '--help'], { env: buildEnv({}), timeoutMs: 60_000 });
    const rejected = /unexpected argument|unrecognized|invalid value|Found argument/i.test(run.stderr + run.stdout);
    perBin[`exec ${flag} --help`] = {
      ...summarize(run, 6),
      rejectedAsUnknownFlag: rejected,
      stdoutHead: run.stdout.split(/\r?\n/).slice(0, 8),
      stderrHead: run.stderr.split(/\r?\n/).slice(0, 8),
    };
    note(`${label} exec ${flag} --help →`, `exit=${run.exitCode}`, `未知 flag? ${rejected}`);
  }

  // Q1a 的真实初始化：一次 exec，base URL 指向 DeepSeek，但 prompt 空 —— 只看它能不能起进程、
  // 能不能把初始事件写出来。**不设超时例外**：240s 上限照旧。
  const key = loadDeepSeekKey();
  const scratch = makeScratch('aieval-v4-bin-');
  const args = buildExecArgs({
    config: {
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
    },
    model: 'deepseek-chat',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    cwd: scratch.cwd,
    skipGitRepoCheck: true,
  });
  const execRun = await spawnCapture(exe, args, {
    env: buildEnv({ codexHome: scratch.home, apiKey: key }),
    cwd: scratch.cwd,
    timeoutMs: 240_000,
    stdin: 'reply with the single word: ok\n',
  });
  perBin.execInit = {
    ...summarize(execRun, 12),
    appServerOsError5: /in-process app-server client|os error 5|拒绝访问/.test(execRun.stderr + execRun.stdout),
    stdoutRawHead: execRun.stdoutLines.slice(0, 4),
    stderrRawHead: execRun.stderrLines.slice(0, 6),
    scratch: scratch.dir,
  };
  note(
    `${label} exec 初始化 →`,
    `exit=${execRun.exitCode}`,
    `stdout行=${execRun.stdoutLines.length}`,
    `stderr行=${execRun.stderrLines.length}`,
    `os error 5? ${perBin.execInit.appServerOsError5}`,
  );

  results.probes[label] = perBin;
}

const file = writeDump('v4/codex-bin-spawn', results);
note('落盘：', file);
