/**
 * SkillTable：三列的列内容、行点击开抽屉、两处固定列与横向滚动、工具条（路径 + 计数 + 重新扫描）、
 * 两套空态文案，以及开关的「不做乐观翻转 / 不可用也能切」两条口径。
 *
 * 断言口径与 `provider-table.test.tsx` / `mcp-server-table.test.tsx` 同款：全走「用户能看到什么」，
 * 只有两处必须查类名（`ant-table-cell-fix-start` / `-fix-end` 是 jsdom 里「这一列到底钉没钉」
 * 唯一可观察的信号）。
 *
 * ⚠️ **不在这个文件里假装量几何**：jsdom 的 `getBoundingClientRect()` 恒为 0，没有布局引擎。
 * 这里钉的是「列定义与两处 fixed 的存在」，真实吸边与横向滚动留真机冒烟。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SkillEntry } from '@aieval/contracts';
import { installResizeObserverStub } from '../testing/resize-observer';
import { SkillTable } from './skill-table';

// jsdom 没有 ResizeObserver，antd 的 Table 与 Typography 的 ellipsis 内部会直接 new 它
beforeEach(() => {
  installResizeObserverStub();
});

const ROOT = '/home/u/.aieval/skills';

/** 三条真实形态：一条合格、一条缺 SKILL.md、一条名字不合法（描述都非空，避免空字符串断言失效） */
const SKILLS: SkillEntry[] = [
  {
    name: 'alpha-skill',
    dir: `${ROOT}/alpha-skill`,
    description: '第一件技能',
    ok: true,
    disabled: false,
  },
  {
    name: 'broken-skill',
    dir: `${ROOT}/broken-skill`,
    description: '',
    ok: false,
    reason: '缺 SKILL.md（技能是一个目录，里面放 SKILL.md；只扫这一层，不递归）',
    disabled: true,
  },
  {
    name: 'Bad_Name',
    dir: `${ROOT}/Bad_Name`,
    description: '名字不合法的那条',
    ok: false,
    reason: '名称不合法：Bad_Name（只允许小写字母、数字与单个连字符，最长 64）',
    disabled: false,
  },
];

describe('SkillTable：三列与固定列', () => {
  it('三列成立：名称 / 描述 / 启用（没有来源路径列、没有操作列）', () => {
    render(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={vi.fn()} />,
    );

    for (const title of ['名称', '描述', '启用']) {
      expect(screen.getByRole('columnheader', { name: title })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.queryByRole('columnheader', { name: '来源路径' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: '操作' })).toBeNull();
  });

  it('名称列钉左、启用列钉右，表格宽度是各列声明宽度之和', () => {
    const { container } = render(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={vi.fn()} />,
    );

    const headers = screen.getAllByRole('columnheader');
    expect(headers[0]?.style.position).toBe('sticky');
    expect(headers[0]?.style.left).toBe('0px');
    expect(headers[2]?.style.position).toBe('sticky');
    expect(headers[2]?.style.right).toBe('0px');
    // 220 + 320 + 90：固定列的偏移输入就是这些声明值
    const table = container.querySelector('table');
    expect(table?.style.width).toBe('630px');
  });

  it('每行显名称与描述，不可用的挂红标签（原因在 Tooltip 里）', async () => {
    render(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={vi.fn()} />,
    );

    expect(screen.getByText('alpha-skill')).toBeInTheDocument();
    expect(screen.getByText('第一件技能')).toBeInTheDocument();
    // 两条不可用 ⇒ 两个红标签；合格的那条没有
    expect(screen.getAllByTestId('skill-bad-tag')).toHaveLength(2);
    // 原因**不占一列**（三列的定义不能因为它变样），只在标签的 Tooltip 里——antd 的 Tooltip
    // 是悬停才挂载的，所以必须先 mouseEnter 再断言，否则这条断言恒假（它自己就是「悬停可见」的验证）
    fireEvent.mouseEnter(screen.getAllByTestId('skill-bad-tag')[0] as HTMLElement);
    await waitFor(() =>
      expect(
        screen.getByText('缺 SKILL.md（技能是一个目录，里面放 SKILL.md；只扫这一层，不递归）'),
      ).toBeInTheDocument(),
    );
  });
});

describe('SkillTable：工具条', () => {
  it('工具条三件在场：技能目录路径 + 计数 + 重新扫描；**没有**「上次扫描时间」', () => {
    render(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={vi.fn()} />,
    );

    expect(screen.getByText(ROOT)).toBeInTheDocument();
    expect(screen.getByTestId('skill-count')).toHaveTextContent('共 3 条，其中 2 条不可用');
    expect(screen.getByRole('button', { name: /重新扫描/ })).toBeInTheDocument();
    expect(screen.queryByText(/上次扫描/)).toBeNull();
  });

  it('全可用时计数只说条数（不写「其中 0 条不可用」）', () => {
    render(
      <SkillTable skills={[SKILLS[0] as SkillEntry]} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={vi.fn()} />,
    );

    expect(screen.getByTestId('skill-count')).toHaveTextContent('共 1 条');
    expect(screen.getByTestId('skill-count')).not.toHaveTextContent('不可用');
  });

  it('「重新扫描」把动作交出去（组件自己不调接口）', () => {
    const onRescan = vi.fn();
    render(<SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={onRescan} onToggle={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /重新扫描/ }));

    expect(onRescan).toHaveBeenCalledTimes(1);
  });
});

describe('SkillTable：开关与行点击', () => {
  it('开关读服务端算好的 disabled（关着的不显示为开），可访问名带行名', () => {
    render(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={vi.fn()} />,
    );

    expect(screen.getByRole('switch', { name: '启用 alpha-skill' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 broken-skill' })).not.toBeChecked();
  });

  it('点开关交出去的是这一行 + **期望状态**（开着的点一下 ⇒ disabled:true）', () => {
    const onToggle = vi.fn();
    render(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={onToggle} />,
    );

    fireEvent.click(screen.getByRole('switch', { name: '启用 alpha-skill' }));
    expect(onToggle.mock.calls[0]?.[0]).toMatchObject({ name: 'alpha-skill' });
    // 交出去的是「要不要停用」这个布尔，不是 `checked`：开关这一格的名字叫「启用」，
    // 而落盘/补丁那两个 schema 收的是 disabled —— 在这里翻一次就不必让每个调用方各翻一次
    expect(onToggle.mock.calls[0]?.[1]).toBe(true);

    fireEvent.click(screen.getByRole('switch', { name: '启用 broken-skill' }));
    expect(onToggle.mock.calls[1]?.[0]).toMatchObject({ name: 'broken-skill' });
    expect(onToggle.mock.calls[1]?.[1]).toBe(false);
  });

  it('不可用的条目**仍可切**：开关是用户的意图，不因当前磁盘状态而丢', () => {
    // 目录名不合法 / 缺 SKILL.md 的那条现在装不上，但「我要停用它」是一个该被记住的意图：
    // 用户把目录修好之后，那个开关立刻生效。禁用它的表现是「修好了还得回来再点一次」
    const onToggle = vi.fn();
    render(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={onToggle} />,
    );

    const toggle = screen.getByRole('switch', { name: '启用 Bad_Name' });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('不做乐观翻转：点一下不改自己那一格，checked 仍然只读服务端给的 disabled', () => {
    // 失败时要保持原值（父层的 update 失败 ⇒ 这份 props 不变 ⇒ 开关停在原处）。
    // 组件自己留一份 state 的话，失败时就会「翻转了再翻回去」，用户以为是自己点错了
    const onToggle = vi.fn();
    const { rerender } = render(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={onToggle} />,
    );

    const toggle = screen.getByRole('switch', { name: '启用 alpha-skill' });
    fireEvent.click(toggle);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(toggle).toBeChecked();
    rerender(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={onToggle} />,
    );
    expect(screen.getByRole('switch', { name: '启用 alpha-skill' })).toBeChecked();
  });

  it('点开关**不**触发「点一行开抽屉」：写入口不该顺手把预览抽屉顶开', () => {
    // 行本身是抽屉的入口（`onRow` 的 onClick），而开关住在行里 ⇒ 不掐断冒泡的话，
    // 每切一次启停都会弹出一个盖住表格的抽屉，用户下一步只能先关掉它
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(
      <SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={onOpen} onRescan={vi.fn()} onToggle={onToggle} />,
    );

    fireEvent.click(screen.getByRole('switch', { name: '启用 alpha-skill' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen, '开关的点击冒泡到了行上，把抽屉顶开了').not.toHaveBeenCalled();
  });

  it('点一行开抽屉：交出去的是这一行的条目', () => {
    const onOpen = vi.fn();
    render(<SkillTable skills={SKILLS} skillWarnings={[]} root={ROOT} onOpen={onOpen} onRescan={vi.fn()} onToggle={vi.fn()} />);

    fireEvent.click(screen.getByText('Bad_Name'));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]).toMatchObject({ name: 'Bad_Name', ok: false });
  });
});

describe('SkillTable：两套空态', () => {
  it('目录还不存在 ⇒ 「技能目录还不存在」+ 路径（不是「还没有技能」）', () => {
    render(
      <SkillTable
        skills={[]}
        skillWarnings={[{ path: ROOT, reason: '技能目录还不存在' }]}
        root={ROOT}
        onOpen={vi.fn()}
        onRescan={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    const empty = screen.getByText('技能目录还不存在').closest('[data-slot="empty"]') ?? document.body;
    expect(within(empty as HTMLElement).getByText(`把一个技能目录放进这里即可：${ROOT}`)).toBeInTheDocument();
    expect(screen.queryByText('这个目录里还没有技能')).toBeNull();
  });

  it('目录空（没有根级 warning）⇒ 「这个目录里还没有技能」', () => {
    render(
      <SkillTable skills={[]} skillWarnings={[]} root={ROOT} onOpen={vi.fn()} onRescan={vi.fn()} onToggle={vi.fn()} />,
    );

    expect(screen.getByText('这个目录里还没有技能')).toBeInTheDocument();
    expect(screen.queryByText('技能目录还不存在')).toBeNull();
  });
});
