/**
 * SegmentDivider（`Marker` 形态）：段与段之间的**分界**。
 *
 * 守卫：
 *   · 形态是 vendored 的 `Marker`（`[data-slot="marker"]` + `[data-slot="marker-content"]`），
 *     不是一颗孤零零的徽标；
 *   · 段号与时刻都在 marker 的内容里（「第几次追问、什么时候问的」是这一行的全部信息）；
 *   · 那次追问的正文（有的话）在 marker **下面**：它是这一段的标题，不是分界线的一部分；
 *   · 正文缺失（`text === null`）时只少那一块，段号照旧（旧运行的账本里没有那条记录）；
 *   · 空的时刻（`''`）不画那一格。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SegmentDivider } from './segment-divider';

const AT = '2026-10-02T10:44:32.000Z';

describe('SegmentDivider', () => {
  it('形态是 Marker：根是 marker，段号与时刻在 marker-content 里', () => {
    const { container } = render(<SegmentDivider segment={2} at={AT} text={null} />);

    const marker = container.querySelector('[data-slot="marker"]');
    expect(marker).not.toBeNull();
    const content = marker?.querySelector('[data-slot="marker-content"]');
    expect(content).not.toBeNull();
    expect(content).toHaveTextContent('追问 ×2');
    // 时刻按本地 HH:mm:ss 画（与时间轴左槽同一口径）；不钉死具体值，只钉它落在 marker 里
    expect(content?.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
    // 段界只由 Marker 承担（上面四条结构断言即判据）；「antd 不许回来」由仓库级守卫
    // `apps/web-next/src/antd-free.test.ts` 守。
  });

  it('段号挂在根节点的 data-segment 上（时间轴/虚拟列表按段跳转要用）', () => {
    const { container } = render(<SegmentDivider segment={3} at={AT} text={null} />);

    const root = container.querySelector('[data-testid="agent-log-segment-divider"]');
    expect(root).toHaveAttribute('data-segment', '3');
  });

  it('追问正文在 marker 下面（它是这一段的标题，不是分界线的一部分）', () => {
    const { container } = render(<SegmentDivider segment={1} at={AT} text="顺便把 changelog 补上" />);

    const marker = container.querySelector<HTMLElement>('[data-slot="marker"]');
    expect(marker).not.toBeNull();
    const body = screen.getByText('顺便把 changelog 补上');
    expect(marker?.contains(body)).toBe(false);
    expect(marker!.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('正文缺失时只少那一块，段号照旧', () => {
    render(<SegmentDivider segment={4} at={AT} text={null} />);

    expect(screen.getByText('追问 ×4')).toBeInTheDocument();
  });

  it('时刻为空串时不画那一格，段号仍在', () => {
    const { container } = render(<SegmentDivider segment={5} at="" text={null} />);

    expect(screen.getByText('追问 ×5')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="marker-content"]')?.textContent).toBe('追问 ×5');
  });
});
