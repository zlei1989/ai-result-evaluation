'use client';

/**
 * 「粘贴 JSON」弹窗：贴进去 → **先看预览**（逐条说清将要发生什么）→ 确认才导入。
 *
 * 五个必须守住的点：
 *   1. **预览与落盘是同一份判定**：预览每一行的「新增 / 覆盖已有 X / 跳过 / 不导入+原因」
 *      全部来自 `parseMcpPaste`（契约里的纯函数），组件这一层不自己再判一次 ——
 *      两处各判一次的话，「预览说覆盖、落盘是新增」这类偏差只能靠肉眼发现。
 *   2. **一次原子落盘**：确认时组件交出的是**算好的整份 map**（`applyMcpPaste` 的结果），
 *      调用方拿它走一次 `PUT /api/settings`；组件自己不调接口、不碰 message。
 *   3. **同名默认覆盖、逐行可切跳过**：默认合并（覆盖同名），每一行都给一个「跳过」开关；
 *      「先清空现有条目再导入」是默认**关**的勾选框（它删的是用户已有的配置，不能是默认行为）。
 *   4. **名字只有裸单项可改**：map 形状里名字住在键上（改键就是改名），裸单项的名字是猜的，
 *      故只有它给输入框；名字为空、或与本批内另一台净化后撞名 ⇒ 那一行**不许导入**并提示改名
 *      （判据在 `mcpPasteNameIssue` 里，与契约同一把尺子）。
 *   5. 中文文案**全部显式给出**、按钮一律 `autoInsertSpace={false}`（antd 默认给两个汉字的标签插空格，
 *      渲染成 `导 入`，可访问名随之不再等于文案）。
 *
 * 为什么草稿要连**文本**一起存（`drafts.text`）：预览里的「跳过 / 改名」是逐行决定，
 * 文本一换，上一批决定就不该继续生效（上一份配置里的 `context7` 与这一份里的 `context7`
 * 未必是同一件事）。存在一起、读的时候对不上就当空，比用一个 effect 事后清更稳：
 * effect 会在「文本已换、决定还没清」的那一帧里画出错的预览。
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Checkbox, Flex, Input, Modal, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import {
  MCP_PASTE_SHAPE_EXAMPLES,
  applyMcpPaste,
  mcpPasteNameIssue,
  parseMcpPaste,
  type McpServerConfig,
  type McpServers,
} from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
// 复用表格那一列的同一份口径（http 显 URL、stdio 显 `command args…`）：预览与落盘后的表格
// 对同一条给出两种写法的话，用户会以为自己看错了
import { endpointText } from './mcp-server-table';

export interface McpPasteModalProps {
  open: boolean;
  /** 现有集合：预览里判「新增 / 覆盖已有」，确认时算最终那份 map */
  servers: McpServers;
  /** 落盘在途（页面把 `isUpdating` 传进来）：确认按钮转圈并禁用 */
  saving: boolean;
  /** 确认导入：交出的是一份**算好的整份 map**（调用方一次 PUT 落盘，不做第二次合并） */
  onImport: (servers: McpServers) => void;
  onCancel: () => void;
}

/** 弹窗宽度：预览表五列（名称 / 传输 / 端点或命令 / 处置 / 被丢字段）要放得下，窄了处置列只能读半句 */
export const MCP_PASTE_MODAL_WIDTH = 880;

/** 预览表的最大高度：超过就表内滚动（100 条上限时，整页跟着滚会让底部的勾选框滑出视野） */
const PREVIEW_MAX_HEIGHT = 320;

/** 用户对某一行的改动（按行 id 存）：`skipped` 是逐行的「跳过」，`name` 只有裸单项会用到 */
interface RowDecision {
  skipped?: boolean;
  name?: string;
}

/** 预览表里的一行：`rejected` 行没有条目，只有一个中文原因 */
interface PreviewRow {
  id: string;
  kind: 'entry' | 'rejected';
  name: string;
  entry?: McpServerConfig;
  transport?: McpServerConfig['transport'];
  droppedFields: string[];
  renamable: boolean;
  skipped: boolean;
  /** 处置标签的文字与颜色（Tag 的 `color` 直接用 antd 的预设名） */
  actionText: string;
  actionColor: string;
  /** 不导入的中文原因（含「名字为空 / 重名」这类改名问题）；null = 这一行会导入 */
  blockedReason: string | null;
}

export function McpPasteModal(props: McpPasteModalProps): ReactNode {
  const { open, servers, saving, onImport, onCancel } = props;
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<{ text: string; decisions: Record<string, RowDecision> }>({
    text: '',
    decisions: {},
  });
  const [clearFirst, setClearFirst] = useState(false);

  // 文本对不上就整批作废（见文件头最后一段：不用 effect，避免画出「新文本 + 旧决定」的那一帧）
  const decisions = drafts.text === text ? drafts.decisions : {};

  const parsed = useMemo(() => parseMcpPaste(text, servers), [text, servers]);
  const existingNames = Object.keys(servers);

  const patchDecision = (id: string, patch: RowDecision): void => {
    setDrafts({ text, decisions: { ...decisions, [id]: { ...decisions[id], ...patch } } });
  };

  /** 名字判据的**唯一**落点：其它行（不含被跳过的）的名字就是「已被占用」的那一份 */
  const importableNames = parsed.entries
    .map((item) => ({ id: item.name, name: decisions[item.name]?.name ?? item.name, skipped: decisions[item.name]?.skipped ?? false }))
    .filter((row) => !row.skipped);

  const nameIssueOf = (id: string, name: string): string | null =>
    mcpPasteNameIssue(
      name,
      importableNames.filter((row) => row.id !== id).map((row) => row.name),
    );

  const rows: PreviewRow[] = [
    ...parsed.entries.map((item): PreviewRow => {
      const decision = decisions[item.name];
      const name = decision?.name ?? item.name;
      const skipped = decision?.skipped ?? false;
      // 名字问题只对「将要导入」的行算：被跳过的行不占名字，也不该因为名字而报错
      const issue = skipped ? null : nameIssueOf(item.name, name);
      const overwrite = servers[name] !== undefined;
      return {
        id: item.name,
        kind: 'entry',
        name,
        entry: item.entry,
        transport: item.entry.transport,
        droppedFields: item.droppedFields,
        renamable: item.renamable,
        skipped,
        actionText: skipped ? '跳过' : issue !== null ? '不导入' : clearFirst || !overwrite ? '新增' : `覆盖已有 ${name}`,
        actionColor: skipped ? 'default' : issue !== null ? 'red' : overwrite && !clearFirst ? 'gold' : 'green',
        blockedReason: issue,
      };
    }),
    ...parsed.rejected.map(
      (item): PreviewRow => ({
        id: `!${item.name}`,
        kind: 'rejected',
        name: item.name,
        ...(item.transport === undefined ? {} : { transport: item.transport }),
        droppedFields: item.droppedFields,
        renamable: false,
        skipped: false,
        actionText: '不导入',
        actionColor: 'red',
        blockedReason: item.reason,
      }),
    ),
  ];

  // 将要写入的那些行：没被跳过、也没有名字问题。计数与落盘用的是**同一个**数组
  const importRows = rows
    .filter((row): row is PreviewRow & { entry: McpServerConfig } => row.kind === 'entry' && row.entry !== undefined)
    .filter((row) => !row.skipped && row.blockedReason === null)
    .map((row) => ({ name: row.name, entry: row.entry }));
  // 勾了「先清空」就没有「覆盖」可言：先删光再写进去，标成覆盖会是假话
  const overwriteCount = clearFirst ? 0 : importRows.filter((row) => servers[row.name] !== undefined).length;

  const confirm = (): void => {
    onImport(applyMcpPaste(servers, importRows, clearFirst));
  };

  const columns: TableColumnsType<PreviewRow> = [
    {
      title: '名称',
      key: 'name',
      width: 190,
      render: (_value, row) =>
        // 只有裸单项的名字是「猜」的（map 形状里名字住在键上，改键就是改名），故只有它给输入框
        row.renamable ? (
          <Input
            size="small"
            value={row.name}
            aria-label="名称"
            status={row.blockedReason === null ? undefined : 'error'}
            onChange={(event) => patchDecision(row.id, { name: event.target.value })}
          />
        ) : (
          <EllipsisText text={row.name} />
        ),
    },
    {
      title: '传输',
      key: 'transport',
      width: 90,
      render: (_value, row) =>
        row.transport === undefined ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Tag color={row.transport === 'http' ? 'blue' : 'purple'}>{row.transport}</Tag>
        ),
    },
    {
      title: '端点或命令',
      key: 'endpoint',
      render: (_value, row) =>
        row.entry === undefined ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <EllipsisText text={endpointText(row.entry)} />
        ),
    },
    {
      title: '处置',
      key: 'action',
      width: 240,
      render: (_value, row) => (
        <Flex vertical gap={4}>
          <Flex gap={8} align="center">
            <Tag color={row.actionColor}>{row.actionText}</Tag>
            {row.kind === 'entry' && (
              // 逐行可切跳过（默认关）：勾上之后这一行既不新增也不覆盖，名字也不占位
              <Flex gap={4} align="center">
                <Typography.Text type="secondary">跳过</Typography.Text>
                <Switch
                  size="small"
                  checked={row.skipped}
                  aria-label={`跳过 ${row.name}`}
                  onChange={(checked) => patchDecision(row.id, { skipped: checked })}
                />
              </Flex>
            )}
          </Flex>
          {row.blockedReason !== null && <Typography.Text type="danger">{row.blockedReason}</Typography.Text>}
        </Flex>
      ),
    },
    {
      title: '被丢字段',
      key: 'dropped',
      width: 170,
      render: (_value, row) =>
        row.droppedFields.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <EllipsisText text={row.droppedFields.join('、')} />
        ),
    },
  ];

  return (
    <Modal
      open={open}
      title="粘贴 MCP 配置"
      width={MCP_PASTE_MODAL_WIDTH}
      okText={overwriteCount > 0 ? `导入 ${importRows.length} 台（覆盖 ${overwriteCount}）` : `导入 ${importRows.length} 台`}
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ autoInsertSpace: false, disabled: parsed.error !== undefined || importRows.length === 0 }}
      cancelButtonProps={{ autoInsertSpace: false }}
      onOk={confirm}
      onCancel={onCancel}
      // 关掉即丢弃：留着上次那段文本，用户会以为已经导入过了（与 RubricRecognizeModal 同一条口径）
      destroyOnHidden
      afterClose={() => {
        setText('');
        setDrafts({ text: '', decisions: {} });
        setClearFirst(false);
      }}
    >
      <Flex vertical gap={12}>
        <Typography.Text type="secondary">
          认三种形状：{'"mcpServers"'} 信封（Claude / Cursor）、{'"servers"'} 信封（VS Code，{'inputs'} 会被丢掉）、
          单台服务器；JSONC 的注释与尾逗号也认。贴进来先看预览，点「导入」才写入。
        </Typography.Text>
        <Input.TextArea
          rows={6}
          value={text}
          aria-label="粘贴内容"
          data-testid="mcp-paste-text"
          placeholder={'如 { "mcpServers": { "context7": { "url": "https://mcp.context7.com/mcp" } } }'}
          onChange={(event) => setText(event.target.value)}
        />

        {parsed.error !== undefined && (
          <Alert
            type="error"
            showIcon
            title="认不出这段内容"
            description={
              <Flex vertical gap={4}>
                <Typography.Text>{parsed.error.message}</Typography.Text>
                {/* 「无法识别」时把四类形状摆出来：用户要照着它自己判断该贴哪一份 */}
                {parsed.error.topLevelKeys !== undefined && (
                  <Typography.Text type="secondary">能贴的形状（四选一）：</Typography.Text>
                )}
                {parsed.error.topLevelKeys !== undefined &&
                  MCP_PASTE_SHAPE_EXAMPLES.map((example) => (
                    <Typography.Text key={example} code data-testid="mcp-paste-shape-example">
                      {example}
                    </Typography.Text>
                  ))}
              </Flex>
            }
          />
        )}

        {/* 整份级别被丢掉的字段（信封的兄弟键）：不点名的话，用户会以为 `inputs` 也一起导进来了 */}
        {parsed.droppedFields.length > 0 && (
          <Alert
            type="warning"
            showIcon
            title={`整份丢掉了这些字段：${parsed.droppedFields.join('、')}`}
            description="它们是信封自己的字段（如 VS Code 的 inputs），不会写进 MCP 配置。"
          />
        )}

        {rows.length > 0 && (
          <Table<PreviewRow>
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={rows}
            pagination={false}
            data-testid="mcp-paste-preview"
            scroll={{ y: PREVIEW_MAX_HEIGHT }}
          />
        )}

        {rows.length > 0 && (
          <Checkbox checked={clearFirst} onChange={(event) => setClearFirst(event.target.checked)}>
            {existingNames.length > 0
              ? `先清空现有条目再导入（会删掉现有 ${existingNames.length} 台）`
              : '先清空现有条目再导入'}
          </Checkbox>
        )}
      </Flex>
    </Modal>
  );
}
