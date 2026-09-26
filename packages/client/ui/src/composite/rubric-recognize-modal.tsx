'use client';

/**
 * 「智能识别」弹窗：**框内只有一个多行文本域**——用户把评分要求粘进来，识别结果由调用方回填到表单表格。
 *
 * 三条口径：
 *   1. **失败不清空、不关窗**：反面写法是「先清空再请求」——一次网络抖动就会清掉用户刚粘进来的长文，
 *      而用户看到的只是一句报错。本组件因此把文本放在**自己的 state** 里，只有成功或用户主动关闭才动它；
 *   2. **本组件不调接口**（纯展示）：`onRecognize` 由调用方实现，错误也由调用方提示（与 CaseFormPanel 同一条分工）；
 *   3. 关闭（取消 / 遮罩）只调 `onCancel`，**不写回**任何东西。
 */
import { Button, Flex, Input, Modal, Typography } from 'antd';
import { useState, type ReactNode } from 'react';

export interface RubricRecognizeModalProps {
  open: boolean;
  /** 识别请求在途：按钮转圈并禁用（避免连点两次花两次钱） */
  recognizing: boolean;
  onCancel: () => void;
  /** 把文本交给调用方去识别；抛错即失败（本组件据此保留文本） */
  onRecognize: (prompt: string) => Promise<void>;
}

export function RubricRecognizeModal({ open, recognizing, onCancel, onRecognize }: RubricRecognizeModalProps): ReactNode {
  const [text, setText] = useState('');

  return (
    <Modal
      open={open}
      title="智能识别评分标准项"
      // 关闭即丢弃文本：留着下次打开又看到上次那份，用户会以为「已经识别过了」
      destroyOnHidden
      onCancel={onCancel}
      afterClose={() => setText('')}
      footer={
        <Flex justify="end" gap={8}>
          <Button size="small" autoInsertSpace={false} data-testid="rubric-recognize-cancel" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="small"
            type="primary"
            autoInsertSpace={false}
            loading={recognizing}
            disabled={recognizing}
            data-testid="rubric-recognize-submit"
            // 本组件**不看**这个 promise 的结果：失败时本来就不关窗、不清文本，原因由调用方提示。
            // 但 `.catch` 不能省——`void` 只丢掉返回值，被拒绝的 promise 会变成**未处理的 rejection**
            // （浏览器控制台一条 uncaught，测试里直接记成一次 error 把整个 run 判红）。
            onClick={() => void onRecognize(text).catch(() => {})}
          >
            识别
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={8}>
        <Typography.Text type="secondary">
          把你的评分要求粘贴进来，识别结果会回填到表单里的评分标准项表格
        </Typography.Text>
        <Input.TextArea
          rows={10}
          value={text}
          data-testid="rubric-recognize-text"
          onChange={(event) => setText(event.target.value)}
        />
      </Flex>
    </Modal>
  );
}
