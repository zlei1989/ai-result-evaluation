'use client';

/**
 * 根 `XProvider` 的本仓外壳（`@ant-design/x` 的导入只允许出现在 `base/`）。
 *
 * 在这里收口两件「X 的默认行为在本仓是缺陷」的事，调用方无从漏：
 *
 *   1. **locale 必须显式合并**：X 的文案走它自己的一条 context（`es/locale/context`），
 *      antd 的 `locale` 传不进去，而两包的键除 `locale` 外完全不相交。只给 antd 的 `zh_CN` 时，
 *      X 的六组文案（`Conversations` / `Sender` / `Actions` / `Bubble` / `Mermaid` / `Folder`）
 *      整组退回英文（`New chat` / `OK` / `Like` …），而 `getLocaleCode()` 仍返回 `zh-cn`——
 *      症状到不了页面上显眼的地方，所以合并写在本壳里，不做成调用方的义务。
 *
 *   2. **`boxShadow*` 13 键要换回 antd 的值**：X 抄的 `alias.js` 停在 antd 6 之前，阴影写死
 *      `rgba(0, 0, 0, …)` 而不是从 `colorShadow` 派生 ⇒ 暗色算法下 X 的阴影仍是给浅色用的黑阴影，
 *      而 `Sender` / `Bubble` / `FileCard` 确实在用 `boxShadowTertiary` 一类。做法是把 antd 用
 *      **同一份 theme 配置**算出来的那 13 个键塞进 `theme.token`：X 那份 `formatToken` 只删
 *      seed 名单里的键（阴影不在其中），故覆盖能穿透到 X 的 token；antd 侧拿到的值与它自己
 *      算出来的逐字相同，等于没改。
 *
 * **静态入口不在这里**：`XProvider` 没有任何静态方法，脱离 React 上下文的静态
 * `message` / `Modal` 渲染根仍由 antd 的 `ConfigProvider.config({ holderRender })` 提供
 * （见 `app-theme.tsx` 的第三处同步）——那里渲染的是 antd 组件，不消费 X 的 token 与 locale。
 */
import { XProvider, type XProviderProps } from '@ant-design/x';
import xZhCN from '@ant-design/x/locale/zh_CN';
import { theme } from 'antd';
import type { ThemeConfig } from 'antd';
import { useMemo, type ReactNode } from 'react';

/**
 * X 与 antd 同名不同值的那批阴影键（X 的 alias 落后 antd 6：一律写死黑阴影）。
 *
 * 列全 13 个而不是只覆盖眼前用到的 `boxShadowTertiary`：X 里换一个带阴影的组件
 * （`Sender` → `Bubble` → `FileCard`）就会换一个键，漏掉的那一个在暗色下发黑且无声。
 */
export const SHADOW_TOKEN_KEYS = [
  'boxShadow',
  'boxShadowSecondary',
  'boxShadowTertiary',
  'boxShadowPopoverArrow',
  'boxShadowCard',
  'boxShadowDrawerRight',
  'boxShadowDrawerLeft',
  'boxShadowDrawerUp',
  'boxShadowDrawerDown',
  'boxShadowTabsOverflowLeft',
  'boxShadowTabsOverflowRight',
  'boxShadowTabsOverflowTop',
  'boxShadowTabsOverflowBottom',
] as const;

/** 被覆盖的键名（`SHADOW_TOKEN_KEYS` 的元素类型） */
type ShadowTokenKey = (typeof SHADOW_TOKEN_KEYS)[number];

/**
 * 取 antd 在**这份 theme 配置下**算出的 13 个阴影值，用来覆盖 X 那份过期的派生。
 *
 * 用 `getDesignToken` 而不是抄一份字面量：值随算法走（light 是 `rgba(0, 0, 0, …)`、
 * dark 是 `rgba(255, 255, 255, …)`，强度由 `colorShadow` 定），抄字面量就会在下次
 * 升级 antd 时静默过期——那正是 X 现在这个缺陷的成因。
 *
 * 读出来先摊成 `Record<string, unknown>`：antd 的 `AliasToken` 类型里没有
 * `boxShadowPopoverArrow` 这类**运行时才有**的键，逐键取会撞 TS7053。取值仍逐个判 `string`，
 * 取不到就不写这一格（X 保留自己的值），而「键集是否齐」由 `x-provider.test.tsx` 对着
 * antd 的 `boxShadow*` 全集判——那里才是该响的地方。
 */
export function shadowTokenOverrides(themeConfig: ThemeConfig): Partial<Record<ShadowTokenKey, string>> {
  const antdTokens: Record<string, unknown> = Object.fromEntries(Object.entries(theme.getDesignToken(themeConfig)));
  const overrides: Partial<Record<ShadowTokenKey, string>> = {};
  for (const key of SHADOW_TOKEN_KEYS) {
    const value = antdTokens[key];
    if (typeof value === 'string') overrides[key] = value;
  }
  return overrides;
}

export interface XAppProviderProps extends Omit<XProviderProps, 'theme' | 'locale'> {
  /**
   * 主题配置：与 antd `ConfigProvider` 同一份**必填**（不传就是回落 `defaultAlgorithm`
   * 的浅色 + 非紧凑——「组件亮了、底色还是暗的」那种半亮主题，且只在暗色偏好下看得出来）。
   */
  theme: ThemeConfig;
  /**
   * antd 的 locale（如 `antd/locale/zh_CN`）。X 自己的 `zh_CN` 由本壳合并，调用方不必给，
   * 给了也只覆盖同名的键——两包键除 `locale` 外不相交，合并顺序无差异。
   */
  locale?: XProviderProps['locale'];
}

export function XAppProvider({ theme: themeConfig, locale, children, ...rest }: XAppProviderProps): ReactNode {
  const mergedTheme = useMemo<ThemeConfig>(
    () => ({ ...themeConfig, token: { ...themeConfig.token, ...shadowTokenOverrides(themeConfig) } }),
    [themeConfig],
  );
  const mergedLocale = useMemo<XProviderProps['locale']>(() => ({ ...xZhCN, ...locale }), [locale]);
  return (
    <XProvider {...rest} theme={mergedTheme} locale={mergedLocale}>
      {children}
    </XProvider>
  );
}
