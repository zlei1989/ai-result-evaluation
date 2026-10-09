/**
 * v7 探针：codex 的**插件同步**与它留下的**进程/目录残留**（2026-10-07）。
 *
 * 要回答三个问题：
 *   A. `thread/start` 到底会不会去联网同步插件目录、会不会在 `$CODEX_HOME` 下留残骸？
 *   B. 这个同步能不能关掉？三个候选闸门逐格对照：线程级 `config.features.plugins`（今天产品走的路）、
 *      盘上的 `$CODEX_HOME/config.toml`、进程级 `-c features.plugins=false`。
 *   C. 只杀直接子进程 vs 杀整棵进程树，`$CODEX_HOME` 能不能删掉（EPERM 的成因）。
 *
 * 为什么必须真机跑：这三件事都在**厂商二进制的内部行为**里（`codex_core_plugins::startup_sync`、
 * 它自己 spawn 的 `git` 链、Windows 上孙进程继承的句柄/工作目录锁），任何假夹具都答不了。
 *
 * 用法：`node packages/server/agents/probe/v7/codex-plugins-sync.mjs`
 *      （不需要网关凭据：全程不调 `turn/start`，只做 initialize + thread/start）
 * 落盘：`probe/dumps/v7/codex-plugins-sync.json`（dumps 已 gitignore，跑一次即可重建）
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..', '..');
const dumpDir = join(here, '..', 'dumps', 'v7');
const scratchRoot = join(dumpDir, 'tmp');

/** codex 二进制：与 `appserver/binary.ts` 同一条解析链，探针里不引产品代码（探针要能独立跑） */
function resolveCodexBinary() {
  const candidates = [
    join(repoRoot, 'node_modules', '.pnpm', '@openai+codex@0.156.1-win32-x64', 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`找不到 codex.exe（试过 ${candidates.join('、')}）：换版本时按 @openai/codex 的平台包路径改这一格`);
}

const CODEX = resolveCodexBinary();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ps(command) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
  } catch (error) {
    return `<PS 失败: ${String(error.message).split('\n')[0]}>`;
  }
}

/**
 * 某一棵进程树的全部后代（含孙）。
 * 累积那一步必须判 ContainsKey：`@($null) + @($p)` 会造出一条 `|` 空行（本探针第一版就踩了）。
 */
function descendants(rootPid) {
  const script =
    '$all = Get-CimInstance Win32_Process; $byParent = @{};' +
    'foreach ($p in $all) { $k = [string]$p.ParentProcessId;' +
    '  if ($byParent.ContainsKey($k)) { $byParent[$k] = @($byParent[$k]) + @($p) } else { $byParent[$k] = @($p) } };' +
    'function Show($root, $depth) { foreach ($c in $byParent[[string]$root]) {' +
    '  ("  " * $depth) + "$($c.ProcessId)|$($c.Name)|$($c.CommandLine)"; Show $c.ProcessId ($depth + 1) } };' +
    `Show ${rootPid} 0`;
  return ps(script)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|'));
}

/** `$CODEX_HOME` 下前两层的目录名（只看结构，不看内容） */
function homeTree(home) {
  const walk = (dir, depth) => {
    if (depth > 2) return [];
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return ['<读不到>'];
    }
    return entries.flatMap((entry) => [
      `${'  '.repeat(depth)}${entry.name}${entry.isDirectory() ? '/' : ''}`,
      ...(entry.isDirectory() ? walk(join(dir, entry.name), depth + 1) : []),
    ]);
  };
  return walk(home, 0);
}

function tryRemove(target) {
  try {
    rmSync(target, { recursive: true, force: true });
    return { removed: true, error: null };
  } catch (error) {
    return { removed: false, error: `${error.code} ${error.syscall}: ${error.message}` };
  }
}

/** 跑一个 case：起 app-server → initialize → thread/start → 采快照 → 按指定方式收场 */
async function runCase(name, config, options = {}) {
  const { prepareHome, extraArgs = [] } = options;
  const home = mkdtempSync(join(scratchRoot, `${name}-`));
  if (prepareHome !== undefined) prepareHome(home);
  const env = { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home, RUST_LOG: 'error' };
  const child = spawn(CODEX, ['app-server', ...extraArgs], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const send = (id, method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);

  send(1, 'initialize', {
    clientInfo: { name: 'aieval-probe-v7', title: 'lifecycle probe', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  await sleep(800);
  send(2, 'thread/start', {
    model: 'deepseek-flash',
    cwd: home,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    ...(config === undefined ? {} : { config }),
  });
  // 插件同步是异步的：给足窗口让它把 git 链拉起来（真机实测约 1~3s 内出现）
  await sleep(5000);

  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  const threadStart = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).find((message) => message !== null && message.id === 2);
  const children = descendants(child.pid);
  const tree = homeTree(home);
  const pluginArtifacts = tree.filter((line) => line.includes('plugins-clone') || line.includes('plugins.sync.lock'));
  const gitChildren = children.filter((line) => line.includes('git'));
  /** 后代 pid：收场时按 pid 清（它们的命令行里**没有** CODEX_HOME，按路径扫是扫不到的） */
  const descendantPids = children.map((line) => Number(line.split('|')[0])).filter((pid) => Number.isInteger(pid) && pid > 0);

  // 收场一：只杀直接子进程（今天 client.close() 的动作），随后立刻试着删目录
  child.kill();
  await sleep(400);
  const survivorsAfterChildKill = descendants(child.pid);
  const removeAfterChildKill = tryRemove(home);

  // 收场二：按**收场前记下的 pid** 清掉幸存的后代，再删一次
  // （这一步同时是因果判据：幸存者一死目录就可删 ⇒ 锁确实是它们持的）
  for (const pid of descendantPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经自己退了：不影响结论
    }
  }
  await sleep(400);
  const removeAfterSweep = existsSync(home) ? tryRemove(home) : { removed: true, error: null };

  return {
    name,
    config: config ?? null,
    extraArgs,
    threadStart: threadStart ?? null,
    hasThreadId: typeof threadStart?.result?.thread?.id === 'string' || typeof threadStart?.result?.threadId === 'string',
    children,
    gitChildren,
    pluginArtifacts,
    descendantPids,
    survivorsAfterChildKill,
    removeAfterChildKill,
    removeAfterSweep,
    stderrTail: stderr.split('\n').slice(-6).join('\n'),
  };
}

mkdirSync(scratchRoot, { recursive: true });
// 探针自己拉起来的 scratch 一律重建：上一轮的残骸会让「目录能不能删」这条判据失真
for (const entry of readdirSync(scratchRoot)) {
  if (/^(baseline|plugins-off|config-toml-plugins-off|argv-plugins-off)-/.test(entry)) {
    const victim = join(scratchRoot, entry);
    const { removed, error } = tryRemove(victim);
    if (!removed) console.log(`[WARN] 上一轮 scratch 删不掉（${victim}）：${error}`);
  }
}

const results = [];
results.push(await runCase('baseline', { features: { multi_agent: true } }));
results.push(await runCase('plugins-off', { features: { multi_agent: true, plugins: false } }));
/**
 * 第三个 case 的存在理由：`thread/start` 的 `config` 是**线程级**覆盖，而厂商的插件同步叫
 * `startup_sync`（二进制字面量 `core-plugins/src/startup_sync.rs`）——它只读**盘上的**
 * `$CODEX_HOME/config.toml`。只测线程级那一格就下「关不掉」的结论，会漏掉真正的闸门。
 */
results.push(
  await runCase('config-toml-plugins-off', { features: { multi_agent: true } }, {
    prepareHome: (home) => {
      writeFileSync(join(home, 'config.toml'), '[features]\nplugins = false\n', 'utf8');
    },
  }),
);
/**
 * 第四个 case：进程级 `-c features.plugins=false`（等价 CLI 的 `--disable plugins`）。
 * 与上一个 case 的区别是「不落盘」——若它也管用，产品侧就不必往行配置目录里写文件。
 */
results.push(
  await runCase('argv-plugins-off', { features: { multi_agent: true } }, {
    extraArgs: ['-c', 'features.plugins=false'],
  }),
);

for (const one of results) {
  console.log(`\n===== case: ${one.name} =====`);
  console.log(`config           : ${JSON.stringify(one.config)}${one.extraArgs.length > 0 ? ` argv=${JSON.stringify(one.extraArgs)}` : ''}`);
  console.log(`thread/start 回 id: ${one.hasThreadId}`);
  console.log(`子进程/孙进程      : ${one.children.length} 个${one.gitChildren.length > 0 ? `（其中 git 链 ${one.gitChildren.length} 个）` : ''}`);
  for (const line of one.children) console.log(`   ${line}`);
  console.log(`CODEX_HOME 里的插件残骸: ${one.pluginArtifacts.length === 0 ? '无' : one.pluginArtifacts.join('、')}`);
  console.log(`只杀直接子进程后幸存的后代: ${one.survivorsAfterChildKill.length} 个`);
  console.log(`只杀直接子进程后删目录    : ${one.removeAfterChildKill.removed ? '成功' : `失败 ⇒ ${one.removeAfterChildKill.error}`}`);
  console.log(`清掉残留后代后删目录      : ${one.removeAfterSweep.removed ? '成功' : `失败 ⇒ ${one.removeAfterSweep.error}`}`);
}

mkdirSync(dumpDir, { recursive: true });
const dumpFile = join(dumpDir, 'codex-plugins-sync.json');
writeFileSync(dumpFile, `${JSON.stringify({ codex: CODEX, ranAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
console.log(`\n[v7] 原始结果已落盘：${dumpFile}`);
