'use client';

/**
 * 测试结果：一次测试运行的 **run → suite → test** 三层。
 *
 * 五条口径：
 *   1. **总览的数字只从明细来**：`TestRunResult` 的 `total/passed/failed/skipped` 由解析器按用例
 *      逐条数出来，并与命令自己的汇总行对过账；本件不再自己加一遍，避免出现「标题 3 个、下面 2 条」；
 *   2. **失败才可再展一层**：test 行有失败原文时才是 `TraceCollapsible`，否则是一条 `TraceLine`
 *      —— 给每条通过的用例都套一个可点箭头，只会让真正的失败埋在噪声里；
 *   3. **解析失败回落原文 + 明确标记**：`unparsed` 只画一句「测试输出未能解析」与原因，
 *      再把命令原文逐字放进 `CodeBlock`；**不渲染任何计数**，从结构上堵住「0 个测试」；
 *   4. **开合全部受控**：suite / 失败用例的键由调用方（工具组那一份 `openEntries`）持有，
 *      本件不持态（`agent-log-layering.test.ts` (d)）；
 *   5. **不判厂商**：只读 `framework` 这个数据层给的标签，不按 `agentKind` 分支。
 */
import type { ReactNode } from 'react';
import { CircleCheckIcon, CircleMinusIcon, CircleXIcon, FlaskConicalIcon } from 'lucide-react';
import { TEST_FRAMEWORK_LABELS, type TestCaseResult } from '@aieval/contracts';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { CodeBlock, CodeBlockContent } from '../../components/ui/code-block';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../../components/ui/trace';
import type { ToolTestResult } from './types';

export interface TestResultsViewProps {
  result: ToolTestResult;
  /** 解析失败时要回落的那段命令原文（逐字给，本件不截断） */
  raw: string;
  /** 外层工具行的稳定键：suite / 失败用例的折叠键都挂在它上面 */
  entryKey: string;
  openSuites: ReadonlySet<string>;
  onSuiteOpenChange(key: string, open: boolean): void;
}

/** suite 的折叠键：工具行键 + 后缀 + 序号（序号在一份解析结果里稳定） */
export function testSuiteKey(entryKey: string, index: number): string {
  return `${entryKey}|test-suite:${index}`;
}

/** 失败用例的折叠键（与 suite 同一份集合，后缀不同） */
export function testCaseKey(entryKey: string, suiteIndex: number, caseIndex: number): string {
  return `${entryKey}|test-case:${suiteIndex}:${caseIndex}`;
}

/** 总览那一句：数量与失败数必须出现在标题里（Trace 的 a11y 口径：状态不靠颜色单独表达） */
function runTitle(result: Extract<ToolTestResult, { status: 'parsed' }>): string {
  const run = result.run;
  const parts = [`测试 ${run.total} 个`, `${run.passed} 通过`];
  if (run.failed > 0) parts.push(`${run.failed} 失败`);
  if (run.skipped > 0) parts.push(`${run.skipped} 跳过`);
  return parts.join(' · ');
}

/** 一条用例的图标：失败 / 通过 / 跳过三档，颜色之外还有形状 */
function CaseIcon({ status }: { status: TestCaseResult['status'] }): ReactNode {
  if (status === 'failed') return <CircleXIcon />;
  if (status === 'skipped') return <CircleMinusIcon />;
  return <CircleCheckIcon />;
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

/** 一条用例（失败且带原文时可再展开一层） */
function TestCaseRow({
  test,
  entryKey,
  suiteIndex,
  caseIndex,
  openSuites,
  onSuiteOpenChange,
}: {
  test: TestCaseResult;
  entryKey: string;
  suiteIndex: number;
  caseIndex: number;
  openSuites: ReadonlySet<string>;
  onSuiteOpenChange(key: string, open: boolean): void;
}): ReactNode {
  const duration = formatDuration(test.durationMs);
  const status = test.status === 'failed' ? 'error' : undefined;
  const line = (
    <TraceLine status={status} data-testid="test-case">
      <TraceIcon>
        <CaseIcon status={test.status} />
      </TraceIcon>
      <TraceTitle>{test.name}</TraceTitle>
      {duration !== null && <TraceDescription>{duration}</TraceDescription>}
    </TraceLine>
  );
  if (test.status !== 'failed' || test.failure === null) return <Trace>{line}</Trace>;

  const key = testCaseKey(entryKey, suiteIndex, caseIndex);
  return (
    <Trace>
      <TraceCollapsible open={openSuites.has(key)} onOpenChange={(next) => onSuiteOpenChange(key, next)}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm" data-testid="test-case-failure">
            <CodeBlockContent wrap>{test.failure}</CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/** 解析失败：标记 + 原文。两个元素都在，缺一个都会让「没读到」与「读到了但没显示」分不清 */
function UnparsedResult({ result, raw }: { result: Extract<ToolTestResult, { status: 'unparsed' }>; raw: string }): ReactNode {
  return (
    <div className="flex flex-col gap-2 text-foreground" data-testid="test-results-unparsed">
      <Alert variant="destructive">
        <AlertTitle>测试输出未能解析</AlertTitle>
        <AlertDescription>
          {`${result.reason}。原文如下，未折算成 0 个用例。`}
        </AlertDescription>
      </Alert>
      <CodeBlock size="sm">
        <CodeBlockContent wrap className="max-h-64">
          {raw}
        </CodeBlockContent>
      </CodeBlock>
    </div>
  );
}

export function TestResultsView({
  result,
  raw,
  entryKey,
  openSuites,
  onSuiteOpenChange,
}: TestResultsViewProps): ReactNode {
  if (result.status === 'unparsed') return <UnparsedResult result={result} raw={raw} />;
  const run = result.run;
  const duration = formatDuration(run.durationMs);
  return (
    <Trace data-testid="test-results">
      <TraceLine status={run.failed > 0 ? 'error' : undefined}>
        <TraceIcon>
          <FlaskConicalIcon />
        </TraceIcon>
        <TraceTitle data-testid="test-results-run-title">{runTitle(result)}</TraceTitle>
        <TraceDescription>{TEST_FRAMEWORK_LABELS[run.framework]}</TraceDescription>
        {duration !== null && <TraceDescription>{duration}</TraceDescription>}
      </TraceLine>
      {run.suites.map((suite, suiteIndex) => {
        const key = testSuiteKey(entryKey, suiteIndex);
        return (
          <TraceCollapsible key={suite.name} open={openSuites.has(key)} onOpenChange={(next) => onSuiteOpenChange(key, next)}>
            <TraceCollapsibleTrigger>
              <TraceLine status={suite.status === 'failed' ? 'error' : undefined} data-testid="test-suite">
                <TraceIcon>
                  <CaseIcon status={suite.status} />
                </TraceIcon>
                <TraceTitle>{suite.name}</TraceTitle>
                <TraceDescription>{`${suite.tests.length} 个用例`}</TraceDescription>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <Trace>
                {suite.tests.map((test, caseIndex) => (
                  <TestCaseRow
                    key={`${test.name}|${caseIndex}`}
                    test={test}
                    entryKey={entryKey}
                    suiteIndex={suiteIndex}
                    caseIndex={caseIndex}
                    openSuites={openSuites}
                    onSuiteOpenChange={onSuiteOpenChange}
                  />
                ))}
              </Trace>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        );
      })}
    </Trace>
  );
}
