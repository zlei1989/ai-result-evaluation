'use client';

/**
 * 悬浮提示的薄壳：把「禁用态也要说清原因」收敛成一处。
 *
 * 为什么需要它：禁用按钮自己收不到鼠标事件，宿主必须是**包住按钮的真实元素**——
 * 每个调用点各写一遍 `Tooltip` + `TooltipTrigger` 的嵌套，迟早有一处把触发点直接挂在
 * 禁用按钮上，而那种缺陷在 jsdom 里验不出来（合成事件照常冒泡），只会在真实浏览器里
 * 表现为「悬浮什么都不出现」。
 *
 * `HintProvider` 只是把 Base UI 的默认打开延迟从 600ms 压到 0：这些提示解释的是
 * 「为什么这个按钮不能按」，延迟只会让原因更难看到。
 */
import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';

export interface HintProps {
  /** 提示文案；`undefined` / 空串 = 不需要提示（条件都满足时不该有一个空浮层） */
  label?: ReactNode;
  children: ReactNode;
}

export function Hint({ label, children }: HintProps): ReactNode {
  if (label === undefined || label === null || label === '') return <>{children}</>;
  return (
    <TooltipProvider delay={0}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** 提示的上下文：把打开延迟压到 0（理由见文件头） */
export function HintProvider({ children }: { children: ReactNode }): ReactNode {
  return <TooltipProvider delay={0}>{children}</TooltipProvider>;
}
