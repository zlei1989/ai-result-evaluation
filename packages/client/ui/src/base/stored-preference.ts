'use client';

/**
 * 宽度与显示偏好记忆（localStorage）。
 *
 * 为什么放 localStorage 而不是 URL：这些是**个人显示偏好**（怎么读界面），不是「在看什么」——
 * 同一份链接发给别人时不该把自己的栏宽偏好一起带过去。分工：URL 记「在看什么」（?panel= / ?id=），
 * localStorage 记「怎么显示」（栏宽、开关）。
 *
 * 两条硬要求：
 *   1. 读取路径**绝不抛错**——无 window（SSR）/ 存储不可用（隐私模式、禁用存储、分区隔离）/
 *      无值 / 解析失败，一律回落默认值；
 *   2. useStoredWidth **不在首帧读 localStorage**，挂载后再读。若在 useState 初始化函数里读，
 *      服务端渲染拿到 seed、客户端首次渲染拿到存量值，会产生水合不一致警告。
 */
import { useCallback, useEffect, useState } from 'react';

/** 单个偏好键在本机的读取：无 window / 存储不可用 / 无值 / 解析失败 → seed */
export function readStoredPreference<T>(key: string, seed: T, parse: (raw: string) => T | null): T {
  if (typeof window === 'undefined') return seed;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? seed : parse(raw) ?? seed;
  } catch {
    // 隐私模式 / 禁用存储 / 分区隔离：读不到就用默认值，不影响功能
    return seed;
  }
}

/** 数值偏好的解析器：非有限数视为脏值 */
function parseFiniteNumber(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 夹紧到 [min, max] 并取整：存量值可能来自旧版本的范围、也可能被手改过 */
function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 宽度偏好状态：首帧取 clamp(seed)，挂载后读出存量值并夹紧；更新即写回。
 * 写入失败（配额 / 禁用存储）不抛错——本次会话内的改动仍然生效，只是记不住。
 */
export function useStoredWidth(key: string, seed: number, min: number, max: number): [number, (next: number) => void] {
  const [width, setWidth] = useState<number>(() => clampWidth(seed, min, max));

  // 挂载后再读存量值：保证 SSR 与客户端首帧一致（否则水合不一致）
  useEffect(() => {
    const stored = readStoredPreference(key, seed, parseFiniteNumber);
    setWidth(clampWidth(stored, min, max));
  }, [key, seed, min, max]);

  const update = useCallback(
    (next: number) => {
      const clamped = clampWidth(next, min, max);
      setWidth(clamped);
      try {
        window.localStorage.setItem(key, String(clamped));
      } catch {
        // 写不进去（配额 / 禁用存储）：本次会话内的宽度仍然生效
      }
    },
    [key, min, max],
  );

  return [width, update];
}
