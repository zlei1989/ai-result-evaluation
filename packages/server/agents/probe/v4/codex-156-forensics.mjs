/**
 * v4：0.156.1 `exec` 起不来的**归因**探测。
 *
 * 已证事实（`codex-bin-spawn.mjs` + 一次 pwsh 直跑）：
 *   · 同一份 node `stdio:'pipe'` 通路对 `--version`/`--help` **完全正常**（exit 0）；
 *   · 0.154.0 走同一条通路跑**完整 turn** 也正常（exit 0，5 条事件）；
 *   · 0.156.1 `exec` 在 **PowerShell 自己的管道 + 文件重定向**下同样失败（逐字同两条 stderr）。
 * ⇒ 上一轮「沙箱限制 node 管道/命名管道」的归因**被推翻**，必须是别的东西。本脚本按
 *   「一次只动一个变量」的矩阵去找它，并把二进制里那两条文案附近的**原始字节窗口**取出来，
 *   让「它到底在读写什么」有据可查（本仓硬规矩：先打印原始形态，再下结论）。
 *
 * 用法：node probe/v4/codex-156-forensics.mjs
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { buildEnv, buildExecArgs, makeScratch, spawnCapture, summarize } from './lib/codex-exec.mjs';
import { loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const V156 = `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
const V154 = 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';

/** 在二进制里找 ASCII 串，取前后窗口（不打印密钥之类无关字节，只取这两条文案附近）。 */
function asciiWindows(exe, needles, window = 260) {
  const buf = readFileSync(exe);
  const out = [];
  for (const needle of needles) {
    const target = Buffer.from(needle, 'utf8');
    let from = 0;
    let count = 0;
    for (;;) {
      const at = buf.indexOf(target, from);
      if (at === -1 || count >= 3) break;
      out.push({
        needle,
        at,
        before: buf.subarray(Math.max(0, at - window), at).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
        after: buf.subarray(at, Math.min(buf.length, at + window)).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
      });
      from = at + 1;
      count += 1;
    }
    if (count === 0) out.push({ needle, at: -1, note: 'ASCII 未命中（可能是 UTF-16 或已压缩/加密的字符串表）' });
  }
  return out;
}

const results = { at: new Date().toISOString(), bins: { v156: V156, v154: V154 }, strings: {}, matrix: [] };

/** 每个变体都从**同一个基线 argv** 出发，只动一个变量。 */
function baseCfg(multiAgent = false) {
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
    features: { multi_agent: multiAgent },
  };
}

const key = loadDeepSeekKey();

async function variant(name, { exe = V156, mutate, env = {}, model = null, stdin = null, longPath = false }) {
  const scratch = makeScratch('aieval-v4-forensics-');
  const spec = {
    config: baseCfg(),
    model: model ?? 'deepseek-chat',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    cwd: scratch.cwd,
    skipGitRepoCheck: true,
  };
  const built = buildExecArgs(spec);
  const mutated = mutate ? (mutate({ argv: built, spec, scratch }) ?? {}) : {};
  const argv = mutated.argv ?? built;
  const effectiveStdin = mutated.stdin === undefined ? stdin : mutated.stdin;
  const execEnv = buildEnv({ codexHome: scratch.home, apiKey: key, extra: { ...env, ...(mutated.env ?? {}) } });
  const run = await spawnCapture(exe, argv, {
    env: execEnv,
    cwd: spec.cwd,
    timeoutMs: 180_000,
    stdin: effectiveStdin ?? undefined,
  });
  const ok = run.exitCode === 0 && run.stdoutLines.length > 0;
  const record = {
    name,
    ok,
    exe: exe === V156 ? '0.156.1' : '0.154.0',
    longPath,
    ...summarize(run, 8),
    stderrRaw: run.stderr,
    stdoutFirstEvent: run.stdoutLines[0] ?? null,
    lastStdoutEvent: run.stdoutLines.at(-1) ?? null,
  };
  note(`变体 ${name} →`, `exit=${run.exitCode}`, `stdout行=${run.stdoutLines.length}`, ok ? '✅ 起来' : '❌ 起不来');
  results.matrix.push(record);
  return record;
}

results.strings.v156 = asciiWindows(V156, ['could not create PATH aliases', 'in-process app-server client']);
results.strings.v154 = asciiWindows(V154, ['could not create PATH aliases', 'in-process app-server client']);

// 基线：与 codex-bin-spawn.mjs 同形（对照组，证明矩阵本身可比）
await variant('v156 基线（argv 与 SDK 同形，prompt 走 stdin）', { stdin: 'reply with the single word: ok\n' });

// ① prompt 改成位置参数：完全不碰 stdin
await variant('v156 prompt 作位置参数（不读 stdin）', {
  mutate: ({ argv }) => ({ argv: [...argv, 'reply with the single word: ok'] }),
});

// ② 换 `--json`（非 experimental）
await variant('v156 用 --json 而非 --experimental-json', {
  mutate: ({ argv }) => ({ argv: argv.map((one) => (one === '--experimental-json' ? '--json' : one)), stdin: 'reply with the single word: ok\n' }),
});

// ③ 完全离线的最小 config：不注入 model_providers，只 -m deepseek-chat
await variant('v156 无 model_providers 注入（裸 -m deepseek-chat）', {
  mutate: ({ argv }) => ({
    argv: argv.filter((one, index) => !(argv[index - 1] === '--config' && /model_provider/.test(one))),
    stdin: 'reply with the single word: ok\n',
  }),
});

// ④ 把 TEMP/TMP/TMPDIR 指向**长路径**（非 8.3 短名）——C:\Users\ZHANGL~1\… 是 os.tmpdir() 给的短名
const LONG_TMP = `${REPO}\\.probe-v4-tmp`;
mkdirSync(LONG_TMP, { recursive: true });
await variant('v156 TEMP/TMP/TMPDIR 指向长路径', {
  longPath: true,
  mutate: () => ({
    argv: [...buildExecArgs({ config: baseCfg(), model: 'deepseek-chat', sandboxMode: 'danger-full-access', approvalPolicy: 'never', skipGitRepoCheck: true }), 'reply with the single word: ok'],
    env: { TEMP: LONG_TMP, TMP: LONG_TMP, TMPDIR: LONG_TMP },
  }),
});

// ⑤ 加 --dangerously-bypass-approvals-and-sandbox（0.154.0 那轮用的旗标，绕开沙箱设置）
await variant('v156 --dangerously-bypass-approvals-and-sandbox', {
  mutate: ({ argv }) => ({ argv: [...argv, '--dangerously-bypass-approvals-and-sandbox', 'reply with the single word: ok'] }),
});

// ⑥ RUST_LOG 拉满，看 0.156.1 自己报的内部细节
await variant('v156 RUST_LOG=trace', {
  env: { RUST_LOG: 'trace' },
  mutate: ({ argv }) => ({ argv: [...argv, 'reply with the single word: ok'] }),
});

// ⑦ 对照组：0.154.0 在同一矩阵位置上（同 argv、同 env、同 cwd 形态）
await variant('v154 基线（同 argv/同 env）', {
  exe: V154,
  mutate: ({ argv }) => ({ argv: [...argv, 'reply with the single word: ok'] }),
});

const file = writeDump('v4/codex-156-forensics', results);
note('落盘：', file);
