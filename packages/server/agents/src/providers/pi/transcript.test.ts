// @vitest-environment node
/**
 * pi 子会话转写投影的守卫：**子任务的逐步骤正文是这一层唯一的来源**。
 *
 * 判据一律取**产物**（消息草稿的信封与块）与**路径字符串**，不断言实现里调了哪个函数。
 * 三条最要紧的：
 *   · **每一条都盖上 `subagentId`**：漏了它，这批消息就回到主会话节点上去了（挂错节点比不显示更坏）；
 *   · **轮次是子任务自己的 1..N**：与主会话共用一个计数器会让几十条消息全挤进一个轮次行；
 *   · **读不到不抛、要点名**：转写是旁路文件（扩展关了、还没落盘、读不动都可能），
 *     一次读盘失败不该把一次跑完的运行翻成失败，但也不许静默什么都不说。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PI_SUBAGENT_TRANSCRIPT_MAX_LINES,
  piSubagentTranscriptPath,
  projectTranscriptLines,
  readPiSubagentTranscript,
} from './transcript';

const AGENT_ID = 'ee5a55d2-cc6c-480';
const SESSION_ID = '01a13280-3b01-75f0-ad85-2a0e38d60c38';
const CWD = '/Users/someone/Workspaces/run-1/rows/row-1/workspace';

/** 一条转写行（真机形状：`{isSidechain, agentId, type, message, timestamp, cwd}`） */
function line(type: string, message: Record<string, unknown>, agentId = AGENT_ID): string {
  return JSON.stringify({ isSidechain: true, agentId, type, message, timestamp: '2026-10-12T23:44:02.773Z', cwd: CWD });
}

/** 助手行：与父会话 `message_end.message` 同构 */
function assistantLine(content: unknown[], overrides: Record<string, unknown> = {}, agentId = AGENT_ID): string {
  return line('assistant', {
    role: 'assistant',
    content,
    usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0 } },
    stopReason: 'toolUse',
    responseId: 'resp_1',
    ...overrides,
  }, agentId);
}

/** 工具结果行：`ToolResultMessage`（正文在 `message.content`，不在 `result.content`） */
function toolResultLine(callId: string, text: string, overrides: Record<string, unknown> = {}): string {
  return line('toolResult', {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    durationMs: 5,
    ...overrides,
  });
}

/** 首行：派发的任务提示词（正文是**裸字符串**，不是块数组） */
function userLine(prompt: string): string {
  return line('user', { role: 'user', content: prompt });
}

const call = (id: string, name: string): unknown => ({ type: 'toolCall', id, name, arguments: { path: 'a.ts' } });

describe('转写路径：由本行的 cwd 与会话 id 拼出来', () => {
  it('路径 = <tmpdir>/pi-subagents-<uid>/<cwd 编码>/<会话 id>/tasks/<身份>.output', () => {
    const path = piSubagentTranscriptPath({ cwd: CWD, sessionId: SESSION_ID, agentId: AGENT_ID });
    expect(path).toBe(join(
      tmpdir(),
      `pi-subagents-${process.getuid?.() ?? 0}`,
      'Users-someone-Workspaces-run-1-rows-row-1-workspace',
      SESSION_ID,
      'tasks',
      `${AGENT_ID}.output`,
    ));
  });

  it('cwd 的两种分隔符都换成 `-`，盘符前缀与开头的 `-` 去掉（与扩展的目录布局逐字一致）', () => {
    const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
    expect(piSubagentTranscriptPath({ cwd: 'C:\\Users\\foo\\project', sessionId: SESSION_ID, agentId: AGENT_ID }))
      .toBe(join(root, 'Users-foo-project', SESSION_ID, 'tasks', `${AGENT_ID}.output`));
    // POSIX 根目录编码后不以 `-` 开头（UNC 同一条处置）
    expect(piSubagentTranscriptPath({ cwd: '/srv/app', sessionId: SESSION_ID, agentId: AGENT_ID }))
      .toBe(join(root, 'srv-app', SESSION_ID, 'tasks', `${AGENT_ID}.output`));
  });

  it('身份或会话 id 含路径分隔符时**不去拼路径**（宁可当边界，也不碰一个可能指到别处的路径）', () => {
    expect(piSubagentTranscriptPath({ cwd: CWD, sessionId: SESSION_ID, agentId: '../../etc/passwd' })).toBeNull();
    expect(piSubagentTranscriptPath({ cwd: CWD, sessionId: '../..', agentId: AGENT_ID })).toBeNull();
  });

  /**
   * **会话 id 的判据跟厂商自己的 `assertValidSessionId` 同宽**（首尾字母数字，中间允许 `.`）。
   *
   * 收得比厂商更严的代价已经量到过：厂商允许 `.`，而 `sessionId` 是**它**生成的
   * （`uuidv7()` 今天不带点，`SessionManager.create(..., { id })` 与导入的会话可以带）
   * ⇒ 白名单收紧了，这一格的转写路径恒为 `null`、兜底通道**静默**读不到
   * （跑动期增量那条路连 WARN 都没有），症状与「子任务本来就没说话」一模一样。
   * `..` 这种唯一有路径含义的写法仍被「首尾必须是字母数字」挡住——上面那条用例钉的就是它。
   */
  it('会话 id 里的 `.` 照样拼得出路径（与厂商的 id 语法同宽），但首尾不能是点', () => {
    const dotted = piSubagentTranscriptPath({ cwd: CWD, sessionId: '01a1.4f-506b.7514', agentId: AGENT_ID });
    expect(dotted, '带点的会话 id 被我们自己的白名单挡掉了 ⇒ 兜底通道静默失效').toContain('01a1.4f-506b.7514');
    expect(dotted).toContain(`${AGENT_ID}.output`);
    for (const sessionId of ['.hidden', 'x.', '..', '.', 'a..b/../c']) {
      expect(piSubagentTranscriptPath({ cwd: CWD, sessionId, agentId: AGENT_ID }), sessionId).toBeNull();
    }
  });
});

describe('转写投影：每一条都盖上子会话的信封', () => {
  it('助手行各占一轮（1..N），工具结果沿用当前号，且逐条带 subagentId 与 session-file 来源', () => {
    const text = [
      userLine('帮我核对这个文件'),
      assistantLine([{ type: 'thinking', thinking: '先读文件' }, call('call_a', 'read')]),
      toolResultLine('call_a', '文件内容'),
      assistantLine([{ type: 'text', text: '核对完了' }], { stopReason: 'stop' }),
      '',
    ].join('\n');
    const { messages, dropped } = projectTranscriptLines(text, AGENT_ID, SESSION_ID);

    expect(dropped).toBe(0);
    expect(messages.map((m) => [m.role, m.roundTrip, m.subagentId, m.source])).toEqual([
      ['assistant', 1, AGENT_ID, 'session-file'],
      ['tool', 1, AGENT_ID, 'session-file'],
      ['assistant', 2, AGENT_ID, 'session-file'],
    ]);
    // 块形状来自**既有**的助手归一（本层不重写解析）：思考 → 工具调用
    expect(messages[0]?.blocks.map((b) => b.block.type)).toEqual(['thinking', 'tool-call']);
    expect(messages[1]?.blocks.map((b) => b.block.type)).toEqual(['tool-result']);
    expect(messages[2]?.blocks.map((b) => b.block.type)).toEqual(['text']);
  });

  it('工具结果靠 parentCallId 配回它的调用块（界面按这一格把结果挂在调用上）', () => {
    const text = [
      assistantLine([call('call_a', 'read')]),
      toolResultLine('call_a', '内容'),
      '',
    ].join('\n');
    const { messages } = projectTranscriptLines(text, AGENT_ID, SESSION_ID);
    expect(messages[0]?.blocks[0]?.block).toMatchObject({ type: 'tool-call', callId: 'call_a' });
    expect(messages[1]?.parentCallId).toBe('call_a');
    expect(messages[1]?.blocks[0]?.block).toMatchObject({ type: 'tool-result', callId: 'call_a' });
  });

  it('助手那一份用量逐轮带上（转写里的 usage 与父会话同一把尺）', () => {
    const { messages } = projectTranscriptLines(`${assistantLine([{ type: 'text', text: '好' }])}\n`, AGENT_ID, SESSION_ID);
    expect(messages[0]?.usage).toEqual({
      input: 100,
      cached: 5,
      output: 20,
      reasoningOutput: null,
      total: 125,
    });
  });

  it('派发提示词（user）与 system 行不投影：它不是子智能体自己说的话', () => {
    const text = [
      userLine('这是派发给它的任务'),
      line('system', { role: 'system', content: '工具清单' }),
      assistantLine([{ type: 'text', text: '收到' }]),
      '',
    ].join('\n');
    const { messages } = projectTranscriptLines(text, AGENT_ID, SESSION_ID);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.roundTrip).toBe(1);
    expect(messages.every((m) => m.role === 'assistant')).toBe(true);
  });

  it('身份对不上的行当坏行跳过（文件名才是身份，内容不是）', () => {
    const text = [
      line('assistant', { role: 'assistant', content: [{ type: 'text', text: '别人的' }] }, 'other-agent'),
      assistantLine([{ type: 'text', text: '我的' }]),
      '',
    ].join('\n');
    const { messages } = projectTranscriptLines(text, AGENT_ID, SESSION_ID);
    expect(messages).toHaveLength(1);
    expect(messages.map((m) => m.roundTrip)).toEqual([1]);
  });
});

describe('转写读取：宽容解析', () => {
  it('坏行跳过；**没有换行收尾的末行**丢掉（那是一次 flush 写到一半的残行）', () => {
    const complete = assistantLine([{ type: 'text', text: '第一条' }]);
    const half = '{"isSidechain":true,"agentId":"ee5a55d2-cc6c-480","type":"assistant","mess';
    const text = `${complete}\n不是一个 JSON\n${assistantLine([{ type: 'text', text: '第二条' }])}\n${half}`;
    const { messages } = projectTranscriptLines(text, AGENT_ID, SESSION_ID);
    expect(messages.map((m) => m.roundTrip)).toEqual([1, 2]);
  });

  it('以换行收尾时末行照收（文件完整时一行都不丢）', () => {
    const text = `${assistantLine([{ type: 'text', text: '唯一一条' }])}\n`;
    expect(projectTranscriptLines(text, AGENT_ID, SESSION_ID).messages).toHaveLength(1);
  });

  it('超过上限时只投影最后 N 行并**报出丢了多少**（悄悄少一半与「本来就这些」长得一样）', () => {
    const lines = Array.from({ length: PI_SUBAGENT_TRANSCRIPT_MAX_LINES + 7 }, (_, index) => (
      assistantLine([{ type: 'text', text: `第 ${index} 条` }])
    ));
    const { messages, dropped } = projectTranscriptLines(`${lines.join('\n')}\n`, AGENT_ID, SESSION_ID);
    expect(dropped).toBe(7);
    expect(messages).toHaveLength(PI_SUBAGENT_TRANSCRIPT_MAX_LINES);
    /**
     * 留下的是**最后**一段，但轮次号必须是**该子会话的绝对序**（丢掉 7 条助手行 ⇒ 首条保留行是
     * 第 8 轮）：wire 那条通道取的是绝对基数，两条通道按载体键（含轮次）去重 ⇒ 从 1 重排会让
     * 保留段在两条通道上键不相等、被投两遍（界面上表现为重复轮次）。
     */
    expect(messages[0]?.roundTrip).toBe(8);
  });
});

describe('转写读取：读不到时点名但不失败', () => {
  /** 真落一份转写到 `os.tmpdir()` 下的转写根（`readPiSubagentTranscript` 的根固定在那里） */
  const liveSession = `pi-transcript-test-${process.pid}`;
  const liveAgent = 'pi-transcript-test-agent';
  /** 目录由**被测的**路径公式算出来（路径公式本身另有专门用例，这里只借它定位落点） */
  const livePath = piSubagentTranscriptPath({ cwd: tmpdir(), sessionId: liveSession, agentId: liveAgent });
  if (livePath === null) throw new Error('夹具算不出转写路径');
  const liveTasks = dirname(livePath);

  afterAll(() => {
    rmSync(liveTasks, { recursive: true, force: true });
  });

  it('文件缺失：空消息 + 一条点名原因（子任务步骤的边界如实登记），一次都不抛', () => {
    const out = readPiSubagentTranscript({ cwd: tmpdir(), sessionId: liveSession, agentId: 'missing-agent' });
    expect(out.messages).toEqual([]);
    expect(out.warning).toContain('missing-agent');
    expect(out.warning).toContain('ENOENT');
  });

  it('文件在时按同一套规则读得到，且 `warning` 为 null（读到了就不落噪声）', () => {
    mkdirSync(liveTasks, { recursive: true });
    writeFileSync(
      livePath,
      `${assistantLine([{ type: 'text', text: '子任务的答复' }], {}, liveAgent)}\n`,
      'utf8',
    );
    const out = readPiSubagentTranscript({ cwd: tmpdir(), sessionId: liveSession, agentId: liveAgent });
    expect(out.warning).toBeNull();
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]?.subagentId).toBe(liveAgent);
    expect(out.messages[0]?.roundTrip).toBe(1);
  });
});
