'use client';

/**
 * 页面标题区：全站「这一页是什么」的唯一出口。
 *
 * 版式按 shadcn 的 page header 约定固定下来，**不跟密度档**：
 *   1. 标题 `text-2xl` + `font-semibold` + `tracking-tight`，描述 `text-sm` + `text-muted-foreground`；
 *   2. 动作靠右，与标题同一基线区（`justify-between`），窄容差时换行而不是把标题挤成两行；
 *   3. 标题与正文的层级由字号差建立（24 / 14），不靠颜色——改颜色会让「主次分明」变成换主题的事。
 *
 * 为什么不做成密度档的一格：密度管的是正文与表格行高，把 24px 的页标题压到 14px 会让它
 * 与正文同号，整页失去视觉重心；shadcn 的骨架里页标题从来不是密度变量。
 */
import type { ReactNode } from 'react';

export interface PageHeaderProps {
  /** 页面名，纯文本或带标识的元素 */
  title: ReactNode;
  /** 一句说明「有多少、能做什么」，加载中也可以给占位文案 */
  description?: ReactNode;
  /** 右侧动作区；主操作放第一个 */
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps): ReactNode {
  return (
    <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        {/* 本仓没引 preflight：`h1` / `p` 的 UA 外边距必须显式清零，否则标题与描述之间
            会多出一整行（1em + 1em），看起来像换行失败 */}
        <h1 className="m-0 text-2xl leading-tight font-semibold tracking-tight text-foreground">{title}</h1>
        {description === undefined ? null : (
          <p className="m-0 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
