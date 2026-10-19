'use client';

/**
 * `/dev/ui-probe`：界面基座的探针页，只把 `UiProbeGrid` 摆出来。
 *
 * 它与 `/dev/agent-log` 同级、**不进顶栏导航**。页面本身刻意不 import antd：
 * 这一页验收的是新栈（Tailwind 语义类 + vendored 原语），掺进 antd 的 token 就分不清
 * 颜色是哪一层给的。明暗不在这里造状态——`html[data-theme]` 是唯一真源，切主题时四格
 * 一起变；密度只在格上挂 `data-density`，作用域变量由主题与密度那一层供给。
 *
 * 必须是客户端组件：`@aieval/ui` 的包根把若干用 hooks 的展示件与 vendored 原语一起转出，
 * 服务端组件引包根时 Next 会把这些 hooks 判成「服务端模块里的 React API」并让整个路由 500；
 * 本页与 `/dev/agent-log` 一样只做纯展示，标 `'use client'` 即可。
 */
import { UiProbeGrid } from '@aieval/ui';
import type { ReactNode } from 'react';

export default function Page(): ReactNode {
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <header className="mb-4 flex flex-col gap-1">
        <h1 className="text-lg font-medium">界面基座探针：明暗 × 密度</h1>
        <p className="text-sm text-muted-foreground">
          四格的颜色都跟随 html[data-theme]（切主题时一起变）；每格自带五块语义色板与四个 vendored 件。
        </p>
      </header>
      <UiProbeGrid />
    </main>
  );
}
