'use client';

/**
 * 密度上下文：把**解析后的实际明暗**（auto 已解析为 light/dark）传给 PageShell，
 * 供其选择紧凑主题的哪一份。为什么需要这层：PageShell 是 ui 包内的展示组件、不调接口，
 * 它无从知道当前明暗，只能由应用的 Providers 注入。
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { DensityMode } from './density';

const DensityContext = createContext<DensityMode>('dark');

export function DensityProvider({ mode, children }: { mode: DensityMode; children: ReactNode }): ReactNode {
  return <DensityContext.Provider value={mode}>{children}</DensityContext.Provider>;
}

/** 读当前实际明暗；无 Provider 时回落 dark（与默认主题一致） */
export function useDensityMode(): DensityMode {
  return useContext(DensityContext);
}
