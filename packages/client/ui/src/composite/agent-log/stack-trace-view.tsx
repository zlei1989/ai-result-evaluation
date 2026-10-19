'use client';

/**
 * 失败的工具输出 → `Stack Trace` 的结构：**一句错误 + 帧列表**，帧列表自己可折叠。
 *
 * 四条的取舍：
 *   1. **首行是错误那句话，其余是帧**。失败输出在数据层是整段原文（stderr / 厂商的
 *      `output-error`），没有结构化字段可用；按行切分是唯一不需要猜厂商格式的做法。
 *      空行与行首缩进在这里被裁掉——帧是给人扫的，缩进只在终端里有对齐意义。
 *   2. **标题会被截断，故正文顶部重复一遍完整错误**（官方 Stack Trace 的同一条口径）：
 *      收起态那行 `TraceTitle` 是 `truncate`，长错误在那里读不全。
 *   3. **框架帧保持 muted、自己的帧用前景色**：`node_modules` 与运行时内部帧占绝大多数，
 *      把它们与「我们自己的代码」同色，等于让读者在几十行里自己找。判据只看路径片段，
 *      不解析语言：Python / Node / Go 的帧形态都落在同一条规则上。
 *   4. **开合受控**：`open` / `onOpenChange` 由调用方给（折叠态住在 `useAgentLogView`，
 *      L0 不许持态，见 `agent-log-layering.test.ts` (d)）。默认收起——失败摘要已经说明
 *      「失败了」，帧是第二层细节。
 *
 * `splitStack` / `isFrameworkFrame` 导出是为了让判据能被单独钉住：它们是纯函数，
 * 而组件那一层只负责把它们摆成 Trace 的形状。
 */
import type { ReactNode } from 'react';
import { CircleXIcon } from 'lucide-react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../../components/ui/trace';

export interface StackTraceViewProps {
  /** 失败输出的整段原文（逐字给，本件只按行切分） */
  text: string;
  /** 帧列表是否展开（**受控**） */
  open: boolean;
  onOpenChange(next: boolean): void;
}

/** 首行错误 + 其余帧。空输出不编造错误句子（调用方保证有结果才会渲染到这里） */
export function splitStack(text: string): { error: string; frames: string[] } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const [error = '', ...frames] = lines;
  return { error, frames };
}

/**
 * 这一帧是不是「不是我们的代码」：`node_modules` 里的依赖、运行时内部帧。
 *
 * 判据是**路径片段**而不是语言语法：`at foo (node_modules/x/y.js:1:2)`、
 * `File "/…/site-packages/…"`、`/usr/local/go/src/…` 三种形态都会命中。
 */
export function isFrameworkFrame(frame: string): boolean {
  return /(?:^|[\\s(\\/])node_modules[\\/]|(?:^|[\\s(])internal[\\/]|[\\/]site-packages[\\/]|[\\/]go[\\/]src[\\/]/.test(frame);
}

export function StackTraceView({ text, open, onOpenChange }: StackTraceViewProps): ReactNode {
  const { error, frames } = splitStack(text);
  return (
    <Trace data-testid="stack-trace">
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        <TraceCollapsibleTrigger>
          <TraceLine status="error" data-testid="stack-trace-line">
            <TraceIcon>
              <CircleXIcon />
            </TraceIcon>
            {/* 标题是一行完整的话（"失败：…"），状态词不靠颜色单独表达（Trace 的 a11y 口径） */}
            <TraceTitle>{`失败：${error}`}</TraceTitle>
            {frames.length > 0 && <TraceDescription>{`${frames.length} 帧`}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {/* `text-foreground`：`TraceCollapsibleContent` 会把整段文字变 muted，而这里是正文 */}
          <div className="flex flex-col gap-1 font-mono text-sub text-foreground" data-testid="stack-trace-body">
            <p className="text-destructive" data-testid="stack-error">
              {error}
            </p>
            {frames.length > 0 && (
              <ol className="flex flex-col gap-0.5" data-testid="stack-frames">
                {frames.map((frame, index) => (
                  <li
                    key={`${index}|${frame}`}
                    data-frame={isFrameworkFrame(frame) ? 'framework' : 'own'}
                    className={isFrameworkFrame(frame) ? 'text-muted-foreground/60' : 'text-foreground'}
                  >
                    {frame}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
