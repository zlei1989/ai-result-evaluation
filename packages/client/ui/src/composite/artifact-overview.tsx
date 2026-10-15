'use client';

/**
 * 「产物总览」二级抽屉：把每个候选在**工作区根**写下的 `RESULT.*` 按名次自上而下逐份摆出来，
 * 一份产物一张卡（`Card size="small"`），标题是「排名 · 智能体 · 模型 · 思考强度」，
 * 正文是这份产物**渲染后的效果**。抽屉与开合由页面给（受控），本件只画内容。
 *
 * 七条口径：
 *   1. **顺序与名次只有一份判据**（`orderForDisplay` + `rankOf`，来自 `run-detail-panel`）：
 *      本件不自己排、不自己算名次——两处各写一份的形状是「卡片挂第 1 名、总览里排第 2」，
 *      而那种错在界面上看起来像数据坏了，不是判据分叉；
 *   2. **没有产物的候选也占一张卡**：正文是 `EmptyState`，标题同样四段（首段是行状态）。
 *      「这一行没有产出」是一句要显示出来的事实——跳过它等于把「没产出」说成「这一行不存在」；
 *      判据与排名表第一格同源：未出分的候选在名次那个位置写 `ROW_STATUS_LABELS`；
 *   3. **取数不在这里**：`ui` 包不调接口。每份产物的正文由调用方传 `renderBody({ rowId, name })` 进来，
 *      它为每一份挂一份自己的订阅——hook 不能按参数循环调用，故「每份一个组件实例」是唯一站得住的形状
 *      （与 `DiffView` 的 `renderFileBody` 同一条口径）；
 *   4. **渲染分档 = 产物后缀**（`file.kind`）：`md` 走 `XMarkdownText`（本仓 markdown 外壳：
 *      原始 HTML 一律转义、标题降级、外链新窗口），`html` / `svg` 走**沙箱 iframe**。
 *      HTML 与 SVG 是**独立文档**、和我们这套界面没有共同语言：内联渲染会把它自己的 CSS 铺到抽屉上，
 *      脚本还会拿到宿主上下文。`sandbox=""` 是最严一档——脚本不执行、表单 / 弹窗 / 顶层跳转全挡；
 *      代价是跨源、读不到 `contentDocument`，故**不量内容高度**（固定高度 + 内部滚动）。
 *      SVG 另加一层最小 HTML 壳：直接 srcdoc 原始 SVG 在 HTML 解析下会落在 300×150 的默认尺寸上，
 *      看不出「那个页面的效果」；
 *   5. **三态都有可读文案**：加载中 `Skeleton`、读失败 `Alert`（中文原因由调用方折好）、
 *      截断一行 `warning`——截断是**可见的降级**，不能让人以为「它只写了这么多」；
 *   6. **`index === undefined` 是「还没读到」，不是「没有产物」**：正文给空态并说明怎么重扫，
 *      不画一排空卡（那会让人以为所有候选都没产出）；
 *   7. 卡片正文的内边距归 `Card` 自己，抽屉正文的内边距归这里（`NestedDrawer` 的 `body.padding` 已置 0）。
 */
import { Alert, Card, Flex, Skeleton, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  AGENT_LABELS,
  ARTIFACT_FILE_HINT,
  ARTIFACT_TEXT_MAX_CHARS,
  ROW_STATUS_LABELS,
  type EvalRow,
  type EvalRun,
  type RowArtifactFile,
  type RunArtifactIndex,
} from '@aieval/contracts';
import { EmptyState } from '../base/empty-state';
import { NestedDrawer } from '../base/nested-drawer';
import { XMarkdownText } from '../base/x-markdown';
import { orderForDisplay, rankOf } from './run-detail-panel';

/**
 * 入口按钮与抽屉标题**共用一份文案**（同 `rawOutputLabel` 的口径）：两处各写一份字面量时，
 * 改一处就会出现「按钮叫这个、点开的抽屉叫那个」。
 */
export const ARTIFACT_OVERVIEW_LABEL = '产物总览';

/**
 * `html` / `svg` 那一档的高度（px）：产物是独立文档，而我们**量不到**它的内容高度
 * （`sandbox=""` 是跨源的，`contentDocument` 读不到），故给一屏固定高度、内容自己滚。
 * 取值按「一页交付物大致一屏」定；比抽屉还高的内容照样能看，只是要在框里滚。
 */
export const ARTIFACT_FRAME_HEIGHT = 420;

/**
 * SVG 那一档的最小 HTML 壳：把 SVG 铺满框宽并保持纵横比，**高的一侧也不许溢出框**。
 * 不给这一层时，srcdoc 里的 `<svg>` 是 HTML 文档里的一个普通 SVG 元素——没有 `width` / `height`
 * 就按默认 300×150 渲染，「那个文件的样子」看不出来。
 *
 * `html,body{height:100%}` 不是装饰：`max-height: 100%` 的百分比要对着**确定的**包含块高度才算数，
 * 少了它这条约束被当成 `none` ⇒ 一张正方形 SVG 会按框宽撑成与框同宽、`ARTIFACT_FRAME_HEIGHT` 高的框里
 * 只露出上半截。宽的一侧由 `width:100%` 铺满（`height:auto` 按比例推），高的一侧由
 * `max-height` 收回来——CSS 对「替换元素 + 内在比例」的约束冲突会按比例同时缩宽高，故不会被压扁。
 * 壳里的 CSS 只碰 `html` / `body` / `svg` 三个选择器，且**必须在用户源码之前**
 * （用户自己的 `style` 属性优先级更高，不会被这里盖掉）。
 */
const SVG_FRAME_SHELL = '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}svg{display:block;width:100%;height:auto;max-height:100%}</style>';

/**
 * 卡片标题的四段：名次 · 智能体 · 模型 · 思考强度。
 *
 * 未出分的候选在名次那一格写**行状态**（与排名表第一格同源）：它们不参与排名，
 * 写成「最后一名」或留空都是在替使用者下结论。思考强度缺省写「未指定」（不是空串）。
 */
export function artifactCardTitle(row: EvalRow, rank: number | undefined): string {
  const place = rank === undefined ? ROW_STATUS_LABELS[row.status] : `第 ${rank} 名`;
  return [place, AGENT_LABELS[row.agentKind], row.modelId, row.effort ?? '未指定'].join(' · ');
}

export interface ArtifactOverviewProps {
  /** 这一轮的快照：名次、身份、候选数都从它取 */
  run: EvalRun;
  /** 这一轮的产物清单；`undefined` = 还没读到（不是「没有产物」） */
  index: RunArtifactIndex | undefined;
  /** 二级抽屉的开合（受控：入口按钮在主抽屉的 `footer` 上，状态只能住在页面那一层） */
  open: boolean;
  onOpenChange(next: boolean): void;
  /** 一份产物的正文由调用方渲染（`ui` 包不调接口，见口径 3） */
  renderBody(input: { rowId: string; name: string }): ReactNode;
}

export function ArtifactOverview({ run, index, open, onOpenChange, renderBody }: ArtifactOverviewProps): ReactNode {
  // 清单按 rowId 建一次索引：下面按名次顺序逐行取，每行再 find 一遍是候选数的平方
  const filesByRow = new Map((index?.rows ?? []).map((row) => [row.rowId, row.files]));

  return (
    <NestedDrawer open={open} onClose={() => onOpenChange(false)} title={ARTIFACT_OVERVIEW_LABEL}>
      <Flex vertical gap={12} style={{ padding: 16 }}>
        {index === undefined ? (
          <EmptyState title="还没读到产物清单" description="关掉排名抽屉再打开，会重新扫一遍候选工作区" />
        ) : (
          orderForDisplay(run.rows).map((row) => {
            const rank = rankOf(run.rows, row);
            const files = filesByRow.get(row.id) ?? [];
            if (files.length === 0) {
              // 没有产物也是一个结论：卡片照出现、正文是空态（口径 2）
              return (
                <Card
                  key={`${row.id}|empty`}
                  size="small"
                  data-testid="artifact-card"
                  data-row-id={row.id}
                  data-artifact-name=""
                  title={artifactCardTitle(row, rank)}
                >
                  <EmptyState
                    title="这一行没有产物"
                    description={`执行目录里没有 ${ARTIFACT_FILE_HINT}`}
                  />
                </Card>
              );
            }
            return files.map((file) => (
              <Card
                key={`${row.id}|${file.name}`}
                size="small"
                data-testid="artifact-card"
                data-row-id={row.id}
                data-artifact-name={file.name}
                title={artifactCardTitle(row, rank)}
                // 文件名单独放卡头右侧：一个候选可能有多份产物，四段标题里不掺文件名
                extra={<Typography.Text type="secondary" code>{file.name}</Typography.Text>}
              >
                {renderBody({ rowId: row.id, name: file.name })}
              </Card>
            ));
          })
        )}
      </Flex>
    </NestedDrawer>
  );
}

export interface ArtifactFileContentProps {
  file: RowArtifactFile | undefined;
  /** 读失败的原因（调用方已折成中文） */
  error: unknown;
  isLoading: boolean;
}

/**
 * 一份产物的**受控纯展示件**：加载中 / 读失败 / 截断提示 / 三种渲染。
 *
 * 导出它是因为调用方拿到 SWR 结果后需要一个现成的渲染件——否则每个调用方都要再写一份四态判断，
 * 而四份判断必然漂移（与 `DiffFileContent` 同一处置）。
 */
export function ArtifactFileContent({ file, error, isLoading }: ArtifactFileContentProps): ReactNode {
  // testid 挂在 `Flex` 这一层而不是 `Skeleton` 上：antd 6 的 Skeleton 不转发未知属性
  //（它只认自己那张 props 表），`data-testid` 写在它身上会被**静默丢掉**
  if (isLoading) {
    return (
      <Flex vertical data-testid="artifact-file-skeleton">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Flex>
    );
  }
  if (error !== null && error !== undefined) {
    return <Alert type="error" showIcon title="这一份产物读取失败" description={String(error)} />;
  }
  if (file === undefined) return null;

  return (
    <Flex vertical gap={8}>
      {file.truncated && (
        <Typography.Text type="warning" data-testid="artifact-truncated">
          这一份超过 {ARTIFACT_TEXT_MAX_CHARS} 字符，只显示前一部分
        </Typography.Text>
      )}
      {renderArtifactBody(file)}
    </Flex>
  );
}

/**
 * 按 `kind` 分档渲染（口径 4）。分档就是产物后缀：契约里 `ArtifactKind` 与白名单同源，
 * 故这里不需要第二份「哪个后缀算哪种内容」的映射。
 */
function renderArtifactBody(file: RowArtifactFile): ReactNode {
  switch (file.kind) {
    case 'md':
      return <XMarkdownText text={file.text} open={false} />;
    case 'html':
      return <SandboxedFrame title={`产物 ${file.name}`} content={file.text} />;
    case 'svg':
      return <SandboxedFrame title={`产物 ${file.name}`} content={`${SVG_FRAME_SHELL}${file.text}`} />;
  }
}

/**
 * 承载独立文档的那一档：`sandbox=""` 的 iframe（口径 4）。
 *
 * 三个值都是口径本身，改任何一个都要回到文件头看代价：
 *   · `sandbox=""`（空串 = 最严）：去掉它或加 `allow-scripts` / `allow-same-origin`，
 *     产物里的脚本就能在宿主页面里跑、能读抽屉里的东西；
 *   · 白底：产物是**独立文档**，暗色主题下它自己的黑字必须落在白底上才读得出来
 *     （产物自己给了 `body` 底色就会盖掉这一层）；
 *   · 固定高度：跨源读不到内容高度，见 `ARTIFACT_FRAME_HEIGHT`。
 */
function SandboxedFrame({ title, content }: { title: string; content: string }): ReactNode {
  return (
    <iframe
      title={title}
      data-testid="artifact-frame"
      sandbox=""
      srcDoc={content}
      style={{ width: '100%', height: ARTIFACT_FRAME_HEIGHT, border: 0, background: '#fff', display: 'block' }}
    />
  );
}
