// @vitest-environment node
/**
 * 活动行词表的行为契约：一句话怎么说、什么时候不给摘要。
 *
 * 逐条钉住三件事：
 *   ① **句式**：`调用工具 <名>：<参数摘要>`——工具名与参数缺一不可，参数取「说明了在干什么」的那一格；
 *   ② **不给摘要的场合**（活动行不该被它们占据）：没有工具名、没有参数、参数是一坨 JSON 时不给空壳句子；
 *   ③ **名字缺失不留占位**：`已派发子任务：子任务` 那种同义反复不许再出现。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_SUMMARY_MAX_LENGTH,
  clipSummary,
  oneLine,
  planSummary,
  subagentDispatchSummary,
  subagentSettledSummary,
  toolCallSummary,
  toolErrorSummary,
} from './activity';

describe('工具调用：`调用工具 <名>：<参数摘要>`', () => {
  it('参数优先取 command / file_path / path / query / description（都是「说了在干什么」的那一格）', () => {
    expect(toolCallSummary('Bash', { command: 'ls -la "D:/w"', description: 'List workspace contents' })).toBe(
      '调用工具 Bash：ls -la "D:/w"',
    );
    expect(toolCallSummary('Read', { file_path: 'D:\\w\\index.html' })).toBe('调用工具 Read：D:\\w\\index.html');
    expect(toolCallSummary('WebSearch', { query: 'vue 3 cdn' })).toBe('调用工具 WebSearch：vue 3 cdn');
  });

  it('参数是 JSON **字符串**时也要解析（dsh 的 `arguments` 就是字符串）', () => {
    expect(toolCallSummary('pwsh', '{"command":"git status --porcelain","timeout":30}')).toBe(
      '调用工具 pwsh：git status --porcelain',
    );
  });

  it('`job_id` 在优先键里（dsh 的 `job_output` / `job_kill` 只有这一格，漏了就退化成整串 JSON）', () => {
    expect(toolCallSummary('job_output', '{"job_id":"pwsh-16","timeout_ms":420000,"wait":true}')).toBe(
      '调用工具 job_output：pwsh-16',
    );
  });

  it('工具名与参数只有一个时，句子仍是一句话：不写空冒号、不编参数', () => {
    expect(toolCallSummary('Bash', null)).toBe('调用工具 Bash');
    expect(toolCallSummary(null, { command: 'ls' })).toBe('调用工具：ls');
    expect(toolCallSummary(null, null)).toBe('调用工具');
  });

  it('参数里没有那几个键时退化成紧凑 JSON（不假装认识它的形状）；不是 JSON 时原样用', () => {
    expect(toolCallSummary('mcp__x__y', { a: 1 })).toBe('调用工具 mcp__x__y：{"a":1}');
    expect(toolCallSummary('pwsh', 'Get-ChildItem env:')).toBe('调用工具 pwsh：Get-ChildItem env:');
  });

  it('改动清单（`changes[].path`）列路径，超过两个说「等 N 个」（不把 20 条路径塞进一行）', () => {
    expect(toolCallSummary('apply_patch', { changes: [{ path: 'index.html', kind: 'update' }] })).toBe(
      '调用工具 apply_patch：index.html',
    );
    expect(
      toolCallSummary('apply_patch', { changes: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }] }),
    ).toBe('调用工具 apply_patch：a.ts、b.ts 等 3 个');
  });

  it('计划类入参给**统一的那一句**：`更新计划：N 步`（三家同形，不再是 JSON 转储）', () => {
    expect(toolCallSummary('TodoWrite', { todos: [{ content: 'a' }, { content: 'b' }] })).toBe('更新计划：2 步');
    expect(toolCallSummary('update_plan', { plan: [{ step: 'a' }] })).toBe('更新计划：1 步');
    expect(toolCallSummary('todo_write', '{"steps":[{"step":"a"},{"step":"b"},{"step":"c"}]}')).toBe('更新计划：3 步');
  });

  it('单行化 + 截断：换行压成空格、超长参数带省略号（卡片底部只有一行）', () => {
    const command = `echo a\necho b\n${'x'.repeat(ACTIVITY_SUMMARY_MAX_LENGTH + 40)}`;
    // 截断按**整段参数**算（换行先压成空格再数长度），不是从那一串 x 起算
    const hint = oneLine(command);
    expect(toolCallSummary('Bash', { command })).toBe(
      `调用工具 Bash：${hint.slice(0, ACTIVITY_SUMMARY_MAX_LENGTH)}…`,
    );
  });
});

describe('工具报错：`工具报错：<内容>`', () => {
  it('内容单行化截断；一个字的错误也说得出「报错」', () => {
    expect(toolErrorSummary('Error: DeepSeek search has no API key')).toBe(
      '工具报错：Error: DeepSeek search has no API key',
    );
    expect(toolErrorSummary('')).toBe('工具报错');
    expect(toolErrorSummary(null)).toBe('工具报错');
  });
});

describe('子任务：派发与收场', () => {
  it('派发 / 收场各有固定句式，状态用中文档位', () => {
    expect(subagentDispatchSummary('Review Vue 3 page')).toBe('已派发子任务：Review Vue 3 page');
    expect(subagentSettledSummary('Review Vue 3 page', 'completed')).toBe('子任务已完成：Review Vue 3 page');
    expect(subagentSettledSummary('Review Vue 3 page', 'failed')).toBe('子任务失败：Review Vue 3 page');
    expect(subagentSettledSummary('Review Vue 3 page', 'stopped')).toBe('子任务已停止：Review Vue 3 page');
  });

  it('**名字缺失时不留占位名**（旧实现写的是「已派发子任务：子任务」，同义反复）', () => {
    expect(subagentDispatchSummary(null)).toBe('已派发子任务');
    expect(subagentDispatchSummary('')).toBe('已派发子任务');
    expect(subagentSettledSummary(null, 'completed')).toBe('子任务已完成');
    expect(subagentSettledSummary('  ', null)).toBe('子任务已结束');
  });

  it('不认识的厂商状态不假装认识：折成「已结束」（原文仍在原始负载里）', () => {
    expect(subagentSettledSummary('x', 'weird-status')).toBe('子任务已结束：x');
  });
});

describe('计划与通用工具', () => {
  it('计划更新按步数说话', () => {
    expect(planSummary(4)).toBe('更新计划：4 步');
    expect(planSummary(0)).toBe('更新计划：0 步');
  });

  it('单行化与截断是公开口径（两家适配器都要按同一把尺子用）', () => {
    expect(oneLine('a\n\n b\tc ')).toBe('a b c');
    expect(clipSummary('y'.repeat(ACTIVITY_SUMMARY_MAX_LENGTH + 1))).toBe(`${'y'.repeat(ACTIVITY_SUMMARY_MAX_LENGTH)}…`);
    expect(clipSummary('短')).toBe('短');
  });
});
