/**
 * 分栏宽度规划：把「容器宽 + 用户偏好」换算成两栏各占多少像素，以及详情栏当前可用的 min/max。
 *
 * 为什么需要它：`react-resizable-panels` 只按百分比布局，像素下限由调用方换算成 `minSize`/`maxSize`
 * 传进去；一旦两栏下限之和超过容器，库会把两栏按比例一起压，谁的下限都保不住。规划函数先把
 * **列表栏的 min 扣出来**，再决定详情栏的宽度与它的边界，于是「窄窗下列表栏不低于 min」成为
 * 布局输入本身的约束，而不是事后再修。
 *
 * 宽度口径：
 *   · `available` 是**容器**宽度（含分隔条），`separator` 是分隔条实际占位；两栏可分配的是差额。
 *   · `available <= 0` 表示还没量到容器（首帧 / 无 ResizeObserver）：此时按偏好给详情栏，
 *     边界用声明值——挂载期的 `defaultSize` 会落在同一条线上，不会先闪一个错误宽度。
 *   · 详情栏始终不超过「扣掉分隔条与列表栏 min 之后剩下的宽度」；容器窄到连详情栏的声明下限
 *     都放不下时，下限跟着预算下降（下限优先让给列表栏，它才是主内容）。
 */
export interface PaneWidthInput {
  /** 容器实测宽度（px）；<= 0 表示还没量到 */
  available: number;
  /** 详情栏的用户偏好宽度（px） */
  preferred: number;
  /** 列表栏下限（px） */
  minList: number;
  /** 详情栏声明下限（px） */
  minDetail: number;
  /** 详情栏声明上限（px） */
  maxDetail: number;
  /** 分隔条占位宽度（px） */
  separator: number;
}

export interface PaneWidthPlan {
  /**
   * 列表栏得到的宽度（px）；容器未量到时为 0（无实际布局参照）。
   * 组件不消费它——左栏由分栏库吃掉剩余空间——但它是本函数的另一半契约：
   * 「窄窗下列表栏不低于 min」要能直接断言，而不是再从详情栏反推。
   */
  list: number;
  /** 详情栏应占宽度（px） */
  detail: number;
  /**
   * 详情栏在当前容器下的有效下限（px），直接喂 `Panel` 的 `minSize`。
   * 两栏下限之和放不下时它低于声明下限：宁可让详情栏窄一点，也不让左栏被一起压到 min 以下。
   */
  detailMin: number;
}

/** 分隔条的布局占位：命中带由库的 overlays 另算，这条只参与「两栏可分配多少」 */
export const PANE_SEPARATOR_WIDTH = 6;

/** 把详情栏偏好夹到当前容器允许的区间；容器未知时只按声明区间夹 */
export function planPaneWidths(input: PaneWidthInput): PaneWidthPlan {
  const want = clamp(input.preferred, input.minDetail, input.maxDetail);
  if (input.available <= 0) {
    return { list: 0, detail: want, detailMin: input.minDetail };
  }

  const budget = Math.max(0, input.available - input.separator);
  // 扣掉列表栏的 min 之后，详情栏最多能拿这么多；它同时是「窄窗时让给列表栏」的硬边界。
  const detailCeiling = Math.max(0, budget - input.minList);
  // 连详情栏的声明下限都放不下时，下限降到 ceiling——两栏下限之和绝不超出预算，
  // 否则 rrp 把百分比一起归一化，列表栏会被按比例压回 min 以下。
  const detailMin = Math.min(input.minDetail, detailCeiling);
  const detailMax = Math.min(input.maxDetail, detailCeiling);
  const detail = clamp(want, detailMin, detailMax);
  return {
    list: Math.max(0, budget - detail),
    detail,
    detailMin,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
