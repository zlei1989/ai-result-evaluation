/**
 * TaskPanelCard：状态化清单面板。
 *
 * 七条守卫（前两条是「不自己算」的落实）：
 *   · **计数照数据层给的渲染**：夹具里 `counts` 与 `steps.length` 故意不一致
 *     （7 vs 3），UI 自己数一遍就会显示成 `1/3 完成`；
 *   · 变化摘要只给非 0 的分量（`+1 完成 · +2 新增 · −1 移除`）；
 *   · 四态 Tag：`unknown` **不显示成成功**（Tag 没有 `success` 类）；
 *   · `steps` 空数组 → 「清单为空（这家报了空表）」，不是空白面板；分母为 0 → 标题写「清单为空」；
 *   · `owner === null` **整格不显示**（这家没有「指派」这个概念）、`owner === ''` 显示「未指派」；
 *     `id === null` 时不画依赖（**不自己发号**）； * · **表格形态**（用例名见「清单是表格且表头整条隐藏」「左列任务…右对齐」
 *     与「清单不分页」三条）：两列 small `Table`、表头整条隐藏、状态列在最右且 `textAlign: 'right'`、
 *     owner 与依赖跟任务同格（不进状态列）、不分页（12 步也全在）；
 *   · `earlierCount > 0` 出「本轮另有 N 次更新」，`note` 可见。
 *
 * jsdom 环境注意：antd 的 `Table` 会 `new ResizeObserver` 并读 `matchMedia`，jsdom 两个都没有
 * ——环境缺口，不是被测代码的问题（替身与安装助手的说明见 `testing/resize-observer.ts`）。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserverStub } from '../../testing/resize-observer';
import { TaskPanelCard } from './task-panel-card';
import type { TaskPanel, TaskStep } from './types';

beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-10-02T08:00:00.000Z';

function step(overrides: Partial<TaskStep> = {}): TaskStep {
  return { id: 't1', subject: '写实现', status: 'pending', owner: null, blockedBy: null, ...overrides };
}

function panel(overrides: Partial<TaskPanel> = {}): TaskPanel {
  return {
    // 故意与 counts 不一致：UI 照 counts 渲染，自己数 steps 会得到 1/3
    steps: [
      step({ id: 't1', subject: '写实现' }),
      step({ id: 't2', subject: '跑测试', status: 'inProgress', owner: 'alice' }),
      step({ id: 't3', subject: '改文档', status: 'completed', owner: '', blockedBy: ['t1'] }),
    ],
    counts: { pending: 1, inProgress: 1, completed: 4, unknown: 1 },
    change: { completed: 1, added: 2, removed: 1 },
    note: '按评审意见调整了顺序',
    at: AT,
    result: { ok: true, raw: '{"todos":[]}', truncation: { kind: 'none' } },
    running: false,
    ...overrides,
  };
}

const props = { earlierCount: 0, open: true, onOpenChange: vi.fn(), rawOpen: false, onRawOpenChange: vi.fn() };

describe('TaskPanelCard', () => {
  it('计数照数据层给的渲染（含 unknown 的那一格，分母是四格之和）', () => {
    render(<TaskPanelCard {...props} panel={panel()} />);

    expect(screen.getByText('4/7 完成')).toBeInTheDocument();
    // UI 自己数 steps 会显示成 1/3
    expect(screen.queryByText('1/3 完成')).toBeNull();
  });

  it('变化摘要：只显示非 0 的分量', () => {
    const { unmount } = render(<TaskPanelCard {...props} panel={panel()} />);
    expect(screen.getByText('+1 完成 · +2 新增 · −1 移除')).toBeInTheDocument();
    unmount();

    render(<TaskPanelCard {...props} panel={panel({ change: { completed: 2, added: 0, removed: 0 } })} />);
    expect(screen.getByText('+2 完成')).toBeInTheDocument();
    expect(screen.queryByText(/新增/)).toBeNull();
    expect(screen.queryByText(/移除/)).toBeNull();
  });

  it('没有可比的上一张清单（change === null）时不给变化摘要', () => {
    render(<TaskPanelCard {...props} panel={panel({ change: null })} />);

    expect(screen.queryByText(/完成 ·/)).toBeNull();
  });

  it('四态 Tag 各出中文，unknown 不显示成成功', () => {
    render(
      <TaskPanelCard
        {...props}
        panel={panel({
          counts: { pending: 1, inProgress: 1, completed: 1, unknown: 4 },
          steps: [
            step({ id: 's1', subject: '一', status: 'pending' }),
            step({ id: 's2', subject: '二', status: 'inProgress' }),
            step({ id: 's3', subject: '三', status: 'completed' }),
            step({ id: 's4', subject: '四', status: 'unknown' }),
          ],
        })}
      />,
    );

    expect(screen.getByText('待办')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    const unknownTag = screen.getByText('状态未知').closest('.ant-tag');
    expect(unknownTag).not.toBeNull();
    expect(unknownTag?.className).not.toContain('success');
  });

  it('steps 为空数组时显示「清单为空（这家报了空表）」而不是空白面板', () => {
    render(<TaskPanelCard {...props} panel={panel({ steps: [] })} />);

    expect(screen.getByText('清单为空（这家报了空表）')).toBeInTheDocument();
  });

  it('分母为 0 时标题写「清单为空」，不写 0/0', () => {
    render(
      <TaskPanelCard
        {...props}
        open={false}
        panel={panel({ counts: { pending: 0, inProgress: 0, completed: 0, unknown: 0 } })}
      />,
    );

    expect(screen.getByText('清单为空')).toBeInTheDocument();
    expect(screen.queryByText('0/0 完成')).toBeNull();
  });

  it('owner 为 null 时整格不显示；owner 为空串时显示「未指派」', () => {
    // 行的判据落在 `<tr>` 上：表格化之后 `parentElement` 只是单元格里那层 Flex，
    // 状态 Tag 在**另一格**，拿它当行会把两列的关系漏掉
    const rowOf = (subject: string): HTMLElement | null => screen.getByText(subject).closest('tr');

    render(
      <TaskPanelCard
        {...props}
        panel={panel({
          steps: [step({ id: 'a', subject: '没人认领的概念都没有' }), step({ id: 'b', subject: '有概念但空着', owner: '' })],
        })}
      />,
    );

    // `null` = 这一家没有「指派」这个概念 ⇒ 这一格整个不画（整行只剩状态 Tag 那一个）
    expect(rowOf('没人认领的概念都没有')?.querySelectorAll('.ant-tag')).toHaveLength(1);
    expect(rowOf('没人认领的概念都没有')).not.toHaveTextContent('未指派');
    // `''` = 有概念但当前无人认领 ⇒ 明说
    expect(rowOf('有概念但空着')).toHaveTextContent('未指派');
  });

  it('id 为 null 时不画依赖（blockedBy 的值就是 id，不自己发号）', () => {
    render(
      <TaskPanelCard
        {...props}
        panel={panel({ steps: [step({ id: null, subject: '没有 id 的项', blockedBy: ['t1'] })] })}
      />,
    );

    expect(screen.queryByText(/依赖/)).toBeNull();
  });

  it('拿得到 id 时把依赖画出来', () => {
    render(
      <TaskPanelCard {...props} panel={panel({ steps: [step({ id: 't9', subject: '依赖项', blockedBy: ['t1', 't2'] })] })} />,
    );

    expect(screen.getByText('依赖 t1、t2')).toBeInTheDocument();
  });

  /**
   * 形态守卫：清单是**两列的 small Table**，**表头整条隐藏**。
   * jsdom 不做布局、量不了像素：这里只钉结构，真实几何在浏览器里量。
   */
  it('清单是表格且表头整条隐藏（没有列头那行）', () => {
    render(<TaskPanelCard {...props} panel={panel()} />);

    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    // rc-table 的判据是 `showHeader !== false && <Header/>`：隐藏时 `<thead>` 整个不存在，不是「空表头」
    expect(document.querySelector('.ant-table-thead')).toBeNull();
  });

  /**
   * 形态守卫：左列任务、右列状态，右列**列级右对齐**。
   * 三条各对应一个会静默退化的写法（都能被单独变异掉）：
   *   · 漏掉状态列的 `align: 'right'` ⇒ Tag 贴左，右列看着还是左列（textAlign 那一条会红）；
   *   · 两列顺序被调换 ⇒ 状态跑到最左边（「第二格是状态」那一条会红）；
   *   · owner / 依赖被挪进状态列 ⇒ 右列宽度随 Tag 长短跳动（它们留在左格那两条会红）。
   */
  it('左列任务（含 owner 与依赖）、右列状态且右对齐', () => {
    render(
      <TaskPanelCard
        {...props}
        panel={panel({
          steps: [step({ id: 't9', subject: '依赖项', status: 'inProgress', owner: 'alice', blockedBy: ['t1', 't2'] })],
        })}
      />,
    );

    const cells = Array.from(screen.getByText('依赖项').closest('tr')?.querySelectorAll('td') ?? []);
    // ⚠️ 这一条是**承重**的：把清单退回 `Listy`（或任何非表格形态）时，「没有表头」那条守卫**单独是绿的**
    // （没有 `<thead>` 它照样满足），真正拦得住退回的就是「一行两格」这件事。别把它当冗余简化掉。
    expect(cells).toHaveLength(2);
    // 任务在左：文本、owner、依赖三样同在第一格
    expect(cells[0]).toHaveTextContent('依赖项');
    expect(cells[0]).toHaveTextContent('alice');
    expect(cells[0]).toHaveTextContent('依赖 t1、t2');

    // 状态在右：右对齐是**列**的属性（antd 把它落到单元格的内联 `textAlign` 上，本仓不手写 CSS）
    const statusCell = screen.getByText('进行中').closest('td');
    expect(statusCell).toBe(cells[1]);
    expect(statusCell?.style.textAlign).toBe('right');
  });

  /**
   * 形态守卫：清单**不分页**。
   *
   * 为什么单独钉这一格：antd 的默认是 `pageSize = 10`（`table/hooks/usePagination.js` 的
   * `DEFAULT_PAGE_SIZE`，只有 `pagination === false` 才提前退出）——掉掉这一格，**11 步以上的清单
   * 只画前 10 行**外加一个分页器，而上面那两条形态守卫（无表头 / 右对齐）**照样全绿**。
   * 夹具刻意给 **12** 步：正好越过那个默认值一档（给 10 步就不再有任何区分力）。
   */
  it('清单不分页：12 步全在表里（第 12 步也没被藏起来），且没有分页器', () => {
    const steps = Array.from({ length: 12 }, (_, index) => step({ id: `s${index + 1}`, subject: `第 ${index + 1} 步` }));
    render(<TaskPanelCard {...props} panel={panel({ steps })} />);

    // 数自己标的行：`ant-table-measure-row` 是 rc-table 量列宽用的空行，不是清单项
    const rows = Array.from(document.querySelectorAll('tbody tr')).filter(
      (tr) => !tr.classList.contains('ant-table-measure-row'),
    );
    expect(rows).toHaveLength(steps.length);
    expect(screen.getByText('第 12 步')).toBeInTheDocument();
    expect(document.querySelector('.ant-pagination')).toBeNull();
  });

  it('本轮另有 N 次更新与 note 都可见', () => {
    render(<TaskPanelCard {...props} earlierCount={2} panel={panel()} />);

    expect(screen.getByText(/本轮另有 2 次更新/)).toBeInTheDocument();
    expect(screen.getByText('按评审意见调整了顺序')).toBeInTheDocument();
  });

  it('结果没到手时连「原始结果」入口都不画（标题已写过结果未采集）', () => {
    const { unmount } = render(<TaskPanelCard {...props} panel={panel()} />);
    expect(screen.getByText('原始结果')).toBeInTheDocument();
    unmount();

    render(<TaskPanelCard {...props} panel={panel({ result: null, running: false })} />);
    expect(screen.queryByText('原始结果')).toBeNull();
    expect(screen.getByText('结果未采集')).toBeInTheDocument();
  });

  /**
   * `rawOpen` 的**透传**：卡片自己不持态（L0 纪律），开合完全听调用方——
   * 这条钉住「卡片的 `rawOpen` 真的喂进了 `RawOutputPanel`」：漏了/写死 `false` 时，
   * 底部的「原始结果」就是一个点不开的按钮，而别的用例（只查入口文案在不在）**照样全绿**。
   *
   * ⚠️ 那一份原文是 JSON ⇒ 正文走 `JsonText`，被缩进格式化并切成高亮 token
   * （`{"todos":[]}` → 三行）。故判据从「整串 `getByText('{"todos":[]}')`」换成
   * 「**载荷片段 + 高亮标记**」：整串匹配在新形态下恒查不到（`getByText` 只看直接文本子节点），
   * 留着它就是一条永远绿的假守卫。穿透力的那一半（开/关两态）原样保留。
   */
  it('rawOpen 透传：为真时原文真的在抽屉里，为假时同一份原文不在 DOM', () => {
    const { unmount } = render(<TaskPanelCard {...props} rawOpen panel={panel()} />);
    expect(screen.getByTestId('raw-output-body')).toBeInTheDocument();
    // 载荷的键还在（`"todos"` 带引号 ⇒ 只可能来自那一份原文），且高亮真的落在节点上
    expect(document.body.textContent).toContain('"todos"');
    expect(document.querySelectorAll('[data-json-token]').length).toBeGreaterThan(0);
    unmount();

    render(<TaskPanelCard {...props} rawOpen={false} panel={panel()} />);
    expect(screen.getByText('原始结果')).toBeInTheDocument();
    expect(screen.queryByTestId('raw-output-body')).toBeNull();
    expect(document.body.textContent).not.toContain('"todos"');
  });
});
