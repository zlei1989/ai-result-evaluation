// @vitest-environment node
/**
 * 智能体真源：三个 id、顺序、标签。
 * 顺序不是装饰——它同时是 `agents` 注册表 `listAgentProviders()` 的顺序与前端下拉的顺序，
 * 三者任一漂移，界面上「选中的智能体」与「真正跑的那家」就会错位。
 * 本文件是本次改动新增的唯一真源文件；包根的出口面由同目录的 `index.test.ts` 守着。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, AGENT_LABELS, AgentKindSchema } from './agent';

describe('智能体真源', () => {
  it('恰好三家且顺序固定', () => {
    expect([...AGENT_KINDS]).toEqual(['claude-code', 'codex', 'dsh']);
  });

  it('每个 id 都有中文标签', () => {
    expect(AGENT_LABELS['claude-code']).toBe('Claude Code');
    expect(AGENT_LABELS.codex).toBe('Codex');
    expect(AGENT_LABELS.dsh).toBe('DeepSeek Harness');
  });

  it('schema 只认这三个 id', () => {
    expect(AgentKindSchema.safeParse('dsh').success).toBe(true);
    expect(AgentKindSchema.safeParse('gemini').success).toBe(false);
  });
});
