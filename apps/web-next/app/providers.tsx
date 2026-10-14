'use client';

/**
 * 根客户端 Provider：主题（偏好 auto/light/dark）+ App 包装（message/modal 上下文）+ 紧凑密度
 * + 全局应答宿主（智能体的提问弹层，全站可见）。
 * 主题来源 = GET /api/settings（useSettings）→ 偏好交给 ui 包的 useResolvedTheme 解析；
 * 主题口径（auto 按系统偏好解析、data-theme / data-theme-preference 写入、holderRender 注册）统一在 ui 包，
 * 本组件只负责「把偏好喂进去 + 提供 AntdApp 子树 + 挂上应答宿主」。
 *
 * 根 Provider 是 `@aieval/ui` 的 `XAppProvider`（X 的 `XProvider` + 本仓口径的壳），不是裸的
 * `ConfigProvider`：X 组件的文案与阴影各有自己的坑，都收在那个壳里（见其文件头）。本文件
 * **不 import `@ant-design/x`**——`ui` 包直出源码、X 是它的依赖，装配侧只给 antd 的 locale。
 */
import { useSettings } from '@aieval/client';
import { DensityProvider, useResolvedTheme, XAppProvider } from '@aieval/ui';
import { App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';
import { AskUserHost } from './ask-user-host';

export function Providers({ children }: { children: ReactNode }): ReactNode {
  const { settings } = useSettings();
  // 设置未就绪时 useResolvedTheme 内部按暗色兜底（SSR 期不闪白）
  const { mode, themeConfig } = useResolvedTheme({ preference: settings?.theme });
  return (
    <XAppProvider
      theme={themeConfig}
      // 应用级 locale：不配的话内置文案全是英文
      // （antd 侧：Empty 空图的 SVG `<title>No data</title>`、Modal 关闭按钮的 `aria-label="Close"`、
      // Select 的 `No data`、校验规则模板……；X 侧：Conversations / Sender / Actions / Bubble /
      // Mermaid / Folder 六组）。否则只能在每个浮层上逐个显式补中文，漏一个就漏一个英文；
      // 在根上配一次即可一次性关掉这两类。
      // 这里只给 antd 的那份：X 的 `zh_CN` 由 `XAppProvider` 合并进去（X 的 locale 是独立 context，
      // antd 的传不进去，且漏合时 X 文案掉英文而 `localeCode` 仍报 `zh-cn`——不能靠调用方记得）。
      // 已有的显式中文文案不受影响：显式值优先于 locale 提供的默认值。
      locale={zhCN}
      // 全局关掉「两个汉字之间插空格」：antd 默认把 `编辑` / `保存` 渲染成 `编 辑`，
      // 可访问名随之不再等于可见文案（屏读器念成两个字，按名字定位按钮也失配）。
      // 在根上设一次，后加的按钮不必各自记得写 autoInsertSpace={false}；
      // 已显式传该 prop 的按钮保持原样：重复但一致，为去重去动已过审的组件不划算。
      button={{ autoInsertSpace: false }}
    >
      {/* 把解析后的实际明暗传给 PageShell：其紧凑密度主题需据此选底色算法 */}
      <DensityProvider mode={mode}>
        <AntdApp>
          {children}
          {/* 应答宿主：与页面平级（它要全局可见，不能只活在某个页面壳里）；它在 AntdApp 子树内
              是为了拿 `message` 上下文提示提交失败，紧凑密度则由它自己包（见该文件头） */}
          <AskUserHost />
        </AntdApp>
      </DensityProvider>
    </XAppProvider>
  );
}
