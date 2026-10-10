'use client';

/**
 * 环境抽屉（L0 渲染件，但由 `agent-log` 内部渲染）：智能体跑在什么之上。
 *
 * 五条口径：
 *   1. **受控**：吃 `open` / `onOpenChange`，自己不持开合态——这样它能被单独挂到任何地方
 *      （例如设置页的「本机环境」区块），换交互形态时只换「谁渲染 `open`」；
 *   2. **不硬编码任何组名**：分组名、组顺序、每组的条目全部由数据层给
 *      （`EnvGroup.title` / 数组顺序），新增一层不必改本文件；
 *   3. **缺失不隐藏**：`present: false` 的条目渲染成「标签 · 原因」，四句原因互不相同——
 *      藏起来就把「这家结构上就没有」与「我们没接」说成了同一件事；
 *   4. **不内套第二层滚动区**：长文本交给抽屉自己的 body 滚，否则这一个抽屉里会出现两条滚动条；
 *   5. **本件不写 `push`**：推动量归**被推开的主抽屉**那一侧
 *      （`MAIN_DRAWER_PUSH`，见 `base/drawer-geometry.ts`）。把这里写成
 *      `push={{ distance: 100 }}` 也不会改变主抽屉的位移（**仍是 -360**）⇒ 这一格完全空转，
 *      留着只会让读的人以为推动是它干的（`NestedDrawer` 那一侧同此口径）。
 *
 * 「能力声明」一节回答的是**这一次我们能拿到什么**（五格各自带等级与原因），
 * 与被下发了什么是同一抽屉里并列的两件事，且四句原因与下面 `EnvItemRow` 的 `missing` 共用
 * `MISSING_REASON_LABELS` 一张表——放两处才不会出现「同一个原因两种说法」。
 * 它是**可选**的：不给就整段不出现（宁可不显示，也不编一份「都支持」出来）。
 */
import { Alert, Button, Collapse, Descriptions, Drawer, Flex, Skeleton, Tag, Typography, theme } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { AgentEnvironment, EnvGroup, EnvItem, Loadable, MessageCapabilityMap } from './types';
import { MISSING_REASON_LABELS } from './types';
import { CapabilityNotes } from './capability-notes';
import { MonoText } from '../../base/mono-text';
import { formatBytes } from '../../base/format';
import { NESTED_DRAWER_SIZE } from '../../base/drawer-geometry';

export interface AgentEnvironmentDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  environment: Loadable<AgentEnvironment> | undefined;
  onRetry?(): void;
  /**
   * 能力声明（`LogNode.capability`）。**可选**：不给就整段不出现——
   * 「没采到声明」与「声明说都支持」在界面上必须长得不一样。
   */
  capability?: MessageCapabilityMap;
  /** 能力成立的**前提**（路由 / 模型 / 开关）；空数组 = 无条件成立 */
  capabilityNotes?: readonly string[];
}

/** 组来源的四个中文标签：它回答「这条要求是谁下发的」，也正是分开展示的全部理由 */
const SOURCE_LABELS: Record<EnvGroup['source'], string> = {
  user: '用户层',
  vendor: '厂商系统层',
  project: '运行配置',
  observed: '实测统计',
};

/**
 * 复制到剪贴板。**失败静默**：这是只读的排查视图，弹一个「复制失败」的提示比没复制上更打扰；
 * 环境里没有剪贴板 API（非安全上下文、jsdom）时同样静默跳过。
 */
function copyToClipboard(text: string): void {
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) return;
  void clipboard.writeText(text).catch(() => undefined);
}

/** `Loadable` 的 `error` 是 `unknown`：能给一句人话就给，给不出就如实说「未知错误」 */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '未知错误';
}

/** 摘要：智能体 / 模型 / 思考强度 / 供应商 / 接口地址 / 工作区 / 基线提交 */
function summaryItems(summary: AgentEnvironment['summary']): { key: string; label: string; children: ReactNode }[] {
  return [
    /**
     * 「智能体」那一格画的是数据层给的**显示名**（`summary.agentLabel`），不是 kind。
     *
     * 为什么不由本件查 `AGENT_LABELS`：那一查就是 L0 持有「厂商 → 文案」的表
     * ——`agent-log-layering.test.ts` 的 (e) 条**当场红**，而那条纪律的理由是实的：
     * 文案与厂商名的对应关系属于数据层（同 `facts.domain` / `effortPlaceholder`），
     * 组件只摆版 ⇒ 换一家、改一个显示名都不必动渲染件。
     */
    { key: 'agentLabel', label: '智能体', children: summary.agentLabel },
    { key: 'modelId', label: '模型', children: summary.modelId },
    // `effort === null` ⇒「未指定」：不显示空白（空白会被读成「这一格没有这个概念」）；
    // 档位照上游词汇原样写（关闭档也不加工，与行卡片上那个 `off` 同一份）
    { key: 'effort', label: '思考强度', children: summary.effort === null ? '未指定' : summary.effort },
    { key: 'providerName', label: '供应商', children: summary.providerName },
    { key: 'baseUrl', label: '接口地址', children: summary.baseUrl },
    { key: 'workspaceBase', label: '工作区', children: summary.workspaceBase },
    { key: 'baselineCommit', label: '基线提交', children: summary.baselineCommit },
  ];
}

/** 一条环境信息：标签 + 正文（逐字原文）+ 截断提示 + 复制按钮 */
function EnvItemRow({ item }: { item: EnvItem }): ReactNode {
  const { token } = theme.useToken();

  // 「这一格没有」必须带原因，且**不隐藏**（四句原因见 MISSING_REASON_LABELS）
  if (!item.present) {
    return (
      <Typography.Text type="secondary">
        {item.label} · {MISSING_REASON_LABELS[item.missing]}
      </Typography.Text>
    );
  }

  const copyPath = item.copyPath;

  return (
    <Flex vertical gap={token.marginXXS}>
      <Typography.Text strong>{item.label}</Typography.Text>
      {/* 不传 `maxHeight`：长文本交给抽屉 body 滚，这里不再开第二个滚动区 */}
      <MonoText text={item.text} />
      <Flex align="center" gap={token.marginXS} wrap>
        {item.truncated !== null && (
          <>
            <Typography.Text type="secondary">已截断（原文 {formatBytes(item.truncated.bytes)}）</Typography.Text>
            <Typography.Text type="secondary">{item.truncated.reason}</Typography.Text>
            {/* 复制的是**我们手上这份原文**：被上限截掉的部分 UI 并没有，不假装能复制到 */}
            <Button size="small" autoInsertSpace={false} icon={<CopyOutlined aria-hidden />} onClick={() => copyToClipboard(item.text)}>
              复制全部
            </Button>
          </>
        )}
        {/* 约定路径（调试时最常用的是把完整提示词粘到别处）。先取进常量：闭包里属性收窄会失效 */}
        {copyPath !== undefined && (
          <Button size="small" autoInsertSpace={false} icon={<CopyOutlined aria-hidden />} onClick={() => copyToClipboard(copyPath)}>
            复制
          </Button>
        )}
      </Flex>
    </Flex>
  );
}

export function AgentEnvironmentDrawer({
  open,
  onOpenChange,
  environment,
  onRetry,
  capability,
  capabilityNotes,
}: AgentEnvironmentDrawerProps): ReactNode {
  const { token } = theme.useToken();
  /**
   * 能力声明那一节是否出现：**两个条件缺一不可**——有声明，且至少有一个维度。
   * 空对象（`{}`）与 `undefined` 同一处置：画一个没有行的标题只会让人以为「五格都是空的」。
   */
  const showCapability = capability !== undefined && Object.keys(capability).length > 0;

  return (
    <Drawer
      title="环境信息"
      placement="right"
      // ⚠️ antd 6 已废弃 `width`，几何走 `size`（CSS 表达式可以直接给）
      // 宽度与二级抽屉同一档（`NESTED_DRAWER_SIZE`，`min(60vw, 900px)`）：它本来就是「从主抽屉里
      // 再推出来的一层」，更窄的宽度会让长工具名与工作区路径全被折行
      size={NESTED_DRAWER_SIZE}
      open={open}
      onClose={() => onOpenChange(false)}
      destroyOnHidden
      // `maskClosable` 已废弃：点遮罩关闭走 `mask.closable`
      mask={{ enabled: true, closable: true }}
      styles={{ wrapper: { maxWidth: '100vw' }, body: { padding: 0 } }}
    >
      <Flex vertical gap={token.paddingMD} style={{ padding: token.paddingMD }} data-testid="agent-environment-drawer">
        {/**
          * 能力声明**在三态之外**：它的来源是**节点**（`LogNode.capability`，随模型按值给），
          * 与环境信息那次取数的成败无关。放进 ready 那一支的话，「环境信息没提供」会把一份
          * 明明拿到了的声明一起藏掉——而它恰恰是解释「为什么这里没内容」的那句话。
          */}
        {showCapability && (
          <Flex vertical gap={token.marginXS}>
            <Typography.Text strong>能力声明</Typography.Text>
            {/* 维度名与顺序由数据层给：本件按 `capability` 的插入顺序渲染，未知维度原样显示 */}
            <CapabilityNotes capability={capability} notes={capabilityNotes ?? []} />
          </Flex>
        )}
        {environment === undefined ? (
          // 「没提供」与「读取中」是两件事：一直转圈会把「这次没采到」说成「还在取」
          <Typography.Text type="secondary">未提供</Typography.Text>
        ) : environment.status === 'loading' ? (
          <Skeleton active />
        ) : environment.status === 'error' ? (
          <Flex vertical gap={token.marginSM}>
            {/* antd 6 的 `Alert` 用 `title`（`message` 已废弃：控制台会打 deprecation 警告） */}
            <Alert type="error" showIcon title="环境信息读取失败" description={errorText(environment.error)} />
            {/* 不给重试回调就不渲染按钮：一个点了没反应的按钮比没有按钮更糟 */}
            {onRetry !== undefined && (
              <Button size="small" autoInsertSpace={false} onClick={onRetry} style={{ alignSelf: 'flex-start' }}>
                重试
              </Button>
            )}
          </Flex>
        ) : (
          <>
            <Descriptions size="small" column={1} items={summaryItems(environment.data.summary)} />
            <Collapse
              // 组名与分组顺序都由数据层给；默认全开，因为打开这个抽屉的人本来就是来看事实的
              defaultActiveKey={environment.data.groups.map((group) => group.id)}
              items={environment.data.groups.map((group) => ({
                key: group.id,
                label: (
                  <Flex align="center" gap={token.marginXS}>
                    <Typography.Text>{group.title}</Typography.Text>
                    <Tag>{SOURCE_LABELS[group.source]}</Tag>
                  </Flex>
                ),
                children: (
                  <Flex vertical gap={token.marginSM}>
                    {group.items.map((item) => (
                      <EnvItemRow key={item.id} item={item} />
                    ))}
                  </Flex>
                ),
              }))}
            />
          </>
        )}
      </Flex>
    </Drawer>
  );
}
