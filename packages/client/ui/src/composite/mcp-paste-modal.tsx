'use client';

/**
 * 「粘贴 JSON」弹窗：贴进去 → **先看预览**（逐条说清将要发生什么）→ 确认才导入。
 *
 * 五个必须守住的点：
 *   1. **预览与落盘是同一份判定**：预览每一行的「新增 / 覆盖已有 X / 跳过 / 不导入+原因」
 *      全部来自 `parseMcpPaste`（契约里的纯函数），组件这一层不自己再判一次 ——
 *      两处各判一次的话，「预览说覆盖、落盘是新增」这类偏差只能靠肉眼发现。
 *   2. **一次原子落盘**：确认时组件交出的是**算好的整份 map**（`applyMcpPaste` 的结果），
 *      调用方拿它走一次 `PUT /api/settings`；组件自己不调接口、不碰提示通道。
 *   3. **同名默认覆盖、逐行可切跳过**：默认合并（覆盖同名），每一行都给一个「跳过」开关；
 *      「先清空现有条目再导入」是默认**关**的勾选框（它删的是用户已有的配置，不能是默认行为）。
 *   4. **名字只有裸单项可改**：map 形状里名字住在键上（改键就是改名），裸单项的名字是猜的，
 *      故只有它给输入框；名字为空、或与本批内另一台净化后撞名 ⇒ 那一行**不许导入**并提示改名。
 *   5. 中文文案**全部显式给出**，可访问名与可见文案逐字一致。
 *
 * 解析失败那句话的**去向**：弹窗里保留完整诊断（原因 + 四类形状示例，用户要照着它改），
 * 同时经 `onParseError` 把**同一句原文**交给调用方（页面接到 `toast.error`）。
 * 组件不认识 toast —— 提示通道由调用方注入，文案一个字节都不改写（用户拿报错原文才搜得到）。
 *
 * 为什么草稿要连**文本**一起存（`drafts.text`）：预览里的「跳过 / 改名」是逐行决定，
 * 文本一换，上一批决定就不该继续生效。存在一起、读的时候对不上就当空，比用一个 effect
 * 事后清更稳：effect 会在「文本已换、决定还没清」的那一帧里画出错的预览。
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  MCP_PASTE_SHAPE_EXAMPLES,
  applyMcpPaste,
  mcpPasteNameIssue,
  parseMcpPaste,
  type McpServerConfig,
  type McpServers,
} from '@aieval/contracts';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { DataTable, type DataTableColumn } from '../base/data-table';
import { Textarea } from '../components/ui/textarea';
import { SettingsEllipsis } from './settings-ellipsis';
// 复用表格那一列的同一份口径（http 显 URL、stdio 显 `command args…`）：预览与落盘后的表格
// 对同一条给出两种写法的话，用户会以为自己看错了
import { endpointText } from './mcp-server-table';
import { SettingsAlert } from './settings-alert';

export interface McpPasteModalProps {
  open: boolean;
  /** 现有集合：预览里判「新增 / 覆盖已有」，确认时算最终那份 map */
  servers: McpServers;
  /** 落盘在途（页面把 `isUpdating` 传进来）：确认按钮转圈并禁用 */
  saving: boolean;
  /** 确认导入：交出的是一份**算好的整份 map**（调用方一次 PUT 落盘，不做第二次合并） */
  onImport: (servers: McpServers) => void;
  onCancel: () => void;
  /**
   * 整份解析失败时把**原文**交给调用方（页面接 `toast.error`）。
   * 只在错误文案变化时调用一次：用户每敲一个字符都弹一条 toast 会比错误本身更烦。
   */
  onParseError?: (message: string) => void;
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
  /** 处置标签的文字与配色（语义色由 `actionTone` 决定） */
  actionText: string;
  actionTone: 'muted' | 'destructive' | 'warning' | 'success';
  /** 不导入的中文原因（含「名字为空 / 重名」这类改名问题）；null = 这一行会导入 */
  blockedReason: string | null;
}

/** 处置标签的语义配色：四种处置在表里必须一眼可分 */
const ACTION_CLASSES: Record<PreviewRow['actionTone'], string> = {
  muted: 'border-border bg-muted text-muted-foreground',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  success: 'border-success/30 bg-success/10 text-success',
};

export function McpPasteModal(props: McpPasteModalProps): ReactNode {
  const { open, servers, saving, onImport, onCancel, onParseError } = props;
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

  /**
   * 解析失败的原文转交给调用方：只在**文案变化**时交一次。
   * 依赖里是 `parsed.error?.message` 而不是整个 `parsed`（后者每次 render 都是新对象，
   * 会让同一条错误重复弹）。
   */
  const parseErrorMessage = parsed.error?.message;
  useEffect(() => {
    if (parseErrorMessage !== undefined) onParseError?.(parseErrorMessage);
  }, [parseErrorMessage, onParseError]);

  // 关掉即丢弃：留着上次那段文本，用户会以为已经导入过了
  useEffect(() => {
    if (open) return;
    setText('');
    setDrafts({ text: '', decisions: {} });
    setClearFirst(false);
  }, [open]);

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
      const actionTone: PreviewRow['actionTone'] = skipped
        ? 'muted'
        : issue !== null
          ? 'destructive'
          : clearFirst || !overwrite
            ? 'success'
            : 'warning';
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
        actionTone,
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
        actionTone: 'destructive',
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

  /**
   * 五列定义：名称 / 传输 / 端点或命令 / 处置 / 被丢字段。
   * 这张预览表在弹窗内滚动（`viewportHeight=320`），行高由「处置」列里的两行内容决定。
   */
  const columns: DataTableColumn<PreviewRow>[] = [
    {
      id: 'name',
      header: '名称',
      accessorKey: 'name',
      size: 190,
      cell: ({ row }) =>
        // 只有裸单项的名字是「猜」的（map 形状里名字住在键上，改键就是改名），
        // 故只有它给输入框
        row.original.renamable ? (
          <Input
            value={row.original.name}
            aria-label="名称"
            aria-invalid={row.original.blockedReason !== null}
            className={row.original.blockedReason === null ? undefined : 'border-destructive'}
            onChange={(event) => patchDecision(row.original.id, { name: event.target.value })}
          />
        ) : (
          <SettingsEllipsis text={row.original.name} />
        ),
    },
    {
      id: 'transport',
      header: '传输',
      accessorFn: (row) => row.transport,
      size: 90,
      cell: ({ row }) =>
        row.original.transport === undefined ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          <Badge
            variant="outline"
            className={
              row.original.transport === 'http'
                ? 'border-info/30 bg-info/10 text-info'
                : 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300'
            }
          >
            {row.original.transport}
          </Badge>
        ),
    },
    {
      id: 'endpoint',
      header: '端点或命令',
      accessorFn: (row) => (row.entry === undefined ? '' : endpointText(row.entry)),
      size: 200,
      cell: ({ row }) =>
        row.original.entry === undefined ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          <SettingsEllipsis text={endpointText(row.original.entry)} />
        ),
    },
    {
      id: 'action',
      header: '处置',
      accessorKey: 'actionText',
      size: 240,
      cell: ({ row }) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={ACTION_CLASSES[row.original.actionTone]}>
              {row.original.actionText}
            </Badge>
            {row.original.kind === 'entry' && (
              // 逐行可切跳过（默认关）：勾上之后这一行既不新增也不覆盖，名字也不占位
              <span className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">跳过</span>
                <Switch
                  size="sm"
                  checked={row.original.skipped}
                  aria-label={`跳过 ${row.original.name}`}
                  onCheckedChange={(checked) => patchDecision(row.original.id, { skipped: checked })}
                />
              </span>
            )}
          </div>
          {row.original.blockedReason !== null && (
            <span className="text-sm text-destructive">{row.original.blockedReason}</span>
          )}
        </div>
      ),
    },
    {
      id: 'droppedFields',
      header: '被丢字段',
      accessorFn: (row) => row.droppedFields.join('、'),
      size: 170,
      cell: ({ row }) =>
        row.original.droppedFields.length === 0 ? (
          <span className="text-sm text-muted-foreground">—</span>
        ) : (
          <SettingsEllipsis text={row.original.droppedFields.join('、')} />
        ),
    },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-[880px]"
        style={{ maxWidth: MCP_PASTE_MODAL_WIDTH }}
        data-testid="mcp-paste-dialog"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>粘贴 MCP 配置</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            认三种形状：{'"mcpServers"'} 外层（Claude / Cursor）、{'"servers"'} 信封（VS Code，{'inputs'} 会被丢掉）、
            单台服务器；JSONC 的注释与尾逗号也认。贴进来先看预览，点「导入」才写入。
          </p>
          <Textarea
            rows={6}
            value={text}
            aria-label="粘贴内容"
            data-testid="mcp-paste-text"
            placeholder={'如 { "mcpServers": { "context7": { "url": "https://mcp.context7.com/mcp" } } }'}
            onChange={(event) => setText(event.target.value)}
          />

          {parsed.error !== undefined && (
            <SettingsAlert tone="error" title="认不出这段内容">
              <div className="flex flex-col gap-1">
                <p className="text-sm">{parsed.error.message}</p>
                {/* 「无法识别」时把四类形状摆出来：用户要照着它自己判断该贴哪一份 */}
                {parsed.error.topLevelKeys !== undefined && (
                  <p className="text-sm text-muted-foreground">能贴的形状（四选一）：</p>
                )}
                {parsed.error.topLevelKeys !== undefined &&
                  MCP_PASTE_SHAPE_EXAMPLES.map((example) => (
                    <code
                      key={example}
                      className="block rounded bg-muted px-1.5 py-1 font-mono text-xs whitespace-pre-wrap"
                      data-testid="mcp-paste-shape-example"
                    >
                      {example}
                    </code>
                  ))}
              </div>
            </SettingsAlert>
          )}

          {/* 整份级别被丢掉的字段（信封的兄弟键）：不点名的话，用户会以为 `inputs` 也一起导进来了 */}
          {parsed.droppedFields.length > 0 && (
            <SettingsAlert
              tone="warning"
              title={`整份丢掉了这些字段：${parsed.droppedFields.join('、')}`}
              description="它们是外层容器自己的字段（如 VS Code 的 inputs），不会写进 MCP 配置。"
            />
          )}

          {rows.length > 0 && (
            <div
              data-testid="mcp-paste-preview"
              className="w-full rounded-lg border"
            >
              <DataTable
                columns={columns}
                data={rows}
                rowKey={(row) => row.id}
                virtualize={false}
                viewportHeight={320}
                rowHeight={64}
                ariaLabel="粘贴预览"
              />
            </div>
          )}

          {rows.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={clearFirst} onChange={(event) => setClearFirst(event.target.checked)} />
              {existingNames.length > 0
                ? `先清空现有条目再导入（会删掉现有 ${existingNames.length} 台）`
                : '先清空现有条目再导入'}
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button
            data-loading={saving ? 'true' : undefined}
            disabled={saving || parsed.error !== undefined || importRows.length === 0}
            onClick={confirm}
          >
            {saving && (
              <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
            )}
            {overwriteCount > 0 ? `导入 ${importRows.length} 台（覆盖 ${overwriteCount}）` : `导入 ${importRows.length} 台`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
