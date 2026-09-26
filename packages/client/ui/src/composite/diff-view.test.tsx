/**
 * DiffView：逐文件列表 + 吸顶标题 + 惰性加载 + 骨架 + 截断提示。
 *
 * 截断提示是硬要求（spec §5.5 第 7 步）：评分模型看不到的改动必须让人知道，
 * 否则使用者会把「这一次的分」当成完整输入下的结论。
 *
 * 注意：`Skeleton` / `Input` 会读全局 `ResizeObserver` / `matchMedia`，jsdom 都没有，
 * 故本文件自己装桩（见 testing/resize-observer.ts）。`IntersectionObserver` jsdom 也没有，
 * 由本文件的桩手动触发回调来模拟「滚进了视口」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
 * 必须包在 `act` 里：回调会 `setVisible(true)`，而在 `act` 之外触发的状态更新不会被 React 冲刷，
 * 于是 DOM 里只剩标题、正文那一段永远是空的——症状是「惰性加载看起来完全没生效」，
 * 而实际上它生效了只是没重渲染（jsdom 的 IntersectionObserver 本来就是桩）。
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

describe('DiffView', () => {
  it('列出文件与全局计数（计数取自索引的全局值，不是本页合计）', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    expect(screen.getByText('lib/a.ts')).toBeInTheDocument();
    expect(screen.getByText('lib/b.ts')).toBeInTheDocument();
    expect(screen.getByText('共 2 个文件 · +1 −3')).toBeInTheDocument();
  });

  it('正文**不**在首帧渲染：文件没进视口时一次都不调 renderFileBody（万级文件下这是不卡死的关键）', () => {
    const renderFileBody = bodySpy();

    render(<DiffView index={index} renderFileBody={renderFileBody} dark={false} />);

    expect(renderFileBody).not.toHaveBeenCalled();
  });

  it('文件进入视口后才渲染正文，加载中给骨架（空白会被误读成「这个文件没改动」）', () => {
    const renderFileBody = bodySpy(undefined, true);

    render(<DiffView index={index} renderFileBody={renderFileBody} dark={false} />);
    enterViewport();

    expect(renderFileBody).toHaveBeenCalledWith('lib/a.ts');
    // 骨架必须是**真骨架**：`Skeleton` 带 active 时会有 `.ant-skeleton` 节点。
    // 只断言 testid 会漏掉「Skeleton 根本没渲染」这一类失败
    expect(document.querySelectorAll('.ant-skeleton').length).toBeGreaterThan(0);
  });

  it('正文就绪后渲染出来', async () => {
    render(<DiffView index={index} renderFileBody={bodySpy(loadedFile())} dark={false} />);
    enterViewport();

    // diff 组件的 diff 计算在 componentDidMount 里是**异步**的（首帧渲染的是一个空 tbody），
    // 故必须等它，不能同步断言。
    // 也不能用 `getByText(/const b = 2;/)`：开了语法高亮之后这一行被拆进多个 <span>，
    // 文本匹配取不到跨元素的字符串。改为断言「确实出现了一条插入行，且它的文字是新内容」。
    const inserted = await waitFor(() => {
      const node = document.querySelector('[data-testid="diff-file-section-lib/a.ts"] ins');
      if (node === null) throw new Error('插入行还没渲染出来');
      return node;
    });

    expect(inserted.textContent).toContain('const b = 2;');
  });

  it('文件标题是 sticky 的（吸顶靠它；相对 .ant-drawer-body 这个滚动容器定位）', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    const title = screen.getByTestId('diff-file-title-lib/a.ts');

    expect(title).toHaveStyle({ position: 'sticky', top: '0px' });
  });

  it('hasBody=false 的文件明说「未包含在本轮评分输入中」，且不给加载入口', () => {
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
    enterViewport();

    expect(screen.getByText(/未包含在本轮评分输入中/)).toBeInTheDocument();
    // 被丢弃的文件不该触发取数（服务端对它抛 409，请求了也只是白跑一趟）
    expect(renderFileBody).not.toHaveBeenCalled();
  });

  it('被截断时给出「评分模型看不到」的提示与被丢弃文件清单', () => {
    render(
      <DiffView
        index={{ ...index, truncated: true, droppedFiles: ['lib/c.ts', 'lib/d.ts'], noBodyCount: 2 }}
        renderFileBody={bodySpy()}
        dark={false}
      />,
    );

    expect(screen.getByText(/diff 已按体积上限截断：2 个文件未包含，评分模型看不到它们/)).toBeInTheDocument();
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

  it('没有改动时给空态而不是一张空列表', () => {
    render(
      <DiffView
        index={{ ...index, files: [], total: 0, insertions: 0, deletions: 0 }}
        renderFileBody={bodySpy()}
        dark={false}
      />,
    );

    expect(screen.getByText('没有代码改动')).toBeInTheDocument();
  });

  it('二进制文件不给 diff 视图，给一句说明（渲染出来会是一片空白）', () => {
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
    enterViewport();

    expect(screen.getByText(/二进制文件/)).toBeInTheDocument();
  });

  it('索引还没回来时给加载态，而不是空态（否则会先说「没有改动」再跳出内容）', () => {
    render(<DiffView index={undefined} renderFileBody={bodySpy()} dark={false} />);

    expect(screen.getByText('正在读取变更…')).toBeInTheDocument();
    expect(screen.queryByText('没有代码改动')).not.toBeInTheDocument();
  });

  it('按路径过滤只作用于已加载的那些文件，并如实说明范围', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    fireEvent.change(screen.getByLabelText('按路径过滤'), { target: { value: 'b.ts' } });

    expect(screen.queryByText('lib/a.ts')).not.toBeInTheDocument();
    expect(screen.getByText('lib/b.ts')).toBeInTheDocument();
    // 说清「只过滤了已加载的 2 个」而不是让用户以为服务端搜了全部
    expect(screen.getByText(/仅在已加载的 2 个文件里过滤/)).toBeInTheDocument();
  });

  it('标题里的路径走省略号，且不再用 Tag 包裹（用户口径 2026-09-29）', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    const title = screen.getByTestId('diff-file-title-lib/a.ts');

    // Tag 有自己的边框与内边距，路径已经很长，包起来只是多占宽度
    expect(title.querySelector('.ant-tag')).toBeNull();
    // 省略号 + Tooltip 显全量是既有的 EllipsisText 能力
    expect(title.querySelector('.ant-typography-ellipsis')).not.toBeNull();
  });

  it('变更行数不换行（换行会让吸顶条忽厚忽薄）', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    const title = screen.getByTestId('diff-file-title-lib/a.ts');
    const counts = [...title.querySelectorAll('span')].find((el) => el.textContent?.includes('+1'));

    expect(counts).toBeDefined();
    expect(counts).toHaveStyle({ whiteSpace: 'nowrap' });
  });

  it('diff 正文**不**自带限高/自滚（否则抽屉里会出现右侧第二条滚动条）', () => {
    const { container } = render(
      <DiffView index={index} renderFileBody={bodySpy(loadedFile())} dark={false} />,
    );
    enterViewport();

    // 正文块只应有一个「内边距」容器，里面直接就是 diff 视图——
    // 一旦有人加回 `maxHeight + overflow:auto` 的包裹层，这里会红
    const scrollers = [...container.querySelectorAll('div')].filter((el) => {
      const style = el.getAttribute('style') ?? '';
      return /overflow:\s*(auto|scroll)/.test(style);
    });

    expect(scrollers).toHaveLength(0);
  });

  /**
   * 分页：**这条曾经缺失，导致「第 31 个之后的文件永远看不到」溜过了全部测试**
   * （code review 2026-09-29 的 Critical #1）。哨兵存在 + `onLoadMore` 被真的调到，
   * 两件事必须一起钉：只钉「传了 onLoadMore」而不钉「它会被触发」，等于没钉。
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
