'use client';

/**
 * `Folder` 的本仓外壳（`@ant-design/x` 的导入只允许出现在 `base/`，见
 * `docs/architecture/ui-primitives-and-theme.md` 与《X 落地纪律》）。
 *
 * 五件事，每一件都是本仓的口径而不是 X 的默认值：
 *
 *   1. **预览恒由调用方接管**（`previewRender`）。X 的内置预览写死 `oneLight` 高亮主题，
 *      不随 `darkAlgorithm` 走——直接用会在暗色下铺一块浅色底。内容加载也归调用方
 *      （本仓走 SWR：错误是中文、有缓存），壳不碰 `fileContentService`。
 *   2. **标题栏由壳渲染、内容由调用方给**（`previewTitle`）：左边是文件（完整相对路径）、
 *      右边是复制按钮。⚠️ **不能靠 X 的默认那一栏**：它的复制源是 `fileContentService` 取到的内容
 *      （本仓不走那条路 ⇒ 那个按钮只会复制一句占位文案），而要它就得让 X 自己再取一遍内容
 *      ——多一个请求，且它的 `loading` 会在取数那几帧顶掉调用方的预览。
 *   3. **树节点两格都放叶子名**（`title` 与 `path`）：`path` 供 X 逐层拼树键，`title` 只显示这一层
 *      ——**不带父目录前缀**。缩进已经表达了层级，再把 `reference/` 写进子节点标题就是重复；
 *      完整相对路径在预览区标题栏那一格（见第 2 条）。
 *   4. **树标题默认不渲染**（`directoryTitle={false}`）：树那一栏上下都是内容，多一行只是噪声。
 *      调用方要说话时再传 `title`。
 *   5. **选中是受控的**：`selectedFile` 恒给数组（没选中时给空数组，而不是 `undefined`）。
 *      传 `undefined` 会退回 X 的内部态，于是「关掉抽屉再打开」还会残留上一次选中的文件。
 */
import { Actions, Folder } from '@ant-design/x';
import type { FolderTreeData } from '@ant-design/x';
import { Flex, Typography, theme } from 'antd';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { SkillTreeNode } from '@aieval/contracts';

export interface XFolderProps {
  /** 树数据（本仓契约形状：`title` / `path` 都是叶子名、`children` 恒为数组） */
  nodes: SkillTreeNode[];
  /** 选中的文件（**路径段数组**，与树的层级一一对应）；null = 没选中 */
  selectedPath: string[] | null;
  /** 点了某个文件：收到**路径段数组**（X 的树键按 `/` 切开就是它） */
  onSelectPath(segments: string[]): void;
  /** 右侧预览那一栏（由调用方渲染） */
  preview: ReactNode;
  /**
   * 预览区的标题栏：左边 `fileName`（通常给**完整相对路径**——它才是「同名文件分得清」的那一格）、
   * 右边是复制 `copyText` 的按钮。不传 = 不渲染标题栏。
   */
  previewTitle?: { fileName: string; copyText: string };
  /** 左树顶部的标题；不传 = 不渲染（见文件头第 4 条） */
  title?: ReactNode;
  /** 没选中任何文件时右侧那一栏 */
  empty?: ReactNode;
  /** 结构性尺寸（高度之类）由调用方给：抽屉里它要吃掉剩余高度 */
  style?: CSSProperties;
}

/** 契约形状 → X 的树形状：`title` 与 `path` 都原样透传（两边都是叶子名，见文件头第 3 条） */
function toFolderTree(nodes: SkillTreeNode[]): FolderTreeData[] {
  return nodes.map((node) => ({
    title: node.title,
    path: node.path,
    // 目录才给 children：空目录给 `[]`（它仍是个目录），叶子给 `undefined`（组件据此判 isLeaf）
    children: node.isDirectory ? toFolderTree(node.children) : undefined,
  }));
}

export function XFolder({
  nodes,
  selectedPath,
  onSelectPath,
  preview,
  previewTitle,
  title,
  empty,
  style,
}: XFolderProps): ReactNode {
  const { token } = theme.useToken();
  const treeData = useMemo(() => toFolderTree(nodes), [nodes]);

  return (
    <Folder
      treeData={treeData}
      style={style}
      // 标题默认关掉（见文件头第 4 条）：`undefined` 会让 X 渲染它自己的默认标题区
      directoryTitle={title ?? false}
      // 恒给数组（见文件头第 5 条）：`undefined` 会退回内部态，残留上一次的选中
      selectedFile={selectedPath ?? []}
      onSelectedFileChange={({ path }) => onSelectPath(path)}
      // 恒接管预览（见文件头第 1 条）
      previewRender={preview}
      // 标题栏自己渲染（见文件头第 2 条）；不传就走 X 的「不渲染标题」分支
      previewTitle={
        previewTitle === undefined
          ? false
          : () => (
            <Flex
              justify="space-between"
              align="center"
              // 复刻 X 给默认标题栏的那几格（`es/folder/style/index.js` 的 `-preview-title`）：
              // 间距走 token，紧凑密度一变它跟着变
              style={{
                paddingInline: token.padding,
                paddingBlock: token.paddingXS,
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <Typography.Text>{previewTitle.fileName}</Typography.Text>
              <Actions.Copy text={previewTitle.copyText} />
            </Flex>
          )
      }
      emptyRender={empty}
    />
  );
}
