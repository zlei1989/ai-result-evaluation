// @vitest-environment node
/**
 * **活动行的跨家一致性**（用户口径：统一流信息展示）。
 *
 * 卡片底部那一行只吃 `log` 事件的 `summary` / 人话 `text`（判定在 `@aieval/client` 的
 * `activityOf`）。从前这句话由三家各写一份实现，于是同一件事有三种说法：
 *   · claude 给 `调用工具 Bash`（**丢掉了参数**，而同一行原始负载里 `input.command` 是完整的）；
 *   · dsh 给 `调用工具 pwsh：git status --porcelain`；
 *   · codex 什么都不给（app-server 重写后活动行整轮只剩「更新计划：N 步」）。
 * 词表收进 `src/activity.ts` 之后，这份用例钉的就是「**同一件事，三家逐字同一句**」。
 *
 * 三条判据：
 *   ① **逐字相等**（不是「都非空」）：工具调用、工具报错、子任务派发/收场、计划更新各一条；
 *   ② **该沉默的一起沉默**：工具成功返回、推理、轮次播报在三家都**不给摘要**——
 *      只要有一家破了例，活动行就会重新被流水账占据；
 *   ③ 差异只允许出现在**厂商自己的名字**上（工具名、任务名），句式与参数摘要必须同形。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FailureContext } from './errors';
import { createTurnState } from './testing/agent-fixtures';
import { projectClaudeMessage } from './providers/claude-code/events';
import { resetClaudeTaskNamesForTesting } from './providers/claude-code/message';
import type { AppServerItem, AppServerNotificationPayload } from './providers/codex/appserver/protocol';
import { projectCodexEvent } from './providers/codex/events';
import { createCodexRunState, type CodexRunState } from './providers/codex/run-state';
import { projectDshNotification, resetSubagentCatalogForTesting } from './providers/dsh/events';

const CLAUDE_CONTEXT = { kind: 'claude-code', baseUrl: 'https://gw.example.com/anthropic' } as const;
const DSH_CONTEXT = { kind: 'dsh', baseUrl: 'https://gw.example.com/deepseek/v1' } as const;
const CODEX_CONTEXT = { kind: 'codex', baseUrl: 'https://gw.example.com/v1', mainThreadId: 'thread-main' } as const;

/** 三个 provider 的投影上下文类型不同，故各自一个薄封装：取出的都是**草稿数组** */
function claudeDrafts(raw: unknown): { type: string; summary?: string; text?: string }[] {
  return projectClaudeMessage(raw, createTurnState(), CLAUDE_CONTEXT as unknown as FailureContext).drafts as never;
}

function dshDrafts(raw: unknown): { type: string; summary?: string; text?: string }[] {
  return projectDshNotification(raw, createTurnState(), DSH_CONTEXT as unknown as FailureContext).drafts as never;
}

function codexDrafts(
  payload: AppServerNotificationPayload,
  runState: CodexRunState = createCodexRunState(),
): { type: string; summary?: string; text?: string }[] {
  return projectCodexEvent(payload, createTurnState(), runState, CODEX_CONTEXT).projection.drafts as never;
}

/** 一条 dsh 会话事件（外形照 dump：`{ method, params: { sessionId, event } }`） */
function dshSessionEvent(type: string, data: unknown): unknown {
  return { method: 'session.event', params: { sessionId: 'session-1', event: { type, seq: 1, time: 1, data } } };
}

/** 一条 codex 通知（`item/started` 与 `item/completed` 只差这一格） */
function codexItem(item: AppServerItem, completed = false): AppServerNotificationPayload {
  return completed
    ? { kind: 'itemCompleted', threadId: 'thread-main', turnId: 'turn-1', item, completedAtMs: 1_700_000_000_000 }
    : { kind: 'itemStarted', threadId: 'thread-main', turnId: 'turn-1', item };
}

/**
 * 摘要（没有摘要就是 `null`，与消费方 `activityOf` 的读法一致）。
 * ⚠️ 它**分不出**「没落日志」与「落了但不带摘要」——所以「该沉默」那一组还要用 `logDrafts`
 * 单独断言「证据照落」：只用本函数的话，把整条证据日志删掉也能绿（审查 N3 指出的假绿）。
 */
function summaryOf(drafts: { type: string; summary?: string }[]): string | null {
  const log = drafts.find((draft) => draft.type === 'log' && draft.summary !== undefined);
  return log?.summary ?? null;
}

/** 这一批草稿里的**日志条数**与它们的文本（用来钉「不给摘要 ≠ 不落证据」） */
function logDrafts(drafts: { type: string; text?: string }[]): string[] {
  return drafts.filter((draft) => draft.type === 'log').map((draft) => draft.text ?? '');
}

describe('工具调用：三家逐字同形（`调用工具 <名>：<参数摘要>`）', () => {
  it('同一条命令 ⇒ 只有工具名不同，`：<参数>` 那一段逐字相同', () => {
    const claude = summaryOf(
      claudeDrafts({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }] },
      }),
    );
    const dsh = summaryOf(dshDrafts(dshSessionEvent('tool/call', { name: 'pwsh', arguments: '{"command":"npm run build"}' })));
    const codex = summaryOf(
      codexDrafts(
        codexItem({
          kind: 'commandExecution',
          id: 'c1',
          command: 'npm run build',
          cwd: null,
          status: 'inProgress',
          output: null,
          exitCode: null,
          durationMs: null,
        }),
      ),
    );

    expect(claude).toBe('调用工具 Bash：npm run build');
    expect(dsh).toBe('调用工具 pwsh：npm run build');
    expect(codex).toBe('调用工具 exec_command：npm run build');
    // 句式与参数那一段逐字相同：差异只允许在厂商的工具名上
    const tail = (summary: string | null): string => summary?.slice(summary.indexOf('：')) ?? '';
    expect([tail(claude), tail(dsh), tail(codex)]).toEqual(['：npm run build', '：npm run build', '：npm run build']);
    expect([claude, dsh, codex].every((one) => one?.startsWith('调用工具 '))).toBe(true);
  });

  it('**该沉默的一起沉默**：工具成功返回在三家都不给摘要（活动行答的是「在做什么」）', () => {
    const claude = summaryOf(
      claudeDrafts({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] },
      }),
    );
    const dsh = summaryOf(
      dshDrafts(dshSessionEvent('tool/result', { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false } })),
    );
    const codex = summaryOf(
      codexDrafts(
        codexItem(
          { kind: 'commandExecution', id: 'c1', command: 'npm run build', cwd: null, status: 'completed', output: 'ok', exitCode: 0, durationMs: 12 },
          true,
        ),
      ),
    );
    expect([claude, dsh, codex]).toEqual([null, null, null]);
  });
});

describe('工具报错：三家逐字同形（`工具报错：<内容>`）', () => {
  it('同一条错误文案 ⇒ 同一句话', () => {
    const claude = summaryOf(
      claudeDrafts({
        type: 'user',
        uuid: 'u2',
        message: {
          role: 'user',
          content: [{ tool_use_id: 't2', type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'ENOENT: no such file' }] }],
        },
      }),
    );
    const dsh = summaryOf(
      dshDrafts(dshSessionEvent('tool/result', { message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'ENOENT: no such file' }], isError: true } })),
    );
    const codex = summaryOf(
      codexDrafts(
        codexItem(
          {
            kind: 'mcpToolCall',
            id: 'm1',
            server: 'fs',
            tool: 'read',
            status: 'failed',
            durationMs: 1,
            arguments: null,
            result: null,
            error: { message: 'ENOENT: no such file' },
          },
          true,
        ),
      ),
    );

    expect(claude).toBe('工具报错：ENOENT: no such file');
    expect(dsh).toBe(claude);
    expect(codex).toBe(claude);
  });
});

describe('子任务：派发与收场三家逐字同形（且不留占位名）', () => {
  /**
   * dsh 的 catalog 关联表是**模块级**的（名字在 `subagent/catalog` 里、与 `subagent.started`
   * 分两条消息到达）⇒ 用例之间会串，每条用例前清一次（同 `providers/dsh/events.test.ts` 的口径）。
   */
  beforeEach(() => {
    resetSubagentCatalogForTesting();
    // claude 的子任务名字表同样是模块级（收场帧没有 description，名字靠派发帧回填）
    resetClaudeTaskNamesForTesting();
    // codex 的收场去重台账在 runState 上，每条用例各建一份 ⇒ 无需重置
  });

  it('同一个任务名 ⇒ 同一句话（有名字 / 没名字两档都对得上）', () => {
    const name = 'Review Vue 3 page';
    const claudeNamed = summaryOf(claudeDrafts({ type: 'system', subtype: 'task_started', uuid: 's1', task_id: 't-1', description: name }));
    // dsh：`subagent.started` **不带名字**（名字随后由 catalog 补）⇒ 无名那一档正是它最常见的形态
    const dshAnonymous = summaryOf(dshDrafts({ method: 'subagent.started', params: { parentSessionId: 'session-1', childSessionId: 'child-1' } }));
    const codexRunState = createCodexRunState();
    /**
     * codex 的派发**只在 `item/completed`**（receiver id 那一刻才到，真机证据见 `events.ts` 的
     * `collabDrafts`）⇒ 夹具按真机形状写：开始时空 receivers。这里同时**不给昵称**——运行期昵称
     * 多半拿不到（同一份抓包里子线程不发 `thread/started`），无名那一档才是生产的主形态。
     */
    expect(
      codexDrafts(
        codexItem({ kind: 'collabToolCall', id: 'x0', tool: 'spawnAgent', status: 'inProgress', senderThreadId: 'thread-main', receiverThreadIds: [], prompt: null, agentsStates: [] }),
        codexRunState,
      ).length,
    ).toBe(0);
    const codexNamed = summaryOf(
      codexDrafts(
        codexItem(
          {
            kind: 'collabToolCall',
            id: 'x1',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: 'thread-main',
            receiverThreadIds: ['child-1'],
            prompt: null,
            agentsStates: [{ threadId: 'child-1', status: 'pendingInit', message: null }],
          },
          true,
        ),
        codexRunState,
      ),
    );

    expect(claudeNamed).toBe(`已派发子任务：${name}`);
    // codex 这一档没有名字：词表的口径是「无名不留占位」，与 dsh 的无名档同形
    expect(codexNamed).toBe('已派发子任务');
    // **无名时不留占位**：旧实现两家都写成 `已派发子任务：子任务`（同义反复）
    expect(dshAnonymous).toBe('已派发子任务');

    // 收场那一档：dsh 走真实的两条消息（catalog 补名字 → finished 带终态）
    dshDrafts(dshSessionEvent('subagent/catalog', { version: 0, childId: 'child-1', childCreatedAt: 1, mode: 'one-shot', label: name }));
    const dshSettled = summaryOf(
      dshDrafts({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'child-1',
          parentSessionId: 'session-1',
          childSessionId: 'child-1',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'done' }],
        },
      }),
    );
    expect(dshSettled).toBe(`子任务已完成：${name}`);

    // claude 的同一档：**两条帧**（派发带名字 → 收场帧按真机形状**不带** `description`，名字靠回填）
    claudeDrafts({ type: 'system', subtype: 'task_started', uuid: 's2', task_id: 't-1', description: name });
    const claudeSettled = summaryOf(
      claudeDrafts({ type: 'system', subtype: 'task_notification', uuid: 's3', task_id: 't-1', status: 'completed', summary: 'done' }),
    );
    expect(claudeSettled).toBe(`子任务已完成：${name}`);

    // codex 的同一档（`wait` 完成时带的终态）
    const codexSettled = summaryOf(
      codexDrafts(
        codexItem(
          {
            kind: 'collabToolCall',
            id: 'x2',
            tool: 'wait',
            status: 'completed',
            senderThreadId: 'thread-main',
            receiverThreadIds: ['child-1'],
            prompt: null,
            agentsStates: [{ threadId: 'child-1', status: 'completed', message: null }],
          },
          true,
        ),
        codexRunState,
      ),
    );
    expect(codexSettled).toBe('子任务已完成');
  });
});

describe('计划更新：三家同形（`更新计划：N 步`）', () => {
  it('清单工具与原生计划表说的是同一句', () => {
    const claude = summaryOf(
      claudeDrafts({
        type: 'assistant',
        uuid: 'a2',
        message: { content: [{ type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: [{ content: 'a' }, { content: 'b' }] } }] },
      }),
    );
    const dsh = summaryOf(dshDrafts(dshSessionEvent('tool/call', { name: 'todo_write', arguments: '{"steps":[{"step":"a"},{"step":"b"}]}' })));
    const codex = summaryOf(
      codexDrafts({ kind: 'turnPlanUpdated', threadId: 'thread-main', turnId: 'turn-1', steps: [{ step: 'a', status: 'pending' }, { step: 'b', status: 'pending' }] }),
    );

    expect(claude).toBe('更新计划：2 步');
    expect(dsh).toBe(claude);
    expect(codex).toBe(claude);
  });
});

describe('该沉默的场合：三家一致（推理 / 轮次播报不占活动行）', () => {
  it('推理正文：codex 与 claude 不给摘要，dsh 也不再给（正文的落点是思考块）', () => {
    const claude = summaryOf(
      claudeDrafts({ type: 'assistant', uuid: 'a3', message: { content: [{ type: 'thinking', thinking: '先看看工作区', signature: 's' }] } }),
    );
    const dsh = summaryOf(
      dshDrafts(
        dshSessionEvent('assistant/message', {
          turn: 1,
          step: 1,
          usage: { input: 1, cached: 0, output: 1 },
          message: { role: 'assistant', content: [{ type: 'reasoning', text: '先看看工作区' }] },
        }),
      ),
    );
    const codex = summaryOf(
      codexDrafts(codexItem({ kind: 'reasoning', id: 'r1', summary: [], content: ['先看看工作区'] }, true)),
    );
    expect([claude, dsh, codex]).toEqual([null, null, null]);

    /**
     * 「不给摘要」**不等于**「不落证据」——这一组必须逐条钉在**草稿**上：
     * `summaryOf` 对「没落日志」与「落了不带摘要」给的都是 `null`，只用它的话，把证据日志整条删掉
     * 也照样绿（审查 N3）。三家的证据形态各不同，判据只钉「有日志」这一件事。
     */
    expect(logDrafts(claudeDrafts({ type: 'assistant', uuid: 'a3b', message: { content: [{ type: 'thinking', thinking: '先看看工作区', signature: 's' }] } })).length).toBeGreaterThan(0);
    const dshLogs = logDrafts(
      dshDrafts(
        dshSessionEvent('assistant/message', {
          turn: 1,
          step: 1,
          usage: { input: 1, cached: 0, output: 1 },
          message: { role: 'assistant', content: [{ type: 'reasoning', text: '先看看工作区' }] },
        }),
      ),
    );
    // 推理正文在原始信封里逐字可查（`text` 是 `{method, params}` 那一条）
    expect(dshLogs.some((text) => text.includes('先看看工作区'))).toBe(true);
    expect(logDrafts(codexDrafts(codexItem({ kind: 'reasoning', id: 'r2', summary: [], content: ['先看看工作区'] }, true)))).toEqual([]);
  });

  it('轮次播报不占活动行：dsh 的 `turn/start` 只落证据，codex 的 `turn/started` 连证据都不落', () => {
    const dsh = dshDrafts(dshSessionEvent('turn/start', { turn: 2 }));
    expect(summaryOf(dsh)).toBeNull();
    expect(logDrafts(dsh).length).toBeGreaterThan(0);

    const codex = codexDrafts({ kind: 'turnStarted', threadId: 'thread-main', turnId: 'turn-1' });
    expect(summaryOf(codex)).toBeNull();
    expect(logDrafts(codex)).toEqual([]);
  });
});
