/**
 * 测试输出的**只读投影**：把日志里一段测试命令输出折成 run → suite → test 三层。
 *
 * 四条口径（每条都对应一次「假绿」）：
 *   1. **三层都要有明细**：run 的计数必须与 suite 下逐个 test 数出来的一致；
 *      只有 `Tests 90 passed` 而没有逐条用例时，整段标成 `unparsed`——否则界面会画出
 *      「90 个通过」却一个用例名都列不出来，那比不显示更坏；
 *   2. **解析失败不是 0**：`unparsed` 只带原因，**不带 run**。调用方拿不到一个可以当成
 *      「0 个用例」的返回值，必须回落原文并明确标记；
 *   3. **只认四种命令 / 四种输出特征**：`pnpm test` / `vitest` / `pytest` / `go test`。
 *      不是测试的命令返回 `not-test`，调用方不挂「测试结果」这一块；
 *   4. **输出被截断时不猜**：本函数只读文本，截断判定由调用方（它手里有 `truncation`）
 *      在调用前做掉；这里再用「汇总与明细不一致」兜住「文本虽然完整但少了几行」的情况。
 *
 * 本文件是纯函数，不读盘、不 import 任何 UI / 服务端包：契约层是四种输出的唯一解析处，
 * 界面与排名页的只读投影都从同一个函数取结果。
 */
import { z } from 'zod';

/** 四种被测命令。`pnpm` 是包装层，真正的用例行仍按 vitest 的 verbose 输出读 */
export const TEST_FRAMEWORKS = ['pnpm', 'vitest', 'pytest', 'go-test'] as const;
export const TestFrameworkSchema = z.enum(TEST_FRAMEWORKS);
export type TestFramework = z.infer<typeof TestFrameworkSchema>;

/** 四种框架的界面标签（排名页与日志抽屉共用一份，不各写一张表） */
export const TEST_FRAMEWORK_LABELS: Record<TestFramework, string> = {
  pnpm: 'pnpm test',
  vitest: 'vitest',
  pytest: 'pytest',
  'go-test': 'go test',
};

/** 三种用例结局；没有 `error` 这一档——pytest 的 ERROR 归入失败（它同样让这次运行不通过） */
export const TEST_CASE_STATUSES = ['passed', 'failed', 'skipped'] as const;
export const TestCaseStatusSchema = z.enum(TEST_CASE_STATUSES);
export type TestCaseStatus = z.infer<typeof TestCaseStatusSchema>;

export const TestCaseResultSchema = z.object({
  name: z.string().min(1),
  status: TestCaseStatusSchema,
  /** 这一条自己的耗时；输出里没给就是 `null`（不写 0） */
  durationMs: z.number().nullable(),
  /** 失败信息（能读到才给）；失败用例在界面上据此多一层可展开的断言原文 */
  failure: z.string().nullable(),
});
export type TestCaseResult = z.infer<typeof TestCaseResultSchema>;

export const TestSuiteResultSchema = z.object({
  /** 文件路径（vitest / pytest）或包名（go test） */
  name: z.string().min(1),
  status: TestCaseStatusSchema,
  tests: z.array(TestCaseResultSchema),
});
export type TestSuiteResult = z.infer<typeof TestSuiteResultSchema>;

export const TestRunResultSchema = z.object({
  framework: TestFrameworkSchema,
  /** 触发它的命令原文（进标题，排障时能与日志对上） */
  command: z.string(),
  suites: z.array(TestSuiteResultSchema),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  /** = 三个计数之和；UI 的总览行直接用它，不再自己加一遍 */
  total: z.number(),
  durationMs: z.number().nullable(),
});
export type TestRunResult = z.infer<typeof TestRunResultSchema>;

/**
 * 解析结果三态。`unparsed` **没有 `run` 字段**：类型上就拿不到一个可以被显示成 0 的结果。
 */
export type TestParseResult =
  | { status: 'not-test' }
  | { status: 'unparsed'; framework: TestFramework | null; reason: string }
  | { status: 'parsed'; run: TestRunResult };

/** 一份汇总行的计数；`total` 缺席时由明细推出 */
interface SummaryCounts {
  passed: number;
  failed: number;
  skipped: number;
  total?: number;
  durationMs: number | null;
}

/** 去掉 ANSI 颜色控制码：真实命令输出默认带颜色，颜色码会插在 `✓` 与用例名之间 */
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** 命令的 JSON 入参里拿 `command`；非 JSON / 没有这一格 / 不是字符串一律 `null`（不猜） */
export function testCommandOf(input: string | null): string | null {
  if (input === null) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const command = (parsed as Record<string, unknown>)['command'];
    return typeof command === 'string' && command.trim() !== '' ? command.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 命令 / 输出属于哪一种测试。命令优先（它能区分「`pnpm test` 包的其实是 vitest」），
 * 命令没命中时再看输出特征——有些工具只给一段裸输出，调用方拿不到命令原文。
 */
export function detectTestFramework(command: string, output: string): TestFramework | null {
  const cmd = command.toLowerCase();
  // `pnpm --filter pkg test` / `pnpm run test` 都算包装层；`vitest` 单跑时下面那一条先命中
  if (/\bvitest\b/.test(cmd)) return 'vitest';
  if (/\bgo\s+test\b/.test(cmd)) return 'go-test';
  if (/\bpytest\b/.test(cmd) || /\bpython3?\s+-m\s+pytest\b/.test(cmd)) return 'pytest';
  if (/\b(?:pnpm|npm|yarn|bun)\b[^\n]*\btest\b/.test(cmd)) return 'pnpm';
  if (/\bRUN\s+v\d|Test Files\s+\d|Tests\s+\d/.test(output)) return 'vitest';
  if (/test session starts|short test summary info|collected \d+ items?/.test(output)) return 'pytest';
  if (/^\s*=== RUN\s/m.test(output) || /^\s*--- (?:PASS|FAIL|SKIP):/m.test(output)) return 'go-test';
  return null;
}

/**
 * 主入口。`output` 是工具结果原文，`command` 是那次调用的命令（可为空串）。
 *
 * `pnpm` 分支复用 vitest 的正文解析：`pnpm test` 的输出前半段是包管理器横幅，
 * 后半段才是真实的测试运行；只把 framework 记成 `pnpm`，用例与计数仍按同一套规则读。
 */
export function parseTestOutput(input: { command: string; output: string }): TestParseResult {
  const output = input.output.replace(ANSI_PATTERN, '');
  const framework = detectTestFramework(input.command, output);
  if (framework === null) return { status: 'not-test' };
  if (output.trim() === '') {
    return { status: 'unparsed', framework, reason: '测试输出为空（命令可能还没开始或没有产出）' };
  }
  switch (framework) {
    case 'vitest':
      return parseVitest(output, 'vitest', input.command);
    case 'pnpm':
      return parsePnpm(output, input.command);
    case 'pytest':
      return parsePytest(output, input.command);
    case 'go-test':
      return parseGoTest(output, input.command);
  }
}

/** pnpm 包装层：先看正文是不是 pytest / go，否则按 vitest 读（`pnpm test` 的常见落点） */
function parsePnpm(output: string, command: string): TestParseResult {
  if (/test session starts/.test(output)) return parsePytest(output, command, 'pnpm');
  if (/^\s*=== RUN\s/m.test(output)) return parseGoTest(output, command, 'pnpm');
  return parseVitest(output, 'pnpm', command);
}

/** 一行 vitest 用例：`✓ src/x.test.ts > 组 > 名字 1ms`（前缀 `|包名|` 是 workspace 运行时的附加信息） */
const VITEST_TEST_LINE = /^\s*([✓✔×✗✕↓])\s+(.+?)\s*$/;

/** 解析 vitest / pnpm 的 verbose 输出；`framework` 只影响结果标签，不影响计数规则 */
function parseVitest(output: string, framework: TestFramework, command: string): TestParseResult {
  const bySuite = new Map<string, TestCaseResult[]>();
  const lines = output.split('\n');
  for (const [index, line] of lines.entries()) {
    const matched = VITEST_TEST_LINE.exec(line);
    if (matched === null) continue;
    const symbol = matched[1] ?? '';
    // 行尾的 `12ms` 是这一条的耗时；去掉之后再按 ` > ` 拆套件 / 组 / 用例
    const body = (matched[2] ?? '').replace(/\s+\d+(?:\.\d+)?ms$/, '').replace(/^\|[^|]*\|\s*/, '');
    const parts = body.split(' > ').map((part) => part.trim());
    // 只有一个文件段的 `✓ src/x.test.ts (3 tests)` 是文件汇总行，不是用例明细
    if (parts.length < 2) continue;
    const suiteName = parts[0] ?? '';
    const name = parts.slice(1).join(' > ');
    if (suiteName === '' || name === '') continue;
    const status: TestCaseStatus = symbol === '↓' ? 'skipped' : symbol === '✓' || symbol === '✔' ? 'passed' : 'failed';
    const durationText = /\s+(\d+(?:\.\d+)?)ms$/.exec(matched[2] ?? '')?.[1];
    // 失败用例下一行的 `→ …` 是断言消息；能读到就带上，读不到留 null（原文仍在工具输出里）
    const failureLine = status === 'failed' ? (lines[index + 1]?.trim() ?? '') : '';
    const failure = failureLine.startsWith('→') ? failureLine.slice(1).trim() : null;
    const tests = bySuite.get(suiteName) ?? [];
    tests.push({
      name,
      status,
      durationMs: durationText === undefined ? null : Number.parseFloat(durationText),
      failure,
    });
    bySuite.set(suiteName, tests);
  }

  const summary = vitestSummary(output);
  if (summary === null) {
    return {
      status: 'unparsed',
      framework,
      reason: '没有读到 vitest 的 Tests 汇总行（输出可能被截断），不按明细残缺的计数下结论',
    };
  }
  return buildRun(framework, command, bySuite, summary, 'vitest');
}

/** `Tests  1 failed | 1 passed | 1 skipped (3)` 与 `Duration 70ms` */
function vitestSummary(output: string): SummaryCounts | null {
  const line = /^\s*Tests\s+(.+)$/m.exec(output)?.[1];
  if (line === undefined) return null;
  const read = (label: string): number => Number.parseInt(new RegExp(`(\\d+)\\s+${label}`).exec(line)?.[1] ?? '0', 10);
  const totalText = /\((\d+)\)/.exec(line)?.[1];
  const duration = /^\s*Duration\s+(.+)$/m.exec(output)?.[1] ?? '';
  const durationMs = /(\d+(?:\.\d+)?)ms/.exec(duration)?.[1];
  const durationS = /(\d+(?:\.\d+)?)s/.exec(duration)?.[1];
  return {
    passed: read('passed'),
    failed: read('failed'),
    skipped: read('skipped'),
    ...(totalText === undefined ? {} : { total: Number.parseInt(totalText, 10) }),
    durationMs:
      durationMs === undefined
        ? durationS === undefined
          ? null
          : Math.round(Number.parseFloat(durationS) * 1000)
        : Math.round(Number.parseFloat(durationMs)),
  };
}

/** pytest -v 的用例行：`tests/test_math.py::test_add PASSED [ 33%]` */
const PYTEST_TEST_LINE = /^(\S+::\S+)\s+(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/;

/** pytest 的终态行 `1 failed, 1 passed, 1 skipped in 0.01s`；三个数各自独立读，顺序不敏感 */
function pytestSummary(output: string): SummaryCounts | null {
  const terminal = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /\bin \d+(?:\.\d+)?s\b/.test(line) && /\b(?:passed|failed|error|skipped)\b/.test(line));
  if (terminal === undefined) return null;
  const read = (label: string): number => Number.parseInt(new RegExp(`(\\d+)\\s+${label}`).exec(terminal)?.[1] ?? '0', 10);
  const collected = /collected (\d+) items?/.exec(output)?.[1];
  const durationS = /\bin (\d+(?:\.\d+)?)s\b/.exec(terminal)?.[1];
  return {
    passed: read('passed'),
    failed: read('failed') + read('error'),
    skipped: read('skipped'),
    ...(collected === undefined ? {} : { total: Number.parseInt(collected, 10) }),
    durationMs: durationS === undefined ? null : Math.round(Number.parseFloat(durationS) * 1000),
  };
}

function parsePytest(output: string, command: string, framework: TestFramework = 'pytest'): TestParseResult {
  const bySuite = new Map<string, TestCaseResult[]>();
  for (const line of output.split('\n')) {
    const matched = PYTEST_TEST_LINE.exec(line.trim());
    if (matched === null) continue;
    const nodeId = matched[1] ?? '';
    const [suiteName = '', ...rest] = nodeId.split('::');
    if (suiteName === '' || rest.length === 0) continue;
    const rawStatus = matched[2] ?? '';
    const status: TestCaseStatus =
      rawStatus === 'PASSED' || rawStatus === 'XPASS' ? 'passed' : rawStatus === 'SKIPPED' || rawStatus === 'XFAIL' ? 'skipped' : 'failed';
    const tests = bySuite.get(suiteName) ?? [];
    tests.push({ name: rest.join('::'), status, durationMs: null, failure: null });
    bySuite.set(suiteName, tests);
  }
  const summary = pytestSummary(output);
  if (summary === null) {
    return {
      status: 'unparsed',
      framework,
      reason: '没有读到 pytest 的终态汇总行（输出可能被截断），不按明细残缺的计数下结论',
    };
  }
  return buildRun(framework, command, bySuite, summary, 'pytest');
}

/** `--- PASS: TestAdd (0.00s)` / `    --- SKIP: TestSub (0.00s)` */
const GO_RESULT_LINE = /^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)/;

/** `ok example.com/calc 0.002s` / `FAIL example.com/calc 0.002s` / `? example.com/empty [no test files]` */
const GO_PACKAGE_LINE = /^(ok|FAIL|\?)\s+(\S+)(?:\s+([\d.]+)s)?/;

function parseGoTest(output: string, command: string, framework: TestFramework = 'go-test'): TestParseResult {
  const bySuite = new Map<string, TestCaseResult[]>();
  let pending: TestCaseResult[] = [];
  let sawPackage = false;
  for (const line of output.split('\n')) {
    const result = GO_RESULT_LINE.exec(line);
    if (result !== null) {
      const status: TestCaseStatus = result[1] === 'PASS' ? 'passed' : result[1] === 'SKIP' ? 'skipped' : 'failed';
      pending.push({
        name: result[2] ?? '',
        status,
        durationMs: Math.round(Number.parseFloat(result[3] ?? '0') * 1000),
        failure: null,
      });
      continue;
    }
    const packageLine = GO_PACKAGE_LINE.exec(line);
    if (packageLine !== null) {
      sawPackage = true;
      const suiteName = packageLine[2] ?? '';
      // `? pkg [no test files]` 也是一条真实的包结果：suite 存在、tests 为空
      if (suiteName !== '') bySuite.set(suiteName, pending);
      pending = [];
    }
  }
  if (!sawPackage) {
    return {
      status: 'unparsed',
      framework,
      reason: '没有读到 go test 的包结果行（ok / FAIL），输出可能被截断',
    };
  }
  // go 没有一行总汇总；计数只能由明细推。`buildRun` 在没有 summary 时接受明细推导。
  return buildRun(framework, command, bySuite, null, 'go');
}

/**
 * 组装结果并做**三层一致性**检查——这是本文件最重要的一步。
 *
 * `summary` 为 `null` 时（go test）计数由明细推出；有 summary 时必须逐项对得上：
 * 任一计数不同、或总条数不同，都说明这段文本不是完整的运行输出 ⇒ `unparsed`，
 * 不在错误的计数上算通过率。
 */
function buildRun(
  framework: TestFramework,
  command: string,
  bySuite: Map<string, TestCaseResult[]>,
  summary: SummaryCounts | null,
  sourceLabel: string,
): TestParseResult {
  const suites: TestSuiteResult[] = [];
  for (const [name, tests] of bySuite) {
    if (tests.length === 0) continue;
    suites.push({ name, status: suiteStatusOf(tests), tests });
  }
  const allTests = suites.flatMap((suite) => suite.tests);
  if (allTests.length === 0) {
    return {
      status: 'unparsed',
      framework,
      reason: `只读到 ${sourceLabel} 的汇总，没有读到任何用例明细（不把汇总当成 0 个用例）`,
    };
  }
  const passed = allTests.filter((test) => test.status === 'passed').length;
  const failed = allTests.filter((test) => test.status === 'failed').length;
  const skipped = allTests.filter((test) => test.status === 'skipped').length;
  if (summary !== null) {
    const mismatched =
      summary.passed !== passed ||
      summary.failed !== failed ||
      summary.skipped !== skipped ||
      (summary.total !== undefined && summary.total !== allTests.length);
    if (mismatched) {
      return {
        status: 'unparsed',
        framework,
        reason:
          `汇总与明细不一致（汇总 ${summary.passed} 通过 / ${summary.failed} 失败 / ${summary.skipped} 跳过` +
          `${summary.total === undefined ? '' : ` / 共 ${summary.total}`}，明细 ${passed} / ${failed} / ${skipped} / 共 ${allTests.length}）；` +
          '输出可能被截断，不按残缺明细报通过率',
      };
    }
  }
  return {
    status: 'parsed',
    run: {
      framework,
      command,
      suites,
      passed,
      failed,
      skipped,
      total: allTests.length,
      durationMs: summary?.durationMs ?? null,
    },
  };
}

/** suite 的结局：有一条失败就是失败；全部跳过才是跳过；否则通过 */
function suiteStatusOf(tests: readonly TestCaseResult[]): TestCaseStatus {
  if (tests.some((test) => test.status === 'failed')) return 'failed';
  if (tests.every((test) => test.status === 'skipped')) return 'skipped';
  return 'passed';
}

/**
 * 排名页要的**只读投影**：一行一条，只有结论与计数，没有原文。
 *
 * 三态缺一不可：
 *   · `collected`——解析成功，计数可信；
 *   · `unparsed`——识别到测试命令，但输出读不出完整三层（含被截断）；
 *   · `not-collected`——这一行没有跑过可识别的测试命令。
 *
 * 后两态都**没有 `passed` 字段**：界面不可能把「没采到」误读成 0 个通过。
 */
export const RowTestSummarySchema = z.discriminatedUnion('status', [
  z.object({
    rowId: z.string().min(1),
    status: z.literal('collected'),
    framework: TestFrameworkSchema,
    command: z.string(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    total: z.number(),
  }),
  z.object({
    rowId: z.string().min(1),
    status: z.literal('unparsed'),
    framework: TestFrameworkSchema.nullable(),
    command: z.string(),
    reason: z.string().min(1),
  }),
  z.object({
    rowId: z.string().min(1),
    status: z.literal('not-collected'),
  }),
]);
export type RowTestSummary = z.infer<typeof RowTestSummarySchema>;

/** 一轮的测试结果投影（行序与快照一致；服务端不排名） */
export const RunTestResultsSchema = z.object({ rows: z.array(RowTestSummarySchema) });
export type RunTestResults = z.infer<typeof RunTestResultsSchema>;
