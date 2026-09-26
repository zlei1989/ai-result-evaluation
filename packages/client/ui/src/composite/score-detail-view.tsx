'use client';

/**
 * 评分详情：总分 + 满分 + 逐项达成 / 未达成 + 每项理由 + 总评 + 评分者 + 模型原始返回。
 * 五条口径：
 *   1. **总分原样显示 `score.totalScore`，前端不重算**——它是服务端按权重加总出来的权威值
 *      （缺一项即整行判失败），在这里「按评分表现场加一遍」会把数据不一致静默改写成另一个数；
 *   2. **满分来自 `score.maxScore`**（不是常量 100，也不现算）——它是这一分生成时那张表的权重之和；
 *   3. **未达成的项必须与达成项区分开**：它们才是使用者要看的重点；
 *   4. 判定与评分表按**引用键**对齐；评分表里有而判定里没有的项**显式标出**（不静默跳过）
 *      ——那种「看起来正常」的表格比报错危险得多；
 *   5. 原始返回必须可见：解析失败时它是判断「提示词问题还是模型问题」的唯一线索。
 */
import { Flex, Tag, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { AGENT_LABELS, rubricItemKeys, type Rubric, type ScoreResult } from '@aieval/contracts';
import { MonoText } from '../base/mono-text';
import { formatDateTime } from '../base/format';

export interface ScoreDetailViewProps {
  score: ScoreResult;
  /** 这一轮用的评分表（**快照**，与 `score` 来自同一份 run.json） */
  rubric: Rubric;
}

export function ScoreDetailView({ score, rubric }: ScoreDetailViewProps): ReactNode {
  // 未达成项的语义色取 antd token（不写 `var(--ant-color-error)` 字面量：换主题时这里跟着走）
  const { token } = theme.useToken();
  const items = rubric.groups.flatMap((group) => group.items);
  const keys = rubricItemKeys(rubric);
  const byId = new Map(score.judgments.map((judgment) => [judgment.id, judgment]));

  return (
    <Flex vertical gap={16} style={{ padding: 16 }}>
      <Flex align="baseline" gap={8} wrap>
        {/* 总分原样显示（见文件头口径 1） */}
        <Typography.Title level={4}>{score.totalScore}</Typography.Title>
        <Typography.Text type="secondary">
          满分 {score.maxScore} 分 · 共 {keys.length} 项
        </Typography.Text>
      </Flex>

      <Flex vertical gap={8}>
        {rubric.groups.map((group) => (
          <Flex vertical gap={4} key={group.name}>
            <Typography.Text strong>{group.name}</Typography.Text>
            {group.items.map((item) => {
              const index = items.indexOf(item);
              const key = keys[index] ?? '';
              const judgment = byId.get(key);
              return (
                <Flex
                  key={key}
                  data-testid={`score-judgment-${key}`}
                  // 「达成 / 未达成」的**数据属性**判据：比断言 class 稳（antd 换 token 不会让它红），
                  // 也正是测试用的那一条
                  data-achieved={judgment?.achieved === true ? 'yes' : 'no'}
                  gap={8}
                  align="baseline"
                  // 未达成的项用 antd 的语义色标出来——它才是使用者要看的重点。
                  // 取 token 而不是写 `var(--ant-color-error)` 字面量：主题换色时这里跟着走
                  style={judgment?.achieved === true ? undefined : { color: token.colorError }}
                >
                  <Typography.Text code style={{ minWidth: 48 }}>
                    {key}
                  </Typography.Text>
                  <Typography.Text style={{ flex: 1 }}>{item.goal}</Typography.Text>
                  <Typography.Text strong>{item.weight} 分</Typography.Text>
                  {judgment === undefined ? (
                    <Tag color="warning">缺少判定</Tag>
                  ) : (
                    <Tag color={judgment.achieved ? 'success' : 'error'}>{judgment.achieved ? '达成' : '未达成'}</Tag>
                  )}
                  <Typography.Text type="secondary" style={{ flex: 2 }}>
                    {judgment?.reason ?? ''}
                  </Typography.Text>
                </Flex>
              );
            })}
          </Flex>
        ))}
      </Flex>

      <Flex vertical gap={4}>
        <Typography.Text strong>总评</Typography.Text>
        <Typography.Paragraph style={{ marginBottom: 0 }}>{score.verdict}</Typography.Paragraph>
      </Flex>

      {/* 评分者一行分**两条通路**（spec §10 展示表）：`judgeAgentKind === null` ⇔ 纯文本 API 评分
          （老记录读盘后同样是 `null`，契约里 `.default(null)`），此时「评分模型：…」那一段逐字节保持
          原样；非 null 才多出「评分智能体：X · 模型：Y」——光有模型名回答不了「这一分是文本请求打的
          还是智能体会话打的」，而两条通路的分数不可比（README「分数怎么来的」的既有口径）。
          「输出约束」只陈述**我们提交了什么**（spec D10）：true = 提交给模型的是 schema 约束，false =
          只有提示词契约（文本通路与 dsh 通路）。它不表示上游一定照做了（网关可能把那一格丢掉，
          spec §9 第 1 条），故不写「模型已按 schema 返回」这类承诺，也不给告警样式——false 只是事实。 */}
      <Typography.Text type="secondary">
        {score.judgeAgentKind === null
          ? `评分模型：${score.judgeModelId}`
          : `评分智能体：${AGENT_LABELS[score.judgeAgentKind]} · 模型：${score.judgeModelId}`}
        {' · '}
        输出约束：{score.structuredOutput ? 'schema 约束' : '提示词约束'}
        {' · '}
        评分时间：{formatDateTime(score.judgedAt)}
      </Typography.Text>

      <Flex vertical gap={4}>
        <Typography.Text strong>模型原始返回</Typography.Text>
        <MonoText text={score.raw} maxHeight={240} dataTestId="score-raw" />
      </Flex>
    </Flex>
  );
}
