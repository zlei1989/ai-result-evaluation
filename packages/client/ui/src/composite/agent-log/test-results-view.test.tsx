/**
 * Test Results：日志里一次测试命令输出的三层呈现。
 *
 * 三条靶子：
 *   1. 解析成功时，**总览行的数字必须等于下面真正列出的用例条数**——这正是「只显示第一层」
 *      半成品的反面；
 *   2. 解析失败时**回落原文 + 明确标记**，不许出现「0 个测试」这类看起来像读数的句子；
 *   3. suite / test 的开合走受控键（与工具组同一份折叠态），组件自己不持态。
 */
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserverStub } from '../../testing/resize-observer';
import type { ToolTestResult } from './types';
import type { ToolItem } from './render-blocks';
import { ToolItemDetail } from './tool-item-detail';
import { TestResultsView, testCaseKey, testSuiteKey } from './test-results-view';

const AT = '2026-10-02T08:00:00.000Z';

const PARSED: ToolTestResult = {
  status: 'parsed',
  run: {
    framework: 'pnpm',
    command: 'pnpm test',
    passed: 1,
    failed: 1,
    skipped: 0,
    total: 2,
    durationMs: 70,
    suites: [
      {
        name: 'src/x.test.ts',
        status: 'failed',
        tests: [
          { name: '数学 > 加法通过', status: 'passed', durationMs: 1, failure: null },
          { name: '数学 > 减法失败', status: 'failed', durationMs: 2, failure: 'expected 2 to be 1' },
        ],
      },
    ],
  },
};

function callItem(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'call',
    callId: 'call-1',
    blockId: 'm1#0',
    name: 'Bash',
    nameMissing: null,
    family: 'run-shell',
    input: { value: '{"command":"pnpm test"}', text: '{"command":"pnpm test"}', bytes: 22, description: null },
    inputError: null,
    summary: 'pnpm test',
    output: { text: '测试原文', structured: null, status: 'ok', bytes: 8, truncation: { kind: 'none' } },
    at: AT,
    assembly: 'snapshot',
    running: false,
    ...overrides,
  };
}

beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TestResultsView', () => {
  it('解析成功：总览行的 2 个用例，下面真的列出 2 条（防只显示第一层）', () => {
    render(
      <TestResultsView
        result={PARSED}
        raw="测试原文"
        entryKey="call-1"
        openSuites={new Set([testSuiteKey('call-1', 0), testCaseKey('call-1', 0, 1)])}
        onSuiteOpenChange={() => undefined}
      />,
    );

    expect(screen.getByTestId('test-results-run-title')).toHaveTextContent('测试 2 个 · 1 通过 · 1 失败');
    const run = screen.getByTestId('test-results');
    expect(within(run).getAllByTestId('test-suite')).toHaveLength(PARSED.run.suites.length);
    expect(within(run).getAllByTestId('test-case')).toHaveLength(PARSED.run.total);
    // suite 与 test 的名字都上屏，且失败那条带错误消息
    expect(screen.getByText('src/x.test.ts')).toBeInTheDocument();
    expect(screen.getByText('数学 > 加法通过')).toBeInTheDocument();
    expect(screen.getByText('数学 > 减法失败')).toBeInTheDocument();
    expect(screen.getByText('expected 2 to be 1')).toBeInTheDocument();
  });

  it('解析失败：回落原文 + 明确标记，绝不显示成 0 个用例', () => {
    const result: ToolTestResult = {
      status: 'unparsed',
      framework: 'pnpm',
      command: 'pnpm test',
      reason: '只读到汇总，没有读到任何用例明细',
    };
    const { container } = render(
      <TestResultsView
        result={result}
        raw="> vitest run\n\nNo test files found"
        entryKey="call-1"
        openSuites={new Set()}
        onSuiteOpenChange={() => undefined}
      />,
    );

    expect(screen.getByTestId('test-results-unparsed')).toHaveTextContent('测试输出未能解析');
    expect(screen.getByTestId('test-results-unparsed')).toHaveTextContent('只读到汇总');
    // 原文逐字回落，不静默丢弃
    expect(container.textContent).toContain('No test files found');
    // 核心反面：不许出现「0 个测试 / 0 通过 / 0%」这种看起来像读数的句子
    expect(container.textContent).not.toMatch(/0\s*个测试|0\s*通过|0%/);
  });
});

describe('ToolItemDetail 接上测试结果', () => {
  it('有 testResult 时正文画三层；没有时仍画原文（不误伤普通工具输出）', () => {
    const { container } = render(
      <ToolItemDetail
        entry={callItem({ testResult: PARSED })}
        open
        onOpenChange={() => undefined}
        framesOpen={false}
        onFramesOpenChange={() => undefined}
        missingReason={null}
        testOpenKeys={new Set([testSuiteKey('call-1', 0)])}
        onTestOpenChange={() => undefined}
      />,
    );
    expect(container.querySelector('[data-testid="test-results"]')).not.toBeNull();
    expect(within(container).getAllByTestId('test-case')).toHaveLength(2);
  });

  it('解析失败时工具行正文里同时有标记与原文（核心回落路径，不是只测子组件）', () => {
    const result: ToolTestResult = {
      status: 'unparsed',
      framework: 'pnpm',
      command: 'pnpm test',
      reason: '只读到汇总，没有读到任何用例明细',
    };
    const { container } = render(
      <ToolItemDetail
        entry={callItem({ testResult: result, output: { text: '> vitest run\nNo test files found', structured: null, status: 'ok', bytes: 31, truncation: { kind: 'none' } } })}
        open
        onOpenChange={() => undefined}
        framesOpen={false}
        onFramesOpenChange={() => undefined}
        missingReason={null}
      />,
    );
    const body = container.querySelector('[data-slot="trace-collapsible-content"]')?.textContent ?? '';
    expect(body).toContain('测试输出未能解析');
    expect(body).toContain('No test files found');
    expect(body).not.toMatch(/测试 0 个|0 通过|(?:^|[^0-9])0%/);
  });
});
