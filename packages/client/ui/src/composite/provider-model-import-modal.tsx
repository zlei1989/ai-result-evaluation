'use client';

/**
 * 模型挑选对话框（拉取的第二步）：把上游拉到的候选列出来，让用户勾选要加入清单的那批。
 *
 * 为什么要有这一步：网关的 /models 会把 embedding / 图像 / 已弃用型号一并返回，
 * 「拉到就全进清单」会让清单没法用；挑选这道工序把「上游有什么」与「我要用哪些」分开。
 * 它由 `ProviderModelsModal`（模型清单对话框）内部渲染，叠在外层之上 —— 页面只把候选列表
 * 与回调接进来，本组件与外层一样是**纯展示**（不调接口、不认识 message）。
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
 *   4. **中文文案全部显式给出**（应用没配 antd locale），按钮一律 `autoInsertSpace={false}`。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Flex, Modal, Table, Tag, Typography } from 'antd';
import type { ProviderModelPreview } from '@aieval/contracts';
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
 * 弹窗宽度：外层清单对话框是 720（五列：模型 + 来源 + 两个输入框 + 图标按钮），
 * 这里只有三列且没有输入框，560 放得下长模型名（ellipsis 兜底），不必与外层等宽。
 */
export const MODEL_IMPORT_MODAL_WIDTH = 560;

/** 三列之外那几列的宽度（px）：模型列吃剩余空间，故不在此列 */
const COLUMN_WIDTH = { window: 110, status: 96 } as const;

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

  const submit = (): void => {
    const selected = new Set(selectedIds);
    onImport(models.filter((model) => selected.has(model.id)));
  };

  return (
    <Modal
      open={open}
      title={`拉取到 ${models.length} 个模型`}
      onCancel={onCancel}
      width={MODEL_IMPORT_MODAL_WIDTH}
      // 确定请求在跑时点不到遮罩 / Esc：关掉对话框只会丢掉「还能看到结果」的界面，
      // 落盘本身仍在进行 —— 防手滑，不阻断（「取消」按钮仍然可用，那是明确的放弃表态）。
      // `mask.closable` 是 antd 6 的写法（`maskClosable` 已废弃）
      mask={{ closable: !importing }}
      keyboard={!importing}
      footer={
        <Flex gap={8} justify="flex-end">
          <Button autoInsertSpace={false} onClick={onCancel}>
            取消
          </Button>
          <Button
            type="primary"
            autoInsertSpace={false}
            loading={importing}
            disabled={selectedIds.length === 0}
            onClick={submit}
            // 显式给可访问名：loading 图标自带 `aria-label="loading"`，转圈时名字会变成
            // 「loading 加入清单」—— 两种状态下名字必须一致（外层「拉取模型」同一条口径）
            aria-label="加入清单"
          >
            加入清单
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={8}>
        <Typography.Text type="secondary">
          勾选的模型会加入清单（已在清单的勾上则刷新窗口与档位）；未勾选的不会被移除。
        </Typography.Text>
        <Flex align="center" justify="space-between">
          <Flex gap={8}>
            <Button
              size="small"
              autoInsertSpace={false}
              aria-label="全选"
              onClick={() => setSelectedIds(models.map((model) => model.id))}
            >
              全选
            </Button>
            <Button size="small" autoInsertSpace={false} aria-label="反选" onClick={invertSelection}>
              反选
            </Button>
          </Flex>
          <Typography.Text type="secondary">
            已选 {selectedIds.length} / {models.length}
          </Typography.Text>
        </Flex>
        {/**
         * 候选表：受控 rowSelection（勾选集合在组件手里，「全选 / 反选」按钮才能与表格勾选同一份状态）。
         * 窗口是只读数字 —— 与外层清单表不同（那里是输入框、列含义由占位符承担），
         * 这里列头是窗口数字唯一的说明，故**保留表头**。
         */}
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={models}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys.map(String)),
          }}
          columns={[
            {
              title: '模型',
              dataIndex: 'id',
              ellipsis: true,
              // 不套 `code`（与外层清单同一口径）：模型名是纯文本，等宽字形反而更难读长名
              render: (_value, model) => model.id,
            },
            {
              title: '窗口',
              width: COLUMN_WIDTH.window,
              render: (_value, model) =>
                model.contextWindow === undefined ? (
                  <Typography.Text type="secondary">未知</Typography.Text>
                ) : (
                  formatCount(model.contextWindow)
                ),
            },
            {
              title: '状态',
              width: COLUMN_WIDTH.status,
              render: (_value, model) =>
                existingIds.has(model.id) ? <Tag>已在清单</Tag> : <Typography.Text type="secondary">新</Typography.Text>,
            },
          ]}
        />
      </Flex>
    </Modal>
  );
}
