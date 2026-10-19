/**
 * RowStatusTag：10 个行状态 → 徽标文案与颜色。
 * 守的是那句「状态语义必须可区分，不能合并」：把两个状态映成同一个颜色，
 * 使用者就只能逐字读才能分清，扫一眼列表看不出差别——所以颜色表要**两两不同**。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvalRowStatusSchema, ROW_STATUS_LABELS } from '@aieval/contracts';
import { ROW_STATUS_COLORS, RowStatusTag } from './row-status-tag';

describe('RowStatusTag', () => {
  it('每个状态都渲染 contracts 里的中文文案', () => {
    for (const status of EvalRowStatusSchema.options) {
      const view = render(<RowStatusTag status={status} />);
      expect(screen.getByText(ROW_STATUS_LABELS[status])).toBeInTheDocument();
      view.unmount();
    }
  });

  it('渲染的是新栈的 Badge：状态文案落在徽标自己身上', () => {
    const { container } = render(<RowStatusTag status="running" />);
    const badges = container.querySelectorAll('[data-slot="badge"]');
    expect(badges, '状态没有画成徽标').toHaveLength(1);
    expect(badges[0]).toHaveTextContent(ROW_STATUS_LABELS.running);
    // 「antd 不许回来」由仓库级守卫 `apps/web-next/src/antd-free.test.ts` 守
  });

  it('状态色落到徽标的命名类上（换主题只换变量、组件不跟改）', () => {
    const { container } = render(<RowStatusTag status="failed" />);
    const badge = container.querySelector('[data-slot="badge"]');
    expect(badge?.className).toContain(ROW_STATUS_COLORS.failed);
  });

  it('10 个状态的颜色两两不同（不许把状态合并成同色）', () => {
    const statuses = EvalRowStatusSchema.options;
    expect(Object.keys(ROW_STATUS_COLORS).sort()).toEqual([...statuses].sort());
    expect(new Set(Object.values(ROW_STATUS_COLORS)).size).toBe(statuses.length);
  });
});
