/**
 * CaseDetailPanel：字段回显、评分标准项（只读）、删除确认的文案与回调。
 * 重点是删除提示的两件事：**评测记录会保留**（这是用户敢按下去的依据，§4.4），
 * 以及引用数「未知」与「0」必须长得不一样（把 null 显示成 0 会让人以为删了没影响）。
 * 评分标准项那一组守的是「详情页用 `readOnly` 展示用例的评分表」：组名 / 目标 / 权重与表尾满分都在，
 * 而**增删控件一个都不渲染**（写侧只在使用例表单）；旧口径的「评分维度」行与「评分提示词」卡片
 * 已随重构删除（`judgePrompt` 连契约字段一起没了），不许再长回来。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Rubric, TestCase } from '@aieval/contracts';
import { CaseDetailPanel, type CaseDetailPanelProps } from './case-detail-panel';
import { formatDateTime } from '../base/format';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 既没有 matchMedia 也没有 ResizeObserver，而 antd 的 Descriptions 会读全局 matchMedia：
// 不打桩，挂载即抛 `TypeError: window.matchMedia is not a function`（与 ProviderTable 的用例同源）。
beforeEach(() => {
  installResizeObserverStub();
});

const COMMIT_HASH = 'abc1234def567890abc1234def567890abc12345';

/**
 * 用例的评分表（尺子的唯一真源）：详情栏那一组守卫靠它断言「逐项核对得到」。
 * 权重之和 18 就是表尾的满分——**满分不是常量 100**，它由这张表自己决定。
 */
const RUBRIC: Rubric = {
  groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }],
};

const CASE: TestCase = {
  id: 'case-1',
  title: '为网关补齐转换回归',
  repoPath: 'D:\\projects\\gateway',
  commitHash: COMMIT_HASH,
  repoBranch: null,
  taskPrompt: '为 anthropic-to-chat 补一条回归用例',
  rubric: RUBRIC,
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T12:30:00.000Z',
};

function setup(overrides: Partial<CaseDetailPanelProps> = {}): ReturnType<typeof render> {
  return render(
    <CaseDetailPanel testCase={CASE} referencedRuns={null} onEdit={vi.fn()} onDelete={vi.fn()} {...overrides} />,
  );
}

describe('CaseDetailPanel', () => {
  it('回显标题、仓库路径、完整 commit 与考题提示词', () => {
    setup();

    expect(screen.getByText(CASE.title)).toBeInTheDocument();
    expect(screen.getByText(CASE.repoPath)).toBeInTheDocument();
    // 用命名常量而不是 CASE.commitHash：契约里该字段是 `string | null`，
    // 直接传进去过不了 getByText 的 Matcher 类型（strict TS），而详情栏这条钉的是**全量** hash
    expect(screen.getByText(COMMIT_HASH)).toBeInTheDocument();
    expect(screen.getByText(CASE.taskPrompt)).toBeInTheDocument();
    // 期望值由**同一个格式化函数**算出，而不是写死 '2026-09-22 12:30'：
    // formatDateTime 按契约渲染**本地时间**（本机 UTC+8 下 12:30Z 就是 20:30），
    // 写死 UTC 值会让这条断言只在 UTC 机器上通过（format.test.ts 同样按「不依赖本机时区」写）。
    expect(screen.getByText(formatDateTime(CASE.updatedAt))).toBeInTheDocument();
  });

  it('commitHash 为 null 时显示「默认分支 HEAD」而不是空白', () => {
    setup({ testCase: { ...CASE, commitHash: null } });

    expect(screen.getByText('默认分支 HEAD')).toBeInTheDocument();
  });

  // 「评分模型」那一行是固定文案（用例上不再有评分模型这一格）：它回答的是「这个用例拿什么打分」
  // 这个必然会被问一次的问题，并且指出真正的配置在哪一节
  it('评分模型显示固定的「跟随全局默认（设置 → 评分配置）」', () => {
    setup();

    expect(screen.getByText('跟随全局默认（设置 → 评分配置）')).toBeInTheDocument();
  });

  it('引用数未知时只给语义说明（不编造一个 0）', async () => {
    setup({ referencedRuns: null });

    // 说明文字在浮层里：先打开确认框，否则「没渲染」会被误读成「内容正确」
    fireEvent.click(screen.getByTestId('case-detail-delete'));

    expect(await screen.findByText(/已完成的评测记录会保留/)).toBeInTheDocument();
    expect(screen.queryByText(/已被 \d+ 个评测引用/)).toBeNull();
  });

  it('引用数已知时把数字写进删除提示', async () => {
    setup({ referencedRuns: 3 });

    fireEvent.click(screen.getByTestId('case-detail-delete'));

    expect(await screen.findByText(/已被 3 个评测引用/)).toBeInTheDocument();
    // 第二条提示也要等：弹层里的两段文案不保证在同一帧渲染（口径同 provider-form-modal 的注释）
    expect(await screen.findByText(/评测记录会保留/)).toBeInTheDocument();
  });

  it('点「编辑」调 onEdit', () => {
    const onEdit = vi.fn();
    setup({ onEdit });

    fireEvent.click(screen.getByTestId('case-detail-edit'));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  /**
   * 远端用例：来源那一行显示的仍是**全量 URL**（详情栏是核对「这一轮测的是哪份代码」的地方，
   * 这里省略就等于没地方能看全），并多一行分支——分支决定了从远端哪条历史取起点。
   */
  it('远端用例：来源显示 URL，并多一行「分支」', () => {
    setup({ testCase: { ...CASE, repoPath: 'git@host:g/r.git', repoBranch: 'feat/x' } });

    expect(screen.getByText('git@host:g/r.git')).toBeInTheDocument();
    expect(screen.getByText('feat/x')).toBeInTheDocument();
  });

  it('本地用例：不显示分支行（旧数据的界面逐字不变）', () => {
    setup({ testCase: { ...CASE, repoBranch: null } });

    expect(screen.queryByText('分支')).not.toBeInTheDocument();
  });

  /**
   * 渲染范围：**只有考题提示词那一张卡片**走 markdown（它的原文常带标题 / 表格 / 围栏代码块）。
   * 这条守卫要求内容**留在自己的卡片里**：卡片标题栏与边框是用户读这张卡的一部分，
   * 不能被内容替换掉。
   */
  it('考题提示词卡片：markdown 被渲染，且内容仍在这张卡内', () => {
    setup({
      testCase: {
        ...CASE,
        taskPrompt: '# 任务标题\n\n| 字段 | 说明 |\n| --- | --- |\n| agent | 智能体 |\n',
      },
    });

    const heading = screen.getByRole('heading', { level: 4, name: '任务标题' });
    const card = heading.closest('.ant-card');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('考题提示词');
    expect(card?.querySelector('table')).not.toBeNull();
  });

  /**
   * 评分标准项（只读）：详情栏是用户逐项核对「这一轮拿什么打分」的地方，故组名 / 目标 / 权重
   * 与表尾满分都要在。判据走 Task 6 定下的 `data-testid` 契约与文本，不按 class 断言
   * （antd 换 token / 换主题不该让这条守卫红）。
   */
  it('评分标准项卡片：只读渲染组名、目标、权重与表尾满分', () => {
    setup();

    const card = screen.getByText('评分标准项').closest('.ant-card');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('一、生产代码');
    expect(card).toHaveTextContent('追加 agent 字段');
    /**
     * 权重那一格必须在**表格行里**断言：整张卡片找 '18' 是不够的——表尾那句「满分 18 分」也含 18，
     * 权重列整列消失时那种写法照样绿。行内还钉住引用键 A1（只读态渲染的是用例里写的那把键）。
     */
    const row = card?.querySelector('tbody tr') ?? null;
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('A1');
    expect(row).toHaveTextContent('18');
    // 满分由这张表自己决定（`rubricMaxScore` = 权重之和），不是常量 100
    expect(card).toHaveTextContent('满分 18 分 · 共 1 项');
  });

  it('评分标准项卡片是只读的：增删控件与输入框一个都不渲染', () => {
    setup();

    // 只读形态下这些控件不是「被禁用」，而是**不存在**（写侧只有用例表单那一处）
    expect(screen.queryByTestId('rubric-add-group')).toBeNull();
    expect(screen.queryByTestId('rubric-add-item-0')).toBeNull();
    expect(screen.queryByTestId('rubric-remove-item-0-0')).toBeNull();
    // 连输入框都不给：只读态摆一个「看起来能改」的格子比不摆更糟
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('旧评分口径的行与卡片都不再出现（「评分维度」行、「评分提示词」卡片）', () => {
    setup();

    // 这两个概念已随重构删除（`judgePrompt` 连契约字段一起没了）：渲染它们等于给用户看一个
    // 不存在的字段，而评分口径现在只有「评分标准项」这一份真源
    expect(screen.queryByText('评分维度')).toBeNull();
    expect(screen.queryByText('评分提示词')).toBeNull();
  });

  it('删除要走确认：确认后才调 onDelete', async () => {
    const onDelete = vi.fn();
    setup({ onDelete });

    fireEvent.click(screen.getByTestId('case-detail-delete'));
    // 只是打开确认框：此刻绝不能已经删了
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText('确认删除'));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
