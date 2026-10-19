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
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Textarea } from '../components/ui/textarea';

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

  // 关闭即丢弃文本：留着下次打开又看到上次那份，用户会以为「已经识别过了」。
  // 挂在 `open` 上而不是动画结束事件上——受控弹窗的开关由父组件决定，jsdom 里没有动画。
  useEffect(() => {
    if (!open) setText('');
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent data-testid="rubric-recognize-dialog" style={{ maxWidth: 720 }} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>智能识别评分标准项</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            把你的评分要求粘贴进来，识别结果会回填到表单里的评分标准项表格
          </p>
          <Textarea
            rows={10}
            value={text}
            aria-label="评分要求"
            data-testid="rubric-recognize-text"
            onChange={(event) => setText(event.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" data-testid="rubric-recognize-cancel" onClick={onCancel}>
            取消
          </Button>
          <Button
            data-loading={recognizing ? 'true' : undefined}
            disabled={recognizing}
            data-testid="rubric-recognize-submit"
            // 本组件**不看**这个 promise 的结果：失败时本来就不关窗、不清文本，原因由调用方提示。
            // 但 `.catch` 不能省——`void` 只丢掉返回值，被拒绝的 promise 会变成**未处理的 rejection**
            // （浏览器控制台一条 uncaught，测试里直接记成一次 error 把整个 run 判红）。
            onClick={() => void onRecognize(text).catch(() => {})}
          >
            {recognizing && (
              <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
            )}
            识别
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
