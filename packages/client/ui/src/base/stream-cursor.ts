/**
 * 「这块内容还没写完」的**闪烁光标类名**（base 里的共享常量）。
 *
 * 为什么单独一个文件：这个类名现在有**两个**使用者——执行日志里那条正文流
 * （`composite/agent-log/text-block-view.tsx`）与卡片底部的活动行（`base/agent-activity-line.tsx`）。
 * 留在 composite 里让 base 反过来 import composite 是坏依赖方向；而两边各写一份字符串则必然漂移，
 * 漂移的症状是静默的（光标不出现 / 不闪，无任何报错）。
 *
 * 样式仍然只在 `apps/web-next/app/globals.css` 一处定义（口径见 `agent-activity-line.tsx` 的文件头），
 * 跨包一致性由 `apps/web-next/src/global-styles.test.ts` 读本文件的字面量钉住。
 */
export const STREAM_CURSOR_CLASS = 'aieval-stream-cursor';
