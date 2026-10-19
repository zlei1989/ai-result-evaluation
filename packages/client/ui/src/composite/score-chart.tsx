'use client';

/**
 * 排名抽屉里的评分对比图：每个**出了分**的候选一根横柱，柱长 = 该候选的总分。
 *
 * 四条口径：
 *   1. **只有出了分的候选进来**：`score === null` 的行（没跑到评分 / 跑挂了）不进图。
 *      把它们折成 0 画一根柱，等于替使用者断言「它得了 0 分」，而事实是**没有读数**
 *      ——与排名表里写「未采集」是同一条口径，只是换成了图形上的说法；
 *   2. **一根柱都没有时整块不画图**：只留一句「未采集」。空坐标系（轴、网格、0 刻度）
 *      看起来像「都是 0」，比不画更糟；
 *   3. **颜色只取 CSS 变量**（`--chart-*` / `--border` / `--muted-foreground` / `--popover`）：
 *      本仓的明暗真源是 `html[data-theme]` 上的属性，同名变量在暗色块里被整块覆盖。
 *      组件因此不需要知道当前是哪套主题——写死颜色、或把明暗挂在某个全局类名上，切主题之后
 *      就会停在旧的那一套里；
 *   4. **尺寸由候选数算出来，不靠父容器量**：`recharts` 的 `ResponsiveContainer` 依赖
 *      `ResizeObserver` 回调，而 jsdom 永远收不到（`src/testing/resize-observer.ts` 的替身
 *      **从不调用回调**）⇒ 图在用例里恒为 0 尺寸、断言全成空跑。所以宽度取常量、高度随行数增长，
 *      外层用 `width: 100%` 让它按 SVG 的 `viewBox` 等比铺开。
 *
 * 名次顺序沿用调用方给的 `rows` 顺序（排名表用的是 `orderForDisplay`，两处不各排一次）。
 * 刻度上限取各行**自报满分**的最大值：评分表改过之后两行的尺子可能不同，写死 100 会说谎。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, Tooltip, XAxis, YAxis } from 'recharts';
import { AGENT_LABELS, type EvalRow } from '@aieval/contracts';

/** 图的逻辑宽度（px）：`viewBox` 的横向基准，外层按 `width: 100%` 等比缩放 */
export const SCORE_CHART_WIDTH = 640;

/** 每根柱占的高度（px）：柱 16 + 上下留白，够放 11px 的类目名 */
export const SCORE_CHART_ROW_HEIGHT = 36;

/** 图高 = 基准（上下边距 + 刻度）+ 每行一份 */
export const SCORE_CHART_BASE_HEIGHT = 72;

/** 左锁列宽度（px）：装「智能体 + 模型」，与排名表首列同一口径（长名折不下时由 Y 轴截断，浮层给全名） */
export const SCORE_CHART_LABEL_WIDTH = 176;

/**
 * 系列色：用 `--primary` 而不是 `--chart-1`——本仓是单色层级（颜色只标状态），
 * 柱长已经是唯一的读数，再给一档橙/蓝只会让图成为页面上唯一一个「外来色」。
 * 明暗两套由 `globals.css` 里同名变量各自覆盖。
 */
export const SCORE_CHART_BAR_FILL = 'var(--primary)';

/** 网格与刻度的颜色：同样是语义变量，不写死灰度 */
const AXIS_STROKE = 'var(--border)';
const TICK_STYLE = { fill: 'var(--muted-foreground)', fontSize: 11 } as const;

/** 图里的一根柱：名次那一列的可读名字 + 总分 + 这一行自报的满分 */
export interface ScoreChartDatum {
  id: string;
  name: string;
  score: number;
  maxScore: number;
}

/**
 * 从行集投影出图的输入：**滤掉没出分的行**，名字由「智能体 + 模型」拼成
 * （只用模型名时，两个厂商跑同一个模型会被读成同一根柱）。
 */
export function scoreChartData(rows: readonly EvalRow[]): ScoreChartDatum[] {
  return rows.flatMap((row) =>
    row.score === null
      ? []
      : [
        {
          id: row.id,
          name: `${AGENT_LABELS[row.agentKind]} ${row.modelId}`,
          score: row.score.totalScore,
          maxScore: row.score.maxScore,
        },
      ],
  );
}

/** 图高：随出分候选数增长（3 个候选 ≈ 180px，9 个 ≈ 396px，抽屉里滚动） */
export function scoreChartHeight(count: number): number {
  return SCORE_CHART_BASE_HEIGHT + count * SCORE_CHART_ROW_HEIGHT;
}

/**
 * 数值轴的上限：取各行自报满分的最大值。
 * 调用方只在 `data` 非空时用（空数组会得到 `-Infinity`，而空数据根本走不到画图这一步）。
 */
export function scoreChartDomainMax(data: readonly ScoreChartDatum[]): number {
  return data.reduce((max, datum) => Math.max(max, datum.maxScore), 0);
}

export interface ScoreChartProps {
  /** 候选行集，顺序即图的顺序（排名页传 `orderForDisplay(run.rows)` 的结果） */
  rows: readonly EvalRow[];
}

export function ScoreChart({ rows }: ScoreChartProps): ReactNode {
  const data = scoreChartData(rows);
  const hostRef = useRef<HTMLDivElement | null>(null);

  /**
   * 图表是下方排名表的**视觉摘要**，不是第二个数据源：不参与 Tab 序列，也不接管抽屉打开时的焦点。
   * recharts 默认给 SVG 挂 `tabindex=0`（键盘可读），于是抽屉一打开焦点就落在图上——
   * 5px 的 UA 焦点框会画出一圈黑边，聚焦态还会把 tooltip 常显在图上。
   * 这里把 tabindex 收掉，并把误落的焦点交还给覆盖层的关闭按钮（键盘用户仍能立刻离开）。
   * 读数在表里逐项可读，故不退化成「图不可访问」。
   */
  useEffect(() => {
    const surface = hostRef.current?.querySelector<SVGElement>('.recharts-surface');
    if (!surface) return;
    surface.setAttribute('tabindex', '-1');
    if (document.activeElement === surface) {
      const popup = surface.closest('[data-slot="sheet-content"]');
      popup?.querySelector<HTMLElement>('[data-slot="sheet-close"], [aria-label="关闭详情"]')?.focus();
    }
  });

  // 没有出分的候选：写「未采集」而不是画一张空坐标系（口径 2）
  if (data.length === 0) {
    return (
      <div className="flex flex-col gap-1" data-testid="rank-score-chart">
        <span className="text-sm text-muted-foreground" data-testid="rank-score-chart-empty">
          未采集
        </span>
      </div>
    );
  }

  const height = scoreChartHeight(data.length);

  return (
    <div ref={hostRef} data-testid="rank-score-chart" style={{ width: '100%', height }}>
      <BarChart
        layout="vertical"
        width={SCORE_CHART_WIDTH}
        height={height}
        data={data}
        margin={{ top: 4, right: 40, bottom: 4, left: 4 }}
      >
        {/* 横向柱图：只留纵向网格（读数沿横向走） */}
        <CartesianGrid stroke={AXIS_STROKE} horizontal={false} />
        <XAxis type="number" domain={[0, scoreChartDomainMax(data)]} stroke={AXIS_STROKE} tick={TICK_STYLE} />
        <YAxis
          type="category"
          dataKey="name"
          width={SCORE_CHART_LABEL_WIDTH}
          stroke={AXIS_STROKE}
          tick={TICK_STYLE}
          interval={0}
        />
        <Tooltip
          // 浮层是 HTML：底色、边框、字色都只在语义变量里取，否则暗色下是一块白底
          cursor={{ fill: 'var(--accent)' }}
          contentStyle={{
            backgroundColor: 'var(--popover)',
            borderColor: 'var(--border)',
            borderRadius: 6,
            color: 'var(--popover-foreground)',
            fontSize: 12,
          }}
          labelStyle={{ color: 'var(--popover-foreground)' }}
          itemStyle={{ color: 'var(--popover-foreground)' }}
        />
        {/* 关掉入场动画：柱长是读数，动一下只会让人以为数值在变 */}
        <Bar dataKey="score" fill={SCORE_CHART_BAR_FILL} isAnimationActive={false} barSize={16}>
          <LabelList dataKey="score" position="right" fill="var(--foreground)" fontSize={11} />
        </Bar>
      </BarChart>
    </div>
  );
}
