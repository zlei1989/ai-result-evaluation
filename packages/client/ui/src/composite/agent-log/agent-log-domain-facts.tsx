'use client';

/**
 * 领域事实那一行（L1）：**智能体 · 模型 · 思考强度 · 改动 · 评分**逐格摆版，一个取数也不做。
 *
 * 四条口径： * 1. **它自占一行**：这些格若并排在事实条那一候选的末尾、靠 `wrap` 自然折行，
 * 「改动 / 评分」会被甩到第二行，与「智能体 / 模型 / 思考强度」拆散，
 * 而这两组是连起来读的一句话（谁在跑 → 改了多少 → 得了多少分）；
 *   2. **不解析**：`label` / `value` / `hint` 一字不改地照画，顺序就是数据层给的顺序——UI 不知道
 *      「改动」「评分」是什么。要上色 / 做 Tag 的地方由数据层给成 `segments` / `hintSegments`
 *      （每段声明自己是什么），**界面绝不自己去拆 `+111` 这种文本**（见 `types.ts` 的
 *      `DomainFactSegment`）；
 *   3. **空数组时整行不出现**：通用消费方没有领域事实，不留一段空 gap；
 *   4. 与 `agent-log-facts-bar.tsx` 是**两个件、两行**，不是一个件的可选一格：那一行讲
 *      「这个候选跑了什么」（状态 / 轮次 / 用量 / 耗时），这个候选讲「这个候选是谁在跑、改了什么、
 *      得了多少分」。
 */
import { Flex, Tag, theme, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { DomainFact, DomainFactSegment } from './types';

/** 领域事实的色档 → `Tag` 的预设色（**值整段一枚 Tag** 时用，如评分那一格的绿 Tag） */
const DOMAIN_TONE_COLOR: Record<NonNullable<DomainFact['tone']>, string> = {
  default: 'default',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

/**
 * 一段领域事实。三种画法**全按数据层的声明**（界面不认「哪个词是加号」）：
 *   · `tag` ⇒ 一枚 `Tag`，色档取 `tagTone`（不给 = 蓝）；
 *   · `insertion` / `deletion` ⇒ 一枚绿 / 红 Tag（git 惯例的 `+N` / `−N`）；
 *   · 其余 ⇒ 一段次要色文字。
 *
 * **间距一律由外层 `Flex` 的 `gap` 给**（`marginXXS` = 4px）：段内文字与 Tag 都不自带用于排版的空格 /
 * 外边距——`Tag` 默认的 `marginInlineEnd: 8px` 归零（8 + 4 会比格与格之间还松），数据里也不写
 * 「 个文件 」这类首尾空格（排版字符漏了 trim，读屏与复制拿到的是另一句话）。
 */
function FactSegment({ segment }: { segment: DomainFactSegment }): ReactNode {
  const chip = (color: string): ReactNode => (
    <Tag color={color} style={{ marginInlineEnd: 0 }}>
      {segment.text}
    </Tag>
  );
  if (segment.tag === true) return chip(segment.tagTone ?? 'blue');
  if (segment.tone === 'insertion') return chip('success');
  if (segment.tone === 'deletion') return chip('error');
  return <Typography.Text type="secondary">{segment.text}</Typography.Text>;
}

export interface AgentLogDomainFactsProps {
  /** 领域事实（顺序即渲染顺序）：本仓给「智能体 · 模型 · 思考强度 · 改动 · 评分」 */
  domain: readonly DomainFact[];
}

export function AgentLogDomainFacts({ domain }: AgentLogDomainFactsProps): ReactNode {
  const { token } = theme.useToken();
  // 空数组整行不出现（口径 3）：留一行空的 flex 会多出一段 gap
  if (domain.length === 0) return null;

  return (
    <Flex align="center" gap={token.marginSM} wrap data-testid="agent-log-domain-facts">
      {domain.map((fact) => (
        <Flex key={fact.id} align="center" gap={token.marginXXS}>
          <Typography.Text type="secondary">{fact.label}</Typography.Text>
          {/* 值两种画法：数据层给了 `segments` 就按段画（**段间距由 Flex gap 给**，文本里不带空格），
              否则整段一枚色档 Tag（评分那一格就是 `57/57` 那枚绿 Tag） */}
          {fact.segments === undefined ? (
            fact.tone === undefined ? (
              <Typography.Text>{fact.value}</Typography.Text>
            ) : (
              <Tag color={DOMAIN_TONE_COLOR[fact.tone]}>{fact.value}</Tag>
            )
          ) : (
            <Flex align="center" gap={token.marginXXS} wrap data-testid="agent-log-domain-fact-segments">
              {fact.segments.map((segment, index) => (
                <FactSegment key={index} segment={segment} />
              ))}
            </Flex>
          )}
          {/* 提示同样可以分段（各段自带色档），没分段就是一句次要色文本 */}
          {fact.hintSegments === undefined
            ? fact.hint !== undefined && <Typography.Text type="secondary">{fact.hint}</Typography.Text>
            : (
              <Flex align="center" gap={token.marginXXS} wrap>
                {fact.hintSegments.map((segment, index) => (
                  <FactSegment key={index} segment={segment} />
                ))}
              </Flex>
            )}
        </Flex>
      ))}
    </Flex>
  );
}
