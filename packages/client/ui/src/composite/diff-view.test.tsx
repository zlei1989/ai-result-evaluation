/**
 * DiffView：左目录树 + 右单文件 diff（目录可折叠、目录行带子树增删汇总）。
 *
 * 截断提示是硬要求：评分模型看不到的改动必须让人知道，
 * 否则使用者会把「这一次的分」当成完整输入下的结论。
 *
 * 四条判据各自单独钉住，都是「看起来对、实际坏」的那一类：
 *   1. **目录汇总 = 子文件之和**：数字与内容对不上，人就不信这一格；
 *   2. **过滤后层级正确**：深层命中要留祖先（否则文件悬空），不命中的分支要剪掉（否则满屏空目录）；
 *   3. **逐文件惰性加载**：一个文件都没选中时一次都不取，选中哪个才取哪个——万级变更下这是不卡死的关键；
 *   4. **目录折叠**：收起后子节点真的离开 DOM。
 *
 * 注意：`Skeleton` / `Input` 会读全局 `ResizeObserver`，jsdom 没有，故本文件自己装桩
 * （见 testing/resize-observer.ts）。`IntersectionObserver` 也由本文件的桩手动触发——
 * 它现在只服务「滚到底加载下一页」的哨兵。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { RowDiffFile, RowDiffIndex } from '@aieval/contracts';
import { DiffFileContent, DiffView } from './diff-view';
import { installResizeObserverStub } from '../testing/resize-observer';

/** 可控的 IntersectionObserver 桩：把回调收集起来，由用例决定何时「进入视口」 */
const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];

class FakeIntersectionObserver {
  private readonly record: { callback: IntersectionObserverCallback; targets: Element[] };

  constructor(callback: IntersectionObserverCallback) {
    this.record = { callback, targets: [] };
    observers.push(this.record);
  }

  observe(target: Element): void {
    this.record.targets.push(target);
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/**
 * 让所有已注册的观察者都报告「目标进入视口」。
 *
 * 必须包在 `act` 里：回调会改状态，而在 `act` 之外触发的状态更新不会被 React 冲刷。
 */
function enterViewport(): void {
  act(() => {
    for (const record of observers) {
      for (const target of record.targets) {
        record.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    }
  });
}

beforeEach(() => {
  installResizeObserverStub();
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

const index: RowDiffIndex = {
  files: [
    { path: 'lib/a.ts', insertions: 1, deletions: 0, untracked: false, hasBody: true },
    { path: 'lib/b.ts', insertions: 0, deletions: 3, untracked: false, hasBody: true },
  ],
  total: 2,
  offset: 0,
  insertions: 1,
  deletions: 3,
  noBodyCount: 0,
  truncated: false,
  droppedFiles: [],
};

/** 两个根级目录 + 一个根级文件：目录汇总要与各自子文件逐条对上，手算不会错 */
const grouped: RowDiffIndex = {
  files: [
    { path: 'lib/deep/c.ts', insertions: 4, deletions: 1, untracked: false, hasBody: true },
    { path: 'lib/a.ts', insertions: 1, deletions: 0, untracked: false, hasBody: true },
    { path: 'docs/readme.md', insertions: 2, deletions: 5, untracked: false, hasBody: true },
    { path: 'root.ts', insertions: 7, deletions: 7, untracked: false, hasBody: true },
  ],
  total: 4,
  offset: 0,
  insertions: 14,
  deletions: 13,
  noBodyCount: 0,
  truncated: false,
  droppedFiles: [],
};

/** 一段真能在组件里渲染出内容的 patch（首行是段落头，与 collectDiff 的真实形态一致） */
const PATCH = [
  '### 未提交改动（工作区 vs HEAD）',
  'diff --git a/lib/a.ts b/lib/a.ts',
  '--- a/lib/a.ts',
  '+++ b/lib/a.ts',
  '@@ -1,1 +1,2 @@',
  ' const a = 1;',
  '+const b = 2;',
  '',
].join('\n');

function loadedFile(): RowDiffFile {
  return { path: 'lib/a.ts', patch: PATCH, insertions: 1, deletions: 0, binary: false };
}

/** 把 `renderFileBody` 包成 spy 的辅助：默认渲染一份受控的正文 */
function bodySpy(file: RowDiffFile | undefined = undefined, isLoading = false): (path: string) => ReactNode {
  return vi.fn((path: string) => (
    <DiffFileContent file={file} error={null} isLoading={isLoading} dark={false} />
  )) as unknown as (path: string) => ReactNode;
}

/** 点树里的一个文件（叶子名是给人看的，按 testid 定位才稳） */
function selectFile(path: string): void {
  fireEvent.click(screen.getByTestId(`diff-tree-file-${path}`));
}

describe('DiffView：目录树与计数', () => {
  it('列出目录树与全局计数（计数取自索引的全局值，不是本页合计）', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    expect(screen.getByTestId('diff-dir-lib')).toBeInTheDocument();
    expect(screen.getByTestId('diff-tree-file-lib/a.ts')).toBeInTheDocument();
    expect(screen.getByTestId('diff-tree-file-lib/b.ts')).toBeInTheDocument();
    expect(screen.getByText('共 2 个文件 · +1 −3')).toBeInTheDocument();
  });

  it('目录行的 +N −M 与它下面各文件的增删一致（目录汇总是子树之和，不是它自己那一层）', () => {
    render(<DiffView index={grouped} renderFileBody={bodySpy()} dark={false} />);

    // lib: (4+1) 新增、(1+0) 删除；docs: +2 −5
    expect(within(screen.getByTestId('diff-dir-counts-lib')).getByText('+5')).toBeInTheDocument();
    expect(within(screen.getByTestId('diff-dir-counts-lib')).getByText('−1')).toBeInTheDocument();
    expect(within(screen.getByTestId('diff-dir-counts-docs')).getByText('+2')).toBeInTheDocument();
    expect(within(screen.getByTestId('diff-dir-counts-docs')).getByText('−5')).toBeInTheDocument();
    // 逐条对：目录的数字就是它下面每个文件数字之和
    expect(within(screen.getByTestId('diff-file-counts-lib/deep/c.ts')).getByText('+4')).toBeInTheDocument();
    expect(within(screen.getByTestId('diff-file-counts-lib/a.ts')).getByText('+1')).toBeInTheDocument();
    // 三层：lib/deep 只有 c.ts，汇总与它一致（祖先没有被漏算或重复算）
    expect(within(screen.getByTestId('diff-dir-counts-lib/deep')).getByText('+4')).toBeInTheDocument();
    expect(within(screen.getByTestId('diff-dir-counts-lib/deep')).getByText('−1')).toBeInTheDocument();
  });

  it('目录可折叠：点一下收起，子文件离开 DOM', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    const trigger = screen.getByTestId('diff-dir-lib');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('diff-tree-file-lib/a.ts')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByTestId('diff-tree-file-lib/a.ts')).toBeInTheDocument();
  });

  it('文件行的 +N / −M 按 git 惯例上色（语义类，不是内联色值）', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    expect(
      within(screen.getByTestId('diff-file-counts-lib/a.ts')).getByText('+1').classList.contains('text-success'),
    ).toBe(true);
    expect(
      within(screen.getByTestId('diff-file-counts-lib/b.ts')).getByText('−3').classList.contains('text-destructive'),
    ).toBe(true);
  });

  it('变更行数不换行（换行会把目录行撑成两行）', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    const counts = screen.getByTestId('diff-file-counts-lib/a.ts');

    expect(counts).toHaveStyle({ whiteSpace: 'nowrap' });
  });
});

describe('DiffView：逐文件惰性加载', () => {
  it('一个文件都没选中时右侧是空态，且一次都不调 renderFileBody', () => {
    const renderFileBody = bodySpy();

    render(<DiffView index={index} renderFileBody={renderFileBody} dark={false} />);

    expect(screen.getByText('从左边选一个文件')).toBeInTheDocument();
    expect(renderFileBody).not.toHaveBeenCalled();
  });

  it('选中哪个文件才取哪个：只调当前文件的 renderFileBody，其余文件零请求', () => {
    const renderFileBody = bodySpy(undefined, true);

    render(<DiffView index={index} renderFileBody={renderFileBody} dark={false} />);
    selectFile('lib/a.ts');

    // 逐文件：这一次渲染只可能是 a.ts，绝不能顺手把 b.ts 也取了
    expect((renderFileBody as unknown as { mock: { calls: [string][] } }).mock.calls).toEqual([['lib/a.ts']]);
    // 骨架必须是**真骨架**：占位条来自新栈的 `Skeleton`（`data-slot="skeleton"`）
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('切换文件：右侧换成另一个文件，取数只针对新选中的那一个', () => {
    const renderFileBody = bodySpy();

    render(<DiffView index={index} renderFileBody={renderFileBody} dark={false} />);
    selectFile('lib/a.ts');
    selectFile('lib/b.ts');

    const calls = (renderFileBody as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(calls.at(-1)).toEqual(['lib/b.ts']);
    // a.ts 只在自己被选中时取过一次，不会因为切换而重复取
    expect(calls.filter((call) => call[0] === 'lib/a.ts')).toHaveLength(1);
  });

  it('正文就绪后渲染出来', async () => {
    render(<DiffView index={index} renderFileBody={bodySpy(loadedFile())} dark={false} />);
    selectFile('lib/a.ts');

    // diff 组件的 diff 计算在 componentDidMount 里是**异步**的（首帧渲染的是一个空 tbody），
    // 故必须等它，不能同步断言。
    // 也不能用 `getByText(/const b = 2;/)`：开了语法高亮之后这一行被拆进多个 <span>，
    // 文本匹配取不到跨元素的字符串。改为断言「确实出现了一条插入行，且它的文字是新内容」。
    const inserted = await waitFor(() => {
      const node = document.querySelector('[data-testid="diff-file-body-lib/a.ts"] ins');
      if (node === null) throw new Error('插入行还没渲染出来');
      return node;
    });

    expect(inserted.textContent).toContain('const b = 2;');
  });

  it('右侧标题给完整路径（树里只有叶子名，同名文件靠这一格分辨），且走省略号、不裹 Tag', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);
    selectFile('lib/a.ts');

    const title = screen.getByTestId('diff-file-title-lib/a.ts');
    // 树里的叶子名是 `a.ts`，右侧必须能看全 `lib/a.ts`
    expect(within(title).getByText('lib/a.ts')).toBeInTheDocument();
    expect(title.querySelector('[data-slot="badge"]')).toBeNull();
    expect(title.querySelector('.truncate[title]')).not.toBeNull();
  });

  it('hasBody=false 的文件选中后明说「未包含在本轮评分输入中」，且不取数', () => {
    const dropped: RowDiffIndex = {
      ...index,
      files: [{ path: 'lib/big.ts', insertions: 9, deletions: 9, untracked: false, hasBody: false }],
      total: 1,
      noBodyCount: 1,
      truncated: true,
      droppedFiles: ['lib/big.ts'],
    };
    const renderFileBody = bodySpy();

    render(<DiffView index={dropped} renderFileBody={renderFileBody} dark={false} />);
    selectFile('lib/big.ts');

    expect(screen.getByText(/未包含在本次评分输入中/)).toBeInTheDocument();
    // 被丢弃的文件不该触发取数（服务端对它抛 409，请求了也只是白跑一趟）
    expect(renderFileBody).not.toHaveBeenCalled();
  });
});

describe('DiffView：按路径过滤后的层级', () => {
  const nested: RowDiffIndex = {
    files: [
      { path: 'lib/deep/target.ts', insertions: 4, deletions: 1, untracked: false, hasBody: true },
      { path: 'lib/other.ts', insertions: 1, deletions: 0, untracked: false, hasBody: true },
      { path: 'docs/readme.md', insertions: 2, deletions: 5, untracked: false, hasBody: true },
      { path: 'root.ts', insertions: 7, deletions: 7, untracked: false, hasBody: true },
    ],
    total: 4,
    offset: 0,
    insertions: 14,
    deletions: 13,
    noBodyCount: 0,
    truncated: false,
    droppedFiles: [],
  };

  function filterBy(keyword: string): void {
    fireEvent.change(screen.getByLabelText('按路径过滤'), { target: { value: keyword } });
  }

  it('命中深层文件时祖先目录仍在，且没有空目录残留', () => {
    render(<DiffView index={nested} renderFileBody={bodySpy()} dark={false} />);

    filterBy('target');

    // 祖先链 lib → lib/deep 必须在场，否则 target.ts 悬空、看不出它在哪一层
    expect(screen.getByTestId('diff-dir-lib')).toBeInTheDocument();
    expect(screen.getByTestId('diff-dir-lib/deep')).toBeInTheDocument();
    expect(screen.getByTestId('diff-tree-file-lib/deep/target.ts')).toBeInTheDocument();

    // 一个都没命中的分支整枝剪掉：docs 与 root.ts 不该留下空壳
    expect(screen.queryByTestId('diff-dir-docs')).toBeNull();
    expect(screen.queryByTestId('diff-tree-file-root.ts')).toBeNull();
    expect(screen.queryByTestId('diff-tree-file-lib/other.ts')).toBeNull();
  });

  it('过滤后目录汇总跟着剩余子树重算（被剪掉的文件不算进祖先）', () => {
    render(<DiffView index={nested} renderFileBody={bodySpy()} dark={false} />);

    filterBy('target');

    // lib 只剩 target.ts：+4 −1（不是过滤前的 +5 −1）
    expect(within(screen.getByTestId('diff-dir-counts-lib')).getByText('+4')).toBeInTheDocument();
    expect(within(screen.getByTestId('diff-dir-counts-lib')).getByText('−1')).toBeInTheDocument();
  });

  it('说清过滤只作用于已加载的那些文件（不让人以为服务端搜了全部）', () => {
    render(<DiffView index={nested} renderFileBody={bodySpy()} dark={false} />);

    filterBy('target');

    expect(screen.getByText(/仅在已加载的 4 个文件里过滤/)).toBeInTheDocument();
  });

  it('一个都不匹配时给空态而不是一棵空树', () => {
    render(<DiffView index={nested} renderFileBody={bodySpy()} dark={false} />);

    filterBy('nope');

    expect(screen.getByText('没有匹配项')).toBeInTheDocument();
  });
});

describe('DiffView：截断与空态', () => {
  it('被截断时给出「评分模型看不到」的提示与被丢弃文件清单', () => {
    render(
      <DiffView
        index={{ ...index, truncated: true, droppedFiles: ['lib/c.ts', 'lib/d.ts'], noBodyCount: 2 }}
        renderFileBody={bodySpy()}
        dark={false}
      />,
    );

    expect(screen.getByText(/变更已按体积上限截断：2 个文件未包含，评分模型看不到它们/)).toBeInTheDocument();
    expect(screen.getByText('被丢弃的文件：lib/c.ts、lib/d.ts')).toBeInTheDocument();
  });

  it('真实报错文案要说「评分模型看不到」——只说「已截断」会让人以为只是界面没显示全', () => {
    render(
      <DiffView
        index={{ ...index, truncated: true, droppedFiles: ['lib/c.ts'], noBodyCount: 1 }}
        renderFileBody={bodySpy()}
        dark={false}
      />,
    );

    expect(screen.getByText(/评分模型看不到它们/)).toBeInTheDocument();
  });

  it('没有变更时给空态而不是一张空列表', () => {
    render(
      <DiffView
        index={{ ...index, files: [], total: 0, insertions: 0, deletions: 0 }}
        renderFileBody={bodySpy()}
        dark={false}
      />,
    );

    expect(screen.getByText('没有代码变更')).toBeInTheDocument();
  });

  it('二进制文件选中后不给 diff 视图，给一句说明（渲染出来会是一片空白）', () => {
    render(
      <DiffView
        index={{
          ...index,
          files: [{ path: 'img.png', insertions: 0, deletions: 0, untracked: false, hasBody: true }],
          total: 1,
        }}
        renderFileBody={() => (
          <DiffFileContent
            file={{ path: 'img.png', patch: 'Binary files differ', insertions: 0, deletions: 0, binary: true }}
            error={null}
            isLoading={false}
            dark={false}
          />
        )}
        dark={false}
      />,
    );
    selectFile('img.png');

    expect(screen.getByText(/二进制文件/)).toBeInTheDocument();
  });

  it('索引还没回来时给加载态，而不是空态（否则会先说「没有改动」再跳出内容）', () => {
    render(<DiffView index={undefined} renderFileBody={bodySpy()} dark={false} />);

    expect(screen.getByText('正在读取变更…')).toBeInTheDocument();
    expect(screen.queryByText('没有代码改动')).not.toBeInTheDocument();
  });
});

describe('DiffView：滚动与分页', () => {
  it('diff 正文不自带限高/自滚：右栏是唯一那条滚动容器', () => {
    render(<DiffView index={index} renderFileBody={bodySpy(loadedFile())} dark={false} />);
    selectFile('lib/a.ts');

    // 正文容器只给上下留白，一旦有人加回 `maxHeight + overflow:auto`，抽屉里就会出现第二条滚动条
    expect(screen.getByTestId('diff-file-body-lib/a.ts')).not.toHaveStyle({ overflow: 'auto' });
    expect(screen.getByTestId('diff-file-pane')).toHaveStyle({ overflow: 'auto' });
  });

  /**
   * 分页：**漏了它，「第 31 个之后的文件永远看不到」会溜过全部测试**。
   * 哨兵存在 + `onLoadMore` 被真的调到，两件事必须一起钉。
   */
  it('还有更多文件时挂哨兵，滚到底（哨兵进入视口）会调 onLoadMore', () => {
    const onLoadMore = vi.fn();
    const many: RowDiffIndex = {
      ...index,
      total: 45,
      files: Array.from({ length: 30 }, (_, i) => ({
        path: `f${i}.ts`,
        insertions: 1,
        deletions: 0,
        untracked: false,
        hasBody: true,
      })),
    };

    render(<DiffView index={many} renderFileBody={bodySpy()} dark={false} onLoadMore={onLoadMore} />);
    expect(onLoadMore).not.toHaveBeenCalled();

    enterViewport();

    expect(onLoadMore).toHaveBeenCalled();
  });

  it('已经加载完（files 数 = total）就不挂哨兵，不会再多请求一页', () => {
    const onLoadMore = vi.fn();

    // index 里 total=2 且 files 就是 2 条
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} onLoadMore={onLoadMore} />);
    enterViewport();

    expect(onLoadMore).not.toHaveBeenCalled();
  });
});
