// @vitest-environment node
/**
 * 智能体真源：全部 id、顺序、标签。
 * 顺序不是装饰——它同时是 `agents` 注册表 `listAgentProviders()` 的顺序与前端下拉的顺序，
 * 三者任一漂移，界面上「选中的智能体」与「真正跑的那家」就会错位。
 * 标签表是 `Record<AgentKind, string>`：漏一家的编译期就报错，本文件守的是**取值**。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, AGENT_LABELS, AgentKindSchema } from './agent';

describe('智能体真源', () => {
  it('清单与顺序固定', () => {
    expect([...AGENT_KINDS]).toEqual(['cc', 'codex', 'dsh', 'pi']);
  });

  it('每个 id 都有中文标签', () => {
    expect(AGENT_LABELS['cc']).toBe('Claude Code');
    expect(AGENT_LABELS.codex).toBe('Codex');
    expect(AGENT_LABELS.dsh).toBe('DeepSeek Harness');
    expect(AGENT_LABELS.pi).toBe('Pi Coding Agent');
  });

  it('schema 只认清单里的 id', () => {
    expect(AgentKindSchema.safeParse('cc').success).toBe(true);
    expect(AgentKindSchema.safeParse('dsh').success).toBe(true);
    expect(AgentKindSchema.safeParse('pi').success).toBe(true);
    expect(AgentKindSchema.safeParse('gemini').success).toBe(false);
    // `claude-code` 是这一格的历史字符串形态：闭集不收历史值，读侧也不做归一
    // （放它进来等于同一格两个答案：旧 run.json 里是它、新写的配置里是 cc）
    expect(AgentKindSchema.safeParse('claude-code').success).toBe(false);
  });
});
