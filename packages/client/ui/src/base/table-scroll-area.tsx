'use client';

/**
 * 列表表格的滚动容器：把「滚」从表格内部挪到这一层。用例页与评测页的列表都用它。
 *
 * 为什么必须由外层滚，而不是继续用 `Table` 的 `scroll={{ y }}`：
 * 给了 `scroll.y` 时 rc-table 会把 `.ant-table-body` 的 `overflow-y` **写死成 `scroll`**
 * （`@rc-component/table` 的 `Table.js`：`scrollYStyle = { overflowY: hasData ? 'scroll' : 'auto', … }`，
 * 且该分支只在 `scroll.y` 存在时进入）。antd 没有把这一位改成 `auto` 的 prop，于是**数据只有两三行、
 * 根本无可滚内容时，表格右侧也永远挂着一条空滚动条**（实测：`.ant-table-body` 的
 * `offsetWidth - clientWidth = 15`，而 `scrollHeight === clientHeight`）。
 * 唯一走属性的解法是不给 `scroll.y`、把滚动交给外层容器，并用 `Table` 的 `sticky` 把表头钉住。
 *
 * 三条声明都是承重的，少任何一条都静默失效（表格不会报错，只是滚不动或又出现常驻滚动条）：
 *   - `flex: 1`：吃掉工具栏剩下的高度。写 `height: 100%` 不行——它在内容更长时让不出高度，
 *     容器会被内容顶开，滚动照样不发生；
 *   - `minHeight: '0px'`：纵向 Flex 子项默认 `min-height: auto`，不给 0 时容器按内容高度撑开，
 *     永远不产生滚动，长列表会被栏宿主的 `overflow: hidden` 裁掉（下面的行点不到）；
 *   - `overflow: 'auto'`：滚动真正发生在这里，且**只在需要时**才出现滚动条（这正是要的效果）。
 *
 * 调用方的 `Table` 必须用 `sticky`（不是 `scroll={{ y }}`）——两者一起给等于回到老样子。
 */

import { Flex } from 'antd';
import type { ReactNode } from 'react';

/**
 * 滚动容器的内联样式。导出是给测试直接钉上面三条不变量用的：jsdom 没有布局引擎，
 * 「能不能滚」测不出来，能断言的只有「这三条无条件落在内联 style 上」。
 */
export const TABLE_SCROLL_STYLE = { flex: 1, minHeight: '0px', overflow: 'auto' } as const;

export interface TableScrollAreaProps {
  /** 表格（必须是 `sticky` 的那张，见文件头） */
  children: ReactNode;
}

export function TableScrollArea({ children }: TableScrollAreaProps): ReactNode {
  return (
    <Flex vertical style={TABLE_SCROLL_STYLE}>
      {children}
    </Flex>
  );
}
