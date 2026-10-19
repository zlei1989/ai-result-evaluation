/**
 * 首批 vendored 原语的渲染面：**从包根**取四个件，在 jsdom 里渲染出各自的 `data-slot`。
 *
 * 判据刻意走包根（`../index`）而不是深路径：装配侧（`apps/web-next`）只能拿包根出口，
 * 深路径那条 import 一直是通的——用它写用例等于把「包根漏转出」整个放过。
 *
 * 断 `data-slot` 而不是断 class：这几个件的样式全在 `apps/web-next` 的 Tailwind 管线里，
 * jsdom 不跑 CSS，类名在测试里只是一串字符串；而 `data-slot` 是 vendored 源码自己的结构契约
 * （`card` 的 `has-data-[slot=card-footer]`、`button` 的 `in-data-[slot=button-group]` 都靠它命中），
 * 它从渲染结果里消失就说明拿到的是别的实现（或包根转出撞了名）。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, Button, Card, CardContent, CardFooter, CardHeader, CardTitle, Separator } from '../index';

describe('vendored 原语从包根渲染', () => {
  it('Button 渲染成 button，并带 data-slot="button"', () => {
    render(<Button>确认</Button>);
    const button = screen.getByRole('button', { name: '确认' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('data-slot', 'button');
    // base-ui 的 button 原语自带 `type="button"`：默认的 submit 会让按钮出现在表单里就提交
    expect(button).toHaveAttribute('type', 'button');
  });

  it('Card 的各段各自带自己的 data-slot', () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>标题</CardTitle>
        </CardHeader>
        <CardContent>正文</CardContent>
        <CardFooter>脚注</CardFooter>
      </Card>,
    );
    for (const slot of ['card', 'card-header', 'card-title', 'card-content', 'card-footer']) {
      expect(container.querySelector(`[data-slot="${slot}"]`), `缺少 data-slot="${slot}"`).not.toBeNull();
    }
    expect(screen.getByText('正文')).toBeInTheDocument();
  });

  it('Badge 渲染成 span，并带 data-slot="badge"', () => {
    render(<Badge>草稿</Badge>);
    const badge = screen.getByText('草稿');
    expect(badge.tagName).toBe('SPAN');
    // Badge 走 base-ui 的 `useRender`：`data-slot` 由 `state.slot` 推导，不是手写的 JSX 属性
    expect(badge).toHaveAttribute('data-slot', 'badge');
  });

  it('Separator 渲染出 data-slot="separator"', () => {
    const { container } = render(<Separator />);
    const separator = container.querySelector('[data-slot="separator"]');
    expect(separator).not.toBeNull();
    expect(separator).toHaveAttribute('data-orientation', 'horizontal');
  });
});
