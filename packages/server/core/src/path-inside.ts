/**
 * 路径归属判据：`target` 是不是在 `root` 之下。
 *
 * 为什么单独成文件：它是「第二道门」——技能预览与候选产物读取都要在 `realpath` 解析**之后**
 * 复核一次，防止软链把手改过的路径指到根之外。两处各写一份的形状是「一处收紧了、另一处照旧」，
 * 而那种漂移没有任何运行时症状（越界与否只在特定的软链现场才看得见）。
 *
 * 两条使用前提，写在签名上说不清、漏了就会误判：
 *   1. **两侧都必须已经过 `realpath`**：拿未解析的路径来比，软链那一路的结论是错的；
 *   2. 比较是**字符串前缀**，故必须拼上分隔符再比——否则 `/a/b` 会「包含」`/a/bc`。
 */
import { sep } from 'node:path';

/** `target` 是不是 `root` 本身或它之下的一项（两侧都必须是 `realpath` 解析过的真实路径） */
export function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
