/**
 * `AgentEnvironmentDrawer`（L0 受控件）的守卫。行为五条 + 几何一条（静态扫描）：
 *   1. 三态：`undefined` ⇒「未提供」（不是空白、也不是永远转圈）、`loading` ⇒ `Skeleton`、`error` ⇒ `Alert`（+有回调才给重试）；
 *   2. 摘要逐项来自数据层，`effort === null` 写「未指定」而不是留空；显式关闭档逐字写 `off`
 *      （档位一律照上游词汇原样写，不加工）；
 *   3. 分组名 / 顺序 / 来源标签全部照数据层渲染，组件不硬编码任何组名；
 *   4. `present: false` 渲染成「标签 · 原因」，**不隐藏**；
 *   5. 截断时给提示与两个复制入口（`复制全部` / `copyPath` 的 `复制`）；
 *   6. **宽度只许来自 `base/drawer-geometry.ts`**（jsdom 测不出布局，故按源码逐字钉）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EFFORT_OFF } from '@aieval/contracts';
import type { AgentEnvironment } from './types';
import { AgentEnvironmentDrawer } from './agent-environment-drawer';
import { installResizeObserverStub } from '../../testing/resize-observer';

// 抽屉的面板与 `Descriptions` 各要一个 jsdom 没有的 api：`ResizeObserver`（rc-portal 的滚动锁）
// 与 `matchMedia`（antd 的响应式断点）。仓库的安装助手一次补两个（见 src/testing/resize-observer.ts）。
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENVIRONMENT: AgentEnvironment = {
  summary: {
    // 数据层给的就是**显示名**（映射在 `client/build-environment.ts`，见 `summaryOf`）：
    // L0 渲染件里不许出现「厂商 → 文案」的表（`agent-log-layering.test.ts` 的 (e) 条）
    agentLabel: 'DeepSeek Harness',
    modelId: 'deepseek-v4',
    effort: null,
    providerName: '网关',
    baseUrl: 'https://gateway.example/v1',
    workspaceBase: 'D:/work/case-1',
    baselineCommit: 'abc1234',
  },
  groups: [
    {
      id: 'user-layer',
      title: '用户层',
      source: 'user',
      items: [{ present: true, id: 'prompt', label: '提示词', text: '把 build 脚本修好', truncated: null, at: null }],
    },
    {
      id: 'vendor-layer',
      title: '厂商系统层',
      source: 'vendor',
      items: [{ present: false, id: 'sys', label: '系统提示词', missing: 'not-exposed' }],
    },
    {
      id: 'observed',
      title: '实测统计',
      source: 'observed',
      items: [
        {
          present: true,
          id: 'used-tools',
          label: '用过的工具',
          text: 'pwsh\nread_file',
          truncated: { reason: '超过上限只保留了开头', bytes: 2048 },
          copyPath: 'D:/work/case-1/tools.txt',
          at: null,
        },
      ],
    },
  ],
};

function renderDrawer(props: Partial<Parameters<typeof AgentEnvironmentDrawer>[0]> = {}): ReturnType<typeof render> {
  return render(
    <AgentEnvironmentDrawer
      open
      onOpenChange={vi.fn()}
      environment={{ status: 'ready', data: ENVIRONMENT }}
      {...props}
    />,
  );
}

describe('AgentEnvironmentDrawer', () => {
  it('environment 未提供 ⇒ 显示「未提供」，不是空白也不是一直转圈', () => {
    renderDrawer({ environment: undefined });

    expect(screen.getByTestId('agent-environment-drawer')).toBeInTheDocument();
    expect(screen.getByText('未提供')).toBeInTheDocument();
  });

  it('读取中 ⇒ Skeleton；读失败 ⇒ Alert，且只有给了 onRetry 才渲染重试按钮', () => {
    const { rerender } = renderDrawer({ environment: { status: 'loading' } });
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    rerender(<AgentEnvironmentDrawer open onOpenChange={vi.fn()} environment={{ status: 'error', error: new Error('读盘失败') }} />);
    expect(screen.getByText('环境信息读取失败')).toBeInTheDocument();
    expect(screen.getByText('读盘失败')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();

    const onRetry = vi.fn();
    rerender(
      <AgentEnvironmentDrawer
        open
        onOpenChange={vi.fn()}
        environment={{ status: 'error', error: new Error('读盘失败') }}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  /**
   * 摘要逐项照数据渲染：**「智能体」那一格画的是数据层给的显示名**（口径：
   * 页面展示不用缩写）。摘要里早已没有 kind 那一格（它是数据层映射好的文案），
   * 故这里钉的是「画的是那个字段、而不是自己拿 kind 去查表」——
   * 后者会让 `agent-log-layering.test.ts` 的 (e) 条当场红（L0 不许持有「厂商 → 文案」的表）。
   */
  it('摘要逐项照数据渲染：智能体画显示名、effort 为 null 写「未指定」', () => {
    renderDrawer();

    expect(screen.getByText('智能体')).toBeInTheDocument();
    // 全名在、kind 缩写不在（阴性面同样要断言：只钉全名时，「两处都画」的实现照样绿）
    expect(screen.getByText('DeepSeek Harness')).toBeInTheDocument();
    expect(screen.queryByText('dsh')).toBeNull();
    expect(screen.getByText('思考强度')).toBeInTheDocument();
    expect(screen.getByText('未指定')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  /**
   * 摘要里的关闭档：档位照上游词汇原样写，`off` 就是 `off`。
   * 靶子是**这一格不是空的**：把关闭档并进「未指定」那一支（`=== null || === 'off'` 这类写法）
   * 这条用例就红——「我要求关掉思考」与「我没选」是两件事。
   */
  it('摘要里的关闭档逐字写 `off`，不是「未指定」', () => {
    renderDrawer({
      environment: {
        status: 'ready',
        data: { ...ENVIRONMENT, summary: { ...ENVIRONMENT.summary, effort: EFFORT_OFF } },
      },
    });

    expect(screen.getByText(EFFORT_OFF)).toBeInTheDocument();
  });

  it('分组按数据层给的组名与顺序渲染，来源标签各一档', () => {
    renderDrawer();

    const headers = [...document.querySelectorAll('[data-group-header]')].map((node) => node.textContent ?? '');
    expect(headers).toHaveLength(3);
    // 组名与顺序都照数据层给的来（组件里没有任何硬编码的组名）
    expect(headers[0]).toContain('用户层');
    expect(headers[1]).toContain('厂商系统层');
    expect(headers[2]).toContain('实测统计');
    // 来源 Tag：user → 用户层、vendor → 厂商系统层、observed → 实测统计
    expect(headers[0]).toContain('用户层');
    expect(headers[1]).toContain('厂商系统层');
    expect(headers[2]).toContain('实测统计');
  });

  it('present: false 渲染成「标签 · 原因」，不隐藏', () => {
    renderDrawer();

    expect(screen.getByText('系统提示词 · 厂商有数据、但没投送到我们能读的通道')).toBeInTheDocument();
  });

  it('截断时给提示与两个复制入口', () => {
    renderDrawer();

    expect(screen.getByText('已截断（原文 2.0 KB）')).toBeInTheDocument();
    expect(screen.getByText('超过上限只保留了开头')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制全部' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
  });

  /**
   * 结论 Tag 渲染：带 `verdictLines` 的条目按行画——结论那一枚是 Tag
   * （文案取契约的四档标签、颜色是 antd 预设色，不手写色值），
   * 其余半行照常等宽原文；不带这一格的条目仍走整段 `MonoText`。
   */
  it('带 verdictLines 的条目把结论画成 Tag（文案与色档都不在组件里写第二份）', () => {
    renderDrawer({
      environment: {
        status: 'ready',
        data: {
          ...ENVIRONMENT,
          groups: [
            {
              id: 'observed',
              title: '实测统计',
              source: 'observed',
              items: [
                {
                  present: true,
                  id: 'observed-mcp-servers',
                  label: '本行 MCP',
                  text: '2 台：\nplaywright：来源 unknown · 判据 厂商启动状态 · 结论 已连上\ncontext7：来源 unknown · 判据 无厂商证据 · 结论 已跳过',
                  truncated: null,
                  at: null,
                  verdictLines: [
                    { text: '2 台：', verdict: null },
                    { text: 'playwright：来源 unknown · 判据 厂商启动状态 · 结论 ', verdict: 'connected' },
                    { text: 'context7：来源 unknown · 判据 无厂商证据 · 结论 ', verdict: 'skipped' },
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    // 结论文案来自契约的四档标签（不在这里抄第二份词表）
    const connected = screen.getByText('已连上');
    const skipped = screen.getByText('已跳过');
    expect(connected.closest('[data-slot="badge"]')).toHaveAttribute('data-tone', 'connected');
    expect(skipped.closest('[data-slot="badge"]')).toHaveAttribute('data-tone', 'skipped');
    // 结论之前的半行与表头照常等宽原文（`MonoText`）
    expect(screen.getByText('2 台：')).toBeInTheDocument();
    expect(screen.getByText(/playwright：来源 unknown · 判据 厂商启动状态 · 结论/)).toBeInTheDocument();
  });

  /**
   * 能力声明（界面落点）。
   *
   * 为什么放在环境抽屉里：这一节回答的是「这一次运行**我们能拿到什么**」，与「被下发了什么」
   * 是同一个抽屉里并列的两件事；而它的四句文案与 `EnvItemRow` 的 `missing` 用的是**同一张表**
   * （`MISSING_REASON_LABELS`），放两处才不会出现「同一个原因两种说法」。
   *
   * 两条口径：
   *   ① **不给 `capability` 就整段不出现**（老调用方与「没采到声明」同一处置）——
   *      宁可不显示，也不编一份「都支持」出来；
   *   ② 四句原因**互不相同**，且由数据层的等级经 `CAPABILITY_TO_MISSING_REASON` 取，
   *      组件不写第二份中文——写错一句就会把「厂商没投送」说成「我们没接」。
   */
  it('能力声明渲染成四句不同的原因；不给就整段不出现', () => {
    const { rerender } = renderDrawer();
    expect(screen.queryByTestId('capability-notes')).toBeNull();

    rerender(
      <AgentEnvironmentDrawer
        open
        onOpenChange={vi.fn()}
        environment={{ status: 'ready', data: ENVIRONMENT }}
        capability={{
          thinkingText: { level: 'yes', source: 'wire', reason: null },
          toolResult: { level: 'not-projected-by-vendor', source: null, reason: 'not-exposed' },
          subagent: { level: 'off-by-adapter', source: null, reason: 'not-observed' },
          streamingDelta: { level: 'no', source: null, reason: 'not-supported' },
        }}
        capabilityNotes={['多智能体随路由变化']}
      />,
    );

    expect(screen.getByTestId('capability-notes')).toBeInTheDocument();
    expect(screen.getByText('思考文本')).toBeInTheDocument();
    // `level === 'yes'` 不显示「原因」（契约里那一格的 reason 就是 null），但也不能留空
    expect(screen.getByText('支持')).toBeInTheDocument();
    expect(screen.getByText('厂商有数据、但没投送到我们能读的通道')).toBeInTheDocument();
    expect(screen.getByText('厂商有、我们还没接')).toBeInTheDocument();
    expect(screen.getByText('这家结构上不支持')).toBeInTheDocument();
    // 能力成立的前提（路由 / 模型 / 开关）如实显示，不吞掉
    expect(screen.getByText('能力随路由/模型变化：多智能体随路由变化')).toBeInTheDocument();
  });

  it('受控：点关闭只把 onOpenChange(false) 交回去', () => {
    const onOpenChange = vi.fn();
    renderDrawer({ onOpenChange });

    // 关闭键走 `Sheet` 的可访问名（英文 Close），不按 antd 的 DOM 类名定位
    fireEvent.click(screen.getByRole('button', { name: /close|关闭/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 自己不改 `open`：开合态在调用方手上（受控件的能力就在于能被挂到任何地方）
    expect(screen.getByTestId('agent-environment-drawer')).toBeInTheDocument();
  });
});

/**
 * **静态扫描**（jsdom 看不见的那一半）：宽度与语义槽归 `NestedDrawer` 统一实现，
 * 环境信息只渲染正文。
 *
 * 为什么值得单独钉：jsdom 没有布局引擎，「这个抽屉多宽 / 内边距多少」测不出来；而写错了是**静默**的。
 * 这个件的壳已经换成 Base UI 的 `Sheet`：宽度、窄屏兜底与二级层让位都由二级抽屉那一份实现，
 * 本件再写一个 `size` / `width` / `styles` 只可能是第二份真源。
 */
describe('AgentEnvironmentDrawer（几何，静态）', () => {
  const raw = readFileSync(join(import.meta.dirname, 'agent-environment-drawer.tsx'), 'utf8');

  /**
   * 判据只许扫代码：文件头的口径注释里写着壳与让位的实现位置（那是讲给读的人听的口径），
   * 扫全文的话负向断言会被注释直接判红。守卫误伤比漏放行更危险（会教人把守卫删掉），故先剥注释。
   */
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('壳是 NestedDrawer：本件不写宽度 / 语义槽（写了就是第二份真源）', () => {
    expect(source, '环境信息的壳不是 NestedDrawer').toContain('<NestedDrawer');
    expect(source, '环境抽屉又自己写了一份语义槽样式').not.toMatch(/DRAWER_SEMANTIC_STYLES|maxWidth: '100vw'/);
    // 所有 `size=` / `width=` 都不许带 vw / px：Button 的 size 预设不受影响
    const geometryProps = [...source.matchAll(/\b(?:size|width)=(\{[^}]*\}|"[^"]*")/g)].map((match) => match[1]);
    expect(
      geometryProps.filter((value) => /\d(vw|px)/.test(value ?? '')),
      '环境抽屉又自己写了一份几何字面量',
    ).toEqual([]);
  });

  it('整件不 import antd（连正文展示件也不再用它）', () => {
    expect(source, '环境信息又把 antd 请回来了').not.toMatch(/from\s+'antd'/);
  });
});
