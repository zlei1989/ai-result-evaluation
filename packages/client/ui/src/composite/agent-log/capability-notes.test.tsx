/**
 * CapabilityNotes：能力声明的界面落点。
 *
 * 五条守卫：
 * · 按数据层给的**插入顺序**渲染、**不硬编码维度名**（塞一个 `myNewDim` 也要画出来，且名字原样）；
 * · 五档等级各有文案，**四句原因互不相同**（变异体 (t)：写成同一句就必须红）——
 * 把「这家没有」说成「我们没接」是本仓最忌讳的那类误读；
 * · `level === 'yes'` 的那一格**不显示原因**，但也不能留空；
 * · `notes` 非空时显示「能力随路由/模型变化：…」；
 * · `only` 只筛维度、不改变顺序。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CapabilityNotes } from './capability-notes';
import type { MessageCapabilityMap } from './types';
import { CAPABILITY_LEVEL_LABELS } from './types';

const capability: MessageCapabilityMap = {
  thinkingText: { level: 'no', source: null, reason: 'not-supported' },
  toolInput: { level: 'yes', source: 'wire', reason: null },
  myNewDim: { level: 'off-by-adapter', source: null, reason: 'not-observed' },
};

describe('CapabilityNotes', () => {
  it('按插入顺序渲染，未知维度原样显示', () => {
    const { container } = render(<CapabilityNotes capability={capability} notes={[]} />);

    expect([...container.querySelectorAll('.ant-tag')].map((tag) => tag.textContent)).toEqual([
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

  it('notes 非空时把前提连起来显示', () => {
    render(<CapabilityNotes capability={capability} notes={['路由 A', '关闭流式']} />);

    expect(screen.getByText('能力随路由/模型变化：路由 A、关闭流式')).toBeInTheDocument();
  });

  it('notes 为空数组时不显示那一行（无条件成立）', () => {
    const { container } = render(<CapabilityNotes capability={capability} notes={[]} />);

    expect(container.textContent).not.toContain('能力随路由/模型变化');
  });

  it('only 只筛维度、不改顺序', () => {
    const { container } = render(
      <CapabilityNotes capability={capability} notes={[]} only={['toolInput', 'myNewDim']} />,
    );

    expect([...container.querySelectorAll('.ant-tag')].map((tag) => tag.textContent)).toEqual([
      '工具入参',
      'myNewDim',
    ]);
  });
});
