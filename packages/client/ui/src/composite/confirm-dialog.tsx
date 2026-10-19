'use client';

/**
 * 设置屏的二次确认对话框：删除这类不可逆动作统一走它。
 *
 * 为什么单独抽一份：供应商表与 MCP 表各有一个删除动作，两处的文案不同、**确认语义必须一致**
 * （点「取消」/ 点遮罩 / 按 Esc 都不触发回调；只有「确认删除」那一下才交出去）。
 * 组件本身不持有状态：开关与目标都由调用方管，它只负责渲染与转发。
 */
import type { ReactNode } from 'react';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 后果说明：用户点删除时看到的只有这一句，必须说清「删掉之后会失去什么」 */
  description: string;
  /** 确认按钮的文案：必填，写成被执行的动作（「删除」，不写「确认删除」）——可访问名与可见文案逐字一致 */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 只有「关掉」这一支交给调用方：打开由外部状态驱动，这里不接
        if (!next) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
