'use client';

/**
 * 顶栏：横向导航。
 * 纯 props 驱动——ui 包不调接口、不依赖路由库，跳转由应用层注入回调。
 * **刻意不在这里放产品名与主题切换**（用户口径）：产品名是装饰，而主题切换的唯一入口在设置页
 * （「跟随系统 / 明亮 / 暗色」三档，读 useSettings 的持久化偏好）。两处各放一份会变成两个真源，
 * 切换后互相打架——顶栏只保留导航这一件事。
 *
 * 四条几何不变量（它们都是布局静默漂移的来源，故写在这里而不是散在样式里）：
 *   1. **顶栏显式给高 56px（shadcn 的 h-14）**：它是 `PageShell`（`flex-1`）的兄弟节点，两者同处 `body` 的纵向 flex；
 *      不写死高度时浏览器按 flex 规则把顶栏一起压缩；
 *   2. **`flexShrink: 0`**：同上，没有它顶栏会被压掉一两像素，且被压多少随视口高与滚动条的有无浮动；
 *   3. **吸顶**（`position: sticky` + `top: 0` + `z-index`）：`scroll="page"` 的页面内容会撑出文档滚动，
 *      顶栏跟着滚走就丢了全站导航；
 *   4. 底色 / 分隔线取 `--app-bg` / `--app-border`：明暗切换只换 `html[data-theme]`，
 *      写死色值就是又一处半亮。
 */
import type { ComponentType, ReactNode } from 'react';
import { SearchIcon } from 'lucide-react';
import { cn } from '../lib/utils';

export interface AppTopNavItem {
  key: string;
  label: string;
  href: string;
  /**
   * 前导图标：收的是**组件引用**而不是元素 —— 导航项的唯一真源 `apps/web-next/src/nav.ts` 是纯 `.ts`
   * （放不下 JSX），而应用侧改成 `.tsx` 会被 vitest 的 import-analysis 按 tsconfig 的 `jsx: preserve`
   * 直接拒绝（口径见 `docs/guard/test-strategy.md` 的「形态与交互」）。故数据模块给组件、本组件负责渲染与可访问性处理。
   */
  icon?: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>;
}

export interface AppTopNavProps {
  items: AppTopNavItem[];
  /** 当前激活项的 key */
  active: string;
  onNavigate: (href: string) => void;
  /**
   * 打开命令面板。给了才渲染右侧那个「搜索 ⌘K」按钮。
   *
   * 为什么需要它：⌘K 是唯一搜索入口，而它没有任何可见迹象——不给按钮，就等于要求用户先知道快捷键。
   * 回调由应用层注入（ui 包不认识路由与面板状态），面板开关仍只有一份。
   */
  onSearch?: () => void;
}

export function AppTopNav({ items, active, onNavigate, onSearch }: AppTopNavProps): ReactNode {
  return (
    <header
      className="flex items-center gap-4 px-4"
      style={{
        // 与 shadcn 的 site header 同高（h-14）：40px 的条把导航压成了工具栏，
        // 页标题 24px 之后顶栏与内容之间需要这一截呼吸。
        height: 56,
        // 与下面的注释同一件事，但必须落在内联 style 上：布局不变量要能被用例直接断言
        flexShrink: 0,
        // 页面壳自己滚（`overflow-auto`）时文档不滚；但 `scroll="page"` 的页面内容会超出壳，
        // 文档跟着滚——顶栏跟着滚走就丢了全站导航。吸顶 + 层级让它在两种模式下都留在原位。
        position: 'sticky',
        top: 0,
        zIndex: 20,
        background: 'var(--app-bg)',
        borderBottom: '1px solid var(--app-border)',
      }}
    >
      {/* 导航项按 shadcn 的 Tabs（line）惯例：14px medium + 透明底，当前项靠底部指示条与字色，
          不再用底色药丸——药丸在浅色下与表格的选中行同形，读起来像「已选中一行」而不是「在哪个区」。 */}
      <nav aria-label="主导航" className="flex h-full min-w-0 flex-1 items-center gap-6">
        {items.map((item) => {
          const Icon = item.icon;
          const current = item.key === active;
          return (
            <a
              key={item.key}
              href={item.href}
              // `aria-current` 落在链接上：导航项的「当前页」语义由链接承担，
              // 屏读器与断言都读得到（只靠底色变化等于没有语义）
              aria-current={current ? 'page' : undefined}
              className={cn(
                'relative inline-flex h-full items-center gap-2 text-sm font-medium whitespace-nowrap transition-colors',
                current ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(item.href);
              }}
            >
              {/* 图标一律 `aria-hidden`：图标是装饰，导航项的语义由链接文案承担——
                  不藏起来时某些图标库会给 svg 挂 `role="img" aria-label`，可访问名会变成「图标名 用例」 */}
              {Icon === undefined ? null : <Icon aria-hidden className="size-4" />}
              {item.label}
              {/* 当前项指示条压在顶栏下边框上（-bottom-px），与设置页 `TabsList variant="line"` 同一种语言 */}
              {current ? (
                <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-foreground" />
              ) : null}
            </a>
          );
        })}
      </nav>
      {/* 搜索的可见入口：⌘K 仍然有效，但不再要求用户先知道它。按钮的语义是「打开搜索面板」，
          快捷键只作为提示放在 kbd 里，不参与可访问名。 */}
      {onSearch === undefined ? null : (
        <button
          type="button"
          onClick={onSearch}
          className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <SearchIcon aria-hidden className="size-4" />
          <span>搜索</span>
          <kbd className="rounded border border-border px-1 font-mono text-sub">⌘K</kbd>
        </button>
      )}
    </header>
  );
}
