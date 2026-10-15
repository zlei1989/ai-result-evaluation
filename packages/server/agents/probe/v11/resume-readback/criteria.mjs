/**
 * 跨家「暗号回读」驱动器（`probe/v11/resume-readback/`）的**判据层**。
 *
 * 这一层只做四件事，四家的差异一律不进这里：
 *  1. **判据形状**：一条判据的读数只有三态 `true` / `false` / `null`——`null` 是「读不出」，
 *     与 `false`（读出来了、是否）严格分开。把这两件事混起来，就会把「跑不起来」写成「不支持」。
 *  2. **两条并行判据的口径**（投影判机制、答复判端到端）与**判定表**：见 `gateOf`。
 *  3. **文本命中**：暗号回读的命中判定（精确 / 宽松两档）。
 *  4. **进程与落盘原语**：`spawnSync` 跑现成的单家探针、读它写的读数、写本驱动器的读数。
 *
 * 三条不变量（与 `probe/v11` 里既有的四支单家探针同口径）：
 *  · 凭据**只从环境变量读**，源码里不出现明文 key，落盘前 redact；
 *  · **两个进程**：正面那一半（resume）与阴性对照必须各起一个真 node 进程，同进程连跑两次证明不了任何事；
 *  · **跑不起来 ≠ 探测失败**：载体进程没跑成时该家的读数作废，不许降级成「不支持」。
 *
 * ⚠️ 本模块是**只加不改**的那一半：四家的引擎仍是既有的 `cc|codex|pi|dsh-session-resume.mjs`
 * （按它们的 `--role=` 单跑接口调用），本目录不重写任何一家的会话装配。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { DUMP_DIR } from '../lib/cc-ask.mjs';

/** 读数落点：与其它 v11 探针同一格（整个 `probe/dumps/` 已 gitignore）。 */
export const DUMP_ROOT = DUMP_DIR;

/** 统一进度前缀（本目录多支臂共用）。 */
export function note(...parts) {
  console.log('[v11/readback]', ...parts);
}

const SECRETS = [process.env.AIEVAL_PROBE_GATEWAY_API_KEY].filter(
  (one) => typeof one === 'string' && one.length >= 8,
);

/** 把已知凭据从落盘与打印里抹掉（逐字替换，不做宽松正则）。 */
export function redact(value) {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) out = out.split(secret).join('***');
  return out;
}

/**
 * `--key=value` 开关。
 *
 * @param name 开关名（不带 `--`）。
 * @param fallback 未给时的回落值。
 * @param argv 参数表（缺省取 `process.argv`）。
 * @returns 开关值；未给时是 `fallback`。
 */
export function flagOf(name, fallback, argv = process.argv) {
  const hit = argv.find((one) => one.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

/** 取子进程 stdout 里 `TAG=值` 形式的定式行（四支单家探针都用这一形状对外暴露读数）。 */
export function pick(stdout, tag) {
  return String(stdout ?? '')
    .split('\n')
    .find((line) => line.startsWith(`${tag}=`))
    ?.slice(tag.length + 1) ?? '';
}

/**
 * 跑一次现成的单家探针（一个 role = 一个真 node 进程）。
 *
 * 超时按 `spawnSync` 的 `timeout` 收场：`exit === null` + `timedOut` ⇒ 调用方当「跑不起来」处理
 * （厂商侧没有 park deadline，挂住这一档只能靠我们自己的墙钟预算）。
 *
 * @param input.script 探针脚本的绝对路径。
 * @param input.args 传给它的参数表（**数组**形状：不经过 shell，中文标点与暗号都不会被吃掉）。
 * @param input.timeoutMs 墙钟上限。
 * @param input.env 额外环境变量（并入宿主环境）。
 * @returns 退出码、耗时、redact 过的 stdout / stderr。
 */
export function runProbe({ script, args, timeoutMs, env }) {
  const t0 = Date.now();
  const out = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  return {
    script,
    args,
    exit: out.status,
    signal: out.signal ?? null,
    timedOut: out.error?.code === 'ETIMEDOUT',
    spawnError: out.error === undefined ? null : String(out.error.message),
    ms: Date.now() - t0,
    stdout: redact(out.stdout ?? ''),
    stderr: redact(out.stderr ?? ''),
  };
}

/** 读一份现成探针写的 JSON 读数（它按 label / role 定名，冲突时后写的覆盖先写的 ⇒ 必须**跑完立刻读**）。 */
export function readProbeDump(name) {
  const file = join(DUMP_ROOT, `${name}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 写本驱动器的读数（`resume-readback-<name>.json`）。 */
export function writeReadbackDump(name, payload) {
  const file = join(DUMP_ROOT, `resume-readback-${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, redact(JSON.stringify(payload, null, 2)), 'utf8');
  return file;
}

/**
 * 一条判据的读数。
 *
 * @param ok `true` = 读出来了且**成立**；`false` = 读出来了且**不成立**；`null` = 读不出。
 * @param detail 一句话说清这一格读到了什么（给人看的判据摘要）。
 * @param evidence 原文级证据（文件路径、答复原文、厂商错误原文）。
 */
export function reading(ok, detail, evidence = []) {
  if (ok !== true && ok !== false && ok !== null) {
    throw new Error(`判据读数只允许 true / false / null，收到 ${String(ok)}`);
  }
  return { ok, detail, evidence };
}

// ───────────────────────────── 暗号命中 ─────────────────────────────

/** 只留字母与数字再比：模型把暗号写成 `aieval-xxxx` / `AIEVALXXXX` / `AIEVAL - XXXX` 都算命中。 */
function normalizeText(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * 一段文本里有没有暗号。两档分开报，**判定用两档的并集**：
 *  · `exact`：逐字包含（转录文件、厂商投影里应当是这一档）；
 *  · `loose`：去掉大小写与分隔符后包含（模型答复常见这一档）。
 *
 * 宽松档是**保守方向**的：阴性对照要求「不含暗号」，宽松比精确更容易报泄漏，
 * 于是假绿（把泄漏读成隔离）不会被宽松档制造出来。
 *
 * ⚠️ `nonce === ''` 必须单独挡掉：空串是任何字符串的子串，漏了它每一格都会报「命中」。
 */
export function hitOf(text, nonce) {
  const raw = String(text ?? '');
  if (nonce === '') return { ok: false, mode: 'none', exact: false, loose: false };
  const exact = raw.includes(nonce);
  const loose = !exact && normalizeText(raw).includes(normalizeText(nonce));
  return { ok: exact || loose, mode: exact ? 'exact' : loose ? 'loose' : 'none', exact, loose };
}

// ───────────────────────────── 文本扫描 ─────────────────────────────

const SCAN_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 扫一个文件里有没有暗号，并把「在哪一行、多大、原文长什么样」带回来。
 *
 * @param file 目标文件（不存在时 `exists: false`，不算异常）。
 * @param nonce 暗号。
 * @returns `{path, exists, bytes, lines, hitLines, snippet}`；暗号在 snippet 里替换成 `<NONCE>`。
 */
export function scanFile(file, nonce) {
  const base = { path: file, exists: false, bytes: 0, lines: 0, hitLines: 0, snippet: null };
  if (file === null || file === undefined || !existsSync(file)) return base;
  const stat = statSync(file);
  if (stat.isDirectory() || stat.size > SCAN_MAX_BYTES) {
    return { ...base, exists: true, bytes: stat.size, skipped: stat.isDirectory() ? '目录' : '超过扫描上限' };
  }
  const text = readFileSync(file, 'utf8');
  const rows = text.split('\n');
  const hitRows = rows.filter((line) => line.includes(nonce));
  const first = hitRows[0] ?? null;
  return {
    path: file,
    exists: true,
    bytes: stat.size,
    lines: rows.length,
    hitLines: hitRows.length,
    snippet: first === null ? null : first.split(nonce).join('<NONCE>').slice(0, 240),
  };
}

/**
 * 递归扫一棵目录树里含暗号的文件（按扩展名过滤）。
 *
 * 用途是「厂商侧的转录里到底有没有上一轮的事实」这一格：读的是厂商自己写的盘上原文，
 * 不经过我们的任何投影。
 *
 * @param root 目录树根。
 * @param input.nonce 暗号。
 * @param input.extensions 只看这些后缀（缺省 `['.jsonl', '.json']`）。
 * @returns 命中文件表（含相对路径、字节、命中行数、首条命中原文）。
 */
export function scanTree(root, { nonce, extensions = ['.jsonl', '.json'] } = {}) {
  const hits = [];
  const skipped = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!extensions.some((one) => entry.name.endsWith(one))) continue;
      const scan = scanFile(path, nonce);
      if (scan.skipped !== undefined) skipped.push({ path: relative(root, path), reason: scan.skipped });
      else if (scan.hitLines > 0) hits.push({ ...scan, rel: relative(root, path) });
    }
  };
  if (root !== null && root !== undefined && existsSync(root)) walk(root, 0);
  return { root, hits, skipped };
}

// ───────────────────────────── 判定表 ─────────────────────────────

/** 一家的判定档。 */
export const GATE = Object.freeze({
  /** 两条并行判据都成立，且阴性对照成立。 */
  SUPPORTED: 'supported',
  /** 机制成立、模型这一把没答出 —— **不是**「不支持」。 */
  MODEL_FLAKED: 'model-flaked',
  /** 机制判据读出来了且为否：厂商侧投影里没有上一轮的事实。 */
  UNSUPPORTED: 'unsupported',
  /** 阴性对照答出了暗号 / 带回了上一轮 ⇒ 泄漏，正面结论作废。 */
  LEAKED: 'leaked',
  /** 有判据读不出（`ok === null`）或答对无法归因 ⇒ 不当结论用。 */
  INCONCLUSIVE: 'inconclusive',
  /** 正面那一格**跑不起来**（环境 / 版本门），与「不支持」严格分开。 */
  NOT_RUNNABLE: 'not-runnable',
});

/**
 * 把一家的四个读数（正面与反面 × 投影与答复）判成一档。
 *
 * 极性统一：`projection.ok` / `reply.ok` 都表示**「厂商侧投影 / 模型答复里带了上一轮的暗号」这一件事**。
 * 正面（resume）期待两格都是 `true`；阴性对照期待两格都是 `false`。
 *
 * 判定顺序与理由：
 *  1. 载体没跑起来 ⇒ `inconclusive`（这一家的读数作废，**不许**降级成 unsupported）；
 *  2. 正面那一格显式标了跑不起来（版本门一类）⇒ `not-runnable`；
 *  3. 阴性对照任何一格是 `true` ⇒ `leaked`：答对了也说明不了转录起了作用；
 *  4. 有 `null` ⇒ `inconclusive`；
 *  5. 投影为否 ⇒ `unsupported`（机制没接上）；但**答复为真、投影为否**时改判 `inconclusive`
 *     ——答对无法归因；
 *  6. 投影为真、答复为否 ⇒ `model-flaked`：单次答不出不算不支持；
 *  7. 其余 ⇒ `supported`。
 *
 * @param input.resume 正面那一半的 `{projection, reply, notRun?}`。
 * @param input.control 阴性对照那一半的 `{projection, reply}`。
 * @param input.broken 跑不起来的原因表（空 = 载体都跑起来了）。
 */
export function gateOf({ resume, control, broken = [] }) {
  if (broken.length > 0) {
    return { gate: GATE.INCONCLUSIVE, notes: [`有载体没跑起来 ⇒ 本家读数作废：${broken.join('；')}`] };
  }
  if (typeof resume.notRun === 'string' && resume.notRun !== '') {
    return { gate: GATE.NOT_RUNNABLE, notes: [resume.notRun] };
  }
  const rp = resume.projection.ok;
  const rr = resume.reply.ok;
  const cp = control.projection.ok;
  const cr = control.reply.ok;
  if (cp === true || cr === true) {
    return {
      gate: GATE.LEAKED,
      notes: ['阴性对照里出现了暗号 ⇒ 说明暗号能从别处泄漏，正面那一格的结论作废'],
    };
  }
  if (rp === null || rr === null || cp === null || cr === null) {
    return { gate: GATE.INCONCLUSIVE, notes: ['有判据读不出（ok=null）⇒ 不当结论用'] };
  }
  if (rp === false && rr === true) {
    return {
      gate: GATE.INCONCLUSIVE,
      notes: ['模型答出了暗号，但厂商侧投影里查不到上一轮的事实 ⇒ 答对无法归因，不当支持'],
    };
  }
  if (rp === false) {
    return {
      gate: GATE.UNSUPPORTED,
      notes: ['厂商侧投影里没有上一轮的事实 ⇒ 机制没接上（这是「不支持」，不是「跑不起来」）'],
    };
  }
  if (rr === false) {
    return {
      gate: GATE.MODEL_FLAKED,
      notes: ['机制成立、模型这一把没答出 ⇒ 单次答不出不算「不支持」：按投影判，或重问一次'],
    };
  }
  return { gate: GATE.SUPPORTED, notes: ['两条并行判据都成立，且阴性对照成立'] };
}

/** 判定档的中文短名（打印用）。 */
export const GATE_LABEL = Object.freeze({
  [GATE.SUPPORTED]: '支持（两条判据并行成立）',
  [GATE.MODEL_FLAKED]: '机制成立、模型抖了一次',
  [GATE.UNSUPPORTED]: '不支持（机制没接上）',
  [GATE.LEAKED]: '阴性对照泄漏 ⇒ 结论作废',
  [GATE.INCONCLUSIVE]: '读不出 / 跑不起来 ⇒ 不作结论',
  [GATE.NOT_RUNNABLE]: '跑不起来（见原因）',
});

/** 三态读数 → 打印用的记号（`null` 恒为 ⬜：读不出既不是成立也不是不成立）。 */
export function mark(ok, expect = true) {
  if (ok === null || ok === undefined) return '⬜';
  return ok === expect ? '✅' : '❌';
}

/** 打印用短路径：只留末三段（完整路径在 evidence 与 dump 里）。 */
export function shortenPath(value) {
  const parts = String(value ?? '').split('/').filter((one) => one !== '');
  return parts.length <= 3 ? String(value ?? '') : `…/${parts.slice(-3).join('/')}`;
}

/**
 * 把一家的读数打印成人读的块（驱动器与单臂 CLI 共用同一份渲染）。
 *
 * 记号是**符合预期**而不是原始的 `ok`：正面那一面期待「带了暗号」（`ok === true`）、
 * 阴性对照期待「没带」（`ok === false`），两面的 detail 里都写明了含 / 不含，原始三态在 dump 里。
 */
export function renderArm(arm) {
  const lines = [];
  const side = (label, one, expect) => {
    lines.push(`  ${label}  投影 ${mark(one.projection?.ok, expect)} ${one.projection?.detail ?? ''}`);
    lines.push(`  ${' '.repeat(label.length)}  答复 ${mark(one.reply?.ok, expect)} ${one.reply?.detail ?? ''}`);
  };
  lines.push(`── ${arm.family}：${arm.variant} ─────────────────────────────`);
  side('正面 resume ', arm.sides.resume, true);
  side('反面 control', arm.sides.control, false);
  const verdict = arm.verdict ?? gateOf({ resume: arm.sides.resume, control: arm.sides.control, broken: arm.broken });
  lines.push(`  判定 ${verdict.gate}（${GATE_LABEL[verdict.gate] ?? verdict.gate}）：${verdict.notes.join('；')}`);
  for (const fence of arm.fences) {
    lines.push(`  ${fence.kind === 'reading' ? '读数' : '围栏'} ${mark(fence.ok)} ${fence.name}（预期：${fence.expected}）${fence.detail === '' ? '' : `｜${fence.detail}`}`);
  }
  if (arm.broken.length > 0) lines.push(`  ⚠️ 跑不起来：${arm.broken.join('；')}`);
  return lines.join('\n');
}

/**
 * 单臂 CLI 的入口外壳：`node <arm>.mjs [--nonce=…] [--timeout-ms=…]` 只跑这一家。
 *
 * 与驱动器走**同一个**函数，所以单跑与汇总的读数必然同形（排障时不必换个口径看）。
 *
 * @param input.family 家名（用于读数文件名）。
 * @param input.run `({nonce, timeoutMs}) => Promise<arm>`。
 */
export async function runArmCli({ family, run }) {
  const nonce = flagOf('nonce', `AIEVAL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`);
  const timeoutMs = Number(flagOf('timeout-ms', '300000'));
  note(`单臂跑 ${family}｜暗号 = ${nonce}｜单进程墙钟上限 ${timeoutMs}ms`);
  const arm = await run({ nonce, timeoutMs });
  note('');
  note(renderArm(arm));
  const file = arm.broken.length === 0 ? writeReadbackDump(family, arm) : null;
  if (file === null) {
    note(`⚠️ 有载体没跑起来 ⇒ 读数作废、不落盘、退出码 2（跑不起来 ≠ 探测失败）`);
    process.exitCode = 2;
  } else {
    note(`读数落盘：${file}`);
  }
  return arm;
}
