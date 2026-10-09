'use client';

/**
 * 「原始输出」入口 + 二级抽屉：**两种变体共用一个件**——固定区的逐行原文（`AgentLogDiagnostics`）
 * 与卡片底部的单份原文（`ToolCardResult`）。
 *
 * 七条口径：
 *   1. **本件只画 ready 态**。`Loadable` 的三态画面（`Skeleton` / `Alert` + 重试）由**调用方**决定：
 *      「取到没有」这件事只有数据层知道（UI 不做取数），本件吃的是已经到手的数据；
 *   2. **逐行原文逐字给出、不解析**。`summary` 是给人看的一句话，有就**优先**渲染，
 *      但 `text` 原文照旧逐字给出——规范逐字禁「拿 `text` 顶替 `summary`」，
 *      反过来用 `text` 顶替也不对（原文与归纳是两件事）。
 *      唯一例外是 **`single` 变体的正文**（卡片底部那一份原文）：自 2026-10-04 起走 `JsonText`
 *      ——是 JSON 就缩进格式化 + 高亮，不是就**逐字原样**（`diagnostics` 那一档的逐行台账一字不动）；
 *   3. **`lines` 为空不渲染入口**：一个「原始输出 0 条」的按钮没有任何信息量；
 *   4. **不做脱敏**：`secret` 类遮罩是显示口径、由调用方决定（本件不装安全边界）；
 *   5. **入口是一个按钮、正文在二级抽屉里**（2026-10-03 用户口径）：原文不再挤占主抽屉固定区
 *      的高度（50 条 `[时间] 来源 原文` 会把时间轴压掉一大截），点开才在 `NestedDrawer` 里整段看；
 *   6. **开合态一律受控**（`agent-log-layering.test.ts` (d)：L0/L1 不许持态。那一条**先剥注释再扫**，
 *      所以这里写出那个 hook 名也不会命中；绕着写只是习惯，不是判据要求）：固定区那一支由 `AgentLogLayout` 持态
 *      （它还要借这个回调向数据层上报「我需要了」——见 `agent-log-layout.tsx` 的
 *      `handleRawOpenChange`），卡片底部那两支由**同一份折叠态**按键控开合
 *      （键 = 块键 + `|raw`，见 `agent-message-timeline.tsx` 的 `contextOf`）。
 *      抽屉不像 `Collapse` 那样自带非受控态，故这一格从「可选」变成了**必填**；
 *   7. **本件不自带布局容器**（用户 2026-10-07 口径）：返回的是**按钮本身**（Fragment），
 *      横排 / 换行 / 间距由调用方的容器给——固定区里它与「下载台账」同层，卡片底部各自包一层。
 *      原先自带一层 `Flex gap={8}`，症状是同一行里两套间距、且「这一行有哪几个按钮」要去两层里数。
 */
import { Button, Flex, Typography } from 'antd';
import type { ReactNode } from 'react';
import { JsonText } from '../../base/json-text';
import { MonoText } from '../../base/mono-text';
import { NestedDrawer } from '../../base/nested-drawer';
import { VirtualList } from '../../base/virtual-list';
import type { AgentLogDiagnostics, ToolCardResult } from './types';
import { truncationNote } from './types';

export interface RawOutputPanelProps {
  /** `diagnostics` 变体（固定区的「原始输出 N 条」）或 `single` 变体（卡片底部的「原始结果」） */
  source: { kind: 'diagnostics'; diagnostics: AgentLogDiagnostics } | { kind: 'single'; result: ToolCardResult };
  /** 二级抽屉的开合（**受控**，见文件头口径 6） */
  open: boolean;
  onOpenChange(next: boolean): void;
  /** 数据层重取（`source.requestDiagnostics`）；**不给时不渲染重试按钮** */
  onRetry?(): void;
  /** `single` 变体的入口与标题文案，默认「原始结果」 */
  label?: string;
}

/** 正文内边距（px）：二级抽屉的 `body.padding` 已置 0（见 `base/drawer-geometry.ts`），由内容自己给 */
const BODY_PADDING = 16;

/** 逐行原文之间留的空（px）：虚拟列表里没有 `gap` 可用（行是各自独立的绝对定位项），加在行上 */
const ROW_GAP = 8;

/**
 * 正文行前缀的时间戳：ISO → 本机时区的 `HH:mm:ss`，非法输入原样返回。
 * 与 `log-format.ts` 的 `formatClock` 同一口径，但那边没有导出（它只服务下载台账），
 * 本件不为了一个两行的格式化去改它。
 */
function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 非空判定：契约里 `null` = 未采集，空串同样是「没有这句话」（两者都不该占一行） */
function hasText(value: string | null): value is string {
  return value !== null && value !== '';
}

/**
 * 逐行原文：每行先给「给人看的一句话」（有才给），再逐字给出 `[时间] 来源 原文`。
 *
 * **走虚拟滚动**（2026-10-03 用户口径：「避免数据量大浏览器卡顿」）：`lines` 没有上限
 * （`diagnosticsOf` 把全部 `log` 事件映射成行，服务端 `readEvents` 也读整份文件），
 * 长跑的 stdout 上千行 ⇒ 普通 `.map` 就是几千个节点、且每次新事件到都整段重渲。
 * 虚拟化本身住在 `base/virtual-list.tsx`（**虚拟化的唯一持有者**；全仓另一处 `<Listy>` 在问答卡片的选项列表里，不虚拟化），
 * 本件只提供行内容与 `rowKey`。
 *
 * **截断提示留在列表外的固定位置**（不放进虚拟列表）：它是「这份原文本身不全」的结论，
 * 跟着滚出屏幕就等于没说。
 */
function diagnosticsBody(diagnostics: AgentLogDiagnostics): ReactNode {
  return (
    <Flex vertical style={{ height: '100%', display: 'flex', flexDirection: 'column' }} data-testid="agent-log-diagnostics">
      <VirtualList
        testId="raw-output-list"
        items={diagnostics.lines}
        // 行没有 id（契约里就是一段无结构的文本流），`at` + 序号足够稳定：`lines` 只追加、不重排
        rowKey={(line, index) => `${index}|${line.at}`}
        itemRender={(line) => (
          <Flex
            vertical
            gap={4}
            // 横向内边距加在行上（不是外面包一层）：滚动条才会贴抽屉边缘
            style={{ padding: `0 ${BODY_PADDING}px ${ROW_GAP}px` }}
            data-testid="raw-output-line"
          >
            {hasText(line.summary) && <Typography.Text>{line.summary}</Typography.Text>}
            <MonoText text={`[${formatClock(line.at)}] ${line.source} ${line.text}`} />
          </Flex>
        )}
      />
      {hasText(diagnostics.truncatedReason) && (
        <Typography.Text type="warning" style={{ padding: `0 ${BODY_PADDING}px ${BODY_PADDING}px` }}>
          {diagnostics.truncatedReason}
        </Typography.Text>
      )}
    </Flex>
  );
}

/** 单份原文：`raw` 为 null 时说「结果未采集」，不留一个空白的抽屉 */
function singleBody(result: ToolCardResult): ReactNode {
  const note = truncationNote(result.truncation);
  return (
    <Flex vertical gap={4}>
      {result.raw === null ? (
        <Typography.Text type="secondary">结果未采集</Typography.Text>
      ) : (
        // 不传 `maxHeight`：正文交给抽屉 body 自己滚，这里不再开第二个滚动区
        // （与环境抽屉同口径：一个抽屉里不该出现两条滚动条）。
        // 走 `JsonText`：是 JSON 就缩进格式化 + 高亮，不是就逐字原样（口径 2 不变）
        <JsonText text={result.raw} />
      )}
      {hasText(note) && <Typography.Text type="warning">{note}</Typography.Text>}
    </Flex>
  );
}

/**
 * 入口渲不渲染的**唯一判据**：`diagnostics` 变体在 `lines` 为空时连入口都不出现
 * （§5.3：`ready` 且空表不是「一条都没有」，是没有这个入口）。
 *
 * 导出是因为**调用方要用同一条判据**：固定区那一行还要摆「下载台账」（`placement: 'raw'`），
 * 而「这一行有没有原文」决定整行要不要画——不画的话固定区会多出一段空 gap。
 * 两处各写一遍必然漂移，而漂移的症状是「原文为 0 条时下载按钮上面多一条空隙」。
 */
export function hasRawEntry(source: RawOutputPanelProps['source']): boolean {
  return !(source.kind === 'diagnostics' && source.diagnostics.lines.length === 0);
}

export function RawOutputPanel({ source, open, onOpenChange, onRetry, label }: RawOutputPanelProps): ReactNode {
  // 判据见 `hasRawEntry`（调用方用的是同一条）
  if (!hasRawEntry(source)) return null;

  const text =
    source.kind === 'diagnostics' ? `原始输出 ${source.diagnostics.lines.length} 条` : label ?? '原始结果';

  return (
    /*
     * **本件不自带容器**（用户 2026-10-07 口径：把包裹那一层去掉，按钮拿出来）。
     * 入口按钮与「重新读取」直接进调用方的排布容器，与旁边的兄弟（固定区里是「下载台账」）
     * 同层——原先那层 `Flex gap={8}` 会在行里再嵌一层，同一个行里出现两套间距，
     * 且让「这一行有哪几个按钮」变得要去两层里数。
     * 摆位（横排 / 换行 / 间距）归调用方：固定区是原文行那个 `Flex`，卡片底部各自包一层。
     * `NestedDrawer` 走 portal，不占父容器的排布（开合与标题都不受影响）。
     */
    <>
      <Button
        size="small"
        autoInsertSpace={false}
        data-testid="raw-output-open"
        onClick={() => onOpenChange(true)}
      >
        {text}
      </Button>
      {onRetry !== undefined && (
        // 重取入口：数据层可能在 ready 之后丢流；调用方不传 `onRetry` 时这里一个按钮都不渲染。
        // **样式与旁边两个按钮同形**（默认按钮 + `size="small"`，用户 2026-10-03 口径）：
        // 原先写成 `type="text"`（无边框），与「原始输出 N 条」「下载台账」并排时像是另一类东西
        <Button size="small" autoInsertSpace={false} onClick={onRetry}>
          重新读取
        </Button>
      )}
      <NestedDrawer open={open} onClose={() => onOpenChange(false)} title={text}>
        {source.kind === 'diagnostics' ? (
          /*
            诊断变体：正文**取满抽屉正文的高度**（`display` / `flexDirection` 写进内联 style——
            antd 的 `Flex` 这两个属性走 CSS 类，内联读不到，而这里是结构性不变量）。
            高度有界是虚拟滚动的**前提**：量不到高度时 `VirtualList` 会静默退化为全量渲染。
            横向内边距由每一行自己给：这样滚动条仍然贴在抽屉边缘（与列表口径一致）。
          */
          <Flex vertical style={{ height: '100%', display: 'flex', flexDirection: 'column' }} data-testid="raw-output-body">
            {diagnosticsBody(source.diagnostics)}
          </Flex>
        ) : (
          // 单份原文：一块文本，不需要虚拟化；内边距自己给（抽屉 `body.padding` 已置 0）
          <Flex vertical style={{ padding: BODY_PADDING }} data-testid="raw-output-body">
            {singleBody(source.result)}
          </Flex>
        )}
      </NestedDrawer>
    </>
  );
}
