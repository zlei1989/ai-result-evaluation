'use client';

/**
 * 供应商表格：名称 / 协议类型 / API 地址 / 模型数 / 操作。
 * 纯展示：不调接口、不知道 hooks 的存在 —— 维护模型 / 新增 / 编辑 / 删除四个动作全部以回调交给调用方。
 *
 * 七个必须守住的点：
 *   1. 删除走二次确认对话框（`ConfirmDialog`）：误点一次会连明文密钥与手工维护的模型清单一起消失，
 *      而密钥是明文落盘的，用户未必还有第二份；
 *   2. **不渲染「密钥掩码」列**（用户口径）：一列 `96c***…3a0f` 对齐起来核对不了任何东西，其中间段
 *      还带着密钥长度这类无谓信息，而它稳定占掉 150px——要看掩码的地方是编辑弹窗（密钥框 placeholder
 *      回显当前掩码）。`apiKeyMasked` 仍在契约 `ProviderView` 里，只是这张表不展示。
 *   3. **「添加供应商」在表格左下方**（用户口径）：新增是「读完列表之后」的收尾动作，跟在表格后面
 *      顺着视线走；放工具条右侧会与标题同行、离列表本体太远，放右下角则会和「操作」列的按钮抢视线。
 *   4. **「模型」是本行的第一个动作**：模型清单已从编辑弹窗里单独提成一个对话框，入口就落在这里。
 *      它排在最前是因为使用频率：清单维护是高频动作，改接线是低频动作；
 *      破坏性的「删除」仍在最后，且隔着「编辑」一格。
 *   5. **卡片窄到装不下时，名称列钉在左边、操作列钉在右边**：列固定由 `columnPinning` 表达
 *      （`pinned: 'start' | 'end'` + 每列声明的 `size`）；中间三列从两侧固定列下面滑过。
 *      吸边偏移由套件按声明宽度算，组件不手写 `sticky` 与最小宽度。
 *   6. 固定列的底色由套件统一给：否则横向滚动时中间列会从固定列下面透出来。
 *   7. 新增入口（表格下方与空态两处）全站同形：前导加号 + 虚线描边 —— 虚线是「新建」的视觉约定，
 *      实心主按钮留给「开始」「校验并保存」这类推进流程的动作。图标 `aria-hidden`，
 *      可访问名必须与可见文案逐字一致。
 */
import { PlusIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { PROTOCOL_LABELS, type ProviderView } from '@aieval/contracts';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { DataTable, type DataTableColumn } from '../base/data-table';
import { SettingsEllipsis } from './settings-ellipsis';
import { ConfirmDialog } from './confirm-dialog';
import { SettingsEmpty } from './settings-empty';

export interface ProviderTableProps {
  providers: ProviderView[];
  /** 「模型」按钮：打开模型清单对话框（清单的维护入口，见文件头第 4 点） */
  onModels: (provider: ProviderView) => void;
  onEdit: (provider: ProviderView) => void;
  onDelete: (provider: ProviderView) => void;
  onCreate: () => void;
  loading?: boolean;
}

/** 协议 → 标签配色：两种协议在表里必须一眼可分（它决定模型能喂给哪些智能体） */
const PROTOCOL_CLASSES: Record<ProviderView['protocolType'], string> = {
  openai: 'border-info/30 bg-info/10 text-info',
  anthropic: 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300',
};

/**
 * 五列声明的宽度（px）：名称 / 协议 / API 地址 / 模型数 / 操作。
 *
 * 固定列的吸边偏移是这些声明值之和（套件的唯一输入），故每一列都必须给。
 * 700 = 前四列：名称 180、协议 150、地址 280、模型数 90。
 */
const PROVIDER_COLUMN_WIDTH = {
  name: 180,
  protocolType: 150,
  baseUrl: 280,
  modelCount: 90,
  actions: 200,
} as const;

export function ProviderTable({
  providers,
  onModels,
  onEdit,
  onDelete,
  onCreate,
  loading = false,
}: ProviderTableProps): ReactNode {
  /** 等待确认删除的那一条：null = 没有开确认框 */
  const [pendingDelete, setPendingDelete] = useState<ProviderView | null>(null);

  /**
   * 五列的定义。固定位置写在列定义上（`pinned`）是套件的约定：
   * 「哪一列钉住」与「这一列多宽」待在同一个对象里，偏移不会与真实列宽各说各话。
   */
  const columns: DataTableColumn<ProviderView>[] = [
    {
      id: 'name',
      header: '名称',
      accessorKey: 'name',
      size: PROVIDER_COLUMN_WIDTH.name,
      pinned: 'start',
      cell: ({ row }) => <SettingsEllipsis text={row.original.name} strong />,
    },
    {
      id: 'protocolType',
      header: '协议类型',
      accessorKey: 'protocolType',
      size: PROVIDER_COLUMN_WIDTH.protocolType,
      cell: ({ row }) => (
        <Badge variant="outline" className={PROTOCOL_CLASSES[row.original.protocolType]}>
          {PROTOCOL_LABELS[row.original.protocolType]}
        </Badge>
      ),
    },
    {
      id: 'baseUrl',
      header: 'API 地址',
      accessorKey: 'baseUrl',
      size: PROVIDER_COLUMN_WIDTH.baseUrl,
      // 地址默认就包着 Tooltip（`SettingsEllipsis` 的行为），省略号只在真的放不下时才出现
      cell: ({ row }) => <SettingsEllipsis text={row.original.baseUrl} />,
    },
    {
      id: 'modelCount',
      header: '模型数',
      accessorFn: (provider) => provider.models.length,
      size: PROVIDER_COLUMN_WIDTH.modelCount,
      cell: ({ row }) => row.original.models.length,
    },
    {
      id: 'actions',
      header: '操作',
      size: PROVIDER_COLUMN_WIDTH.actions,
      pinned: 'end',
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => onModels(row.original)}>
            模型
          </Button>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => onEdit(row.original)}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={loading}
            onClick={() => setPendingDelete(row.original)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Card size="sm" data-testid="provider-table-card">
      <CardHeader>
        <CardTitle>模型供应商</CardTitle>
      </CardHeader>
      <CardContent>
        <div data-testid="provider-table-scroll">
          <DataTable
            columns={columns}
            // 地址列吃剩余宽度：卡片是整宽的，列宽之和只有 ~600，不铺满时右侧会空出一大块
            fillColumnId="baseUrl"
            data={providers}
            rowKey={(provider) => provider.id}
            rowHeight={40}
            virtualize={false}
            emptyText={
              <SettingsEmpty
                title="还没有供应商"
                description="添加一个供应商，才能给智能体选模型"
                actions={[
                  {
                    label: '添加第一个供应商',
                    icon: <PlusIcon aria-hidden />,
                    variant: 'dashed',
                    onClick: onCreate,
                  },
                ]}
              />
            }
            tableAttributes={{ 'aria-busy': loading }}
            ariaLabel="模型供应商"
          />
        </div>
        {/* 左下方而不是右下方：与「操作」列那组按钮错开，视线读完一行后落到「再加一条」上 */}
        <div className="mt-2 flex">
          <Button size="sm" variant="outline" className="border-dashed" disabled={loading} onClick={onCreate}>
            <PlusIcon aria-hidden />
            添加供应商
          </Button>
        </div>
        <ConfirmDialog
          open={pendingDelete !== null}
          title="删除这个供应商？"
          description="它的 API 密钥与模型清单会一起消失；历史评测里记的模型名仍会保留（那是快照）。"
          confirmLabel="删除这个供应商"
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
