'use client';

/**
 * MCP 服务器表格：名称 / 传输 / 端点或命令 / 状态 / 操作（与「模型供应商」那张同构）。
 * 纯展示：不调接口、不认识 hooks —— 四个动作（新增 / 编辑 / 启停 / 删除）全部以回调交给调用方。
 *
 * 八个必须守住的点：
 *   1. **五列、两处固定**（与供应商表同款）：卡片窄到装不下时表格**内部**横向滚动，
 *      `名称` 钉在左边、`操作` 钉在右边，中间三列从它们下面滑过。列固定由 `columnPinning`
 *      表达（`pinned: 'start' | 'end'` + 每列声明的 `size`）。
 *      ⚠️ jsdom 没有布局引擎，真实吸边效果只有真机冒烟量得出来；单测钉的是「列定义与两处 pin
 *      的存在」，**不假装量到了尺寸**。
 *   2. **停用只弱化、不隐藏**：条目被停用后仍要看得见（它是「暂时不注入」而不是「不存在」）——
 *      直接不渲染的话用户会以为配置丢了。弱化那一笔**只落在名称那一格**（次级色）：
 *      整行都涂淡会把「端点或命令」也一起弱化，而那是排障时要读的字。
 *   3. **删除走二次确认对话框且文案点明后果**：误点一次就少一台服务器，而「删了就没了」这件事
 *      要到候选执行时才发现。
 *   4. **不渲染密钥列**（同供应商表）：密钥本体只在表单弹窗里以掩码出现，
 *      表格这一格只给一个「已配置密钥」小标 —— 一列掩码对齐起来核对不了任何东西，还稳定占宽。
 *   5. 中文文案**全部显式给出**：可访问名必须与可见文案逐字一致（屏读器与按名字定位都靠它）。
 *   6. 卡片头部**两个入口**：`添加`（表单弹窗）与 `粘贴 JSON`（预览导入）。第二个入口的
 *      回调没接上时**禁用并说明原因**，而不是摆一个点了没反应的按钮。
 *      **空态那份引导同样摆这两个入口**（`SettingsEmpty` 支持传一组动作）。
 *   7. **「测试连接」的结果就地展开在该行下方**：结果区是表体里紧跟该行的附加行（`colSpan` 占满五列），
 *      **不给表格加展开列** —— 五列的定义是用几何钉过的，多出一个展开列会让「哪一列吃剩余宽度」当场变样。
 *      行级 loading 与结果状态是本组件的局部 state：它是**界面状态**（哪一行在转、哪一行有结论），
 *      请求本身仍然由调用方通过 `onTest` 注入。
 *   8. **卡片内、表格上方一条静态说明**：永远显示、**不是错误提示** —— 与仓库自带条目的关系那句话
 *      是正文，不是 Alert。落点必须在卡片**里**：它说的是这张卡片这些条目与仓库自带条目的关系。
 */
import { Loader2Icon, PlusIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { endpointText, hasSensitiveValue, type McpProbeResult, type McpServerConfig, type McpServers } from '@aieval/contracts';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { DataTable, type DataTableColumn } from '../base/data-table';
import { Switch } from '../components/ui/switch';
import { SettingsEllipsis } from './settings-ellipsis';
import { ConfirmDialog } from './confirm-dialog';
import { McpProbeResultView, McpProbeWaiting, type McpProbeOutcome } from './mcp-probe-result';
import { SettingsEmpty } from './settings-empty';

/**
 * 「端点或命令」那一列的一行文本（http 显 URL、stdio 显 `command args…`）。
 * **实现已移进契约层**（`contracts/src/mcp.ts` 的 `endpointText`）：`api` 的探活日志与这里的表格
 * 必须同口径，而两层之间没有依赖边。这里保留同名转出，不打断既有调用点与用例。
 */
export { endpointText };

/**表格里的一行：名字住在 map 的**键**上（条目里没有 `name` 字段），故行数据要带上它 */
export interface McpServerRow {
  name: string;
  config: McpServerConfig;
}

export interface McpServerTableProps {
  servers: McpServers;
  /** 单项启停：把这一行的新状态交出去（条目增删改都走弹窗的「确定」，只有开关是即时落盘） */
  onToggle: (name: string, enabled: boolean) => void;
  onEdit: (row: McpServerRow) => void;
  onDelete: (row: McpServerRow) => void;
  onCreate: () => void;
  /**
   * 「测试连接」：交出去整行，**返回**这次的探活结论。
   * 为什么是 `Promise`：按钮的 loading、该行其它动作的禁用、结果区的展开都要等它 settle；
   * 组件自己不调接口，请求由调用方注入（`probeMcpServer({ name })` 测的就是**已保存**的那份）。
   */
  onTest?: (row: McpServerRow) => Promise<McpProbeResult>;
  /**
   * 「粘贴 JSON」：打开预览导入弹窗（`McpPasteModal`）。回调不传时按钮**禁用并说明原因** ——
   * 摆一个点了没反应的按钮，比摆一个明说「还没接上」的按钮更糟（与 `onTest` 同一条口径）。
   */
  onPasteJson?: () => void;
  /** 保存 / 删除在跑：表格整体 loading（避免半截状态里继续点） */
  loading?: boolean;
}

/**
 * 这一条有没有「已配置的密钥」：`env` / `headers` 里**键名命中敏感模式且值非空**。
 * 判据本体在契约层（`hasSensitiveValue`）——`api` 的探活「匿名调用」说明用的是同一把尺。
 */
export function hasConfiguredSecret(config: McpServerConfig): boolean {
  return hasSensitiveValue(config.transport === 'http' ? config.headers : config.env);
}

/**
 * 把一条（新增或编辑后的）条目并进集合，返回**新**map：名字住在键上 ⇒ 同名即覆盖那一条，
 * 改名即「删旧键、写新键」。`previousName` 就是改名那一半：**新增**传 null，
 * 编辑传打开弹窗时记下的那个名字（不从当前输入反推）。
 *
 * 为什么是纯函数：`mcpServers` 每次都是**整份替换**，而「改名的旧键必须消失」这条一旦漏掉，
 * 界面会留下一条谁也删不掉的幽灵条目直到刷新。抽出来才钉得住。
 */
export function upsertServer(
  servers: McpServers,
  previousName: string | null,
  name: string,
  config: McpServerConfig,
): McpServers {
  const next: McpServers = {};
  for (const [key, value] of Object.entries(servers)) {
    // 旧名字与目标名字都要跳过：前者是改名的另一半，后者是覆盖（跳掉再写 ⇒ 位置挪到末尾，
    // JSON 保持插入顺序 ⇒ 界面顺序 = 落盘顺序）
    if (key === previousName || key === name) continue;
    next[key] = value;
  }
  next[name] = config;
  return next;
}

/** 从集合里去掉一条，返回**新** map（删除按钮那条路径；同样不改入参） */
export function removeServer(servers: McpServers, name: string): McpServers {
  const next: McpServers = {};
  for (const [key, value] of Object.entries(servers)) {
    if (key === name) continue;
    next[key] = value;
  }
  return next;
}

/**
 * 五列声明的宽度（px）：名称 / 传输 / 端点或命令 / 状态 / 操作。
 * 190 + 110 + 320 + 90 + 200 = 910，是「装不装得下」的分界；固定列的偏移输入就是这些声明值。
 *
 * 名称列 190：这一格里住着**两样东西**——名称本身与「已配置密钥」小标，而列宽是固定的 ⇒ 两者抢
 * 同一格。190 - 16（单元格内边距）= 174，够放下常见名 + 间隙 + 小标；更长的名字照旧省略。
 */
const MCP_COLUMN_WIDTH = { name: 190, transport: 110, endpoint: 320, status: 90, actions: 200 } as const;

export function McpServerTable({
  servers,
  onToggle,
  onEdit,
  onDelete,
  onCreate,
  onTest,
  onPasteJson,
  loading = false,
}: McpServerTableProps): ReactNode {
  // 顺序 = 落盘顺序（JSON 对象保持插入顺序）：不排序、不重组，否则「界面顺序 = 落盘顺序」
  // 这条承诺在用户眼里就不成立
  const rows: McpServerRow[] = Object.entries(servers).map(([name, config]) => ({ name, config }));

  /**
   * 正在测的那些行（**按行**记，不是全局一个标志）。
   * 为什么允许同时有多行在测：要求探活「不阻塞保存与其它行」——别的行照常能点。
   * 真正的互斥在服务端（同一时刻只跑一个探活，多出来的排队），前端这一层不该替它做串行。
   */
  const [testingNames, setTestingNames] = useState<readonly string[]>([]);
  /** 逐行的结论。探活结果**留在原地**（不弹 toast）：用户要对着这一行读「连通了什么 / 错在哪一档」 */
  const [outcomes, setOutcomes] = useState<Record<string, McpProbeOutcome>>({});
  /** 等待确认删除的那一行：null = 没有开确认框 */
  const [pendingDelete, setPendingDelete] = useState<McpServerRow | null>(null);

  const isTesting = (name: string): boolean => testingNames.includes(name);

  /** 五行定义：名称钉左、操作钉右，端点列居中吃剩余宽度 */
  const columns: DataTableColumn<McpServerRow>[] = [
    {
      id: 'name',
      header: '名称',
      accessorKey: 'name',
      size: MCP_COLUMN_WIDTH.name,
      pinned: 'start',
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          {/* 停用行的弱化信号**只在这一格**（文件头第 2 点）：次级色让「这一台现在不生效」一眼可见，
              而端点 / 命令那两列保持原样——排障时要读它们，涂淡了等于把线索藏起来 */}
          <SettingsEllipsis text={row.original.name} strong muted={!row.original.config.enabled} />
          {/* 「已配置密钥」小标：密钥本体不在这张表里出现，只给一个「配过」的信号 */}
          {hasConfiguredSecret(row.original.config) && (
            <Badge
              data-testid="mcp-secret-tag"
              variant="outline"
              className="border-warning/30 bg-warning/10 text-warning"
            >
              已配置密钥
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: 'transport',
      header: '传输',
      accessorFn: (row) => row.config.transport,
      size: MCP_COLUMN_WIDTH.transport,
      cell: ({ row }) => (
        // 两种传输在表里一眼可分：它决定这一条是拉起本地子进程还是连远端端点
        <Badge
          variant="outline"
          className={
            row.original.config.transport === 'http'
              ? 'border-info/30 bg-info/10 text-info'
              : 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300'
          }
        >
          {row.original.config.transport === 'http' ? 'http' : 'stdio'}
        </Badge>
      ),
    },
    {
      id: 'endpoint',
      header: '端点或命令',
      accessorFn: (row) => endpointText(row.config),
      size: MCP_COLUMN_WIDTH.endpoint,
      cell: ({ row }) => <SettingsEllipsis text={endpointText(row.original.config)} />,
    },
    {
      id: 'status',
      header: '状态',
      accessorFn: (row) => row.config.enabled,
      size: MCP_COLUMN_WIDTH.status,
      cell: ({ row }) => (
        <Switch
          size="sm"
          checked={row.original.config.enabled}
          // 可访问名带上行名：多台服务器各有开关，只念「启用」的话屏读器与按名字定位的用例都分不出是哪一行
          aria-label={`启用 ${row.original.name}`}
          // 这一行正在探活：启停会改「已停用，不会注入」那条结论的成立条件，转完再动
          disabled={isTesting(row.original.name)}
          onCheckedChange={(checked) => onToggle(row.original.name, checked)}
        />
      ),
    },
    {
      id: 'actions',
      header: '操作',
      size: MCP_COLUMN_WIDTH.actions,
      pinned: 'end',
      cell: ({ row }) => {
        const testing = isTesting(row.original.name);
        return (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={testing || loading} onClick={() => onEdit(row.original)}>
              编辑
            </Button>
            {/* 「测试连接」：点下去按钮 loading、该行其它动作禁用、结论就地展开在该行下方。
                停用条目**仍可点**（spec §3）—— 结论里会写明「已停用，不会注入」；
                别的行正在测时这里不拦（服务端排队），允许各测各的 */}
            <Button
              size="sm"
              variant="outline"
              aria-label="测试连接"
              data-loading={testing ? 'true' : undefined}
              disabled={onTest === undefined || testing}
              title={onTest === undefined ? '当前不可用' : undefined}
              onClick={() => runTest(row.original)}
            >
              {testing && <Loader2Icon className="animate-spin" aria-hidden />}
              测试连接
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={testing || loading}
              onClick={() => setPendingDelete(row.original)}
            >
              删除
            </Button>
          </div>
        );
      },
    },
  ];

  /**
   * 点「测试连接」：先进入 loading（提示就在结果区里）、清掉上一次的结论，再等 `onTest` settle。
   * 上一次的结论必须先撤掉：留着它会让「正在测」与「上次的结果」同时出现在一块区域里，
   * 而两次探活的结果完全可能不一样（改了端点、上游刚挂）。
   */
  const runTest = (row: McpServerRow): void => {
    if (onTest === undefined) return;
    setTestingNames((names) => (names.includes(row.name) ? names : [...names, row.name]));
    setOutcomes((previous) => {
      const next = { ...previous };
      delete next[row.name];
      return next;
    });
    void onTest(row)
      .then((result) => setOutcomes((previous) => ({ ...previous, [row.name]: { kind: 'result', result } })))
      // 请求本身失败（条目被别的标签页删了 / 网络断 / 500）：折成结果区的第三种内容，
      // 不冒充任何探活档位；`ServiceError.message` 已是可直接展示的中文
      .catch((error: unknown) =>
        setOutcomes((previous) => ({
          ...previous,
          [row.name]: { kind: 'error', message: error instanceof Error ? error.message : String(error) },
        })),
      )
      .finally(() => setTestingNames((names) => names.filter((name) => name !== row.name)));
  };

  return (
    <Card size="sm" data-testid="mcp-server-table-card">
      <CardHeader>
        <CardTitle>MCP 服务器</CardTitle>
        <CardAction>
          {/* 两个入口都钉在卡片头部（见文件头第 6 点）：顺序是 添加 → 粘贴 JSON，
              与列举顺序一致（表单是逐条维护，粘贴是一次性批量导入） */}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="border-dashed" onClick={onCreate}>
              <PlusIcon aria-hidden />
              添加
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={onPasteJson === undefined}
              title={onPasteJson === undefined ? '粘贴入口还没接上' : undefined}
              onClick={() => onPasteJson?.()}
            >
              粘贴 JSON
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          {/* 卡片内、表格上方那条**静态说明**：永远显示、**不是错误态**（正文，不用 Alert ——
              摆一个告警样式会让用户以为配置出了问题）。落点为什么在卡片**里**而不是页面那层：
              这句话说的是这张卡片里这些条目与仓库自带条目的关系，它属于这张卡片。 */}
          <p className="text-sm text-muted-foreground" data-testid="mcp-priority-note">
            与仓库自带的 MCP 条目的关系：同名时以设置页为准；仓库自带的其它条目仍会生效；要改仓库自带的那条得去改那个仓库
          </p>
          <div data-testid="mcp-server-table-scroll">
            <DataTable
              columns={columns}
              // 端点地址是最长的一格：余量给它，卡片右侧不再留白
              fillColumnId="endpoint"
              data={rows}
              rowKey={(row) => row.name}
              rowHeight={44}
              virtualize={false}
              emptyText={
                <SettingsEmpty
                  title="还没有配置 MCP 服务器。"
                  description="默认会预置 context7 与 playwright"
                  // 空态与卡片头部**同一组入口**：顺序添加第一台 → 粘贴 JSON；
                  // 粘贴没接上时禁用并说明原因，与头部那颗按钮同一条口径
                  actions={[
                    {
                      label: '添加第一台',
                      icon: <PlusIcon aria-hidden />,
                      variant: 'dashed',
                      onClick: onCreate,
                    },
                    {
                      label: '粘贴 JSON',
                      disabled: onPasteJson === undefined,
                      title: onPasteJson === undefined ? '粘贴入口还没接上' : undefined,
                      onClick: () => onPasteJson?.(),
                    },
                  ]}
                />
              }
              renderRowAfter={(row) => {
                const testing = isTesting(row.name);
                const outcome = outcomes[row.name];
                if (!testing && outcome === undefined) return null;
                return (
                  <div className="whitespace-normal bg-muted/30">
                    {testing ? <McpProbeWaiting /> : <McpProbeResultView outcome={outcome as McpProbeOutcome} />}
                  </div>
                );
              }}
              tableAttributes={{ 'aria-busy': loading }}
              ariaLabel="MCP 服务器"
            />
          </div>
        </div>
        <ConfirmDialog
          open={pendingDelete !== null}
          title="删除这台 MCP 服务器？"
          description="删除后这些工具在候选执行时就没了。"
          confirmLabel="删除这台服务器"
          onConfirm={() => {
            if (pendingDelete === null) return;
            onDelete(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      </CardContent>
    </Card>
  );
}
