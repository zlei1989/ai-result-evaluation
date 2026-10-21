'use client';

/**
 * 技能预览抽屉：**左树右预览**。左边是这条技能的目录树（递归全列），右边是选中文件的正文，
 * 整份按 markdown 渲染。纯展示：树与正文都由调用方（页面）取好递进来，本件不调接口。
 *
 * 六个必须守住的点：
 *   1. **不做「frontmatter 逐字」那一格**：整份文件按 markdown 渲染，只是 frontmatter 段先由
 *      `fenceFrontmatter` 包进 ```yaml 围栏——不包的话收尾那条 `---` 会按 CommonMark 的 setext
 *      规则把 `name:` / `description:` 吃成标题（本仓降两级后是页面里最大的一行字）。
 *      字段解析只发生在服务端的准入判定里（`splitSkillMarkdown` 在那里），界面上不摆第二份解析结果；
 *   2. **正文交给 `XMarkdownText`**（`@ant-design/x-markdown`）：原始 HTML **一律转义成文本**
 *      （外壳里 `escapeRawHtml` 恒开）。`SKILL.md` 是外部输入（可能随被测仓库克隆进来），这一条正是要的；
 *   3. **树只回答「有什么」**：磁盘上的条目照列，唯一的例外是常见噪声（`.DS_Store` / `.git` /
 *      `node_modules` 这类 OS / 版本库 / 依赖条目，名单在服务端 `skill-store`）——它们不是技能内容，
 *      占一行只是噪声；表外的点文件照列。「读不出来」的结论一律落在右侧预览格（带中文原因）——
 *      **任何一格不得用空内容顶替**；
 *   4. **顶部不摆事实块**：这一条的名字在抽屉标题上，路径与体积都不摆（体积契约里本就没有这一格，
 *      见 `SkillEntrySchema`）；树从技能目录的**内容**开始（不含技能名那一层），节点标题给
 *      **完整相对路径**——读者要的是「它在技能里的哪一处」，不是「它叫什么」；
 *   5. **不可用条目也打得开**：抽屉照旧给这两个事实 + 中文原因，正文那一格再说明为什么读不出来
 *      （「缺 SKILL.md」这类结论要能在点开之后看到，而不是只能悬停标签）；
 *   6. **几何走共享常量**：宽度与语义槽样式取自 `drawer-geometry`（`body.padding` 已置 0，
 *      内边距由内容自己按主题 token 给）。
 */
import { Alert, Button, Drawer, Flex, Skeleton, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import type { SkillEntry, SkillFileText, SkillTree } from '@aieval/contracts';
import { DRAWER_SEMANTIC_STYLES, WIDE_DRAWER_SIZE } from '../base/drawer-geometry';
import { EmptyState } from '../base/empty-state';
import { XFolder } from '../base/x-folder';
import { XMarkdownText } from '../base/x-markdown';
import { fenceFrontmatter } from './skill-preview-markdown';

export interface SkillDetailDrawerProps {
  open: boolean;
  /** 被打开的那一条；null = 没选中（抽屉关着，或列表刷新后目标已不在） */
  skill: SkillEntry | null;
  /** 这条技能的目录树；undefined = 还没取到 */
  tree: SkillTree | undefined;
  /** 树读取失败的原因（服务端的 `ServiceError`，message 已是可直接展示的中文） */
  treeError: unknown;
  treeLoading: boolean;
  /** 整棵树都列不出来时的那一次重试 */
  onRetryTree: () => void;
  /** 选中的技能内路径（**完整 slash 路径**，如 `poetry/SKILL.md`）；null = 还没点任何文件 */
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  /** 选中那个文件的原文；undefined = 还没取到（配合 `fileLoading` / `fileError` 分三态） */
  file: SkillFileText | undefined;
  fileError: unknown;
  fileLoading: boolean;
  onClose: () => void;
}

/** 错误对象转成可展示的中文：`ServiceError.message` 本来就是给人看的中文 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SkillDetailDrawer({
  open,
  skill,
  tree,
  treeError,
  treeLoading,
  onRetryTree,
  selectedPath,
  onSelectPath,
  file,
  fileError,
  fileLoading,
  onClose,
}: SkillDetailDrawerProps): ReactNode {
  const { token } = theme.useToken();

  /** 右侧那一栏：三态 + 一条正文。**不拿空内容顶替**——每一种「读不出来」都有自己的话 */
  const renderPreview = (): ReactNode => {
    if (fileLoading) return <Skeleton active />;
    if (fileError !== undefined) {
      return <Alert type="error" showIcon title="这个文件读不出来" description={messageOf(fileError)} />;
    }
    if (file === undefined) return null;
    // 整份文件按 markdown 渲染（非流式：磁盘上那一份已经收尾）；frontmatter 先包成 yaml 代码块，
    // 否则收尾那条 `---` 会把它按 setext 标题吃掉（见 `fenceFrontmatter` 的文件头）
    return <XMarkdownText text={fenceFrontmatter(file.text)} open={false} />;
  };

  return (
    <Drawer
      // 标题只说这是哪一条：路径在正文第一块（`Descriptions`）里
      title={skill === null ? '技能' : `技能：${skill.name}`}
      placement="right"
      size={WIDE_DRAWER_SIZE}
      open={open}
      onClose={onClose}
      // 关掉即卸载：`open === false` 时正文一个节点都不在 DOM 里（不留上一条的内容）
      destroyOnHidden
      mask={{ enabled: true, closable: true }}
      styles={DRAWER_SEMANTIC_STYLES}
    >
      {skill === null ? null : (
        <Flex
          vertical
          // 高度交给抽屉 body：树那一栏要吃剩余高度，否则 Splitter 只有内容那么高。
          // **这层不带内边距**：Folder 要**紧贴**内容区（抽屉 body 的 `padding` 已置 0），
          // 边距只由「本来就不该贴边的那几块」（不可用说明 / 骨架屏 / 错误态）自己留
          style={{ height: '100%', minHeight: 0 }}
          data-testid="skill-detail-drawer"
        >
          {/* 不可用的原因写在最前面：列表里的红标只能悬停看，抽屉里要能读到整句 */}
          {!skill.ok && (
            <Alert
              type="warning"
              showIcon
              title="这一条现在不可用"
              description={skill.reason ?? ''}
              style={{ margin: token.paddingMD }}
            />
          )}

          {treeLoading ? (
            <Skeleton active style={{ padding: token.paddingMD }} />
          ) : treeError !== undefined ? (
            // 整棵树都列不出来：树与预览一起换成错误态 + 一次重试
            <Alert
              type="error"
              showIcon
              title="技能目录读取失败"
              style={{ margin: token.paddingMD }}
              description={
                <Flex vertical gap={token.marginXS} align="flex-start">
                  <Typography.Text>{messageOf(treeError)}</Typography.Text>
                  <Button size="small" autoInsertSpace={false} onClick={onRetryTree}>
                    重试
                  </Button>
                </Flex>
              }
            />
          ) : tree === undefined ? null : (
            <XFolder
              // 树从技能目录的**内容**开始，不含根那一格技能名：于是树键天然就是「技能内相对路径」
              // （`reference/API.md`），与契约同形、两处不需要互转
              nodes={tree.root.children}
              // 只在没列全时说话；正常情况下树上方不留标题（那是纯噪声）
              title={
                tree.truncated ? <Typography.Text type="warning">这个目录没列全</Typography.Text> : undefined
              }
              // 标题栏那一格给**完整相对路径**：树里只显示叶子名（不重复父目录），
              // 「同名文件分得清」靠这里；复制的是我们自己取到的正文
              previewTitle={
                selectedPath === null ? undefined : { fileName: selectedPath, copyText: file?.text ?? '' }
              }
              selectedPath={selectedPath === null ? null : selectedPath.split('/')}
              onSelectPath={(segments) => onSelectPath(segments.join('/'))}
              preview={renderPreview()}
              empty={
                <EmptyState title="还没选中文件" description="点左边树里的一个文件，这里显示它的内容" />
              }
              style={{ flex: 1, minHeight: 0 }}
            />
          )}
        </Flex>
      )}
    </Drawer>
  );
}
