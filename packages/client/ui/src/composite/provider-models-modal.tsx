'use client';

/**
 * 模型清单对话框：拉取（预览 + 挑选导入两步）/ 手工增删 / 逐条设置窗口与输出上限。
 *
 * 它是从「编辑供应商」里**单独提出来**的：模型清单与供应商的字段
 * （名称 / 协议 / 地址 / 密钥）是两件事 —— 前者是**高频的清单维护**，后者是**低频的接线改动**，
 * 挤在同一个弹窗里的结果是「改个模型名要先把整张表单拉出来」。提出去之后：
 *   · 列表每行的操作列多一个「模型」按钮，落在「编辑」之前（模型清单比改接线常用得多）；
 *   · 编辑弹窗只留四个字段 + 一条指向本对话框的提示（那个入口必须**可见**，不能靠用户自己发现）。
 *
 * 纯展示：不调接口、不认识提示通道；动作全部以回调交给调用方（页面负责接 hooks 与报错）。
 *
 * 拉取是两步：本对话框的「拉取模型」只发起**预览**（onFetchModels），候选回到页面后经
 * `modelCandidates` 传进来，由内层的 `ProviderModelImportModal`（挑选对话框）接手 ——
 * 勾选、全选 / 反选都在那里，确定才经 onImportModels 落盘。
 *
 * 八个必须守住的点：
 *   1. **目标供应商由 props 现给**（页面按 id 从列表里查），所以拉取 / 增删之后列表一重取，
 *      这里的清单跟着刷新 —— 对话框自己不再存一份清单（两份必然漂移）。
 *   2. **目标消失要说出来**：供应商在对话框开着时被别的标签页删掉，`provider` 变成 null，
 *      此时渲染一条可见原因，而不是一片空白或一个还能点但注定 404 的按钮。
 *      挑选对话框也随之不渲染（目标没了，确定请求注定 404）。
 *   3. **草稿（窗口 / 输出上限）按 `open` 与目标 id 重置**：换了一个供应商还留着上一条的输入，
 *      保存下去就是改错了对象 —— 与 `provider-form-modal` 的表单重灌同一条口径。
 *   4. 两格能力的**输入草稿**要能把「用户清空了输入框」与「用户没碰过」分开：前者回调 `null`
 *      （明确清空，服务端据此记住「这是用户的手工表态」），后者回落到清单里的现值。
 *      用 `Object.hasOwn` 判「改过没有」，因为草稿值本身可以是 `null`。
 *   5. **「手工维护」不用标签表达**：改由保存图标变黄 + 提示语承担（少一个标签就少一格宽度竞争）。
 *   6. 中文文案**全部显式给出**，可访问名与可见文案逐字一致。
 *   7. **本对话框没有「确定 / 取消」**：它不做提交 —— 每一次增删与拉取都是**立即生效**的独立请求，
 *      页脚只留一个「关闭」。给它一个「确定」会让人以为不点就不保存。
 *      内层的挑选对话框**有**确定 / 取消：它表达的是「这一批要不要进清单」的一次性表态。
 *   8. **拉取中按钮转圈**（loading 来自页面 props）：预览是一次真实网络请求，
 *      无反馈的等待会让人连点几次（每次都发起一次请求）。
 */
import { PlusIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProviderModelCapability, ProviderModelPreview, ProviderView } from '@aieval/contracts';
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
import { DataTable, type DataTableColumn } from '../base/data-table';
import { ProviderModelImportModal } from './provider-model-import-modal';
import { SettingsAlert } from './settings-alert';

export interface ProviderModelsModalProps {
  open: boolean;
  /** 目标供应商；null = 它已不在列表里（对话框给可见原因，不渲染任何操作） */
  provider: ProviderView | null;
  fetchingModels: boolean;
  /**
   * 拉取到的候选（预览结果）：非 null 时内层挑选对话框打开。**引用必须稳定**
   * （页面存在 state 里）—— 挑选框的勾选集合随它重置，每次 render 传新数组会「勾不住」。
   */
  modelCandidates: ProviderModelPreview[] | null;
  /** 挑选后的确定请求进行中（内层对话框的「加入清单」转圈） */
  importingModels: boolean;
  onClose: () => void;
  onFetchModels: () => void;
  /** 挑选对话框「确定」：回传勾选的候选（原样，含能力格） */
  onImportModels: (models: ProviderModelPreview[]) => void;
  /** 挑选对话框「取消」/ 关闭 */
  onCancelImport: () => void;
  onAddModel: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  /**
   * 设置某条模型的能力两格（窗口 / 输出上限）。`null` = **明确清空**——
   * 服务端据此把窗口标成「用户手工改过」，下一次拉取不再覆盖它。
   * 两格同一次提交：它们是同一行相邻的两个输入框，用户点一次保存表达的是「这一行就是这样」。
   */
  onSetModelContext: (modelId: string, modelCapability: ProviderModelCapability) => void;
}

/**
 * 模型清单这张表的列宽（px）。**它是 `table-layout: fixed`**，所以每列宽必须自己算够：
 * 格子比内容窄时 td 是 `overflow: visible`，内容会**直接压到相邻列上**。
 *
 * 推导：输入框 7em = 98px + 单元格内边距 16px = 114，取 **116** 留 2px 余量。
 * 常量假设由 `provider-models-modal.test.tsx` 的列宽守卫盯着（谁把列宽改小到装不下 7em 就会变红）。
 */
export const MODEL_COLUMN_WIDTH = { model: 280, source: 88, capability: 116, actions: 72 } as const;

/** 弹窗宽度：560 放不下「模型名 + 两个输入 + 两个图标按钮」，模型列会被挤到 140px 只剩省略号 */
export const MODELS_MODAL_WIDTH = 720;

/**
 * 候选缺席时的占位数组：**模块级常量**（引用稳定）。挑选框的勾选集合随 `models` 引用重置，
 * 这里若写 `?? []`，每次 render 都是一个新数组。
 */
const NO_CANDIDATES: ProviderModelPreview[] = [];

/** 模型来源的中文标签：拉取来的与手工补的必须一眼可分（下一次拉取只会覆盖 fetched 那一批） */
const SOURCE_LABELS: Record<ProviderView['models'][number]['source'], string> = {
  fetched: '自动拉取',
  manual: '手工维护',
};

const SOURCE_CLASSES: Record<ProviderView['models'][number]['source'], string> = {
  fetched: 'border-info/30 bg-info/10 text-info',
  manual: 'border-warning/30 bg-warning/10 text-warning',
};

/** 表格里两个可编辑的能力格（与 `ProviderModelCapability` 的键一一对应） */
type CapabilityField = 'contextWindow' | 'maxOutputTokens';

/** 能力输入框的宽度：与列宽常量一起构成「装得下」的判据（7em 在 14px 字号下是 98px） */
const CAPABILITY_INPUT_WIDTH = '7em';

export function ProviderModelsModal(props: ProviderModelsModalProps): ReactNode {
  const {
    open,
    provider,
    fetchingModels,
    modelCandidates,
    importingModels,
    onClose,
    onFetchModels,
    onImportModels,
    onCancelImport,
    onAddModel,
    onRemoveModel,
    onSetModelContext,
  } = props;
  const [modelInput, setModelInput] = useState('');
  /** 两格能力的输入草稿（按模型 id、按字段），见文件头第 4 点 */
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<CapabilityField, number | null>>>>({});
  const providerId = provider?.id ?? null;

  // 依赖里只放 open 与目标 id，**不放 provider 对象本身**：增删一个模型后列表会重取、给出新的
  // ProviderView 对象，把它放进依赖会让 effect 在用户打字中途清掉刚输入的值。
  useEffect(() => {
    if (!open) return;
    setDrafts({});
    setModelInput('');
  }, [open, providerId]);

  const addModel = (): void => {
    const id = modelInput.trim();
    if (id === '') return;
    onAddModel(id);
    setModelInput('');
  };

  /** 该输入框当前该显示的值：用户改过（含清空）就用用户的，没碰过就回落到清单里的现值 */
  const draftOf = (model: ProviderView['models'][number], field: CapabilityField): number | null => {
    const row = drafts[model.id];
    if (row !== undefined && Object.hasOwn(row, field)) return row[field] ?? null;
    return model[field] ?? null;
  };

  const setDraft = (modelId: string, field: CapabilityField, value: number | null): void => {
    setDrafts((draft) => ({ ...draft, [modelId]: { ...draft[modelId], [field]: value } }));
  };

  /**
   * 「手工维护过」这一行的保存提示：这件事改由**保存图标变黄 + 提示语**承担。
   * 提示语与可访问名用同一份文案 —— 屏读用户不该拿到一个「保存窗口」而不知道这是手工行。
   */
  const saveHintOf = (model: ProviderView['models'][number]): string =>
    model.contextWindowSource === 'manual' ? '保存窗口，模型已被手工维护' : '保存窗口';

  /**
   * 五列定义：模型 / 来源 / 输入 / 输出 / 操作。**表头隐藏**（`showHeader={false}`）：
   * 列的含义由输入框占位符与按钮承担；固定宽度让两个能力输入框有确定的分母。
   */
  const columns: DataTableColumn<ProviderView['models'][number]>[] = [
    {
      id: 'model',
      header: '模型',
      accessorKey: 'id',
      size: MODEL_COLUMN_WIDTH.model,
      // 不套 `code`：模型名本身就是纯文本，等宽字形反而更难读长名。
      // `data-ellipsis` 是「这一格真的开了省略」的稳定信号（jsdom 量不到宽度）
      cell: ({ row }) => (
        <span data-ellipsis className="block truncate" title={row.original.id}>
          {row.original.id}
        </span>
      ),
    },
    {
      id: 'source',
      header: '来源',
      accessorKey: 'source',
      size: MODEL_COLUMN_WIDTH.source,
      cell: ({ row }) => (
        <Badge variant="outline" className={SOURCE_CLASSES[row.original.source]}>
          {SOURCE_LABELS[row.original.source]}
        </Badge>
      ),
    },
    {
      id: 'contextWindow',
      header: '上下文窗口',
      accessorKey: 'contextWindow',
      size: MODEL_COLUMN_WIDTH.capability,
      cell: ({ row }) => (
        <Input
          type="number"
          min={1}
          style={{ width: CAPABILITY_INPUT_WIDTH }}
          aria-label={`${row.original.id} 的上下文窗口`}
          placeholder="窗口 token 数"
          className="[appearance:textfield]"
          value={draftOf(row.original, 'contextWindow') ?? ''}
          onChange={(event) =>
            setDraft(row.original.id, 'contextWindow', event.target.value === '' ? null : Number(event.target.value))
          }
        />
      ),
    },
    {
      id: 'maxOutputTokens',
      header: '最大输出',
      accessorKey: 'maxOutputTokens',
      size: MODEL_COLUMN_WIDTH.capability,
      cell: ({ row }) => (
        <Input
          type="number"
          min={1}
          style={{ width: CAPABILITY_INPUT_WIDTH }}
          aria-label={`${row.original.id} 的最大输出`}
          placeholder="输出上限"
          className="[appearance:textfield]"
          value={draftOf(row.original, 'maxOutputTokens') ?? ''}
          onChange={(event) =>
            setDraft(row.original.id, 'maxOutputTokens', event.target.value === '' ? null : Number(event.target.value))
          }
        />
      ),
    },
    {
      id: 'actions',
      header: '操作',
      size: MODEL_COLUMN_WIDTH.actions,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            data-manual={row.original.contextWindowSource === 'manual' ? 'true' : undefined}
            className={
              row.original.contextWindowSource === 'manual'
                ? 'text-warning'
                : undefined
            }
            aria-label={saveHintOf(row.original)}
            // 手工维护过的行：图标变黄；`title` 与可访问名同文，悬停可读
            title={saveHintOf(row.original)}
            onClick={() =>
              onSetModelContext(row.original.id, {
                contextWindow: draftOf(row.original, 'contextWindow'),
                maxOutputTokens: draftOf(row.original, 'maxOutputTokens'),
              })
            }
          >
            <SaveIcon aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-destructive"
            aria-label="移除"
            title="移除"
            onClick={() => onRemoveModel(row.original.id)}
          >
            <Trash2Icon aria-hidden />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-[720px]"
        style={{ maxWidth: MODELS_MODAL_WIDTH }}
        data-testid="provider-models-dialog"
        showCloseButton={false}
      >
        <DialogHeader>
          {/* 标题带上供应商名：从列表里点进来时，人未必记得自己点的是哪一行（两行名字只差一个后缀很常见） */}
          <DialogTitle>{provider === null ? '模型清单' : `模型清单：${provider.name}`}</DialogTitle>
        </DialogHeader>

        {provider === null ? (
          // 目标在对话框开着时被删掉（别的标签页 / CLI 改配置）：说清去向，而不是给一片空白
          <SettingsAlert
            tone="warning"
            title="这条供应商已不在列表里"
            description="它可能已被删除或改名：请关闭这个对话框，等列表刷新后重新打开。"
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                aria-label="拉取模型"
                data-loading={fetchingModels ? 'true' : undefined}
                disabled={fetchingModels}
                onClick={onFetchModels}
              >
                {fetchingModels && (
                  <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
                )}
                拉取模型
              </Button>
              <span className="text-sm text-muted-foreground">
                拉取后先挑选要加入的模型；手工维护的条目不会被冲掉
              </span>
            </div>

            {provider.models.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有模型：拉取一次，或手工添加。</p>
            ) : (
              /**
               * 模型清单：列序 **模型 ｜ 来源 ｜ 输入 ｜ 输出 ｜ 操作**，**表头隐藏**（列的含义由输入框
               * 占位符与按钮承担），操作列**右对齐**。三条刻意的取舍：
               *   · 模型列开 `truncate`：网关的模型名可以很长，撑破弹窗比截断更糟；
               *   · 两格能力各占一列、都是输入框、都 7em：值只在输入框里；
               *   · 操作用图标按钮 + 右对齐：两个汉字的文字按钮在这一列里占掉半张表。
               */
              <div className="w-full">
                <DataTable
                  columns={columns}
                  data={provider.models}
                  rowKey={(model) => model.id}
                  showHeader={false}
                  virtualize={false}
                  rowHeight={40}
                  // 操作列右对齐：与旧表的单元格语义一致（图标按钮贴着右边界）
                  cellAttributes={(_model, columnId) =>
                    columnId === 'actions' ? { style: { textAlign: 'right' } } : undefined
                  }
                  ariaLabel="模型清单"
                />
              </div>
            )}

            <div className="flex gap-2">
              <Input
                size={undefined}
                value={modelInput}
                placeholder="手工添加模型名，如 deepseek-chat"
                onChange={(event) => setModelInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addModel();
                  }
                }}
              />
              <Button size="sm" variant="outline" className="border-dashed" onClick={addModel}>
                <PlusIcon aria-hidden />
                添加
              </Button>
            </div>

            {/**
             * 挑选对话框（拉取第二步）：只在目标还在、且页面手里有候选时出现。
             * 「已在清单」的标注由当前清单现算 —— 候选与清单都在 props 里，两份事实都是最新的。
             */}
            <ProviderModelImportModal
              open={modelCandidates !== null}
              models={modelCandidates ?? NO_CANDIDATES}
              existingIds={new Set(provider.models.map((model) => model.id))}
              importing={importingModels}
              onImport={onImportModels}
              onCancel={onCancelImport}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
