/**
 * RubricTable：可编辑的二级表格（组 → 评分项）。
 * 四条守卫：
 *   1. 表尾汇总实时跟着数据走（它是用户自查权重配置的唯一手段——满分不强制是 100）；
 *   2. **写侧会拒的东西当场标出来**：撞车的**引用键**（判据取自 `rubricItemKeys`——含「空 ID 与显式
 *      `#1` 撞车」这种手写字符串比较看不见的情形）与**超过 `MAX_ITEM_WEIGHT` 的权重**
 *      （`validateRubric` 不查上限，它由 `RubricSchema` 在提交时才拒）；
 *   3. 改一格只动那一格（组轴与项轴都按索引定位，两项内容完全相同时也不能改错项）；
 *   4. readOnly 时不渲染任何增删改控件（用例详情复用同一个组件）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MAX_ITEM_WEIGHT, type Rubric } from '@aieval/contracts';
import { RubricSummaryText, RubricTable } from './rubric-table';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 既没有 ResizeObserver 也没有 matchMedia，而 antd 的 Table 两者都要
// （见 src/testing/resize-observer.ts）：不打桩，挂载即抛 `window.matchMedia is not a function`。
beforeEach(() => {
  installResizeObserverStub();
});

function sample(): Rubric {
  return {
    groups: [
      { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }, { id: 'A2', goal: '补 Javadoc', weight: 4 }] },
      { name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] },
    ],
  };
}

describe('RubricTable', () => {
  it('渲染组名、每项的 id / 目标 / 权重', () => {
    render(<RubricTable value={sample()} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('一、生产代码')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('追加 agent 字段')).toBeInTheDocument();
    expect(screen.getByDisplayValue('18')).toBeInTheDocument();
  });

  it('改目标时把**整张新表**交给 onChange（受控组件，不自己改 value）', () => {
    const onChange = vi.fn();
    render(<RubricTable value={sample()} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue('追加 agent 字段'), { target: { value: '改过的目标' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as Rubric;
    expect(next.groups[0]?.items[0]?.goal).toBe('改过的目标');
    // 其余部分必须原样保留（漏了就是「改一格清掉别的」）
    expect(next.groups[1]?.items[0]?.id).toBe('D1');
  });

  it('「添加评分项」往该组末尾加一个空项（权重给一个正数默认值，schema 不接受 0）', () => {
    const onChange = vi.fn();
    render(<RubricTable value={sample()} onChange={onChange} />);
    // 按钮形态钉在类名上：antd 6 里 `variant` **单给**会被静默降级成实线，除了类名没有任何可观察
    // 信号（同一处理由与写法见 `base/empty-state.test.tsx` 与 `composite/provider-table.test.tsx`）。
    // 三个按钮一律 `color` + `variant` 成对给，故这里把两种形态各钉一次。
    expect(screen.getByTestId('rubric-add-item-0').className).toContain('ant-btn-variant-dashed');
    expect(screen.getByTestId('rubric-remove-item-0-0').className).toContain('ant-btn-variant-text');
    fireEvent.click(screen.getByTestId('rubric-add-item-0'));
    const next = onChange.mock.calls[0]?.[0] as Rubric;
    expect(next.groups[0]?.items).toHaveLength(3);
    expect(next.groups[0]?.items[2]).toEqual({ id: '', goal: '', weight: 1 });
  });

  it('「删除项」「删除组」「添加分组」各自改对位置', () => {
    const onChange = vi.fn();
    const view = render(<RubricTable value={sample()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('rubric-remove-item-0-1'));
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).groups[0]?.items.map((item) => item.id)).toEqual(['A1']);

    view.unmount();
    const onChange2 = vi.fn();
    const view2 = render(<RubricTable value={sample()} onChange={onChange2} />);
    fireEvent.click(screen.getByTestId('rubric-remove-group-1'));
    expect((onChange2.mock.calls.at(-1)?.[0] as Rubric).groups.map((group) => group.name)).toEqual(['一、生产代码']);

    // 受控组件自己不持有状态：第二次点击前必须像真实表单那样把上一次的结果喂回去，
    // 否则「添加分组」看到的仍是挂载时那张 2 组的表（点完变成 3 组，测的就不是这条口径了）
    view2.rerender(<RubricTable value={onChange2.mock.calls.at(-1)?.[0] as Rubric} onChange={onChange2} />);
    fireEvent.click(screen.getByTestId('rubric-add-group'));
    expect((onChange2.mock.calls.at(-1)?.[0] as Rubric).groups).toHaveLength(2);
  });

  /**
   * 守卫：**两项内容完全相同**时改第二项不能改到第一项。
   * 这是本组件实现上最容易踩的坑（用 `items.includes(item)` 反查组索引时，
   * 两个 `{ id: '', goal: '', weight: 1 }` 的默认项会永远命中的是第一项），
   * 而连点两次「添加评分项」正好造出这个形状。
   */
  it('两项完全相同时只改被点的那一项', () => {
    const sameTwice: Rubric = { groups: [{ name: 'g', items: [{ id: '', goal: '', weight: 1 }, { id: '', goal: '', weight: 1 }] }] };
    const onChange = vi.fn();
    render(<RubricTable value={sameTwice} onChange={onChange} />);

    // 第二个空目标框：`getAllByDisplayValue('')` 拿不到（空值不算 display value），故按测试 id 取
    fireEvent.change(screen.getByTestId('rubric-item-goal-0-1'), { target: { value: '第二项的目标' } });

    const next = onChange.mock.calls.at(-1)?.[0] as Rubric;
    expect(next.groups[0]?.items[0]?.goal).toBe('');
    expect(next.groups[0]?.items[1]?.goal).toBe('第二项的目标');
  });

  it('表格上方直接显示校验原因（用户不该等到点「确定」才知道哪一格有问题）', () => {
    render(<RubricTable value={{ groups: [] }} onChange={vi.fn()} />);
    expect(screen.getByTestId('rubric-validation-error')).toHaveTextContent('至少需要一组');
  });

  it('有 id 的项重复时标红（写侧会拒，但用户不该等到提交才知道）', () => {
    const duplicated: Rubric = {
      groups: [
        { name: 'g1', items: [{ id: 'A1', goal: 'a', weight: 1 }] },
        { name: 'g2', items: [{ id: 'A1', goal: 'b', weight: 1 }] },
      ],
    };
    const view = render(<RubricTable value={duplicated} onChange={vi.fn()} />);
    // 两个输入框都进 error 态（antd 的 error 类名是 `ant-input-status-error`）
    const inputs = screen.getAllByDisplayValue('A1');
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input.className).toContain('ant-input-status-error');

    /**
     * 判据必须与 `validateRubric` / `rubricItemKeys` **同一口径：trim 之后比较**。
     *   · `' A1 '` 与 `'A1'` 在写侧是同一个 ID ⇒ 行内红框不能漏（红框是快信号、表格上方的文案是
     *     精确信号，两者对同一个问题给出不同答案正是「同一个问题两套判据」）；
     *   · 纯空白 ID 与空 ID 同档（都算「没写 ID」）⇒ 两个空白**不是**重复，不能标红。
     * 这一轮按 `data-testid` 取而不是按显示值取：`getAllByDisplayValue` 默认会 trim / 折叠空白，
     * `' A1 '` 在它眼里与 `'A1'` 是同一个显示值，按显示值取就分不清到底哪一个框红了。
     */
    view.unmount();
    const padded: Rubric = {
      groups: [
        { name: 'g1', items: [{ id: 'A1', goal: 'a', weight: 1 }] },
        { name: 'g2', items: [{ id: ' A1 ', goal: 'b', weight: 1 }] },
        { name: 'g3', items: [{ id: '   ', goal: 'c', weight: 1 }, { id: '   ', goal: 'd', weight: 1 }] },
        { name: 'g4', items: [{ id: 'B1', goal: 'e', weight: 1 }] },
      ],
    };
    render(<RubricTable value={padded} onChange={vi.fn()} />);
    // 先断言「不该红」的那一对：标记写反（把空白当重复）时红的就是这一条，
    // 放在「该红」的前面，两种错法各有断言接得住，不会一条失败把另一条盖住
    for (const testId of ['rubric-item-id-2-0', 'rubric-item-id-2-1']) {
      expect(screen.getByTestId(testId).className).not.toContain('ant-input-status-error');
    }
    for (const testId of ['rubric-item-id-0-0', 'rubric-item-id-1-0']) {
      expect(screen.getByTestId(testId).className).toContain('ant-input-status-error');
    }
    // 「引用键有重复」这个 Tag 只挂在真有撞车键的组上：g1 / g2 撞了 `A1`，g3（两个空白 = 匿名）
    // 与 g4（唯一 ID）都是干净的——挂在 groups.map 里就会给四组挂四个 Tag，冤枉两组
    // 文案与表格上方那句同口径：撞的是**引用键**（空 ID 的项会拿到位置键 `#k`），不是「ID」——
    // 写「ID 有重复」会在 g3 那种「两个都没写 ID」的表上指向一个不存在的字段
    expect(screen.getAllByText('引用键有重复')).toHaveLength(2);
    for (const testId of ['rubric-group-2', 'rubric-group-3']) {
      expect(within(screen.getByTestId(testId)).queryByText('引用键有重复')).toBeNull();
    }
  });

  /**
   * 守卫：判据必须取自契约的 `rubricItemKeys`（**引用键生成的唯一实现**），而不是本组件手写的
   * 「id 字符串相等」。手写那套漏掉「没写 ID 的项按位置分配 `#k`」这一半：
   * 下表的第 1 项没写 ID（键是 `#1`）、第 2 项显式写了 `#1` —— 写侧是两把相同的键、会被拒，
   * 而按字符串比较它们「不重复」，表格一个红框都不给（表格上方有精确文案、行内却没有快信号）。
   */
  it('空 ID 与显式 `#1` 撞车时也标红（键来自 rubricItemKeys，不是本组件手写的字符串比较）', () => {
    const collided: Rubric = {
      groups: [{ name: 'g', items: [{ id: '', goal: 'a', weight: 1 }, { id: '#1', goal: 'b', weight: 1 }] }],
    };
    render(<RubricTable value={collided} onChange={vi.fn()} />);
    // 写侧点的就是「引用键」，表格上方那句照旧来自 validateRubric
    expect(screen.getByTestId('rubric-validation-error')).toHaveTextContent('引用键');
    for (const testId of ['rubric-item-id-0-0', 'rubric-item-id-0-1']) {
      expect(screen.getByTestId(testId).className).toContain('ant-input-status-error');
    }
  });

  /**
   * 守卫：权重上限（`MAX_ITEM_WEIGHT`）只写在 `RubricSchema` 里，`validateRubric` **不查它**
   * （只管正整数）——所以「等提交被拒」是这张表唯一会漏掉的一类非法状态，而它正是本表最容易
   * 手滑造出来的（多按几个 0）。行内红框 + 表格上方点名，与引用键撞车同一套呈现。
   */
  it('权重超过上限时当场标出（schema 会拒，但 validateRubric 不查上限）', () => {
    const tooHeavy: Rubric = {
      groups: [{ name: 'g', items: [{ id: 'A1', goal: 'a', weight: MAX_ITEM_WEIGHT + 1 }] }],
    };
    render(<RubricTable value={tooHeavy} onChange={vi.fn()} />);
    expect(screen.getByTestId('rubric-validation-error')).toHaveTextContent(`超过了上限 ${MAX_ITEM_WEIGHT}`);
    // 上界真的交给了 antd（内层 input 的 `aria-valuemax`），不是只在自己这一层判
    const weight = screen.getByTestId('rubric-item-weight-0-0');
    expect(weight).toHaveAttribute('aria-valuemax', String(MAX_ITEM_WEIGHT));
    // 行内红框：antd 6 把 InputNumber 的 error 态挂在**外层 div** 上（内层 input 只管录入，
    // `data-testid` 落的正是它）——故从测试 id 的父元素取，这一点与 `Input` 不同（那边在自身）
    expect(weight.tagName).toBe('INPUT');
    expect(weight.parentElement?.className).toContain('ant-input-number-status-error');
  });

  /** 守卫：组轴与项轴一样按**索引**定位——改第 2 组的组名/权重时第 1 组必须原样 */
  it('改第 2 组的组名与权重时只动第 2 组（组轴也按索引定位，不按对象引用反查）', () => {
    const onChange = vi.fn();
    render(<RubricTable value={sample()} onChange={onChange} />);
    // 三个测试 id 一并覆盖：组卡片、组名输入框、第 2 组的权重输入框
    expect(screen.getByTestId('rubric-group-1')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('rubric-group-name-1'), { target: { value: '二、测试（改过）' } });
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).groups.map((group) => group.name)).toEqual(['一、生产代码', '二、测试（改过）']);

    // 受控组件：这一步仍是从挂载时那张表重算，故只断言「被改的那一格」与「没动的第 1 组」
    fireEvent.change(screen.getByTestId('rubric-item-weight-1-0'), { target: { value: '20' } });
    const next = onChange.mock.calls.at(-1)?.[0] as Rubric;
    expect(next.groups[1]?.items[0]?.weight).toBe(20);
    expect(next.groups[0]).toEqual(sample().groups[0]);
  });

  it('readOnly 时不渲染任何增删控件（用例详情复用同一个组件）', () => {
    render(<RubricTable value={sample()} onChange={vi.fn()} readOnly />);
    expect(screen.queryByTestId('rubric-add-group')).toBeNull();
    expect(screen.queryByTestId('rubric-add-item-0')).toBeNull();
    expect(screen.queryByTestId('rubric-remove-group-0')).toBeNull();
    // 只读态也不能是可编辑输入框
    expect(screen.queryByDisplayValue('追加 agent 字段')).toBeNull();
    expect(screen.getByText('追加 agent 字段')).toBeInTheDocument();
  });

  /**
   * 守卫：「这一项写没写 ID」只有**一条**判据——`trim()` 之后为空就算没写
   * （这正是 `rubricItemKeys` 决定「用 ID 还是用按位置的 `#k`」的那一行）。
   * 只读态若还按 `item.id === ''` 判，纯空白 ID 会渲染成一段空白：「有没有 ID」于是有两个答案。
   */
  it('只读态下纯空白 ID 与空 ID 同档，显示占位符 `—` 而不是一段空白', () => {
    const blankId: Rubric = {
      groups: [
        {
          name: 'g',
          items: [
            { id: '   ', goal: '没写 ID 的项', weight: 1 },
            { id: 'A1', goal: '有 ID 的项', weight: 1 },
          ],
        },
      ],
    };
    render(<RubricTable value={blankId} onChange={vi.fn()} readOnly />);
    expect(screen.getAllByText('—')).toHaveLength(1);
    // 两行都照常渲染（占位符只换掉 ID 那一格，别的内容不受影响）
    expect(screen.getByText('没写 ID 的项')).toBeInTheDocument();
    expect(screen.getByText('有 ID 的项')).toBeInTheDocument();
    expect(screen.getByText('A1')).toBeInTheDocument();
  });
});

describe('RubricSummaryText', () => {
  it('实时汇总满分与项数（满分由表格决定，用户必须能看见）', () => {
    render(<RubricSummaryText rubric={sample()} />);
    expect(screen.getByText(/满分 36 分/)).toBeInTheDocument();
    expect(screen.getByText(/共 3 项/)).toBeInTheDocument();
  });

  it('空表显示 0 分 0 项（不显示 NaN）', () => {
    render(<RubricSummaryText rubric={{ groups: [] }} />);
    expect(screen.getByText(/满分 0 分/)).toBeInTheDocument();
  });
});
