/**
 * 技能数据层：清单 / 目录树 / 单个文件原文，三条各自一个 GET。
 *
 * 四条口径：
 *   · **清单的 key 恒定**（`/api/skills`）：它是全量快照，刷新 = 重新扫一遍磁盘；
 *   · **树与文件的 key 都带名字**：不同条目各自缓存；没有选中任何一条时（`name === null`）
 *     **不发请求**——SWR 的 key 传 null 就是这个语义，少了它，抽屉没打开也会去读第一条；
 *   · **文件的 key 还带技能内路径**（`?path=`）：一棵树里点不同文件各自缓存，点回已看过的不再发请求；
 *   · 名字与路径都必须 `encodeURIComponent`：名字域是 `[a-z0-9-]`，但这一层做编码不是应付当前域，
 *     而是让「将来放宽名字规则 / 文件名里出现 `#`、`%`」时不必回头找这条路径（不编码会被当片段丢掉或解错）。
 */
import useSWR from 'swr';
import type { SkillFileText, SkillList, SkillTree } from '@aieval/contracts';
import { getJson } from './http';

/** 清单的 cache key（与 `app/api/skills/route.ts` 一一对应） */
export const SKILLS_KEY = '/api/skills';

/** 单条技能目录树的 cache key */
export function skillTreeKey(name: string): string {
  return `${SKILLS_KEY}/${encodeURIComponent(name)}/tree`;
}

/** 单条技能里某个文件的 cache key */
export function skillFileKey(name: string, path: string): string {
  return `${SKILLS_KEY}/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`;
}

export function useSkills(): {
  list: SkillList | undefined;
  error: unknown;
  isLoading: boolean;
  /** 「重新扫描」：重新发一次 GET（实时扫描下没有「上次扫描时间」这类快照概念） */
  refresh: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<SkillList>(SKILLS_KEY, getJson);
  return {
    list: data,
    error,
    isLoading,
    // 包一层而不是直接把 mutate 透出去：契约要求 refresh 是「无参、无返回」的动作
    refresh: (): void => {
      void mutate();
    },
  };
}

export function useSkillTree(name: string | null): {
  tree: SkillTree | undefined;
  error: unknown;
  isLoading: boolean;
  /** 整棵树都列不出来时的那一次重试 */
  refresh: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<SkillTree>(name === null ? null : skillTreeKey(name), getJson);
  return {
    tree: data,
    error,
    isLoading,
    refresh: (): void => {
      void mutate();
    },
  };
}

/**
 * 读技能里某个文件的原文。`name` 或 `path` 有一个是 null 就**不发请求**——
 * 抽屉刚打开、还没点任何文件时就是这一态（那时该显示空态，不是去读 `SKILL.md`）。
 */
export function useSkillFile(
  name: string | null,
  path: string | null,
): { file: SkillFileText | undefined; error: unknown; isLoading: boolean } {
  const key = name === null || path === null ? null : skillFileKey(name, path);
  const { data, error, isLoading } = useSWR<SkillFileText>(key, getJson);
  return { file: data, error, isLoading };
}
