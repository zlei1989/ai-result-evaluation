'use client';

/**
 * antd 客户端 Provider：主题（偏好 auto/light/dark）+ App 包装（message/modal 上下文）+ 紧凑密度。
 * 主题来源 = GET /api/settings（useSettings）→ 偏好交给 ui 包的 useResolvedTheme 解析；
 * 主题口径（auto 按系统偏好解析、data-theme / data-theme-preference 写入、holderRender 注册）统一在 ui 包，
 * 本组件只负责「把偏好喂进去 + 提供 AntdApp 子树」。
 */
import { useSettings } from '@aieval/client';
import { DensityProvider, useResolvedTheme } from '@aieval/ui';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }): ReactNode {
  const { settings } = useSettings();
  // 设置未就绪时 useResolvedTheme 内部按暗色兜底（SSR 期不闪白）
  const { mode, themeConfig } = useResolvedTheme({ preference: settings?.theme });
  return (
    <ConfigProvider
      theme={themeConfig}
      // 应用级 antd locale：不配的话 antd 的内置文案全是英文
      // （Empty 空图的 SVG `<title>No data</title>`、Modal 关闭按钮的 `aria-label="Close"`、
      // Select 的 `No data`、校验规则模板……）。否则只能在每个浮层上逐个显式补中文，
      // 漏一个就漏一个英文；在根上配一次即可一次性关掉这一整类。
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
        <AntdApp>{children}</AntdApp>
      </DensityProvider>
    </ConfigProvider>
  );
}
