/**
 * 根 XProvider 外壳的两条收口，各一条防回归：
 *
 *   1. **locale 合并**：只给 antd 的 `zh_CN` 时，X 那六组文案会整组退回英文（`OK` / `Cancel` /
 *      `New chat` …），而 `getLocaleCode()` 仍返回 `zh-cn`——页面上不显眼。判据是「X 的组件
 *      渲染出中文」。
 *   2. **`boxShadow*` 覆盖**：X 抄的 alias 落后 antd 6，阴影写死黑阴影 ⇒ 暗色下
 *      `Sender` / `Bubble` / `FileCard` 的阴影是给浅色用的。判据是「X 组件读到的阴影逐字等于
 *      antd 在同一份 theme 配置下算出的值」。
 *
 * 两条都走 **X 组件自己那条读取路径**，而不是读我们传给 `XProvider` 的 props：断言「传下去了」
 * 不等于断言「组件读到了」——这两个缺陷的形态正是「看起来配了、组件里没生效」。
 *
 * locale 那条用**真的 X 组件**（`Bubble` 的可编辑态两个按钮就是 `editableOk` / `editableCancel`），
 * 且必须与 `XAppProvider` 用**同一个入口** import：X 的 locale 是自己的一条 context，而
 * `@ant-design/x` 的 `lib/` 与 `es/` 两棵树在 Vitest 下是两个模块实例，从 `es/locale/…`
 * 深路径读会拿到空 context，症状（文案恒为英文兜底）与「压根没合并」一模一样。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Bubble } from '@ant-design/x';
import { theme } from 'antd';
import type { ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import useXToken from '@ant-design/x/es/theme/useToken';
import type { ReactNode } from 'react';
import { SHADOW_TOKEN_KEYS, XAppProvider, shadowTokenOverrides } from './x-provider';

const DARK: ThemeConfig = { algorithm: theme.darkAlgorithm };
const LIGHT: ThemeConfig = { algorithm: theme.defaultAlgorithm };

/**
 * 判据**独立于产品的 `SHADOW_TOKEN_KEYS`**：跑的是「antd 里所有 `boxShadow*` 键」。
 * 若照产品常量取键，漏掉一个键时探针与期望值会一起缩，用例就成了自证——漏键反而全绿。
 * 跟着 antd 的 token 名走，漏键会红；antd 将来新增阴影键也会红，那时回来核对 X 那边是否同样缺。
 */
const ANTD_SHADOW_KEYS = Object.keys(theme.getDesignToken(DARK)).filter((key) => key.startsWith('boxShadow'));

/** 与 `apps/web-next/app/providers.tsx` 同一份根配置（含「两个汉字之间不插空格」） */
const ROOT_BUTTON = { autoInsertSpace: false } as const;

/**
 * antd 在这份主题下算出的 token。摊成 `Record<string, unknown>`：antd 的 `AliasToken` 类型里
 * 没有 `boxShadowPopoverArrow` 这类运行时才有的键，逐键取会撞 TS7053。
 */
function antdTokenMap(themeConfig: ThemeConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(theme.getDesignToken(themeConfig)));
}

/** `Bubble` 的可编辑态：两个按钮的文案取 X 的 `Bubble` 组 locale */
function EditableBubble(): ReactNode {
  return <Bubble content="hi" editable={{ editing: true }} />;
}

/** 读 X 组件读到的那份 token（`es/theme/useToken` 是 X 组件唯一的 token 来源） */
function ShadowProbe(): ReactNode {
  const { token } = useXToken();
  const tokens: Record<string, unknown> = Object.fromEntries(Object.entries(token));
  return <span data-testid="shadows">{ANTD_SHADOW_KEYS.map((key) => String(tokens[key])).join('\u0000')}</span>;
}

function readProbedShadows(): string[] {
  return (screen.getByTestId('shadows').textContent ?? '').split('\u0000');
}

/** X 侧读到的顺序与 `ANTD_SHADOW_KEYS` 一致，故期望值按同一顺序摊 */
function antdShadowValues(themeConfig: ThemeConfig): string[] {
  const tokens = antdTokenMap(themeConfig);
  return ANTD_SHADOW_KEYS.map((key) => String(tokens[key]));
}

function renderShadowProbe(themeConfig: ThemeConfig): void {
  render(
    <XAppProvider theme={themeConfig}>
      <ShadowProbe />
    </XAppProvider>,
  );
}

describe('XAppProvider 的 locale 合并', () => {
  it('X 的 Bubble 按钮是中文（只给 antd 的 zh_CN 时也不掉英文）', () => {
    render(
      <XAppProvider theme={LIGHT} locale={zhCN} button={ROOT_BUTTON}>
        <EditableBubble />
      </XAppProvider>,
    );
    // 不合并 X 的 zh_CN 时这两格是 `OK` / `Cancel`（X 的 en_US 兜底）
    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('调用方连 antd locale 都不给时，X 的文案仍是中文（X 侧不依赖调用方）', () => {
    render(
      <XAppProvider theme={LIGHT} button={ROOT_BUTTON}>
        <EditableBubble />
      </XAppProvider>,
    );
    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });
});

describe('XAppProvider 的 boxShadow 覆盖', () => {
  it('被覆盖的键集就是 antd 的 boxShadow* 全集（antd 6 下共 13 个）', () => {
    expect([...SHADOW_TOKEN_KEYS].sort()).toEqual([...ANTD_SHADOW_KEYS].sort());
    expect(ANTD_SHADOW_KEYS).toHaveLength(13);
  });

  it('暗色下 X 读到的阴影全是 antd 的值（不是写死的黑阴影）', () => {
    renderShadowProbe(DARK);
    expect(readProbedShadows()).toEqual(antdShadowValues(DARK));
    // 症状级判据：暗色的阴影强度由 `colorShadow`（白）派生，一个黑阴影都不该剩
    for (const value of readProbedShadows()) expect(value).not.toContain('rgba(0, 0, 0');
  });

  it('亮色下同样用 antd 的值（X 那份派生在亮色下也有一格不一样：boxShadowTertiary）', () => {
    renderShadowProbe(LIGHT);
    expect(readProbedShadows()).toEqual(antdShadowValues(LIGHT));
  });

  it('覆盖值由 antd 在**传入的那份配置**下现算（换算法就换值，不抄字面量）', () => {
    for (const [themeConfig, tokens] of [
      [DARK, antdTokenMap(DARK)],
      [LIGHT, antdTokenMap(LIGHT)],
    ] as const) {
      expect(shadowTokenOverrides(themeConfig)).toEqual(
        Object.fromEntries(ANTD_SHADOW_KEYS.map((key) => [key, tokens[key]])),
      );
    }
  });
});
