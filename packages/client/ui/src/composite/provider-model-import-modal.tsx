'use client';

/**
 * 模型挑选对话框（拉取的第二步）：把上游拉到的候选列出来，让用户勾选要加入清单的那批。
 *
 * 为什么要有这一步：网关的 /models 会把 embedding / 图像 / 已弃用型号一并返回，
 * 「拉到就全进清单」会让清单没法用；挑选这道工序把「上游有什么」与「我要用哪些」分开。
 * 它由 `ProviderModelsModal`（模型清单对话框）内部渲染，叠在外层之上 —— 页面只把候选列表
 * 与回调接进来，本组件与外层一样是**纯展示**（不调接口、不认识提示通道）。
 *
 * 四个必须守住的点：
 *   1. **默认全选**：打开后直接确定 = 把拉到的全部加入（与「挑选加入」之前的旧行为一致，
 *      老用户不用重新学）。挑选靠取消勾选 / 反选完成，不是从零开始勾。
 *   2. **勾选随候选重置**：重新拉取（候选数组换了一份）后必须回到默认全选 ——
 *      沿用上一份的勾选集合， ids 对不上号就会出现「看着勾了 A、确定后进的是 B」。
 *      依赖数组里是 `models`（引用），页面把它存在 state 里，重渲染不会换引用；
 *      调用方若每次 render 传新数组，勾选会被逐帧重置（症状是「勾不住」）。
 *   3. **零勾选时「加入清单」不可点**：空提交没有语义（服务端 zod 也挡），可点的确定按钮
 *      会让用户以为「点了但什么都没发生」。
 *   4. **中文文案全部显式给出**，可访问名与可见文案逐字一致。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProviderModelPreview } from '@aieval/contracts';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { DataTable, type DataTableColumn } from '../base/data-table';
import { formatCount } from '../base/usage-metrics';

export interface ProviderModelImportModalProps {
  open: boolean;
  /** 上游拉到的候选（拉取第一步的产物）；空数组不会出现（服务端对空清单直接报错） */
  models: ProviderModelPreview[];
  /** 已在清单里的模型 id（标注「已在清单」：勾上它的语义是刷新窗口与档位，不是新增） */
  existingIds: ReadonlySet<string>;
  /** 确定请求进行中（按钮转圈，遮罩防手滑关掉对话框） */
  importing: boolean;
  /** 确定：把勾选的候选**原样**回传（含窗口 / 档位等能力格 —— 所见即所得） */
  onImport: (models: ProviderModelPreview[]) => void;
  onCancel: () => void;
}

/**
 * 弹窗宽度：外层清单对话框是 720（五列），这里只有四列且没有输入框，
 * 560 放得下长模型名（省略号兜底），不必与外层等宽。
 */
export const MODEL_IMPORT_MODAL_WIDTH = 560;

/** 四列声明的宽度（px）：勾选 / 模型 / 窗口 / 状态 */
const COLUMN_WIDTH = { select: 44, model: 300, window: 110, status: 96 } as const;

export function ProviderModelImportModal(props: ProviderModelImportModalProps): ReactNode {
  const { open, models, existingIds, importing, onImport, onCancel } = props;
  /** 勾选集合按候选 id 受控；重置口径见文件头第 2 点 */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (open) setSelectedIds(models.map((model) => model.id));
  }, [open, models]);

  /** 反选 = 全集减当前勾选（补集），不是「清空」也不是「全选」 */
  const invertSelection = (): void => {
    const selected = new Set(selectedIds);
    setSelectedIds(models.filter((model) => !selected.has(model.id)).map((model) => model.id));
  };

  const toggleRow = (id: string, checked: boolean): void => {
    setSelectedIds((current) =>
      checked ? (current.includes(id) ? current : [...current, id]) : current.filter((one) => one !== id),
    );
  };

  const submit = (): void => {
    const selected = new Set(selectedIds);
    onImport(models.filter((model) => selected.has(model.id)));
  };

  /**
   * 四列定义。勾选列与模型列都显式声明宽度（吸边偏移的输入是声明值）；
   * 表头**保留**：窗口这一格是只读数字，列头是它唯一的说明。
   */
  const columns: DataTableColumn<ProviderModelPreview>[] = [
    {
      id: 'select',
      header: '',
      size: COLUMN_WIDTH.select,
      // 表头不提供「全选」复选框：全选 / 反选是旁边那两颗显式按钮，
      // 两处都能切同一份状态会让「点哪一个算数」变得含糊
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={`选择 ${row.original.id}`}
          checked={selectedIds.includes(row.original.id)}
          onChange={(event) => toggleRow(row.original.id, event.target.checked)}
        />
      ),
    },
    {
      id: 'model',
      header: '模型',
      accessorKey: 'id',
      size: COLUMN_WIDTH.model,
      // 不套 `code`（与外层清单同一口径）：模型名是纯文本，等宽字形反而更难读长名
      cell: ({ row }) => (
        <span data-ellipsis className="block truncate" title={row.original.id}>
          {row.original.id}
        </span>
      ),
    },
    {
      id: 'window',
      header: '窗口',
      accessorKey: 'contextWindow',
      size: COLUMN_WIDTH.window,
      cell: ({ row }) =>
        row.original.contextWindow === undefined ? (
          <span className="text-sm text-muted-foreground">未知</span>
        ) : (
          formatCount(row.original.contextWindow)
        ),
    },
    {
      id: 'status',
      header: '状态',
      accessorFn: (model) => existingIds.has(model.id),
      size: COLUMN_WIDTH.status,
      cell: ({ row }) =>
        existingIds.has(row.original.id) ? (
          <Badge variant="secondary">已在清单</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">新</span>
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
        className="sm:max-w-[560px]"
        style={{ maxWidth: MODEL_IMPORT_MODAL_WIDTH }}
        data-testid="provider-model-import-dialog"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{`拉取到 ${models.length} 个模型`}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            勾选的模型会加入清单（已在清单的勾上则刷新窗口与档位）；未勾选的不会被移除。
          </p>
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button size="sm" variant="outline" aria-label="全选" onClick={() => setSelectedIds(models.map((model) => model.id))}>
                全选
              </Button>
              <Button size="sm" variant="outline" aria-label="反选" onClick={invertSelection}>
                反选
              </Button>
            </div>
            <span className="text-sm text-muted-foreground">
              已选 {selectedIds.length} / {models.length}
            </span>
          </div>
          {/**
           * 候选表：受控勾选（勾选集合在组件手里，「全选 / 反选」按钮才能与表格勾选同一份状态）。
           * 窗口是只读数字 —— 与外层清单表不同（那里是输入框、列含义由占位符承担），
           * 这里列头是窗口数字唯一的说明，故**保留表头**。
           */}
          <div className="w-full">
            <DataTable
              columns={columns}
              data={models}
              rowKey={(model) => model.id}
              rowHeight={40}
              virtualize={false}
              ariaLabel="模型挑选"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button
            aria-label="加入清单"
            data-loading={importing ? 'true' : undefined}
            disabled={importing || selectedIds.length === 0}
            onClick={submit}
          >
            {importing && (
              <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
            )}
            加入清单
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
