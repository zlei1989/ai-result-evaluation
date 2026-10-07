'use client';

/**
 * 「现在」的秒级心跳：给运行中的耗时走秒表用。
 *
 * 为什么必须本地走：行结束之前快照里的 `durationMs` 是 null（编排层每 5s 才回写一次，且只作兜底），
 * 而「这一行已经跑了多久」在界面上应当是连续的——否则使用者看到的是一个 5 秒跳一次的数字，
 * 或者干脆是「未采集」。
 *
 * 两个边界：
 *   · `active === false`（终态、或拿不到开始时刻）时**不挂定时器**：详情页可能同时挂着十几个候选卡片，
 *     让每一个都每秒重渲染整页是纯粹的浪费，而终态的耗时是结算值、本来就不该再涨；
 *   · 切到 `active` 的那一刻立刻取一次当前时间（否则最长要等一个间隔才更新）。
 */
import { useEffect, useState } from 'react';

/** 每秒返回一次当前时间戳（毫秒）；`active` 为 false 时不推进、也不挂定时器 */
export function useNow(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // 立刻对齐一拍：从 false 翻到 true 时（行刚开始跑）不必等满一个间隔
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}
