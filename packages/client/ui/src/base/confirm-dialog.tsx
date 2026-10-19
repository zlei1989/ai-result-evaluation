'use client';

/**
 * 确认框：不可撤销的动作（终止 / 删除 / 重跑）与「会烧掉几十分钟」的启动共用的唯一形态。
 *
 * 为什么不用气泡式确认：这些动作的代价需要完整段落说清（杀子进程、旧分被替换、
 * 本次要跑哪几个候选），气泡放不下；而确认框还能承载一份**清单**（「开始」前逐条列出候选）。
 *
 * 三条口径：
 *   · `onConfirm` 可以返回在途请求的 promise：返回 thenable 时确认按钮进入在途态、
 *     **等它落定才关闭**。提前关闭的症状是「点一下没反应」，再点一次就是第二次写请求；
 *   · 关闭只走 `onOpenChange(false)`，组件是**受控**的——调用方拿得到「用户点了取消」这一拍；
 *   · 确认键的文案（`confirmLabel`）**必填**：写被执行的那个动作，不写「确定」；
 *     危险动作另用 `destructive` 配色，与普通确认再分开一档。
 */
import { useState, type ReactNode } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  /** 必填：Base UI 的确认框要求有无障碍描述；它也正是说清「代价」的那一段 */
  description: ReactNode;
  /** 标题与按钮之间的正文（候选清单这类需要逐条列出的内容） */
  children?: ReactNode;
  /**
   * 确认键的文案：**必填**，写成被执行的那个动作（「删除」「终止」「开始执行」）。
   *
   * 不给缺省值是有意的：笼统的「确定」在「终止这一行」与「删除这一轮」上长得一模一样，
   * 用户只能回读标题才知道自己按的是什么；而缺省值一旦存在，新调用点就会照抄它。
   */
  confirmLabel: string;
  cancelLabel?: string;
  /** 危险动作（终止 / 删除）：确认键用 destructive 配色 */
  destructive?: boolean;
  /** 返回 promise 时按钮转圈、确认框等它落定再关（理由见文件头） */
  onConfirm(): void | Promise<unknown>;
  testId?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = '取消',
  destructive = false,
  onConfirm,
  testId,
}: ConfirmDialogProps): ReactNode {
  const [pending, setPending] = useState(false);

  const handleConfirm = (): void => {
    const result = onConfirm();
    if (result instanceof Promise) {
      setPending(true);
      void result.finally(() => {
        setPending(false);
        onOpenChange(false);
      });
      return;
    }
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent {...(testId === undefined ? {} : { 'data-testid': testId })}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            data-loading={pending ? 'true' : undefined}
            onClick={handleConfirm}
          >
            {pending ? <LoaderCircleIcon className="size-3 animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
