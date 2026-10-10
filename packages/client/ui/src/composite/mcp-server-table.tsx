'use client';

/**
 * MCP 服务器表格：名称 / 传输 / 端点或命令 / 状态 / 操作（与「模型供应商」那张同构）。
 * 纯展示：不调接口、不认识 hooks —— 四个动作（新增 / 编辑 / 启停 / 删除）全部以回调交给调用方。
 *
 * 五个必须守住的点：
 *   1. **五列、两处固定**（与供应商表同款）：卡片窄到装不下时表格**内部**
 *      横向滚动，`名称` 钉在左边、`操作` 钉在右边，中间三列从它们下面滑过。三处必须同时在场，
 *      少一处就静默退回「被压扁 / 滚出去够不到」的样子：`scroll={{ x: 数值 }}`、名称列 `fixed: 'left'`、
 *      操作列 `fixed: 'right'`（理由与 `PROVIDER_TABLE_MIN_WIDTH` 逐字相同）。
 *      ⚠️ jsdom 没有布局引擎，真实吸边效果只有真机冒烟量得出来（`docs/guard/smoke-testing.md`）；
 *      单测钉的是「列定义与两处 `fixed` 的存在」，**不假装量到了尺寸**。
 *   2. **停用只弱化、不隐藏**：条目被停用后仍要看得见（它是「暂时不注入」而不是「不存在」）——
 *      直接不渲染的话用户会以为配置丢了。弱化那一笔**只落在名称那一格**（次级色，`muted`）：
 *      整行 `type="secondary"` 会把「端点或命令」也涂淡，而那是排障时要读的字（状态列的开关本身
 *      也只是一个信号，它回答不了「这一行是哪一台」）。判据是「停用行的名称格有弱化类 + 端点文本原样在」。
 *   3. **删除走 `Popconfirm` 且文案点明后果**：误点一次就少一台服务器，而「删了就没了」这件事
 *      要到候选执行时才发现；`okText="确认删除"` 必须显式给中文（应用没配 antd locale）。
 *   4. **不渲染密钥列**（同供应商表第 5 点）：密钥本体只在表单弹窗里以掩码出现，
 *      表格这一格只给一个「已配置密钥」小标 —— 一列掩码对齐起来核对不了任何东西，还稳定占宽。
 *   5. 中文文案**全部显式给出**、按钮一律 `autoInsertSpace={false}`（antd 默认会在两个汉字中间插
 *      一个空格，渲染成 `编 辑`，可访问名随之不再等于文案）。
 *   6. 卡片头部**两个入口**：`添加`（表单弹窗）与 `粘贴 JSON`（预览导入）。第二个入口的
 *      回调与表格的其它动作同一条口径 —— 没接上时**禁用并说明原因**，而不是摆一个点了没反应的
 *      按钮（与「测试连接」那格同款）。弹窗与导入语义都不在本组件里：这里只有入口。
 *      **空态那份引导同样摆这两个入口**：`EmptyState` 的 `action` 支持传一组动作。
 *   7. **「测试连接」的结果就地展开在该行下方**：用 antd 的展开行渲染结果区，但**不给展开列**
 * （`expandable.showExpandColumn: false`）—— 五列的定义是用几何钉过的，
 *      多出一个展开列会让「哪一列吃剩余宽度」当场变样。行级 loading 与结果状态是本组件的局部 state：
 *      它是**界面状态**（哪一行展开了、哪一行在转），请求本身仍然由调用方通过 `onTest` 注入。
 *   8. **卡片内、表格上方一条静态说明**（「卡片头部一条静态说明」）：永远显示、**不是错误提示**
 *      —— 与仓库自带条目的关系那句话是正文（`Typography.Text type="secondary"`），不是 Alert。
 *      落点必须在卡片**里**：它说的是这张卡片这些条目与仓库自带条目的关系（页面层再印一份就是两处真源）。
 */
import { PlusOutlined } from '@ant-design/icons';
import { Button, Card, Flex, Popconfirm, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { useState, type Key, type ReactNode } from 'react';
import { endpointText, hasSensitiveValue, type McpProbeResult, type McpServerConfig, type McpServers } from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { EmptyState } from '../base/empty-state';
import { McpProbeResultView, McpProbeWaiting, type McpProbeOutcome } from './mcp-probe-result';

/**
 * 「端点或命令」那一列的一行文本（http 显 URL、stdio 显 `command args…`）。
 * **实现已移进契约层**（`contracts/src/mcp.ts` 的 `endpointText`）：`api` 的探活日志与这里的表格
 * 必须同口径，而两层之间没有依赖边。这里保留同名转出，不打断既有调用点与用例
 * （`mcp-paste-modal`、`ui` 的包根出口、`mcp-server-table.test.tsx` 都从本模块取它）。
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
  /** 保存 / 删除在跑：表格整体 loading（与供应商表同口径，避免半截状态里继续点） */
  loading?: boolean;
}

/**
 * 这一条有没有「已配置的密钥」：`env` / `headers` 里**键名命中敏感模式且值非空**。
 * 为什么不看传输：http 的 headers 与 stdio 的 env 是同一件事的两个落点，判据必须合成一条，
 * 否则两种传输会给用户两套「有没有配密钥」的说法。判据本体在契约层（`hasSensitiveValue`）——
 * `api` 的探活「匿名调用」说明用的是同一把尺，两处各判一遍就会自相矛盾。
 */
export function hasConfiguredSecret(config: McpServerConfig): boolean {
  return hasSensitiveValue(config.transport === 'http' ? config.headers : config.env);
}

/**
 * 把一条（新增或编辑后的）条目并进集合，返回**新**map：名字住在键上 ⇒ 同名即覆盖那一条，
 * 改名即「删旧键、写新键」（改名 = 挪 map 键，后果是工具名 `mcp__<name>__*` 全变、
 * 且仓库自带的同名条目会重新生效——两条都写进规格当已知行为，不当缺陷追）。
 * `previousName` 就是改名那一半：**新增**传 null，编辑传打开弹窗时记下的那个名字
 * （不从当前输入反推，同 `ProviderFormModal` 记 id 的理由）。
 *
 * 为什么是纯函数：`mcpServers` 每次都是**整份替换**（浅合并），而「改名的旧键必须消失」这条
 * 一旦漏掉，界面会留下一条谁也删不掉的幽灵条目直到刷新。抽出来才钉得住（组件的 DOM 断言只能间接验）。
 * **新建**的对象：调用方拿着它直接进 PUT，就地改入参会让界面上的列表与将要落盘的那份共享引用。
 */
export function upsertServer(
  servers: McpServers,
  previousName: string | null,
  name: string,
  config: McpServerConfig,
): McpServers {
  const next: McpServers = {};
  for (const [key, value] of Object.entries(servers)) {
    // 旧名字与目标名字都要跳过：前者是改名的另一半（不跳就留下一条谁也删不掉的幽灵条目），
    // 后者是覆盖（跳掉再写 ⇒ 位置挪到末尾，JSON 保持插入顺序 ⇒ 界面顺序 = 落盘顺序）
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

/** 四列申报的宽度（`端点或命令` 刻意不给宽度，吃剩余宽度） */
const MCP_COLUMN_WIDTH = { name: 190, transport: 110, status: 90, actions: 200 } as const;

/** 「端点或命令」兜底的最小宽度：卡片窄到极限时，这一列至少还得读得出一条 npx 命令或一个 URL */
const ENDPOINT_MIN_WIDTH = 320;

/**
 * 表格的最小宽度（px）：卡片窄于它时**才**横向滚动，并把名称列 / 操作列钉在两侧。
 * 190 + 110 + 320 + 90 + 200 = 910 是**坏掉与没坏掉的分界**，来历与 `PROVIDER_TABLE_MIN_WIDTH` 同款
 * （那一处有完整的推导与「为什么不能给 `true` / `'max-content'`」）。
 *
 * 名称列 190：这一格里住着**两样东西**——名称本身与「已配置密钥」小标，而列宽是固定的 ⇒ 两者抢
 * 同一格。150px 时名称只剩 54px，`context7` 渲染成 `conte…`：**主标识被截断，而「端点或命令」那列
 * 还空着大半**。190 - 16（单元格内边距）= 174，够放下常见名（`playwright` / `filesystem`）+
 * 4px 间隙 + 小标；更长的名字照旧省略，且 `EllipsisText` 自带 Tooltip 可悬停看全。
 */
const MCP_TABLE_MIN_WIDTH =
  MCP_COLUMN_WIDTH.name + MCP_COLUMN_WIDTH.transport + ENDPOINT_MIN_WIDTH + MCP_COLUMN_WIDTH.status + MCP_COLUMN_WIDTH.actions;

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
   * 为什么允许同时有多行在测： 要求探活「不阻塞保存与其它行」——别的行照常能点。
   * 真正的互斥在服务端（同一时刻只跑一个探活，多出来的排队），前端这一层不该替它做串行。
   */
  const [testingNames, setTestingNames] = useState<readonly string[]>([]);
  /** 逐行的结论。探活结果**留在原地**（不弹 toast）：用户要对着这一行读「连通了什么 / 错在哪一档」 */
  const [outcomes, setOutcomes] = useState<Record<string, McpProbeOutcome>>({});
  /** 展开的行 = 结果区所在的那些行（受控：结果一出就要是展开的，而用户仍可手动收起） */
  const [expandedKeys, setExpandedKeys] = useState<readonly Key[]>([]);

  const isTesting = (name: string): boolean => testingNames.includes(name);

  /**
   * 点「测试连接」：先展开该行（loading 提示就在结果区里）、清掉上一次的结论，再等 `onTest` settle。
   * 上一次的结论必须先撤掉：留着它会让「正在测」与「上次的结果」同时出现在一块区域里，
   * 而两次探活的结果完全可能不一样（改了端点、上游刚挂）。
   */
  const runTest = (row: McpServerRow): void => {
    if (onTest === undefined) return;
    setTestingNames((names) => (names.includes(row.name) ? names : [...names, row.name]));
    setExpandedKeys((keys) => (keys.includes(row.name) ? keys : [...keys, row.name]));
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

  const columns: TableColumnsType<McpServerRow> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: MCP_COLUMN_WIDTH.name,
      // 钉在左边（见文件头第 1 点）：横向滚动时中间三列从它下面滑过，「这一行是谁」始终看得见
      fixed: 'left',
      render: (_value, row) => (
        <Flex gap={4} align="center">
          {/* 停用行的弱化信号**只在这一格**（文件头第 2 点）：次级色让「这一台现在不生效」一眼可见，
              而端点 / 命令那两列保持原样——排障时要读它们，涂淡了等于把线索藏起来 */}
          <EllipsisText text={row.name} strong muted={!row.config.enabled} />
          {/* 「已配置密钥」小标（spec §3）：密钥本体不在这张表里出现，只给一个「配过」的信号 */}
          {hasConfiguredSecret(row.config) && (
            <Tag color="gold" data-testid="mcp-secret-tag">
              已配置密钥
            </Tag>
          )}
        </Flex>
      ),
    },
    {
      title: '传输',
      dataIndex: ['config', 'transport'],
      key: 'transport',
      width: MCP_COLUMN_WIDTH.transport,
      render: (_value, row) => (
        // 两种传输在表里一眼可分：它决定这一条是拉起本地子进程还是连远端端点
        <Tag color={row.config.transport === 'http' ? 'blue' : 'purple'}>
          {row.config.transport === 'http' ? 'http' : 'stdio'}
        </Tag>
      ),
    },
    {
      title: '端点或命令',
      key: 'endpoint',
      // 不给宽度（与供应商表的「API 地址」同款）：它是唯一吃剩余宽度的列，
      // 省略号只在真的放不下时出现；「放不下」的分母由 `tableLayout="fixed"` + `scroll.x` 兜住
      render: (_value, row) => <EllipsisText text={endpointText(row.config)} />,
    },
    {
      title: '状态',
      key: 'enabled',
      width: MCP_COLUMN_WIDTH.status,
      render: (_value, row) => (
        <Switch
          size="small"
          checked={row.config.enabled}
          // 可访问名带上行名：多台服务器各有开关，只念「启用」的话屏读器与按名字定位的用例都分不出是哪一行
          aria-label={`启用 ${row.name}`}
          // 这一行正在探活：启停会改「已停用，不会注入」那条结论的成立条件，转完再动
          disabled={isTesting(row.name)}
          onChange={(checked) => onToggle(row.name, checked)}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: MCP_COLUMN_WIDTH.actions,
      // 钉在右边（见文件头第 1 点）：三个动作都不该需要先把表格拖到尽头才够得到
      fixed: 'right',
      render: (_value, row) => (
        <Flex gap={8}>
          <Button
            size="small"
            autoInsertSpace={false}
            disabled={isTesting(row.name)}
            onClick={() => onEdit(row)}
          >
            编辑
          </Button>
          {/* 「测试连接」：点下去按钮 loading、该行其它动作禁用、结果就地展开在
              该行下方。停用条目**仍可点**（spec §3）—— 结论里会写明「已停用，不会注入」；
              别的行正在测时这里禁用（服务端同一时刻只跑一个探活，允许连点只会让大家排队） */}
          <Button
            size="small"
            autoInsertSpace={false}
            disabled={onTest === undefined || isTesting(row.name)}
            loading={isTesting(row.name)}
            title={onTest === undefined ? '当前不可用' : undefined}
            onClick={() => runTest(row)}
          >
            测试连接
          </Button>
          <Popconfirm
            title="删除这台 MCP 服务器？"
            // 后果必须写在确认框里：用户点删除时看到的只有这一行字，
            // 「候选执行时用不到这些工具」是删除真正的代价
            description="删除后这些工具在候选执行时就没了。"
            okText="确认删除"
            cancelText="取消"
            okButtonProps={{ autoInsertSpace: false }}
            cancelButtonProps={{ autoInsertSpace: false }}
            onConfirm={() => onDelete(row)}
          >
            <Button size="small" danger autoInsertSpace={false} disabled={isTesting(row.name)}>
              删除
            </Button>
          </Popconfirm>
        </Flex>
      ),
    },
  ];

  return (
    <Card
      size="small"
      data-testid="mcp-server-table-card"
      title="MCP 服务器"
      extra={
        // 两个入口都钉在卡片头部（见文件头第 6 点）：顺序是 添加 → 粘贴 JSON，
        // 与列举顺序一致（表单是逐条维护，粘贴是一次性批量导入）
        <Flex gap={8}>
          <Button
            color="default"
            variant="dashed"
            size="small"
            icon={<PlusOutlined aria-hidden />}
            autoInsertSpace={false}
            onClick={onCreate}
          >
            添加
          </Button>
          {/* 「粘贴 JSON」是批量入口：它不替代「添加」，只是省掉逐条手填（预览弹窗会先把将要发生的事说清） */}
          <Button
            size="small"
            autoInsertSpace={false}
            disabled={onPasteJson === undefined}
            title={onPasteJson === undefined ? '粘贴入口还没接上' : undefined}
            onClick={() => onPasteJson?.()}
          >
            粘贴 JSON
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={8}>
        {/* 卡片内、表格上方那条**静态说明**（spec §3「卡片头部一条静态说明」）：永远显示、**不是错误态**
            （`type="secondary"` 的正文，不用 Alert —— 摆一个告警样式会让用户以为配置出了问题）。
            落点为什么在卡片**里**而不是页面那层：这句话说的是这张卡片里这些条目与仓库自带条目的关系，
            它属于这张卡片；摆在页面层时，两个入口（添加 / 粘贴）与这句话隔着一层卡片边框，
            读起来像在说整个设置页。 */}
        <Typography.Text type="secondary" data-testid="mcp-priority-note">
          与仓库自带的 MCP 条目的关系：同名时以设置页为准；仓库自带的其它条目仍会生效；要改仓库自带的那条得去改那个仓库
        </Typography.Text>
        <Table<McpServerRow>
          rowKey="name"
          size="small"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={false}
          // 必须给 `x`，且必须是数值：这一格就是「宽度不足」的判据本身（见 `MCP_TABLE_MIN_WIDTH`）
          scroll={{ x: MCP_TABLE_MIN_WIDTH }}
          // `fixed` 是「端点或命令」那格省略号能成立的前提（列宽由表头算，`max-width: 100%` 才有分母）
          tableLayout="fixed"
          // 结果区就地展开在这一行下方（见文件头第 6 点）：`showExpandColumn: false` 是关键 ——
          // 留着展开列就变成六列，五列的定义与那两处固定列当场失效
          expandable={{
            showExpandColumn: false,
            expandedRowKeys: expandedKeys,
            onExpandedRowsChange: (keys) => {
              // 正在测的那几行不许被收起：loading 提示就住在展开区里，收起来等于「点了没反应」
              const pinned = testingNames.filter((name) => !keys.includes(name));
              setExpandedKeys(pinned.length === 0 ? keys : [...keys, ...pinned]);
            },
            expandedRowRender: (row) => {
              if (isTesting(row.name)) return <McpProbeWaiting />;
              const outcome = outcomes[row.name];
              return outcome === undefined ? null : <McpProbeResultView outcome={outcome} />;
            },
          }}
          locale={{
            emptyText: (
              <EmptyState
                title="还没有配置 MCP 服务器。"
                description="默认会预置 context7 与 playwright"
                // 空态与卡片头部**同一组入口**（要求两处都摆）：顺序添加第一台 → 粘贴 JSON；
                // 粘贴没接上时禁用并说明原因，与头部那颗按钮同一条口径
                action={[
                  {
                    label: '添加第一台',
                    icon: <PlusOutlined aria-hidden />,
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
            ),
          }}
        />
      </Flex>
    </Card>
  );
}
