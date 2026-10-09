/**
 * EvalRowCard：候选卡片。版面口径来自 spec §5.3 的 ASCII 稿；
 * 五件容易被漏掉、漏掉就会误判的事各一条用例：
 *   1. 串行排队中的行要说清「为什么会等」（不是没反应）；
 *   2. diff 被截断要标出来（这一次的分是在不完整输入下得出的）；
 *   3. `cancelMidTurn === false` 的智能体，按钮文案是「关闭运行时」而不是「终止」；
 *   4. 错误要带码与原因，不能只留一个红 Tag；
 *   5. **显式关闭档写着 `off`**（2026-10-07 口径）：`off` 不是「未指定」的同义词，
 *      档位标签必须逐字写出来，浮层再用一句「关闭思考」注解它。
 *   6. **供应商信息挂在模型名上**（2026-10-07 用户口径）：标题行不再有「供应商」Tag，名字与接口
 *      地址只在悬浮模型名时浮出。「挪进浮层」与「静默删掉」在页面上长得一模一样，故两条分开钉：
 *      一条要浮层里有那句「供应商：名字（地址）」，一条要标题行上**再也找不到**那个名字。
 * 另外「没有产出时不给看改动」与「运行中才给终止」也在这里钉住。
 *
 * 按钮的可访问名一律是**无空格**的中文（本仓既有口径：两个汉字的按钮一律
 * `autoInsertSpace={false}`，见 provider-table.tsx 的文件头）——用例按无空格名查找。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { EFFORT_OFF, type EvalRow } from '@aieval/contracts';
import { EvalRowCard } from './eval-row-card';
import { installResizeObserverStub } from '../testing/resize-observer';

const row: EvalRow = {
  id: 'w-1',
  agentKind: 'claude-code',
  providerId: 'p-anthropic',
  providerName: 'Anthropic 网关',
  baseUrl: 'https://gw.example.com/anthropic',
  modelId: 'claude-opus-4-6',
  status: 'judged',
  branch: 'test/w-1',
  workspacePath: 'D:\\runs\\run-1\\rows\\w-1\\workspace',
  baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
  tokens: { input: 128_450, cached: 12_800, output: 4_200 },
  turns: 17,
  durationMs: 383_000,
  diff: { filesChanged: 3, insertions: 25, deletions: 7, truncated: false },
  score: null,
  error: null,
  // 这一行走过几次尝试（2026-09-27，契约新增）：1 = 没重试过（不显示「已重试」徽标）
  attempts: 1,
};

const handlers = {
  onAbort: vi.fn(),
  onOpenLog: vi.fn(),
  onOpenDiff: vi.fn(),
  onOpenScore: vi.fn(),
  onRescore: vi.fn(),
  onRetry: vi.fn(),
};

/**
 * 两档失败归因（2026-09-28 起 `EvalRow.error` 多了一格 `stage`）：它今天只用于**叙述**
 * （界面上不显示，也不参与任何按钮的可用性判定）。两档的行状态与错误码可以逐字相同
 * （都是 `failed` + `AGENT_FAILED`），只有这一格不同——故本文件用它们当**形状齐全**的两条夹具，
 * 而不是当「哪条路该给哪个按钮」的依据（那个依据 2026-09-28 晚间已经取消）。
 */
const judgeFailed: EvalRow['error'] = { code: 'JUDGE_PARSE_FAILED', message: '评分模型返回的不是合法 JSON', stage: 'judge' };
const agentFailed: EvalRow['error'] = { code: 'AGENT_FAILED', message: 'Codex Exec exited with code 1', stage: 'agent' };
/** 老快照：`stage` 是 2026-09-28 才加的，磁盘上已有的记录读出来是 undefined */
const legacyFailed: EvalRow['error'] = { code: 'AGENT_FAILED', message: '老记录没有失败阶段' };

// 终止走 Popconfirm ⇒ 浮层对齐要 ResizeObserver + matchMedia（jsdom 两个都没有），
// 与 provider-table / run-detail-panel 同一口径
beforeEach(() => {
  installResizeObserverStub();
});

/**
 * 按**文案**拿按钮，而不是 `getByRole('button', { name })`。
 * 为什么需要它：antd 在 `loading` 时把按钮标成忙碌态，可访问名随之算不出来，
 * 而「转圈」这条用例要的正是**在途**那一帧——按角色查会「找不到元素」，
 * 失败信息还会指向「按钮不存在」这个完全错误的方向（实测踩过）。
 */
function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent === text);
  if (button === undefined) throw new Error(`找不到文案为「${text}」的按钮`);
  return button;
}

/**
 * 悬浮之后**给浮层一个出场的机会**，再判「确实没有浮层」——所有「不给 Tooltip」的否定面都必须走这里。
 *
 * 为什么不能悬浮完就立刻查 `.ant-tooltip`：antd 的 `Tooltip` **不是同步挂载**的，鼠标进入后有
 * `mouseEnterDelay`（默认 **0.1s**）才把它推进 body 的 portal。于是「悬浮 → 同步查为 `null`」这条
 * 断言**在任何实现下都为真**：`title` 是 `undefined` 时它为真，`title` 挂着一句真原因时**它同样为真**
 * ——浮层还没到出场时间。它测的不是实现，是时序，等于没写。
 *
 * 这不是推演，是变异验证实测出来的：把 `rescoreHint` 改成**无条件**给出原因（正是 :445 那条用例声称
 * 要拦的缺陷）、或把轮次那一格的 `> 0` 判据删掉，同步断言都**照样绿**；等满一个延迟窗口再判，
 * 两条才分别变红（登记在 spec §3 的 #17 与本文件末尾那段）。
 * 本仓 `metric-line.test.tsx` 与 `ellipsis-text.test.tsx` 也各登记过同一件事（后者写明
 * 「`.ant-tooltip` 那一句单独不构成守卫」）。
 *
 * 窗口取 300ms = 默认延迟的 3 倍：够浮层落定，又不至于把 20 条用例拖慢（每条 +0.3s）。
 */
const expectNoTooltip = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(document.querySelector('.ant-tooltip')).toBeNull();
};

describe('EvalRowCard', () => {
  it('标题行是「智能体 · 模型」+ 状态 Tag，并给出分支与计量', () => {
    render(<EvalRowCard row={row} {...handlers} />);

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
    expect(screen.getByText('test/w-1')).toBeInTheDocument();
    expect(screen.getByText('tok 132,650')).toBeInTheDocument();
  });

  it('排名徽标只在传了 rank 时出现', () => {
    const { unmount } = render(<EvalRowCard row={row} rank={1} {...handlers} />);
    expect(screen.getByText('第 1 名')).toBeInTheDocument();
    unmount();

    render(<EvalRowCard row={row} {...handlers} />);
    expect(screen.queryByText(/第 \d+ 名/)).toBeNull();
  });

  it('串行排队中给出「为什么在等」', () => {
    render(<EvalRowCard row={{ ...row, status: 'pending' }} queued {...handlers} />);

    expect(screen.getByText('串行排队中：前一行结束后自动开始')).toBeInTheDocument();
  });

  it('diff 被截断时在卡片上标出来', () => {
    render(
      <EvalRowCard
        row={{ ...row, diff: { filesChanged: 3, insertions: 25, deletions: 7, truncated: true } }}
        {...handlers}
      />,
    );

    expect(screen.getByText('diff 已截断')).toBeInTheDocument();
  });

  it('不支持的计量显示「不支持计量」而不是 0', () => {
    render(
      <EvalRowCard
        row={{ ...row, tokens: null, turns: null, durationMs: null }}
        capability={{ usage: false, cancelMidTurn: true }}
        {...handlers}
      />,
    );

    expect(screen.getByText('tok 不支持计量')).toBeInTheDocument();
    expect(screen.queryByText('tok 0')).toBeNull();
  });

  it('cancelMidTurn 为 false 的智能体，按钮文案是「关闭运行时」', () => {
    const { unmount } = render(
      <EvalRowCard
        row={{ ...row, status: 'running' }}
        capability={{ usage: true, cancelMidTurn: false }}
        {...handlers}
      />,
    );
    expect(screen.getByRole('button', { name: '关闭运行时' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '终止' })).toBeNull();
    unmount();

    render(<EvalRowCard row={{ ...row, status: 'running' }} {...handlers} />);
    expect(screen.getByRole('button', { name: '终止' })).toBeInTheDocument();
  });

  it('单行的终止按钮只在运行中可见', () => {
    const { unmount } = render(<EvalRowCard row={row} {...handlers} />);
    expect(screen.queryByRole('button', { name: '终止' })).toBeNull();
    unmount();

    render(<EvalRowCard row={{ ...row, status: 'judging' }} {...handlers} />);
    expect(screen.getByRole('button', { name: '终止' })).toBeInTheDocument();
  });

  /**
   * 跑动期的实时指标透传（用户口径，2026-09-26）。
   * 两条都必要：只测「实时值能显示」会漏掉「终态还在用实时值」，
   * 而后者正是「结算值被一个还在涨的秒表/旧估算顶掉」的形状。
   */
  it('运行中的卡片把实时指标透传给计量行（不等这一行结束）', () => {
    render(
      <EvalRowCard
        row={{ ...row, status: 'running', tokens: null, turns: null, durationMs: null }}
        live={{ startedAtMs: null, tokens: { input: 10, cached: 0, output: 5 }, subagentTokens: null, subagentTurns: null, turns: 3, latestText: null, candidateEnded: false, candidateEndedAtMs: null }}
        {...handlers}
      />,
    );

    expect(screen.getByText('tok 15')).toBeInTheDocument();
    expect(screen.getByText('轮次 3')).toBeInTheDocument();
  });

  it('终态的卡片忽略实时值：显示快照里的权威值（running 由行的状态决定，不由 live 决定）', () => {
    render(
      <EvalRowCard
        row={row}
        live={{
          startedAtMs: Date.parse('2026-09-22T08:00:00.000Z'),
          tokens: { input: 999, cached: 0, output: 999 },
          subagentTokens: null,
          subagentTurns: null,
          turns: 99,
          // 终态忽略实时值这条口径对**文本**同样成立（活动行整行都不该出现，见下面那一组用例）
          latestText: '上一轮的残留文本',
          candidateEnded: false,
          candidateEndedAtMs: null,
        }}
        {...handlers}
      />,
    );

    // row 是 judged（快照里有权威值）：tok 132,650 / 轮次 17 必须压住实时值
    expect(screen.getByText('tok 132,650')).toBeInTheDocument();
    expect(screen.getByText('轮次 17')).toBeInTheDocument();
  });

  it('点「终止」先弹确认框，首点**不发** onAbort（不可撤销的动作不能一键直达）', async () => {
    const onAbort = vi.fn();
    render(<EvalRowCard row={{ ...row, status: 'running' }} {...handlers} onAbort={onAbort} />);

    fireEvent.click(screen.getByRole('button', { name: '终止' }));

    // 弹层要说清后果（杀子进程 + 不可撤销），并且此时一个请求都还没发
    expect(await screen.findByText('终止这一行？')).toBeInTheDocument();
    // 第二条提示也要等：弹层标题与正文不保证在同一帧渲染（口径同 provider-form-modal 的注释）
    expect(await screen.findByText('正在跑的 agent 子进程会被杀掉，且不可撤销。')).toBeInTheDocument();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('确认框点「确定」才发 onAbort，点「取消」零副作用', async () => {
    const onAbort = vi.fn();
    render(<EvalRowCard row={{ ...row, status: 'running' }} {...handlers} onAbort={onAbort} />);

    // 取消：关掉浮层，什么都没发生（对照冒烟 §1 第 16 项对整轮终止的实测）
    fireEvent.click(screen.getByRole('button', { name: '终止' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(onAbort).not.toHaveBeenCalled();

    // 确定：这一次才真的终止
    fireEvent.click(screen.getByRole('button', { name: '终止' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    await waitFor(() => expect(onAbort).toHaveBeenCalledTimes(1));
  });

  it('不支持中途取消的智能体同样要确认（文案是「关闭运行时」，语义是同一套）', async () => {
    const onAbort = vi.fn();
    render(
      <EvalRowCard
        row={{ ...row, status: 'running' }}
        capability={{ usage: true, cancelMidTurn: false }}
        {...handlers}
        onAbort={onAbort}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '关闭运行时' }));

    expect(await screen.findByText('终止这一行？')).toBeInTheDocument();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('没有产出改动时「变更详情」禁用；有错误时把码与原因一起显示', () => {
    render(
      <EvalRowCard
        row={{
          ...row,
          diff: null,
          status: 'failed',
          error: { code: 'AGENT_FAILED', message: 'CLI 未安装：spawn claude ENOENT' },
        }}
        {...handlers}
      />,
    );

    expect(screen.getByRole('button', { name: '变更详情' })).toBeDisabled();
    expect(screen.getByText(/AGENT_FAILED/)).toBeInTheDocument();
    expect(screen.getByText(/spawn claude ENOENT/)).toBeInTheDocument();
  });

  it('三个查看按钮把点击交回给调用方', () => {
    const onOpenLog = vi.fn();
    const onOpenDiff = vi.fn();
    const onOpenScore = vi.fn();
    render(
      <EvalRowCard
        row={{
          ...row,
          score: {
            // 评分结果的形状换了：逐项判定 + 满分（旧的 `dimensions: []` 已随重构删除）
            judgments: [],
            totalScore: 87,
            maxScore: 100,
            verdict: '可用',
            raw: '{}',
            judgeProviderId: 'p-1',
            judgeModelId: 'm',
            judgedAt: '2026-09-22T08:10:00.000Z',
            judgeAgentKind: null,
            // 强度未指定（一个强度键都没发）：本用例不涉及强度通路
            judgeEffort: null,
            // false ⇔ 这一分只靠提示词契约拿到（本用例不涉及 schema 通路）
            structuredOutput: false,
            // 评分自己的花销（2026-10-08）：行卡片不展示这两格
            judgeTokens: null,
            judgeDurationMs: null,
          },
        }}
        onAbort={vi.fn()}
        onOpenLog={onOpenLog}
        onOpenDiff={onOpenDiff}
        onOpenScore={onOpenScore}
        onRescore={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '执行日志' }));
    fireEvent.click(screen.getByRole('button', { name: '变更详情' }));
    fireEvent.click(screen.getByRole('button', { name: '评分详情' }));

    expect(onOpenLog).toHaveBeenCalledTimes(1);
    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    expect(onOpenScore).toHaveBeenCalledTimes(1);
  });

  /**
   * 按钮顺序（2026-09-28 **用户指定的版面口径**）：执行日志 / 变更详情 / 执行这一行 / 评分详情 / 重新评分。
   *
   * 为什么值得单独钉一条：本文件其余用例全按**可访问名**查按钮，顺序被改回去它们照样全绿
   * （M5 那次把文案改回「重试」时就是靠名字才发现，顺序反而是没人盯的一格）。
   * 顺序是按位置找按钮的使用者的读数习惯，改它必须显式改这一条。
   *
   * 两处字面量变更，**位置一格没动**：
   *   · 「查看改动」→「变更详情」（抽屉重设计，2026-09-29）；
   *   · 「重新执行」按行态分叉成「开始执行 / 重新执行」——这一格的位置仍是第 3 个（2026-09-29）；
   *   · 「查看日志」→「执行日志」（执行日志抽屉重设计，2026-10-02）——第 1 个，位置不变。
   *
   * 起点用**没跑过**的行（`pending`，没有基线也没有 diff）⇒ 那一格显示「开始执行」。
   * 为什么不断言「数组里必须有这五个」：写了它，将来删掉一个按钮时这条用例会因为
   * `filter` 后的长度对不上而红（那是**另一条**守卫该管的事），而它对顺序本身一无所知。
   */
  it('按钮顺序：执行日志 / 变更详情 / 执行这一行 / 评分详情 / 重新评分', () => {
    render(<EvalRowCard row={{ ...row, status: 'pending', baselineCommit: '', diff: null }} {...handlers} />);

    const ordered = ['执行日志', '变更详情', '开始执行', '评分详情', '重新评分'];
    const labels = screen
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((text) => ordered.includes(text));

    expect(labels).toEqual(ordered);
  });

  /**
   * 行级「重新评分」的二次确认（Task 7，spec §9 的用户口径）。
   *
   * 三条缺一不可：①首点**不发** `onRescore`（它会替换掉现有分数），②确认框要**说清代价**
   * （候选 agent 不会再跑、旧分会被替换），③确认之后才真的发出去。少了第 ① 条，一次误点就会
   * 静默重算；少了第 ② 条，使用者不知道自己的旧分正在被丢掉。
   *
   * ⚠️ 起点用「评分阶段失败」的行（判据不读这一档，只是这条夹具形状齐全：跑过 + 有基线 + 有 diff）。
   * 它**不必**是评分失败——2026-09-28 晚间口径放开之后，已经出分的行同样可点（见下面那组正面用例）。
   */
  it('点「重新评分」先弹确认框且首点不发请求，确认框说清「候选不会再跑、旧分会被替换」', async () => {
    const onRescore = vi.fn();
    render(<EvalRowCard row={{ ...row, status: 'failed', error: judgeFailed }} {...handlers} onRescore={onRescore} />);

    fireEvent.click(screen.getByRole('button', { name: '重新评分' }));

    expect(await screen.findByText('重新评分这一行？')).toBeInTheDocument();
    expect(
      screen.getByText('只重跑评分步骤，候选 agent 不会再跑；现有的分数会被新的评分结果替换。'),
    ).toBeInTheDocument();
    expect(onRescore).not.toHaveBeenCalled();
  });

  it('确认框点「确定」才发 onRescore，点「取消」零副作用', async () => {
    const onRescore = vi.fn();
    render(<EvalRowCard row={{ ...row, status: 'failed', error: judgeFailed }} {...handlers} onRescore={onRescore} />);

    fireEvent.click(screen.getByRole('button', { name: '重新评分' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(onRescore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重新评分' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    await waitFor(() => expect(onRescore).toHaveBeenCalledTimes(1));
  });

  /**
   * 可用性判据与**服务端同一份**（contracts 的 `canRescoreRow`）：两处各写一份必然漂移，
   * 而漂移的表现是「按钮可点、点下去 409」。这里钉住每个否定面**以及它对应的原因文案**
   * ——禁用而不解释等于一个坏掉的按钮（spec §9.2）。
   *
   * ⚠️ 这组用例**验不出文案是否真的能看见**（终审 FIX-6 实测的教训）：真实浏览器里鼠标悬浮禁用态的
   * 「重新评分」时，Tooltip 的直接子节点若是 `Popconfirm` 组件，浮层**根本不出现**；而 jsdom 里
   * `fireEvent.mouseEnter(button)` 是直接派发到按钮上的合成事件，会照常沿 React 树冒泡上去 ⇒
   * 下面这几条断言在两种结构下都绿。**改动这一处之后必须在真实浏览器里悬浮一次**（见
   * `eval-row-card.tsx` 里那段注释与冒烟记录）。
   */
  it('没跑过的行（无 diff）不给重评，并说明原因', async () => {
    render(<EvalRowCard row={{ ...row, status: 'pending', diff: null, baselineCommit: '' }} {...handlers} />);

    const button = screen.getByRole('button', { name: '重新评分' });
    expect(button).toBeDisabled();
    // 原因文案挂在 Tooltip 上（浮层由 mouseEnter 打开；悬浮本身在 jsdom 里不代表真实鼠标行为）
    fireEvent.mouseEnter(button);
    // 文案顺序与判据的三个条件同一序（在跑 → 没基线 → 没产出）：这一条夹具两个前提都缺，
    // 落到的是**工作区未就绪**（不是「没有改动」——那样会把原因指到错误的方向）
    expect(await screen.findByText('这一行的工作区未就绪，请先点「开始」跑一次')).toBeInTheDocument();
  });

  it('没有产出（diff 为 null）的行不给重评，并说明原因', async () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: agentFailed, diff: null }} {...handlers} />);

    const button = screen.getByRole('button', { name: '重新评分' });
    expect(button).toBeDisabled();
    fireEvent.mouseEnter(button);
    expect(await screen.findByText('这一行还没有跑过，没有可复评的改动')).toBeInTheDocument();
  });

  it('在跑的行不给重评（要重评得先终止它），并说明原因', async () => {
    render(<EvalRowCard row={{ ...row, status: 'running' }} {...handlers} />);

    const button = screen.getByRole('button', { name: '重新评分' });
    expect(button).toBeDisabled();
    fireEvent.mouseEnter(button);
    expect(await screen.findByText('正在运行中：请先终止它，再重新评分')).toBeInTheDocument();
  });

  /**
   * **2026-09-28 晚间口径**（用户：「已出分、无报错时取消禁用」）落在界面上的两条正面：
   *   · 已经出分的行 ⇒ **两个按钮都可点**（这是这次改动的全部目的）；
   *   · 候选 agent 阶段失败的行 ⇒ 也可点（判据不再看失败阶段）。
   * 误点的代价由各自的 `Popconfirm` 承担，不由 `disabled` 承担——下一条用例钉住那个确认框。
   */
  it('已经出分且没有报错的行：两个按钮都可点', () => {
    render(<EvalRowCard row={row} {...handlers} />); // 起点是 judged、error 为 null

    expect(screen.getByRole('button', { name: '重新评分' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重新执行' })).toBeEnabled();
  });

  it('已经出分的行点「重新执行」照样先弹确认框（一次误点是分钟级成本）', async () => {
    const onRetry = vi.fn();
    render(<EvalRowCard row={row} {...handlers} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: '重新执行' }));

    expect(await screen.findByText('重新执行这一行？')).toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('候选 agent 阶段失败的行：两个按钮都可点（判据不再看失败阶段）', () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: agentFailed }} {...handlers} />);

    expect(screen.getByRole('button', { name: '重新执行' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重新评分' })).toBeEnabled();
  });

  /**
   * 老快照（`error` 里没有 `stage` 这一格）**不许崩、也不许因此禁用**：
   * 判据只看那三条硬前提，而这三条与 `stage` 无关——这一条钉住「读 `error.stage` 的代码没有偷偷回来」。
   */
  it('老快照（error 没有 stage）与普通行同档：两个按钮都可点', () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: legacyFailed }} {...handlers} />);

    expect(screen.getByRole('button', { name: '重新执行' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重新评分' })).toBeEnabled();
  });

  it('可重评的行不给 Tooltip（没有原因要说，浮层不该出现）', async () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: judgeFailed }} {...handlers} />);

    const button = screen.getByRole('button', { name: '重新评分' });
    expect(button).toBeEnabled();
    fireEvent.mouseEnter(button);
    /**
     * 阴性面：`title={undefined}` 时 antd 不建浮层。
     *
     * ⚠️ 这一条**曾经是没有区分力的**（2026-10-04 T2 复核实测）：原来写的是悬浮后**同步**查
     * `.ant-tooltip`，而 antd 的浮层要等 `mouseEnterDelay`（默认 0.1s）才进 portal ⇒ 那句断言在任何
     * 实现下都为真。把 `rescoreHint` 改成**无条件**给出原因（也就是这条用例声称要拦的缺陷）之后，
     * 它**照样绿**——旧注释写的「少了这条…照样绿」恰好说反了：**加上**这条也照样绿。
     * 现在走 `expectNoTooltip()`（等满一个延迟窗口再判）：同一个缺陷会让浮层在窗口内落定 ⇒ 当场变红。
     */
    await expectNoTooltip();
  });

  it('评分失败的行照样可以重评（这正是这个功能的用途）', () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: judgeFailed }} {...handlers} />);

    expect(screen.getByRole('button', { name: '重新评分' })).toBeEnabled();
  });

  it('重评请求在途时按钮转圈（连点两次会让第二次的结果顶掉第一次）', () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: judgeFailed }} {...handlers} rescorePending />);

    // antd 的 loading 自己挡住点击（不额外置 `disabled` 属性，而是把按钮标成忙碌）：
    // `ant-btn-loading` 就是「连点两次」那条承诺的落点，而它只能由 `rescorePending` 传出来
    // ——控件里没有第二个 loading 来源。按角色查不到它（忙碌态的按钮没有可访问名），故按文本定位。
    const button = buttonByText('重新评分');
    expect(button.className).toContain('ant-btn-loading');
  });

  it('不在途时不转圈：那个类名确实是 rescorePending 带出来的', () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: judgeFailed }} {...handlers} />);

    expect(buttonByText('重新评分').className).not.toContain('ant-btn-loading');
  });

  /**
   * 行级「执行」（2026-09-27 引入为「重新执行」，2026-09-28 改过文案与可用面，
   * 2026-09-29 按用户口径「只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」**再放开一档**）：
   * 与「重新评分」并列的第二条出口。
   *
   * 为什么必须是**两个**按钮：要跑候选 agent（分钟级）与只重跑评分（几十秒）的处置与成本都不同，
   * 合成一个按钮等于让人按下去才知道跑的是哪一段。这一组钉住：
   *   · 跑过的行 ⇒ 「重新执行」+ 确认框说清「候选 agent 也会重跑」「只跑这一行」；
   *   · **没跑过的行 ⇒ 「开始执行」且可点**（首跑出口，2026-09-29 新增的那一档）+ 确认框说清
   *     「本轮其他行都不会重跑」；
   *   · 在跑的行 ⇒ 禁用并给出原因。
   */
  it('点「重新执行」先弹确认框且首点不发请求，确认框说清「候选 agent 与评分都会重跑」', async () => {
    const onRetry = vi.fn();
    render(<EvalRowCard row={{ ...row, status: 'failed', error: agentFailed }} {...handlers} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: '重新执行' }));

    expect(await screen.findByText('重新执行这一行？')).toBeInTheDocument();
    expect(
      screen.getByText(
        '候选 agent 与评分都会重跑：工作区会被重新准备，现有分数会被新的评分结果替换。只跑这一行，本轮其他行不动。',
      ),
    ).toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('重新执行确认框点「确定」才发 onRetry，点「取消」零副作用', async () => {
    const onRetry = vi.fn();
    render(<EvalRowCard row={{ ...row, status: 'failed', error: agentFailed }} {...handlers} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: '重新执行' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(onRetry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重新执行' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });

  /**
   * **2026-09-29 口径修订的正面**（用户原话：「重新执行，只执行当前候选项，不要完成后重新执行下方
   * 已经执行过的候选项」）：没跑过的行那一格从「禁用 + 请先点『开始』」变成「**开始执行**且可点」。
   *
   * 这一条钉三件事，缺一条这个功能就等于没做：
   *   ① 文案是「开始执行」而不是「重新执行」（没跑过的行说「重新」字面上就不通）；
   *   ② 它是**可点**的（禁用着就还是老行为：只能靠「开始」跑整轮）；
   *   ③ 确认框说清范围（只有这一个候选会跑，下方已执行过的行不会被重跑）——这句话就是用户那句口径。
   */
  it('没跑过的行给「开始执行」且可点，确认框说清「只跑这一个候选」', async () => {
    const onRetry = vi.fn();
    render(
      <EvalRowCard
        row={{ ...row, status: 'pending', baselineCommit: '', diff: null }}
        {...handlers}
        onRetry={onRetry}
      />,
    );

    const button = screen.getByRole('button', { name: '开始执行' });
    expect(button).toBeEnabled();
    expect(screen.queryByRole('button', { name: '重新执行' })).toBeNull();

    fireEvent.click(button);

    expect(await screen.findByText('开始执行这一行？')).toBeInTheDocument();
    expect(screen.getByText('只跑这一个候选：本轮其他行（含已经执行过的行）都不会重跑。')).toBeInTheDocument();
    // 首点不发请求（与另外两个出口同一套「先确认再动手」的语义）
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('开始执行确认框点「确定」才发 onRetry', async () => {
    const onRetry = vi.fn();
    render(
      <EvalRowCard
        row={{ ...row, status: 'pending', baselineCommit: '', diff: null }}
        {...handlers}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '开始执行' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));

    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });

  it('被跳过（skipped）的行同样是首跑出口：文案「开始执行」且可点', () => {
    render(<EvalRowCard row={{ ...row, status: 'skipped', baselineCommit: '', diff: null }} {...handlers} />);

    expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled();
  });

  /**
   * 「跑过没有」的判据是 `canRetryRow`（**两条**都要满足：有可比基线 + 有产出），不是「基线有没有」。
   * 只有一条成立的行（prepare 成功过、但候选 agent 阶段没产出 diff）仍然算首跑：
   * 这一档过去被「重新执行」判据挡着，只能靠「开始」跑——正是 2026-09-29 要解决的那个形状。
   */
  it('有基线但没产出 diff 的行也算首跑：文案「开始执行」且可点', () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: agentFailed, diff: null }} {...handlers} />);

    expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled();
  });

  it('在跑的行不给执行（要先终止它），并说明原因', async () => {
    render(<EvalRowCard row={{ ...row, status: 'running' }} {...handlers} />);

    const button = screen.getByRole('button', { name: '重新执行' });
    expect(button).toBeDisabled();
    fireEvent.mouseEnter(button);
    expect(await screen.findByText('正在运行中：请先终止它，再执行')).toBeInTheDocument();
  });

  /**
   * 正在**首跑**的行（`preparing` / `running`、还没有基线）那一格的文案仍是「重新执行」：
   * 它确实已经跑起来了，显示「开始执行」会让人以为还没开始。文案的判据因此是
   * 「跑过没有 **或** 正在跑」，不是单纯的 `canRetryRow`（后者对这一档返回 false）。
   */
  it('正在首跑（没基线、状态在途）的行：文案仍是「重新执行」，不显示「开始执行」', () => {
    render(<EvalRowCard row={{ ...row, status: 'preparing', baselineCommit: '', diff: null }} {...handlers} />);

    expect(screen.getByRole('button', { name: '重新执行' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '开始执行' })).toBeNull();
  });

  it('执行失败的行可以重新执行（这正是这个功能的用途）', () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: agentFailed }} {...handlers} />);

    expect(screen.getByRole('button', { name: '重新执行' })).toBeEnabled();
  });

  it('超时 / 被终止 / 被重启打断的行也可以重新执行（它们同样「跑过一次且有产出」）', () => {
    for (const status of ['timed-out', 'canceled', 'interrupted'] as const) {
      const { unmount } = render(<EvalRowCard row={{ ...row, status }} {...handlers} />);
      expect(screen.getByRole('button', { name: '重新执行' })).toBeEnabled();
      unmount();
    }
  });

  it('重新执行请求在途时按钮转圈（与重评同一套防连点口径）', () => {
    render(<EvalRowCard row={{ ...row, status: 'failed', error: agentFailed }} {...handlers} retryPending />);

    expect(buttonByText('重新执行').className).toContain('ant-btn-loading');
  });

  /**
   * `attempts` 的可视化（2026-09-27）：瞬时失败是**自动重试**的，不标出来的话
   * 「试了三次才成功」与「一次就成功」在卡片上长得一模一样——而那两件事的含义完全不同
   * （一个说明上游不稳，一个说明一切正常）。
   */
  it('重试过的行（attempts > 1）带「已重试 N 次」徽标；一次成功的行不带', () => {
    render(<EvalRowCard row={{ ...row, attempts: 3 }} {...handlers} />);
    expect(screen.getByText('已重试 2 次')).toBeInTheDocument();
  });

  it('阴性面：attempts = 1 时不出现那个徽标', () => {
    render(<EvalRowCard row={{ ...row, attempts: 1 }} {...handlers} />);
    expect(screen.queryByText(/已重试/)).toBeNull();
  });

  /**
   * 思考强度的可视化（spec D12 / §7 第 4 条）：有意选了档的行必须看得出来。
   * 没有这一格，横向对比就会把「跑 max 的行」与「跑默认档的行」并排展示而**不加区分**——
   * 那正是「分高的那一行可能是模型更强，也可能只是它跑了更高档」这件事在界面上消失的地方。
   */
  it('行上写了思考强度 ⇒ 显示档位标签；没写 ⇒ 一个标签都不出现（「没说」与「说了」要分得开）', () => {
    render(<EvalRowCard row={{ ...row, effort: 'high' }} {...handlers} />);
    expect(screen.getByText('high')).toBeInTheDocument();
  });

  it('阴性面：行上没有 effort ⇒ 不显示任何档位标签', () => {
    render(<EvalRowCard row={row} {...handlers} />);
    expect(screen.queryByText('high')).toBeNull();
    expect(screen.queryByText('max')).toBeNull();
  });

  /**
   * 显式关闭档（2026-10-07 口径）：档位一律照上游词汇原样显示，`off` 就写 `off`。
   * 靶子是**这一格还在**：把关闭档并进「没说」那一支（`row.effort === undefined || === EFFORT_OFF`）
   * 这条用例就红——「我要求关掉思考」与「我没选、由适配器决定」必须分得开，关掉思考这件事
   * 只有写出来才看得见（浮层里的「关闭思考」是它的注解，见下一条）。
   */
  it('显式 off 的行：档位标签逐字写 `off`，不写「未指定」', () => {
    render(<EvalRowCard row={{ ...row, effort: EFFORT_OFF }} {...handlers} />);
    expect(screen.getByText(EFFORT_OFF)).toBeInTheDocument();
  });

  /**
   * 档位浮层的文案（2026-10-07 用户口径）：写成一行「思考强度：<档>」——标签上已经写着档位名，
   * 浮层再说一遍「这一行**要求的**思考强度」是把同一件事说两遍。
   * 靶子是那句**逐字**的文案：留着旧那句（或改成别的措辞）这条用例就红。
   */
  it('行上写了档位 ⇒ 浮层写「思考强度：high」', async () => {
    render(<EvalRowCard row={{ ...row, effort: 'high' }} {...handlers} />);

    // 与 `metric-line.test.tsx` 同一套：hover 打开，且**必须等它入场**（同步查测的是时序不是实现）
    fireEvent.mouseEnter(screen.getByText('high'));
    expect(await screen.findByText('思考强度：high')).toBeInTheDocument();
  });

  /**
   * 关闭档的 Tooltip 也要说清它是什么（2026-10-07 用户口径：文案压到最短）：标签上已经是 `off`，
   * 浮层若照普通档抄一遍只把用户看不懂的词重复一遍，故写「关闭思考」。
   * 靶子是那句**逐字**的文案：留着旧那句（「这一行要求关闭思考」）这条用例就红。
   */
  it('显式 off 的行：Tooltip 写「关闭思考」，不是重复一遍 off', async () => {
    render(<EvalRowCard row={{ ...row, effort: EFFORT_OFF }} {...handlers} />);

    // 浮层判据与 `metric-line.test.tsx` 同一套：hover 打开，且**必须等它入场**
    // （同步查 `.ant-tooltip` 在任何实现下都为真，那测的是时序不是实现）
    fireEvent.mouseEnter(screen.getByText(EFFORT_OFF));
    expect(await screen.findByText('关闭思考')).toBeInTheDocument();
  });
});

/**
 * 供应商信息的位置（2026-10-07 用户口径）：标题行不再有「供应商」Tag，只留
 * 智能体 · 模型 · 思考强度；供应商名与接口地址改挂在**模型名**上，鼠标移入才浮出。
 * 两面分开钉：只钉「浮层里有」那一面的话，把 Tag 留着照样全绿，而「悬浮能看到」与
 * 「一眼占着标题行」是两种版面。
 */
describe('EvalRowCard：供应商信息挂在模型名上', () => {
  it('鼠标移入模型名 ⇒ 浮层给出「供应商：名字（地址）」', async () => {
    render(<EvalRowCard row={row} {...handlers} />);

    // 悬浮目标必须是**模型名本身**（挂到别处、或压根没挂，这条都红）
    fireEvent.mouseEnter(screen.getByText('claude-opus-4-6'));
    expect(
      await screen.findByText('供应商：Anthropic 网关（https://gw.example.com/anthropic）'),
    ).toBeInTheDocument();
  });

  it('阴性面：标题行上再也没有供应商 Tag（名字只活在浮层里）', () => {
    render(<EvalRowCard row={row} {...handlers} />);
    expect(screen.queryByText('Anthropic 网关')).toBeNull();
  });
});

/**
 * 卡片底部的**活动行**（用户口径，2026-09-29）：跑动期显示智能体最近一条输出、文字上有一条
 * 周期性扫过的高光；终态整行消失。四条口径各自有靶子：
 *   ① 判据必须是 `row.status`：终态还挂着「正在思考」比不显示更糟，而「传没传 `live`」不能当判据
 *      ——历史还没拉回来的跑动行同样要显示（第三条）；
 *   ② 它在**按钮行之后**：这是整张卡片里唯一会自己动的元素，夹在稳定信息中间会让每次重渲染
 *      都像「卡片在跳」。jsdom 没有真实几何，「在底部」只能按 DOM 顺序钉住；
 *   ③ 拿不到实时值时显示**回落文案**，不是空白行、也不是整行消失；
 *   ④ 终态时连**残留文本**一起消失（只判「有没有 live」的实现会把上一轮的输出接着显示下去）。
 */
describe('EvalRowCard 底部的活动行', () => {
  it('运行中显示智能体最近一条输出', () => {
    render(
      <EvalRowCard
        row={{ ...row, status: 'running', tokens: null, turns: null, durationMs: null }}
        live={{ startedAtMs: null, tokens: null, subagentTokens: null, subagentTurns: null, turns: null, latestText: '正在改 lib/http.js', candidateEnded: false, candidateEndedAtMs: null }}
        {...handlers}
      />,
    );

    expect(screen.getByTestId('agent-activity-line')).toHaveTextContent('正在改 lib/http.js');
  });

  it('它排在按钮行**之后**（卡片内容区的最底部）', () => {
    render(<EvalRowCard row={{ ...row, status: 'running' }} {...handlers} />);

    // 拿这一行**最后**一个按钮当参照物：顺序反了这条断言就是 0
    const lastButton = buttonByText('终止');
    const line = screen.getByTestId('agent-activity-line');
    expect(lastButton.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('拿不到实时值（刚起来 / 历史还没到）时显示回落文案，而不是空白行', () => {
    render(<EvalRowCard row={{ ...row, status: 'running', tokens: null, turns: null, durationMs: null }} {...handlers} />);

    expect(screen.getByTestId('agent-activity-line')).toHaveTextContent('正在思考…');
  });

  it('终态整行消失——即使手里还攥着上一轮的残留文本', () => {
    render(
      <EvalRowCard
        row={{ ...row, status: 'judged' }}
        live={{ startedAtMs: null, tokens: null, subagentTokens: null, subagentTurns: null, turns: null, latestText: '上一轮的残留文本', candidateEnded: false, candidateEndedAtMs: null }}
        {...handlers}
      />,
    );

    expect(screen.queryByTestId('agent-activity-line')).toBeNull();
    expect(screen.queryByText('上一轮的残留文本')).toBeNull();
  });
});

/**
 * **卡片 → Tooltip 的透传**（Task 8 评审补的守卫，2026-10-04）。
 *
 * 为什么非要有这一条：本文件其余夹具的 `subagentTokens` 全是 `null`（那一格是后加的，夹具只需
 * 形状齐全），于是 `eval-row-card.tsx` 里那行 `subagentTokens={row.subagentTokens}` 写成
 * `row.tokens`、或者**整行删掉**，既有用例与 `tsc` 全都会照常通过——而卡片上的两行 Tooltip
 * 从此在任何一行都不出现。这正是本仓拒绝上线的「静默失效」那一类：功能没了，测试却全绿。
 * 靶子就是那一行：把它改成 `row.tokens`，下面两条断言当场变红（拆出来的会是 0 / 100 / 20 / 30）。
 *
 * 浮层判据与 `metric-line.test.tsx` 同一套：hover 打开（`fireEvent.mouseEnter`），
 * 依赖文件顶部那个 `installResizeObserverStub()`（jsdom 没有 ResizeObserver，浮层对齐会抛）。
 */
describe('EvalRowCard：子智能体那一份透传到 Tooltip（spec 2026-10-04 §2.5）', () => {
  it('行上有分量时，卡片的 tok 浮层是两行（主会话 = 合计 − 分量）', async () => {
    render(
      <EvalRowCard
        row={{ ...row, tokens: { input: 100, cached: 20, output: 30 }, subagentTokens: { input: 40, cached: 10, output: 5 } }}
        {...handlers}
      />,
    );

    // 卡片上的 tok 仍只算输入 + 输出（130 = 100 + 30，缓存读不进这一格）
    expect(screen.getByText('tok 130')).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByText(/^tok /));

    // 60 = 100 − 40、10 = 20 − 10、25 = 30 − 5
    expect(await screen.findByText('主会话 输入 60 tok · 缓存 10 tok · 输出 25 tok')).toBeInTheDocument();
    expect(await screen.findByText('子智能体 输入 40 tok · 缓存 10 tok · 输出 5 tok')).toBeInTheDocument();
  });
});

/**
 * **卡片 → 「轮次」浮层的透传**（2026-10-04，与上面那条 token 透传守卫同源）。
 *
 * 为什么非要有这一条：本文件其余夹具的 `subagentTurns` 都是 `null` / 缺格（那一格是后加的），
 * 于是 `eval-row-card.tsx` 里那行 `subagentTurns={row.subagentTurns}` 写成 `row.turns`、
 * 或者**整行删掉**，既有用例与 `tsc` 全都会照常通过（`MetricLineProps.subagentTurns` 是可选格，
 * 少传一格不报错）——而「轮次」那个两行浮层从此在任何一行都不出现，卡片正文照旧显示合计。
 * 这正是本仓拒绝上线的「静默失效」：功能没了，测试却全绿。
 * 靶子就是那一行：把它改成 `row.turns`，下面第一条断言当场变红（拆出来会变成 0 / 20）。
 *
 * 浮层判据与 `metric-line.test.tsx` 同一套：hover 打开（`fireEvent.mouseEnter`），
 * 依赖 `ResizeObserver` 桩（jsdom 没有它，浮层对齐会抛 ⇒ 浮层永不出现）。
 */
describe('EvalRowCard：子智能体的轮次透传到 Tooltip（spec 2026-10-04 §2.5）', () => {
  /** 这一组自带桩与解除：与 `metric-line.test.tsx` 最后一段同一对（桩会影响整个文件的全局） */
  beforeEach(() => {
    installResizeObserverStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('行上有子轮次时，卡片的「轮次」浮层是两行（主会话 = 合计 − 分量）', async () => {
    render(<EvalRowCard row={{ ...row, turns: 20, subagentTurns: 7 }} {...handlers} />);

    // 卡片正文不改口径：合计仍是 20
    expect(screen.getByText('轮次 20')).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByText(/^轮次 /));

    // 13 = 20 − 7：主会话那一行只可能来自 `row.turns − row.subagentTurns`
    expect(await screen.findByText('主会话 13 轮')).toBeInTheDocument();
    expect(await screen.findByText('子智能体 7 轮')).toBeInTheDocument();
  });

  it('行上没有这一份分量（null）时「轮次」不给浮层，正文照旧是合计', async () => {
    render(<EvalRowCard row={{ ...row, turns: 20, subagentTurns: null }} {...handlers} />);

    fireEvent.mouseEnter(screen.getByText(/^轮次 /));
    await expectNoTooltip();

    expect(screen.getByText('轮次 20')).toBeInTheDocument();
    expect(screen.queryByText(/主会话/)).toBeNull();
  });
});
