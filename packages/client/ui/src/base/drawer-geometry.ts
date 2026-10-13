/**
 * 抽屉的几何口径：**主抽屉**（变更详情 / 评分详情 / 执行日志）与**二级抽屉**（原文查看这类
 * 「从主抽屉里再推出来的一层」）各一档宽度，语义槽样式两档共用。
 *
 * 为什么要有这个文件：抽屉**分居两个包**（「执行日志」的几何跟着 `AgentLogDrawer` 走，
 * 另两个在评测页里就地接线），同一份宽度各写一遍必然漂移。而漂移是**静默**的：
 * 实测——antd 6 废弃 `width`（控制台只打一句 warning）之后，页面那两处漏改，
 * 抽屉当场掉回默认 `378px`（同时执行日志是 `800px`），三个抽屉宽窄不一，而**没有一条用例变红**。
 * 故宽度与语义槽样式都收敛到这里，消费者只引用常量、不再各写一份字面量。
 *
 * 四条口径：
 * · **宽度走 `size`**：用 CSS `max()` / `min()` 而不是在 JS 里量 `window.innerWidth`
 * （后者要挂 resize 监听、首帧还得处理 SSR 无水 `window` 的情况，而 CSS 函数由浏览器直接算）。
 * 入口必须是 `size`——`styles.wrapper.width` 与 `width` 在 antd 6 都已废弃；
 * · **主抽屉 `max(50vw, 800px)`**；
 * · **二级抽屉 `min(60vw, 900px)`**：比主抽屉窄一档，从主抽屉里推出来时
 * 仍看得见主抽屉的存在——原文（逐行台账 / 模型 raw）比主抽屉正文更需要宽度，故只窄一档；
 * · **语义槽样式两档共用 `DRAWER_SEMANTIC_STYLES`**：`maxWidth: '100vw'` 与 antd 自带的
 * `.ant-drawer-content-wrapper{max-width:100vw}` 同值，**显式写出来是为了让「窄屏下不许把抽屉
 * 撑出屏幕」这条意图留在代码里**（否则下一个人看到 800px 下限会以为窄屏必然溢出）；
 * `body.padding: 0` 则把内边距交给**各抽屉的内容自己给**（评分详情与执行日志自己加，
 * 变更详情在内层块上给），否则正文会贴死抽屉边框。
 * `maxHeight: '100vh'` 是**纵向那一半**：antd 只给水平方向留兜底（`.ant-drawer-content-wrapper`
 * 的 `max-width`），垂直方向什么都不给。对左右抽屉它是空转（那两档本来就是 `top:0; bottom:0`），
 * 对**底部弹入**才是真判据——那里的高度可以写成带下限的表达式，视口矮时下限会顶穿屏幕。
 *
 * **「环境信息」抽屉只走了 `NESTED_DRAWER_SIZE`，语义槽样式是就地内联的一份副本**（值恰好相同，故今天看不出漂移；这是已知的重复，别把这条读成「两处都走共享常量」）。
 * 它用二级那一档而不是自持一份更窄的字面量：它本来就是「从主抽屉里再推出来的一层」，
 * 比主抽屉还窄的话长工具名与工作区路径会全被折行。
 */

/** 主抽屉的宽度（antd `Drawer` 的 `size`，可用 CSS 表达式）：50vw，下限 800px */
export const WIDE_DRAWER_SIZE = 'max(50vw, 800px)';

/** 二级抽屉的宽度：60vw，上限 900px（比主抽屉窄一档，推出来时仍看得见主抽屉） */
export const NESTED_DRAWER_SIZE = 'min(60vw, 900px)';

/**
 * **底部弹入**那一档的高度（`placement="bottom"` 时 `size` 是高度，不是宽度）：60vh，上限 560px。
 *
 * 为什么单独一档、且必须是 `min()` 而不是 `max()`：上面两档是宽度表达式，宽屏上从 800px / 900px
 * **起步**；把它当高度用，1440px 的视口里抽屉会比屏幕还高（底部贴边 ⇒ 顶出屏幕的部分再也够不着）。
 * `min()` 保证「内容少时收紧、内容多时最多占 60% 视口」，剩下的屏幕仍看得见背后的页面。
 *
 * 高度与宽度同一条口径：**只在这一处写字面量**。antd 6 已废弃 `height` / `width`
 * （只在 dev 打一句 warning），漏改会静默掉回默认 378px，没有用例变红——故消费者只引用常量。
 */
export const BOTTOM_PANEL_SIZE = 'min(60vh, 560px)';

/**
 * 二级抽屉打开时**把主抽屉推开**多远（px）。
 *
 * ⚠️ **这一格必须给「被推开的那个抽屉」（主抽屉），不是给二级抽屉**——这是 rc-drawer 的实际口径
 * （`DrawerPopup.js`：`pushDistance = push?.distance ?? parentPushDistance ?? 180`；
 * 二级抽屉 `open` 时调的是 `parentContext.push()`，位移量取的是**父级自己**那一份）。
 * **实测**：只在二级抽屉上写 360、主抽屉不写 ⇒ 主抽屉只挪 antd 的默认 **180**（量到的就是 180），
 * 那一格完全空转。默认 180 在宽屏上几乎看不出来，「我在第二层」这件事就看不出来，
 * 故三个主抽屉（评测页的 `DRAWER_GEOMETRY`）与 `AgentLogDrawer` 都显式写这一份。
 */
export const MAIN_DRAWER_PUSH = { distance: 360 } as const;

/** 三档抽屉共用的语义槽样式：窄屏兜底（`maxWidth` / `maxHeight`）+ 内容区自管内边距（`body.padding`） */
export const DRAWER_SEMANTIC_STYLES = {
  wrapper: { maxWidth: '100vw', maxHeight: '100vh' },
  body: { padding: 0 },
} as const;
