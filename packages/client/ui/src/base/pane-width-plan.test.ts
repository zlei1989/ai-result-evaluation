// @vitest-environment node
/**
 * 分栏宽度的纯函数：给定容器宽与偏好宽，产出**两栏各占多少像素**。
 *
 * 判据只有一条但最硬：**任何容器宽下列表栏都不低于它声明的 min**。
 * 只按「容器 - 分隔条 - 偏好」算详情栏，会把左栏挤到 88 / 16px（低于 120）；这里把
 * 「先扣掉列表栏 min，再给详情栏」写进纯函数，组件只负责把结果喂给 `Panel` 的 min/max
 * 与 `panelRef.resize()`。
 */
import { describe, expect, it } from 'vitest';
import { PANE_SEPARATOR_WIDTH, planPaneWidths } from './pane-width-plan';

/** 常态参数：评测页/用例页的默认偏好与两侧下限 */
const BASE = {
  preferred: 380,
  minList: 120,
  minDetail: 320,
  maxDetail: 900,
  separator: PANE_SEPARATOR_WIDTH,
} as const;

describe('planPaneWidths：窄窗按 min 夹紧', () => {
  it('容器 474px：列表栏保住 120px（旧算法落到 88px），详情栏让到 348px', () => {
    const plan = planPaneWidths({ ...BASE, available: 474 });
    expect(plan.list).toBe(120);
    expect(plan.detail).toBe(348);
  });

  it('容器 402px：列表栏仍保住 120px（旧算法落到 16px），详情栏让到 276px', () => {
    const plan = planPaneWidths({ ...BASE, available: 402 });
    expect(plan.list).toBe(120);
    expect(plan.detail).toBe(276);
  });

  it('容器够宽时详情栏按偏好、列表栏吃富余', () => {
    const plan = planPaneWidths({ ...BASE, available: 1000 });
    expect(plan.detail).toBe(380);
    expect(plan.list).toBe(614);
  });

  it('详情栏的下限随预算下降：两栏下限之和不能超出容器', () => {
    // 402px 时详情栏的 320px 下限放不下（120 + 320 + 6 > 402），必须让详情栏跟着让，
    // 否则 rrp 会把两栏按比例压缩，左栏又掉回 min 以下。
    expect(planPaneWidths({ ...BASE, available: 402 }).detailMin).toBe(276);
    expect(planPaneWidths({ ...BASE, available: 1000 }).detailMin).toBe(320);
  });

  it('容器还没量到（0）时按偏好给详情栏，不做夹紧', () => {
    const plan = planPaneWidths({ ...BASE, available: 0 });
    expect(plan.detail).toBe(380);
  });
});
