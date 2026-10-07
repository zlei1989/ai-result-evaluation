'use client';

/**
 * 变更详情：逐文件的「文件名 + diff 正文」列表，滚动时当前文件标题吸顶。
 *
 * 五条口径：
 *   1. **正文惰性渲染**：文件进入视口才调 `renderFileBody`。万级文件变更下这是不卡死的关键——
 *      万级文件的正文在服务端就已经被 256 KB 预算裁掉了，真正会卡的是「一次渲染一万个节点」；
 *   2. **取数不在这里**：本包不调接口（见 index.ts 头注释）。调用方传 `renderFileBody(path)` 进来，
 *      由它为每个文件挂一份自己的订阅——hook 不能按参数循环调用，故「每文件一个组件实例」
 *      是唯一站得住的形状；
 *   3. **吸顶相对 `.ant-drawer-body`**：抽屉内容区 padding 已置 0 且它自己 `overflow: auto`，
 *      故本组件**不再套第二层滚动容器**——滚动容器只有一个，标题才能正确吸顶（spec §7.2.1 ③）；
 *   4. **截断提示是硬要求**（spec §5.5 第 7 步）：文案必须说「评分模型看不到」，
 *      只说「已截断」会让使用者以为只是界面没显示全；
 *   5. 正文用 `react-diff-viewer-continued` 渲染，它要的是**两侧完整正文**而不是 diff 文本，
 *      故先经 `reconstructSides` 还原（理由见 diff-patch.ts 的文件头）。
 */
import { Alert, Empty, Flex, Input, Skeleton, Tag, Typography, theme } from 'antd';
import DiffViewer from 'react-diff-viewer-continued';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RowDiffFile, RowDiffIndex } from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { EmptyState } from '../base/empty-state';
import { languageOf, reconstructSides } from './diff-patch';

export interface DiffViewProps {
  index: RowDiffIndex | undefined;
  /** 由调用方渲染单个文件的正文（ui 包不调接口，故收一个渲染函数而不是取数函数） */
  renderFileBody: (path: string) => ReactNode;
  /** 继续加载下一页索引；undefined = 没有更多 */
  onLoadMore?: () => void;
  /** 实际生效的明暗，透传给 diff 组件的 useDarkTheme */
  dark: boolean;
}

/**
 * 单个文件正文的**受控纯展示件**：加载中 / 出错 / 二进制 / diff 视图四态。
 * 导出它是因为调用方拿到 SWR 结果后需要一个现成的渲染件——
 * 否则每个调用方都要再写一份这四态判断，四份判断必然漂移。
 */
export function DiffFileContent({
  file,
  error,
  isLoading,
  dark,
}: {
  file: RowDiffFile | undefined;
  error: unknown;
  isLoading: boolean;
  dark: boolean;
}): ReactNode {
  if (isLoading) return <Skeleton active paragraph={{ rows: 3 }} data-testid="diff-file-skeleton" />;
  if (error !== null && error !== undefined) {
    return <Alert type="error" showIcon title="这个文件的正文读取失败" description={String(error)} />;
  }
  if (file === undefined) return null;
  if (file.binary) return <Typography.Text type="secondary">二进制文件，没有可显示的文本改动</Typography.Text>;

  return <DiffContentViewer file={file} dark={dark} />;
}

/**
 * 单个文件的 diff 视图。
 *
 * **标题（文件路径）由本组件的吸顶条负责，不交给 diff 组件**（用户口径 2026-09-29）：
 * 组件内部那个头部也是 `position: sticky`，两层吸顶必然互相压——把路径交给它，
 * 下滚时就会与我们的标题条重叠，或者反过来把标题条盖住。
 * 边界很清楚：**标题归我们**（它对每个文件都必须存在，哪怕没有正文可取），
 * **正文归它**。故这里把 `hideSummary` 打开，只留它自己的展开/折叠按钮（`summary`），
 * 路径不再重复出现。
 */
function DiffContentViewer({ file, dark }: { file: RowDiffFile; dark: boolean }): ReactNode {
  const { token } = theme.useToken();
  const sides = useMemo(() => reconstructSides(file.patch), [file.patch]);

  if (sides.oldValue === '' && sides.newValue === '') {
    return <Typography.Text type="secondary">这个文件没有可显示的文本改动</Typography.Text>;
  }

  return (
    // **不限高、不自滚**（用户口径 2026-09-29）：正文随内容自然展开，抽屉里只保留
    // `.ant-drawer-body` 这一条滚动条——正文自己再滚一次就会出现右侧第二条滚动条。
    <DiffViewer
      oldValue={sides.oldValue}
      newValue={sides.newValue}
      splitView={false}
      useDarkTheme={dark}
      // 不折叠未修改行：两侧已按行号对齐补空行，折叠会把对齐关系藏起来
      showDiffOnly={false}
      // 每个文件一个 worker 在几十个文件同时进视口时是纯开销；jsdom 里也没有 worker
      disableWorker
      highlightLanguage={languageOf(file.path)}
      hideSummary
      styles={{
        contentText: { fontFamily: token.fontFamilyCode, fontSize: token.fontSizeSM },
        lineNumber: { fontFamily: token.fontFamilyCode },
        /**
         * **避免横向滚动**（用户口径 2026-09-29）：组件给表格的默认样式里带
         * `minWidth: '1000px'` 与 `overflowX: 'auto'`，而抽屉只有 800px —— 于是必然出现横向滚动条。
         * 这里把最小宽度放开、改成按容器宽度排版；正文本身已是 `pre-wrap` + `lineBreak: anywhere`，
         * 长行会在单元格内折行，所以不需要靠横向滚动来看全。
         */
        diffContainer: { minWidth: 0, width: '100%', tableLayout: 'fixed', overflowX: 'auto' },
      }}
    />
  );
}

/** 一个文件条目：标题吸顶 + 正文（进入视口才渲染） */
function DiffFileSection({
  path,
  insertions,
  deletions,
  untracked,
  hasBody,
  renderFileBody,
}: {
  path: string;
  insertions: number;
  deletions: number;
  untracked: boolean;
  hasBody: boolean;
  renderFileBody: DiffViewProps['renderFileBody'];
}): ReactNode {
  const { token } = theme.useToken();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || visible || !hasBody) return;
    if (typeof IntersectionObserver === 'undefined') {
      // 没有观察者（老浏览器 / 某些测试环境）时退化成「立即渲染」，而不是永远不渲染
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [hasBody, visible]);

  return (
    <div ref={hostRef} data-testid={`diff-file-section-${path}`}>
      <Flex
        align="center"
        justify="space-between"
        gap={8}
        data-testid={`diff-file-title-${path}`}
        style={{
          // 吸顶：相对 .ant-drawer-body 定位。底色必须给，否则正文会从标题下面透过来。
          // **z-index 必须高于 diff 组件自己那个头部（它是 sticky + z-index: 2）**：
          // 它就在本条的下面，同层吸顶时低的那个会被盖住——这正是「文件路径被遮挡」的成因。
          position: 'sticky',
          top: 0,
          zIndex: 3,
          padding: '8px 16px',
          background: token.colorBgElevated,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {/* 路径**不用 Typography/Tag 包裹**（用户口径 2026-09-29）：`EllipsisText` 内部已经是
            一个 `Typography.Text code`，再包一层 `<Typography.Text code>` 会套出两层等宽壳，
            既多一层 DOM 又让省略号的宽度算错。这里直接用它，过长走省略号 + Tooltip 显全量。 */}
        <EllipsisText text={path} monospace />
        <Flex align="center" gap={8} style={{ flexShrink: 0 }}>
          {untracked && <Tag color="green">未跟踪</Tag>}
          {/* 增删行数按 git 惯例上色（2026-10-07 用户口径）：`+N` 绿、`−Y` 红，
              与执行日志事实条里「改动」那一格是同一套视觉语言（见 `agent-log-facts-bar.tsx`）。
              颜色取 antd token，light / dark 都跟着主题走。 */}
          <Typography.Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
            <span style={{ color: token.colorSuccess }}>+{insertions}</span>
            {' '}
            <span style={{ color: token.colorError }}>−{deletions}</span>
          </Typography.Text>
        </Flex>
      </Flex>

      {/*
        正文区**不额外加横向内边距**：diff 表格自带 `minWidth: 1000px` 与 `overflow-x: auto`，
        抽屉只有 800px，外面再套一层 padding 只会把可用的横向空间再削掉一截、让那条横向滚动条更早出现。
        上下留白仍由这里的 padding 提供。
      */}
      <div style={{ padding: '8px 0' }}>
        {!hasBody ? (
          <Typography.Text type="secondary">该文件超出体积上限，未包含在本轮评分输入中</Typography.Text>
        ) : visible ? (
          renderFileBody(path)
        ) : null}
      </div>
    </div>
  );
}

export function DiffView({ index, renderFileBody, onLoadMore, dark }: DiffViewProps): ReactNode {
  const [keyword, setKeyword] = useState('');
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /**
   * `onLoadMore` 走 ref 而不是直接进 effect 依赖：调用方几乎总是传一个**内联箭头函数**
   * （每帧新引用），进依赖会让观察者每帧重建、每次都立即判定「哨兵可见」而反复触发加载——
   * 一个自我维持的加载循环。ref 让订阅只建一次，回调始终取最新那个。
   */
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current?.();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const files = index?.files ?? [];
  const visible = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase();
    if (trimmed === '') return files;
    return files.filter((file) => file.path.toLowerCase().includes(trimmed));
  }, [files, keyword]);

  if (index === undefined) {
    return <Typography.Text type="secondary">正在读取变更…</Typography.Text>;
  }

  return (
    // minHeight 而不是 height：内容短于视口时铺满，长于视口时自然撑开，两种都由 .ant-drawer-body 滚动
    <Flex vertical style={{ minHeight: '100%' }}>
      <Flex vertical gap={8} style={{ padding: '12px 16px' }}>
        {index.truncated && (
          <Alert
            type="warning"
            showIcon
            title={`diff 已按体积上限截断：${index.droppedFiles.length} 个文件未包含，评分模型看不到它们`}
          />
        )}
        {index.droppedFiles.length > 0 && (
          <Typography.Text type="secondary">被丢弃的文件：{index.droppedFiles.join('、')}</Typography.Text>
        )}
        <Flex align="center" justify="space-between" gap={8} wrap>
          <Typography.Text type="secondary">
            共 {index.total} 个文件 · +{index.insertions} −{index.deletions}
          </Typography.Text>
          <Input.Search
            allowClear
            size="small"
            placeholder="按路径过滤"
            style={{ maxWidth: 260 }}
            onChange={(event) => setKeyword(event.target.value)}
            aria-label="按路径过滤"
          />
        </Flex>
        {keyword.trim() !== '' && (
          // 只说「命中几个」会让人以为服务端搜过全部文件——实际只过滤了已加载的这一页
          <Typography.Text type="secondary">
            仅在已加载的 {files.length} 个文件里过滤（共 {index.total} 个）
          </Typography.Text>
        )}
      </Flex>

      {index.total === 0 ? (
        <div style={{ padding: '0 16px 16px' }}>
          <EmptyState title="没有代码改动" description="这一行没有产生任何文件变更" />
        </div>
      ) : visible.length === 0 ? (
        <div style={{ padding: '0 16px 16px' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="已加载的文件里没有匹配项" />
        </div>
      ) : (
        <div>
          {visible.map((file) => (
            <DiffFileSection
              key={file.path}
              path={file.path}
              insertions={file.insertions}
              deletions={file.deletions}
              untracked={file.untracked}
              hasBody={file.hasBody}
              renderFileBody={renderFileBody}
            />
          ))}
        </div>
      )}

      {onLoadMore !== undefined && files.length < index.total && <div ref={sentinelRef} style={{ height: 1 }} />}
    </Flex>
  );
}
