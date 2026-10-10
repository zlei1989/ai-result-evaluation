/**
 * 「粘贴 JSON」弹窗：预览逐条说清将要发生什么、同名默认覆盖且逐行可切跳过、先清空是默认关的、
 * 确认交出的是一份**算好的整份 map**（一次原子落盘的入口）。
 *
 * 断言口径与其它弹窗用例一致：全部走「用户看到什么、点下去交出了什么」。
 * 解析本身（五步判别 / 条目化 / 上限）由 `contracts` 的表驱动用例钉住，这里只钉**接线与呈现**：
 * 预览有没有把「覆盖 / 跳过 / 不导入+原因 / 被丢字段」说出来、计数对不对、交出去的 map 是不是那一份。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MCP_PASTE_MAX_BYTES, MCP_PASTE_SHAPE_EXAMPLES, type McpServers } from '@aieval/contracts';
import { McpPasteModal } from './mcp-paste-modal';
import { installResizeObserverStub } from '../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
});

/** 一台已配置的 http 服务器：用来验「同名默认覆盖」与「先清空」 */
const servers: McpServers = {
  context7: { transport: 'http', enabled: true, url: 'https://mcp.context7.com/mcp' },
};

const noop = (): void => {};

/** 贴入一段文本：唯一的入口就是那个多行文本域 */
function paste(text: string): void {
  fireEvent.change(screen.getByLabelText('粘贴内容'), { target: { value: text } });
}

describe('McpPasteModal：预览 → 确认导入', () => {
  it('预览逐条给出名称 / 传输 / 端点或命令 / 处置 / 被丢字段，确认交出一份整份 map', async () => {
    const onImport = vi.fn();
    render(<McpPasteModal open servers={servers} saving={false} onImport={onImport} onCancel={noop} />);

    paste(
      '{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"], "alwaysAllow": ["read"] } } }',
    );

    expect(await screen.findByText('filesystem')).toBeInTheDocument();
    // 预览表真的出来了（下面「超限时不出预览」那条断言靠它才不是空断言）
    expect(screen.getByTestId('mcp-paste-preview')).toBeInTheDocument();
    expect(screen.getByText('stdio')).toBeInTheDocument();
    expect(screen.getByText('npx -y @modelcontextprotocol/server-filesystem')).toBeInTheDocument();
    expect(screen.getByText('新增')).toBeInTheDocument();
    // 未知字段要逐行点名：不点的话用户以为 alwaysAllow 也导进去了
    expect(screen.getByText('alwaysAllow')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '导入 1 台' }));

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport.mock.calls[0]?.[0]).toEqual({
      context7: servers.context7,
      filesystem: {
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      },
    });
  });

  it('同名默认覆盖：处置写着「覆盖已有 context7」、计数带上覆盖台数；切成跳过后这一行不写', async () => {
    const onImport = vi.fn();
    render(<McpPasteModal open servers={servers} saving={false} onImport={onImport} onCancel={noop} />);

    paste('{ "mcpServers": { "context7": { "url": "https://new.invalid/mcp" } } }');

    expect(await screen.findByText('覆盖已有 context7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导入 1 台（覆盖 1）' }));
    expect(onImport.mock.calls[0]?.[0]).toEqual({
      context7: { transport: 'http', enabled: true, url: 'https://new.invalid/mcp' },
    });

    // 逐行切「跳过」：处置列与开关标签都写着「跳过」（两处都读得到这件事），
    // 关键是这一行不再进 map —— 计数归零、确认按钮禁用（点了也没东西可写）
    fireEvent.click(screen.getByRole('switch', { name: '跳过 context7' }));
    expect(screen.getAllByText('跳过').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '导入 0 台' })).toBeDisabled();
  });

  it('「先清空现有条目再导入」默认关；勾上之后确认交出的 map 里现有条目一条不剩', async () => {
    const onImport = vi.fn();
    render(<McpPasteModal open servers={servers} saving={false} onImport={onImport} onCancel={noop} />);

    paste('{ "mcpServers": { "context7": { "url": "https://new.invalid/mcp" } } }');
    const checkbox = await screen.findByRole('checkbox', { name: /先清空现有条目再导入/ });
    expect(checkbox).not.toBeChecked();
    // 它删的是用户已有的配置：默认关，且勾之前先把代价写在文案里
    expect(screen.getByText(/会删掉现有 1 台/)).toBeInTheDocument();

    fireEvent.click(checkbox);
    // 先清空 ⇒ 没有「覆盖」可言，计数与标签一起变（标着覆盖却是清空重写，是假话）
    fireEvent.click(screen.getByRole('button', { name: '导入 1 台' }));

    expect(onImport.mock.calls[0]?.[0]).toEqual({
      context7: { transport: 'http', enabled: true, url: 'https://new.invalid/mcp' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /先清空现有条目再导入/ }));
    fireEvent.click(screen.getByRole('button', { name: '导入 1 台（覆盖 1）' }));
    expect(onImport.mock.calls[1]?.[0]).toEqual({
      context7: { transport: 'http', enabled: true, url: 'https://new.invalid/mcp' },
    });
  });

  it('裸单项：名称给默认值且可改；清空名字 ⇒ 那一行不导入并提示改名', async () => {
    const onImport = vi.fn();
    render(<McpPasteModal open servers={{}} saving={false} onImport={onImport} onCancel={noop} />);

    paste('{ "url": "https://mcp.context7.com/mcp" }');
    const nameInput = await screen.findByLabelText('名称');
    // 默认名按内容猜（URL 主机名去掉 mcp. 前缀）
    expect(nameInput).toHaveValue('context7');

    fireEvent.change(nameInput, { target: { value: '' } });
    expect(await screen.findByText(/名字不能为空/)).toBeInTheDocument();
    expect(screen.getByText('不导入')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入 0 台' })).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: 'ctx7' } });
    fireEvent.click(screen.getByRole('button', { name: '导入 1 台' }));

    expect(onImport.mock.calls[0]?.[0]).toEqual({
      ctx7: { transport: 'http', enabled: true, url: 'https://mcp.context7.com/mcp' },
    });
  });

  it('不能识别的条目逐条点名原因，其余条目照常导入（不做「任一条不合法就整份拒绝」）', async () => {
    const onImport = vi.fn();
    render(<McpPasteModal open servers={{}} saving={false} onImport={onImport} onCancel={noop} />);

    paste(
      '{ "mcpServers": { "old": { "type": "sse", "url": "https://x/sse" }, "my.server": { "command": "npx" }, "ok": { "command": "npx" } } }',
    );

    expect(await screen.findByText(/暂不支持 type: 'sse'/)).toBeInTheDocument();
    expect(screen.getByText(/名字「my.server」不合法/)).toBeInTheDocument();
    expect(screen.getAllByText('不导入')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '导入 1 台' }));

    expect(onImport.mock.calls[0]?.[0]).toEqual({ ok: { transport: 'stdio', enabled: true, command: 'npx' } });
  });

  it('超过 256 KB：给中文原因、不出预览、确认按钮禁用（连解析都不做）', async () => {
    render(<McpPasteModal open servers={{}} saving={false} onImport={noop} onCancel={noop} />);

    paste('x'.repeat(MCP_PASTE_MAX_BYTES + 1));

    expect(await screen.findByText(/256 KB/)).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-paste-preview')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: '导入 0 台' })).toBeDisabled();
  });

  it('整份无法识别：列出实际看到的顶层键，并把四类形状的示例摆出来', async () => {
    render(<McpPasteModal open servers={{}} saving={false} onImport={noop} onCancel={noop} />);

    paste('{ "foo": 1 }');

    expect(await screen.findByText(/看到的顶层键：foo/)).toBeInTheDocument();
    // 用 textContent 逐字比：示例里有换行，而 getByText 的默认规范化会把空白折成一个空格
    expect(screen.getAllByTestId('mcp-paste-shape-example').map((node) => node.textContent)).toEqual([
      ...MCP_PASTE_SHAPE_EXAMPLES,
    ]);
  });

  it('JSONC 与 http:// 一路走到预览：注释被剥掉、URL 逐字还在', async () => {
    const onImport = vi.fn();
    render(<McpPasteModal open servers={{}} saving={false} onImport={onImport} onCancel={noop} />);

    paste('{\n  // 本机代理\n  "mcpServers": { "local": { "url": "http://localhost:8080/mcp" }, },\n}');

    expect(await screen.findByText('http://localhost:8080/mcp')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导入 1 台' }));

    expect(onImport.mock.calls[0]?.[0]).toEqual({
      local: { transport: 'http', enabled: true, url: 'http://localhost:8080/mcp' },
    });
  });

  it('保存中：确认按钮转圈且点不动（避免连点两次落两份）', async () => {
    const onImport = vi.fn();
    render(<McpPasteModal open servers={{}} saving onImport={onImport} onCancel={noop} />);

    paste('{ "mcpServers": { "local": { "command": "npx" } } }');

    const ok = await screen.findByRole('button', { name: /导入 1 台/ });
    // antd 的 loading 不给 `disabled` 属性（只在 handleClick 里提前 return），
    // 故这一条只能钉类名 +「点了确实不回调」，不能钉 `toBeDisabled()`
    expect(ok.className).toContain('ant-btn-loading');
    fireEvent.click(ok);
    expect(onImport).not.toHaveBeenCalled();
  });
});
