'use client';

/**
 * 环境抽屉（L0 渲染件，但由 `agent-log` 内部渲染）：智能体跑在什么之上。
 *
 * 五条口径：
 *   1. **受控**：吃 `open` / `onOpenChange`，自己不持开合态——这样它能被单独挂到任何地方
 *      （例如设置页的「本机环境」区块），换交互形态时只换「谁渲染 `open`」；
 *   2. **不硬编码任何组名**：分组名、组顺序、每组的条目全部由数据层给
 *      （`EnvGroup.title` / 数组顺序），新增一层不必改本文件；
 *   3. **缺失不隐藏**：`present: false` 的条目渲染成「标签 · 原因」，四句原因互不相同——
 *      藏起来就把「这家结构上就没有」与「我们没接」说成了同一件事；
 *   4. **不内套第二层滚动区**：长文本交给二级抽屉自己的正文容器滚，否则这一个抽屉里会出现两条滚动条；
 *   5. **壳是 `NestedDrawer`**（Base UI `Sheet`）：宽度、窄屏兜底与「让位归主抽屉」都收在
 *      `base/nested-drawer.tsx` / `base/drawer-geometry.ts`，本件只渲染正文。
 *      二级层打开时主抽屉由 Base UI 的 `--nested-dialogs` 计数驱动左移，本件不声明任何位移。
 *
 * 「能力声明」一节回答的是**这一次我们能拿到什么**（五格各自带等级与原因），
 * 与被下发了什么是同一抽屉里并列的两件事，且四句原因与下面 `EnvItemRow` 的 `missing` 共用
 * `MISSING_REASON_LABELS` 一张表——放两处才不会出现「同一个原因两种说法」。
 * 它是**可选**的：不给就整段不出现（宁可不显示，也不编一份「都支持」出来）。
 */
import { ChevronRightIcon, CopyIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { Skeleton } from '../../components/ui/skeleton';
import { ROW_MCP_VERDICT_LABELS, type RowMcpVerdict } from '@aieval/contracts';
import type { ReactNode } from 'react';
import type { AgentEnvironment, EnvGroup, EnvItem, Loadable, MessageCapabilityMap } from './types';
import { MISSING_REASON_LABELS } from './types';
import { CapabilityNotes } from './capability-notes';
import { MonoText } from '../../base/mono-text';
import { formatBytes } from '../../base/format';
import { NestedDrawer } from '../../base/nested-drawer';

export interface AgentEnvironmentDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  environment: Loadable<AgentEnvironment> | undefined;
  onRetry?(): void;
  /**
   * 能力声明（`LogNode.capability`）。**可选**：不给就整段不出现——
   * 「没采到声明」与「声明说都支持」在界面上必须长得不一样。
   */
  capability?: MessageCapabilityMap;
  /** 能力成立的**前提**（路由 / 模型 / 开关）；空数组 = 无条件成立 */
  capabilityNotes?: readonly string[];
}

/** 组来源的四个中文标签：它回答「这条要求是谁下发的」，也正是分开展示的全部理由 */
const SOURCE_LABELS: Record<EnvGroup['source'], string> = {
  user: '用户层',
  vendor: '厂商系统层',
  project: '运行配置',
  observed: '实测统计',
};

/**
 * 四档 MCP 结论徽标的语义色（`data-tone` 是给用例的稳定判据）。
 *
 * 为什么 `unverified` 与 `skipped` 刻意**都**不用红色：红 = 失败，而这两档都不是失败
 * （前者是「没有证据」，后者是「我们主动跳过」）。`unavailable` 才是「有证据说它没起来」，故只有它红。
 */
const MCP_VERDICT_TAG_CLASSES: Record<RowMcpVerdict, string> = {
  connected: 'border-success/40 text-success',
  unavailable: 'border-destructive/40 text-destructive',
  unverified: 'border-border text-muted-foreground',
  skipped: 'border-warning/40 text-warning',
};

/**
 * 复制到剪贴板。**失败静默**：这是只读的排查视图，弹一个「复制失败」的提示比没复制上更打扰；
 * 环境里没有剪贴板 API（非安全上下文、jsdom）时同样静默跳过。
 */
function copyToClipboard(text: string): void {
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) return;
  void clipboard.writeText(text).catch(() => undefined);
}

/** `Loadable` 的 `error` 是 `unknown`：能给一句人话就给，给不出就如实说「未知错误」 */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '未知错误';
}

/** 摘要：智能体 / 模型 / 思考强度 / 供应商 / 接口地址 / 工作区 / 基线提交 */
function summaryItems(summary: AgentEnvironment['summary']): { key: string; label: string; children: ReactNode }[] {
  return [
    /**
     * 「智能体」那一格画的是数据层给的**显示名**（`summary.agentLabel`），不是 kind。
     *
     * 为什么不由本件查 `AGENT_LABELS`：那一查就是 L0 持有「厂商 → 文案」的表
     * ——`agent-log-layering.test.ts` 的 (e) 条**当场红**，而那条纪律的理由是实的：
     * 文案与厂商名的对应关系属于数据层（同 `facts.domain` / `effortPlaceholder`），
     * 组件只摆版 ⇒ 换一家、改一个显示名都不必动渲染件。
     */
    { key: 'agentLabel', label: '智能体', children: summary.agentLabel },
    { key: 'modelId', label: '模型', children: summary.modelId },
    // `effort === null` ⇒「未指定」：不显示空白（空白会被读成「这一格没有这个概念」）；
    // 档位照上游词汇原样写（关闭档也不加工，与行卡片上那个 `off` 同一份）
    { key: 'effort', label: '思考强度', children: summary.effort === null ? '未指定' : summary.effort },
    { key: 'providerName', label: '供应商', children: summary.providerName },
    { key: 'baseUrl', label: '接口地址', children: summary.baseUrl },
    { key: 'workspaceBase', label: '工作区', children: summary.workspaceBase },
    { key: 'baselineCommit', label: '基线提交', children: summary.baselineCommit },
  ];
}

/** 一条环境信息：标签 + 正文（逐字原文）+ 截断提示 + 复制按钮 */
function EnvItemRow({ item }: { item: EnvItem }): ReactNode {
  // 「这一格没有」必须带原因，且**不隐藏**（四句原因见 MISSING_REASON_LABELS）
  if (!item.present) {
    return (
      <span className="text-muted-foreground">
        {item.label} · {MISSING_REASON_LABELS[item.missing]}
      </span>
    );
  }

  const copyPath = item.copyPath;
  const verdictLines = item.verdictLines;

  return (
    <div className="flex flex-col gap-hair">
      <span className="font-medium">{item.label}</span>
      {/* 不传 `maxHeight`：长文本交给抽屉 body 滚，这里不再开第二个滚动区 */}
      {verdictLines === undefined ? (
        <MonoText text={item.text} />
      ) : (
        // 「一台一个结论」的观测格：结论画成 Tag、其余照常等宽原文。
        // `text` 那一格仍是完整原文（复制按钮读它），这里只换了画法。
        <div className="flex flex-col gap-hair" data-testid="verdict-lines">
          {verdictLines.map((line) => (
            // 行内文字逐台唯一（服务名在设置页里是唯一键），当 React key 不会串行
            <div key={line.text} className="flex flex-wrap items-center gap-hair">
              {line.text !== '' && <MonoText text={line.text} />}
              {line.verdict !== null && (
                <Badge
                  variant="outline"
                  className={MCP_VERDICT_TAG_CLASSES[line.verdict]}
                  data-tone={line.verdict}
                >
                  {ROW_MCP_VERDICT_LABELS[line.verdict]}
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-tight">
        {item.truncated !== null && (
          <>
            <span className="text-muted-foreground">已截断（原文 {formatBytes(item.truncated.bytes)}）</span>
            <span className="text-muted-foreground">{item.truncated.reason}</span>
            {/* 复制的是**我们手上这份原文**：被上限截掉的部分 UI 并没有，不假装能复制到 */}
            <Button size="xs" variant="outline" onClick={() => copyToClipboard(item.text)}>
              <CopyIcon aria-hidden />
              复制全部
            </Button>
          </>
        )}
        {/* 约定路径（调试时最常用的是把完整提示词粘到别处）。先取进常量：闭包里属性收窄会失效 */}
        {copyPath !== undefined && (
          <Button size="xs" variant="outline" onClick={() => copyToClipboard(copyPath)}>
            <CopyIcon aria-hidden />
            复制
          </Button>
        )}
      </div>
    </div>
  );
}

export function AgentEnvironmentDrawer({
  open,
  onOpenChange,
  environment,
  onRetry,
  capability,
  capabilityNotes,
}: AgentEnvironmentDrawerProps): ReactNode {
  /**
   * 能力声明那一节是否出现：**两个条件缺一不可**——有声明，且至少有一个维度。
   * 空对象（`{}`）与 `undefined` 同一处置：画一个没有行的标题只会让人以为「五格都是空的」。
   */
  const showCapability = capability !== undefined && Object.keys(capability).length > 0;

  return (
    <NestedDrawer open={open} onClose={() => onOpenChange(false)} title="环境信息">
      <div className="flex flex-col gap-roomy p-roomy" data-testid="agent-environment-drawer">
        {/**
          * 能力声明**在三态之外**：它的来源是**节点**（`LogNode.capability`，随模型按值给），
          * 与环境信息那次取数的成败无关。放进 ready 那一支的话，「环境信息没提供」会把一份
          * 明明拿到了的声明一起藏掉——而它恰恰是解释「为什么这里没内容」的那句话。
          */}
        {showCapability && (
          <div className="flex flex-col gap-tight">
            <span className="font-medium">能力声明</span>
            {/* 维度名与顺序由数据层给：本件按 `capability` 的插入顺序渲染，未知维度原样显示 */}
            <CapabilityNotes capability={capability} notes={capabilityNotes ?? []} />
          </div>
        )}
        {environment === undefined ? (
          // 「没提供」与「读取中」是两件事：一直转圈会把「这次没采到」说成「还在取」
          <span className="text-muted-foreground">未提供</span>
        ) : environment.status === 'loading' ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-4 w-full" />
            ))}
          </div>
        ) : environment.status === 'error' ? (
          <div className="flex flex-col gap-snug">
            <Alert variant="destructive">
              <AlertTitle>环境信息读取失败</AlertTitle>
              <AlertDescription>{errorText(environment.error)}</AlertDescription>
            </Alert>
            {/* 不给重试回调就不渲染按钮：一个点了没反应的按钮比没有按钮更糟 */}
            {onRetry !== undefined && (
              <Button size="xs" variant="outline" className="self-start" onClick={onRetry}>
                重试
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* 摘要：标签 / 值逐行（`dl` 是这件事的语义元素，不是两张各排一列的表格） */}
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-snug gap-y-tight text-sm">
              {summaryItems(environment.data.summary).map((item) => (
                <div key={item.key} className="contents">
                  <dt className="text-muted-foreground">{item.label}</dt>
                  <dd className="min-w-0">{item.children}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-snug">
              {environment.data.groups.map((group) => (
                // 组名与分组顺序都由数据层给；默认全开，因为打开这个抽屉的人本来就是来看事实的
                <Collapsible key={group.id} defaultOpen className="rounded-lg border border-border px-snug py-tight">
                  <CollapsibleTrigger
                    className="flex w-full items-center gap-tight text-left text-sm"
                    data-group-header={group.id}
                  >
                    <ChevronRightIcon aria-hidden className="size-3.5 transition-transform data-[panel-open]:rotate-90" />
                    <span>{group.title}</span>
                    <Badge variant="outline">{SOURCE_LABELS[group.source]}</Badge>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="flex flex-col gap-snug pt-snug">
                      {group.items.map((item) => (
                        <EnvItemRow key={item.id} item={item} />
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </>
        )}
      </div>
    </NestedDrawer>
  );
}
