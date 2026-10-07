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
import { join, posix } from 'node:path';
import ts from 'typescript';
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
    // 18（2026-10-02）：把上面那两个「各切一半」的文件再拆一层，得到
    // `orchestrator-execution-mode-b` 与 `orchestrator-retry-b`——两个新文件都照抄了三条 `vi.mock`
    // （下一条用例覆盖这一点），这里只补计数。**注意本清单不含 `orchestrator-live.test.ts`**
    // （它是拆分前就有的另一个文件，见上面的过滤器）。
    expect(splitFiles).toHaveLength(17);
  });

  it('每个文件都自己注册了三条 mock', () => {
    const missing = splitFiles.flatMap((file) => {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      return REQUIRED_MOCKS.filter((needle) => !text.includes(needle)).map((needle) => `${file} 缺 ${needle}`);
    });
    expect(missing).toEqual([]);
  });
});

/**
 * **工厂动态 import 的闭包里，不得存在对「被 mock 的项目模块」的运行时边**（2026-10-06）。
 *
 * 为什么必须有这条守卫：`vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock())`
 * 这类工厂在**收集阶段**就要把目标模块求值出来，于是「工厂 → seams → fixtures → **正在求值中**的
 * `@aieval/agents`」构成一条 vite ModuleRunner **解不开的 await 环**：整个文件 **0 个用例、无报错、
 * 无超时、零 CPU**（本包实测 19/27 个文件如此 ⇒ `pnpm test` 这个动作整个不成立；根因见 spec
 * `docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md` §9.1）。
 *
 * 为什么不能靠上面那条守卫（三条 `vi.mock` 文本的存在性）：
 *   · 它与缺陷**同向**——mock 注册得越齐它越绿，而**注册齐全正是触发条件之一**（19 个挂死文件
 *     在那条守卫下全绿，却一个用例都跑不了）；
 *   · 环的形状是「A 的工厂 → B → C → A」，任何**单文件**的文本里都看不到它。
 *
 * 判据分三步（v3 spec §9.1）：
 *   ① MOCKED  ← 一张**登记表**（`MOCKED_MODULES`）：所有被 mock 的**项目模块**。`node:` 内建
 *      **刻意不入表**——`run-delete.test.ts:32` / `run-store.test.ts:21` mock 了 `node:fs`，而
 *      `fixtures.ts:11` 必须能 import 它（建临时家目录），把内建纳入判据会让守卫**落地即红**，
 *      且环发生在**项目模块**之间；
 *   ② ROOTS   ← 扫 `src/**\/*.test.ts` 里每个 `vi.mock(…)` 的**工厂实参**子树，取其中的
 *      `import('<字面量>')`；工厂里出现**非字面量**目标 ⇒ 直接判红（推导不出来就不放行）；
 *   ③ 违规    ← 从 ROOTS 出发沿**运行时相对 import** 走 `src/` 内的本地文件得到闭包，
 *      闭包里任一文件对 MOCKED 里任一目标存在运行时边 ⇒ 红，报 `文件:行: 说明符`。
 *
 * 为什么范围是「工厂目标的静态可达闭包」而不是整个 `src/testing/`：`orchestrator-harness.ts:40`
 * **运行时** import `../run-store`（它自己也是被 mock 的模块），而 harness **不是**任何工厂的目标
 * ⇒ 把整个目录纳入，守卫**落地那一刻就是红的**，而那不是本缺陷（假红会诱使人削弱断言 —— 这正是
 * 本仓反复登记的教训）。
 *
 * 已知边界（如实登记，不许当成守卫失效，v3 spec §9.1）：拼字符串的 `require`、
 * `import(变量)` 这类推导不出来的形态（工厂目标的那一半已由 ② 判红兜住）、以及下面显式放行的
 * `vi.importActual`。
 *
 * ⚠️ **还有一条盲区：工厂体写成静态 import 时守卫完全看不见**（2026-10-07 终审要求登记在此）：
 * 若把 mock 写成 `vi.mock('@aieval/agents', seams.agentsMock)` 这种**标识符**形式（工厂体来自
 * 文件顶部的静态 import，而不是内联的 `async () => (await import('…')).agentsMock()`），
 * ② 就取不到任何 `import('<字面量>')` ⇒ **ROOTS 为空 ⇒ 整条判据静默放行**（不报错、不红）。
 * 它**当前没有活体实例**：本包 **27** 个测试文件里 **22 个**含带工厂的 `vi.mock`、共 **58 处**，
 * 这 58 处的工厂体**全部**（58/58，逐一配平括号实测过）是内联
 * `async () => (await import('<字面量>'))…` 形态 ⇒ ROOTS 非空、判据确实在跑。
 * （`static-assertions.test.ts` 里另有 3 处 `vi.mock(` 只出现在**样本字符串**里，不是真 mock，不计入 58。）
 * 但这是判据的**结构性缺口**：本盲区**同时登记在两处入库载体** —— 这段 JSDoc 与
 * `docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md`
 * （`.superpowers/` 下的 ledger 是 gitignore 的，不算入库载体）。
 * 要真正堵住它，得追静态 import 的绑定来源（属独立一条线，本线不扩环）。
 */

/** 一条「运行时触碰了某个模块」的记录；`kind` 决定它是否被放行 */
interface RuntimeTouch {
  /** `import-actual` 是 `vi.importActual(…)`：mock 系统的旁路 API，**显式放行**（spec §4.4） */
  kind: 'static-import' | 'dynamic-import' | 'require' | 'import-actual';
  /** 说明符原文（未归一化）；非字面量目标记成 `<非字面量>` */
  specifier: string;
  /** 源码行号（1 起） */
  line: number;
}

/**
 * 被 mock 的项目模块**登记表**（不靠类型推导，靠下面那条绊线用例与源码保持同步）。
 * `key` 是归一后的模块身份：裸说明符原样，相对说明符归一成相对 `src/` 的路径（不带扩展名）
 * ⇒ 从 `src/testing/` 看，`../judge` 与从 `src/` 看的 `./judge` 是**同一个身份**。
 */
const MOCKED_MODULES: ReadonlyArray<{ label: string; key: string }> = [
  // 三方：orchestrator-run-row.test.ts:12、judge-agent.test.ts:18、run-delete.test.ts:39 等
  { label: '@aieval/agents', key: '@aieval/agents' },
  // 本地：orchestrator-run-row.test.ts:13 / :17；judge.test.ts:22（同一类环的另一个入口）
  { label: './judge', key: 'judge' },
  { label: './run-store', key: 'run-store' },
  { label: './text-api', key: 'text-api' },
];

/** `src/**\/*.test.ts`（相对 src，正斜杠）——`vi.mock` 只可能写在测试文件里 */
function testFiles(): string[] {
  return readdirSync(import.meta.dirname, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.test.ts'));
}

/** `src/**\/*.ts`（含 `testing/**` 与测试文件）：闭包只在本包的文件里走 */
function allSourceFiles(): string[] {
  return readdirSync(import.meta.dirname, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.ts'));
}

/** 字符串字面量节点的文本；不是字面量（含 undefined）时为 null */
function literalText(node: ts.Node | undefined): string | null {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * 把说明符归一成**模块身份**：相对说明符按 `fromFile` 所在目录归一成相对 `src/` 的路径
 * （去掉 `.ts`）；裸说明符原样返回。只比身份，不校验文件是否存在。
 */
function moduleKey(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return posix.normalize(posix.join(posix.dirname(fromFile), specifier)).replace(/\.ts$/, '');
}

/**
 * 顶层语句是不是一条**运行时**模块引用（spec §4.2 的逐形态表）。
 *
 * ⚠️ **import 侧只有整条 `import type { … }` 才算非运行时边**（2026-10-07 收窄，评审 Important）：
 * `verbatimModuleSyntax: true`（`tsconfig.base.json:5`）只擦除 `import type`，而**混合形态**
 * （`import { type A, type B }`、`import { type A }`、`import {}`）会被保留成 `import {} from 'x'`
 * —— **那仍是一次运行时模块请求**。实测（vite@8.3.0 的 SSR transform = vitest 走的同一条管线；
 * 探针放在 `testing/fixtures.ts` 同目录以继承本包 tsconfig）的 `__vite_ssr_import__` 条数：
 *   · `import type { A } from '@aieval/agents'`         → **0**
 *   · `import { type A, type B } from '@aieval/agents'` → **1**
 *   · `import { type A } from '@aieval/agents'`         → **1**
 *   · `import {} from '@aieval/agents'`                 → **1**
 * 按「任一成员不带 `type`」判会被它们蒙过去：把混合 import 的最后一个值成员删掉（= T1 修复的
 * **逆操作**）会让收集期静默挂死回来，而守卫绿、样本表还反向背书。故 `isTypeOnly` 之外**一律**算。
 */
function isRuntimeModuleStatement(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return true; // `import 'x'`：副作用导入
    if (clause.isTypeOnly) return false; // 整条 `import type { … } from`：转译后 0 条请求（实测）
    // 其余一律算运行时边：默认导入 / `import * as ns from` / 命名子句（含成员全带 `type` 的
    // 混合形态、以及空子句 `import {} from`）—— 实测它们转译后都是 1 条请求
    return true;
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.moduleSpecifier === undefined) return false; // 本地导出，不碰别的模块
    if (statement.isTypeOnly) return false; // `export type { … } from`
    const clause = statement.exportClause;
    if (clause === undefined) return true; // `export * from`
    if (ts.isNamespaceExport(clause)) return true; // `export * as ns from`
    /**
     * export 侧**与 import 侧不对称，别照着 import 改成「一律算」**（2026-10-07 实测）：
     * `export { type A, type B } from 'x'` 与 `export type { … } from 'x'` 都被**整条擦除**
     * （`__vite_ssr_import__` **0** 条），而 `export { type A, getProvider } from 'x'` 是 1 条
     * ⇒ 这里保留「任一成员不带 `type`」。改成一律算运行时边会**凭空误报**（将来闭包里出现一条
     * 合法的 `export { type X } from './judge'` 就会假红）。
     */
    /**
     * ⚠️ **空子句 `export {} from 'x'` 必须单独判红**（2026-10-07 终审收口）：它与 import 侧的
     * 空子句同理——转译后是 **1 条真请求**（实测 `__vite_ssr_import__` 1 条），而
     * `elements.some(…)` 对**空数组**恒返回 `false` ⇒ 少了这一行就会把它**静默放行**。
     * 补之前的状态是「**权威文档判违规、实现判放行**」：spec §4.2 的修正段与 §4.5 的负样本⑪
     * 都写明它违规（那个矛盾此前只记在 gitignore 的 ledger 里，不在任何入库文档里）。
     * 对应的负样本是样本表里的 `export {} from '@aieval/agents';`。
     */
    if (clause.elements.length === 0) return true;
    return clause.elements.some((element) => !element.isTypeOnly);
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    // `import a = require('x')`；`import type a = require('x')` 是类型专用，放行
    return !statement.isTypeOnly && ts.isExternalModuleReference(statement.moduleReference);
  }
  return false;
}

/** 顶层语句的模块说明符文本；不是「带字面量说明符的模块引用」时为 null */
function statementSpecifier(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    return statement.moduleSpecifier === undefined ? null : literalText(statement.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
    return literalText(statement.moduleReference.expression);
  }
  return null;
}

/**
 * 一个文件里全部「运行时触碰模块」的位置。
 *
 * 两条来源互补：顶层声明走 `source.statements`；动态 `import()` / `require()` / `vi.importActual()`
 * 走整棵树的 `CallExpression`（它们可以出现在任何深度）。`typeof import('x')` 是 `ImportTypeNode`
 * （**类型位置**、不是 `CallExpression`）⇒ 天然落在判据之外（这正是正则方案会误报的那个形态）。
 *
 * ⚠️ `vi.importActual(…)` **故意记成一条触碰**（而不是在这里跳过）：放行发生在
 * `mockedRuntimeEdges()` 里 —— 删掉那条放行规则守卫就会红（spec §5.2 的变异 3a：
 * **见过失败才算守卫**）。
 */
function runtimeTouches(file: string, text: string): RuntimeTouch[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const touches: RuntimeTouch[] = [];
  const at = (node: ts.Node): number => lineOf(text, node.getStart(source));
  for (const statement of source.statements) {
    if (!isRuntimeModuleStatement(statement)) continue;
    const specifier = statementSpecifier(statement);
    if (specifier !== null) touches.push({ kind: 'static-import', specifier, line: at(statement) });
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        touches.push({ kind: 'dynamic-import', specifier: literalText(node.arguments[0]) ?? '<非字面量>', line: at(node) });
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'vi' &&
        callee.name.text === 'importActual'
      ) {
        touches.push({ kind: 'import-actual', specifier: literalText(node.arguments[0]) ?? '<非字面量>', line: at(node) });
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        touches.push({ kind: 'require', specifier: literalText(node.arguments[0]) ?? '<非字面量>', line: at(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return touches;
}

/**
 * 一个文件对**被 mock 的项目模块**的运行时边（`文件:行: 说明符（被 mock 的 登记名）`）。
 *
 * `vi.importActual(…)` 在此**显式放行**（spec §4.4）：它是 mock 系统的旁路 API（读的是**真模块**），
 * `fixtures.ts:846` 用它让 `acceptsProtocol` / `protocolMismatchMessage` 与真模块同源 ——
 * 那是 `fixtures.ts:831-835` 记录过的那次事故（缺这两个导出 ⇒ evaluator 16 个文件、83 条用例
 * 一起红，报错点离真因很远）的修复。把它算成运行时边 ⇒ 守卫**落地即红**，还会诱使人去拆掉
 * 那次修复。**这条放行是活代码**：删掉它，守卫必须红（spec §5.2 的变异 3a）。
 */
function mockedRuntimeEdges(file: string, text: string): string[] {
  const edges: string[] = [];
  for (const touch of runtimeTouches(file, text)) {
    if (touch.kind === 'import-actual') continue;
    const mocked = MOCKED_MODULES.find((module) => module.key === moduleKey(file, touch.specifier));
    if (mocked !== undefined) edges.push(`${file}:${touch.line}: ${touch.specifier}（被 mock 的 ${mocked.label}）`);
  }
  return edges;
}

/** 一个文件里全部**运行时相对 import** 的目标（归一后，相对 `src/` 且不带扩展名） */
function runtimeRelativeTargets(file: string, text: string): string[] {
  return runtimeTouches(file, text)
    .filter((touch) => touch.kind !== 'import-actual' && touch.specifier.startsWith('.'))
    .map((touch) => moduleKey(file, touch.specifier));
}

/**
 * 从工厂目标出发，沿**运行时相对 import** 走 `src/` 内的本地文件，得到闭包（含起点）。
 * 只沿相对 import 走：裸说明符（`@aieval/agents` / `node:fs`）不是本包的文件 —— 它们正是判据要
 * 比对的**目标**，不是要展开的中间节点。类型专用 import 不跟着走（不产生运行时边）。
 */
function factoryClosure(target: string): string[] {
  const known = new Set(allSourceFiles());
  const seen = new Set<string>();
  const queue = [`${target}.ts`];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file) || !known.has(file)) continue;
    seen.add(file);
    for (const next of runtimeRelativeTargets(file, readSource(file))) queue.push(`${next}.ts`);
  }
  return [...seen];
}

/** 一条 `vi.mock('<字面量>', <工厂>)` 调用 */
interface MockCall {
  /** 第一个实参（说明符）的文本 */
  specifier: string;
  /** 工厂实参；没有第二实参的注册没有传递 import 图 */
  factory: ts.Expression | undefined;
}

/** 收集一个测试文件里所有「说明符是字面量」的 `vi.mock(…)` 调用 */
function viMockCalls(file: string, text: string): MockCall[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const calls: MockCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'vi' &&
      node.expression.name.text === 'mock'
    ) {
      const specifier = literalText(node.arguments[0]);
      if (specifier !== null) calls.push({ specifier, factory: node.arguments[1] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** 工厂实参里的动态 `import('<字面量>')` 目标（归一后），以及推导不出来的那些 */
interface FactoryImports {
  /** 归一后的目标（相对 `src/`，不带扩展名） */
  targets: string[];
  /** 非字面量的 `import(…)` 目标：推导不出来就不放行（spec §4.2 ②） */
  unresolved: string[];
}

/** 扫一棵工厂实参子树里的动态 `import(…)` */
function factoryImports(file: string, text: string, factory: ts.Expression): FactoryImports {
  const source = factory.getSourceFile();
  const targets: string[] = [];
  const unresolved: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalText(node.arguments[0]);
      if (specifier === null) unresolved.push(`${file}:${lineOf(text, node.getStart(source))}: import(<非字面量>)`);
      else targets.push(moduleKey(file, specifier));
    }
    ts.forEachChild(node, visit);
  };
  visit(factory);
  return { targets, unresolved };
}

describe('工厂动态 import 的闭包不得运行时 import 被 mock 的模块（防收集期静默挂死）', () => {
  it('闭包里没有对「被 mock 的项目模块」的运行时边；工厂里的 import 目标必须是字面量', () => {
    const offenders: string[] = [];
    const unresolved: string[] = [];
    for (const file of testFiles()) {
      const text = readSource(file);
      for (const call of viMockCalls(file, text)) {
        if (call.factory === undefined) continue;
        const imports = factoryImports(file, text, call.factory);
        unresolved.push(...imports.unresolved);
        for (const target of imports.targets) {
          for (const reached of factoryClosure(target)) offenders.push(...mockedRuntimeEdges(reached, readSource(reached)));
        }
      }
    }
    // 推导不出来 ⇒ 不放行（宁可红，也不要一条「看不懂就算过」的守卫）
    expect(unresolved).toEqual([]);
    // 同一个文件会被多个工厂命中，去重后报出来
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('绊线：被 mock 的项目模块与工厂目标，与登记表逐项一致（新增时先红一次）', () => {
    const mockedKeys = new Set<string>();
    const factoryTargets = new Set<string>();
    for (const file of testFiles()) {
      const text = readSource(file);
      for (const call of viMockCalls(file, text)) {
        // ⚠️ `node:` 内建**不入判据**：run-delete.test.ts:32 与 run-store.test.ts:21 mock 了 `node:fs`，
        // 而 fixtures.ts:11 必须能 import 它（建临时家目录）——把内建纳入判据会让守卫**落地即红**，
        // 且环发生在**项目模块**之间（spec §4.2 ① 的 2026-10-06 控制者裁定）。
        if (!call.specifier.startsWith('node:')) mockedKeys.add(moduleKey(file, call.specifier));
        if (call.factory !== undefined) {
          for (const target of factoryImports(file, text, call.factory).targets) factoryTargets.add(target);
        }
      }
    }
    // 本条是**绊线**：新增第三条 `vi.mock` 或第三个工厂目标模块时它先红一次，逼作者回来看
    // 「新模块要不要纳入 MOCKED_MODULES、会不会构成同类环」——沿用本仓的计数绊线手法
    // （见上面 `:449-459`）。
    expect([...mockedKeys].sort()).toEqual(MOCKED_MODULES.map((module) => module.key).sort());
    expect([...mockedKeys].sort()).toEqual(['@aieval/agents', 'judge', 'run-store', 'text-api']);
    // 工厂目标今天只有这两个模块（现状：全包的 `import('./testing/…')` 只落在这两处）
    expect([...factoryTargets].sort()).toEqual(['testing/fixtures', 'testing/orchestrator-seams']);
  });

  it('判定认得出运行时边的各种形态，并放行类型专用 / 类型位置 / vi.importActual（判据的规格）', () => {
    /**
     * 为什么单开一条：上面那条只能证明「当前源码干净」，不能证明判据**有覆盖**——判据被改窄时
     * 那条照样绿。这里把形态直接喂给判定本身（沿用本仓做法，见 `agents/src/static-assertions.test.ts:185-209`）。
     * 喂进去的「来源文件」写作 `testing/fixtures.ts`：负样本里 `import { getProvider } from '../judge';`
     * 那条就是靠它验证「`../judge` 归一化后命中 `judge`」这条口径（**按形态文本指认，不写序号**——
     * 序号会随样本增删漂移，本仓已经吃过一次这种亏）。
     */
    const negative = [
      'import { permissiveMessageCapability } from \'@aieval/agents\';',
      ['import {', '  type A,', '  permissiveMessageCapability,', '} from \'@aieval/agents\';'].join('\n'),
      /**
       * 下面四条是**混合形态 / 空子句**（2026-10-07 评审 Important 补齐）：`verbatimModuleSyntax`
       * 下它们转译后**都是真请求**（实测各 1 条 `__vite_ssr_import__`），故必须判红。
       * 前两条是从正样本挪过来的——它们曾经被断言「不该命中」，等于样本表在**反向背书**那个洞。
       */
      ['import {', '  type A,', '  type B,', '} from \'@aieval/agents\';'].join('\n'),
      'import { type A } from \'@aieval/agents\';',
      'import {} from \'@aieval/agents\';',
      'import providers from \'@aieval/agents\';',
      'import * as agents from \'@aieval/agents\';',
      'import \'@aieval/agents\';',
      'export * from \'@aieval/agents\';',
      'export { getProvider } from \'@aieval/agents\';',
      /**
       * export 侧的**空子句**（2026-10-07 终审收口）：转译后是 **1 条真请求**，而
       * `elements.some(…)` 对空数组恒 false ⇒ 它是「文档判违规、实现判放行」的那个矛盾点。
       * 这条样本就是那条 `if (clause.elements.length === 0) return true;` 的**唯一**覆盖：
       * 把那一行改回「不认空子句」时，**本样本必须红**（变异验证）。
       */
      'export {} from \'@aieval/agents\';',
      'import a = require(\'@aieval/agents\');',
      'const a = await import(\'@aieval/agents\');',
      'require(\'@aieval/agents\');',
      'import { getProvider } from \'../judge\';',
      'import{getProvider}from"@aieval/agents";',
    ];
    for (const form of negative) {
      expect(mockedRuntimeEdges('testing/fixtures.ts', form), `应当命中：${form}`).not.toEqual([]);
    }

    const positive = [
      'import type { A, B } from \'@aieval/agents\';',
      'import type { JudgeInput } from \'../judge\';',
      'const t: typeof import(\'@aieval/agents\') = x;',
      'const actual = await vi.importActual<typeof import(\'@aieval/agents\')>(\'@aieval/agents\');',
      'import { fakeAgentsModule } from \'./fixtures\';',
    ];
    for (const form of positive) {
      expect(mockedRuntimeEdges('testing/fixtures.ts', form), `不该命中：${form}`).toEqual([]);
    }
  });
});
