// @vitest-environment node
/**
 * 「**同一个缓存对象传给收尾那两条读盘路径**」的守卫。
 *
 * 为什么单独开一个文件：`index.test.ts` 用的是**真** fs（`mkdtempSync` / `writeFileSync` /
 * `realpathSync.native`），在那里整面 mock `node:fs` 的风险大于收益。而这条判据**只能**靠数
 * `openSync` 才看得见——缓存接没接上，行为层面逐字相同（同一份文件被解析一次还是两次，读数一模一样），
 * 界面上一个字都看不出来。⇒ 判据是「**同一个版本的转录文件在一次收尾里被打开了几次**」。
 *
 * 两条读盘路径（`index.ts` 的 `finalize`）：
 *   ① **合计读**（`readClaudeSubagentUsage` ⇒ 行级 `subagentTokens` / `subagentTurns`）；
 *   ② **逐个子智能体重读**（`finalSubagents` ⇒ 每个子智能体的**最终**用量，进 `SubagentRecord.usage`）。
 *
 * ⚠️ **跑动期不读盘**（用户裁定：只展示最终用量）：子智能体的**终态通知**到达时只登记记录、
 * 不读文件（`rememberSubagent`）⇒ 每个转录文件一次运行只该被打开一次。
 *
 * ⚠️ **「必须真读」没有被这条守卫削弱**：文件长长了（size / mtimeMs 变）时条目不命中，照常重读
 * ——那是 `subagent-usage.test.ts` 里「文件长长了 ⇒ 重新读」那条钉的。本文件只钉
 * 「**同一版本**在收尾那一次不会被二次解析」。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, SubagentRecord } from '@aieval/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import { collectEvents, createFakeClaudeSdk, createRecorder, createRunInput } from '../../testing/agent-fixtures';
import { claudeCodeProvider } from './index';
import { CLAUDE_PACKAGE_NAME } from './sdk';

/**
 * 只替换 `openSync`（计数 + 委派给真实现）：其余导出原样透出（`mkdtempSync` / `writeFileSync` /
 * `statSync` / `readSync` / `readdirSync` 等照常是真实现——本文件的夹具与被测模块都要用它们）。
 */
const fsSpies = vi.hoisted(() => ({ openSync: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsSpies.openSync.mockImplementation(actual.openSync);
  return { ...actual, openSync: fsSpies.openSync };
});

afterEach(() => {
  setAgentRuntimeForTesting(null);
  fsSpies.openSync.mockClear();
});

/** 一份 `agent-<taskId>.jsonl` 转录（与 `index.test.ts` 的夹具同形：目录布局与记录形状都一致） */
function writeAgentFile(configHome: string, sessionId: string, taskId: string, lines: unknown[]): void {
  const dir = join(configHome, 'projects', 'D---tmp-proj', sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${taskId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
}

/** 文件里的一条 assistant 记录：同一个 `message.id` 会出现多次（按内容块），后到覆盖 */
function assistant(messageId: string, usage: Record<string, number>): unknown {
  return { type: 'assistant', isSidechain: true, uuid: `${messageId}-1`, message: { id: messageId, usage } };
}

/** 真派发的 `task_started`（形状三格齐：`subagent_type` / `spawn_depth` / `prompt`） */
function dispatchStarted(taskId: string, toolUseId: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    subagent_type: 'general-purpose',
    spawn_depth: 1,
    prompt: '审查这个页面，把发现写成结论',
  };
}

/** 某个转录文件在这次运行里被 `openSync` 打开了几次（判据：一次读盘 = 一次 open） */
function opensOf(taskId: string): number {
  return fsSpies.openSync.mock.calls.filter((call) => String(call[0]).endsWith(`agent-${taskId}.jsonl`)).length;
}

describe('claude-code 的子会话读盘缓存接线（审查 M-3）', () => {
  /**
   * 一次真实收尾把两条路径全走一遍：`task-1` **有**终态通知、`task-2` **没有**（只有派发帧）。
   * **同一版本**的两个转录文件各只该被打开一次——没接线 / 少接一处会是 2 次。
   *
   * ⚠️ **本文件钉的是「缓存接没接上」，不是「跑动期读不读盘」**：
   * 把跑动期那一读加回去（终态通知时读一次）时这条**照样绿**——收尾那次会命中同一版本、不再 open。
   * 「跑动期不读盘」的守卫在 `index.test.ts`（记录时序：终态帧的 `usage` 恒 `null`）。
   */
  it('收尾两条读盘路径共用同一个缓存：同一版本的文件各只被打开一次', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-cache-'));
    writeAgentFile(configHome, 's-cache', 'task-1', [
      assistant('task-1-m-1', { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant('task-1-m-1', { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 }),
      assistant('task-1-m-2', { input_tokens: 20, cache_read_input_tokens: 200, output_tokens: 5 }),
    ]);
    writeAgentFile(configHome, 's-cache', 'task-2', [
      assistant('task-2-m-1', { input_tokens: 7, cache_read_input_tokens: 0, output_tokens: 3 }),
      assistant('task-2-m-2', { input_tokens: 1, cache_read_input_tokens: 40, output_tokens: 2 }),
    ]);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', session_id: 's-cache' },
            dispatchStarted('task-1', 'call_1'),
            dispatchStarted('task-2', 'call_2'),
            // 子智能体收场帧：跑动期**只登记记录、不读盘**（最终用量由收尾那一次给）
            { type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'call_1', status: 'completed', summary: '跑完了' },
            { type: 'assistant', uuid: 'main-1', message: { id: 'main-m-1', content: [{ type: 'text', text: '干活' }] } },
            { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
          ],
        }),
      },
    });
    const events: AgentEvent[] = [];
    const records: SubagentRecord[] = [];
    const result = await claudeCodeProvider.run(
      createRunInput({ configHome, onEvent: collectEvents(events), onSubagent: (record) => records.push(record) }),
    );

    // 前提钉一：两条路径都真的读到了数（否则「只 open 一次」可能只是「一次都没读」）
    expect(result.subagentTokens).toEqual({ input: 128, cached: 240, output: 20, reasoningOutput: null, total: null });
    expect(result.subagentTurns).toBe(4);
    /**
     * 前提钉二：**每个子智能体的最后一条记录都带着它自己的最终用量**（读数确实落到子任务条那一格）。
     * ⚠️ 取**最后一条**而不是第一条：跑动期不读盘 ⇒ 终态通知那一条的 `usage` 恒为 `null`，
     * 收尾那一批才是最终值——覆盖累积（`foldSubagents`）消费的也正是最后一条。
     * ⚠️ `task-2` **没有**终态通知（只有派发帧）也不是空转：它钉的正是「登记要连 `running` 帧一起记」
     * ——改前那一档提前返回、什么都不记，收尾那批里就没有它，这一格永远是「用量未采集」。
     */
    const lastOf = (subagentId: string): SubagentRecord | undefined =>
      [...records].reverse().find((record) => record.subagentId === subagentId);
    expect(lastOf('task-1')?.usage).toEqual({ input: 120, cached: 200, output: 15, reasoningOutput: null, total: null });
    expect(lastOf('task-2')?.usage).toEqual({ input: 8, cached: 40, output: 5, reasoningOutput: null, total: null });
    expect(opensOf('task-1')).toBeGreaterThan(0);
    // 判据：**同一版本**（这两个文件在运行期间一个字没改）⇒ 每个文件只 open 一次
    expect(opensOf('task-1')).toBe(1);
    expect(opensOf('task-2')).toBe(1);
  });
});
