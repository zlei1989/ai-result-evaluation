/**
 * v4 Q5：`codex exec --json` 与 `--experimental-json` 在 0.154.0 / 0.156.1 上是否可用。
 *
 * 判据分两层（只看 `--help` 不够）：
 *   ① **帮助文本**：把 `exec --help` 的**全文**收下来，逐字列出与 json 有关的行；
 *   ② **真跑**：用该 flag 跑一次真实 turn，看它是否真的产出 JSONL 事件（而不是只被 clap 接受）。
 * 为什么必须两层：`exec --json --help` 在 clap 里只要 flag 合法就会直接打帮助，
 * 所以「打了帮助」不能证明事件流是 JSON；反过来「真跑失败」也要先排除是不是 Q1 那个 home 位置的坑
 * ⇒ 本轮所有真跑一律把 `$CODEX_HOME` 放在工作区内（Q1 已证这是 0.156.1 能起来的条件）。
 *
 * 用法：node probe/v4/codex-json-flag.mjs
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, buildExecArgs, spawnCapture } from './lib/codex-exec.mjs';
import { DEEPSEEK_OPENAI_BASE_URL, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const BINS = {
  '0.154.0': 'D:\\.nvm4w\\nodejs\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
  '0.156.1': `${REPO}\\node_modules\\.pnpm\\@openai+codex@0.156.1-win32-x64\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`,
};
const STAGE = join(HERE, '..', 'dumps', 'v4', 'tmp');
const key = loadDeepSeekKey();

function config() {
  return {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval deepseek',
        base_url: DEEPSEEK_OPENAI_BASE_URL,
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    tools: { web_search: false, update_plan: { enabled: true } },
    features: { multi_agent: false },
  };
}

const results = { at: new Date().toISOString(), bins: BINS, help: {}, realRuns: [] };

for (const [label, exe] of Object.entries(BINS)) {
  const plain = await spawnCapture(exe, ['exec', '--help'], { env: buildEnv({}), timeoutMs: 60_000 });
  const jsonHelp = await spawnCapture(exe, ['exec', '--json', '--help'], { env: buildEnv({}), timeoutMs: 60_000 });
  const expHelp = await spawnCapture(exe, ['exec', '--experimental-json', '--help'], { env: buildEnv({}), timeoutMs: 60_000 });
  const linesOf = (text) => text.split(/\r?\n/);
  const jsonLines = [...new Set([...linesOf(plain.stdout), ...linesOf(jsonHelp.stdout), ...linesOf(expHelp.stdout)])].filter((one) => /json/i.test(one));
  results.help[label] = {
    plainExit: plain.exitCode,
    jsonHelpExit: jsonHelp.exitCode,
    expHelpExit: expHelp.exitCode,
    plainHelpLines: linesOf(plain.stdout).length,
    jsonRelatedLines: jsonLines,
    jsonHelpDiffersFromPlain: jsonHelp.stdout !== plain.stdout,
    expHelpDiffersFromPlain: expHelp.stdout !== plain.stdout,
    plainHelpFull: plain.stdout,
  };
  note(`help ${label} →`, `exec --help exit=${plain.exitCode}`, `含 json 的行=${jsonLines.length}`);
  for (const one of jsonLines) note('   |', one.trim());
}

/** 用指定 flag 真跑一次 turn（home 一律在工作区内）。 */
async function realRun(label, flag) {
  const home = join(STAGE, `jsonflag-${label.replace('.', '')}-${flag.replaceAll('-', '')}`);
  const cwd = join(home, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const args = buildExecArgs({
    config: config(),
    model: 'deepseek-chat',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    cwd,
    skipGitRepoCheck: true,
  });
  // 把 SDK 默认的 `--experimental-json` 换成要测的 flag
  const idx = args.indexOf('--experimental-json');
  if (idx >= 0) args.splice(idx, 1);
  args.splice(1, 0, flag);
  args.push('reply with the single word: ok');
  const out = await spawnCapture(BINS[label], args, {
    env: buildEnv({ codexHome: home, apiKey: key }),
    cwd,
    timeoutMs: 240_000,
  });
  const parsed = out.stdoutLines.flatMap((line) => {
    try {
      const one = JSON.parse(line);
      return typeof one === 'object' && one !== null && typeof one.type === 'string' ? [one] : [];
    } catch {
      return [];
    }
  });
  const record = {
    label,
    flag,
    argv: args,
    exitCode: out.exitCode,
    timedOut: out.timedOut,
    stderrRaw: out.stderr,
    stdoutLineCount: out.stdoutLines.length,
    stdoutIsJsonl: parsed.length === out.stdoutLines.length && parsed.length > 0,
    eventTypes: [...new Set(parsed.map((one) => one.type))],
    stdoutHead: out.stdoutLines.slice(0, 4),
  };
  results.realRuns.push(record);
  note(`真跑 ${label} ${flag} →`, `exit=${out.exitCode}`, `stdout行=${out.stdoutLines.length}`, `是 JSONL？ ${record.stdoutIsJsonl}`);
  if (out.exitCode !== 0) note('   stderr:', out.stderr.split(/\r?\n/).filter((one) => one.trim() !== '').slice(0, 3).join(' | '));
  return record;
}

for (const label of Object.keys(BINS)) {
  await realRun(label, '--json');
  await realRun(label, '--experimental-json');
}

const file = writeDump('v4/codex-json-flag', results);
note('落盘：', file);
