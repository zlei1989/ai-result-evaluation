/**
 * AskUserPanel：一题一步推进，点「完成」时交出一份与问题**逐问对上**的答案。
 *
 * 七个守卫（本组件的全部价值都在这几条上）：
 *   1. 一题一步：最后一问才给「完成」，`onComplete` 只回调一次，载荷的 `header` 与问题逐问对上；
 *   2. 多选 + 自由输入 = **并存**（选项不禁用，标签与自由输入都交出去）；单选 + 自由输入 = **覆盖**（选项整组禁用、`selected` 空，清空后恢复）；
 *   3. `allowOther === false` 时根本没有自由输入入口；
 *   4. `secret` 的答案默认遮罩，展开才显示；
 *   5. 「关掉」不是「回答」：只回调 `onClose`，不产生 `onComplete`；输入框里按 Enter 也不交卷
 *      （末题不做事、非末题只推进），只有「完成」按钮触发的 submit 才被受理；
 *   6. 关闭即丢弃：再打开是崭新一题，上次的输入不残留；
 *   7. 没有作答面的一问（选项为空且不允许自由输入）仍然走得通，空答案不许外溢到有作答面的问题上。
 *
 * 弹层走 portal ⇒ 查询一律走 `screen`（按 `render()` 的 `container` 查会恒得 0）。
 *
 * 「禁用」的判据是**原生 `<input>` 的 `disabled`**：`Questionnaire.Choice` 的选项是真的
 * radio / checkbox（`Questionnaire.ChoiceInput`），故 `toBeDisabled()` 直接读的就是
 * 浏览器会照办的那一格。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installResizeObserverStub } from '../testing/resize-observer';
import { AskUserPanel } from './ask-user-panel';
import type { AskUserOption, AskUserQuestion } from './agent-log/types';

// jsdom 没有 `ResizeObserver`，而 `Drawer` 内部（rc-resize-observer）直接 new 它：不打桩挂载即抛
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function option(label: string, overrides: Partial<AskUserOption> = {}): AskUserOption {
  return { label, description: null, recommended: false, ...overrides };
}

function question(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return {
    header: '选路径',
    prompt: '这次改哪条路径？',
    options: [option('选项 A'), option('选项 B')],
    multiSelect: false,
    allowOther: false,
    secret: false,
    ...overrides,
  };
}

const noop = (): void => {};

it('口径 4｜单选 + 自由输入 = 覆盖：选项整组禁用，答案里 custom 有值、selected 为空', () => {
  const onComplete = vi.fn();
  render(
    <AskUserPanel
      open
      questions={[question({ allowOther: true })]}
      submitting={false}
      onComplete={onComplete}
      onClose={noop}
    />,
  );

  fireEvent.click(screen.getByRole('radio', { name: /选项 A/ }));
  fireEvent.change(screen.getByTestId('ask-user-custom'), { target: { value: '都不对，走第三条路' } });

  // 写了话就不该再能点选项：那一点会交出一个会被丢掉的选择。
  // 判据是原生 input 的 disabled：选项是真的 radio，浏览器拦得住才算数
  expect(screen.getByRole('radio', { name: /选项 A/ })).toBeDisabled();
  expect(screen.getByRole('radio', { name: /选项 B/ })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: '完成' }));

  expect(onComplete).toHaveBeenCalledWith([{ header: '选路径', selected: [], custom: '都不对，走第三条路' }]);
});

it('单选：清空自由输入 ⇒ 选项恢复可选且选中生效', () => {
  const onComplete = vi.fn();
  render(
    <AskUserPanel
      open
      questions={[question({ allowOther: true })]}
      submitting={false}
      onComplete={onComplete}
      onClose={noop}
    />,
  );

  const custom = screen.getByTestId('ask-user-custom');
  // 输入后又清空（用户改主意）
  fireEvent.change(custom, { target: { value: '先这么写' } });
  expect(screen.getByRole('radio', { name: /选项 A/ })).toBeDisabled();
  fireEvent.change(custom, { target: { value: '' } });
  expect(screen.getByRole('radio', { name: /选项 A/ })).toBeEnabled();

  // 不能只判「能点」：还要能真选上、且提交的是选中的标签
  fireEvent.click(screen.getByRole('radio', { name: /选项 A/ }));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));

  expect(onComplete).toHaveBeenCalledWith([{ header: '选路径', selected: ['选项 A'], custom: null }]);
});

it('口径 4｜多选 + 自由输入 = 并存：不禁用选项，标签与自由输入一起交出去', () => {
  const onComplete = vi.fn();
  render(
    <AskUserPanel
      open
      questions={[question({ multiSelect: true, allowOther: true })]}
      submitting={false}
      onComplete={onComplete}
      onClose={noop}
    />,
  );

  fireEvent.change(screen.getByTestId('ask-user-custom'), { target: { value: '还有一条自定路径' } });
  // 多选那一档不能跟着单选一起锁住：它们都要交出去
  expect(screen.getByRole('checkbox', { name: /选项 A/ })).toBeEnabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /选项 B/ }));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));

  expect(onComplete).toHaveBeenCalledWith([{ header: '选路径', selected: ['选项 B'], custom: '还有一条自定路径' }]);
});

it('一题一步：最后一问才给「完成」，载荷与问题逐问对上', () => {
  const onComplete = vi.fn();
  const questions = [
    question({ header: '选路径', options: [option('选项 A'), option('选项 B')] }),
    question({ header: '要不要重跑', prompt: '改完之后重跑一次吗？', options: [option('要'), option('不要')] }),
  ];
  render(
    <AskUserPanel open questions={questions} submitting={false} onComplete={onComplete} onClose={noop} />,
  );

  // 第一问：页脚没有「完成」（一题一步的意义就在于不能一次交半份答案）
  expect(screen.getByRole('button', { name: '下一步' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '完成' })).toBeNull();

  fireEvent.click(screen.getByRole('radio', { name: /选项 A/ }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));

  // 第二问：标题与正文都换成第二问的，「上一步」这一步才出现。
  // 其余几问仍挂在 DOM 里（Questionnaire 用 `hidden`/`inert` 藏非当前问），故判据落在
  // **可访问性**上：只当前那一问的控件能被读到，隐藏的问句不该被当成还能答的一问
  expect(screen.getByRole('dialog')).toHaveTextContent('第 2/2 题 · 要不要重跑');
  expect(screen.queryByRole('radio', { name: /选项 A/ })).toBeNull();
  expect(screen.getByRole('radio', { name: /^要/ })).toBeVisible();
  expect(screen.getByRole('button', { name: '上一步' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('radio', { name: /^要/ }));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));

  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledWith([
    { header: '选路径', selected: ['选项 A'], custom: null },
    { header: '要不要重跑', selected: ['要'], custom: null },
  ]);
});

it('口径 3｜配对键只用 header：题目顺序变了也按 header 配对，不按下标', async () => {
  const onComplete = vi.fn();
  const first = question({ header: '第一问', options: [option('选项 A')] });
  const second = question({ header: '第二问', prompt: '第二问说什么？', options: [option('选项 C')] });
  const { rerender } = render(
    <AskUserPanel open questions={[first, second]} submitting={false} onComplete={onComplete} onClose={noop} />,
  );

  // 两问都答上：第一问选 A，推进到第二问选 C
  fireEvent.click(screen.getByRole('radio', { name: /选项 A/ }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('radio', { name: /选项 C/ }));

  // 两问换位：内容跟着各自的问题走，下标全变了。
  // 草稿要是按题目顺序存，A / C 就会跟着下标停到另一问上——正是「答案配错题」的症状
  rerender(
    <AskUserPanel open questions={[second, first]} submitting={false} onComplete={onComplete} onClose={noop} />,
  );

  // 换位后当前是「第二问」（下标 0）：先等官方件把 DOM 顺序重新登记完，再推进到最后一问
  await waitFor(() => expect(screen.getByRole('button', { name: '下一步' })).toBeVisible());
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));

  // 载荷按**当前问题清单的顺序**产出，但每一格的内容必须回到它自己的 header 上
  expect(onComplete).toHaveBeenCalledWith([
    { header: '第二问', selected: ['选项 C'], custom: null },
    { header: '第一问', selected: ['选项 A'], custom: null },
  ]);
});

it('allowOther === false 时没有自由输入入口', () => {
  render(
    <AskUserPanel
      open
      questions={[question({ allowOther: false })]}
      submitting={false}
      onComplete={noop}
      onClose={noop}
    />,
  );

  expect(screen.queryByTestId('ask-user-custom')).toBeNull();
});

it('secret 的答案默认遮罩，展开才显示作答区', () => {
  render(
    <AskUserPanel
      open
      questions={[question({ secret: true })]}
      submitting={false}
      onComplete={noop}
      onClose={noop}
    />,
  );

  expect(screen.getByText('••••')).toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: /选项 A/ })).toBeNull();

  fireEvent.click(screen.getByText('••••'));

  expect(screen.getByRole('radio', { name: /选项 A/ })).toBeInTheDocument();
});

it('口径 1｜不点完成不交出：关闭只回调 onClose，不产生完成事件', () => {
  const onComplete = vi.fn();
  const onClose = vi.fn();
  render(
    <AskUserPanel
      open
      questions={[question({ allowOther: true })]}
      submitting={false}
      onComplete={onComplete}
      onClose={onClose}
    />,
  );

  fireEvent.click(screen.getByRole('radio', { name: /选项 A/ }));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onComplete).not.toHaveBeenCalled();
});

it('口径 1｜输入框里按 Enter 不提交', () => {
  const onComplete = vi.fn();
  render(
    <AskUserPanel
      open
      questions={[question({ allowOther: true })]}
      submitting={false}
      onComplete={onComplete}
      onClose={noop}
    />,
  );

  const input = screen.getByTestId('ask-user-custom');
  // 敲完一句、习惯性回车：这是最容易误触的一格，末题上不许因此交出整份问卷。
  // 官方件的 Enter 走的是不带 submitter 的 `requestSubmit()`，被 `onSubmit` 的完成标记判据拦下
  fireEvent.change(input, { target: { value: '写完就回车' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  expect(onComplete).not.toHaveBeenCalled();
  expect(screen.getByTestId('ask-user-custom')).toHaveValue('写完就回车');
});

it('Enter 在非末题上等价于「下一题」：仍在这份问卷里，且没有交出答案', () => {
  const onComplete = vi.fn();
  const questions = [
    question({ header: '第一问', allowOther: true }),
    question({ header: '第二问', prompt: '第二问说什么？', options: [option('选项 C')] }),
  ];
  render(
    <AskUserPanel open questions={questions} submitting={false} onComplete={onComplete} onClose={noop} />,
  );

  const input = screen.getByTestId('ask-user-custom');
  fireEvent.change(input, { target: { value: '先写一句' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  // 回车推进到下一题（与点「下一步」同一件事），绝不产生完成事件
  expect(screen.getByRole('dialog')).toHaveTextContent('第 2/2 题 · 第二问');
  expect(screen.getByRole('radio', { name: /选项 C/ })).toBeVisible();
  expect(onComplete).not.toHaveBeenCalled();
});

it('口径 6｜关闭即丢弃：再打开时不残留上次的输入', async () => {
  const onComplete = vi.fn();
  const props = {
    questions: [question({ allowOther: true })],
    submitting: false,
    onComplete,
    onClose: noop,
  };
  const { rerender } = render(<AskUserPanel open {...props} />);

  fireEvent.click(screen.getByRole('radio', { name: /选项 A/ }));
  fireEvent.change(screen.getByTestId('ask-user-custom'), { target: { value: '写了一半' } });

  // 关：Sheet 关闭即卸载，草稿在关闭完成时重置（`onOpenChangeComplete`）
  rerender(<AskUserPanel open={false} {...props} />);
  await waitFor(() => expect(screen.queryByTestId('ask-user-custom')).toBeNull());

  rerender(<AskUserPanel open {...props} />);

  const custom = screen.getByTestId('ask-user-custom');
  expect(custom).toHaveValue('');
  expect(screen.getByRole('radio', { name: /选项 A/ })).not.toBeChecked();
  expect(screen.getByRole('button', { name: '完成' })).toBeDisabled();
});

it('没有作答面（选项为空且不允许自由输入）时仍然走得通：交出空答案', async () => {
  const onComplete = vi.fn();
  render(
    <AskUserPanel
      open
      questions={[question({ options: [], allowOther: false })]}
      submitting={false}
      onComplete={onComplete}
      onClose={noop}
    />,
  );

  // 面板是人工应答的唯一入口：这一枚按钮要是禁着，用户既推进不了也提交不了，整轮只能等提问预算到点
  const complete = screen.getByRole('button', { name: '完成' });
  expect(complete).toBeEnabled();

  fireEvent.click(complete);

  // 没有作答面时页脚主按钮是官方 `Skip`：末题直接点击交出，不绕表单的 submit
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith([{ header: '选路径', selected: [], custom: null }]));
});

it('没有作答面的一问只放行自己：下一问仍要求先答，空答案不外溢', () => {
  const onComplete = vi.fn();
  const questions = [
    question({ header: '没得选', prompt: '智能体没给选项', options: [], allowOther: false }),
    question({ header: '选路径', options: [option('选项 A')] }),
  ];
  render(
    <AskUserPanel open questions={questions} submitting={false} onComplete={onComplete} onClose={noop} />,
  );

  // 第一问：能推进到下一问
  const next = screen.getByRole('button', { name: '下一步' });
  expect(next).toBeEnabled();
  fireEvent.click(next);
  expect(screen.getByRole('dialog')).toHaveTextContent('第 2/2 题 · 选路径');
  expect(screen.getByRole('radio', { name: /选项 A/ })).toBeVisible();

  // 第二问有作答面 ⇒ 回到「必须先答」，空答案不许蒙混过去
  const complete = screen.getByRole('button', { name: '完成' });
  expect(complete).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: /选项 A/ }));
  fireEvent.click(complete);

  expect(onComplete).toHaveBeenCalledWith([
    { header: '没得选', selected: [], custom: null },
    { header: '选路径', selected: ['选项 A'], custom: null },
  ]);
});
