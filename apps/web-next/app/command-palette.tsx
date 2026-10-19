'use client';

/**
 * 命令面板宿主：把「全站可用的 ⌘K」接到数据与路由上。
 *
 * 挂在应用根的 Provider（页面壳之外），任何路由都能唤起——找用例 / 评测不必先回列表页。
 * 面板本身（键盘、浮层、过滤、数据门）在 `@aieval/ui`；这里只负责两件事：喂来源、跳转。
 *
 * **列表来源是 hook、不是现成数组**：`GatedCommandPalette` 只在面板第一次打开过之后才挂载它，
 * 因此 `/settings`、`/dev/agent-log` 这类不碰用例 / 评测的路由，一进来不会为了「可能会按 ⌘K」
 * 预取两份列表（`useCases` / `useRuns` 在这里面，门一关就一次都不调用）。
 * 导航项走 `staticGroups`，不依赖网络：唤起的那一刻就在，列表随后补上。
 */
import { useCases, useRuns } from '@aieval/client';
import { GatedCommandPalette, type CommandPaletteGroup } from '@aieval/ui';
import { useRouter } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { caseCommandGroup, navCommandGroup, runCommandGroup } from '@/src/command-palette-items';

/** 导航分组：模块级常量（面板是常驻组件，不必每次渲染都造一份新数组） */
const STATIC_GROUPS: CommandPaletteGroup[] = [navCommandGroup()];

/**
 * 列表分组来源：只在面板第一次打开后由 `GatedCommandPalette` 调用。
 * 与列表页共用同一组 SWR 键，同屏时不会多打一次请求。
 */
function useListGroups(): CommandPaletteGroup[] {
  const { cases } = useCases();
  const { runs } = useRuns();
  return useMemo(() => [caseCommandGroup(cases ?? []), runCommandGroup(runs ?? [])], [cases, runs]);
}

export function CommandPaletteHost(): ReactNode {
  const router = useRouter();
  return (
    <GatedCommandPalette
      staticGroups={STATIC_GROUPS}
      useListGroups={useListGroups}
      onSelect={(entry) => router.push(entry.href)}
    />
  );
}
