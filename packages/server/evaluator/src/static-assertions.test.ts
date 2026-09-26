// @vitest-environment node
/**
 * 源码级不变量：T5 的「**每次状态变更由同一个函数同时写快照与追加事件**」（评审 C1）。
 *
 * 为什么这条不变式只能扫源码：违反它的实现与正确的实现在**运行期可观测结果上完全一样**。
 * 评审自设计的时序变异体——把第 7 步的 `setRowStatus(…, 'judging')` 拆成
 * `patchRow({status:'judging'})` → `await yieldToEventLoop()` → `publishRowEvent({type:'status'})`——
 * 终态与事件序列一字不变，整套 14 个用例**全绿存活**；唯一的差别在那个 `setImmediate` 窗口里：
 * `run.json` 已说 `judging` 而 `events.jsonl` 里还没有这条状态事件，并发读会看到「快照比日志超前一步」。
 *
 * 所以判据做成**结构式断言**（确定性、不受调度影响）。行为式的并发观察者为什么不选：窗口的开合由
 * `setImmediate` 与微任务的相对顺序决定——变异体的 `await yieldToEventLoop()` 的续体就在它自己的
 * `setImmediate` 回调之后立刻以微任务运行，而观察者的 `setImmediate` 回调排在后面，**很容易整个错过窗口**
 * （观察到「一致」却什么都没证明）。仓内已有同类手法：agents 包的 `static-assertions.test.ts`。
 *
/**
 * 扫描面是 evaluator 包自己的 `src/**`（**排除 `*.test.ts`**）：本文件里的正则字面量与变异体样本
 * 会把规则自己判违规（与 agents 包同一条理由）。注释先被剥掉——文档里正好在讨论
 * 「直接 `row.status = …` 再 `saveRun`」这种写法，不去注释就会把说明判成违规。
 *
 * **T6 的扩展（窄口，判据没放松）**：轮级状态机需要写 `EvalRun.status` / `startedAt` / `finishedAt`，
 * 而它不可能走 `mutateRow`（那个函数的定位参数是 `(runId, rowId)`，轮级收尾发生在所有行都结束之后，
 * 没有「当事行」）。于是允许**第二个具名写入点** `setRunStatus`，它只碰轮级的三个字段。
 * 这不是给行级开口子：① 判据仍是「`saveRun(` 只出现在两个具名函数体内」，其余任何位置照旧违规；
 * ② `setRunStatus` 里没有状态事件、也不会写行字段（要写行字段必须经过 `Object.assign(row, …)`，
 * 那条判据的允许集合没变）；③ 样本表里新增了「把轮级写入点搬到别处」的反例，证明这个窄口不是放行。
 * 轮级为什么不需要「同时追加事件」：契约 §2.6 / spec §7.4 的 `AgentEvent` 七个成员全是行级的，
 * 事件日志也按行落盘，轮级状态在协议里没有对应的事件类型可写。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 状态不变式的宿主文件（`setRowStatus` / `patchRow` / `mutateRow` 都在这里） */
const ORCHESTRATOR = 'orchestrator.ts';

/** 包内全部非测试源码（相对 src，Windows 分隔符统一成正斜杠） */
function sourceFiles(): string[] {
  return readdirSync(import.meta.dirname, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    /**
     * `src/testing/**` 是**测试脚手架**（夹具、编排 harness、注入接缝），不是产品源码：
     * 夹具本来就真的要 `saveRun` 一轮评测出来才谈得上被测，把它算成「产品里的第三个写入点」
     * 是把判据问错了对象。产品源码里出现第三个写入点仍然照红——这条排除只让扫描面回到
     * 「会被打进产物、会在生产里写盘的那些文件」，判据本身一个字没放松。
     */
    .filter((entry) => !entry.startsWith('testing/'));
}

/**
 * 去掉注释、只留可执行源码。**保持行号不变**（块注释按原字符数换成空格，行注释整段删掉），
 * 这样违规信息里的行号就是人肉打开文件时的行号。
 * 已知局限（与 agents 包同款、如实登记）：正则不区分字符串字面量里的 `//`，含 `://` 的字符串常量会被
 * 从该行截断——方向是漏报而不是误报；`orchestrator.ts` 今天没有任何含 `//` 的字符串（已逐行核对）。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/** 每个匹配的起始下标（`pattern` 必须是带 `g` 的正则） */
function occurrences(text: string, pattern: RegExp): number[] {
  const indexes: number[] = [];
  for (const match of text.matchAll(pattern)) indexes.push(match.index ?? 0);
  return indexes;
}

/**
 * `saveRun` 的**调用点**：排除 `export function saveRun(` 这个定义本身（判据问的是「谁在写盘」，
 * 而定义在 run-store.ts 里，必然要出现一次）。`(?<![\w.])` 同时排除对象方法调用。
 */
const SAVE_RUN_CALL = /(?<![\w.])(?<!function )saveRun\(/g;

/** 状态事件字面量：`{ type: 'status'`（唯一发布点只能是 setRowStatus） */
const STATUS_EVENT = /\{\s*type:\s*'status'/g;

/** 下标对应的行号（1 起） */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * 取 `function <name>(…) { … }` 的函数体**在源码里的下标区间**（按花括号配平）。
 * 为什么不用行号区间：函数体里有箭头函数、对象字面量，空行与排版一变就错位；
 * 花括号配平对「谁在里面」是精确的（本仓的源码里字符串不含花括号本身，模板串的 `${}` 是配平的）。
 */
function functionRange(source: string, name: string): [number, number] {
  const start = source.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  const open = source.indexOf('{', start);
  if (open < 0) throw new Error(`函数 ${name} 没有函数体`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return [open, index];
    }
  }
  throw new Error(`函数 ${name} 的花括号不配平`);
}

/**
 * 一份源码里对「状态变更单一写入点」的全部违规（空数组 = 这条不变式成立）。
 * 五条判据（前三条是「写入点必须落在哪个函数里」，后两条是「不许有第二种写法」）：
 *   ① 状态事件（`{ type: 'status'`）只出现在 `setRowStatus` 里，且至少有一处；
 *   ② 行字段写入（`Object.assign(row, …)`）只出现在 `setRowStatus` / `patchRow` 里，且至少有一处；
 *   ③ 快照落盘（`saveRun(…)` 调用）只出现在 `mutateRow`（**行级**唯一出口）或 `setRunStatus`
 *      （**轮级**唯一出口，T6 追加）里，且至少有一处；
 *   ④ 不出现 `.status = …` 的直接赋值；
 *   ⑤ `patchRow` / `mutateRow` 的实参里不出现 `status` 令牌（一次状态变更不许从 patch 侧夹带进来）。
 * ①②③ 的「至少有一处」不是凑数：把写入点整个删掉（例如状态事件不再发布）同样是这条不变式的破坏。
 */
function statusWriteViolations(source: string): string[] {
  const text = stripComments(source);
  const violations: string[] = [];

  let setRowStatus: [number, number];
  let patchRow: [number, number];
  let mutateRow: [number, number];
  let setRunStatus: [number, number];
  try {
    setRowStatus = functionRange(text, 'setRowStatus');
    patchRow = functionRange(text, 'patchRow');
    mutateRow = functionRange(text, 'mutateRow');
    setRunStatus = functionRange(text, 'setRunStatus');
  } catch (error) {
    // 判据的前提没了（函数被改名 / 拆走）必须显式失败：静默跳过等于这条守卫悄悄失效
    return [`判据的前提不成立：${error instanceof Error ? error.message : String(error)}`];
  }

  const inside = (index: number, ranges: Array<[number, number]>): boolean =>
    ranges.some(([start, end]) => index >= start && index <= end);

  const rules: Array<[RegExp, string, Array<[number, number]>]> = [
    [STATUS_EVENT, '状态事件（快照与事件必须由 setRowStatus 一起写）', [setRowStatus]],
    [/Object\.assign\(\s*row,/g, '行字段写入（只允许 setRowStatus / patchRow）', [setRowStatus, patchRow]],
    [
      SAVE_RUN_CALL,
      '快照落盘（行级唯一出口是 mutateRow、轮级唯一出口是 setRunStatus）',
      [mutateRow, setRunStatus],
    ],
  ];
  for (const [pattern, why, allowed] of rules) {
    const hits = occurrences(text, pattern);
    if (hits.length === 0) violations.push(`${why}：一处都没有（这个写入点消失了）`);
    for (const index of hits) {
      if (!inside(index, allowed)) violations.push(`${why}：出现在第 ${lineOf(text, index)} 行`);
    }
  }

  for (const index of occurrences(text, /\.status\s*=(?!=)/g)) {
    violations.push(`直接给 .status 赋值（第二个状态写入点）：第 ${lineOf(text, index)} 行`);
  }
  for (const index of occurrences(text, /(?:patchRow|mutateRow)\s*\([^)]*\bstatus\b/g)) {
    violations.push(`patchRow / mutateRow 的实参里夹带 status：第 ${lineOf(text, index)} 行`);
  }
  return violations;
}

/** 读一个包内源文件（剥注释前） */
function readSource(file: string): string {
  return readFileSync(join(import.meta.dirname, file), 'utf8');
}

/**
 * 判据的样本表：每一条都是「违反不变式的一种写法」，且都是**自包含**的小源码
 * （不依赖真实源码的排版，改真实源码不会让样本表过期）。
 * 第 1 条是评审自设计的存活变异体（把一次状态变更拆成两次写 + 中间让出事件循环）。
 */
const VIOLATION_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  [
    '把一次状态变更拆成「先写快照 → 让出事件循环 → 再追加事件」（评审 C1 的存活变异体）',
    `
async function runRowAttempt(runId: string, rowId: string): Promise<void> {
  patchRow(runId, rowId, { status: 'judging' });
  await yieldToEventLoop();
  publishRowEvent(runId, rowId, { type: 'status', status: 'judging' });
}
function setRowStatus(runId: string, rowId: string, status: EvalRowStatus, patch?: Partial<EvalRow>): EvalRun {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch ?? {}, { status });
  });
  publishRowEvent(runId, rowId, { type: 'status', status });
  return getRunForWrite(runId);
}
function patchRow(runId: string, rowId: string, patch: Partial<EvalRow>): void {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch);
  });
}
function mutateRow(runId: string, rowId: string, mutate: (row: EvalRow) => void): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  mutate(row);
  saveRun(run);
  return run;
}
function setRunStatus(runId: string, patch: RunStatusPatch): EvalRun {
  const next: EvalRun = { ...getRunForWrite(runId), ...patch };
  saveRun(next);
  return next;
}
`,
  ],
  [
    '直接给 row.status 赋值后再 saveRun（绕过 setRowStatus 的第二条快照路径）',
    `
function setRowStatus(runId: string, rowId: string, status: EvalRowStatus, patch?: Partial<EvalRow>): EvalRun {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch ?? {}, { status });
  });
  publishRowEvent(runId, rowId, { type: 'status', status });
  return getRunForWrite(runId);
}
function patchRow(runId: string, rowId: string, patch: Partial<EvalRow>): void {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch);
  });
}
function mutateRow(runId: string, rowId: string, mutate: (row: EvalRow) => void): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  mutate(row);
  saveRun(run);
  return run;
}
function setRunStatus(runId: string, patch: RunStatusPatch): EvalRun {
  const next: EvalRun = { ...getRunForWrite(runId), ...patch };
  saveRun(next);
  return next;
}
function markJudging(runId: string, rowId: string): void {
  const { run, row } = requireRow(runId, rowId);
  row.status = 'judging';
  saveRun(run);
}
`,
  ],
  [
    '把状态事件搬到 patchRow 里（快照与事件不再由同一个函数写）',
    `
function setRowStatus(runId: string, rowId: string, status: EvalRowStatus, patch?: Partial<EvalRow>): EvalRun {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch ?? {}, { status });
  });
  return getRunForWrite(runId);
}
function patchRow(runId: string, rowId: string, patch: Partial<EvalRow>): void {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch);
  });
  publishRowEvent(runId, rowId, { type: 'status', status: 'running' });
}
function mutateRow(runId: string, rowId: string, mutate: (row: EvalRow) => void): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  mutate(row);
  saveRun(run);
  return run;
}
function setRunStatus(runId: string, patch: RunStatusPatch): EvalRun {
  const next: EvalRun = { ...getRunForWrite(runId), ...patch };
  saveRun(next);
  return next;
}
`,
  ],
  [
    '把轮级快照的写入点从 setRunStatus 搬到 finalizeRun（轮级出现第二个 saveRun 出口，T6 的窄口不许放行）',
    `
function setRowStatus(runId: string, rowId: string, status: EvalRowStatus, patch?: Partial<EvalRow>): EvalRun {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch ?? {}, { status });
  });
  publishRowEvent(runId, rowId, { type: 'status', status });
  return getRunForWrite(runId);
}
function patchRow(runId: string, rowId: string, patch: Partial<EvalRow>): void {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch);
  });
}
function mutateRow(runId: string, rowId: string, mutate: (row: EvalRow) => void): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  mutate(row);
  saveRun(run);
  return run;
}
function setRunStatus(runId: string, patch: RunStatusPatch): EvalRun {
  const next: EvalRun = { ...getRunForWrite(runId), ...patch };
  saveRun(next);
  return next;
}
function finalizeRun(runId: string): void {
  const run = getRunForWrite(runId);
  saveRun({ ...run, status: 'partial', finishedAt: new Date().toISOString() });
}
`,
  ],
  [
    '在第三个函数里另起一处 saveRun（阶段评审 E5 的形状：`abortRow` 内，既不是 mutateRow 也不是 setRunStatus）',
    `
function setRowStatus(runId: string, rowId: string, status: EvalRowStatus, patch?: Partial<EvalRow>): EvalRun {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch ?? {}, { status });
  });
  publishRowEvent(runId, rowId, { type: 'status', status });
  return getRunForWrite(runId);
}
function patchRow(runId: string, rowId: string, patch: Partial<EvalRow>): void {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch);
  });
}
function mutateRow(runId: string, rowId: string, mutate: (row: EvalRow) => void): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  mutate(row);
  saveRun(run);
  return run;
}
function setRunStatus(runId: string, patch: RunStatusPatch): EvalRun {
  const next: EvalRun = { ...getRunForWrite(runId), ...patch };
  saveRun(next);
  return next;
}
function abortRow(runId: string, rowId: string): void {
  const { run } = requireRow(runId, rowId);
  saveRun({ ...run, rows: run.rows.filter((item) => item.id !== rowId) });
}
`,
  ],
  [
    '在 setRowStatus / patchRow 之外直接改行字段（`Object.assign(row, …)` 出圈：行快照的第二个写入路径）',
    `
function setRowStatus(runId: string, rowId: string, status: EvalRowStatus, patch?: Partial<EvalRow>): EvalRun {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch ?? {}, { status });
  });
  publishRowEvent(runId, rowId, { type: 'status', status });
  return getRunForWrite(runId);
}
function patchRow(runId: string, rowId: string, patch: Partial<EvalRow>): void {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch);
  });
}
function mutateRow(runId: string, rowId: string, mutate: (row: EvalRow) => void): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  mutate(row);
  saveRun(run);
  return run;
}
function setRunStatus(runId: string, patch: RunStatusPatch): EvalRun {
  const next: EvalRun = { ...getRunForWrite(runId), ...patch };
  saveRun(next);
  return next;
}
function clearRowScore(runId: string, rowId: string): void {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, { score: null });
  });
}
`,
  ],
];

describe('源码级不变量：T5 的状态变更单一写入点（评审 C1）', () => {
  it('orchestrator.ts 里「写快照 + 追加状态事件」只由 setRowStatus 成对完成，别处没有第二条状态写路径', () => {
    // 为什么这条守卫必须存在：把一次状态变更拆成两次写，最终状态与事件序列一字不差（14 个用例全绿），
    // 但 run.json 与 events.jsonl 之间会出现「快照比日志超前一步」的真实窗口——并发读看到状态对不上。
    expect(statusWriteViolations(readSource(ORCHESTRATOR))).toEqual([]);
  });

  it('整包的非测试源码里，status 事件与快照落盘都不在其它文件里另起写入点', () => {
    // 状态不变式的宿主是 orchestrator.ts；这条把「另开一个文件写状态」也一并拦住
    //（例如将来在 events.ts / run-store.ts 里补一条「顺手把行标成 …」的路径）。
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === ORCHESTRATOR) continue;
      const text = stripComments(readSource(file));
      for (const index of occurrences(text, STATUS_EVENT)) {
        offenders.push(`${file}：第 ${lineOf(text, index)} 行发布了状态事件`);
      }
      for (const index of occurrences(text, SAVE_RUN_CALL)) {
        offenders.push(`${file}：第 ${lineOf(text, index)} 行直接调用了 saveRun`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('判据能拦住各种「拆开写」的写法（判据自己有覆盖，不是恒绿的空转）', () => {
    // 上一条只能证明「当前源码干净」，证明不了判据**有覆盖**。这里把写法直接喂给判据本身：
    // 判据被改窄（例如只看事件不看快照）时，样本会立刻暴露它。
    // 样本都是字符串字面量，本文件是 `*.test.ts`（被 sourceFiles 排除），不会与上一条互相判违规。
    // 样本数不写死在标题里（它是**会随判据边界增长**的集合，写死一个数字只会让标题过期）。
    for (const [why, sample] of VIOLATION_SAMPLES) {
      expect(statusWriteViolations(sample), `应当命中：${why}`).not.toEqual([]);
    }
  });

  /**
   * R29 的守卫（终审 §2-M7 点名它「有落点但无守卫」）。
   *
   * R29 的裁决是「**p4 的编排层不再单独调 `ensureCaseCache`**」——用例缓存的预热归 `core/workspace.ts`
   * 的 `prepareRowWorkspace`（唯一的 `ensureCaseCache` 调用点）。终审复核的实测事实是：
   * `evaluator/src` 里 `ensureCaseCache` **只出现在 `orchestrator.ts:20` 的注释里**，
   * 没有任何测试断言「它不被调用」⇒ 将来有人在编排层补一句预热（看似优化、实则多一份缓存真源）
   * 不会有任何测试变红。
   *
   * 判据刻意扫**去掉注释后的源码**：注释里正当地讨论着这件事（`orchestrator.ts` 的文件头），
   * 不去注释就会把说明判成违规——这也顺带钉住「它只出现在注释里」这个当前事实。
   */
  it('编排层不自己预热用例缓存：ensureCaseCache 不出现在任何非测试源码里（R29，注释除外）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = stripComments(readSource(file));
      for (const index of occurrences(text, /\bensureCaseCache\b/g)) {
        offenders.push(`${file}：第 ${lineOf(text, index)} 行调用了 ensureCaseCache`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * 拆分后的编排测试文件（`orchestrator-*.test.ts`）**各自注册三条 mock** 的守卫。
 *
 * 为什么必须有这条守卫：`vi.mock` 的前置提升**只作用于测试文件自己**（vitest 的机制，
 * 不是风格选择），所以三条注册在各文件里逐字重复。漏掉一条的后果**不是红**，而是静默地
 * 退回真实实现——本仓已有先例：`apps/web-next/vitest.config.ts` 的 `@aieval/evaluator` alias
 * 缺失时，`vi.mock` 静默失效并**真的 spawn 了 agent 子进程**。具体三种漏法：
 *   · 漏 `@aieval/agents` → 真的去起厂商 CLI（最慢、且可能联网）；
 *   · 漏 `./judge` → 真的去调评分模型；
 *   · 漏 `./run-store` → 注入接缝失效，那几条用例以 `Cannot set properties of undefined` 红，
 *     错误信息与它要守的语义（落盘失败回退）毫无关系。
 *
 * 文件条数也一并钉住：新增一个拆分文件时这条会先红一次，逼作者回来看这里的规则。
 */
describe('拆分后的编排测试文件各自注册 mock（防静默退回真实实现）', () => {
  /** 拆分出来的文件：`orchestrator-*.test.ts`，但 `orchestrator-live.test.ts` 是拆分前就有的另一个文件 */
  const splitFiles = readdirSync(import.meta.dirname)
    .map((entry) => String(entry))
    .filter((entry) => /^orchestrator-.*\.test\.ts$/.test(entry) && entry !== 'orchestrator-live.test.ts')
    .sort();

  const REQUIRED_MOCKS = ['vi.mock(\'@aieval/agents\'', 'vi.mock(\'./judge\'', 'vi.mock(\'./run-store\''];

  it('拆分出的文件条数与登记一致（新增文件必须回到这里更新清单）', () => {
    // 这是一条**绊线**：它不校验什么业务规则，只保证「有人新增一个拆分文件」时这里先红一次，
    // 逼作者回来看一眼（新增的那个文件有没有照抄三条 `vi.mock`）。
    // 15：第四轮 13 个，第五轮又把 `orchestrator-execution-mode` 与 `orchestrator-retry` 各按用例切一半。
    // 16：第六轮加了 `orchestrator-single-row`（单行执行的范围守卫，2026-09-29 用户口径）。
    // 历史上它已经红过三次，三次都抓到真实的漏更新——第四次就是上面这个 16。
    expect(splitFiles).toHaveLength(16);
  });

  it('每个文件都自己注册了三条 mock', () => {
    const missing = splitFiles.flatMap((file) => {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      return REQUIRED_MOCKS.filter((needle) => !text.includes(needle)).map((needle) => `${file} 缺 ${needle}`);
    });
    expect(missing).toEqual([]);
  });
});
