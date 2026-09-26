'use client';

/**
 * 等宽文本块：执行日志、diff 正文、模型原始返回共用。
 * 两个注意点：
 *   1. 自动滚底只在**文本变化时**执行一次（不是每次渲染）——每次渲染都滚会把用户往上翻的动作按回去；
 *   2. 滚动用 `host.scrollTop = host.scrollHeight`，不用 `scrollTo`：后者在 jsdom 里不可达，
 *      而这条分支正是要能被测到的那条（见 mono-text.test.tsx 的说明）。
 * 等宽字体取自 antd 的 `token.fontFamilyCode`，不手写字体名（与全站「样式走 antd」一致）。
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
      <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{text}</Typography.Text>
    </Flex>
  );
}
