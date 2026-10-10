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
 *
 * **「环境信息」抽屉只走了 `NESTED_DRAWER_SIZE`，语义槽样式是就地内联的一份副本**（值恰好相同，故今天看不出漂移；这是已知的重复，别把这条读成「两处都走共享常量」）。原句「自 也走这一份」**不成立**（原先它在组件里自写 `min(42vw, 640px)`）：
 * 用户口径「宽一些」——旧值在 1432px 视口上只有 601px，比它推开的那个主抽屉还窄，
 * 工具名与工作区路径全被折行。它本来就是「从主抽屉里再推出来的一层」，故直接用二级那一档，
 * 不再自持一份字面量（多一份字面量 = 多一处会静默漂移的宽度）。
 */

/** 主抽屉的宽度（antd `Drawer` 的 `size`，可用 CSS 表达式）：50vw，下限 800px */
export const WIDE_DRAWER_SIZE = 'max(50vw, 800px)';

/** 二级抽屉的宽度：60vw，上限 900px（比主抽屉窄一档，推出来时仍看得见主抽屉） */
export const NESTED_DRAWER_SIZE = 'min(60vw, 900px)';

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

/** 两档抽屉共用的语义槽样式：窄屏兜底（`maxWidth`）+ 内容区自管内边距（`body.padding`） */
export const DRAWER_SEMANTIC_STYLES = {
  wrapper: { maxWidth: '100vw' },
  body: { padding: 0 },
} as const;
