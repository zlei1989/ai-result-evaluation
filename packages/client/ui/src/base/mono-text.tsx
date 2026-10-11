'use client';

/**
 * 等宽文本块：执行日志、diff 正文、模型原始返回共用。
 * 两个注意点：
 *   1. 自动滚底只在**文本变化时**执行一次（不是每次渲染）——每次渲染都滚会把用户往上翻的动作按回去；
 *   2. 滚动用 `host.scrollTop = host.scrollHeight`，不用 `scrollTo`：后者在 jsdom 里不可达，
 *      而这条分支正是要能被测到的那条（见 mono-text.test.tsx 的说明）。
 * 等宽字体取自 antd 的 `token.fontFamilyCode`，不手写字体名（与全站「样式走 antd」一致）。
 * ⚠️ **字体必须挂在承载文本的那个元素上**（下面那个 `Typography.Text`）：只挂在宿主上会被
 * `.ant-typography` 自己的 `font-family` 盖掉——宿主上写着等宽、量出来却是系统字体，
 * 而这件事在 jsdom 里看不出来（没有 CSS 级联），只有真机读 `getComputedStyle` 才现形。
 */
import { Flex, theme, Typography } from 'antd';
import { useEffect, useRef, type ReactNode } from 'react';

export interface MonoTextProps {
  text: string;
  /** 限高（px）；不传则由父容器决定 */
  maxHeight?: number;
  /** 尾部自动滚动（日志抽屉默认打开，由调用方的开关控制） */
  autoScroll?: boolean;
  /** 宿主的 data-testid：滚动与几何断言都靠它定位 */
  dataTestId?: string;
}

export function MonoText({ text, maxHeight, autoScroll = false, dataTestId }: MonoTextProps): ReactNode {
  const { token } = theme.useToken();
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!autoScroll || host === null) return;
    host.scrollTop = host.scrollHeight;
  }, [autoScroll, text]);

  return (
    <Flex
      ref={hostRef}
      vertical
      data-testid={dataTestId}
      style={{
        fontFamily: token.fontFamilyCode,
        whiteSpace: 'pre-wrap',
        overflow: 'auto',
        ...(maxHeight === undefined ? {} : { maxHeight }),
      }}
    >
      <Typography.Text style={{ fontFamily: token.fontFamilyCode, whiteSpace: 'pre-wrap' }}>{text}</Typography.Text>
    </Flex>
  );
}
