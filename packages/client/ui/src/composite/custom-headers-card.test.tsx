/**
 * CustomHeadersCard：增删行、行内校验（键名 / 撞名 / 填了一半）、折叠成 map、「保存 / 还原」的启用条件。
 *
 * 为什么这些行为必须逐条钉在**卡片**上：本仓的应用层（apps/web-next）不能写 `.tsx` 测试，页面只做接线，
 * 全部判定都在卡片里。而这一张卡的三类判断都是「错了也不报错」的那种：
 *   · 把草稿空行提交上去 ⇒ 落盘里多出一条没有名字的头，四家据此写出一行畸形方言；
 *   · 把撞名的两行都交出去 ⇒ 落盘一份、发出去一份，界面与真实行为分家；
 *   · 「保存」键的启用条件写错（一直可点 / 永远不可点）⇒ 用户要么把坏表存进去，要么改完点不动。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CustomHeadersCard, type CustomHeadersCardProps } from './custom-headers-card';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 matchMedia，而 antd 的 Form.Item / Grid 会无条件读它（口径见 workspace-settings-card.test.tsx）
beforeEach(() => {
  installResizeObserverStub();
});

const noop = (): void => {};

function renderCard(overrides: Partial<CustomHeadersCardProps> = {}): ReturnType<typeof render> {
  return render(<CustomHeadersCard headers={{}} saving={false} onSave={noop} {...overrides} />);
}

/** 取第 n 行（1 起）的两个输入框与删除按钮 */
function row(n: number): { name: HTMLInputElement; value: HTMLInputElement; remove: HTMLElement } {
  return {
    name: screen.getByLabelText(`第 ${n} 行的键名`) as HTMLInputElement,
    value: screen.getByLabelText(`第 ${n} 行的键值`) as HTMLInputElement,
    remove: screen.getByLabelText(`删除第 ${n} 行`),
  };
}

/** 「保存」按钮：文案是唯一判据（按钮没有额外的可访问名） */
function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
}
function resetButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '还原' }) as HTMLButtonElement;
}

describe('CustomHeadersCard：编辑与保存', () => {
  it('已有的头逐行回显；没改动时「保存」「还原」都不可点', () => {
    renderCard({ headers: { 'X-Trace-Id': 'abc', 'X-Team': 'ev' } });

    expect(row(1).name.value).toBe('X-Trace-Id');
    expect(row(1).value.value).toBe('abc');
    expect(row(2).name.value).toBe('X-Team');
    expect(saveButton().disabled).toBe(true);
    expect(resetButton().disabled).toBe(true);
  });

  it('添加一行 → 填上键值 → 保存交出折叠好的 map；草稿空行不提交', () => {
    const onSave = vi.fn();
    renderCard({ onSave });

    fireEvent.click(screen.getByRole('button', { name: '添加一行' }));
    fireEvent.click(screen.getByRole('button', { name: '添加一行' }));
    fireEvent.change(row(1).name, { target: { value: 'X-Trace-Id' } });
    fireEvent.change(row(1).value, { target: { value: 'abc:123' } });
    // 第二行留成整行空白（草稿）：它不该出现在提交的那张表里
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledWith({ 'X-Trace-Id': 'abc:123' });
  });

  it('删掉一行 → 剩下那行原样，保存交出剩下的部分（删光 = 空表）', () => {
    const onSave = vi.fn();
    renderCard({ headers: { 'X-Trace-Id': 'abc', 'X-Team': 'ev' }, onSave });

    fireEvent.click(row(1).remove);

    expect(row(1).name.value).toBe('X-Team');
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({ 'X-Team': 'ev' });
  });

  it('删光之后保存交出空表（一条都不发是一种合法选择，不是「没改」）', () => {
    const onSave = vi.fn();
    renderCard({ headers: { 'X-Trace-Id': 'abc' }, onSave });

    fireEvent.click(row(1).remove);
    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledWith({});
  });

  it('还原：扔掉未保存的输入，回到已保存那份', () => {
    renderCard({ headers: { 'X-Trace-Id': 'abc' } });
    fireEvent.change(row(1).value, { target: { value: 'changed' } });
    expect(resetButton().disabled).toBe(false);

    fireEvent.click(resetButton());

    expect(row(1).value.value).toBe('abc');
    expect(saveButton().disabled).toBe(true);
  });

  it('服务端那份变了 ⇒ 重灌（保存之后拿到的新掩码要看得见）', () => {
    const { rerender } = renderCard({ headers: { 'X-Api-Key': 'abc***xyz' } });
    fireEvent.change(row(1).value, { target: { value: 'new-plain' } });

    rerender(<CustomHeadersCard headers={{ 'X-Api-Key': 'new***pek' }} saving={false} onSave={noop} />);

    expect(row(1).value.value).toBe('new***pek');
  });
});

describe('CustomHeadersCard：行内校验（拦下保存）', () => {
  it('键名含空白 / 冒号 ⇒ 标红且不能保存', () => {
    renderCard({ headers: { 'X Trace': 'abc' } });

    expect(screen.getByText(/请求头名只能含 HTTP 头名允许的字符/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('撞名（忽略大小写）⇒ 两行同时标红、说清是撞名', () => {
    renderCard({ headers: { 'X-Trace': '1', 'x-trace': '2' } });

    expect(screen.getAllByText('键名重复（HTTP 头名不区分大小写）')).toHaveLength(2);
    expect(saveButton().disabled).toBe(true);
  });

  it('只填了值没填键名 ⇒ 拦下（那不是草稿，是填了一半，静默丢掉等于用户以为自己配上了）', () => {
    renderCard({ headers: {} });
    fireEvent.click(screen.getByRole('button', { name: '添加一行' }));
    fireEvent.change(row(1).value, { target: { value: 'abc' } });

    expect(screen.getByText('这一行还没填键名')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('值里带换行 ⇒ 拦下（Header 注入的形状）', () => {
    renderCard({ headers: { 'X-Trace': 'a\nX-Evil: 1' } });

    expect(screen.getByText(/请求头的值不能包含换行/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('保存在跑 ⇒ 三个按钮一起置灰（半截状态里不许继续点）', () => {
    renderCard({ headers: { 'X-Trace-Id': 'abc' }, saving: true });

    expect(saveButton().disabled).toBe(true);
    expect(resetButton().disabled).toBe(true);
    expect((screen.getByRole('button', { name: '添加一行' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('空表时给一句引导，而不是留一张什么都没有的卡', () => {
    renderCard({ headers: {} });

    expect(screen.getByText(/还没有自定义请求头/)).toBeTruthy();
  });
});
