// @vitest-environment node
/**
 * `protocol.ts` 的行为契约。
 *
 * 每条断言都钉一个**具体形状**：上游换字段名、把值搬到别处、或者把「没采到」变成空值时，
 * 这里要红。样例取自真机报文（`thread/list` / `thread/items/list` / 通知流）。
 */
import { describe, expect, it } from 'vitest';
import {
  readItem,
  readItemEntry,
  readNotification,
  readSourceKind,
  readSubAgentSpawn,
  readThread,
  readTokenUsage,
} from './protocol';

const USAGE = {
  totalTokens: 100,
  inputTokens: 60,
  cachedInputTokens: 40,
  cacheWriteInputTokens: 0,
  outputTokens: 10,
  reasoningOutputTokens: 5,
};

describe('readTokenUsage —— 用量', () => {
  it('六个字段齐备才算采到', () => {
    expect(readTokenUsage(USAGE)).toEqual(USAGE);
  });

  it('缺任一字段返回 null（不拿 0 冒充「没采到」）', () => {
    const { outputTokens: _omitted, ...partial } = USAGE;
    expect(readTokenUsage(partial)).toBeNull();
    expect(readTokenUsage(null)).toBeNull();
  });
});

describe('readItem —— 条目归一化', () => {
  it('reasoning：summary 与 content 分开取，正文是明文块', () => {
    const item = readItem({ type: 'reasoning', id: 'r1', summary: [], content: ['先看仓库结构。'] });
    expect(item).toEqual({ kind: 'reasoning', id: 'r1', summary: [], content: ['先看仓库结构。'] });
  });

  it('agentMessage：text 与 phase', () => {
    expect(readItem({ type: 'agentMessage', id: 'm1', text: '空仓库，我直接创建页面。', phase: 'commentary' })).toEqual({
      kind: 'agentMessage',
      id: 'm1',
      text: '空仓库，我直接创建页面。',
      phase: 'commentary',
    });
  });

  it('commandExecution：命令 / 输出 / 退出码 / 耗时', () => {
    const item = readItem({
      type: 'commandExecution',
      id: 'c1',
      command: 'powershell -Command ls',
      cwd: 'D:/w',
      status: 'completed',
      aggregatedOutput: 'index.html',
      exitCode: 0,
      durationMs: 12,
    });
    expect(item).toEqual({
      kind: 'commandExecution',
      id: 'c1',
      command: 'powershell -Command ls',
      cwd: 'D:/w',
      status: 'completed',
      output: 'index.html',
      exitCode: 0,
      durationMs: 12,
    });
  });

  it('collabAgentToolCall：receivers 与 agentsStates（以子线程 id 为键的对象摊成数组）', () => {
    const item = readItem({
      type: 'collabAgentToolCall',
      id: 'call_1',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'parent',
      receiverThreadIds: ['child'],
      prompt: '审查页面',
      agentsStates: { child: { status: 'completed', message: 'PASS' } },
    });
    expect(item).toEqual({
      kind: 'collabToolCall',
      id: 'call_1',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'parent',
      receiverThreadIds: ['child'],
      prompt: '审查页面',
      agentsStates: [{ threadId: 'child', status: 'completed', message: 'PASS' }],
    });
  });

  it('subAgentActivity：kind 归一到 activity，带子线程 id 与 agent_path', () => {
    expect(
      readItem({ type: 'subAgentActivity', id: 'a1', kind: 'interrupted', agentThreadId: 'child', agentPath: '/root/w' }),
    ).toEqual({ kind: 'subAgentActivity', id: 'a1', activity: 'interrupted', agentThreadId: 'child', agentPath: '/root/w' });
  });

  it('未识别的类型归 other 并保留类型名（不丢，便于发现上游新增）', () => {
    expect(readItem({ type: 'sleep', id: 's1' })).toEqual({ kind: 'other', id: 's1', type: 'sleep' });
  });

  it('mcpToolCall：参数 / 结果 / 错误原样带出（构造调用块与结果块要用）', () => {
    expect(
      readItem({
        type: 'mcpToolCall',
        id: 'm1',
        server: 'fs',
        tool: 'read_file',
        status: 'completed',
        durationMs: 8,
        arguments: { path: 'a.txt' },
        result: { content: 'hi' },
        error: null,
      }),
    ).toEqual({
      kind: 'mcpToolCall',
      id: 'm1',
      server: 'fs',
      tool: 'read_file',
      status: 'completed',
      durationMs: 8,
      arguments: { path: 'a.txt' },
      result: { content: 'hi' },
      error: null,
    });
  });

  it('dynamicToolCall：参数与内容项带出', () => {
    expect(
      readItem({
        type: 'dynamicToolCall',
        id: 'd1',
        namespace: 'plugins',
        tool: 'deploy',
        status: 'failed',
        success: false,
        durationMs: 3,
        arguments: { env: 'dev' },
        contentItems: [{ type: 'text', text: '失败原因' }],
      }),
    ).toEqual({
      kind: 'dynamicToolCall',
      id: 'd1',
      namespace: 'plugins',
      tool: 'deploy',
      status: 'failed',
      success: false,
      durationMs: 3,
      arguments: { env: 'dev' },
      contentItems: [{ type: 'text', text: '失败原因' }],
    });
  });

  it('functionCallOutput：工具真名与输出正文；字段缺失时为 null（不填 undefined）', () => {
    expect(readItem({ type: 'functionCallOutput', id: 'o1', name: 'exec_command', namespace: null, output: 'done' })).toEqual({
      kind: 'toolOutput',
      id: 'o1',
      name: 'exec_command',
      namespace: null,
      output: 'done',
    });
    expect(readItem({ type: 'functionCallOutput', id: 'o2', name: 'x' })).toEqual({
      kind: 'toolOutput',
      id: 'o2',
      name: 'x',
      namespace: null,
      output: null,
    });
  });

  it('非对象返回 null', () => {
    expect(readItem('nope')).toBeNull();
  });
});

describe('readSubAgentSpawn —— 子智能体身份', () => {
  it('读 source.subAgent.thread_spawn 的 snake_case 字段', () => {
    expect(
      readSubAgentSpawn({
        subAgent: {
          thread_spawn: {
            parent_thread_id: 'parent',
            depth: 1,
            agent_path: '/root/worker',
            agent_nickname: 'Harvey',
            agent_role: 'explorer',
          },
        },
      }),
    ).toEqual({
      parentThreadId: 'parent',
      depth: 1,
      agentPath: '/root/worker',
      agentNickname: 'Harvey',
      agentRole: 'explorer',
    });
  });

  it('缺 parent_thread_id 视为没有派发信息（不造半个对象）', () => {
    expect(readSubAgentSpawn({ subAgent: { thread_spawn: { depth: 1 } } })).toBeNull();
    expect(readSubAgentSpawn('exec')).toBeNull();
  });
});

describe('readSourceKind —— 来源分类', () => {
  it('字符串形态按白名单归一，未登记归 unknown', () => {
    expect(readSourceKind('exec')).toBe('exec');
    expect(readSourceKind('vscode')).toBe('vscode');
    expect(readSourceKind('something-new')).toBe('unknown');
  });

  it('对象形态（{subAgent}）归 subAgent', () => {
    expect(readSourceKind({ subAgent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } })).toBe('subAgent');
  });
});

describe('readThread —— 线程', () => {
  it('身份 / 父链 / 状态 / 来源 / 轮次', () => {
    const thread = readThread({
      id: 'child',
      parentThreadId: 'parent',
      agentNickname: 'Harvey',
      agentRole: null,
      status: { type: 'active', activeFlags: ['streaming'] },
      source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } },
      cwd: 'D:/w',
      cliVersion: '0.156.1',
      model: 'deepseek-flash',
      preview: '审查页面',
      turns: [
        {
          id: 'turn-1',
          items: [{ type: 'agentMessage', id: 'm1', text: 'OK' }],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
        },
      ],
    });
    expect(thread?.id).toBe('child');
    expect(thread?.parentThreadId).toBe('parent');
    expect(thread?.agentNickname).toBe('Harvey');
    expect(thread?.status).toEqual({ type: 'active', activeFlags: ['streaming'] });
    expect(thread?.sourceKind).toBe('subAgent');
    expect(thread?.turns).toHaveLength(1);
    expect(thread?.turns[0]?.items[0]).toEqual({ kind: 'agentMessage', id: 'm1', text: 'OK', phase: null });
  });

  it('缺 id 返回 null', () => {
    expect(readThread({ parentThreadId: 'p' })).toBeNull();
  });
});

describe('readItemEntry —— 条目列表项', () => {
  it('条目自带所属轮次', () => {
    expect(readItemEntry({ turnId: 'turn-1', item: { type: 'plan', id: 'p1', text: '步骤' } })).toEqual({
      turnId: 'turn-1',
      item: { kind: 'plan', id: 'p1', text: '步骤' },
    });
  });

  it('缺 turnId 或条目不可解析时返回 null', () => {
    expect(readItemEntry({ item: { type: 'plan', id: 'p1', text: 'x' } })).toBeNull();
    expect(readItemEntry({ turnId: 't', item: 42 })).toBeNull();
  });
});

describe('readNotification —— 通知归一化', () => {
  it('thread/started 带完整线程', () => {
    const payload = readNotification('thread/started', {
      thread: { id: 'child', parentThreadId: 'parent', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } } },
    });
    expect(payload.kind).toBe('threadStarted');
    if (payload.kind === 'threadStarted') expect(payload.thread.parentThreadId).toBe('parent');
  });

  it('turn/started 的 turnId 取自 turn.id（不是顶层 turnId）', () => {
    const payload = readNotification('turn/started', { threadId: 't', turn: { id: 'turn-9', items: [] } });
    expect(payload).toEqual({ kind: 'turnStarted', threadId: 't', turnId: 'turn-9' });
  });

  it('turn/completed 带状态 / 错误 / 时长', () => {
    const payload = readNotification('turn/completed', {
      threadId: 't',
      turn: { id: 'turn-1', items: [], status: 'failed', error: { message: '模型超时' }, durationMs: 5, completedAt: 7 },
    });
    expect(payload.kind).toBe('turnCompleted');
    if (payload.kind === 'turnCompleted') {
      expect(payload.turn.status).toBe('failed');
      expect(payload.turn.error).toBe('模型超时');
      expect(payload.turn.durationMs).toBe(5);
    }
  });

  it('item/completed 带归属线程与完成时刻', () => {
    const payload = readNotification('item/completed', {
      threadId: 't',
      turnId: 'turn-1',
      completedAtMs: 123,
      item: { type: 'agentMessage', id: 'm1', text: '完成' },
    });
    expect(payload).toEqual({
      kind: 'itemCompleted',
      threadId: 't',
      turnId: 'turn-1',
      completedAtMs: 123,
      item: { kind: 'agentMessage', id: 'm1', text: '完成', phase: null },
    });
  });

  it('文本增量：agentMessage 与 reasoning 各自归一', () => {
    expect(readNotification('item/agentMessage/delta', { threadId: 't', turnId: 'u', itemId: 'i', delta: '你' })).toEqual({
      kind: 'agentMessageDelta',
      threadId: 't',
      turnId: 'u',
      itemId: 'i',
      delta: '你',
    });
    expect(readNotification('item/reasoning/textDelta', { threadId: 't', turnId: 'u', itemId: 'i', delta: '想' })).toEqual({
      kind: 'reasoningTextDelta',
      threadId: 't',
      turnId: 'u',
      itemId: 'i',
      delta: '想',
    });
  });

  it('thread/tokenUsage/updated 的用量在 tokenUsage 字段', () => {
    const payload = readNotification('thread/tokenUsage/updated', {
      threadId: 't',
      turnId: 'u',
      tokenUsage: { total: USAGE, last: USAGE, modelContextWindow: 1048576 },
    });
    expect(payload.kind).toBe('tokenUsage');
    if (payload.kind === 'tokenUsage') {
      expect(payload.usage.last).toEqual(USAGE);
      expect(payload.usage.modelContextWindow).toBe(1048576);
    }
  });

  it('error 的文案在 error.message 里，且带线程 id', () => {
    expect(readNotification('error', { threadId: 't', turnId: 'u', error: { message: '流中断' }, willRetry: true })).toEqual({
      kind: 'error',
      threadId: 't',
      message: '流中断',
    });
  });

  it('未识别的方法归 other 并保留方法名', () => {
    expect(readNotification('thread/realtime/started', {})).toEqual({ kind: 'other', method: 'thread/realtime/started' });
  });
});
