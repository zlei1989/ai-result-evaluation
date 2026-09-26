/**
 * `ui` 包根（`src/index.ts`）**转出 `completionPercent` 这一个名字**的守卫。
 *
 * ⚠️ 它不是「包根出口面的枚举器」：契约 §8 那份清单由整分支终审逐个核对过，本文件不复刻它，
 * 只钉这一个曾被漏转出的名字。三条判据：① 它从**包根**可用；② 它的**行为**（`total <= 0` ⇒ 0）；
 * ③ 它与深路径那份是**同一个函数**（包根只转出，不是第二份实现）。
 *
 * 为什么需要这个文件：包根是契约 §8 认定的**出口权威**，而 p5 交付时
 * `completionPercent(done, total)` 只在 `composite/run-detail-panel.tsx` 里具名导出、
 * **没有从包根转出**——契约 §8 把它列为 `run-detail-panel.tsx` 的具名出口，并在正文里论证它
 * 「必须抽出来」（留在组件里时「零行不出现 NaN」那条守卫只能退化成间接断言，实测 M2/M7 两个
 * 变异体存活）。整分支终审 §5.1 把契约 §2–§9 的出口清单逐个在 `src/index.ts` 里核对，
 * **只差这一个名字**（终审 L1）。
 *
 * 判据刻意走**包根**而不是深路径（`./composite/run-detail-panel`）：
 * 深路径那条 import 改前就是通的，用它写守卫等于把「包根漏转出」这件事整个放过——
 * 而那正是这里要钉的东西。同理断言行为而不只断言存在：
 * 一个转出成 `() => NaN` 的实现「存在」但没用（`total <= 0` 返回 0 是契约明文口径）。
 */
import { describe, expect, it } from 'vitest';
import * as ui from './index';
import { completionPercent as deepCompletionPercent } from './composite/run-detail-panel';

describe('ui 包根转出 completionPercent', () => {
  it('从包根转出 completionPercent（契约 §8 的具名出口，终审 L1）', () => {
    expect(ui.completionPercent).toBeTypeOf('function');
  });

  it('转出的就是那个纯函数本身（行为钉住，而不只是「名字在」）', () => {
    const { completionPercent } = ui;
    // 契约 §8 的明文口径：`total <= 0` 时返回 **0**，绝不让除零的 NaN 流进界面
    expect(completionPercent(0, 0)).toBe(0);
    expect(completionPercent(3, 0)).toBe(0);
    expect(completionPercent(0, 4)).toBe(0);
    expect(completionPercent(2, 4)).toBe(50);
    expect(completionPercent(4, 4)).toBe(100);
    // 与深路径那份是**同一个函数**：包根只是转出，不是第二份实现（两份必然漂移）
    expect(completionPercent).toBe(deepCompletionPercent);
  });
});
