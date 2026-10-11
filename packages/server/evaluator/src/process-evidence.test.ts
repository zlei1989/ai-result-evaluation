// @vitest-environment node
/**
 * 评分阶段的「执行过程记录」证据组装（`assembleProcessEvidence`）与其预算截断
 * （`truncateRawLines`）的单测。
 *
 * 组装只做四件事：includeSteps 快照门控 → 读 events.jsonl **raw 原文**（不做事件解析）→
 * 按 provider 元数据（`metadata.needsMessagesForReasoningEvidence`）决定要不要追加 messages.jsonl
 * → 按字节预算逐行截断。读文件用真磁盘（临时目录），provider 判定用假注册表——元数据可以
 * 被改成与真实厂商相反的值，从而钉住「判定来自元数据、不是厂商名硬编码」这条口径。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rowDir, rowEventsFile, rowMessagesFile } from '@aieval/core';
import { assembleProcessEvidence, truncateRawLines } from './process-evidence';

/** 假注册表的元数据开关：键是 agentKind，值是「推理证据要不要补 messages.jsonl」 */
const agentsState = vi.hoisted(() => ({
  needsMessages: {} as Record<string, boolean>,
  getProviderCalls: 0,
}));

vi.mock('@aieval/agents', () => ({
  getProvider: (kind: string) => {
    agentsState.getProviderCalls += 1;
    return {
      metadata: { needsMessagesForReasoningEvidence: agentsState.needsMessages[kind] ?? false },
    };
  },
}));

const roots: string[] = [];
/**
 * 一个带 events.jsonl / messages.jsonl 落点的临时行目录。
 * 证据按 `rowEventsFile` / `rowMessagesFile` 的布局取（`{root}/{runId}/rows/{rowId}/`），
 * 夹具必须落在同一布局上，否则测的是「文件没放对位置」而不是组装本身。
 */
function makeRowDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'aieval-process-evidence-'));
  roots.push(root);
  const dir = rowDir(root, 'run-1', 'row-1');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return root;
}

afterAll(() => {
  // 只删本用例自己 mkdtemp 出来的目录（每个都在系统临时目录下）
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  agentsState.needsMessages = {};
  agentsState.getProviderCalls = 0;
});

/** 一条 JSON 事件行（内容与断言无关，只要求「与磁盘逐字相同」） */
const EVENT_LINE = '{"seq":1,"at":"2026-01-01T00:00:00.000Z","type":"status","status":"running"}';

describe('assembleProcessEvidence', () => {
  it('includeSteps=false 时返回空证据，且一次都不查 provider 注册表', () => {
    const root = makeRowDir({ 'events.jsonl': `${EVENT_LINE}\n` });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: false,
      agentKind: 'codex',
      budgetBytes: 262_144,
    });
    expect(evidence).toEqual({ files: [] });
    expect(agentsState.getProviderCalls).toBe(0);
  });

  it('开关开：events.jsonl 的 raw 原文整体进证据（逐字节等于磁盘原文，不做解析）', () => {
    // 内容里带「坏行」：readEvents 会把它丢掉，raw 组装必须原样保留——这是「不做事件解析」的观测点
    const raw = `${EVENT_LINE}\n不是 JSON 的一行\n{"seq":3,"type":"log","stream":"stderr","text":"缺 at 也能读"}\n`;
    const root = makeRowDir({ 'events.jsonl': raw });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'claude-code',
      budgetBytes: 262_144,
    });
    expect(evidence.files).toHaveLength(1);
    expect(evidence.files[0]).toMatchObject({
      filename: 'candidate-events.jsonl',
      truncated: false,
      absolutePath: rowEventsFile(root, 'run-1', 'row-1'),
    });
    // raw 原文逐字节一致：包括那行「不是 JSON」——解析侧会丢它，证据侧必须留它
    expect(evidence.files[0]?.content).toBe(raw);
  });

  it('候选元数据声明要补 messages（codex）时，messages.jsonl 原文追加成第二个文件', () => {
    const eventsRaw = `${EVENT_LINE}\n`;
    const messagesRaw = '{"messageId":"m1","role":"assistant","blocks":[{"type":"text","text":"思考全文"}]}\n';
    agentsState.needsMessages['codex'] = true;
    const root = makeRowDir({ 'events.jsonl': eventsRaw, 'messages.jsonl': messagesRaw });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'codex',
      budgetBytes: 262_144,
    });
    expect(evidence.files).toHaveLength(2);
    expect(evidence.files[0]?.filename).toBe('candidate-events.jsonl');
    expect(evidence.files[1]).toMatchObject({
      filename: 'candidate-messages.jsonl',
      absolutePath: rowMessagesFile(root, 'run-1', 'row-1'),
    });
    expect(evidence.files[1]?.content).toBe(messagesRaw);
  });

  /**
   * **回归守卫：判定来自 provider 元数据，不是厂商名硬编码。**
   * 把元数据拧成与真实厂商相反（claude-code 也声明要补 messages）时，组装必须照元数据走——
   * 硬编码 `agentKind === 'codex'` 的写法会让这条红（那正是本票验收要做的变异）。
   */
  it('元数据声明要补 messages 的任何一家都照补：claude-code 被拧成 true 时同样拿到两个文件', () => {
    agentsState.needsMessages['claude-code'] = true;
    const root = makeRowDir({
      'events.jsonl': `${EVENT_LINE}\n`,
      'messages.jsonl': '{"messageId":"m1","role":"assistant","blocks":[{"type":"text","text":"x"}]}\n',
    });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'claude-code',
      budgetBytes: 262_144,
    });
    expect(evidence.files).toHaveLength(2);
    expect(evidence.files[1]?.filename).toBe('candidate-messages.jsonl');
  });

  it('非 codex（元数据声明不需要补）只有 events 一个文件，即使 messages.jsonl 在盘上', () => {
    agentsState.needsMessages['claude-code'] = false;
    const root = makeRowDir({
      'events.jsonl': `${EVENT_LINE}\n`,
      'messages.jsonl': '{"messageId":"m1"}\n',
    });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'claude-code',
      budgetBytes: 262_144,
    });
    expect(evidence.files.map((file) => file.filename)).toEqual(['candidate-events.jsonl']);
  });

  it('events.jsonl 缺失时跳过它（候选没跑到产出事件），不抛错', () => {
    const root = makeRowDir({});
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'claude-code',
      budgetBytes: 262_144,
    });
    expect(evidence.files).toEqual([]);
  });

  it('codex 且 messages.jsonl 缺失时只有 events 一个文件（缺哪份就少哪份）', () => {
    agentsState.needsMessages['codex'] = true;
    const root = makeRowDir({ 'events.jsonl': `${EVENT_LINE}\n` });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'codex',
      budgetBytes: 262_144,
    });
    expect(evidence.files.map((file) => file.filename)).toEqual(['candidate-events.jsonl']);
  });

  it('已存在但为空的 events.jsonl 照常进证据（空内容也是事实），不存在才跳过', () => {
    const root = makeRowDir({ 'events.jsonl': '' });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'claude-code',
      budgetBytes: 262_144,
    });
    expect(evidence.files).toHaveLength(1);
    expect(evidence.files[0]?.content).toBe('');
    expect(evidence.files[0]?.truncated).toBe(false);
  });

  it('带 UTF-8 BOM 的原文进证据时剥掉 BOM（与事件读取侧同一条容忍口径）', () => {
    const root = makeRowDir({ 'events.jsonl': `\uFEFF${EVENT_LINE}\n` });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'claude-code',
      budgetBytes: 262_144,
    });
    expect(evidence.files[0]?.content).toBe(`${EVENT_LINE}\n`);
  });

  it('超预算时逐行截断：头尾保留、中间显著标注、总字节不超预算', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `第 ${index} 行的事件原文\n`).join('');
    const budget = 200;
    const root = makeRowDir({ 'events.jsonl': lines });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'claude-code',
      budgetBytes: budget,
    });
    const file = evidence.files[0];
    expect(file?.truncated).toBe(true);
    expect(Buffer.byteLength(file?.content ?? '', 'utf8')).toBeLessThanOrEqual(budget);
    expect(file?.content).toContain('第 0 行的事件原文'); // 头保留
    expect(file?.content).toContain('第 39 行的事件原文'); // 尾保留
    expect(file?.content).toMatch(/…（中间 \d+ 行已截断，预算 200 字节）…/); // 显著标注（含预算）
  });

  it('预算单位是字节不是字符数：全中文行按 UTF-8 字节裁，字符数装得下的内容也要截', () => {
    // 每行 100 个中文（300 字节，101 字符）× 5 行：800 字节预算只装得下头尾各 1 行（共 600 字节）；
    // 按**字符数**算的话 5 行共 505 字符 ≤ 800，会整段放行——字符口径在这里的读数是「不截断」，
    // 而字节口径必须截。断言钉的是「中间 3 行被截」，两种口径只有字节口径会给这个读数。
    const chineseLine = '中'.repeat(100);
    const raw = [chineseLine, chineseLine, chineseLine, chineseLine, chineseLine].join('\n');
    const budget = 800;
    const root = makeRowDir({ 'events.jsonl': raw });
    const evidence = assembleProcessEvidence({
      workspaceBase: root,
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'claude-code',
      budgetBytes: budget,
    });
    const content = evidence.files[0]?.content ?? '';
    expect(evidence.files[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(budget);
    expect(content.startsWith(chineseLine)).toBe(true);
    expect(content.endsWith(chineseLine)).toBe(true);
    expect(content.split(chineseLine)).toHaveLength(3); // 恰好两份：头一行 + 尾一行
    expect(content).toMatch(/…（中间 3 行已截断，预算 800 字节）…/);
  });

  it('恰好不超预算的原文不截断（边界上一字不多裁）', () => {
    const raw = `${EVENT_LINE}\n`;
    const budget = Buffer.byteLength(raw, 'utf8');
    const evidence = assembleProcessEvidence({
      workspaceBase: makeRowDir({ 'events.jsonl': raw }),
      runId: 'run-1',
      rowId: 'row-1',
      includeSteps: true,
      agentKind: 'claude-code',
      budgetBytes: budget,
    });
    expect(evidence.files[0]?.truncated).toBe(false);
    expect(evidence.files[0]?.content).toBe(raw);
  });
});

describe('truncateRawLines', () => {
  it('预算之内原样返回（逐字）', () => {
    const raw = 'a\nb\nc\n';
    expect(truncateRawLines(raw, 1024)).toEqual({ text: raw, truncated: false });
  });

  it('超预算截断时标注包含被截掉的行数与预算字节数，且头尾都保留', () => {
    // 每行 20 字节 × 10 行 = 200 字节 > 120 预算；内容预算（120 - 标注 - 2 换行）装得下头 2 尾 1
    const raw = Array.from({ length: 10 }, (_, index) => `line-${index} 事件原文\n`).join('');
    const { text, truncated } = truncateRawLines(raw, 120);
    expect(truncated).toBe(true);
    expect(text).toContain('已截断');
    expect(text).toContain('预算 120 字节');
    // 头尾交替取行：两边都保得住
    expect(text.startsWith('line-0 事件原文\n')).toBe(true);
    expect(text.endsWith('line-9 事件原文\n')).toBe(true);
    expect(text).toMatch(/…（中间 7 行已截断，预算 120 字节）…/);
  });

  it('标注自身也是输出的一部分，且输出总字节不超预算（裁尾让路）', () => {
    // 100 行、预算 80：内容预算只装得下头尾各 2 行 + 标注，总字节必须 ≤ 预算
    const raw = Array.from({ length: 100 }, (_, index) => `行 ${index}\n`).join('');
    const budget = 80;
    const { text, truncated } = truncateRawLines(raw, budget);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget);
    expect(text).toMatch(/…（中间 \d+ 行已截断，预算 80 字节）…/);
  });
});
