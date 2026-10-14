/**
 * 折叠面板标题的**可收缩**语义样式：给 antd `Collapse` 传 `styles={SHRINKABLE_TITLE_STYLE}`。
 *
 * 为什么非给不可：antd 的 `.ant-collapse-title` 带 `min-width: auto`，而它是折叠头部那个
 * flex 容器的项 ⇒ 最小宽度按**内容**算。标题里放了 `nowrap` 的长内容（`EllipsisText` 渲染的
 * 工具摘要行、单行问句）时，标题把整行顶宽，外层容器冒出**横向滚动条**，而省略号永远轮不到它
 * ——`EllipsisText` 的 `max-width: 100%` 分母正是那个已经被顶宽的容器。
 *
 * 交还给 flex 之后标题按可用宽度收缩：长内容照旧省略 + Tooltip 显全量，
 * 头部右侧的 `extra`（状态标签）也不再被顶出去。短标题的面板传了没有副作用。
 */
import type { CollapseProps } from 'antd';

export const SHRINKABLE_TITLE_STYLE: NonNullable<CollapseProps['styles']> = { title: { minWidth: 0 } };
