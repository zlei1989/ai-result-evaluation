/**
 * 技能数据层三条路径：清单（刷新 = 重新扫盘）、目录树、单个文件的原文。
 * 判据取「**发了几次请求、URL 是什么**」：这三条 hook 没有本地状态，
 * 缓存键写错时界面只是「点开没有内容」或「明明没打开抽屉却读了一个文件」，都不报错。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { SkillFileText, SkillList, SkillTree } from '@aieval/contracts';
import { SKILLS_KEY, skillFileKey, skillTreeKey, useSkillFile, useSkills, useSkillTree } from './skills';

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

const TREE: SkillTree = {
  name: 'tang-poem-meal',
  dir: '/home/u/.aieval/skills/tang-poem-meal',
  root: {
    title: 'tang-poem-meal',
    path: 'tang-poem-meal',
    isDirectory: true,
    children: [{ title: 'SKILL.md', path: 'SKILL.md', isDirectory: false, children: [], sizeBytes: 42 }],
    sizeBytes: null,
  },
  truncated: false,
};

const FILE: SkillFileText = { path: 'SKILL.md', text: '---\nname: tang-poem-meal\n---\n# 规则\n' };

/** 按 URL 分派的 fetch 桩：清单 / 目录树 / 文件原文各回各的 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    const body = url === SKILLS_KEY ? LIST : url.endsWith('/tree') ? TREE : FILE;
    return new Response(JSON.stringify(body), { status: 200 });
  });
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

describe('useSkillTree', () => {
  it('name 为 null 时一个请求都不发（抽屉没打开就不列目录）', () => {
    const fetchMock = stubFetch();

    const { result } = renderHook(() => useSkillTree(null), { wrapper });

    expect(result.current.tree).toBeUndefined();
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it('选中一条后按带名字的 key 拉树', async () => {
    const fetchMock = stubFetch();

    const { result } = renderHook(() => useSkillTree('tang-poem-meal'), { wrapper });
    await waitFor(() => expect(result.current.tree).toBeDefined());

    expect(fetchMock.mock.calls[0]?.[0]).toBe(skillTreeKey('tang-poem-meal'));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/skills/tang-poem-meal/tree');
    expect(result.current.tree?.root.children[0]?.path).toBe('SKILL.md');
  });
});

describe('useSkillFile', () => {
  it('name 或 path 有一个为 null 就一个请求都不发（选了技能还没点文件就是这一态）', () => {
    const fetchMock = stubFetch();

    const withoutSkill = renderHook(() => useSkillFile(null, null), { wrapper });
    const withoutFile = renderHook(() => useSkillFile('tang-poem-meal', null), { wrapper });

    expect(withoutSkill.result.current.file).toBeUndefined();
    expect(withoutFile.result.current.file).toBeUndefined();
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it('选中技能与文件后按「名字 + 技能内路径」的 key 拉原文', async () => {
    const fetchMock = stubFetch();

    const { result } = renderHook(() => useSkillFile('tang-poem-meal', 'SKILL.md'), { wrapper });
    await waitFor(() => expect(result.current.file).toBeDefined());

    expect(fetchMock.mock.calls[0]?.[0]).toBe(skillFileKey('tang-poem-meal', 'SKILL.md'));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/skills/tang-poem-meal/file?path=SKILL.md');
    expect(result.current.file?.text).toBe(FILE.text);
  });

  it('名字与路径里的保留字符都被编码（放宽名字域 / 文件名带 `#` 时不必回头找这条路径）', () => {
    expect(skillTreeKey('a#b')).toBe('/api/skills/a%23b/tree');
    expect(skillFileKey('a#b', 'c d.md')).toBe('/api/skills/a%23b/file?path=c%20d.md');
    expect(skillFileKey('a/b', 'c/d.md')).toBe('/api/skills/a%2Fb/file?path=c%2Fd.md');
  });
});
