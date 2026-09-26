/**
 * v4 / Q1(a)：**CLI 直跑**能否打通 DeepSeek 的 anthropic 兼容端点（`https://api.deepseek.com/anthropic`）。
 *
 * 为什么用 `spawn` 而不是 pwsh：需要把 stdout / stderr **分开、逐字**留下，并且要有硬超时；
 * pwsh 的 `2>&1` 会把两者混在一起，事后无法区分「模型回的」与「CLI 报的」。
 *
 * 判据（§9.4.1 的教训：证明「厂商不产出 X」之前先证明链路没坏 X）：
 *   ① 进程是否退出、退出码、耗时；
 *   ② stdout 里有没有 `type:"result"` 那一行，以及它的 `usage` 原文；
 *   ③ stderr 原文（模型名被拒的文案逐字留）。
 *
 * 用法：node probe/v4/q1-cli-anthropic.mjs [variantLabel ...]   # 缺省跑全部
 * 产物：probe/dumps/v4/q1-cli-<label>.json + .stdout.jsonl + .stderr.txt
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEEPSEEK_ANTHROPIC_BASE_URL, DUMP_DIR, loadDeepSeekKey, note, redact, writeDump } from './lib/env.mjs';

const EXE = 'D:\\.nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const KEY = loadDeepSeekKey();
const PROMPT = 'Reply with exactly this and nothing else: ok';

/**
 * 变体表：题面要求「若某个模型名被 CLI 拒绝，逐字记录拒绝文案并换名再试」，
 * 故把「用哪个环境变量传模型」「是否给 haiku 档」拆成独立变体，逐个跑、逐个留证。
 */
const VARIANTS = [
  {
    label: 'model-env-chat',
    why: '最直译的写法：ANTHROPIC_MODEL=deepseek-chat，不带 haiku 档',
    env: { ANTHROPIC_MODEL: 'deepseek-chat' },
  },
  {
    label: 'model-env-chat-plus-haiku',
    why: 'CLI 内部有「小模型/快模型」档，若它强制要求一个 haiku 档，这里补上',
    env: {
      ANTHROPIC_MODEL: 'deepseek-chat',
      ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-chat',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
    },
  },
  {
    label: 'model-flag-chat',
    why: '改用 --model 传（CLI 的 --model 走的是另一条解析路径，可能对 env 里的别名不认）',
    env: {},
    args: ['--model', 'deepseek-chat'],
  },
  {
    label: 'model-env-reasoner',
    why: '换名再试：deepseek-reasoner（DeepSeek 官方第二个模型名）',
    env: { ANTHROPIC_MODEL: 'deepseek-reasoner' },
  },
  {
    label: 'api-key-var',
    why: '换凭据传法：ANTHROPIC_API_KEY 而不是 ANTHROPIC_AUTH_TOKEN',
    env: { ANTHROPIC_MODEL: 'deepseek-chat' },
    authVar: 'ANTHROPIC_API_KEY',
  },
];

const only = process.argv.slice(2);
const picked = only.length > 0 ? VARIANTS.filter((v) => only.includes(v.label)) : VARIANTS;

function runVariant(variant, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
      [variant.authVar ?? 'ANTHROPIC_AUTH_TOKEN']: KEY,
      ...variant.env,
    };
    const args = ['-p', PROMPT, '--output-format', 'stream-json', '--verbose', ...(variant.args ?? [])];
    const at = Date.now();
    const child = spawn(EXE, args, { env, cwd: DUMP_DIR, windowsHide: true });
    // 立刻关掉 stdin：否则 CLI 会等 3s 并打 "no stdin data received in 3s"（实测 7.8s 里 3s 是这么来的）。
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ variant, spawnError: String(error?.message ?? error), ms: Date.now() - at, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
      const parsed = [];
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch { parsed.push({ __unparsable: line.slice(0, 400) }); }
      }
      resolve({
        variant,
        exitCode: code,
        timedOut,
        ms: Date.now() - at,
        stdoutLineCount: lines.length,
        stdoutTypes: parsed.map((one) => one?.type ?? (one?.__unparsable ? 'UNPARSABLE' : '?')),
        resultMessages: parsed.filter((one) => one?.type === 'result'),
        stderr,
        stdoutParsed: parsed,
      });
    });
  });
}

const summary = [];
for (const variant of picked) {
  note(`== ${variant.label} ==`, variant.why);
  const out = await runVariant(variant);
  const clean = JSON.parse(redact(JSON.stringify(out)));
  const record = {
    label: variant.label,
    why: variant.why,
    args: ['-p', PROMPT, '--output-format', 'stream-json', '--verbose', ...(variant.args ?? [])],
    envKeys: [
      'ANTHROPIC_BASE_URL',
      variant.authVar ?? 'ANTHROPIC_AUTH_TOKEN',
      ...Object.keys(variant.env),
    ],
    exitCode: clean.exitCode,
    timedOut: clean.timedOut,
    ms: clean.ms,
    spawnError: clean.spawnError,
    stdoutLineCount: clean.stdoutLineCount,
    stdoutTypes: clean.stdoutTypes,
    resultMessages: clean.resultMessages,
    resultRaw: clean.stdoutParsed?.filter((one) => one?.type === 'result') ?? [],
    stderrHead: (clean.stderr ?? '').slice(0, 4000),
    stderrLength: (clean.stderr ?? '').length,
  };
  // 原始流全量落盘（redact 后），便于「先打印原始形态再下结论」。
  const base = join(DUMP_DIR, 'v4', `q1-cli-${variant.label}`);
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(`${base}.stdout.jsonl`, redact(clean.stdoutParsed ? clean.stdoutParsed.map((one) => JSON.stringify(one)).join('\n') : ''), 'utf8');
  writeFileSync(`${base}.stderr.txt`, redact(clean.stderr ?? ''), 'utf8');
  const dump = writeDump(`v4/q1-cli-${variant.label}`, record);
  note(`  exit=${record.exitCode} timedOut=${record.timedOut} ms=${record.ms} stdoutLines=${record.stdoutLineCount} stderrLen=${record.stderrLength}`);
  note(`  stdoutTypes=${JSON.stringify(record.stdoutTypes)}`);
  if (record.resultMessages.length > 0) note('  result =', JSON.stringify(record.resultMessages[0]).slice(0, 1200));
  if (record.stderrHead !== '') note('  stderrHead =', record.stderrHead.slice(0, 600));
  summary.push({ label: variant.label, exitCode: record.exitCode, timedOut: record.timedOut, ms: record.ms, hasResult: record.resultMessages.length > 0, dump });
}

writeDump('v4/q1-cli-summary', { at: new Date().toISOString(), endpoint: DEEPSEEK_ANTHROPIC_BASE_URL, prompt: PROMPT, runs: summary });
note('汇总：', JSON.stringify(summary, null, 2));
