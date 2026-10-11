/**
 * 技能清单数据层：一个 GET 拿清单，一个 GET 拿单条正文。
 *
 * 两条口径：
 *   · **清单的 key 是恒定的一格**（`/api/skills`）：它是全量快照，刷新 = 重新扫一遍磁盘；
 *   · **正文的 key 带名字**（`/api/skills/<name>`）：不同行的正文各自缓存，点回已看过的那一条不再发请求；
 *     没有选中任何一条时（`name === null`）**不发请求**——SWR 的 key 传 null 就是这个语义，
 *     少了它，抽屉没打开也会去读第一条。
 *
 * 名字必须 `encodeURIComponent`：技能名域是 `[a-z0-9-]`，这一层做编码不是应付当前域，
 * 而是让「将来放宽名字规则」时不必回头找这条路径（`#` / `%` 这类字符不编码会被当片段丢掉或解错）。
 */
import useSWR from 'swr';
import type { SkillFile, SkillList } from '@aieval/contracts';
import { getJson } from './http';

/** 清单的 cache key（与 `app/api/skills/route.ts` 一一对应） */
export const SKILLS_KEY = '/api/skills';

/** 单条正文的 cache key */
export function skillFileKey(name: string): string {
  return `${SKILLS_KEY}/${encodeURIComponent(name)}`;
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

export function useSkillFile(name: string | null): {
  file: SkillFile | undefined;
  error: unknown;
  isLoading: boolean;
} {
  const { data, error, isLoading } = useSWR<SkillFile>(name === null ? null : skillFileKey(name), getJson);
  return { file: data, error, isLoading };
}
