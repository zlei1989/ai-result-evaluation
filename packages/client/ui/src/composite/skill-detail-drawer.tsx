'use client';

/**
 * 技能正文预览抽屉：上半是 `SKILL.md` 的 frontmatter（**逐字**、等宽），下半是正文渲染出来的 markdown。
 * 纯展示：正文由调用方（页面）取好递进来，本件不调接口。
 *
 * 六个必须守住的点：
 *   1. **frontmatter 不解析成字段**：界面上摆一份解析结果、文件里写着另一份，就是第二真相；
 *      原文可核才是这一格的价值（字段解析只发生在服务端的准入判定里）；
 *   2. **正文交给 `MarkdownText`**（`react-markdown` + `remark-gfm`）：不引新依赖、**不引 `rehype-raw`**
 *      ⇒ `SKILL.md` 里的原始 HTML **一律转义成文本**。它是外部输入（可能随被测仓库克隆进来），
 *      这一条正是要的；
 *   3. **不做「看原文」切换**：渲染的是**同一份文件**（不是重排的字段），frontmatter 已逐字可见，
 *      围栏代码块在 `MarkdownText` 里等宽不折行；要看语法标记就打开文件——顶部留路径正是为这个；
 *   4. **顶部三个只读事实**：名称 / 路径 / 大小（体积是「不设上限」那条决定的缓解手段）。
 *      大小**算不出就写「未知」**：拿 0 顶替会让人以为这条技能是空的；
 *   5. **不可用条目也打得开**：抽屉照旧给三个事实 + 中文原因，正文那一格再说明为什么读不出来
 *      （「缺 SKILL.md」这类结论要能在点开之后看到，而不是只能悬停标签）；
 *   6. **几何走共享常量**：宽度与语义槽样式取自 `drawer-geometry`（`body.padding` 已置 0，
 *      内边距由内容自己按主题 token 给）。
 */
import { Alert, Descriptions, Drawer, Flex, Skeleton, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import type { SkillEntry, SkillFile } from '@aieval/contracts';
import { DRAWER_SEMANTIC_STYLES, WIDE_DRAWER_SIZE } from '../base/drawer-geometry';
import { EllipsisText } from '../base/ellipsis-text';
import { formatBytes } from '../base/format';
import { MarkdownText } from '../base/markdown-text';
import { MonoText } from '../base/mono-text';

export interface SkillDetailDrawerProps {
  open: boolean;
  /** 被打开的那一条；null = 没选中（抽屉关着，或列表刷新后目标已不在） */
  skill: SkillEntry | null;
  /** 取到的 `SKILL.md` 两半；undefined = 还没取到（配合 `loading` / `error` 分三态） */
  file: SkillFile | undefined;
  /** 读取失败的原因（服务端的 `ServiceError`，message 已是可直接展示的中文） */
  error: unknown;
  loading: boolean;
  onClose: () => void;
}

export function SkillDetailDrawer({
  open,
  skill,
  file,
  error,
  loading,
  onClose,
}: SkillDetailDrawerProps): ReactNode {
  const { token } = theme.useToken();

  return (
    <Drawer
      // 标题只说这是哪一条：路径与大小在正文第一块（`Descriptions`）里
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
          gap={token.paddingMD}
          style={{ padding: token.paddingMD }}
          data-testid="skill-detail-drawer"
        >
          {/* 三个只读事实：名称 / 路径 / 大小。大小**缺席写「未知」**，不拿 0 顶替 */}
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'name', label: '名称', children: <Typography.Text strong>{skill.name}</Typography.Text> },
              { key: 'dir', label: '路径', children: <EllipsisText text={skill.dir} monospace /> },
              {
                key: 'size',
                label: '大小',
                children: (
                  <Typography.Text>
                    {skill.sizeBytes === undefined ? '未知' : formatBytes(skill.sizeBytes)}
                  </Typography.Text>
                ),
              },
            ]}
          />
          {/* 不可用的原因写在事实下方：标签上的 Tooltip 只能悬停看，抽屉里要能读到整句 */}
          {!skill.ok && (
            <Alert type="warning" showIcon title="这一条现在不可用" description={skill.reason ?? ''} />
          )}

          {loading ? (
            <Skeleton active />
          ) : error !== undefined ? (
            <Alert
              type="error"
              showIcon
              title="SKILL.md 读取失败"
              description={error instanceof Error ? error.message : String(error)}
            />
          ) : file === undefined ? null : (
            <Flex vertical gap={token.paddingMD}>
              <Flex vertical gap={token.marginXS}>
                <Typography.Text type="secondary">frontmatter（原文）</Typography.Text>
                {file.frontmatter === null ? (
                  <Typography.Text type="secondary">这个文件没有 frontmatter</Typography.Text>
                ) : (
                  // 逐字、等宽：与文件里的那几行一字不差（`MonoText` 走 antd 的等宽字体 token）
                  <MonoText text={file.frontmatter} dataTestId="skill-frontmatter" />
                )}
              </Flex>
              <MarkdownText text={file.body} />
            </Flex>
          )}
        </Flex>
      )}
    </Drawer>
  );
}
