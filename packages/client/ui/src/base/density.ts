/**
 * 紧凑密度主题：全站「内容文字用小」的唯一定义点（设置页以 density="default" 豁免）。
 * 做法：antd 的 algorithm 接受数组并按序应用，[底色算法, compactAlgorithm] 即「明暗正确 + 更紧凑」。
 *
 * 两个不能改的地方（改了会静默出问题）：
 *   1. 绝不显式写 fontSize —— compactAlgorithm 会覆盖它：它取「基础算法派生出的 fontSizeSM」
 *      作为新基准再推导整档字号，于是 { fontSize: 12 } 的实效是 10px（比 antd 默认 14 还小）。
 *      实测：{ fontSizeSM: 11 } → 12/11/14（目标）；{ fontSize: 12 } → 10/8/12；
 *      {}（不传 token）→ 12/10/14。
 *   2. 间距与控件高度交给 compactAlgorithm，不重复手调 padding* / controlHeight 种子 token
 *      （与算法叠加会过度压缩）；lineHeight 也不动（缩小字号后行高比例已流体，动它易致行框局促）。
 */
import { theme } from 'antd';
import type { ThemeConfig } from 'antd';

/** 明暗模式（由 useResolvedTheme 解析应用设置得出） */
export type DensityMode = 'light' | 'dark';
/** 紧凑密度的字号 token：只给 fontSizeSM，其余两档交给 compactAlgorithm 派生 */
export const COMPACT_FONT_TOKENS = { fontSizeSM: 11 } as const;

/** 生成紧凑密度主题：algorithm 依赖明暗，故按 mode 参数化 */
export function compactTheme(mode: DensityMode): ThemeConfig {
  return {
    algorithm: [mode === 'light' ? theme.defaultAlgorithm : theme.darkAlgorithm, theme.compactAlgorithm],
    token: { ...COMPACT_FONT_TOKENS },
  };
}
