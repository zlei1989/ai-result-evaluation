/**
 * `/dev/ui-probe` 的探针矩阵：四格的档位标注、四件与五块色板都在。
 *
 * 为什么这条用例落在 ui 包而不是 `apps/web-next`：该应用必须保留 `jsx: preserve`，
 * Vite 的 import-analysis 编译不了 `.tsx` 测试（AGENTS.md 的硬约束），于是页面那一层
 * 没有渲染测试面。页面本身只做「把 `UiProbeGrid` 摆出来」这一件事，矩阵的形状因此在
 * 包内可测：格子数与每格的 `data-theme` / `data-density`、四个件、五条语义工具类。
 *
 * 明暗的**颜色**不在这里断言：jsdom 不跑 CSS，`bg-background` 这类类名在测试里只是字符串；
 * 真机判据是切换 `html[data-theme]` 后读 `getComputedStyle`（票据 02 的验收口径）。
 * 这里守住的是「页面确实把要核的那几条接上了」——类名被换掉或格子漏掉，真机就没有可量之物。
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UiProbeGrid } from '../index';

/** 四格的档位组合，顺序即页面上的阅读顺序（两组明暗 × 两档密度） */
const EXPECTED_CELLS = [
  { theme: 'light', density: 'compact' },
  { theme: 'light', density: 'default' },
  { theme: 'dark', density: 'compact' },
  { theme: 'dark', density: 'default' },
] as const;

/** 每格都要有的五块色板：槽位 → 必须出现的语义工具类（变量接错时这一类会整条失效） */
const EXPECTED_SWATCHES = [
  { slot: 'background', className: 'bg-background' },
  { slot: 'foreground', className: 'text-foreground' },
  { slot: 'border', className: 'border-border' },
  { slot: 'primary', className: 'bg-primary' },
  { slot: 'muted-foreground', className: 'text-muted-foreground' },
] as const;

/** 取四格并断言数量，后面的用例共用（数量不对时先在这一步报红，而不是空循环成绿） */
function probeCells(container: HTMLElement): HTMLElement[] {
  const cells = [...container.querySelectorAll<HTMLElement>('[data-probe-cell]')];
  expect(cells).toHaveLength(EXPECTED_CELLS.length);
  return cells;
}

describe('UiProbeGrid（/dev/ui-probe 的四格）', () => {
  it('渲染四格，每格带对应的 data-theme / data-density', () => {
    const { container } = render(<UiProbeGrid />);
    const actual = probeCells(container).map((cell) => ({
      theme: cell.dataset.theme,
      density: cell.dataset.density,
    }));
    expect(actual).toEqual(EXPECTED_CELLS.map(({ theme, density }) => ({ theme, density })));
  });

  it('每格都把四个 vendored 件摆出来', () => {
    const { container } = render(<UiProbeGrid />);
    for (const cell of probeCells(container)) {
      for (const slot of ['button', 'card', 'badge', 'separator']) {
        expect(
          cell.querySelector(`[data-slot="${slot}"]`),
          `${cell.dataset.theme}/${cell.dataset.density} 缺 ${slot}`,
        ).not.toBeNull();
      }
    }
  });

  it('每格五块色板，且各自带着要验的那条语义工具类', () => {
    const { container } = render(<UiProbeGrid />);
    for (const cell of probeCells(container)) {
      for (const { slot, className } of EXPECTED_SWATCHES) {
        const swatch = cell.querySelector<HTMLElement>(`[data-swatch="${slot}"]`);
        expect(swatch, `${cell.dataset.theme}/${cell.dataset.density} 缺 ${slot} 色板`).not.toBeNull();
        expect(swatch?.className.split(/\s+/), `${slot} 色板没带上 ${className}`).toContain(className);
      }
    }
  });
});
