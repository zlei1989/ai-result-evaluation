'use client';

/**
 * 「模型调用重试」卡：一个数字——四家智能体每一次模型请求失败后最多再试几次。
 * 纯展示：不调接口，保存走 `onChange`；异步与错误提示留在调用方（本组件不认识 `message`）。
 *
 * 四个刻意的取舍：
 *   1. **即时落盘**（与「界面主题」「diff 上限」同一条口径，而不是自定义请求头那种显式保存）：
 *      只有一个数，一次点击就能定下来；显式保存按钮会让「改完没点」变成一个没有提示的悬空状态。
 *   2. **越界与非整数不下发**：`InputNumber` 的 `min` / `max` 只在失焦与步进时夹值，打字过程中
 *      完全可能先出现 `2.5` 或 `25`。放它们下去就是一次 400，而用户只是还没打完。
 *   3. **`0` 是合法值**：它表示「不重试」，与「没配」不是同一件事；任何 `|| 默认值` 式的兜底
 *      都会把 0 吞成 10——那正是这个卡片最容易写坏的一处。
 *   4. **文案不写死数字来源**：默认值与上下限从契约常量来（服务端 schema、四家适配器、界面读同一份），
 *      这里只负责把「作用面 / 不含首次 / 与整行重跑是两层」说清楚。
 */
import type { ReactNode } from 'react';
import { Card, Flex, Form, InputNumber, Typography } from 'antd';
import { MODEL_RETRIES_DEFAULT, MODEL_RETRIES_MAX, MODEL_RETRIES_MIN } from '@aieval/contracts';

export interface ModelRetryCardProps {
  /** 已保存的那份（设置里的 `modelRetries`） */
  value: number;
  /** 保存在跑：输入框置灰（避免半截状态里继续改） */
  saving: boolean;
  /** 「改了」：只在值是 `[min,max]` 内的整数时调用 */
  onChange: (value: number) => void;
}

export function ModelRetryCard({ value, saving, onChange }: ModelRetryCardProps): ReactNode {
  return (
    <Card title="模型调用重试" size="small" data-testid="model-retry-card">
      <Flex vertical gap={8}>
        <Typography.Text type="secondary">
          四家智能体（Claude Code / Codex / DeepSeek Harness / Pi）发往网关的每一次模型请求，失败后由厂商
          按自己的可重试清单退避重试（5xx / 429 / 超时 / 连接中断等；400 这类确定性错误不重试）。
          这里是「最多再试几次」（不含首次调用），四家用同一个数；默认 {MODEL_RETRIES_DEFAULT}，
          0 表示不重试。它与「整行失败后自动重跑」是两层，两者会叠加。
        </Typography.Text>
        <Form layout="vertical" size="small" component={false}>
          <Form.Item label="失败重试次数" style={{ marginBottom: 0 }}>
            <InputNumber
              aria-label="模型调用失败重试次数"
              min={MODEL_RETRIES_MIN}
              max={MODEL_RETRIES_MAX}
              step={1}
              precision={0}
              suffix="次"
              disabled={saving}
              value={value}
              onChange={(next) => {
                // 打字过程中的中间态（空值 / 小数 / 越界）不下发：一次 400 只会让输入框闪回去
                if (typeof next !== 'number' || !Number.isInteger(next)) return;
                if (next < MODEL_RETRIES_MIN || next > MODEL_RETRIES_MAX) return;
                onChange(next);
              }}
            />
          </Form.Item>
        </Form>
      </Flex>
    </Card>
  );
}
