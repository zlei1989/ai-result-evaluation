/**
 * CapabilityNotes：能力声明的界面落点。
 *
 * 六条守卫：
 * · 按数据层给的**插入顺序**渲染、**不硬编码维度名**（塞一个 `myNewDim` 也要画出来，且名字原样）；
 * · 五档等级各有文案，**四句原因互不相同**（变异体 (t)：写成同一句就必须红）——
 * 把「这家没有」说成「我们没接」是本仓最忌讳的那类误读；
 * · `level === 'yes'` 的那一格**不显示原因**，但也不能留空；
 * · **维度格按列并排**（不是一行一格）；前提另成一张 `Descriptions`、每句占整行；
 * · `notes` 非空时逐条落进「能力前提」那一段；整块不出现 `Typography` / `Collapse`；
 * · `only` 只筛维度、不改变顺序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapabilityNotes } from './capability-notes';
import type { MessageCapabilityMap } from './types';
import { CAPABILITY_LEVEL_LABELS } from './types';
import { installResizeObserverStub } from '../../testing/resize-observer';

// `Descriptions` 要一个 jsdom 没有的 api：`matchMedia`（响应式断点）。仓库的安装助手
// 顺带补 `ResizeObserver`（与 `Descriptions` 无关，但同一入口）。
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const capability: MessageCapabilityMap = {
  thinkingText: { level: 'no', source: null, reason: 'not-supported' },
  toolInput: { level: 'yes', source: 'wire', reason: null },
  myNewDim: { level: 'off-by-adapter', source: null, reason: 'not-observed' },
};

/** 真实的五维声明：用来钉版式（五格两行摆完，再让前提整行接在后面） */
const FIVE_DIMS: MessageCapabilityMap = {
  thinkingText: { level: 'yes', source: 'wire', reason: null },
  toolInput: { level: 'yes', source: 'wire', reason: null },
  toolResult: { level: 'not-projected-by-vendor', source: null, reason: 'not-exposed' },
  subagent: { level: 'off-by-adapter', source: null, reason: 'not-observed' },
  streamingDelta: { level: 'unverified', source: null, reason: 'unverified' },
};

describe('CapabilityNotes', () => {
  it('按插入顺序渲染，未知维度原样显示', () => {
    const { container } = render(<CapabilityNotes capability={capability} notes={[]} />);

    expect([...container.querySelectorAll('.ant-descriptions-item-label')].map((label) => label.textContent)).toEqual([
      '思考文本',
      '工具入参',
      'myNewDim',
    ]);
  });

  it('四句原因互不相同（去重后仍是 4 句）', () => {
    const labels = Object.values(CAPABILITY_LEVEL_LABELS);

    expect(labels).toHaveLength(4);
    expect(new Set(labels).size).toBe(4);
  });

  it('已知维度各有中文名与原因文案', () => {
    render(
      <CapabilityNotes
        capability={{
          thinkingText: { level: 'no', source: null, reason: 'not-supported' },
          toolResult: { level: 'not-projected-by-vendor', source: null, reason: 'not-exposed' },
          subagent: { level: 'off-by-adapter', source: null, reason: 'not-observed' },
          toolInput: { level: 'unverified', source: null, reason: 'unverified' },
        }}
        notes={[]}
      />,
    );

    expect(screen.getByText('思考文本')).toBeInTheDocument();
    expect(screen.getByText(CAPABILITY_LEVEL_LABELS.no)).toBeInTheDocument();
    expect(screen.getByText(CAPABILITY_LEVEL_LABELS['not-projected-by-vendor'])).toBeInTheDocument();
    expect(screen.getByText(CAPABILITY_LEVEL_LABELS['off-by-adapter'])).toBeInTheDocument();
    expect(screen.getByText(CAPABILITY_LEVEL_LABELS.unverified)).toBeInTheDocument();
    expect(screen.getByText('工具结果')).toBeInTheDocument();
    expect(screen.getByText('子任务')).toBeInTheDocument();
    expect(screen.getByText('工具入参')).toBeInTheDocument();
  });

  it('level 为 yes 的那一格不显示原因，但也不留空', () => {
    const { container } = render(
      <CapabilityNotes capability={{ toolInput: { level: 'yes', source: 'wire', reason: null } }} notes={[]} />,
    );

    for (const reason of Object.values(CAPABILITY_LEVEL_LABELS)) {
      expect(container.textContent).not.toContain(reason);
    }
    expect(container.textContent).toContain('支持');
  });

  /**
   * 版式守卫：五格**并排**（3 + 2）；前提另成一张 `Descriptions`、每句整行。
   *
   * jsdom 的 `matchMedia` 桩对所有查询回 false ⇒ antd 的响应式列数取不到断点、回落到 3；
   * 断言的是**实际渲染出来的每个候选格数**，不是断点映射本身（映射由真机冒烟核对）。
   * 把 `column` 改回 1 时这里立刻变成「5 行各 1 格」而见红。
   */
  it('维度格并排；前提另成一张 Descriptions，每句整行（不套 Typography / Collapse）', () => {
    const { container } = render(
      <CapabilityNotes capability={FIVE_DIMS} notes={['路由 A', '关闭流式']} />,
    );

    const tables = [...container.querySelectorAll('.ant-descriptions')];
    expect(tables).toHaveLength(2);

    // 维度格：第一行 3 格、第二行 2 格——不是 5 行各 1 格
    const dimensionCandidates = [...tables[0]!.querySelectorAll('.ant-descriptions-row')];
    expect(dimensionCandidates.map((row) => row.querySelectorAll('.ant-descriptions-item').length)).toEqual([3, 2]);

    // 前提：标题走 Descriptions 的 `title`，每句前提是一整行；另成一张表 ⇒
    // 不会被维度格第二行剩下的那一格挤成窄条
    expect(tables[1]!.querySelector('.ant-descriptions-title')?.textContent).toBe(
      '能力前提（随路由 / 模型 / 开关变化）',
    );
    const noteCandidates = [...tables[1]!.querySelectorAll('.ant-descriptions-row')];
    expect(noteCandidates.map((row) => row.textContent)).toEqual(['路由 A', '关闭流式']);

    // 整块只有 Descriptions：没有折叠面板，也没有 Typography 的文本节点
    expect(container.querySelector('.ant-collapse')).toBeNull();
    expect(container.querySelector('.ant-typography')).toBeNull();
  });

  it('notes 非空时逐条显示能力前提', () => {
    render(<CapabilityNotes capability={capability} notes={['路由 A', '关闭流式']} />);

    expect(screen.getByText('能力前提（随路由 / 模型 / 开关变化）')).toBeInTheDocument();
    expect(screen.getByText('路由 A')).toBeInTheDocument();
    expect(screen.getByText('关闭流式')).toBeInTheDocument();
  });

  it('notes 为空数组时连前提那一块都不出现（无条件成立）', () => {
    const { container } = render(<CapabilityNotes capability={capability} notes={[]} />);

    expect(container.textContent).not.toContain('能力前提');
  });

  it('only 只筛维度、不改顺序', () => {
    const { container } = render(
      <CapabilityNotes capability={capability} notes={[]} only={['toolInput', 'myNewDim']} />,
    );

    expect([...container.querySelectorAll('.ant-descriptions-item-label')].map((label) => label.textContent)).toEqual([
      '工具入参',
      'myNewDim',
    ]);
  });
});
