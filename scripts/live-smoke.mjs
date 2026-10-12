/**
 * 真机冒烟门禁：一条命令跑完**可用的几家**，逐家打印四格结果并汇总。
 *
 * 为什么要有它：`live-smoke.test.ts` 一次只跑一家（`AIEVAL_LIVE_KIND` 是单值），而「哪家配哪个
 * provider / model」的知识在服务端的候选池里（`GET /api/runs/model-options`）——手工跑要么漏一家、
 * 要么把「默认那家绿了」当成所有家都绿。
 *
 * 用法：
 *   pnpm live-smoke                  # 跑全部有候选的家
 *   pnpm live-smoke -- --kind cc     # 只跑 cc（可重复给多次）
 *   pnpm live-smoke -- --dry-run     # 只检查服务与候选、打印将执行的命令（毫秒级）
 *
 * 前置：`pnpm dev` 起着（默认 http://localhost:3083），且设置页里至少配了一个供应商与模型、
 * 至少有一条用例。本脚本**不读配置文件、不碰密钥**：候选与用例都从 HTTP 取。
 *
 * 退出码：全部家四格通过 = 0；有任一格失败 / 服务不可用 = 1；参数错 = 2。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIVE_SMOKE_TEST = 'packages/server/agents/src/providers/live-smoke.test.ts';
/** 用例标题以圈码开头（`① 装载…`）：这是把 vitest 报告归到四格上的唯一依据 */
const CELL_MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];
/** 圈码 → 格名（与 `live-smoke.test.ts` 的用例标题同源） */
const CELL_NAMES = {
  '①': '装载',
  '②': '传输',
  '③': '产物',
  '④': '形状',
  '⑤': '智能体评分',
  '⑥': '产出可解析',
  '⑦': '耗时',
};
/**
 * **必跑格**：跳过就是异常。⑤⑥ 不在此列——它们只在 `AIEVAL_LIVE_AGENT_JUDGE=1` 时有意义，
 * 默认档跳过是设计如此。把它们算进「绿」的判据会让默认跑**永远不绿**、
 * 台账建议行永远不给（「一条命令跑通 → 更新台账」这个闭环就断了）。
 */
const REQUIRED_MARKS = ['①', '②', '③', '④', '⑦'];
/** 可选档的格（跳过了要在汇总里如实说「未覆盖」，不能悄悄算过） */
const OPTIONAL_MARKS = ['⑤', '⑥'];

function parseArgs(argv) {
  const options = {
    base: 'http://localhost:3083',
    kinds: [],
    caseId: null,
    dryRun: false,
    jsonPath: null,
    providerId: null,
    modelId: null,
    agentJudge: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') options.base = argv[(index += 1)] ?? options.base;
    else if (arg === '--kind') options.kinds.push(argv[(index += 1)] ?? '');
    else if (arg === '--case') options.caseId = argv[(index += 1)] ?? null;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.jsonPath = argv[(index += 1)] ?? null;
    else if (arg === '--provider') options.providerId = argv[(index += 1)] ?? null;
    else if (arg === '--model') options.modelId = argv[(index += 1)] ?? null;
    else if (arg === '--agent-judge') options.agentJudge = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法：pnpm live-smoke [-- --base <url>] [-- --kind <kind>]… [-- --case <uuid>] '
        + '[-- --provider <id> --model <id>] [-- --agent-judge] [-- --dry-run] [-- --json <path>]',
      );
      process.exit(0);
    } else {
      console.error(`[live-smoke] 不认识的参数：${arg}`);
      process.exit(2);
    }
  }
  options.base = options.base.replace(/\/$/, '');
  return options;
}

/** 取一份 JSON；非 2xx 直接带上响应体抛（服务端的错误映射已经给了可读文案） */
async function fetchJson(base, path) {
  const response = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' } });
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}：${await response.text()}`);
  return response.json();
}

/**
 * 每个要跑的 kind → 它的第一个候选（供应商 + 模型）。
 * 候选来自服务端的 `listAgentModelOptions()`：它按 `acceptsProtocol` 过滤，故**本脚本不重复**
 * 「哪家讲哪条 wire」这份知识。
 */
function pickTargets(groups, wantedKinds) {
  const targets = [];
  const skipped = [];
  for (const group of groups) {
    if (wantedKinds.length > 0 && !wantedKinds.includes(group.agentKind)) continue;
    const first = (group.options ?? [])[0];
    if (first === undefined) {
      skipped.push({ kind: group.agentKind, reason: '没有候选（该协议下没有配供应商或模型）' });
      continue;
    }
    targets.push({ kind: group.agentKind, providerId: first.providerId, providerName: first.providerName, modelId: first.modelId });
  }
  for (const kind of wantedKinds) {
    if (!targets.some((one) => one.kind === kind) && !skipped.some((one) => one.kind === kind)) {
      skipped.push({ kind, reason: '服务端不认识这个 kind' });
    }
  }
  return { targets, skipped };
}

/**
 * 从 vitest 的 JSON 报告里按圈码把用例归格（顺序固定，缺的格如实留空）。
 *
 * ⚠️ **前置失败（`beforeAll` 抛错）时 vitest 把用例标成 `skipped`**，并把错误挂在文件级 `message`
 * 上。那不是「这一格跳过了」，是「压根没跑到」——一并收进来按 `blocked` 显示，
 * 否则一次「服务没起 / 用例 id 不存在」看起来会和「⑤⑥ 没开那一档」一模一样。
 */
function cellsFromReport(report) {
  const found = new Map();
  let blocked = false;
  for (const file of report.testResults ?? []) {
    for (const one of file.assertionResults ?? []) {
      const matched = /^([①②③④⑤⑥⑦])/.exec(String(one.title ?? ''));
      if (matched === null) continue;
      found.set(matched[1], { status: one.status, messages: one.failureMessages ?? [] });
    }
    // 前置失败：文件级 `status` 是 `failed`、用例却是 `skipped`（vitest 不给字段级原因，
    // 错误只在输出里——由 `reasonFromTail` 从尾巴里挑一行）
    const allSkipped = (file.assertionResults ?? []).every((one) => one.status === 'skipped');
    if (file.status === 'failed' && allSkipped) blocked = true;
  }
  return CELL_MARKS.map((mark) => {
    const hit = found.get(mark);
    if (hit === undefined) return { mark, name: CELL_NAMES[mark], status: 'missing', messages: [] };
    if (blocked) return { mark, name: CELL_NAMES[mark], status: 'blocked', messages: [] };
    return { mark, name: CELL_NAMES[mark], ...hit };
  });
}

/** 从前置失败的输出尾巴里挑一行最像原因的文字（ANSI 色码先剥掉） */
function reasonFromTail(tail) {
  const lines = tail
    .split('\n')
    .map((one) => one.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((one) => one !== '');
  return lines.find((one) => /Error|AssertionError/.test(one)) ?? lines.at(-1) ?? '';
}

/**
 * 跑一家：起一个 vitest 进程（带这一家的环境变量），把 JSON 报告落临时文件再解析。
 * 输出**不转发**到本进程的 stdout——失败原因由汇总表逐格给出，原始输出要看就跑单家。
 */
function runOne(target, options, caseId) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'live-smoke-'));
    const reportPath = join(dir, 'report.json');
    const startedAt = Date.now();
    const child = spawn(
      'pnpm',
      [
        'vitest',
        'run',
        LIVE_SMOKE_TEST,
        // 两个 reporter 缺一不可：`json` 给出结构化的逐格结果，`default` 给出**可读的错误文本**
        // ——只留 `json` 时 vitest 会把默认输出整个吃掉，前置失败的原因既不在报告字段里、
        // 也不在 stdout 里（实测：文件级 `message` 是空串）
        '--reporter=json',
        `--outputFile=${reportPath}`,
        '--reporter=default',
      ],
      {
        env: {
          ...process.env,
          AIEVAL_LIVE_SMOKE: '1',
          AIEVAL_LIVE_KIND: target.kind,
          AIEVAL_LIVE_PROVIDER_ID: target.providerId,
          AIEVAL_LIVE_MODEL_ID: target.modelId,
          AIEVAL_LIVE_BASE: options.base,
          ...(caseId === null ? {} : { AIEVAL_LIVE_CASE_ID: caseId }),
          // ⑤⑥ 只在开了这一档时有意义（它让评分走**智能体**而不是文本 API）
          ...(options.agentJudge ? { AIEVAL_LIVE_AGENT_JUDGE: '1' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let tail = '';
    child.stdout.on('data', (chunk) => {
      tail = (tail + String(chunk)).slice(-20000);
    });
    child.stderr.on('data', (chunk) => {
      tail = (tail + String(chunk)).slice(-20000);
    });
    child.on('close', (code) => {
      const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
      let cells = [];
      try {
        cells = cellsFromReport(JSON.parse(readFileSync(reportPath, 'utf8')));
      } catch {
        // 报告都没落盘（进程被信号杀掉 / 服务不可用）⇒ 一格都没有，由汇总表如实显示
      }
      rmSync(dir, { recursive: true, force: true });
      resolve({ kind: target.kind, code, seconds, cells, tail });
    });
  });
}

/** 一格的结果标：通过 / 失败 / 跳过（⑤⑥ 在没开智能体评分档时是跳过）/ 没跑到（前置失败）/ 缺席 */
function cellBadge(cell) {
  if (cell.status === 'passed') return '✅';
  if (cell.status === 'skipped') return '⏭️ ';
  if (cell.status === 'missing') return '❔';
  return '❌';
}

function printRun(result) {
  console.log(`\n── ${result.kind} ──（${result.target.providerName} / ${result.target.modelId}）`);
  if (result.cells.length === 0) {
    console.log(`  ${'❌'} 没拿到任何一格的报告（退出码 ${String(result.code)}）——服务起着吗？`);
    const lastLine = result.tail.trim().split('\n').slice(-3).join('\n');
    if (lastLine !== '') console.log(`  末几行输出：\n${lastLine}`);
    return;
  }
  for (const cell of result.cells) {
    const message = cell.messages.length > 0 ? `  ← ${String(cell.messages[0]).split('\n')[0]}` : '';
    console.log(`  ${cellBadge(cell)} ${cell.mark} ${cell.name}${message}`);
  }
  if (result.cells.some((cell) => cell.status === 'blocked')) {
    // 前置失败：把原因抬出来（「用例 id 不存在」这类信息全在输出里，不在报告字段上）
    const reason = reasonFromTail(result.tail);
    if (reason !== '') console.log(`  ↳ 前置失败：${reason}`);
  }
  console.log(`  ⏱  ${result.seconds}s`);
}

/**
 * 这一家算不算绿：**必跑格全通过，且可选格没有失败的**。
 *
 * 可选格**跳过**不算失败（没开那一档时的正常形态），但也不算覆盖过——汇总里单独列「未覆盖」。
 */
function isGreen(result) {
  const required = result.cells.filter((cell) => REQUIRED_MARKS.includes(cell.mark));
  if (!(required.length > 0 && required.every((cell) => cell.status === 'passed'))) return false;
  // 开了档却跑挂 ⇒ 当然不算绿（跳过不在此列：那是没开档的正常形态）
  return result.cells.every((cell) => !(OPTIONAL_MARKS.includes(cell.mark) && cell.status === 'failed'));
}

/**
 * 这一轮**没覆盖到**的可选格：**只给圈码**。
 *
 * 判据是 `skipped`（因没开档而没跑），**不是**「任何非 passed」：开了档却跑挂的那些格不是
 * 「未覆盖」，是**不合格**——把它列成未覆盖会把一次真失败说成「没测」。
 *
 * 为什么不带格名：台账是产品源码里的运行时字符串，受 `business-agnostic` 守卫管——格名里有领域词
 * （「智能体评分」），粘进去那一条会当场红。脚本的建议行必须**能直接粘贴**。
 */
function uncoveredMarks(result) {
  return result.cells
    .filter((cell) => OPTIONAL_MARKS.includes(cell.mark) && cell.status === 'skipped')
    .map((cell) => cell.mark);
}

/** 同一件事的可读形态（终端汇总用，带格名——那不进源码） */
function uncoveredNames(result) {
  return result.cells
    .filter((cell) => OPTIONAL_MARKS.includes(cell.mark) && cell.status === 'skipped')
    .map((cell) => `${cell.mark}${cell.name}`);
}

function printLedgerHint(results) {
  const today = new Date().toISOString().slice(0, 10);
  const greens = results.filter(isGreen);
  if (greens.length === 0) {
    console.log('\n[live-smoke] 没有一家是绿的（必跑格要全过），台账不动。');
    return;
  }
  console.log('\n[live-smoke] 覆盖台账（packages/server/agents/src/testing/live-smoke-checks.ts）——把跑过的那几行换成：');
  for (const result of greens) {
    const missed = uncoveredMarks(result);
    // 文案要**准确**：默认档下 ⑤⑥ 没跑，写「四格通过」会让人以为七格都验过了
    const scope =
      missed.length === 0
        ? '七格全通过'
        : `必跑五格通过；${missed.join(' / ')} 未覆盖（要 AIEVAL_LIVE_AGENT_JUDGE=1）`;
    console.log(
      `  ${result.kind}: '${scope}（${today}：AIEVAL_LIVE_KIND=${result.kind}，`
      + `provider ${result.target.providerName} / ${result.target.modelId}，墙钟 ${result.seconds}s）',`,
    );
  }
  console.log('  （没跑过的家保持原样；台账是「编译期强制回答的清单」，不是机器验证。）');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let cases;
  let groups;
  try {
    cases = await fetchJson(options.base, '/api/cases');
    groups = await fetchJson(options.base, '/api/runs/model-options');
  } catch (error) {
    console.error(`[live-smoke] 连不上服务或取不到候选：${error instanceof Error ? error.message : String(error)}`);
    console.error(`[live-smoke] 先起服务（pnpm dev，默认 http://localhost:3083），再重跑。`);
    process.exit(1);
  }

  /** `/api/cases` 的信封是 `{ cases: [...] }`（不是裸数组）——两种形态都认，免得契约换信封时静默取空 */
  const caseList = Array.isArray(cases) ? cases : (cases.cases ?? []);
  const caseId = options.caseId ?? caseList[0]?.id ?? null;
  // dry-run 没有用例也照跑：它只列候选与将执行的命令，用例是**真跑**时才需要的
  if (caseId === null && !options.dryRun) {
    console.error('[live-smoke] 一条用例都没有：先在 /cases 建一条，或用 --case 指定。');
    process.exit(1);
  }
  const { targets, skipped } = pickTargets(groups, options.kinds);
  if (targets.length === 0) {
    console.error('[live-smoke] 没有任何可跑的家（候选为空）。先到设置页配供应商与模型。');
    for (const one of skipped) console.error(`  · ${one.kind}：${one.reason}`);
    process.exit(1);
  }
  // `--provider` / `--model`：换掉候选池给的第一个组合（诊断用——第一个候选常常不是你要跑的那个）。
  // 只对**单家**开口：多家里指定一个 provider 会让其余家也拿到同一个候选，那是静默的错误结果。
  if (options.providerId !== null || options.modelId !== null) {
    if (targets.length !== 1) {
      console.error('[live-smoke] --provider / --model 只与单个 --kind 搭配使用（多家里覆盖候选会静默跑错组合）。');
      process.exit(2);
    }
    const only = targets[0];
    targets[0] = {
      ...only,
      providerId: options.providerId ?? only.providerId,
      modelId: options.modelId ?? only.modelId,
    };
  }

  console.log(`[live-smoke] 服务 ${options.base}｜用例 ${caseId ?? '（还没建）'}｜要跑 ${targets.length} 家`);
  for (const one of skipped) console.log(`  ⏭️  ${one.kind} 跳过：${one.reason}`);
  for (const one of targets) console.log(`  · ${one.kind} → ${one.providerName} / ${one.modelId}`);

  if (options.dryRun) {
    console.log('\n[live-smoke] --dry-run：真跑的话会执行（逐家、串行）：');
    for (const one of targets) {
      console.log(
        `  AIEVAL_LIVE_SMOKE=1 ${options.agentJudge ? 'AIEVAL_LIVE_AGENT_JUDGE=1 ' : ''}AIEVAL_LIVE_KIND=${one.kind} `
        + `AIEVAL_LIVE_PROVIDER_ID=${one.providerId} `
        + `AIEVAL_LIVE_MODEL_ID=${one.modelId} pnpm vitest run ${LIVE_SMOKE_TEST}`,
      );
    }
    process.exit(0);
  }

  const results = [];
  for (const one of targets) {
    console.log(`\n[live-smoke] 跑 ${one.kind}（分钟级，请等）…`);
    const result = await runOne(one, options, caseId);
    result.target = one;
    results.push(result);
    printRun(result);
  }

  console.log('\n════ 汇总 ════');
  for (const result of results) {
    // 「失败」= 明确 failed，或必跑格不是 passed（blocked / missing / skipped 都算没跑成）；
    // 可选格**跳过**不算失败（那是没开档的正常形态，由 `uncovered` 单独列）
    const failed = result.cells.filter(
      (cell) => cell.status === 'failed' || (REQUIRED_MARKS.includes(cell.mark) && cell.status !== 'passed'),
    );
    const missed = uncoveredNames(result);
    let verdict;
    if (failed.length > 0) verdict = `未过：${failed.map((cell) => `${cell.mark}${cell.name}`).join(' / ')}`;
    else if (isGreen(result)) verdict = missed.length === 0 ? '七格通过' : `必跑格通过（${missed.join(' / ')} 未覆盖）`;
    else verdict = '没有报告';
    console.log(`  ${result.kind.padEnd(6)} ${verdict}（${result.seconds}s）`);
  }
  printLedgerHint(results);

  if (options.jsonPath !== null) {
    const payload = results.map((one) => ({
      kind: one.kind,
      providerId: one.target.providerId,
      modelId: one.target.modelId,
      seconds: one.seconds,
      green: isGreen(one),
      cells: one.cells.map((cell) => ({ mark: cell.mark, name: cell.name, status: cell.status })),
    }));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(options.jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`\n[live-smoke] 结果已写入 ${options.jsonPath}`);
  }

  process.exit(results.every(isGreen) ? 0 : 1);
}

await main();
