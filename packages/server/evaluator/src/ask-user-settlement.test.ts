// @vitest-environment node
/**
 * 编排层那条等待上限（`waitBudgetMs`）：**与端口自己那条兜底同源，但早一步到点**。
 *
 * 为什么这两条要单独钉：端口的兜底只是「不再等这一问」，它不认识挂起表；那一问若不先收掉，
 * 快照与弹层上会一直挂着一条再也答不了的提问。三个方向的靶子：
 *   · 厂商给了预算 ⇒ 以它为准（到点由厂商自己的语义收场，我们只是先一步把表清掉）；
 *   · 厂商没给 ⇒ 用 agents 包那份缺省（**同一个常量**，两处各写一份必然漂）；
 *   · 非正数一律读成「没给」（契约明写 `0` 不许填，一个手滑的 `0` 不该让提问当场落空）。
 *
 * 本文件刻意不 import 编排层，因此不需要那三条 `vi.mock`：它测的是一个纯函数，
 * 而「真跑一行」的判据在 `orchestrator-ask-user.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ASK_USER_BUDGET_MS } from '@aieval/agents';
import { waitBudgetMs } from './ask-user-settlement';

describe('提问等待上限', () => {
  it('厂商给了预算就以它为准，且比端口那条兜底早一步到点', () => {
    // 厂商 120 s ⇒ 编排层 119 s：早的那一秒是留给「先出表、再让端口的兜底落空」的
    expect(waitBudgetMs(120_000)).toBe(119_000);
  });

  it('厂商没给（null / 缺格 / 非正数）⇒ 用 agents 包那份缺省，同样早一步', () => {
    const expected = DEFAULT_ASK_USER_BUDGET_MS - 1_000;
    expect(waitBudgetMs(null)).toBe(expected);
    expect(waitBudgetMs(0)).toBe(expected);
    expect(waitBudgetMs(-1)).toBe(expected);
    // 常量本身必须是正数：它是「没人答时最多等多久」的兜底，0 会让每一次提问当场超时
    expect(DEFAULT_ASK_USER_BUDGET_MS).toBeGreaterThan(1_000);
  });

  it('预算比提前量还小时按 0 处理（那种预算下没有人来得及答，当场收场才是事实）', () => {
    expect(waitBudgetMs(500)).toBe(0);
  });
});
