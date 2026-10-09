/**
 * `AgentEnvironmentDrawer`（L0 受控件）的守卫。行为五条 + 几何一条（静态扫描）：
 *   1. 三态：`undefined` ⇒「未提供」（不是空白、也不是永远转圈）、`loading` ⇒ `Skeleton`、`error` ⇒ `Alert`（+有回调才给重试）；
 *   2. 摘要逐项来自数据层，`effort === null` 写「未指定」而不是留空；显式关闭档逐字写 `off`
 *      （2026-10-07 口径：档位一律照上游词汇原样写，不再加工）；
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
    expect(document.querySelector('.ant-skeleton')).not.toBeNull();

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
   * 摘要逐项照数据渲染：**「智能体」那一格画的是数据层给的显示名**（用户 2026-10-08 口径：
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
   * 摘要里的关闭档（2026-10-07 口径）：档位照上游词汇原样写，`off` 就是 `off`。
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

    const headers = [...document.querySelectorAll('.ant-collapse-header')].map((node) => node.textContent ?? '');
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
   * 能力声明（D28 的界面落点，2026-10-04 收口接上）。
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

    // 关闭按钮按结构定位（`.ant-drawer-close`）：antd 的可访问名是英文的 Close，不该被这里钉死
    const close = document.querySelector<HTMLElement>('.ant-drawer-close');
    expect(close).not.toBeNull();
    if (close !== null) fireEvent.click(close);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 自己不改 `open`：开合态在调用方手上（受控件的能力就在于能被挂到任何地方）
    expect(screen.getByTestId('agent-environment-drawer')).toBeInTheDocument();
  });
});

/**
 * **静态扫描**（jsdom 看不见的那一半）：宽度只许来自 `base/drawer-geometry.ts`。
 *
 * 为什么值得单独钉：jsdom 没有布局引擎，「这个抽屉多宽」测不出来；而宽度写错了是**静默**的——
 * 抽屉照样弹出来，只是宽窄不对，别的用例一条都不会红。2026-10-07 用户口径「宽一些」时改的正是
 * 这一格（旧值 `min(42vw, 640px)` 在 1432px 视口上只有 601px，比它推开的那个主抽屉还窄），
 * 改法是**接上共享常量**（`NESTED_DRAWER_SIZE`）而不是换一个新字面量：自持一份 = 与几何常量漂移。
 */
describe('AgentEnvironmentDrawer（几何，静态）', () => {
  const raw = readFileSync(join(import.meta.dirname, 'agent-environment-drawer.tsx'), 'utf8');

  /**
   * 判据只许扫代码：文件头的口径注释与 `size` 那一行的说明里**正大光明地写着宽度值**
   * （那是讲给读的人听的口径），扫全文的话负向断言会被注释直接判红——`nested-drawer.test.tsx`
   * 第一次跑就是这么假红的。守卫误伤比漏放行更危险（会教人把守卫删掉），故先剥注释。
   */
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('宽度走共享常量，不再自己写一份字面量（写了就会与几何常量静默漂移）', () => {
    // 取**所有** `size=` 属性：本件里还有若干 `<Button size="small">`（它们是对的），
    // 故不能只说「文件里出现过常量」，也不能只说「文件里没有 vw」——两句都要落在同一张表上，
    // 否则把 `size={NESTED_DRAWER_SIZE}` 删掉、只留 `maxWidth: '100vw'` 时仍会绿。
    const sizeProps = [...source.matchAll(/\bsize=(\{[^}]*\}|"[^"]*")/g)].map((match) => match[1]);
    expect(sizeProps, '本件里没解析到 size（判据失效了）').not.toEqual([]);
    expect(sizeProps, '环境抽屉的宽度没有走共享常量').toContain('{NESTED_DRAWER_SIZE}');
    expect(
      sizeProps.filter((value) => /\d(vw|px)/.test(value ?? '')),
      '环境抽屉又自己写了一份宽度字面量',
    ).toEqual([]);
  });
});
