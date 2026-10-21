'use client';

/**
 * `Sender` 的本仓外壳（`@ant-design/x` 的导入只允许出现在 `base/`，见
 * `docs/architecture/ui-primitives-and-theme.md` 与《X 落地纪律》）。
 *
 * 外壳刻意**薄**：语义留在调用方（只有调用方知道这一轮的开关开没开、发出去的是「排队」还是
 * 「立即发送」），这里只做三件事——
 *   1. 收口导入路径：`Sender` 与 `Sender.Header` 在 X 里是一个点号子组件，
 *      而点号子组件在 App Router 的模块边界上取不到 ⇒ 这里改走**深路径**导入再转出，
 *      调用方永远只认 `@aieval/ui` 的两个名字；
 *   2. 把本仓真正用到的那几格显式列出来（`Sender` 自己有二十来格，透传会把它变成一层面纱）；
 *   3. 钉住一处默认值：`submitType` 用 X 的默认（回车发送、Shift+回车换行）。
 *      发送键仍是 **X 自带的那一颗**（`suffix` 的默认渲染），调用方要用它自己判「这一键能不能点」
 *      时传 `suffix` 即可——**不另画一颗**（见下面 `suffix` 那一格的注释：X 的空输入判据
 *      只在「没显式给 `disabled`」时才生效，而调用方常常必须显式给）。
 *
 * **尺寸一律走 token、不在这里写**：`Sender` 没有 `size` 能力（X 官方 FAQ 里的
 * `<Sender size="small" />` 是文档错误），而紧凑密度在本仓由 antd 的紧凑算法统一推导——
 * 壳里任何一处手写字号 / 行高 / 内边距都会把那一格从推导链上摘下来（实效字号掉到 10px）。
 * 这条纪律由 `x-shell-size-discipline.test.ts` 静态核对。
 *
 * **自带「进行中」的两格不透传**：`loading` 会换成取消键、`allowSpeech` 是语音输入，
 * 本仓的「智能体在跑」有自己的一格信号（排队态），两个都挂就是同一件事说两遍。
 * 要用 X 自带的那一套，改的是调用方的判据，不是这里。
 */
import { Sender } from '@ant-design/x';
import type { SenderProps } from '@ant-design/x';
import SenderHeader from '@ant-design/x/es/sender/SenderHeader';
import type { ReactNode } from 'react';

export interface XSenderProps {
  /** 受控值：本仓的草稿住在调用方（「删除回填」要写进它） */
  value: string;
  onChange(next: string): void;
  /** 点发送键或回车时触发；调用方在这一刻决定这条消息的意图 */
  onSubmit(message: string): void;
  placeholder?: string;
  /** 只读态（例如这个候选已经收场） */
  disabled?: boolean;
  /** 输入框**上方**的展开面板（本仓放附件预览） */
  header?: ReactNode;
  /** 输入框**内部**的前缀槽（本仓放上传按钮） */
  prefix?: ReactNode;
  /** 输入框下方的补充内容 */
  footer?: ReactNode;
  /**
   * 输入框右下那一格动作区的替换渲染（默认就是那颗圆形上箭头）。
   *
   * 为什么本仓要给它：**空输入自动禁用那条判据只在「没显式给 `disabled`」时才生效**——
   * `ActionButton` 读的是 `restProps.disabled ?? rootDisabled ?? context.onSendDisabled`，
   * 而 `??` 只跳过 `null` / `undefined`：调用方一旦给 `Sender` 传了 `disabled={false}`
   * （布尔值，不是 `undefined`），X 自己那条「输入为空就禁用」就**永远不生效**，
   * 症状是空框上那颗键看着可点、点下去什么都不发生。
   * 故本仓把「这一键能不能点」显式交给调用方（它才知道「只有附件、没有正文」算不算内容）。
   */
  suffix?: SenderProps['suffix'];
  /** 自动长高的上下限；不传用 X 的默认（最多 8 行） */
  autoSize?: { minRows?: number; maxRows?: number };
}

export function XSender({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  header,
  prefix,
  footer,
  suffix,
  autoSize,
}: XSenderProps): ReactNode {
  return (
    <Sender
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      placeholder={placeholder}
      disabled={disabled}
      header={header}
      prefix={prefix}
      footer={footer}
      suffix={suffix}
      autoSize={autoSize}
    />
  );
}

export interface XSenderHeaderProps {
  /** 面板标题（本仓写「附件 N 个」这类事实，不写装饰性文案） */
  title?: ReactNode;
  children?: ReactNode;
}

/**
 * `Sender.Header` 的转出。**常开**（`open` 固定为真）：它的体积由内容决定，
 * 内容为空时调用方**不该渲染它**（渲染一个空面板会白吃掉输入框上方一段高度）。
 *
 * `closable` 固定为 `false`：X 默认在标题行右侧渲一颗关闭键，而那个点击走 `onOpenChange`
 * ——本仓的面板开合由调用方自己控（`open` 恒真），不接那个回调时那颗键**点了没有任何反应**。
 * 一个点不动的按钮比没有按钮更糟，故这里不给它。代价：`title` 也不再渲标题行
 * （X 的判据是 `closable !== false || title`），要标题的调用方自己放进 `children` 第一行。
 */
export function XSenderHeader({ title, children }: XSenderHeaderProps): ReactNode {
  return (
    <SenderHeader title={title} open closable={false}>
      {children}
    </SenderHeader>
  );
}
