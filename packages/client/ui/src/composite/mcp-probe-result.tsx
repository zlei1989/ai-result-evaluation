/**
 * 「测试连接」结果区：三个入口（表格行内展开、表单弹窗、将来的别处）共用同一份渲染。
 *
 * 为什么必须共用：口径就是「按钮按下之后说什么话」——两处各写一遍必然漂移，
 * 而漂移的那一侧通常是**说得更多**的那一侧（成功文案里多出「配置可用」这类越界措辞）。
 *
 * 两条渲染口径：
 *   1. **成功**：一句结论（`probeSuccessText`，模板在 contracts）+ 补充说明（notes）。
 *      刻意不用绿色大字报：这条结论的判据强度是「中」（进程起得来 + 讲 MCP + 列出 N 个工具），
 *      它证明不了 key、浏览器、行内下载——文案本身已经把边界说清楚了。
 *   2. **失败两段式**：中文结论是标题（一眼看到的那个），**厂商原文照抄**放折叠区（FAQ 按原文索引，
 *      改写过的转述搜不到）；原文为空时不渲染折叠区，不留一个空壳。
 */
import { Alert, Collapse, Flex, Typography } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { probeSuccessText, type McpProbeResult } from '@aieval/contracts';
import { MonoText } from '../base/mono-text';

/**
 * 探活进行中的提示：挂载即开始计时，**超过 1 秒**才把「已等待 Ns」写出来。
 *
 * 为什么要有这个秒数：stdio 首次启动要过 npx 解析层（+2.7 s）甚至下载（+0.8 s 起，冷态更多），
 * 界面上只有一句「测试中…」时用户会以为卡死并连点（连点会被服务端串行挡下，但每点一次都要排队）。
 * 反过来，1 秒以内就把秒数抖出来又太吵，故 1 秒是那个分界。
 */
export function McpProbeWaiting(): ReactNode {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Typography.Text type="secondary" data-testid="mcp-probe-waiting">
      {seconds >= 1 ? `测试中…（已等待 ${seconds} s）` : '测试中…'}
    </Typography.Text>
  );
}

/**
 * 结果区的内容：探活结论，或**请求本身失败**。
 * 后者不是探活档位里的一种（「配置里没这条」「服务端 500」「网络断了」都不是端点的问题），
 * 故不塞进 `McpProbeResult.failure` 里去借一个不准确的档位，而是另一种内容。
 */
export type McpProbeOutcome = { kind: 'result'; result: McpProbeResult } | { kind: 'error'; message: string };

export interface McpProbeResultViewProps {
  outcome: McpProbeOutcome;
}

export function McpProbeResultView({ outcome }: McpProbeResultViewProps): ReactNode {
  if (outcome.kind === 'error') {
    return (
      <Alert
        type="error"
        showIcon
        data-testid="mcp-probe-result"
        title={`测试请求失败：${outcome.message}`}
      />
    );
  }

  const { result } = outcome;
  const failure = result.failure;
  return (
    <Flex vertical gap={4} data-testid="mcp-probe-result">
      {result.ok ? (
        <Alert type="success" showIcon title={probeSuccessText(result)} data-testid="mcp-probe-ok" />
      ) : (
        // 第一段：中文结论分档（「端点不存在（HTTP 404）」这种一眼能读懂的话）
        <Alert
          type="error"
          showIcon
          title={failure?.message ?? '测试失败'}
          data-testid="mcp-probe-failure"
        />
      )}
      {/* 补充说明与结论分开渲染：它们是「这次验到了哪一步」的限定，不是第二份结论 */}
      {result.notes.map((note) => (
        <Typography.Text key={note} type="secondary">
          {note}
        </Typography.Text>
      ))}
      {/* 第二段：厂商原文照抄（可折叠）。空原文不渲染折叠区 —— 一个点开是空的折叠区比没有更糟 */}
      {failure !== undefined && failure.vendorText.trim() !== '' && (
        <Collapse
          size="small"
          data-testid="mcp-probe-vendor"
          items={[
            {
              key: 'vendor',
              label: '厂商原文',
              children: <MonoText text={failure.vendorText} maxHeight={200} dataTestId="mcp-probe-vendor-text" />,
            },
          ]}
        />
      )}
    </Flex>
  );
}
