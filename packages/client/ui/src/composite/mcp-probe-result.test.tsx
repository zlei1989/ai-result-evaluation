/**
 * 「测试连接」结果区：成功一句结论 + 补充说明；失败两段式（中文结论 + 可折叠的厂商原文）；
 * 请求本身失败是第三种内容；等待提示 1 秒后才报秒数。
 *
 * 措辞守卫在这一层再钉一次（契约层已经钉过模板）：这里是**实际渲染出来**的那串字，
 * 越界措辞（「配置可用」这类）一旦出现在界面上，用户就会把它读成「这条配置被证明没问题了」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { McpProbeResult } from '@aieval/contracts';
import { McpProbeResultView, McpProbeWaiting } from './mcp-probe-result';
import { installResizeObserverStub } from '../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
});

const SUCCESS: McpProbeResult = {
  ok: true,
  tier: 'http+call',
  serverName: 'Context7',
  serverVersion: '4.3.0',
  toolCount: 2,
  elapsedMs: 1610,
  notes: ['已停用，不会注入'],
};

const FAILURE: McpProbeResult = {
  ok: false,
  tier: 'A',
  elapsedMs: 404,
  failure: {
    tier: 'not-found',
    message: '端点不存在（HTTP 404）',
    vendorText: '{"error":"not_found","message":"Endpoint not found. Use /mcp for MCP protocol communication."}',
  },
  notes: [],
};

describe('成功', () => {
  it('一句结论按模板渲染，补充说明单独一行', () => {
    render(<McpProbeResultView outcome={{ kind: 'result', result: SUCCESS }} />);

    expect(screen.getByText('连通：Context7 4.3.0，声明 2 个工具（耗时 1.6 s）')).toBeInTheDocument();
    expect(screen.getByText('已停用，不会注入')).toBeInTheDocument();
    // 成功时没有失败区块，也没有折叠区（没有原文可抄）
    expect(screen.queryByTestId('mcp-probe-failure')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-probe-vendor')).not.toBeInTheDocument();
  });

  it('措辞守卫：渲染出来的每一个字里都没有「配置可用 / 配置正常」这类越界措辞', () => {
    render(
      <McpProbeResultView
        outcome={{
          kind: 'result',
          result: { ...SUCCESS, notes: ['候选执行时首次启动还要在本行环境里下载依赖', '已停用，不会注入'] },
        }}
      />,
    );

    const text = document.body.textContent ?? '';
    for (const word of ['配置可用', '配置正常', '一切正常', '可以使用']) {
      expect(text, `界面上出现了越界措辞「${word}」`).not.toContain(word);
    }
  });
});

describe('失败（两段式）', () => {
  it('中文结论是标题，厂商原文在折叠区里逐字可读', () => {
    render(<McpProbeResultView outcome={{ kind: 'result', result: FAILURE }} />);

    expect(screen.getByTestId('mcp-probe-failure')).toHaveTextContent('端点不存在（HTTP 404）');
    // 折叠区默认收起：先点开（antd 的 Collapse 头是可点的）
    fireEvent.click(screen.getByText('厂商原文'));
    expect(
      screen.getByText('{"error":"not_found","message":"Endpoint not found. Use /mcp for MCP protocol communication."}'),
    ).toBeInTheDocument();
  });

  it('没有厂商原文时不渲染折叠区（一个点开是空的折叠区比没有更糟）', () => {
    render(
      <McpProbeResultView
        outcome={{
          kind: 'result',
          result: { ...FAILURE, failure: { tier: 'timeout', message: '超时（已等待 30 s）', vendorText: '' } },
        }}
      />,
    );

    expect(screen.getByTestId('mcp-probe-failure')).toHaveTextContent('超时（已等待 30 s）');
    expect(screen.queryByTestId('mcp-probe-vendor')).not.toBeInTheDocument();
  });
});

describe('请求本身失败（不是探活档位）', () => {
  it('说清是「测试请求失败」并带中文原因，不冒充某个失败档位', () => {
    render(<McpProbeResultView outcome={{ kind: 'error', message: 'MCP 服务器「gone」不在配置里，先保存再测' }} />);

    expect(screen.getByTestId('mcp-probe-result')).toHaveTextContent(
      '测试请求失败：MCP 服务器「gone」不在配置里，先保存再测',
    );
    expect(screen.queryByTestId('mcp-probe-failure')).not.toBeInTheDocument();
  });
});

describe('等待提示', () => {
  it('1 秒以内只说「测试中…」，之后报出已等待秒数（首次启动要过 npx 解析层，用户不该以为卡死）', () => {
    vi.useFakeTimers();
    try {
      render(<McpProbeWaiting />);
      const text = (): string => screen.getByTestId('mcp-probe-waiting').textContent ?? '';

      expect(text()).toBe('测试中…');
      // 定时器驱动的重渲染必须包在 act 里：包了才算「React 处理完了这次更新」，不包会拿到上一次的 DOM
      act(() => vi.advanceTimersByTime(1_000));
      expect(text()).toContain('已等待 1 s');
      act(() => vi.advanceTimersByTime(2_000));
      expect(text()).toContain('已等待 3 s');
    } finally {
      vi.useRealTimers();
    }
  });
});
