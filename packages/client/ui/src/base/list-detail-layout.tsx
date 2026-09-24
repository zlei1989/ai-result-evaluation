'use client';

/**
 * 列表 + 可拖拽宽度右边栏：这一形态的**唯一出口**。
 * 用例页与评测页都复用它，不再各写一套；示例页也用它（脚手架阶段用来验证整套原语能用）。
 *
 * 三个行为要点：
 *   1. 右侧宽度 = 偏好（localStorage）× 容器可用宽的比例还原 ⇒ 窗口变窄时按比例收，
 *      而不是被 Splitter 硬夹到 min 导致栏间比例跳变；
 *   2. 拖拽时把**右栏像素宽**回写进本地状态与偏好——受控模式下不回写，松手会弹回
 *      （见 resizable-columns 的文件头口径③）；
 *   3. detail 为 null 或 detailOpen=false 时退化为单栏列表占满，
 *      **不要**渲染宽度为 0 的 Panel（Splitter 的 min 会把它夹回最小宽、留下一条空栏）。
 *
 * 要点 3 的两个条件**都要判**：只看 detailOpen 时，`detail={null}` 会渲染出一条
 * 右栏外壳（分隔条 + 宿主都在），正是要点里说的「一条空栏」；调用方在「详情未选中」时
 * 传 null 是常态，所以这里按文件头的口径把两个条件都收进同一个判定。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { PageShell } from './page-shell';
import { useStoredWidth } from './stored-preference';
import {
  HANDLE_HIT_WIDTH,
  ResizableColumns,
  restoreWidthsToAvailable,
  type PaneGeometry,
  type ResizablePane,
} from './resizable-columns';

export interface ListDetailLayoutProps {
  /** 左栏内容（列表 / 表格） */
  list: ReactNode;
  /** 右栏内容；与 detailOpen=false 一起表示「不显示右栏」 */
  detail: ReactNode;
  /** 右栏是否显示 */
  detailOpen: boolean;
  /** 右栏宽度偏好的 localStorage 键（每页各一个，避免互相覆盖） */
  widthStorageKey: string;
  /** 右栏默认宽度（px），默认 420 */
  defaultDetailWidth?: number;
  /** 右栏宽度下限（px），默认 320 */
  minDetailWidth?: number;
  /** 右栏宽度上限（px），默认 900 */
  maxDetailWidth?: number;
}

/** 列表栏的几何：弹性列（吃剩余），只给一个不塌的下限 */
const LIST_MIN_WIDTH = 120;

export function ListDetailLayout({
  list,
  detail,
  detailOpen,
  widthStorageKey,
  defaultDetailWidth = 420,
  minDetailWidth = 320,
  maxDetailWidth = 900,
}: ListDetailLayoutProps): ReactNode {
  const [preferredWidth, setPreferredWidth] = useStoredWidth(
    widthStorageKey,
    defaultDetailWidth,
    minDetailWidth,
    maxDetailWidth,
  );
  // 容器实测宽度：首帧未知，用 0 表示「还没量到」——此时不还原，直接给偏好值
  const [available, setAvailable] = useState(0);
  // 本次渲染实际传给 Splitter 的右栏像素宽（拖动过程中由 onWidthsChange 更新）
  const [renderWidth, setRenderWidth] = useState<number | null>(null);

  const panes: PaneGeometry[] = useMemo(
    () => [
      { width: 0, min: LIST_MIN_WIDTH, max: Number.MAX_SAFE_INTEGER, flexible: true },
      { width: preferredWidth, min: minDetailWidth, max: maxDetailWidth },
    ],
    [preferredWidth, minDetailWidth, maxDetailWidth],
  );

  // 可用宽或偏好变化时，按比例还原出本次渲染的右栏宽度
  const detailWidth = useMemo(() => {
    if (renderWidth !== null) return renderWidth;
    if (available <= 0) return preferredWidth;
    return restoreWidthsToAvailable([0, preferredWidth], panes, available, 1)[1] ?? preferredWidth;
  }, [renderWidth, available, preferredWidth, panes]);

  const handleWidthsChange = useCallback(
    (widths: number[]) => {
      const next = widths[1];
      if (next === undefined || !Number.isFinite(next)) return;
      setRenderWidth(next);
      // 落库的是「用户意图宽度」——夹紧由 useStoredWidth 负责
      setPreferredWidth(next);
    },
    [setPreferredWidth],
  );

  // 容器尺寸变化时清掉拖动期的临时值，回到「按可用宽比例还原」的路径
  const handleAvailableChange = useCallback((next: number) => {
    setAvailable(next);
    setRenderWidth(null);
  }, []);

  // 右栏的显示条件：开关打开**且确实有内容**——只看开关会让 detail=null 留下一整条空栏（见文件头）
  const showDetail = detailOpen && detail !== null && detail !== undefined;

  const listPane: ResizablePane = {
    key: 'list',
    label: '列表',
    content: list,
    width: 0,
    min: LIST_MIN_WIDTH,
    max: Number.MAX_SAFE_INTEGER,
    flexible: true,
    style: { padding: 8 },
  };

  const detailPane: ResizablePane = {
    key: 'detail',
    label: '详情',
    content: detail,
    width: Math.round(detailWidth),
    min: minDetailWidth,
    max: maxDetailWidth,
    // 右栏内容可长（用例正文、评测日志），必须自己滚：宿主默认 overflow:hidden 会把它裁掉
    style: { overflow: 'auto', padding: 8 },
  };

  return (
    <PageShell>
      {showDetail ? (
        <ResizableColumns
          panes={[listPane, detailPane]}
          onWidthsChange={handleWidthsChange}
          onAvailableChange={handleAvailableChange}
        />
      ) : (
        // 单栏：列表占满。不要用「宽度为 0 的 Panel」代替——Splitter 的 min 会把它夹回来
        <div style={{ height: '100%', minHeight: 0, overflow: 'auto', padding: 8 }}>{list}</div>
      )}
    </PageShell>
  );
}

/** 分隔条命中带宽度，供调用方做几何断言时复用（避免魔法数字散落） */
export { HANDLE_HIT_WIDTH };
