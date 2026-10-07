'use client';

/**
 * 供应商表格：名称 / 协议类型 / API 地址 / 模型数 / 操作。
 * 纯展示：不调接口、不知道 hooks 的存在 —— 维护模型 / 新增 / 编辑 / 删除四个动作全部以回调交给调用方。
 *
 * 七个必须守住的点：
 *   1. 删除走 `Popconfirm` 二次确认：误点一次会连明文密钥与手工维护的模型清单一起消失，
 *      而密钥是明文落盘的，用户未必还有第二份；
 *   2. 中文文案**全部显式给出**：应用没有配 antd 的 locale（见 apps/web-next/app/providers.tsx），
 *      antd 内置文案默认是英文，漏给一处就是中英混杂；
 *   3. 本组件渲染的按钮一律 `autoInsertSpace={false}`：antd 默认会在**两个汉字**的标签中间插一个
 *      空格（渲染成 `编 辑`），可访问名随之不再等于文案 —— 屏幕阅读器把「编辑」读成两个字，
 *      按名字定位按钮也会失配。按钮文案不插空格的另一面是：`编 辑` 在窄按钮里反而更挤。
 *   4. 创建 / 添加类按钮（表格下方与空态各一个）全站同形：前导加号 + **虚线边框** —— 虚线是「新建」
 *      的视觉约定，实心主按钮留给「开始」「校验并保存」这类推进流程的动作。两处细节都不能省：
 *      ① `color="default"` 必须与 `variant="dashed"` **成对**给，antd 6 里 `variant` 单给会被静默
 *      降级成实线（见 AGENT.md「边界与工具链的已知坑」）；② 图标必须 `aria-hidden`，`@ant-design/icons`
 *      自带 `role="img" aria-label="plus"`，不藏起来可访问名会变成「plus 添加供应商」。
 *   5. **不渲染「密钥掩码」列**（用户口径）：一列 `96c***…3a0f` 对齐起来核对不了任何东西，其中间段
 *      还带着密钥长度这类无谓信息，而它稳定占掉 150px——要看掩码的地方是编辑弹窗（密钥框 placeholder
 *      回显当前掩码）。`apiKeyMasked` 仍在契约 `ProviderView` 里，只是这张表不展示。
 *   6. **「添加供应商」在表格左下方**（用户口径）：新增是「读完列表之后」的收尾动作，跟在表格后面
 *      顺着视线走；放工具条右侧会与标题同行、离列表本体太远，放右下角则会和「操作」列的按钮抢视线。
 *   7. **「模型」是本行的第一个动作**（用户口径 2026-09-30）：模型清单已从编辑弹窗里单独提成
 *      一个对话框，入口就落在这里。它排在最前是因为使用频率：清单维护是高频动作，改接线是低频动作；
 *      破坏性的「删除」仍在最后，且隔着「编辑」一格。
 */
import { PlusOutlined } from '@ant-design/icons';
import { Button, Card, Flex, Popconfirm, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ReactNode } from 'react';
import { PROTOCOL_LABELS, type ProviderView } from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { EmptyState } from '../base/empty-state';

export interface ProviderTableProps {
  providers: ProviderView[];
  /** 「模型」按钮：打开模型清单对话框（清单的维护入口，见文件头第 7 点） */
  onModels: (provider: ProviderView) => void;
  onEdit: (provider: ProviderView) => void;
  onDelete: (provider: ProviderView) => void;
  onCreate: () => void;
  loading?: boolean;
}

/** 协议 → 标签颜色：两种协议在表里必须一眼可分（它决定模型能喂给哪些智能体，F1 / F2） */
const PROTOCOL_COLORS: Record<ProviderView['protocolType'], string> = {
  openai: 'blue',
  anthropic: 'purple',
};

export function ProviderTable({
  providers,
  onModels,
  onEdit,
  onDelete,
  onCreate,
  loading = false,
}: ProviderTableProps): ReactNode {
  const columns: TableColumnsType<ProviderView> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      // 与「API 地址」同口径（用户 2026-09-29）：**默认包 Tooltip**，省略号只在列放不下时出现。
      // 名字可能比 180px 长（`xxx-兼容-正式环境` 这类），裸 `Typography.Text` 会换行或顶出格子，
      // 且没有任何办法看全——它和地址是同一类字段，不该只有地址有这套待遇
      render: (name: string) => <EllipsisText text={name} strong />,
    },
    {
      title: '协议类型',
      dataIndex: 'protocolType',
      key: 'protocolType',
      width: 150,
      render: (protocolType: ProviderView['protocolType']) => (
        <Tag color={PROTOCOL_COLORS[protocolType]}>{PROTOCOL_LABELS[protocolType]}</Tag>
      ),
    },
    {
      title: 'API 地址',
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      // 地址**默认就包着 Tooltip**（`EllipsisText` 的行为），省略号只在真的放不下时才出现。
      // 所以这一格不给写死的 px 宽度（用户 2026-09-29）：原先的 `width={260}` 会在列还有富余时
      // 就把地址截断——「展示不全」是列宽说的，不该由一个魔数提前宣判。
      // 代价是「放不下」需要一个确定的分母，故表格显式 `tableLayout="fixed"`：auto 布局下这一列的
      // 最小内容宽度就是整条地址（`nowrap`），长地址会把表格顶出卡片；fixed 之后列宽由表头算，
      // 省略号稳稳落在列边缘。
      // 另外**不给 `monospace`**（用户 2026-09-29）：`Typography.Text code` 会给地址套一个灰底圆角的
      // `<code>` 盒子，看着像一枚标签，而这一格要的就是一条地址文本。
      render: (baseUrl: string) => <EllipsisText text={baseUrl} />,
    },
    {
      title: '模型数',
      key: 'modelCount',
      width: 90,
      render: (_value, provider) => provider.models.length,
    },
    {
      title: '操作',
      key: 'actions',
      /**
       * 200 是三个两字按钮 + 两个 8px 间距 + 单元格左右内边距实测出来的宽度（浏览器里量的）。
       * 「模型」放在**最前**（用户口径 2026-09-30）：清单维护是高频动作，改接线是低频动作，
       * 常用入口靠左、且与「删除」这个破坏性动作隔开一格。
       */
      width: 200,
      render: (_value, provider) => (
        <Flex gap={8}>
          <Button size="small" autoInsertSpace={false} onClick={() => onModels(provider)}>
            模型
          </Button>
          <Button size="small" autoInsertSpace={false} onClick={() => onEdit(provider)}>
            编辑
          </Button>
          <Popconfirm
            title="删除这个供应商？"
            description="它的 API 密钥与模型清单会一起消失；历史评测里记的模型名仍会保留（那是快照）。"
            okText="确认删除"
            cancelText="取消"
            okButtonProps={{ autoInsertSpace: false }}
            cancelButtonProps={{ autoInsertSpace: false }}
            onConfirm={() => onDelete(provider)}
          >
            <Button size="small" danger autoInsertSpace={false}>
              删除
            </Button>
          </Popconfirm>
        </Flex>
      ),
    },
  ];

  return (
    <Card size="small" data-testid="provider-table-card" title="模型供应商">
      <Table<ProviderView>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={providers}
        loading={loading}
        pagination={false}
        // `fixed` 是「API 地址」那格的省略号能成立的前提（见那一列的注释）：列宽由表头算，
        // `max-width: 100%` 才有确定的分母；换成 auto，长地址会把表格顶出卡片。
        tableLayout="fixed"
        // 空态给引导动作而不仅是一句「暂无数据」：空列表是新用户唯一会看到的界面
        locale={{
          emptyText: (
            <EmptyState
              title="还没有供应商"
              description="添加一个供应商，才能给智能体选模型"
              action={{
                label: '添加第一个供应商',
                icon: <PlusOutlined aria-hidden />,
                variant: 'dashed',
                onClick: onCreate,
              }}
            />
          ),
        }}
      />
      {/* 左下方而不是右下方：与「操作」列那组按钮错开，视线读完一行后落到「再加一条」上 */}
      <Flex justify="flex-start" style={{ marginTop: 8 }}>
        <Button
          color="default"
          variant="dashed"
          size="small"
          icon={<PlusOutlined aria-hidden />}
          autoInsertSpace={false}
          onClick={onCreate}
        >
          添加供应商
        </Button>
      </Flex>
    </Card>
  );
}
