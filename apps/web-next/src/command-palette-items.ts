/**
 * 命令面板的条目来源：导航 + 当前会话读到的用例 / 评测。
 *
 * **导航项只从 `NAV_ITEMS` 派生**。它是顶栏与页面共用的唯一真源，本文件是同一批条目的另一个入口，
 * 不是第二份清单——两份清单会各自漂移，症状是「顶栏有的项 ⌘K 里搜不到（或相反）」，
 * 而这种漂移没有任何运行期信号。`command-palette-items.test.ts` 用行为 + 静态两条断言守着。
 *
 * 用例 / 评测条目的标题与 URL 复用各页已有的真源（`runListTitle` / `runsPanelHref`），
 * 面板里看到的名字与点进去打开的右栏，必须与列表里那一行是同一个口径。
 */
import type { CommandPaletteGroup } from '@aieval/ui';
import type { EvalRun, TestCase } from '@aieval/contracts';
import { NAV_ITEMS } from './nav';
import { runListTitle, runsPanelHref } from './runs-view';

/** 用例列表要的那几格（只声明用到的，面板不关心其余字段） */
export type CommandCase = Pick<TestCase, 'id' | 'title' | 'repoPath' | 'repoBranch'>;

/** 评测列表要的那几格 */
export type CommandRun = Pick<EvalRun, 'id' | 'caseTitle' | 'note'>;

/**
 * 导航分组：逐项照搬 `NAV_ITEMS`（含顺序与文案），只补一个面板内唯一 id。
 * `id` 加 `nav-` 前缀是为了与用例 / 评测的 UUID 区分开，不会撞。
 */
export function navCommandGroup(): CommandPaletteGroup {
  return {
    heading: '导航',
    items: NAV_ITEMS.map((item) => ({ id: `nav-${item.key}`, label: item.label, href: item.href })),
  };
}

/**
 * 用例分组。右栏的 URL 契约与用例页一致（`?panel=detail&id=`）——面板只是替用户点那一下。
 * `hint` 给仓库（远端带分支）：用例标题常常同名，光看标题分不出是哪份代码。
 */
export function caseCommandGroup(cases: readonly CommandCase[]): CommandPaletteGroup {
  return {
    heading: '用例',
    items: cases.map((testCase) => ({
      id: `case-${testCase.id}`,
      label: testCase.title,
      href: `/cases?panel=detail&id=${encodeURIComponent(testCase.id)}`,
      hint: testCase.repoBranch === null ? testCase.repoPath : `${testCase.repoPath} @ ${testCase.repoBranch}`,
    })),
  };
}

/** 评测分组：标题与链接直接复用评测页的那两个函数（备注拼接口径、右栏 URL 都只有一份） */
export function runCommandGroup(runs: readonly CommandRun[]): CommandPaletteGroup {
  return {
    heading: '评测',
    items: runs.map((run) => ({
      id: `run-${run.id}`,
      label: runListTitle(run),
      href: runsPanelHref('detail', run.id),
      hint: run.note.trim() === '' ? undefined : run.caseTitle,
    })),
  };
}
