/**
 * AskUserCard：时间轴上唯一「会等人」的东西。
 *
 * 七条守卫：
 *   · `pending + running` 走秒表且**不出现任何收场文案**（把「还在等」说成「已经收场」是最容易犯的错）；
 *   · `pending + !running` 是**静态灰字**「结果未采集」，**不能一直转圈**（变异体 (j) 的落点）；
 *   · 七态各自的文案与色档，**`unavailable` 是中性不是红色错误**；
 *   · 答案按 **`label`** 回填：夹具里 `selected` 的顺序与选项顺序**不同**——
 *     按下标匹配会把「已选」标到错的那两项上，而界面上看起来「有答案」（变异体 (i)）；
 *   · `selected` 里 `options` 没有的标签**原样显示**，不静默丢弃；
 *   · `custom` 多选是**补充**、单选是**覆盖**；
 *   · `secret` 默认遮罩，展开才显示。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserverStub } from '../../testing/resize-observer';
import { AskUserCard } from './ask-user-card';
import type { AskUserOption, AskUserPending, AskUserQuestion, AskUserSettled } from './types';
import { ASK_USER_OUTCOME_LABELS } from './types';

const AT = '2026-10-02T00:00:00.000Z';
const NOW = '2026-10-02T00:02:03.000Z';

// `header` 为空时标题走 `EllipsisText`（antd 的省略测量要 `ResizeObserver`，jsdom 没有）
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function option(label: string, overrides: Partial<AskUserOption> = {}): AskUserOption {
  return { label, description: null, recommended: false, ...overrides };
}

function question(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return {
    header: '选路径',
    prompt: '这次改哪条路径？',
    options: [option('选项 A'), option('选项 B'), option('选项 C')],
    multiSelect: false,
    allowOther: false,
    secret: false,
    ...overrides,
  };
}

function pending(overrides: Partial<AskUserPending> = {}): AskUserPending {
  return { state: 'pending', questions: [question()], at: AT, running: true, ...overrides };
}

function settled(overrides: Partial<AskUserSettled> = {}): AskUserSettled {
  return {
    state: 'settled',
    questions: [question()],
    outcome: 'answered',
    answers: null,
    at: AT,
    result: null,
    ...overrides,
  };
}

/** 选项那一行的容器（label 的父节点）：用来断言「已选」标挂在哪一项上 */
const rowOf = (label: string): HTMLElement | null => screen.getByText(label).parentElement;

describe('AskUserCard：还没收场', () => {
  it('pending + running：走秒表，且不出现任何收场文案', () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    try {
      render(<AskUserCard interaction={pending()} open={false} onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()} />);

      expect(screen.getByText('等待答复中… 2m03s')).toBeInTheDocument();
      expect(document.querySelector('.ant-badge-status-processing')).not.toBeNull();
      // 无人值守：这一句必须写出来（它解释「为什么可能一直等」）
      expect(screen.getByText('无人值守的运行里，这一步会一直等到轮次被取消')).toBeInTheDocument();

      // 收场文案一条都不能出现
      for (const meta of Object.values(ASK_USER_OUTCOME_LABELS)) {
        expect(screen.queryByText(meta.label)).toBeNull();
      }

      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByText('等待答复中… 3m03s')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pending + !running：静态灰字「结果未采集」，不带 processing 徽标、也不说「会一直等」', () => {
    const { container } = render(
      <AskUserCard interaction={pending({ running: false })} open={false} onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()} />,
    );

    expect(screen.getByText('结果未采集')).toBeInTheDocument();
    expect(container.querySelector('.ant-badge-status-processing')).toBeNull();
    expect(screen.queryByText(/等待答复中/)).toBeNull();
    // 轮次已经结束，「会一直等到轮次被取消」当场就是假的
    expect(screen.queryByText('无人值守的运行里，这一步会一直等到轮次被取消')).toBeNull();
  });
});

describe('AskUserCard：七种收场', () => {
  it('每一态各出自己的中文，unavailable 是中性色而不是红色错误', () => {
    for (const outcome of Object.keys(ASK_USER_OUTCOME_LABELS) as Array<keyof typeof ASK_USER_OUTCOME_LABELS>) {
      const { unmount } = render(
        <AskUserCard interaction={settled({ outcome })} open={false} onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()} />,
      );

      const tag = screen.getByText(ASK_USER_OUTCOME_LABELS[outcome].label).closest('.ant-tag');
      expect(tag).not.toBeNull();
      if (outcome === 'unavailable' || outcome === 'skipped' || outcome === 'canceled') {
        expect(tag?.className).not.toContain('error');
      }
      if (outcome === 'rejected') {
        expect(tag?.className).toContain('error');
      }
      unmount();
    }
  });

  it('收场说明如实写在标题下', () => {
    render(<AskUserCard interaction={settled({ outcome: 'unavailable' })} open={false} onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()} />);

    expect(screen.getByText('无人可应答')).toBeInTheDocument();
    expect(screen.getByText(/本仓没有开应答面/)).toBeInTheDocument();
  });

  it('收场了但没有答案可回填时说「答案未采集」', () => {
    render(<AskUserCard interaction={settled({ outcome: 'timeout', answers: null })} open onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()} />);

    expect(screen.getByText('答案未采集')).toBeInTheDocument();
  });
});

describe('AskUserCard：答案回填', () => {
  it('按 label 匹配：选项顺序与 selected 顺序不同也不会错位', () => {
    render(
      <AskUserCard
        interaction={settled({ answers: [{ header: '选路径', selected: ['选项 C', '选项 A'], custom: null }] })}
        open
        onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()}
      />,
    );

    expect(rowOf('选项 A')).toHaveTextContent('已选');
    expect(rowOf('选项 C')).toHaveTextContent('已选');
    // 按下标匹配会把「已选」标到 A、B 上——B 是那条路留下的指纹
    expect(rowOf('选项 B')).not.toHaveTextContent('已选');
    expect(screen.getAllByText('已选')).toHaveLength(2);
  });

  it('selected 里出现选项中没有的标签时原样显示，不静默丢弃', () => {
    render(
      <AskUserCard
        interaction={settled({ answers: [{ header: '选路径', selected: ['选项 Z'], custom: null }] })}
        open
        onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText('选项里没有的：')).toBeInTheDocument();
    expect(screen.getByText('选项 Z')).toBeInTheDocument();
  });

  it('多选时 custom 是补充：标签与自由输入都显示', () => {
    render(
      <AskUserCard
        interaction={settled({
          questions: [question({ multiSelect: true })],
          answers: [{ header: '选路径', selected: ['选项 B'], custom: '还有一条自定路径' }],
        })}
        open
        onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()}
      />,
    );

    expect(rowOf('选项 B')).toHaveTextContent('已选');
    expect(screen.getByText('补充：还有一条自定路径')).toBeInTheDocument();
  });

  it('单选时 custom 是覆盖：只显示自由输入，选项上不再标「已选」', () => {
    render(
      <AskUserCard
        interaction={settled({
          answers: [{ header: '选路径', selected: ['选项 A'], custom: '都不对，走第三条路' }],
        })}
        open
        onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText('自由输入（覆盖选项）：都不对，走第三条路')).toBeInTheDocument();
    expect(rowOf('选项 A')).not.toHaveTextContent('已选');
    expect(screen.queryByText('已选')).toBeNull();
  });

  it('配不上问题的答案照样列出来', () => {
    render(
      <AskUserCard
        interaction={settled({ answers: [{ header: '没问过的问题', selected: ['选项 A'], custom: null }] })}
        open
        onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText('另有 1 份答案没能回填到问题上：')).toBeInTheDocument();
    expect(screen.getByText('没问过的问题')).toBeInTheDocument();
  });
});

describe('AskUserCard：问题与选项', () => {
  it('recommended 只加一个 Tag，顺序一个字不动', () => {
    render(
      <AskUserCard
        interaction={pending({
          questions: [question({ options: [option('选项 A'), option('选项 B', { recommended: true }), option('选项 C')] })],
        })}
        open
        onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText('推荐')).toBeInTheDocument();
    expect(screen.getAllByText(/^选项 [ABC]$/).map((node) => node.textContent)).toEqual([
      '选项 A',
      '选项 B',
      '选项 C',
    ]);
  });

  it('多选与「其它（自由输入）」各有标注', () => {
    render(
      <AskUserCard
        interaction={pending({ questions: [question({ multiSelect: true, allowOther: true })] })}
        open
        onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText('可多选')).toBeInTheDocument();
    expect(screen.getByText('其它（自由输入）')).toBeInTheDocument();
  });

  it('header 为空时用截断到一行的 prompt 当标题，不美化也不改 header', () => {
    render(
      <AskUserCard
        interaction={pending({ questions: [question({ header: '', prompt: '第一行问题\n第二行细节' })] })}
        open={false}
        onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText('第一行问题')).toBeInTheDocument();
  });
});

describe('AskUserCard：只读与原文', () => {
  it('不提供任何「回答」按钮（本仓没有应答面）', () => {
    const { container } = render(<AskUserCard interaction={pending()} open onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()} />);

    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('secret 的答案默认遮罩，展开才显示；选项上也不留「已选」的痕迹', () => {
    render(
      <AskUserCard
        interaction={settled({
          // 多选：遮罩里两行都要能看到（「选了哪些」与自由输入）
          questions: [question({ secret: true, multiSelect: true })],
          answers: [{ header: '选路径', selected: ['选项 A'], custom: '机密内容' }],
        })}
        open
        onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText('••••')).toBeInTheDocument();
    expect(screen.queryByText('已选：选项 A')).toBeNull();
    expect(screen.queryByText(/机密内容/)).toBeNull();
    expect(rowOf('选项 A')).not.toHaveTextContent('已选');

    fireEvent.click(screen.getByText('••••'));

    expect(screen.getByText('已选：选项 A')).toBeInTheDocument();
    expect(screen.getByText('补充：机密内容')).toBeInTheDocument();
  });

  it('底部「原始结果」只在收场且有原文时出现', () => {
    const result = { ok: true, raw: '{"questions":[]}', truncation: { kind: 'none' } as const };
    const { unmount } = render(<AskUserCard interaction={pending()} open onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()} />);
    expect(screen.queryByText('原始结果')).toBeNull();
    unmount();

    render(<AskUserCard interaction={settled({ result })} open onOpenChange={vi.fn()} rawOpen={false} onRawOpenChange={vi.fn()} />);
    expect(screen.getByText('原始结果')).toBeInTheDocument();
  });
});
