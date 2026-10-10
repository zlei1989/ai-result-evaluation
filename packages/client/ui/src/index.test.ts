/**
 * `ui` 包根（`src/index.ts`）**转出 `completionPercent` 这一个名字**的守卫。
 *
 * ⚠️ 它不是「包根出口面的枚举器」： 那份清单不在本文件复刻，
 * 这里只钉这一个名字。三条判据：① 它从**包根**可用；② 它的**行为**（`total <= 0` ⇒ 0）；
 * ③ 它与深路径那份是**同一个函数**（包根只转出，不是第二份实现）。
 *
 * 为什么需要这个文件：包根是认定的**出口权威**，而 `completionPercent(done, total)`
 * 很容易只留在 `composite/run-detail-panel.tsx` 里具名导出、**不从包根转出**—— 把它
 * 列为 `run-detail-panel.tsx` 的具名出口，并论证它「必须抽出来」（留在组件里时
 * 「零行不出现 NaN」那条守卫只能退化成间接断言）。
 *
 * 判据刻意走**包根**而不是深路径（`./composite/run-detail-panel`）：
 * 深路径那条 import 一直是通的，用它写守卫等于把「包根漏转出」这件事整个放过——
 * 而那正是这里要钉的东西。同理断言行为而不只断言存在：
 * 一个转出成 `() => NaN` 的实现「存在」但没用（`total <= 0` 返回 0 是契约明文口径）。
 */
import { describe, expect, it } from 'vitest';
import * as ui from './index';
import { completionPercent as deepCompletionPercent } from './composite/run-detail-panel';

describe('ui 包根转出 completionPercent', () => {
  it('从包根转出 completionPercent（具名出口）', () => {
    expect(ui.completionPercent).toBeTypeOf('function');
  });

  it('转出的就是那个纯函数本身（行为钉住，而不只是「名字在」）', () => {
    const { completionPercent } = ui;
    //  的明文口径：`total <= 0` 时返回 **0**，绝不让除零的 NaN 流进界面
    expect(completionPercent(0, 0)).toBe(0);
    expect(completionPercent(3, 0)).toBe(0);
    expect(completionPercent(0, 4)).toBe(0);
    expect(completionPercent(2, 4)).toBe(50);
    expect(completionPercent(4, 4)).toBe(100);
    // 与深路径那份是**同一个函数**：包根只是转出，不是第二份实现（两份必然漂移）
    expect(completionPercent).toBe(deepCompletionPercent);
  });
});
