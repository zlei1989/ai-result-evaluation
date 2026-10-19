'use client';

/**
 * 列表 + 可拖拽宽度右边栏：这一形态的**唯一出口**。用例页与评测页都复用它，不再各写一套。
 *
 * 布局交给 `react-resizable-panels` 的 `Group` / `Panel` / `Separator`：
 *   · `Panel` 没有受控的 `size` prop，宽度由库自己维护（拖拽、键盘、双击复位）；
 *     外部只能用 `panelRef.resize(px)` 命令式写回，故这里是「规划值驱动」：
 *     存量值读完、详情栏重新出现、视口变化，都按规划出的**像素**写一次；
 *   · 详情栏声明 `groupResizeBehavior="preserve-pixel-size"` ⇒ 窗口变宽变窄时它保持像素宽，
 *     列表栏吃掉变化；`minSize` 由规划函数按容器算，窄窗下列表栏不会被压到 min 以下；
 *   · `maxSize` 保持声明值不动：每帧改 max 会触发约束重算，把 `preserve-pixel-size` 的
 *     像素意图冲成比例，实时缩窗就退化成「按比例缩」；
 *   · `Separator` 自带双击复位（回到 `defaultSize`），不再需要自己实现。
 *
 * 像素持久化的分工：
 *   1. 存量值经 `useStoredWidth` 在挂载后读出（首帧不读，避免水合不一致）；
 *   2. 读到了就用 `resize(px)` 写回——**不能按比例送**，比例会随窗口宽漂移；
 *   3. 用户拖拽时 `onResize` 上报 `inPixels`，`onLayoutChanged` 的 `isUserInteraction` 为真才落盘；
 *      窗口缩放导致的夹紧不是用户意图，不能覆盖已保存的宽度。
 *
 * detail 为 null 或 detailOpen=false 时退化为单栏列表占满：**不要**渲染宽度为 0 的 Panel
 * （min 会把它夹回来、留下一条空栏），故两个条件都要判。
 *
 * 窄视口（< xl，即 1279px 及以下）默认改走 **Sheet 覆盖**：并排在 1280 以下会把列表栏压到
 * 列宽之和以下（770），表格只能横向滚动。阈值取 1280 是因为「列表栏 120 下限 + 详情 420 +
 * 分隔条 6 + 两侧 32」在 1280 时仍放得下六列表格；再窄就交给覆盖层，列表保持整宽。
 * `narrowDetail="pane"` 可退回并排（给需要对照两栏的调用方留口子）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { XIcon } from 'lucide-react';
import {
  Group,
  Panel,
  Separator,
  usePanelRef,
  type LayoutChangedMeta,
  type PanelSize,
} from 'react-resizable-panels';
import { Button } from '../components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { PageShell } from './page-shell';
import { PANE_PADDING } from './pane-metrics';
import { PANE_SEPARATOR_WIDTH, planPaneWidths } from './pane-width-plan';
import { useStoredWidth } from './stored-preference';

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
  /**
   * 窄视口（< 1280）下右栏的形态：`overlay`（默认，Sheet 覆盖）| `pane`（仍并排）。
   * 并排在 1280 以下会把列表压到列宽之和以下，表格只能横向滚动。
   */
  narrowDetail?: 'overlay' | 'pane';
  /** 窄视口覆盖层的关闭回调（关闭按钮与遮罩都走它）；不传则只能由外部关 */
  onRequestCloseDetail?: () => void;
}

/** 列表栏的几何：吃剩余空间，但任何时候都不低于这个宽度 */
const LIST_MIN_WIDTH = 120;

/** 栏宿主的公共不变量：撑满、可收缩、纵向 flex（内容里的 flex:1 才有参照） */
const PANE_HOST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
};

/** 双栏模式下列表栏自己裁切：表格/虚拟列表的内部滚动条不能被外层再套一层 */
const LIST_PANE_STYLE: CSSProperties = { ...PANE_HOST_STYLE, overflow: 'hidden', padding: PANE_PADDING };

/** 详情栏内容可长（用例正文、评测日志），必须自己滚 */
const DETAIL_PANE_STYLE: CSSProperties = { ...PANE_HOST_STYLE, overflow: 'auto', padding: PANE_PADDING };

/** 单栏模式：列表占满，由它自己滚 */
const LIST_SINGLE_STYLE: CSSProperties = { ...PANE_HOST_STYLE, overflow: 'auto', padding: PANE_PADDING };

/**
 * 两栏内容的内边距：定义搬到了叶子模块 `pane-metrics.ts`（详情面板只消费这个数，
 * 不该为读一个常数把整张布局图拉进来），这里原样转出以保持既有调用点与包出口不变。
 */
export { PANE_PADDING } from './pane-metrics';

/** 窄视口断点（低于 Tailwind 的 `xl`）：并排在 1280 以下放不下六列表格 */
const NARROW_QUERY = '(max-width: 1279px)';

/**
 * 订阅窄视口。jsdom 没有 `matchMedia` 时恒为 false（并排分支），
 * 生产环境的 SSR 快照也取 false——首帧与 `PageShell` 的并排结构一致，水合后窄窗再切覆盖层。
 */
function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const query = window.matchMedia(NARROW_QUERY);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(NARROW_QUERY).matches
        : false,
    () => false,
  );
}

export function ListDetailLayout({
  list,
  detail,
  detailOpen,
  widthStorageKey,
  defaultDetailWidth = 420,
  minDetailWidth = 320,
  maxDetailWidth = 900,
  narrowDetail = 'overlay',
  onRequestCloseDetail,
}: ListDetailLayoutProps): ReactNode {
  const [preferredWidth, setPreferredWidth, hydrated] = useStoredWidth(
    widthStorageKey,
    defaultDetailWidth,
    minDetailWidth,
    maxDetailWidth,
  );
  const narrow = useNarrowViewport();
  const detailRef = usePanelRef();
  const groupElementRef = useRef<HTMLDivElement | null>(null);
  // 容器实测宽度：0 表示还没量到（首帧 / 无 ResizeObserver），此时方案退回声明边界
  const [available, setAvailable] = useState(0);

  // 右栏的显示条件：开关打开**且确实有内容**——只看开关会让 detail=null 留下一整条空栏
  const showDetail = detailOpen && detail !== null && detail !== undefined;

  const plan = planPaneWidths({
    available,
    preferred: preferredWidth,
    minList: LIST_MIN_WIDTH,
    minDetail: minDetailWidth,
    maxDetail: maxDetailWidth,
    separator: PANE_SEPARATOR_WIDTH,
  });
  // 容器宽度：首帧直接读一次，之后交给 ResizeObserver。量不到就保持 0（方案按声明边界走）
  useLayoutEffect(() => {
    if (!showDetail) {
      setAvailable(0);
      return;
    }
    const node = groupElementRef.current;
    if (node === null) return;
    const report = (): void => setAvailable(node.offsetWidth);
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [showDetail]);

  // 宽度由规划值驱动：存量值读完、详情栏重新出现、视口变化时，都用 resize(px) 一次写回。
  // `Panel` 没有受控 `size`，命令式 `resize` 是唯一的受控入口；写回的是规划后的**像素**，
  // 不是比例（比例会随容器宽漂移，刷新/缩窗后就对不上了）。
  // 为什么视口变化也要重写：库的 `preserve-pixel-size` 在「下限被临时夹紧」后会记住夹紧值，
  // 窗口再变宽时停在 min 上；由规划值兜底才能回到用户拖过的宽度。
  useEffect(() => {
    if (!hydrated || !showDetail) return;
    detailRef.current?.resize(plan.detail);
  }, [hydrated, showDetail, plan.detail, detailRef]);

  // onResize 是像素宽的唯一可靠来源（库按元素实测给出 inPixels）
  const pendingPixels = useRef<number | null>(null);
  const handleDetailResize = useCallback((size: PanelSize) => {
    pendingPixels.current = Math.round(size.inPixels);
  }, []);

  // 落盘只在用户直接操作后发生：窗口缩放/夹紧是约束重算，不代表用户想要这个宽度
  const handleLayoutChanged = useCallback(
    (_layout: unknown, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction) return;
      const next = pendingPixels.current;
      if (next !== null) setPreferredWidth(next);
    },
    [setPreferredWidth],
  );

  // 双击复位由库完成（回到 defaultSize）；它走命令式 API、不会被标为用户交互，
  // 故这里显式把复位后的目标宽写进偏好，否则刷新又会回到拖过的宽度。
  const handleSeparatorDoubleClick = useCallback(() => {
    setPreferredWidth(defaultDetailWidth);
  }, [defaultDetailWidth, setPreferredWidth]);

  if (!showDetail) {
    // 单栏：列表占满。不要用「宽度为 0 的 Panel」代替——min 会把它夹回来、留下一条空栏
    return (
      <PageShell>
        <div style={LIST_SINGLE_STYLE}>{list}</div>
      </PageShell>
    );
  }

  // 窄视口 + 覆盖模式：列表保持整宽，详情走 Sheet。两栏的宽度规划在这一支完全不参与，
  // 存量宽度也不会被改写（宽度偏好只在并排时才有意义）。
  if (narrow && narrowDetail === 'overlay') {
    return (
      <PageShell>
        <div style={LIST_SINGLE_STYLE}>{list}</div>
        <Sheet open onOpenChange={(open) => { if (!open) onRequestCloseDetail?.(); }}>
          <SheetContent
            side="right"
            showCloseButton={false}
            className="gap-0 p-0"
            // 宽度走内联 style：Sheet 的 `data-[side=right]:sm:max-w-sm` 带变体前缀，
            // 同组工具类吃不掉它（tailwind-merge 按变体分组），会在 640 以上被夹成 24rem。
            style={{ width: 'min(440px, 100vw)', maxWidth: '100vw' }}
          >
            <SheetHeader className="flex-row items-center justify-between border-b border-border">
              <SheetTitle>详情</SheetTitle>
              <SheetDescription className="sr-only">这一行的详情与操作</SheetDescription>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="关闭详情"
                onClick={onRequestCloseDetail}
              >
                <XIcon aria-hidden />
              </Button>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{detail}</div>
          </SheetContent>
        </Sheet>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <Group
        id="list-detail"
        elementRef={groupElementRef}
        onLayoutChanged={handleLayoutChanged}
        style={{ flex: 1, minWidth: 0, minHeight: 0 }}
      >
        <Panel
          id="list"
          data-testid="resizable-pane-list"
          role="group"
          aria-label="列表"
          minSize={LIST_MIN_WIDTH}
          style={LIST_PANE_STYLE}
        >
          {list}
        </Panel>
        <Separator
          id="list-detail-handle"
          aria-label="调整列表与详情宽度"
          onDoubleClick={handleSeparatorDoubleClick}
          style={{ width: PANE_SEPARATOR_WIDTH }}
          className="bg-border"
        />
        <Panel
          id="detail"
          panelRef={detailRef}
          data-testid="resizable-pane-detail"
          role="group"
          aria-label="详情"
          defaultSize={defaultDetailWidth}
          minSize={plan.detailMin}
          maxSize={maxDetailWidth}
          groupResizeBehavior="preserve-pixel-size"
          onResize={handleDetailResize}
          style={DETAIL_PANE_STYLE}
        >
          {detail}
        </Panel>
      </Group>
    </PageShell>
  );
}
