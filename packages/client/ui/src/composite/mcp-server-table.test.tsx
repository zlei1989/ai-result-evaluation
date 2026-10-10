/**
 * McpServerTable：五列的列内容、启停回调、删除的二次确认（含后果文案）、空态引导、静态说明，
 * 以及**两处固定列与横向滚动**这条形态守卫。
 *
 * 断言口径与 `provider-table.test.tsx` 同款：全部走「用户能看到什么」，只有两处必须查类名
 * （`ant-table-cell-fix-start` / `-fix-end` 是 jsdom 里「这一列到底钉没钉」唯一可观察的信号）。
 *
 * ⚠️ **不在这个文件里假装量几何**：jsdom 的 `getBoundingClientRect()` 恒为 0，没有布局引擎。
 * 这里钉的是「列定义与两处 `fixed` 的存在」（五列 → 五个表头、首末带粘性类、表格拿到最小宽度），
 * 真实吸边与滚动留真机冒烟（口径见 `docs/guard/smoke-testing.md`）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { McpProbeResult, McpServers } from '@aieval/contracts';
import { McpServerTable, endpointText, hasConfiguredSecret, removeServer, upsertServer } from './mcp-server-table';
import { installResizeObserverStub } from '../testing/resize-observer';

/** 一次成功的探活结论（形状来自 contracts；结果区怎么渲染由 `mcp-probe-result.test.tsx` 钉） */
const PROBE_OK: McpProbeResult = {
  ok: true,
  tier: 'http+call',
  serverName: 'Context7',
  serverVersion: '4.3.0',
  toolCount: 2,
  elapsedMs: 1610,
  notes: [],
};

// jsdom 没有 ResizeObserver，antd 的 Table 与 Typography 的 ellipsis 内部会直接 new 它
beforeEach(() => {
  installResizeObserverStub();
});

/**两台真实预置项的形状：一台 http 带敏感头、一台 stdio 不带密钥 */
const servers: McpServers = {
  context7: {
    transport: 'http',
    enabled: true,
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: 'ctx7-***-0001' },
  },
  playwright: {
    transport: 'stdio',
    enabled: false,
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--browser=chrome', '--isolated'],
  },
};

const noop = (): void => {};

describe('endpointText / hasConfiguredSecret（纯函数，表格与用例共用同一份口径）', () => {
  it('http 显 URL，stdio 显 command 加全部参数', () => {
    expect(endpointText(servers.context7 as McpServers[string])).toBe('https://mcp.context7.com/mcp');
    expect(endpointText(servers.playwright as McpServers[string])).toBe(
      'npx -y @playwright/mcp@latest --browser=chrome --isolated',
    );
  });

  it('stdio 没有 args 时只显 command，不留一个尾随空格', () => {
    expect(endpointText({ transport: 'stdio', enabled: true, command: 'uvx' })).toBe('uvx');
  });

  it('「已配置密钥」只看敏感键且值非空：空串（未配置）不算、非敏感键不算', () => {
    expect(hasConfiguredSecret(servers.context7 as McpServers[string])).toBe(true);
    // stdio 那条连 env 都没有
    expect(hasConfiguredSecret(servers.playwright as McpServers[string])).toBe(false);
    // 非敏感键（NODE_ENV）不是密钥
    expect(hasConfiguredSecret({ transport: 'stdio', enabled: true, command: 'npx', env: { NODE_ENV: 'production' } })).toBe(
      false,
    );
    // 界面据此区分「未配置」与「已配置但隐藏」：空串是未配置
    expect(hasConfiguredSecret({ transport: 'http', enabled: true, url: 'u', headers: { 'X-Auth': '' } })).toBe(false);
  });
});

describe('McpServerTable', () => {
  it('五列成立：名称 / 传输 / 端点或命令 / 状态 / 操作', () => {
    render(<McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);

    for (const title of ['名称', '传输', '端点或命令', '状态', '操作']) {
      expect(screen.getByRole('columnheader', { name: title })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('columnheader')).toHaveLength(5);
  });

  it('每行显名称 / 传输 Tag / 端点或命令，且顺序 = 落盘顺序', () => {
    render(<McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);

    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3); // 表头 + 两条
    const first = within(rows[1] as HTMLElement);
    const second = within(rows[2] as HTMLElement);
    expect(first.getByText('context7')).toBeInTheDocument();
    expect(first.getByText('http')).toBeInTheDocument();
    expect(first.getByText('https://mcp.context7.com/mcp')).toBeInTheDocument();
    expect(second.getByText('playwright')).toBeInTheDocument();
    expect(second.getByText('stdio')).toBeInTheDocument();
    expect(second.getByText('npx -y @playwright/mcp@latest --browser=chrome --isolated')).toBeInTheDocument();
  });

  it('密钥只出「已配置密钥」小标：掩码本体不出现在表里（没有密钥列）', () => {
    render(<McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);

    // 一台配了敏感头、一台没配 ⇒ 恰好一个小标（不是每行都有）
    expect(screen.getAllByTestId('mcp-secret-tag')).toHaveLength(1);
    expect(within(screen.getAllByRole('row')[1] as HTMLElement).getByText('已配置密钥')).toBeInTheDocument();
    // 掩码串不许出现在表格里：密钥本体只在表单弹窗里以掩码出现
    expect(screen.queryByText('ctx7-***-0001')).toBeNull();
    expect(screen.queryByText('CONTEXT7_API_KEY')).toBeNull();
  });

  /**
 * 卡片内那条**静态说明**（「卡片头部一条静态说明」）。
 *
 * 三件事各自都会静默退化：① 文案被改写成自己的话（用户读到的就不再是规格里那三句）；
 * ② 落点飘到卡片外（页面层再印一份 = 两处真源，措辞迟早漂移）；③ 用告警样式渲染
 * （`type="info"` 的 Alert 也会让人以为「我的配置出问题了」，而它说的是**永远成立**的优先级关系）。
 * 「永远显示」由渲染本身证明：这里没有任何 loading / error 态，直接就要求它在。
 */
  it('卡片内那条静态说明常显：正文样式、在表格上方、且在卡片里（不是页面层的告警）', () => {
    render(<McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);

    const note = screen.getByTestId('mcp-priority-note');
    expect(note).toHaveTextContent(
      '同名时以设置页为准；仓库自带的其它条目仍会生效；要改仓库自带的那条得去改那个仓库',
    );
    // 落点：卡片**里**（页面层那份与卡片是兄弟节点，`closest` 当场分得开）
    expect(note.closest('[data-testid="mcp-server-table-card"]')).not.toBeNull();
    // 正文样式而不是告警：antd 的次级文本类名 + 不在任何一个 Alert 容器里
    expect(note.className).toContain('ant-typography-secondary');
    expect(note.closest('.ant-alert')).toBeNull();
    // 表格**上方**：DOM 顺序上说明先于表格（`FOLLOWING` = 表格在它之后）
    const table = screen.getByRole('table');
    expect(note.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('状态列是内联 Switch，翻转把行名与新状态交给调用方', () => {
    const onToggle = vi.fn();
    render(<McpServerTable servers={servers} onToggle={onToggle} onEdit={noop} onDelete={noop} onCreate={noop} />);

    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    // 停用是「弱化但不隐藏」：那条仍然在表里，只是开关是关的
    expect(switches[1]).not.toBeChecked();

    fireEvent.click(switches[1] as HTMLElement);

    expect(onToggle).toHaveBeenCalledWith('playwright', true);
  });

  /**
 * 停用行的**弱化信号**（「停用：整行弱化但**不隐藏**」）——判据两半，缺一条就会退化成
 * 规格说的那半边没做：
 * ① 名称那一格带 antd 的次级语义类（jsdom 里「弱化了」唯一可观察的信号，颜色算不出来）；
 * ② 「端点或命令」那一格**不在**次级色里——整行加灰会把排障时要读的那行命令一起涂淡，
 * 而它是这一行唯一的身份信息（这正是当初不加整行灰的理由，见组件文件头第 2 点）。
 * 真实观感（对比度、dark 态）留真机冒烟：jsdom 没有布局引擎，这条只钉语义类。
 */
  it('停用行只弱化名称那一格：名称带次级色，端点与命令照旧可读', () => {
    render(<McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);

    const rows = screen.getAllByRole('row');
    /**
 * 第 `index` 列里那个 antd Typography 元素：次级色是挂在它身上的类
 * （`getByText` 会命中它内部的 `<strong>`，那个内层元素上没有类，拿它断言等于永远为真）。
 */
    const typographyIn = (row: HTMLElement, index: number): Element | null =>
      row.querySelectorAll('td')[index]?.querySelector('.ant-typography') ?? null;

    const disabledName = typographyIn(rows[2] as HTMLElement, 0);
    const enabledName = typographyIn(rows[1] as HTMLElement, 0);
    expect(disabledName, '名称格里没有 Typography 元素（列形态变了？）').not.toBeNull();
    expect(enabledName, '名称格里没有 Typography 元素（列形态变了？）').not.toBeNull();

    expect(disabledName?.className, '停用行没有弱化信号（名称格不是次级色）').toContain(
      'ant-typography-secondary',
    );
    // 反向判据：启用的那行**不许**跟着变淡（否则「弱化」就成了一句永远为真的话）
    expect(enabledName?.className, '启用行也被涂淡了').not.toContain('ant-typography-secondary');

    const endpoint = typographyIn(rows[2] as HTMLElement, 2);
    expect(endpoint?.textContent, '停用行的端点或命令不见了——那是排障时要读的字').toBe(
      'npx -y @playwright/mcp@latest --browser=chrome --isolated',
    );
    expect(endpoint?.className, '端点或命令跟着变淡了——那是排障时要读的字').not.toContain(
      'ant-typography-secondary',
    );
  });

  it('点「编辑」把整行（名字 + 条目）回给调用方', () => {
    const onEdit = vi.fn();
    render(<McpServerTable servers={servers} onToggle={noop} onEdit={onEdit} onDelete={noop} onCreate={noop} />);

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1] as HTMLElement);

    expect(onEdit).toHaveBeenCalledWith({ name: 'playwright', config: servers.playwright });
  });

  it('删除必须过一次 Popconfirm，且确认文案点明「候选执行时就没了」', async () => {
    const onDelete = vi.fn();
    render(<McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={onDelete} onCreate={noop} />);

    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0] as HTMLElement);
    // 只点「删除」不触发：误点一次不该少一台服务器
    expect(onDelete).not.toHaveBeenCalled();
    expect(await screen.findByText('删除后这些工具在候选执行时就没了。')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));

    expect(onDelete).toHaveBeenCalledWith({ name: 'context7', config: servers.context7 });
  });

  it('操作列顺序是 编辑 → 测试连接 → 删除，三个按钮都不插空格', () => {
    render(
      <McpServerTable
        servers={servers}
        onToggle={noop}
        onEdit={noop}
        onDelete={noop}
        onCreate={noop}
        onTest={async () => PROBE_OK}
      />,
    );

    const names = ['编辑', '测试连接', '删除'];
    const buttons = names.map((name) => screen.getAllByRole('button', { name })[0] as HTMLElement);
    for (let index = 1; index < buttons.length; index += 1) {
      expect(buttons[index - 1]?.compareDocumentPosition(buttons[index] as HTMLElement)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    // 「编辑」与「删除」都是两个汉字：漏一个 `autoInsertSpace={false}`，可访问名会变成「编 辑」/
    // 「删 除」（antd 只在恰好两个 CJK 字时插空格），上面那三条按名字定位会失配。
    // 用 queryAll 而不是 getAll：这条断言期望的是**零**个带空格的二字按钮，getAll 找不到时直接抛。
    expect(screen.queryAllByRole('button', { name: /^[^ ] [^ ]$/ })).toHaveLength(0);
    // 数量对齐表体行数（2 行 × 2 个二字按钮）—— 表头那个四字的「添加」不在此列，故意不计入
    expect(screen.getAllByRole('button', { name: /^(编辑|删除)$/ })).toHaveLength(4);
  });

  /**
   * 「测试连接」是真的接上了（结果区在下面那组用例里）；没有 `onTest` 时仍**禁用**，
   * 而不是留一个点了没反应的按钮 —— 后者读起来就是「功能坏了」。
   */
  it('没有 onTest 时「测试连接」禁用并说明当前不可用；给了 onTest 就可用并把整行交出去', () => {
    const { unmount } = render(
      <McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />,
    );
    expect(screen.getAllByRole('button', { name: '测试连接' })[0]).toBeDisabled();
    // 禁用时要说明原因（可见的 title），不能让用户对着灰按钮猜
    expect(screen.getAllByRole('button', { name: '测试连接' })[0]).toHaveAttribute('title', '当前不可用');
    unmount();

    const onTest = vi.fn(async () => PROBE_OK);
    render(
      <McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} onTest={onTest} />,
    );
    const button = screen.getAllByRole('button', { name: '测试连接' })[0] as HTMLElement;
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(onTest).toHaveBeenCalledWith({ name: 'context7', config: servers.context7 });
  });

  it('空态给「还没有配置 MCP 服务器。」+ 预置说明 + 引导动作', () => {
    const onCreate = vi.fn();
    render(<McpServerTable servers={{}} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={onCreate} />);

    expect(screen.getByText('还没有配置 MCP 服务器。')).toBeInTheDocument();
    expect(screen.getByText('默认会预置 context7 与 playwright')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加第一台' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  /**
 * 空态摆的是**与卡片头部同一组入口**（两处都要有「添加」与「粘贴 JSON」）。
 * 名字相同 ⇒ 空态与头部两颗都在 DOM 里，故这条按「两颗都得禁用且都说明原因」来钉，
 * 下一条再钉「接上回调后两颗都点得动」。
 */
  it('空态的「粘贴 JSON」与头部那颗同款：没接回调时禁用并说明原因', () => {
    render(<McpServerTable servers={{}} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);

    const pastes = screen.getAllByRole('button', { name: '粘贴 JSON' });
    expect(pastes).toHaveLength(2);
    for (const button of pastes) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', '粘贴入口还没接上');
    }
  });

  it('空态与头部的「粘贴 JSON」接上回调后都触发同一个 onPasteJson', () => {
    const onPasteJson = vi.fn();
    render(
      <McpServerTable servers={{}} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} onPasteJson={onPasteJson} />,
    );

    for (const button of screen.getAllByRole('button', { name: '粘贴 JSON' })) {
      fireEvent.click(button);
    }

    expect(onPasteJson).toHaveBeenCalledTimes(2);
  });

  it('卡片头部右侧的「添加」触发 onCreate', () => {
    const onCreate = vi.fn();
    render(<McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  /**
   * `upsertServer` / `removeServer`：整份替换语义下「改名 = 挪 map 键」那一步的唯一落点。
   * 旧键不消失的话界面会留一条谁也删不掉的幽灵条目（刷新才没）——而它在 DOM 上完全看不出来。
   */
  it('upsertServer：新增追加在末尾、同名覆盖、改名把旧键挪走（旧键不留幽灵）', () => {
    // 新增：previousName = null，追加在末尾
    const added = upsertServer(servers, null, 'filesystem', { transport: 'stdio', enabled: true, command: 'npx' });
    expect(Object.keys(added)).toEqual(['context7', 'playwright', 'filesystem']);
    // 覆盖同名：值换新、位置挪到末尾（JSON 保持插入顺序 ⇒ 界面顺序 = 落盘顺序）
    const overwritten = upsertServer(servers, 'context7', 'context7', {
      transport: 'http',
      enabled: false,
      url: 'https://x/mcp',
    });
    expect(Object.keys(overwritten)).toEqual(['playwright', 'context7']);
    expect(overwritten.context7).toEqual({ transport: 'http', enabled: false, url: 'https://x/mcp' });
    // 改名：旧键必须消失（只传新名字的话这里会留下 context7 这条幽灵）
    const renamed = upsertServer(servers, 'context7', 'ctx7', servers.context7 as McpServers[string]);
    expect(Object.keys(renamed)).toEqual(['playwright', 'ctx7']);
    expect('context7' in renamed).toBe(false);
    // 入参不许被就地改写（界面上的列表与将要落盘的那份不能共享引用）
    expect(Object.keys(servers)).toEqual(['context7', 'playwright']);
  });

  it('removeServer：删掉那一条并返回新 map，入参不变', () => {
    const next = removeServer(servers, 'context7');
    expect(Object.keys(next)).toEqual(['playwright']);
    expect(Object.keys(servers)).toEqual(['context7', 'playwright']);
    // 删不存在的名字：原样返回一份等值的新 map（不抛、也不凭空造键）
    expect(Object.keys(removeServer(servers, 'nope'))).toEqual(['context7', 'playwright']);
  });

  /**
 * 形态守卫（五列 + 两处固定，与供应商表 `P-COLUMN-FIXED` 同款）：
 * 三处必须同时在场，少一处就静默退回「被压扁 / 滚出去够不到」的老样子。
 * 钉的到类名、内联样式与 `colgroup` 宽度为止 —— 真实几何只有真机量得出来（见文件头）。
 */
  it('卡片装不下时横向滚动，且名称列钉左、操作列钉右（MCP-COLUMN-FIXED）', () => {
    const { container } = render(
      <McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />,
    );

    const content = container.querySelector('.ant-table-content');
    expect(content).not.toBeNull();
    // 有横向滚动才谈得上固定列：给 `scroll.x` 之前这里一个内联样式都没有
    expect(content).toHaveStyle({ overflowX: 'auto' });
    const table = content?.querySelector('table');
    // 最小宽度必须真的落到**表格自己**的宽度上：`min-width: 100%` 保证卡片够宽时铺满、不给滚动条
    expect(table).toHaveStyle({ width: '910px', minWidth: '100%', tableLayout: 'fixed' });

    const headers = content?.querySelectorAll('thead th');
    expect(headers).toHaveLength(5);
    // 刚需的两条粘性类（`-fix-start` / `-fix-end` 就是 `position: sticky` 的来源）
    expect(headers?.[0]?.className).toContain('ant-table-cell-fix-start');
    expect(headers?.[4]?.className).toContain('ant-table-cell-fix-end');
    // 中间三列**不许**粘：把端点列也钉住的话，可滚动区域就只剩传输与状态两列
    for (const index of [1, 2, 3]) {
      expect(headers?.[index]?.className).not.toContain('ant-table-cell-fix');
    }
    // 表体跟着一起钉（只钉表头的话，数据行会在固定列底下滑过去，滚动时表头与数据行错位）
    const bodyCells = content?.querySelector('tbody tr.ant-table-row')?.querySelectorAll('td');
    expect(bodyCells?.[0]?.className).toContain('ant-table-cell-fix-start');
    expect(bodyCells?.[4]?.className).toContain('ant-table-cell-fix-end');

    // 四列把宽度交出去，剩下的才归「端点或命令」（它**刻意不给宽度**，是唯一吃剩余宽度的列）。
    // jsdom 量不出真实宽度（rc-table 的 MeasureCell 靠 ResizeObserver 回调，而替身从不回调），
    // 故这里只钉得住「四列各自申报的宽度」与「端点列一列都没申报」。
    const widths = Array.from(content?.querySelectorAll('colgroup col') ?? []).map(
      (cell) => (cell as HTMLElement).style.width,
    );
    // 名称列 190（不是 150）：那格里住着名称与「已配置密钥」小标两样东西，150 会把主标识挤成
    // `conte…`（见 `MCP_COLUMN_WIDTH` 的注释）
    expect(widths).toEqual(['190px', '110px', '', '90px', '200px']);
  });

  /**
   * 卡片头部的第二个入口「粘贴 JSON」（弹窗本体在 `mcp-paste-modal`）：
   * 与「测试连接」同一条口径 —— 没接回调时**禁用并说明原因**，而不是摆一个点了没反应的按钮。
   */
  it('卡片头部的「粘贴 JSON」触发 onPasteJson；没接回调时禁用并说明原因', () => {
    const { unmount } = render(<McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);
    const disabled = screen.getByRole('button', { name: '粘贴 JSON' });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveAttribute('title', '粘贴入口还没接上');
    unmount();

    const onPasteJson = vi.fn();
    render(
      <McpServerTable
        servers={servers}
        onToggle={noop}
        onEdit={noop}
        onDelete={noop}
        onCreate={noop}
        onPasteJson={onPasteJson}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '粘贴 JSON' }));

    expect(onPasteJson).toHaveBeenCalledTimes(1);
  });

  /** 形态守卫：两个入口都在**卡片头部**（别处再摆一份会让「这张卡片有哪些动作」有两个答案），且顺序是 添加 → 粘贴 JSON */
  it('两个入口都在卡片头部，顺序是 添加 → 粘贴 JSON', () => {
    const { container } = render(
      <McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} onPasteJson={noop} />,
    );

    const extra = container.querySelector('.ant-card-extra');
    expect(extra).not.toBeNull();
    expect(Array.from(extra?.querySelectorAll('button') ?? []).map((button) => button.textContent)).toEqual([
      '添加',
      '粘贴 JSON',
    ]);
  });

  /** 形态守卫：卡片头部的「添加」与空态引导都是「前导加号 + 虚线」（antd 6 单给 `variant` 会被静默降级成实线） */
  it('两个新增入口都是加号 + 虚线（全站新增形态），且图标不污染可访问名', () => {
    render(<McpServerTable servers={{}} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);

    for (const name of ['添加', '添加第一台']) {
      const button = screen.getByRole('button', { name });
      expect(button.className).toContain('ant-btn-variant-dashed');
      expect(button.querySelector('.anticon-plus')).toHaveAttribute('aria-hidden', 'true');
    }
  });
});

/**
 * 「测试连接」的接线与结果区。
 * 断言口径：用户看得到的东西 —— 按钮转不转、结果区在不在**那一行下方**、其它动作还能不能点。
 * 组件**不调接口**：请求由 `onTest` 注入，这里给的就是一个 Promise 替身。
 */
describe('测试连接：行内结果区', () => {
  it('点下去按钮进入 loading，结论就地在该行下方展开（成功与失败都展开）', async () => {
    let release: (result: McpProbeResult) => void = () => {};
    const onTest = vi.fn(() => new Promise<McpProbeResult>((resolve) => (release = resolve)));
    render(
      <McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} onTest={onTest} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '测试连接' })[0] as HTMLElement);

    // 请求还没回来：结果区已经在那一行下方，写的是「测试中…」而不是空白
    expect(screen.getByTestId('mcp-probe-waiting')).toBeInTheDocument();
    expect(await screen.findByTestId('mcp-probe-waiting')).toBeInTheDocument();

    release(PROBE_OK);

    expect(await screen.findByText('连通：Context7 4.3.0，声明 2 个工具（耗时 1.6 s）')).toBeInTheDocument();
    // 转完了：按钮不再 loading，结果区里也不再是「测试中…」
    expect(screen.queryByTestId('mcp-probe-waiting')).not.toBeInTheDocument();
  });

  it('这一行在测时，该行其它动作禁用；别的行照常可用（不阻塞其它行）', () => {
    const onTest = vi.fn(() => new Promise<McpProbeResult>(() => {}));
    render(
      <McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} onTest={onTest} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '测试连接' })[0] as HTMLElement);

    // 按行定位而不是按下标：loading 中的按钮可访问名会带上 antd 的 loading 图标标签
    //（`loading 测试连接`），按下标取会取错行 —— 而这条用例要分清的正是「哪一行被锁住」
    const rowOf = (text: string): HTMLElement =>
      screen.getAllByRole('row').find((row) => row.textContent?.includes(text)) as HTMLElement;

    // 第 0 行（context7）在测：它的编辑 / 删除 / 启停都禁用
    const testing = rowOf('context7');
    expect(within(testing).getByRole('button', { name: '编辑' })).toBeDisabled();
    expect(within(testing).getByRole('button', { name: '删除' })).toBeDisabled();
    expect(within(testing).getByRole('switch', { name: '启用 context7' })).toBeDisabled();
    // 正在测的那个按钮不是靠 `disabled` 属性拦的（antd 的 loading 走 `ant-btn-loading` +
    // `pointer-events: none`），故这里钉的是那个类 —— 钉 `toBeDisabled()` 会红，而红的原因是
    // 「我们钉错了属性」，不是「按钮真能被点第二次」
    expect(within(testing).getByRole('button', { name: /测试连接$/ }).className).toContain('ant-btn-loading');

    // 第 1 行（playwright）不受影响：停用条目**仍可测**
    const other = rowOf('@playwright/mcp');
    expect(within(other).getByRole('button', { name: '编辑' })).toBeEnabled();
    expect(within(other).getByRole('button', { name: '测试连接' })).toBeEnabled();
  });

  it('停用条目仍可测：结果照常展开（「已停用，不会注入」由服务端放进 notes）', async () => {
    const withNote: McpProbeResult = { ...PROBE_OK, tier: 'A', notes: ['已停用，不会注入'] };
    const onTest = vi.fn(async () => withNote);
    render(
      <McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} onTest={onTest} />,
    );

    // playwright 那行是 enabled: false
    fireEvent.click(screen.getAllByRole('button', { name: '测试连接' })[1] as HTMLElement);

    expect(await screen.findByText('已停用，不会注入')).toBeInTheDocument();
    expect(onTest).toHaveBeenCalledWith({ name: 'playwright', config: servers.playwright });
  });

  it('请求本身失败（onTest 抛错）⇒ 说清是「测试请求失败」并带中文原因，不冒充探活档次', async () => {
    const onTest = vi.fn(async () => {
      throw new Error('MCP 服务器「context7」不在配置里，先保存再测');
    });
    render(
      <McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} onTest={onTest} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '测试连接' })[0] as HTMLElement);

    expect(
      await screen.findByText('测试请求失败：MCP 服务器「context7」不在配置里，先保存再测'),
    ).toBeInTheDocument();
  });

  it('结果区不给表格加列：仍是五列表头（展开列必须藏着，否则五列的定义当场变了）', async () => {
    const onTest = vi.fn(async () => PROBE_OK);
    render(
      <McpServerTable servers={servers} onToggle={noop} onEdit={noop} onDelete={noop} onCreate={noop} onTest={onTest} />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '测试连接' })[0] as HTMLElement);
    await screen.findByTestId('mcp-probe-result');

    expect(screen.getAllByRole('columnheader')).toHaveLength(5);
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '名称',
      '传输',
      '端点或命令',
      '状态',
      '操作',
    ]);
  });
});
