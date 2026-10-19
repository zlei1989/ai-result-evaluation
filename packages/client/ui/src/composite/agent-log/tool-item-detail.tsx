'use client';

/**
 * 工具行：摘要行（收起时可见）+ 展开后的完整命令/参数与结果。组内每条一行（`Trace` 的嵌套折叠）。
 *
 * 六条口径：
 *   · **行首只有一块身份牌子：族名（人话，如「跑命令」）优先，没有族映射才给工具名**——
 *     `Bash` 与「跑命令」是同一件事的两种说法，各占一头（行首 / 行尾）就是说两遍；
 *     两者都拿不到时写「工具名未采集」+ 原因，**不编一个名字**（编出来的名字会让排障的人
 *     去找一个不存在的工具）。工具名原样透传到**展开后的正文**（见 `IdentityLabel` /
 *     `OriginalToolName`）；
 *   · **摘要行读数据层算好的那一句**（`tool-call.summary`：描述优先、每族拼法），
 *     老记录（没有这一格）才回落到 `input.description`、再回落参数原文首行——
 *     照原文首行渲染就是一整串 JSON，而原文在展开后的正文里一字不少（见 `inputSummary`）；
 *   · **孤立结果不编工具名**：`orphan-result` 回答的是「这个结果配不上调用」，
 *     编一个名字会让一次配对失败看起来像一次成功的调用；
 *   · **状态只有一处真源：`block.assembly`**。`TraceLine.status` 由它（以及结果的 `error`）
 *     推出来：块还在收（`open`）⇒ `running` + 标题写「正在运行 · …」；块收口 ⇒ 不传 `status`
 *     + 标题回到光秃秃的那句话。**不留第二份「流式中」布尔**（`agent-log-layering.test.ts` (f)）；
 *   · 「进行中」与「结果未采集」的分派**收在 `AgentRunStateTag`**（工具行 / 工具组 / 计划清单三处共用；
 *     问答卡片自持一支，不走它。本件只转发四个字段）。它渲染的是 `div`，故摆在触发器**旁边**
 *     而不是里面——`TraceCollapsibleTrigger` 是 `<button>`，flow 内容不能进按钮；
 *   · **结果不截断**：超长时自己截一段会与滚动区打架，也会让「原文可查」变成「原文查不全」。
 *     普通结果交给 `CodeBlock`（可键盘聚焦滚动、带复制按钮）；失败结果交给 `StackTraceView`
 *     （首行错误 + 帧列表），不再是一整段等宽文本。
 */
import type { ReactNode } from 'react';
import { CircleIcon, CircleXIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } from '../../components/ui/code-block';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../../components/ui/trace';
import { JsonText } from '../../base/json-text';
import { MonoText } from '../../base/mono-text';
import { AgentRunStateTag } from './agent-run-state-tag';
import type { ToolGroupEntry, ToolItem, ToolOutput } from './render-blocks';
import { StackTraceView } from './stack-trace-view';
import { TestResultsView } from './test-results-view';
import { MISSING_REASON_LABELS, TOOL_FAMILY_LABELS, truncationNote } from './types';

export interface ToolItemDetailProps {
  /** `ToolItem` 或 `OrphanToolResult`（判别式 `entry.kind`） */
  entry: ToolGroupEntry;
  open: boolean;
  onOpenChange(next: boolean): void;
  /** 失败输出的帧列表开合（同一份折叠态里的 `|frames` 键，受控） */
  framesOpen: boolean;
  onFramesOpenChange(next: boolean): void;
  /** 结果未采集时的原因（能力声明给，可为 null） */
  missingReason: string | null;
  /** suite / 失败用例的折叠键集合（与工具组同一份受控态；缺省为空集） */
  testOpenKeys?: ReadonlySet<string>;
  onTestOpenChange?: (key: string, open: boolean) => void;
}

/** 缺省的空集合常量：每次渲染新建 `Set` 会让下游 `useMemo` 失效 */
const EMPTY_TEST_KEYS: ReadonlySet<string> = new Set<string>();

/** 参数正文限高（px）：命令可能很长，交给 `MonoText` 自己滚；结果那一段由 `CodeBlock` 限高 */
const DETAIL_MAX_HEIGHT = 320;

/** 非空判定：契约里 `null` = 没采到，空串同样是「没有这句话」 */
function hasText(value: string | null): value is string {
  return value !== null && value !== '';
}

/**
 * 行键：`callId ?? 源块 id`（`blockId`）。
 *
 * 用 `callId` 而不是数组下标：轮次内容会随流式追加变长，下标会漂——
 * 「我展开的那条自己合上了」正是这么来的。导出让 `tool-group-panel` 的 `key` 与受控开合键
 * 用**同一个**公式，两处各写一遍必然漂。
 *
 * ⚠️ **`at` 不能当身份兜底**：它是**轮次派生**的时刻
 * （行开始时刻 + 轮号），同一轮的每个块逐字相同 ⇒ 对「这是哪一条」零信息量。真机一轮里有两条
 * 配不上调用的结果时，两条都落到 `<at>|orphan`，React 直接报
 * 「Encountered two children with the same key, `…|orphan`」；更早的 `at|name` 写法在同一轮
 * 两次同名、都缺 `callId` 的调用上撞的是同一堵墙。
 * 所以兜底用**源块自己的 id**（数据层给 `mergeKey#块下标`，同轮唯一且跨流式帧稳定）。
 *
 * 孤立结果**也照用它的 `callId`**：配不上调用（本轮没有那次调用）不等于它没有身份，
 * 丢掉它正是上面那次撞键的直接原因。
 */
export function toolEntryKey(entry: ToolGroupEntry): string {
  return entry.callId ?? entry.blockId;
}

/**
 * 摘要行的状态：**只从 `block.assembly` 与块自己的结果状态推**。
 *
 * - `assembly === 'open'`（这一块还没收到过快照）⇒ `running`（shimmer + 现在时的标题）；
 * - 块已收口、结果是 `error` ⇒ `error`（红色 + 「失败：」标题）；
 * - 其余**不传 `status`**（Trace 的规则是「跑完就不传」，过去时由标题里那句光秃秃的话承担）。
 */
export function traceStatusOf(entry: ToolGroupEntry): 'running' | 'error' | undefined {
  if (entry.assembly === 'open') return 'running';
  return entry.output?.status === 'error' ? 'error' : undefined;
}

/**
 * 摘要行那一段（收起态唯一可见的一行），**三级回落**：
 *   ① 数据层算好的 `tool-call.summary`——词表真源是 `@aieval/agents` 的 `activity.ts`
 *      （描述优先、每族拼法、截断尺子），界面按分层表不许 import 它，故只能读这一格；
 *   ② `input.description`——**老记录**（`summary` 这一格落盘之前的 `messages.jsonl`）里
 *      当年就是靠它撑起这一行的，留着是为了刷新老 run 时不出现回退；
 *   ③ 参数原文首行——`{command, description}` 那种形状照原文渲染是一整串 JSON（真机 1495px 宽），
 *      而原文在**展开后的正文**里一字不少（见 `CallBody`）。
 *
 * 这一行**不自己拼词表**：`summary` 为空串时按「没有」处理（数据层对「没参数」给的就是空串），
 * 也不在这里补一句「调用工具 <名>」——工具名是这一行左边那个独立元素。
 */
function inputSummary(item: ToolItem): { text: string; missing: boolean } {
  const fromServer = item.summary ?? '';
  if (fromServer.trim() !== '') return { text: fromServer, missing: false };
  if (item.input.description !== null) return { text: item.input.description, missing: false };
  const raw = item.input.value ?? item.input.text;
  if (raw === null) return { text: '参数未采集', missing: true };
  const first = raw.split('\n')[0]?.trim() ?? '';
  return first === '' ? { text: '参数未采集', missing: true } : { text: first, missing: false };
}

export function ToolItemDetail({
  entry,
  open,
  onOpenChange,
  framesOpen,
  onFramesOpenChange,
  missingReason,
  testOpenKeys = EMPTY_TEST_KEYS,
  onTestOpenChange = () => undefined,
}: ToolItemDetailProps): ReactNode {
  const status = traceStatusOf(entry);
  return (
    <Trace data-testid="tool-item-detail">
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex w-full min-w-0 items-center gap-2">
          <TraceCollapsibleTrigger>
            <TraceLine status={status} data-testid="tool-item-line">
              <TraceIcon>{status === 'error' ? <CircleXIcon /> : <CircleIcon />}</TraceIcon>
              {entry.kind === 'call' ? <CallSummary item={entry} status={status} /> : <OrphanSummary />}
            </TraceLine>
          </TraceCollapsibleTrigger>
          {/* 状态标签渲染 `div`：它在触发器**外面**，否则就是 flow 内容进 `<button>` */}
          <AgentRunStateTag
            running={entry.kind === 'call' && entry.running}
            hasResult={entry.output !== null}
            missingReason={missingReason}
            since={entry.at}
          />
        </div>
        <TraceCollapsibleContent>
          {entry.kind === 'call' ? (
            <CallBody
              item={entry}
              missingReason={missingReason}
              framesOpen={framesOpen}
              onFramesOpenChange={onFramesOpenChange}
              testOpenKeys={testOpenKeys}
              onTestOpenChange={onTestOpenChange}
            />
          ) : (
            <OrphanBody output={entry.output} framesOpen={framesOpen} onFramesOpenChange={onFramesOpenChange} />
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/**
 * 摘要行（收起态那一行）：**行首只有一块身份牌子** + 这件事的一句话（`description` 优先）。
 *
 * 标题的时态由 `status` 承担（中文靠副词而不是词形）：
 *   · 进行中（`assembly === 'open'`）⇒「正在运行 · …」；
 *   · 失败（块已收口且结果是 `error`）⇒「失败：…」；
 *   · 跑完 ⇒ 光秃秃的那句话（过去时）。
 * 状态词必须在标题里写出来：只靠颜色与动效，读屏与色觉障碍用户拿不到这个事实（Trace 的 a11y 口径）。
 */
function CallSummary({
  item,
  status,
}: {
  item: ToolItem;
  status: 'running' | 'error' | undefined;
}): ReactNode {
  const summary = inputSummary(item);
  const title = status === 'running' ? `正在运行 · ${summary.text}` : status === 'error' ? `失败：${summary.text}` : summary.text;
  return (
    <>
      <IdentityLabel item={item} />
      <TraceTitle className={summary.missing ? 'text-muted-foreground' : undefined}>{title}</TraceTitle>
    </>
  );
}

/**
 * 行首那**一块**牌子：族名（人话）优先，没有族映射才回落工具名本身。
 *
 * 两者缺一不可的兜底：都拿不到时写「工具名未采集」+ 原因——**不编一个名字**
 * （编出来的名字会让排障的人去找一个不存在的工具）。
 */
function IdentityLabel({ item }: { item: ToolItem }): ReactNode {
  if (item.family !== null) {
    return (
      <Badge variant="outline" className="shrink-0">
        {TOOL_FAMILY_LABELS[item.family]}
      </Badge>
    );
  }
  if (item.name !== '') {
    // 工具名是厂商的标识符，等宽显示便于与日志原文对照
    return (
      <code className="shrink-0 font-mono text-sub text-muted-foreground" data-tool-name>
        {item.name}
      </code>
    );
  }
  return (
    <span className="shrink-0 text-sub text-warning">
      {`工具名未采集 · ${MISSING_REASON_LABELS[item.nameMissing ?? 'unverified']}`}
    </span>
  );
}

/** 孤立结果的摘要行：**没有工具名可写**，也不替它编一个 */
function OrphanSummary(): ReactNode {
  return <TraceTitle className="text-muted-foreground">孤立结果（配不上调用）</TraceTitle>;
}

/** 展开后的正文：完整命令/参数（+ 原始字节数）与结果 */
function CallBody({
  item,
  missingReason,
  framesOpen,
  onFramesOpenChange,
  testOpenKeys,
  onTestOpenChange,
}: {
  item: ToolItem;
  missingReason: string | null;
  framesOpen: boolean;
  onFramesOpenChange(next: boolean): void;
  testOpenKeys: ReadonlySet<string>;
  onTestOpenChange(key: string, open: boolean): void;
}): ReactNode {
  // 正文用 `text`（逐字原文）优先：`value` 是归一后的形状，摘要行才用它
  const full = item.input.text ?? item.input.value;
  const note = item.output === null ? null : truncationNote(item.output.truncation);
  return (
    <div className="flex flex-col gap-1 text-foreground">
      {/* 摘要行把行首让给了族名（人话）⇒ 厂商的工具名原样落到这里；摘要行已经写着工具名时不再重复 */}
      {item.family !== null && <OriginalToolName item={item} />}
      {full === null ? (
        <span className="text-sub text-muted-foreground">参数未采集</span>
      ) : (
        <MonoText text={full} maxHeight={DETAIL_MAX_HEIGHT} />
      )}
      {item.input.bytes !== null && (
        <span className="text-sub text-muted-foreground">{`参数原文 ${item.input.bytes} 字节`}</span>
      )}
      {/*
        参数解析失败：厂商那句话放在参数正文下面。此刻 `input` 是个空对象，与「模型真传了空对象」
        同形——只有这一格能说出真相。
      */}
      {hasText(item.inputError) && (
        <Alert variant="destructive" data-testid="tool-input-error">
          <AlertTitle>参数不是合法 JSON</AlertTitle>
          <AlertDescription>{item.inputError}</AlertDescription>
        </Alert>
      )}
      {item.output === null ? (
        <span className="text-sub text-muted-foreground">
          {hasText(missingReason) ? `结果未采集 · ${missingReason}` : '结果未采集'}
        </span>
      ) : (
        <>
          {/*
            测试输出是**结构优先**的：解析成功画三层，解析失败画「标记 + 原文」。
            两种都不再走下面的 `ToolOutputView`——同一次结果说两遍会让失败标记与一大段
            看似正常的原文并排出现，读者只会信那个更长的。
          */}
          {item.testResult == null ? (
            <ToolOutputView output={item.output} framesOpen={framesOpen} onFramesOpenChange={onFramesOpenChange} />
          ) : (
            <TestResultsView
              result={item.testResult}
              raw={item.output.text}
              entryKey={toolEntryKey(item)}
              openSuites={testOpenKeys}
              onSuiteOpenChange={onTestOpenChange}
            />
          )}
          {hasText(note) && <span className="text-sub text-warning">{note}</span>}
          <StructuredResult structured={item.output.structured} />
        </>
      )}
    </div>
  );
}

/**
 * 结果正文：**失败走 Stack Trace，其余走 CodeBlock**。
 *
 * 失败输出不是「一段更长的文本」：它有自己的结构（首行错误 + 帧），塞进同一个滚动框等于
 * 让读者在一屏 stderr 里自己找第一行、自己判断哪些帧与自己有关。
 */
function ToolOutputView({
  output,
  framesOpen,
  onFramesOpenChange,
}: {
  output: ToolOutput;
  framesOpen: boolean;
  onFramesOpenChange(next: boolean): void;
}): ReactNode {
  if (output.status === 'error') {
    return <StackTraceView text={output.text} open={framesOpen} onOpenChange={onFramesOpenChange} />;
  }
  return (
    <CodeBlock size="sm" data-testid="tool-output">
      <CodeBlockActions>
        <CodeBlockCopyButton value={output.text} />
      </CodeBlockActions>
      {/* `max-h-80` = 320px：与参数正文同一档限高，长输出在自己的框里滚 */}
      <CodeBlockContent wrap className="max-h-80">
        {output.text}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/**
 * 「工具原名」那一行：摘要行把行首让给族名之后，厂商的标识符落在这里。
 *
 * 为什么不干脆丢掉：工具名是**排障时唯一能与厂商日志对上号的东西**（原始输出里那些 `tool_use`
 * 事件认的就是它的名字）。没采到就如实说「工具原名未采集」+ 原因——空着会被读成「这家没有工具名」。
 */
function OriginalToolName({ item }: { item: ToolItem }): ReactNode {
  if (item.name === '') {
    return (
      <span className="text-sub text-warning">
        {`工具原名未采集 · ${MISSING_REASON_LABELS[item.nameMissing ?? 'unverified']}`}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <span className="text-sub text-muted-foreground">工具原名</span>
      <code className="font-mono text-sub" data-tool-name>
        {item.name}
      </code>
    </div>
  );
}

/** 孤立结果的正文：结果原文（它一定在——没有结果就不会有这个条目） */
function OrphanBody({
  output,
  framesOpen,
  onFramesOpenChange,
}: {
  output: ToolOutput;
  framesOpen: boolean;
  onFramesOpenChange(next: boolean): void;
}): ReactNode {
  const note = truncationNote(output.truncation);
  return (
    <div className="flex flex-col gap-1 text-foreground">
      <ToolOutputView output={output} framesOpen={framesOpen} onFramesOpenChange={onFramesOpenChange} />
      {hasText(note) && <span className="text-sub text-warning">{note}</span>}
      <StructuredResult structured={output.structured} />
    </div>
  );
}

/**
 * 厂商已解析的结构化结果（`tool-result.structured`）。
 *
 * 为什么必须给它一个落点：规范明写「**有 `meta` 就不要退回去解析文本**」，而 dsh 的
 * `read` / `write` / `edit` 把行数、改动对象这些**已解析过的事实**只放在这一格里，
 * 正文那一段只是给人看的摘要（`<path>…</path>` 那种）。丢掉它，界面上就只剩摘要可读——
 * 那是「有数据但看不见」的形状。
 *
 * 呈现口径沿用的既有取舍：**等宽原文，不做族专属渲染**，但如实标注它是结构化结果
 * （让人分得清「这一段是给模型看的文本」与「这一段是工具报出来的事实」）。
 * 正文走 `JsonText`：这一格本来就是 `JSON.stringify` 出来的对象 / 数组，
 * 于是它顺理成章地拿到缩进与高亮（`null` / 序列化不动那两条分支不变）。
 * `null` / `undefined` 时**整段不渲染**（不画空框：那会被读成「结构化结果坏了」）。
 */
function StructuredResult({ structured }: { structured: unknown }): ReactNode {
  if (structured === null || structured === undefined) return null;
  let text: string | undefined;
  try {
    text = JSON.stringify(structured, null, 2);
  } catch {
    // 循环引用等序列化不动的值：**如实说序列化不了**，不假装没有这一格
    return <span className="text-sub text-muted-foreground">结构化结果无法序列化（含循环引用）</span>;
  }
  if (text === undefined || text === '') return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sub text-muted-foreground">结构化结果</span>
      <JsonText text={text} maxHeight={DETAIL_MAX_HEIGHT} />
    </div>
  );
}
