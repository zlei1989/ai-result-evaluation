'use client';

/**
 * `Attachments` 的本仓外壳（`@ant-design/x` 的导入只允许出现在 `base/`）。
 *
 * **两种用法，同一个壳**：
 *   1. **触发态**（输入框内那个回形针）：传 `children`，壳把它包成**拖拽区 + 选择器**——
 *      `children` 就是那颗按钮，`Attachments` 自己在它外面套 `DropArea` 与隐藏的 file input；
 *   2. **清单态**（框上方那一行）：传 `items`，X 只在 `items` 非空时渲文件清单
 *      （源码里就是 `fileList.length > 0`）。
 *
 * ⚠️ **两者别塞进同一个槽**：清单是跟着 `items` 走的，而 `children` 模式把清单渲在
 * **它自己内部**。把带 `items` 的实例放进 `Sender` 的 `prefix`，文件清单会被挤进输入框那一行
 * （它跟输入框一样高）——所以本仓的口径是：**触发按钮住 `prefix`（不给它 `items`），
 * 清单住框上方那一行**。
 *
 * 另外两件事：
 *   · `beforeUpload: () => false` 是**上传语义的开关**——文件不往任何地方传，
 *     只留在调用方手里（本仓的文件是发消息时按既有的落盘口径落临时目录的，
 *     让 antd 自传会变成两份真相）；
 *   · 转出**命令式句柄**（`.select()`）：触发按钮住在 `Sender` 的 `prefix` 槽、
 *     文件选择器住在 `Attachments` 内部，不给句柄两者就没法对话。
 *
 * **尺寸一律走 token、不在这里写**（同 `x-sender` 的理由），由
 * `x-shell-size-discipline.test.ts` 静态核对。
 */
import { Attachments } from '@ant-design/x';
import type { AttachmentsProps } from '@ant-design/x';
import { forwardRef, useImperativeHandle, useRef, type ReactElement, type ReactNode } from 'react';

/** 一条附件 = X 自己那一份（本仓不在壳里另造一套文件类型） */
export type XAttachmentItem = NonNullable<AttachmentsProps['items']>[number];

/** 命令式句柄：目前只有「打开文件选择器」一件 */
export interface XAttachmentsHandle {
  /** 打开系统文件选择器；`accept` 由调用方按这一轮的允许类型给 */
  select(options?: { accept?: string; multiple?: boolean }): void;
}

export interface XAttachmentsProps {
  /** 清单态：非空时 X 才渲那一行文件清单（空数组与不传都是「不渲」） */
  items?: readonly XAttachmentItem[];
  onChange?(next: XAttachmentItem[]): void;
  /** 触发态：包成拖拽区的那个元素（本仓是一颗 `Button`）。X 只收**单个元素** */
  children?: ReactElement;
  /**
   * 文件要不要往上传。**本仓恒传 `() => false`**：文件留在调用方手里，
   * 由发消息那一步按既有的落盘口径落临时目录（让 antd 自传会变成两份真相）。
   */
  beforeUpload?: AttachmentsProps['beforeUpload'];
  /**
   * 拖拽落点容器。需要一个真实宿主元素（拖到哪算数）；缺省由调用方给，
   * 给 `null`/不给就是 X 的默认（贴在本组件范围里）。
   */
  getDropContainer?: AttachmentsProps['getDropContainer'];
  /** 空态提示（拖拽区里那两行字）；不传就不渲那一段（不编装饰性文案） */
  placeholder?: AttachmentsProps['placeholder'];
  /**
   * 溢出方向。**清单在框上方那一行时用 `scrollX`**：横向滚动只占一行高，
   * 竖向滚动会把输入框往上顶（输入区的高度链会跟着动）。
   */
  overflow?: AttachmentsProps['overflow'];
  disabled?: boolean;
}

export const XAttachments = forwardRef<XAttachmentsHandle, XAttachmentsProps>(function XAttachments(
  { items, onChange, children, beforeUpload, getDropContainer, placeholder, overflow, disabled },
  ref,
): ReactNode {
  const inner = useRef<{ select?: (options?: { accept?: string; multiple?: boolean }) => void } | null>(null);

  useImperativeHandle(ref, () => ({
    select(options) {
      inner.current?.select?.(options);
    },
  }));

  return (
    <Attachments
      ref={inner as never}
      items={items === undefined ? undefined : (items as XAttachmentItem[])}
      onChange={({ fileList }) => onChange?.(fileList)}
      beforeUpload={beforeUpload}
      getDropContainer={getDropContainer}
      placeholder={placeholder}
      overflow={overflow}
      disabled={disabled}
    >
      {children}
    </Attachments>
  );
});
