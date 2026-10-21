'use client';

/**
 * `image-view` 块：**模型看过的一张图片**（厂商只给路径）。
 *
 * 三条口径：
 *   · 缩略图走 antd 的 `Image`（点击放大、滚轮缩放、拖拽都在它自带的预览里），
 *     本件不另造弹层、也不自己量尺寸；
 *   · `src` 由调用方经 `srcOf` 给：**本件不认识任何路由**——「工作区里的图片怎么取」是宿主的接线
 *     （本仓的接法是 web-next 的一条字节路由），组件这一层只拿一个 URL；
 *   · 拿不到 `src` 时**不画空框**：照实说一句为什么，并把路径留在上面——路径是这一块唯一的内容，
 *     不能因为预览不了就跟着消失。
 */
import { Flex, Image, Tag, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { EllipsisText } from '../../base/ellipsis-text';
import type { ImageViewBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

/**
 * 缩略图的显示框（px）。宽度是版面尺寸而不是排版偏好，故写成常量并说明用途：
 * 固定尺寸让「一张图」在所有轮次里占同样大的位置；`objectFit: 'cover'` 负责裁掉比例差，
 * 点开的预览才是整张原图（按比例、可缩放）。
 */
const THUMBNAIL_WIDTH = 200;
const THUMBNAIL_HEIGHT = 140;

/**
 * 缩略图加载失败时的占位图（`data:` URI，antd `Image` 的 `fallback` 只收 URL）。
 *
 * 为什么需要：工作区在运行结束后会被改写，模型看过的临时截图经常已经被删掉；没有占位图时
 * 浏览器会把破图塌成图标大小（约 80×22），整块内容跟着错位。占位图是**一张图**而不是
 * 一段 CSS：尺寸写死在图片里与缩略图一致，浅色 / 深色下都用一个中性灰，不参与主题 token。
 * 文案只说「无法预览」——文件被删、权限、网络都可能，这一层不知道是哪一种。
 */
const IMAGE_FALLBACK = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140" viewBox="0 0 200 140">'
  + '<rect x="1" y="1" width="198" height="138" fill="none" stroke="#8c8c8c" stroke-dasharray="6 4" stroke-width="2"/>'
  + '<circle cx="76" cy="52" r="10" fill="#8c8c8c" opacity="0.45"/>'
  + '<path d="M50 104l28-34 20 24 14-16 30 26z" fill="#8c8c8c" opacity="0.45"/>'
  + '<text x="100" y="126" text-anchor="middle" font-size="12" fill="#8c8c8c">图片无法预览</text>'
  + '</svg>',
)}`;

export interface ImageViewBlockViewProps {
  block: ImageViewBlock;
  /** 工作区相对路径 → 可直接加载的 URL；不给 = 这个宿主不提供图片服务 */
  srcOf?: (previewPath: string) => string;
}

export function ImageViewBlockView({ block, srcOf }: ImageViewBlockViewProps): ReactNode {
  const { token } = theme.useToken();
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  const src = block.previewPath === null ? null : srcOf?.(block.previewPath) ?? null;

  return (
    <Flex vertical gap={4} data-testid="image-view-block">
      <Flex align="center" gap={4} style={{ minWidth: 0 }}>
        <Tag>查看图片</Tag>
        {sourceLabel !== null && <Tag>{sourceLabel}</Tag>}
        {/* 路径是这一块的身份：预览能不能画都照旧显示（省略号 + 全量 Tooltip） */}
        <EllipsisText text={block.path} monospace />
      </Flex>
      {src === null ? (
        <Typography.Text type="secondary">
          {block.previewPath === null ? '这张图不在该候选工作区内，无法预览' : '当前视图不提供图片预览'}
        </Typography.Text>
      ) : (
        <Image
          src={src}
          alt={block.path}
          width={THUMBNAIL_WIDTH}
          height={THUMBNAIL_HEIGHT}
          fallback={IMAGE_FALLBACK}
          style={{ objectFit: 'cover', borderRadius: token.borderRadius }}
        />
      )}
    </Flex>
  );
}
