'use client';

/**
 * 设置屏的语义告警：error / warning / success / info 四档，落点是 vendored 的 `Alert` 一族。
 *
 * 为什么要这一层：vendored `Alert` 只有 `default` / `destructive` 两个变体，而设置屏要区分
 * 「读失败」（红）、「默认值失效」（红）、「未配置」（黄）、「校验通过」（绿）与「说明」（蓝灰）。
 * 颜色只走语义类（`text-destructive` / `amber` / `emerald` / `muted`），明暗两态由 Tailwind 的
 * `dark:` 变体与语义变量承担，不写死色值。
 *
 * `data-tone` 是给用例与守卫的稳定信号：颜色算不出来，但「这一条到底是哪一档」必须可断言
 * （把一条红色告警降级成提示色，界面上只是变淡，没有任何报错）。
 */
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';

export type SettingsAlertTone = 'error' | 'warning' | 'success' | 'info';

const TONE_CLASSES: Record<SettingsAlertTone, string> = {
  error: 'border-destructive/30 bg-destructive/5 text-destructive',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  success: 'border-success/30 bg-success/10 text-success',
  info: 'border-border bg-muted/40 text-foreground',
};

export interface SettingsAlertProps {
  tone: SettingsAlertTone;
  title: string;
  description?: ReactNode;
  /** 额外的正文块（形状示例这类需要逐行排版的内容） */
  children?: ReactNode;
  'data-testid'?: string;
}

export function SettingsAlert({
  tone,
  title,
  description,
  children,
  'data-testid': testId,
}: SettingsAlertProps): ReactNode {
  return (
    <Alert data-tone={tone} className={TONE_CLASSES[tone]} data-testid={testId}>
      <AlertTitle>{title}</AlertTitle>
      {description !== undefined && <AlertDescription className="text-current/90">{description}</AlertDescription>}
      {children}
    </Alert>
  );
}
