// @vitest-environment node
/**
 * 观察者（`before_provider_request` 的取证）与两条 L3 判据的守卫。
 *
 * 为什么这几条必须逐条钉住：pi 的技能面与 MCP 工具面**只体现在出站请求里**，
 * 而两条 wire 把系统段放在两个不同的地方（openai 在 `messages[]`、anthropic 在顶层 `params.system`）。
 * 只实现一条的后果不是报错，而是另一条 wire 上判据恒空——「装了但判成没装」。
 */
import { describe, expect, it } from 'vitest';
import {
  createPiObserver,
  piRequestSkills,
  piRequestToolNames,
  piSkillReadSatisfied,
  piSystemText,
  type PiExtensionApi,
} from './observer';

/** 技能段（厂商 `formatSkillsForPrompt` 的形状，逐字对齐真机读数） */
function skillsSection(entries: Array<{ name: string; description?: string; location: string }>): string {
  const lines = [
    '\n\nThe following skills provide specialized instructions for specific tasks.',
    'Use the read tool to load a skill\'s file when the task matches its description.',
    '',
    '<available_skills>',
  ];
  for (const entry of entries) {
    lines.push('  <skill>');
    lines.push(`    <name>${entry.name}</name>`);
    lines.push(`    <description>${entry.description ?? '示例'}</description>`);
    lines.push(`    <location>${entry.location}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

/** openai wire 的请求体：系统段是 `messages[]` 里的一条 `system` 消息 */
function openaiPayload(system: string, tools: string[]): unknown {
  return {
    model: 'probe',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: '跑一下' },
    ],
    tools: tools.map((name) => ({ type: 'function', function: { name, description: 'x', parameters: {} } })),
  };
}

/** anthropic wire 的请求体：系统段在顶层 `system`（文本块数组），工具名在 `tools[].name` */
function anthropicPayload(system: string, tools: string[]): unknown {
  return {
    model: 'probe',
    system: [{ type: 'text', text: system }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '跑一下' }] }],
    tools: tools.map((name) => ({ name, description: 'x', input_schema: { type: 'object' } })),
  };
}

const ROW_SKILL = { name: 'alpha', location: '/runs/row-1/.agenthome/skills/alpha/SKILL.md' };

describe('pi 的请求侧观察者', () => {
  it('捕获 before_provider_request 的 payload，逐次计数、只留最近一份', () => {
    const observer = createPiObserver();
    const handlers: Array<(event: { payload: unknown }) => void> = [];
    const pi: PiExtensionApi = {
      on: (event, handler) => {
        expect(event).toBe('before_provider_request');
        handlers.push(handler);
      },
    };
    observer.factory(pi);
    expect(handlers).toHaveLength(1);
    // 一条都没发出去时是「零次观测」，不是「读过但读空了」
    expect(observer.count()).toBe(0);
    expect(observer.latest()).toBeNull();

    handlers[0]?.({ payload: { first: true } });
    handlers[0]?.({ payload: { second: true } });
    expect(observer.count()).toBe(2);
    expect(observer.latest()).toEqual({ second: true });
  });
});

describe('技能装载档：按 wire 取系统段（只实现一条会让另一条恒空）', () => {
  it('openai wire：系统段在 messages[] 的 system 角色里', () => {
    const payload = openaiPayload(skillsSection([ROW_SKILL]), ['read']);
    expect(piSystemText(payload, 'openai-completions')).toContain('<available_skills>');
    expect(piRequestSkills(payload, 'openai-completions')).toEqual([ROW_SKILL]);
  });

  it('anthropic wire：系统段在顶层 system，逐名仍然读得出来', () => {
    const payload = anthropicPayload(skillsSection([ROW_SKILL]), ['read']);
    expect(piRequestSkills(payload, 'anthropic-messages')).toEqual([ROW_SKILL]);
  });

  it('两条 wire 各读自己那一处：把系统段放错位置时该 wire 读不到（判据不是「段在不在」）', () => {
    const section = skillsSection([ROW_SKILL]);
    // openai 的判据不认顶层 system，anthropic 的判据不认 messages[]——互相顶替会让「没装」读成「装了」
    expect(piRequestSkills(anthropicPayload(section, ['read']), 'openai-completions')).toEqual([]);
    expect(piRequestSkills(openaiPayload(section, ['read']), 'anthropic-messages')).toEqual([]);
  });

  it('openai wire 认 developer 角色（同一段系统文本的另一种挂法）', () => {
    const payload = {
      messages: [{ role: 'developer', content: skillsSection([ROW_SKILL]) }],
      tools: [],
    };
    expect(piRequestSkills(payload, 'openai-completions')).toEqual([ROW_SKILL]);
  });

  it('逐条解析：段在、里面没有那一条 ⇒ 读不到它（同名冲突与「藏起来」都长这样）', () => {
    const other = { name: 'beta', location: '/repo/.pi/skills/alpha/SKILL.md' };
    const payload = openaiPayload(skillsSection([other]), ['read']);
    const names = piRequestSkills(payload, 'openai-completions').map((skill) => skill.name);
    expect(names).toEqual(['beta']);
    expect(names).not.toContain(ROW_SKILL.name);
  });

  it('用 name 匹配、不用 description：description 里的 XML 转义不影响判定，location 反转义回原值', () => {
    const location = '/runs/a&b/row-1/.agenthome/skills/alpha/SKILL.md';
    const payload = openaiPayload(
      skillsSection([{ name: 'alpha', description: 'A & B <引号>', location: '/runs/a&amp;b/row-1/.agenthome/skills/alpha/SKILL.md' }]),
      ['read'],
    );
    // description 那串被转义的原文不在判据里；落点按厂商转义还原，才配得上「逐字相等」
    expect(piRequestSkills(payload, 'openai-completions')).toEqual([{ name: 'alpha', location }]);
  });

  it('没有技能段 ⇒ 空数组（不是「装上了但没读到」）', () => {
    expect(piRequestSkills(openaiPayload('光秃秃的系统提示词', ['read']), 'openai-completions')).toEqual([]);
  });
});

describe('工具表：两条 wire 的名字位置不同，一次读法同时认两处', () => {
  it('openai 走 tools[].function.name', () => {
    expect(piRequestToolNames(openaiPayload('x', ['read', 'mcp__probe__echo']))).toEqual(['read', 'mcp__probe__echo']);
  });

  it('anthropic 走 tools[].name', () => {
    expect(piRequestToolNames(anthropicPayload('x', ['read', 'mcp__probe__echo']))).toEqual(['read', 'mcp__probe__echo']);
  });

  it('没有工具表 / 条目形状不认识 ⇒ 空数组（不编一个名字出来）', () => {
    expect(piRequestToolNames({ messages: [] })).toEqual([]);
    expect(piRequestToolNames({ tools: [null, { function: {} }, { name: 42 }] })).toEqual([]);
  });
});

describe('技能行为档：read 实参 == location 且 tool_result 是正文', () => {
  const body = '---\nname: alpha\ndescription: 示例\n---\n\nBODY-OF-alpha\n';
  const read = (path: unknown, resultText: string | null, isError = false) => ({
    toolName: 'read',
    args: { path },
    resultText,
    isError,
  });

  it('实参逐字相等且结果含正文 ⇒ 成立', () => {
    expect(piSkillReadSatisfied([read(ROW_SKILL.location, body)], { location: ROW_SKILL.location, body })).toBe(true);
  });

  it('读了别的文件 / 结果不是正文 / 结果报错 ⇒ 都不成立', () => {
    expect(piSkillReadSatisfied([read('/tmp/other.md', body)], { location: ROW_SKILL.location, body })).toBe(false);
    expect(piSkillReadSatisfied([read(ROW_SKILL.location, '工具输出被截断')], { location: ROW_SKILL.location, body })).toBe(false);
    expect(piSkillReadSatisfied([read(ROW_SKILL.location, body, true)], { location: ROW_SKILL.location, body })).toBe(false);
  });

  it('只认 read 的 path：别的工具或别的参数名不算读了这条技能', () => {
    expect(piSkillReadSatisfied([{ toolName: 'bash', args: { path: ROW_SKILL.location }, resultText: body, isError: false }], { location: ROW_SKILL.location, body })).toBe(false);
    expect(piSkillReadSatisfied([{ toolName: 'read', args: { file_path: ROW_SKILL.location }, resultText: body, isError: false }], { location: ROW_SKILL.location, body })).toBe(false);
  });

  it('正文为空 ⇒ 不成立（没有正文可对，不许凭「路径对上了」就判过）', () => {
    expect(piSkillReadSatisfied([read(ROW_SKILL.location, '')], { location: ROW_SKILL.location, body: '  ' })).toBe(false);
  });
});
