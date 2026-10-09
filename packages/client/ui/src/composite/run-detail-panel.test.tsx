/**
 * RunDetailPanel：顶部信息卡 + 串行进度 + 候选卡片列表 + 吸底操作栏。
 * 本文件钉住 spec §5.3 的界面语义：
 *   · 顶部信息卡的字段（用例标题 / 代码仓库 / 分支 / commit 全量 / 工作基目录），
 *     形态与用例详情同构：`Card` + `Descriptions`（用户口径 2026-09-28）；
 *   · 串行才有进度文案「3/6 已完成」，且零行时不能出现 NaN；
 *   · 出分后的排序与名次共用同一份判据：总分降序 → 耗时升序 → tok（输入+输出）升序，
 *     三项全同并列（同名次）、前三名带徽标；未采集的耗时/tok 按最差算；
 *   · 「开始」先 `Modal.confirm` 列出将执行的候选清单（误点一次要烧掉几十分钟）；
 *   · 「终止」走 `Popconfirm`。
 * jsdom 环境注意：Modal / Select 的浮层走 rc-resize-observer，必须自己装 ResizeObserver 桩。
 *
 * 两处与 plan 原稿的**有意偏离**（都属于「让用例真的在测它声称在测的东西」）：
 *   ① 按钮可访问名无空格：本仓两个汉字的按钮一律 `autoInsertSpace={false}`
 *      （provider-table.tsx 的文件头），故确认按钮是「开始 / 确定 / 取消」而不是「开 始 / 确 定 / 取 消」；
 *   ② 能力透传用例额外断言 `usage: false` 的文案：只断言 `cancelMidTurn` 的话，
 *      「`capabilityOf` 根本没透给卡片」这个变异体也能通过（缺省能力里 `cancelMidTurn` 恰好是 true，
 *      而 `cancelMidTurn: false` 只会让断言失败——这条把两个字段都钉住才不空转）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentKind, EvalRun } from '@aieval/contracts';
import { installResizeObserverStub } from '../testing/resize-observer';
import { RunDetailPanel, completionPercent, type RunDetailPanelProps } from './run-detail-panel';

beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const score = (totalScore: number): NonNullable<EvalRun['rows'][number]['score']> => ({
  // 逐项判定 + 满分（旧的 `dimensions: []` 已随重构删除；这里只用到 totalScore）
  judgments: [],
  totalScore,
  maxScore: 100,
  verdict: '可用',
  raw: '{}',
  judgeProviderId: 'p-1',
  judgeModelId: 'claude-opus-4-6',
  judgedAt: '2026-09-22T08:10:00.000Z',
  // 这一分是哪把尺子打的（Task 1 的必填格）：null = 纯文本通路，与夹具的默认评分方式一致
  judgeAgentKind: null,
  // 同上：强度未指定（一个强度键都没发）
  judgeEffort: null,
  // 同上：false = 只靠提示词契约拿到这一分
  structuredOutput: false,
  // 同上：评分自己的花销（2026-10-08）——面板不展示这两格
  judgeTokens: null,
  judgeDurationMs: null,
});

function makeRow(id: string, overrides: Partial<EvalRun['rows'][number]> = {}): EvalRun['rows'][number] {
  return {
    id,
    agentKind: 'claude-code',
    providerId: 'p-anthropic',
    providerName: 'Anthropic 网关',
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: `claude-opus-4-6-${id}`,
    status: 'judged',
    branch: `test/${id}`,
    workspacePath: `D:\\runs\\run-1\\rows\\${id}\\workspace`,
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false },
    score: score(60),
    error: null,
    // 这一行走过几次尝试（2026-09-27）：默认 1 次（「没重试过」那一档）
    attempts: 1,
    ...overrides,
  };
}

function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '多协议入站转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: '71e628091bf7134a6e677a58cc1e0f29b9302e6f',
    repoBranch: null,
    // 轮级评分表**快照**（必填）：评分详情抽屉读的就是它，而不是用例现取的那张表
    rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 60 }] }] },
    // 轮级状态默认取**空闲**：这是「什么都没在跑」的那一档，也是编辑 / 删除可用的那一档
    // （`hasLiveRows` 会读它，见 Task 7）。此前这里是 `'running'`——那时没有任何用例读轮级状态，
    // 值是什么都不参与断言；「有行在跑」那一档由用例自己显式 overrides 出来（判据要看得见）。
    status: 'idle',
    executionMode: 'parallel',
    // 评分方式快照（Task 1 的必填格）：这一轮走纯文本评分通路
    useAgentJudge: false,
    rows: [makeRow('w-1')],
    workspaceBase: 'D:\\runs',
    createdAt: '2026-09-22T08:00:00.000Z',
    startedAt: '2026-09-22T08:01:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

const handlers = {
  onStart: vi.fn(),
  onAbortRun: vi.fn(),
  onAbortRow: vi.fn(),
  onRescoreRow: vi.fn(),
  rescoring: false,
  onRetryRow: vi.fn(),
  retrying: false,
  onOpenLog: vi.fn(),
  onOpenDiff: vi.fn(),
  onOpenScore: vi.fn(),
  // 编辑 / 删除（2026-09-28）
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  deleting: false,
};

function renderPanel(run: EvalRun, overrides: Partial<RunDetailPanelProps> = {}): ReturnType<typeof render> {
  return render(<RunDetailPanel run={run} starting={false} aborting={false} {...handlers} {...overrides} />);
}

describe('RunDetailPanel 顶部信息卡', () => {
  it('五项都在，且是「卡片 + 描述组件」的标签形态：用例标题 / 代码仓库 / commit 全量 / 工作基目录', () => {
    renderPanel(makeRun());

    const header = within(screen.getByTestId('run-header'));
    // 标题挂在卡片头上
    expect(header.getByText('多协议入站转换')).toBeInTheDocument();
    // 字段一行一个标签：形态与用例详情同构（`Card` + `Descriptions`），不是一串用「·」连起来的文本
    expect(header.getByText('代码仓库')).toBeInTheDocument();
    expect(header.getByText('工作基目录')).toBeInTheDocument();
    expect(header.getByText('D:\\projects\\gateway')).toBeInTheDocument();
    // commit 给**全量**：详情栏是核对「这一轮测的到底是哪个提交」的地方，短哈希在这里等于没地方看全
    expect(header.getByText('71e628091bf7134a6e677a58cc1e0f29b9302e6f')).toBeInTheDocument();
    expect(header.queryByText('71e6280')).toBeNull();
    expect(header.getByText('D:\\runs')).toBeInTheDocument();
  });

  it('用例没指定 commit 时显示「默认分支 HEAD」', () => {
    renderPanel(makeRun({ commitHash: null }));

    expect(screen.getByText('默认分支 HEAD')).toBeInTheDocument();
  });

  /**
   * 远端轮次要显示分支：这一轮到底从哪条历史取起点，是核对一次评测时最先要看的两个事实之一
   * （另一个是 commit）。本地轮次（`repoBranch === null`）**整行不渲染**——旧数据的界面逐字不变。
   *
   * 断言收窄到**顶部信息卡**（`run-header`）：候选行卡片上本来就有一个「分支」标签
   * （那是每行的 `test/{rowId}` 工作分支），不收敛的话这条用例会撞上它、变成一句没有指向的断言。
   */
  it('远端轮次多一行「分支」，本地轮次整行不出现', () => {
    const { unmount } = renderPanel(makeRun({ repoBranch: 'feat/x' }));

    const remoteHeader = within(screen.getByTestId('run-header'));
    expect(remoteHeader.getByText('分支')).toBeInTheDocument();
    expect(remoteHeader.getByText('feat/x')).toBeInTheDocument();
    unmount();

    renderPanel(makeRun({ repoBranch: null }));
    const localHeader = within(screen.getByTestId('run-header'));
    expect(localHeader.queryByText('feat/x')).toBeNull();
    // 只把值藏起来（留一个空的分支行）也算「多渲染了一项」，上面那句 `queryByText` 对它是没有区分力的
    expect(localHeader.queryByText('分支')).toBeNull();
  });
});

/**
 * 跑动期的实时指标按行注入（用户口径，2026-09-26）。
 * 判据是「每一行拿**自己**的那份」：只断言「有实时值出现」的实现，
 * 把第一行的指标发给所有行也能绿——而并行跑多个候选时那正是最常见的形状（一排一模一样的数字）。
 */
describe('RunDetailPanel 的实时指标注入', () => {
  it('liveOf 按行 id 取值：两行各显示自己的实时值', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { status: 'running', tokens: null, turns: null, durationMs: null, score: null }),
          makeRow('w-2', { status: 'running', tokens: null, turns: null, durationMs: null, score: null }),
        ],
      }),
      {
        liveOf: (rowId) =>
          rowId === 'w-1'
            ? { startedAtMs: null, tokens: { input: 10, cached: 0, output: 5 }, subagentTokens: null, subagentTurns: null, turns: 3, latestText: null, candidateEnded: false, candidateEndedAtMs: null }
            : { startedAtMs: null, tokens: { input: 100, cached: 0, output: 200 }, subagentTokens: null, subagentTurns: null, turns: 8, latestText: null, candidateEnded: false, candidateEndedAtMs: null },
      },
    );

    expect(screen.getByText('tok 15')).toBeInTheDocument();
    expect(screen.getByText('轮次 3')).toBeInTheDocument();
    expect(screen.getByText('tok 300')).toBeInTheDocument();
    expect(screen.getByText('轮次 8')).toBeInTheDocument();
  });

  it('没传 liveOf 时退回快照值（不传 = 没有实时通道，不是「显示空」）', () => {
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'running', tokens: { input: 1, cached: 0, output: 2 }, turns: 4 })] }));

    expect(screen.getByText('tok 3')).toBeInTheDocument();
    expect(screen.getByText('轮次 4')).toBeInTheDocument();
  });
});

describe('RunDetailPanel 进度', () => {
  it('串行模式下给出「N/M 已完成」，分子含失败与终止的行', () => {
    renderPanel(
      makeRun({
        executionMode: 'serial',
        rows: [
          makeRow('w-1', { status: 'judged' }),
          makeRow('w-2', { status: 'failed', score: null }),
          makeRow('w-3', { status: 'canceled', score: null }),
          makeRow('w-4', { status: 'running', score: null }),
          makeRow('w-5', { status: 'pending', score: null }),
          makeRow('w-6', { status: 'pending', score: null }),
        ],
      }),
    );

    // 失败/终止也是「跑完了」：不计进去进度永远到不了 100%
    expect(screen.getByText('3/6 已完成')).toBeInTheDocument();
  });

  it('并行模式不显示串行进度', () => {
    renderPanel(makeRun({ executionMode: 'parallel' }));

    expect(screen.queryByText(/已完成/)).toBeNull();
  });

  it('零候选行时不出现 NaN', () => {
    renderPanel(makeRun({ executionMode: 'serial', rows: [] }));

    expect(screen.getByText('0/0 已完成')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
    // 条宽那一半也要钉住：`Progress` 的 percent 不进文案，只落在 aria-valuenow 上，
    // 而「零行时 percent 是 NaN」正是这条守卫要拦的东西（见 completionPercent 的单测）。
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('进度百分比是纯函数：分母为零给 0，绝不给 NaN', () => {
    expect(completionPercent(0, 0)).toBe(0);
    expect(completionPercent(0, 6)).toBe(0);
    expect(completionPercent(3, 6)).toBe(50);
    expect(completionPercent(6, 6)).toBe(100);
    expect(Number.isNaN(completionPercent(0, 0))).toBe(false);
  });
});

describe('RunDetailPanel 卡片列表', () => {
  it('出分的行按总分降序在前，前三名带徽标', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { score: score(70), modelId: 'model-70' }),
          makeRow('w-2', { score: score(92), modelId: 'model-92' }),
          makeRow('w-3', { score: score(85), modelId: 'model-85' }),
          makeRow('w-4', { score: score(60), modelId: 'model-60' }),
        ],
      }),
    );

    expect(screen.getByText('第 1 名')).toBeInTheDocument();
    expect(screen.getByText('第 2 名')).toBeInTheDocument();
    expect(screen.getByText('第 3 名')).toBeInTheDocument();
    // 第 4 名没有徽标
    expect(screen.queryByText('第 4 名')).toBeNull();
    // 第 1 名挂在最高分那张卡上
    const first = screen.getByText('第 1 名').closest('.ant-card');
    expect(first).toHaveTextContent('model-92');
  });

  it('同分同名次（并列不硬拆成 1、2 名），未出分的行排在后面', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { score: score(87), modelId: 'model-a' }),
          makeRow('w-2', { score: score(87), modelId: 'model-b' }),
          makeRow('w-3', { score: score(60), modelId: 'model-c' }),
          makeRow('w-4', { score: null, status: 'running', modelId: 'model-running' }),
        ],
      }),
    );

    expect(screen.getAllByText('第 1 名')).toHaveLength(2);
    // 两行 87 之后，60 分是第 3 名（并列占掉 1、1，下一档从 3 起）
    expect(screen.getByText('第 3 名')).toBeInTheDocument();
    expect(screen.getByText('第 3 名').closest('.ant-card')).toHaveTextContent('model-c');
  });

  it('串行模式下等待中的行被标成排队（并行模式不标）', () => {
    const { unmount } = renderPanel(
      makeRun({ executionMode: 'serial', rows: [makeRow('w-1', { status: 'pending', score: null })] }),
    );
    expect(screen.getByText('串行排队中：前一行结束后自动开始')).toBeInTheDocument();
    unmount();

    renderPanel(makeRun({ executionMode: 'parallel', rows: [makeRow('w-1', { status: 'pending', score: null })] }));
    expect(screen.queryByText('串行排队中：前一行结束后自动开始')).toBeNull();
  });

  it('把每行智能体的能力元数据透给卡片（DSH 的终止文案不同）', () => {
    const capabilityOf = vi.fn((_agentKind: AgentKind) => ({ usage: false, cancelMidTurn: false }));
    renderPanel(makeRun({ rows: [makeRow('w-1', { agentKind: 'dsh', status: 'running', score: null })] }), {
      capabilityOf,
    });

    expect(screen.getByRole('button', { name: '关闭运行时' })).toBeInTheDocument();
    // 两个字段都要断言：只断言 cancelMidTurn 的话「capabilityOf 没透给卡片」这个变异体会存活
    // （EvalRowCard 的缺省能力恰好是 cancelMidTurn: true，缺省时不报错、静默显示成「终止」）
    expect(screen.getByText('tok 不支持计量')).toBeInTheDocument();
    expect(capabilityOf).toHaveBeenCalledWith('dsh');
  });
});

/**
 * 排序与名次的判据（用户口径 2026-09-29）：**总分优先，同分比耗时，耗时再相同比谁省 tok**。
 * 每条用例各自的理由：
 *   · 判据只有**一份**——展示顺序与徽标都从它派生。「排在第 2 张却挂着第 1 名」正是两处各写
 *     一份判据的形状，故这里既断言顺序、也断言名次落在同一张卡上；
 *   · 「省 tok」比的是卡片上那个数（**输入 + 输出**，缓存读单列在缓存命中里）：故「缓存巨大、
 *     但输入+输出小」的行必须仍然胜出——这条专门拦「三项相加」的实现（它会把赢家换成输家）；
 *   · 未采集（`null`）按**最差**算：并列项上有数的一方胜出，两边都没采到才算相等。
 *     否则「没采到」会白捡一个更好的名次，而那是把「不知道」当成了「更好」。
 */
describe('RunDetailPanel 排序与名次的判据', () => {
  /** 列表里各卡片**标题上**的模型名，按 DOM 顺序——排序断言只认屏幕上真实的先后 */
  const shownModels = (): string[] =>
    [...screen.getByTestId('run-row-list').querySelectorAll('.ant-card-head-title code')].map(
      (node) => node.textContent ?? '',
    );

  /** 用量三元组：缓存读默认给 0，需要时显式传大值来验「缓存不计入 tok」 */
  const tok = (input: number, output: number, cached = 0): { input: number; cached: number; output: number } => ({
    input,
    cached,
    output,
  });

  /** 第 N 名徽标挂在哪张卡上（卡片里带模型名，故能认人） */
  const cardOfRank = (rank: number): HTMLElement | null =>
    screen.getByText(`第 ${rank} 名`).closest('.ant-card') as HTMLElement | null;

  it('总分优先：后面的决胜项再好看也翻不过分数', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', {
            score: score(90),
            durationMs: 900_000,
            tokens: tok(10_000, 10_000),
            modelId: 'high-slow-heavy',
          }),
          makeRow('w-2', {
            score: score(80),
            durationMs: 1_000,
            tokens: tok(1, 1),
            modelId: 'low-fast-light',
          }),
        ],
      }),
    );

    expect(shownModels()).toEqual(['high-slow-heavy', 'low-fast-light']);
    expect(cardOfRank(1)).toHaveTextContent('high-slow-heavy');
  });

  it('同分比耗时：耗时短的在先、拿第 1 名', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { score: score(87), durationMs: 900_000, modelId: 'slow' }),
          makeRow('w-2', { score: score(87), durationMs: 300_000, modelId: 'fast' }),
        ],
      }),
    );

    expect(shownModels()).toEqual(['fast', 'slow']);
    expect(cardOfRank(1)).toHaveTextContent('fast');
    expect(cardOfRank(2)).toHaveTextContent('slow');
  });

  it('同分同耗时比 tok：输入+输出少的在先（缓存读不计入）', () => {
    renderPanel(
      makeRun({
        rows: [
          // 缓存读给一个数量级更大的值：三项相加的实现会把它判成「更费」，从而把两张卡换个位置
          makeRow('w-1', {
            score: score(87),
            durationMs: 60_000,
            tokens: tok(1_000, 500, 0),
            modelId: 'heavy',
          }),
          makeRow('w-2', {
            score: score(87),
            durationMs: 60_000,
            tokens: tok(300, 100, 90_000),
            modelId: 'light',
          }),
        ],
      }),
    );

    expect(shownModels()).toEqual(['light', 'heavy']);
    expect(cardOfRank(1)).toHaveTextContent('light');
    expect(cardOfRank(2)).toHaveTextContent('heavy');
  });

  it('三项全同才算并列：两行同为第 1 名，下一档从第 3 名起', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { score: score(87), durationMs: 60_000, tokens: tok(10, 10), modelId: 'twin-a' }),
          makeRow('w-2', { score: score(87), durationMs: 60_000, tokens: tok(10, 10), modelId: 'twin-b' }),
          makeRow('w-3', { score: score(60), durationMs: 1_000, tokens: tok(1, 1), modelId: 'low' }),
        ],
      }),
    );

    expect(screen.getAllByText('第 1 名')).toHaveLength(2);
    expect(screen.getByText('第 3 名').closest('.ant-card')).toHaveTextContent('low');
  });

  it('耗时未采集按最差算：同分时有数的行在前、拿第 1 名', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { score: score(87), durationMs: null, modelId: 'no-duration' }),
          makeRow('w-2', { score: score(87), durationMs: 600_000, modelId: 'has-duration' }),
        ],
      }),
    );

    expect(shownModels()).toEqual(['has-duration', 'no-duration']);
    expect(cardOfRank(1)).toHaveTextContent('has-duration');
  });

  it('tok 未采集按最差算：分与耗时都相同时有数的行在前', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { score: score(87), durationMs: 60_000, tokens: null, modelId: 'no-tok' }),
          makeRow('w-2', { score: score(87), durationMs: 60_000, tokens: tok(5, 5), modelId: 'has-tok' }),
        ],
      }),
    );

    expect(shownModels()).toEqual(['has-tok', 'no-tok']);
    expect(cardOfRank(1)).toHaveTextContent('has-tok');
  });

  it('两边都没采到（耗时与 tok 都是 null）⇒ 判不出高下，并列第 1 名', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { score: score(87), modelId: 'unknown-a' }),
          makeRow('w-2', { score: score(87), modelId: 'unknown-b' }),
        ],
      }),
    );

    expect(screen.getAllByText('第 1 名')).toHaveLength(2);
    expect(screen.queryByText('第 2 名')).toBeNull();
  });
});

describe('RunDetailPanel 吸底操作栏', () => {
  // 「终止」在页面上有两个（卡片上那个与吸底栏那个，spec §5.3 有意如此），
  // 所以吸底栏的断言一律先收窄到 footer 再查——否则用例自己会撞上「找到多个」而红。
  const footer = (): ReturnType<typeof within> => within(screen.getByTestId('run-footer'));

  it('有运行中的行时「开始」禁用、「终止」可用', () => {
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'running', score: null })] }));

    expect(footer().getByRole('button', { name: '开始' })).toBeDisabled();
    expect(footer().getByRole('button', { name: '终止' })).toBeEnabled();
  });

  it('全部已评分时「开始」禁用（没有可执行的行）', () => {
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'judged' })] }));

    expect(footer().getByRole('button', { name: '开始' })).toBeDisabled();
    expect(footer().getByRole('button', { name: '终止' })).toBeDisabled();
  });

  // 确认框的浮层根节点：`.run-start-confirm` 由组件显式挂上（页面上「开始」不止一处，
  // 全局查询会撞上「找到多个」）。用例断言的是**框内**的文案与按钮。
  // 标题文案不做 `getByText` 断言：antd 的浮层会把标题同时放进可见标题与无障碍标签两个节点，
  // `getByText` 因此报「找到多个」——它**不是**缺陷，用 `waitFor` 等浮层出现即可。
  const startDialog = async (): Promise<HTMLElement> => {
    await waitFor(() => expect(document.querySelector('.run-start-confirm')).not.toBeNull());
    return document.querySelector('.run-start-confirm') as HTMLElement;
  };

  it('「开始」先弹确认框列出将执行的候选，确认后才回调', async () => {
    const onStart = vi.fn();
    renderPanel(
      makeRun({
        rows: [makeRow('w-1', { status: 'failed', score: null }), makeRow('w-2', { status: 'pending', score: null })],
      }),
      { onStart },
    );

    fireEvent.click(footer().getByRole('button', { name: '开始' }));

    // 清单必须列出「将执行什么」——误点一次要烧掉几十分钟的额度
    const dialog = await startDialog();
    expect(within(dialog).getAllByText('开始执行这一轮评测？').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('本次将执行 2 个候选：')).toBeInTheDocument();
    // 清单逐条列出候选（智能体中文名 · 模型），不是只给一个总数
    expect(within(dialog).getByText('· Claude Code · claude-opus-4-6-w-1')).toBeInTheDocument();
    expect(within(dialog).getByText('· Claude Code · claude-opus-4-6-w-2')).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();

    // 点确认框自己的「开始」（不是吸底栏那个）
    fireEvent.click(within(dialog).getByRole('button', { name: '开始' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
  });

  it('确认框里点取消不会开跑', async () => {
    const onStart = vi.fn();
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'pending', score: null })] }), { onStart });

    fireEvent.click(footer().getByRole('button', { name: '开始' }));
    fireEvent.click(within(await startDialog()).getByRole('button', { name: '取消' }));

    expect(onStart).not.toHaveBeenCalled();
  });

  it('「终止」走 Popconfirm，确认后才回调', async () => {
    const onAbortRun = vi.fn();
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'running', score: null })] }), { onAbortRun });

    fireEvent.click(footer().getByRole('button', { name: '终止' }));

    expect(await screen.findByText('终止这一轮评测？')).toBeInTheDocument();
    expect(onAbortRun).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    await waitFor(() => expect(onAbortRun).toHaveBeenCalledTimes(1));
  });

  /**
   * 吸底栏的**上下空隙一样宽**（2026-10-07 用户口径）。
   *
   * jsdom 量不出布局，所以这里钉的是**那两个值本身**：上边 8px、下边 0。
   * 下边为什么是 0：栏底到内容之间那 8px 是 `ListDetailLayout` 详情槽的 `padding` 给的
   * （`PANE_PADDING`，槽位那一侧由 `list-detail-layout.test.tsx` 用字面量 `8px` 钉住），
   * 本组件再补一个下边距就会变成 16px —— 上下当场不一样宽。
   * 真机读数（1432×721，run `78ef5b58`）：分隔线→内容 8px、内容→栏底 8px。
   * 靶子就是这两个字面量：把上边改回 0、或改成 `padding: '8px 0'`，这一条即红。
   */
  it('吸底栏只补上边距（下边那 8px 由详情槽的 padding 提供，两侧才一样宽）', () => {
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'judged' })] }));

    const bar = screen.getByTestId('run-footer');
    expect(bar.style.paddingTop).toBe('8px');
    expect(bar.style.paddingBottom).toBe('0px');
  });
});

/**
 * 行级「重新评分」的**透传**（Task 7）：判据与二次确认都在卡片自己身上（`EvalRowCard` 的用例
 * 已经钉住），本面板只负责把「哪一行」和「在途没有」交给卡片。这一条钉的正是那个 id——
 * 传错 id 的表现是「点了 A 行，重评的是 B 行」，而两行的界面在那一刻完全相同。
 *
 * ⚠️ 起点仍是「跑过一次且有产出」的行（本文件用「评分阶段失败」造这一形状，最省事）。
 * 2026-09-28 晚间口径放开之后 `judged` 的行两个按钮同样可点，这条夹具不再有「`judged` 点不动」
 * 那层顾虑；它与真实形状的差别只剩「有分 / 无分」，而本文件验的是 id 透传，与分数无关。
 */
describe('RunDetailPanel：行级重新评分的透传', () => {
  /** 该行可重评的形状：跑过、有基线、有改动（`stage: 'judge'` 只是叙述，判据不读它） */
  const judgeFailedRow = (id: string): EvalRun['rows'][number] =>
    makeRow(id, {
      status: 'failed',
      score: null,
      baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
      error: { code: 'JUDGE_PARSE_FAILED', message: '评分模型返回的不是合法 JSON', stage: 'judge' },
    });

  it('卡片上确认后把**该行**的 id 交回调用方', async () => {
    const onRescoreRow = vi.fn();
    renderPanel(makeRun({ rows: [judgeFailedRow('w-1'), judgeFailedRow('w-2')] }), { onRescoreRow });

    // 两张卡片各有一个「重新评分」：取第二个，钉住「传的是这一行的 id」而不是第一行的
    const buttons = screen.getAllByRole('button', { name: '重新评分' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));

    await waitFor(() => expect(onRescoreRow).toHaveBeenCalledWith('w-2'));
  });

  it('rescoring 为真时每张卡片的按钮都转圈（在途时不许再点第二次）', () => {
    renderPanel(makeRun({ rows: [judgeFailedRow('w-1')] }), { rescoring: true });

    const loading = [...document.querySelectorAll('button')].filter((item) =>
      item.className.includes('ant-btn-loading'),
    );
    expect(loading.map((item) => item.textContent)).toEqual(['重新评分']);
  });
});

/**
 * 「编辑 / 删除」两个入口（spec §6.1）：与用例详情逐字同形，且**不在运行中**才可用。
 * 三条各自的理由：
 *   · 两个汉字的按钮必须关掉 antd 的自动空格，否则可访问名是「编 辑」/「删 除」；
 *   · `Popconfirm` 的 `onConfirm` 必须**回交 promise**（返回 undefined 时确认框立刻关闭，
 *     用户看到「点一下没反应」，再点一次就是第二次 DELETE）；
 *   · 有行在跑时两个按钮都要禁用（服务端同一判据会抛 409，界面的置灰是提前告知）；**禁用原因**只有
 *     「编辑」那一格挂了 `Tooltip`（用例正面钉它），「删除」没有——这一条**今天没有反向守卫**，如实登记。
 */
describe('RunDetailPanel 的编辑 / 删除入口', () => {
  it('默认（空闲）时两个入口都在且可点', () => {
    const onEdit = vi.fn();
    renderPanel(makeRun(), { onEdit });

    fireEvent.click(screen.getByTestId('run-detail-edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('run-detail-delete')).toBeEnabled();
  });

  it('有行在跑时两个入口都禁用（原因在 Tooltip 里）', async () => {
    renderPanel(makeRun({ status: 'running', rows: [makeRow('w-1', { status: 'running' })] }));

    expect(screen.getByTestId('run-detail-edit')).toBeDisabled();
    expect(screen.getByTestId('run-detail-delete')).toBeDisabled();
    // 禁用不是「静默」：原因必须说得出「先终止」。Tooltip 的触发点在禁用按钮外面那层 span 上
    fireEvent.mouseEnter(screen.getByTestId('run-detail-edit').parentElement ?? document.body);
    await waitFor(() => expect(screen.getByText(/先终止/)).toBeDefined());
  });

  it('删除走 Popconfirm，确认后把在途 promise 交给它（否则确认框会提前关闭）', async () => {
    let resolveDelete: (() => void) | undefined;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    renderPanel(makeRun(), { onDelete });

    fireEvent.click(screen.getByTestId('run-detail-delete'));
    const confirm = await screen.findByRole('button', { name: '确认删除' });
    fireEvent.click(confirm);

    expect(onDelete).toHaveBeenCalledTimes(1);
    // promise 还没落定 ⇒ 确认按钮必须还在 loading（提前关闭就是「点一下没反应」那个缺陷）
    await waitFor(() => expect(confirm.className).toContain('ant-btn-loading'));
    await act(async () => { resolveDelete?.(); });
  });
});
