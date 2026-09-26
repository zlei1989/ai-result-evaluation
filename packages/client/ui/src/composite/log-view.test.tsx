/**
 * LogView：流式日志 + 自动滚底开关 + 下载 + 连接状态。
 * 四条守卫：
 *   · 关闭自动滚底后 MonoText 不再滚（用户往上翻的动作不能被按回去）；
 *   · 连接状态如实反映（`connected` 徽标不是装饰）；
 *   · 没有事件时给空态而不是一个空文本框——「还没有日志」与「日志是空的」对使用者是两件事；
 *   · **同一行重跑 = 新一代**（`useRowStream` 的文件头口径 5）：抽屉开着时新一轮事件的 `seq`
 *     从 1 重新开始，正文必须**整段换成新一轮**，绝不能与旧一轮拼在一起——
 *     那会在同一个抽屉里留下两条 `seq=1`、两条 `seq=2` 且无法区分谁是谁。
 *
 * 时间戳断言不写死时钟（`formatClock` 走本机时区），见 log-format.test.ts 的文件头。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent } from '@aieval/contracts';
import { LogView } from './log-view';
import { formatEventLog } from './log-format';

const at = '2026-09-22T08:00:00.000Z';
const at2 = '2026-09-22T08:00:01.000Z';

const events: AgentEvent[] = [
  { seq: 1, at, type: 'status', status: 'running' },
  { seq: 2, at: at2, type: 'log', stream: 'stdout', text: '开始改文件' },
];

/** 同一行重跑后的新一代：seq 又从 1 开始（编排层 resetEvents 删了 events.jsonl，契约 §3.4 / R27） */
const secondGeneration: AgentEvent[] = [
  { seq: 1, at, type: 'status', status: 'preparing' },
  { seq: 2, at: at2, type: 'log', stream: 'stdout', text: '重跑：重新准备' },
];

describe('LogView', () => {
  it('把事件渲染成日志行，并显示连接状态', () => {
    render(<LogView events={events} connected onDownload={vi.fn()} />);

    const text = screen.getByTestId('log-view-text');
    expect(text).toHaveTextContent('状态 执行中');
    expect(text).toHaveTextContent('开始改文件');
    expect(screen.getByText('实时连接中')).toBeInTheDocument();
  });

  it('未连接时如实显示「未连接」（且不丢掉已收到的事件）', () => {
    render(<LogView events={events} connected={false} onDownload={vi.fn()} />);

    expect(screen.getByText('未连接')).toBeInTheDocument();
    expect(screen.getByTestId('log-view-text')).toHaveTextContent('开始改文件');
  });

  it('关掉自动滚底后新事件不再把正文拽回底部', () => {
    const { rerender } = render(<LogView events={events} connected onDownload={vi.fn()} />);
    const host = screen.getByTestId('log-view-text');
    // jsdom 没有布局引擎，`scrollHeight` 恒为 0，而「滚到底」= `scrollTop = scrollHeight`：
    // 不顶出非零高度，这条用例对「压根不滚动」的实现也会通过（0 === 0）。
    // 注意：**每次重渲染前都要重设**——jsdom 在 `scrollTop` 被赋值时会按布局重算 scrollHeight（得到 0），
    // 于是「顶一次、后面不管」的写法会让「关闭时该不动」的那次断言假绿（见 mono-text.test.tsx 同款注释）。
    Object.defineProperty(host, 'scrollHeight', { value: 720, configurable: true });

    fireEvent.click(screen.getByRole('switch', { name: '自动滚底' }));
    host.scrollTop = 123;
    Object.defineProperty(host, 'scrollHeight', { value: 720, configurable: true });

    // 关掉之后**新事件**（文本变化）才是真正会触发滚动的那条路径
    rerender(
      <LogView
        events={[...events, { seq: 3, at: at2, type: 'log', stream: 'stderr', text: '又来一行' }]}
        connected
        onDownload={vi.fn()}
      />,
    );

    expect(host.scrollTop).toBe(123);
  });

  it('打开自动滚底时新事件把正文滚到底', () => {
    const { rerender } = render(<LogView events={events} connected onDownload={vi.fn()} />);
    const host = screen.getByTestId('log-view-text');
    Object.defineProperty(host, 'scrollHeight', { value: 640, configurable: true });

    rerender(
      <LogView
        events={[...events, { seq: 3, at: at2, type: 'log', stream: 'stderr', text: '又来一行' }]}
        connected
        onDownload={vi.fn()}
      />,
    );

    expect(host.scrollTop).toBe(640);
  });

  it('点下载把回调交回去', () => {
    const onDownload = vi.fn();
    render(<LogView events={events} connected onDownload={onDownload} />);

    fireEvent.click(screen.getByRole('button', { name: '下载' }));

    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('没有事件时给空态文案', () => {
    render(<LogView events={[]} connected={false} onDownload={vi.fn()} />);

    expect(screen.getByText('还没有日志')).toBeInTheDocument();
    expect(screen.queryByTestId('log-view-text')).toBeNull();
  });
});

describe('LogView 新一代日志（同一行重跑）', () => {
  // 背景：同一行重跑时编排层 `resetEvents` 删掉 `events.jsonl`，`appendEvent` 的 seq 从 1 重新发号
  // （契约 §3.4 + R27）；`useRowStream` 把「seq 回到 1」判成新一代并**清空**自己交付过的事件
  // （row-stream.ts 口径 5）。所以到 `LogView` 手上的数组**已经是新一轮的整段**。
  //
  // 取舍：视图**不做分段**，就按「这批就是全部」渲染——分段需要轮次 id（`EvalRow` 里没有），
  // 而数据层已经在唯一正确的位置（收到 seq=1 的那一刻）完成了替换；视图再猜一次只会造出
  // 第二份判据。代价：若将来有调用方绕过 `useRowStream` 直接拼两轮，这里不会拦。
  //
  // 守卫的可机检判据：正文**恰好等于** `formatEventLog(新一代)`——多一个字都不行。
  // 这条是**非空转**的：任何「拼在旧正文后面」的实现都会多出旧一轮的行（见报告变异体 M-N1）。
  it('新一代事件整段替换旧一轮，正文不多不少就是新一代', () => {
    const { rerender } = render(<LogView events={events} connected onDownload={vi.fn()} />);
    // 先确认真有一个「旧一轮」存在（否则下面那条断言是空转的）
    expect(screen.getByTestId('log-view-text')).toHaveTextContent('开始改文件');

    rerender(<LogView events={secondGeneration} connected onDownload={vi.fn()} />);

    const text = screen.getByTestId('log-view-text');
    // 正文逐字等于新一代的格式化结果：旧的 `开始改文件` 若被留在里面，这条立刻红
    expect(text.textContent).toBe(formatEventLog(secondGeneration));
    expect(text.textContent).not.toContain('开始改文件');
  });

  it('新一代的 seq=1、seq=2 都要渲染出来（视图不按 seq 去重，那是数据层的事）', () => {
    const { rerender } = render(<LogView events={events} connected onDownload={vi.fn()} />);
    rerender(<LogView events={secondGeneration} connected onDownload={vi.fn()} />);

    const text = screen.getByTestId('log-view-text');
    expect(text).toHaveTextContent('状态 准备中');
    expect(text).toHaveTextContent('重跑：重新准备');
  });
});
