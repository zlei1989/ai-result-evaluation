'use client';

/**
 * 字段级**警告**：与 `FieldError` 同一位置、同一字号，但用 warning 色而不是 destructive。
 *
 * 它存在的唯一理由是「警告不拦提交」这条语义（MCP 服务器名的字符集与撞名提示）：
 * 那两个检查一出错用户就该看见，但保存必须仍然走得通——真源在契约，界面不装第二个裁判。
 * 因此：
 *   · **不进 `formState.errors`**（进去就会被 resolver 拦住提交）；
 *   · `role="status"` 而不是 `role="alert"`——它不是错误，读屏器不该用报警语气念它；
 *   · 颜色写 Tailwind 的 amber，不挪用 `text-destructive`：两者视觉上分不开时，
 *     用户会把「可以保存」读成「不能保存」。
 *
 * 样式口径与 vendored 的 `FieldError` 对齐（`text-sm leading-normal font-normal`），
 * 只换颜色与语义角色。
 */
import type { ReactNode } from 'react';

export interface FieldWarningProps {
  children: ReactNode;
  /** 与控件的 `aria-describedby` 配对用 */
  id?: string;
  'data-testid'?: string;
}

export function FieldWarning({ children, id, 'data-testid': testId }: FieldWarningProps): ReactNode {
  return (
    <p
      id={id}
      role="status"
      data-slot="field-warning"
      data-testid={testId}
      className="text-sm leading-normal font-normal text-warning"
    >
      {children}
    </p>
  );
}
