// @vitest-environment node
/**
 * 测试输出的解析：把四种真实命令输出折成 run → suite → test 三层。
 *
 * 四份夹具的来源：
 *   · `VITEST_OUTPUT` 与 `PNPM_OUTPUT` 来自本仓 `packages/server/contracts` 下一份临时用例的
 *     `vitest run --reporter=verbose` / `pnpm --filter @aieval/contracts test ... --reporter=verbose`
 *     实跑输出（一条通过、一条失败、一条跳过）；
 *   · `PYTEST_OUTPUT` 来自 `python -m pytest -v` 对一份三条用例（通过 / 失败 / 跳过）的实跑输出；
 *   · `GO_OUTPUT` 是 `go test` 的标准输出形态（本机没有 Go 工具链，按官方 `=== RUN` /
 *     `--- PASS|FAIL|SKIP` / `ok|FAIL` 行文手写）。
 *
 * 本文件的核心不是「能解析」，而是**解析不了时不许交出一个看起来像 0 的结果**：
 * 只有汇总没有明细、汇总与明细矛盾、输出被截断，都必须走 `unparsed`。
 */
import { describe, expect, it } from 'vitest';
import { parseTestOutput, testCommandOf, type TestParseResult } from './test-result';

const VITEST_OUTPUT = ` RUN  v4.1.11 /repo

 ✓ src/__tmp-t27-fixture.test.ts > 数学 > 加法通过 1ms
 × src/__tmp-t27-fixture.test.ts > 数学 > 减法失败 2ms
   → expected 2 to be 1 // Object.is equality
 ↓ src/__tmp-t27-fixture.test.ts > 数学 > 跳过的那条

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 1 skipped (3)
   Start at  16:39:40
   Duration  70ms (transform 7ms, setup 0ms, import 12ms, tests 3ms, environment 0ms)`;

const PNPM_OUTPUT = `$ vitest run --passWithNoTests src/__tmp-t27-fixture.test.ts --reporter=verbose

 RUN  v4.1.11 /repo/packages/server/contracts

 ✓ src/__tmp-t27-fixture.test.ts > 数学 > 加法通过 1ms
 × src/__tmp-t27-fixture.test.ts > 数学 > 减法失败 2ms
 ↓ src/__tmp-t27-fixture.test.ts > 数学 > 跳过的那条

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 1 skipped (3)
   Start at  16:39:40
   Duration  70ms (transform 7ms, setup 0ms, import 12ms, tests 3ms, environment 0ms)`;

const PYTEST_OUTPUT = `============================= test session starts ==============================
platform darwin -- Python 3.9.6, pytest-8.4.2, pluggy-1.6.0 -- /private/tmp/t27-pytest-venv/bin/python
cachedir: .pytest_cache
rootdir: /private/tmp/t27-pytest-fixture
collecting ... collected 3 items

tests/test_math.py::test_add PASSED                                      [ 33%]
tests/test_math.py::test_subtract FAILED                                 [ 66%]
tests/test_math.py::test_skipped SKIPPED (not today)                     [100%]

=================================== FAILURES ===================================
________________________________ test_subtract _________________________________

    def test_subtract():
>       assert 3 - 1 == 1
E       assert (3 - 1) == 1

tests/test_math.py:5: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_subtract - assert (3 - 1) == 1
==================== 1 failed, 1 passed, 1 skipped in 0.01s ====================`;

const GO_OUTPUT = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSubtract
    math_test.go:12: got 1, want 2
--- FAIL: TestSubtract (0.00s)
=== RUN   TestSkipped
--- SKIP: TestSkipped (0.00s)
FAIL
FAIL\texample.com/calc\t0.002s`;

/** 解析成功并断言类型收窄（失败时给出可读原因，而不是让后续用例在 `run` 上崩） */
function parsed(result: TestParseResult): Extract<TestParseResult, { status: 'parsed' }> {
  if (result.status !== 'parsed') throw new Error(`期望解析成功，实际是 ${result.status}：${JSON.stringify(result)}`);
  return result;
}

/** 解析失败并断言类型收窄（`unparsed` 才有 reason） */
function unparsed(result: TestParseResult): Extract<TestParseResult, { status: 'unparsed' }> {
  if (result.status !== 'unparsed') throw new Error(`期望解析失败，实际是 ${result.status}：${JSON.stringify(result)}`);
  return result;
}

describe('测试输出解析：四种命令', () => {
  it('vitest verbose 输出 → run / suite / 三条用例，计数与明细一致', () => {
    const result = parsed(parseTestOutput({ command: 'pnpm vitest run src/x.test.ts --reporter=verbose', output: VITEST_OUTPUT }));
    expect(result.run.framework).toBe('vitest');
    expect(result.run.suites).toHaveLength(1);
    expect(result.run.suites[0]?.name).toContain('src/__tmp-t27-fixture.test.ts');
    expect(result.run.suites[0]?.tests.map((test) => [test.name, test.status])).toEqual([
      ['数学 > 加法通过', 'passed'],
      ['数学 > 减法失败', 'failed'],
      ['数学 > 跳过的那条', 'skipped'],
    ]);
    expect([result.run.passed, result.run.failed, result.run.skipped, result.run.total]).toEqual([1, 1, 1, 3]);
  });

  it('pnpm test 包装输出 → 同一个运行、同一个 suite，框架标成 pnpm', () => {
    const result = parsed(parseTestOutput({ command: 'pnpm --filter @aieval/contracts test', output: PNPM_OUTPUT }));
    expect(result.run.framework).toBe('pnpm');
    expect(result.run.suites).toHaveLength(1);
    expect(result.run.suites[0]?.tests).toHaveLength(3);
    expect([result.run.passed, result.run.failed, result.run.skipped, result.run.total]).toEqual([1, 1, 1, 3]);
  });

  it('pytest -v 输出 → 文件为 suite、nodeid 后缀为用例，计数来自终态行', () => {
    const result = parsed(parseTestOutput({ command: 'python -m pytest -v', output: PYTEST_OUTPUT }));
    expect(result.run.framework).toBe('pytest');
    expect(result.run.suites.map((suite) => suite.name)).toEqual(['tests/test_math.py']);
    expect(result.run.suites[0]?.tests.map((test) => [test.name, test.status])).toEqual([
      ['test_add', 'passed'],
      ['test_subtract', 'failed'],
      ['test_skipped', 'skipped'],
    ]);
    expect([result.run.passed, result.run.failed, result.run.skipped, result.run.total]).toEqual([1, 1, 1, 3]);
  });

  it('go test 输出 → 包名为 suite、--- PASS|FAIL|SKIP 为用例，计数由明细推出', () => {
    const result = parsed(parseTestOutput({ command: 'go test ./...', output: GO_OUTPUT }));
    expect(result.run.framework).toBe('go-test');
    expect(result.run.suites.map((suite) => suite.name)).toEqual(['example.com/calc']);
    expect(result.run.suites[0]?.tests.map((test) => [test.name, test.status])).toEqual([
      ['TestAdd', 'passed'],
      ['TestSubtract', 'failed'],
      ['TestSkipped', 'skipped'],
    ]);
    expect([result.run.passed, result.run.failed, result.run.skipped, result.run.total]).toEqual([1, 1, 1, 3]);
  });
});

describe('测试输出解析：解析不了时如实回落', () => {
  it('测试命令的输出一句都读不出 ⇒ unparsed + 原因，绝不返回 0 个用例的 run', () => {
    const result = unparsed(
      parseTestOutput({ command: 'pnpm test', output: '> vitest run\n\nNo test files found, exiting with code 1' }),
    );
    expect(result.framework).toBe('pnpm');
    expect(result.reason).not.toBe('');
    expect('run' in result).toBe(false);
  });

  it('只有汇总、没有用例明细 ⇒ unparsed（防「只显示第一层」的半成品）', () => {
    const result = unparsed(
      parseTestOutput({
        command: 'pnpm vitest run',
        output: ' RUN  v4.1.11 /repo\n\n Test Files  1 passed (1)\n      Tests  90 passed (90)\n   Duration  985ms',
      }),
    );
    expect(result.reason).toContain('明细');
  });

  it('汇总与明细对不上 ⇒ unparsed（截断 / 少读了一部分时不许报一个偏小的通过率）', () => {
    const result = unparsed(
      parseTestOutput({
        command: 'pnpm vitest run',
        output: ' RUN  v4.1.11 /repo\n\n ✓ src/x.test.ts > 组 > 只看到这一条 1ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Duration  20ms',
      }),
    );
    expect(result.reason).toContain('不一致');
  });

  it('不是测试命令、输出也没有测试特征 ⇒ not-test（调用方据此不挂「测试结果」）', () => {
    expect(parseTestOutput({ command: 'ls -la', output: 'a.txt\nb.txt' }).status).toBe('not-test');
  });

  it('从工具入参的 JSON 原文里取出命令；取不到给 null', () => {
    expect(testCommandOf('{"command":"pnpm test -- --run","description":"跑测试"}')).toBe('pnpm test -- --run');
    expect(testCommandOf('{"path":"src/a.ts"}')).toBeNull();
    expect(testCommandOf('not json')).toBeNull();
  });
});
