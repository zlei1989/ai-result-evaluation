/**
 * 技能数据层两条路径：清单的 GET（刷新 = 重新扫盘）与单条正文的 GET（key 带名字）。
 * 判据取「**发了几次请求、URL 是什么**」：这两条 hook 没有本地状态，
 * 缓存键写错时界面只是「点开没有内容」或「明明没打开抽屉却读了一个文件」，都不报错。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { SkillFile, SkillList } from '@aieval/contracts';
import { SKILLS_KEY, skillFileKey, useSkillFile, useSkills } from './skills';

/**
 * 每个用例一份全新的 SWR 缓存：默认缓存是模块级单例，用例之间沿用同一份时第二个用例会直接命中
 * 上一个用例的数据与在飞去重项，一次 GET 都不发——「刷新真的重新扫了一次」这条验收会退化成假绿。
 */
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

const LIST: SkillList = {
  root: '/home/u/.aieval/skills',
  skills: [
    { name: 'tang-poem-meal', dir: '/home/u/.aieval/skills/tang-poem-meal', description: '推荐唐诗', ok: true, disabled: false },
  ],
  skillWarnings: [],
};

const FILE: SkillFile = { frontmatter: '---\nname: tang-poem-meal\n---', body: '# 规则\n' };

/** 按 URL 分派的 fetch 桩：清单与正文各回各的 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) =>
    new Response(JSON.stringify(url === SKILLS_KEY ? LIST : FILE), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSkills', () => {
  it('挂载后按恒定 key 拉清单，refresh 再拉一次（重新扫描的语义）', async () => {
    const fetchMock = stubFetch();

    const { result } = renderHook(() => useSkills(), { wrapper });
    await waitFor(() => expect(result.current.list).toBeDefined());

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/skills');
    expect(result.current.list?.skills[0]?.name).toBe('tang-poem-meal');

    result.current.refresh();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('useSkillFile', () => {
  it('name 为 null 时一个请求都不发（抽屉没打开就不读文件）', async () => {
    const fetchMock = stubFetch();

    const { result } = renderHook(() => useSkillFile(null), { wrapper });

    expect(result.current.file).toBeUndefined();
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it('选中一条后按带名字的 key 拉正文', async () => {
    const fetchMock = stubFetch();

    const { result } = renderHook(() => useSkillFile('tang-poem-meal'), { wrapper });
    await waitFor(() => expect(result.current.file).toBeDefined());

    expect(fetchMock.mock.calls[0]?.[0]).toBe(skillFileKey('tang-poem-meal'));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/skills/tang-poem-meal');
    expect(result.current.file?.frontmatter).toBe(FILE.frontmatter);
  });

  it('名字里的保留字符被编码（放宽名字域时不必回头找这条路径）', () => {
    expect(skillFileKey('a#b')).toBe('/api/skills/a%23b');
    expect(skillFileKey('a/b')).toBe('/api/skills/a%2Fb');
  });
});
