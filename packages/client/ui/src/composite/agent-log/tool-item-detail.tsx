'use client';

/**
 * 工具行：摘要行（收起时可见）+ 展开后的完整命令/参数与结果。组内每条一行（嵌套 `Collapse ghost`）。
 *
 * 四条口径：
 *   · **工具名原样透传**：改名会让厂商认不出自己的调用；拿不到时是空串 + `nameMissing`，
 *     这时写「工具名未采集」+ 原因，**不编一个名字**；
 *   · **孤立结果不编工具名**：`orphan-result` 回答的是「这个结果配不上调用」，
 *     编一个名字会让一次配对失败看起来像一次成功的调用；
 *   · 「进行中」与「结果未采集」的分派**收在 `AgentRunStateTag`**（工具行 / 工具组 / 计划清单三处共用；
 *     问答卡片自持一支，不走它。本件只转发四个字段）；
 *   · **结果不截断**：超长时自己截一段会与 `MonoText` 的滚动打架，也会让「原文可查」变成
 *     「原文查不全」；整段交给 `MonoText`（`maxHeight` + 滚动），一字不少。
 */
import { Collapse, Flex, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { EllipsisText } from '../../base/ellipsis-text';
import { JsonText } from '../../base/json-text';
import { MonoText } from '../../base/mono-text';
import { AgentRunStateTag } from './agent-run-state-tag';
import type { ToolGroupEntry, ToolItem, ToolOutput } from './render-blocks';
import { MISSING_REASON_LABELS, TOOL_FAMILY_LABELS, truncationNote } from './types';

export interface ToolItemDetailProps {
  /** `ToolItem` 或 `OrphanToolResult`（判别式 `entry.kind`） */
  entry: ToolGroupEntry;
  open: boolean;
  onOpenChange(next: boolean): void;
  /** 结果未采集时的原因（能力声明给，可为 null） */
  missingReason: string | null;
}

/** 单面板：每条工具行各挂一个 `Collapse` 实例，键写死即可（它只在自己这个实例里唯一） */
const PANEL_KEY = 'tool-item';

/** 正文限高（px）：命令与结果都可能很长，交给 `MonoText` 自己滚 */
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
 * ⚠️ **`at` 不能当身份兜底**（2026-10-07 真机缺陷）：它是**轮次派生**的时刻
 * （行开始时刻 + 轮号），同一轮的每个块逐字相同 ⇒ 对「这是哪一条」零信息量。真机一轮里有两条
 * 配不上调用的结果时，两条都落到 `<at>|orphan`，React 直接报
 * 「Encountered two children with the same key, `…|orphan`」；更早的 `at|name` 写法在同一轮
 * 两次同名、都缺 `callId` 的调用上撞的是同一堵墙。
 * 所以兜底用**源块自己的 id**（数据层给 `messageId#块下标`，同轮唯一）。
 *
 * 孤立结果**也照用它的 `callId`**：配不上调用（本轮没有那次调用）不等于它没有身份，
 * 丢掉它正是上面那次撞键的直接原因。
 */
export function toolEntryKey(entry: ToolGroupEntry): string {
  return entry.callId ?? entry.blockId;
}

/** 参数摘要：`value ?? text` 的第一行；两者都没有（或只有空白）时如实说「参数未采集」 */
function inputSummary(input: ToolItem['input']): { text: string; missing: boolean } {
  const raw = input.value ?? input.text;
  if (raw === null) return { text: '参数未采集', missing: true };
  const first = raw.split('\n')[0]?.trim() ?? '';
  return first === '' ? { text: '参数未采集', missing: true } : { text: first, missing: false };
}

export function ToolItemDetail({ entry, open, onOpenChange, missingReason }: ToolItemDetailProps): ReactNode {
  const label = entry.kind === 'call' ? <CallSummary item={entry} missingReason={missingReason} /> : <OrphanSummary />;
  const children = entry.kind === 'call' ? <CallBody item={entry} missingReason={missingReason} /> : <OrphanBody output={entry.output} />;

  return (
    <Collapse
      ghost
      destroyOnHidden
      activeKey={open ? [PANEL_KEY] : []}
      onChange={(keys) => onOpenChange(keys.length > 0)}
      items={[{ key: PANEL_KEY, label, children }]}
    />
  );
}

/** 摘要行：工具名（或「未采集」+ 原因）+ 参数摘要 + 族 Tag + 状态 */
function CallSummary({ item, missingReason }: { item: ToolItem; missingReason: string | null }): ReactNode {
  const summary = inputSummary(item.input);
  return (
    <Flex align="center" gap={4} wrap>
      {item.name === '' ? (
        <Typography.Text type="warning">
          {`工具名未采集 · ${MISSING_REASON_LABELS[item.nameMissing ?? 'unverified']}`}
        </Typography.Text>
      ) : (
        // 工具名是厂商的标识符，等宽显示便于与日志原文对照
        <Typography.Text code>{item.name}</Typography.Text>
      )}
      {summary.missing ? (
        <Typography.Text type="secondary">{summary.text}</Typography.Text>
      ) : (
        <EllipsisText text={summary.text} />
      )}
      {item.family !== null && <Tag>{TOOL_FAMILY_LABELS[item.family]}</Tag>}
      {/* 失败的结果要看得见：`AgentRunStateTag` 在结果到手时不表态，这一格不能也沉默 */}
      {item.output !== null && item.output.status === 'error' && <Tag color="error">失败</Tag>}
      <AgentRunStateTag
        running={item.running}
        hasResult={item.output !== null}
        missingReason={missingReason}
        since={item.at}
      />
    </Flex>
  );
}

/** 孤立结果的摘要行：**没有工具名可写**，也不替它编一个 */
function OrphanSummary(): ReactNode {
  return <Typography.Text type="secondary">孤立结果（配不上调用）</Typography.Text>;
}

/** 展开后的正文：完整命令/参数（+ 原始字节数）与结果 */
function CallBody({ item, missingReason }: { item: ToolItem; missingReason: string | null }): ReactNode {
  // 正文用 `text`（逐字原文）优先：`value` 是归一后的形状，摘要行才用它
  const full = item.input.text ?? item.input.value;
  const note = item.output === null ? null : truncationNote(item.output.truncation);
  return (
    <Flex vertical gap={4}>
      {full === null ? (
        <Typography.Text type="secondary">参数未采集</Typography.Text>
      ) : (
        <MonoText text={full} maxHeight={DETAIL_MAX_HEIGHT} />
      )}
      {item.input.bytes !== null && (
        <Typography.Text type="secondary">{`参数原文 ${item.input.bytes} 字节`}</Typography.Text>
      )}
      {item.output === null ? (
        <Typography.Text type="secondary">
          {hasText(missingReason) ? `结果未采集 · ${missingReason}` : '结果未采集'}
        </Typography.Text>
      ) : (
        <>
          <MonoText text={item.output.text} maxHeight={DETAIL_MAX_HEIGHT} />
          {hasText(note) && <Typography.Text type="warning">{note}</Typography.Text>}
          <StructuredResult structured={item.output.structured} />
        </>
      )}
    </Flex>
  );
}

/** 孤立结果的正文：结果原文（它一定在——没有结果就不会有这个条目） */
function OrphanBody({ output }: { output: ToolOutput }): ReactNode {
  const note = truncationNote(output.truncation);
  return (
    <Flex vertical gap={4}>
      <MonoText text={output.text} maxHeight={DETAIL_MAX_HEIGHT} />
      {hasText(note) && <Typography.Text type="warning">{note}</Typography.Text>}
      <StructuredResult structured={output.structured} />
    </Flex>
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
 * 呈现口径沿用 §12.6 的既有取舍：**等宽原文，不做族专属渲染**，但如实标注它是结构化结果
 * （让人分得清「这一段是给模型看的文本」与「这一段是工具报出来的事实」）。
 * 自 2026-10-04 起正文走 `JsonText`：这一格本来就是 `JSON.stringify` 出来的对象 / 数组，
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
    return <Typography.Text type="secondary">结构化结果无法序列化（含循环引用）</Typography.Text>;
  }
  if (text === undefined || text === '') return null;
  return (
    <Flex vertical gap={2}>
      <Typography.Text type="secondary">结构化结果</Typography.Text>
      <JsonText text={text} maxHeight={DETAIL_MAX_HEIGHT} />
    </Flex>
  );
}
