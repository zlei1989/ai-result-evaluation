/**
 * v4：**直接** spawn codex.exe（argv 与 `@openai/codex-sdk@0.156.1` 的 `CodexExec.run` 同形）
 * 的原始采集外壳。存在的理由：
 *
 *  · Q1a 要问的是「node 的 `stdio:'pipe'` 拉子进程这件事本身在这个沙箱里还成不成立」，
 *    所以这一步**必须绕过 SDK**，否则测出来的是「SDK 起不来」而不是「进程拉不起来」；
 *  · 上一轮把 `failed to initialize in-process app-server client: 拒绝访问。(os error 5)`
 *    归因给「当时沙箱对 node 管道/命名管道的限制」（v2 的 codex-cli-plan.ps1 头注逐字写着这条），
 *    当前文件策略是 danger-full-access ⇒ 归因**必须重测**，不能沿用。
 *
 * 采集口径：stdout 按行留**原文**（不 JSON.parse 后重新序列化——那会把「字段不存在」与
 * 「字段为 null」抹平，本仓上一轮正因此误诊过）；stderr 留原文；退出码 / signal / 是否超时。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 与 SDK `CodexExec.run` 的序列化同形：`--config k=<toml value>`。 */
export function tomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return `${value}`;
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  // 数组元素里的对象要写成 TOML **inline table**（SDK 的 `toTomlValue` 就是这么干的，
  // hook 配置 `[{ matcher: '', hooks: [{ type: 'command', command }] }]` 正走这一格）
  if (value !== null && typeof value === 'object') {
    const parts = Object.entries(value).map(([key, child]) => `${TOML_BARE_KEY.test(key) ? key : JSON.stringify(key)} = ${tomlValue(child)}`);
    return `{${parts.join(', ')}}`;
  }
  throw new Error(`不可序列化的 config 值：${value === null ? 'null' : typeof value}`);
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** 把嵌套 config 平铺成 dotted path（SDK `flattenConfigOverrides` 的等价物）。 */
export function flattenConfig(value, prefix = '', out = []) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) flattenConfig(child, path, out);
    else out.push(`${path}=${tomlValue(child)}`);
  }
  return out;
}

/**
 * 构造 `codex exec` 的 argv。**逐条对齐** SDK 0.156.1 的 `CodexExec.run`（`dist/index.js:176-243`）：
 * `["exec","--experimental-json"]` + `--config`（平铺 config）+ baseUrl + `--model` + `--sandbox`
 * + `--cd` + `--config approval_policy=…`。`extraArgs` 是 SDK **没有**的口子（Q4 的
 * `--dangerously-bypass-hook-trust` 只能从这里进）。
 */
export function buildExecArgs(input) {
  const args = ['exec', '--experimental-json'];
  for (const one of flattenConfig(input.config ?? {})) args.push('--config', one);
  if (input.baseUrl) args.push('--config', `openai_base_url=${tomlValue(input.baseUrl)}`);
  if (input.model) args.push('--model', input.model);
  if (input.sandboxMode) args.push('--sandbox', input.sandboxMode);
  if (input.cwd) args.push('--cd', input.cwd);
  if (input.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (input.approvalPolicy) args.push('--config', `approval_policy=${tomlValue(input.approvalPolicy)}`);
  for (const one of input.extraArgs ?? []) args.push(one);
  return args;
}

/** 替换型子进程环境（与 `src/route.ts` 的 `buildSubprocessEnv` 同口径）。 */
export function buildEnv({ codexHome, apiKey, extra = {} }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  if (codexHome) {
    env.CODEX_HOME = codexHome;
    env.HOME = codexHome;
    env.USERPROFILE = codexHome;
  }
  if (apiKey) env.CODEX_API_KEY = apiKey;
  Object.assign(env, extra);
  return env;
}

/** 独占 scratch 目录（`$CODEX_HOME` / 工作区都用它，避免宿主 `~/.codex` 覆盖注入的 base URL）。 */
export function makeScratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, 'home'), { recursive: true });
  mkdirSync(join(dir, 'cwd'), { recursive: true });
  return { dir, home: join(dir, 'home'), cwd: join(dir, 'cwd') };
}

/**
 * spawn 一个进程并把 stdout/stderr **按原文**收完。硬超时（默认 240s）到点强杀，
 * 并把 `timedOut: true` 与**已经收到的部分输出**一起返回——超时不等于没有证据。
 */
export function spawnCapture(exe, args, { env, cwd, timeoutMs = 240_000, stdin } = {}) {
  return new Promise((resolve) => {
    const at = Date.now();
    const child = spawn(exe, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    let spawnError = null;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 杀不动就等它自己退，下面的 finish 仍由上界保证 */
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', (error) => {
      spawnError = `${error?.code ?? ''} ${error?.message ?? String(error)}`.trim();
    });
    child.once('close', (code, signal) => finish(code, signal));

    function finish(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({
        exe,
        args,
        cwd: cwd ?? null,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        spawnError,
        ms: Date.now() - at,
        stdout,
        stderr,
        stdoutLines: stdout.split(/\r?\n/).filter((line) => line !== ''),
        stderrLines: stderr.split(/\r?\n/).filter((line) => line !== ''),
      });
    }

    try {
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    } catch (error) {
      // 管道写不进去（os error 5 就长这个样）：记下来，别让它变成 unhandled rejection
      err.push(Buffer.from(`[probe] stdin 写入失败：${error?.message ?? String(error)}\n`, 'utf8'));
    }
  });
}

/** 把采集结果裁成可读摘要（丢 stdout/stderr 原文，只留计数与头尾）。 */
export function summarize(run, headLines = 6) {
  return {
    exe: run.exe,
    args: run.args,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    ms: run.ms,
    stdout: { lines: run.stdoutLines.length, bytes: run.stdout.length, head: run.stdoutLines.slice(0, headLines) },
    stderr: { lines: run.stderrLines.length, bytes: run.stderr.length, head: run.stderrLines.slice(0, headLines) },
  };
}
