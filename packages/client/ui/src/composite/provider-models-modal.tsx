'use client';

/**
 * 模型清单对话框：拉取 / 手工增删 / 逐条设置窗口与输出上限。
 *
 * 它是从「编辑供应商」里**单独提出来**的（用户口径 2026-09-30）：模型清单与供应商的字段
 * （名称 / 协议 / 地址 / 密钥）是两件事 —— 前者是**高频的清单维护**，后者是**低频的接线改动**，
 * 挤在同一个弹窗里的结果是「改个模型名要先把整张表单拉出来」。提出去之后：
 *   · 列表每行的操作列多一个「模型」按钮，落在「编辑」之前（模型清单比改接线常用得多）；
 *   · 编辑弹窗只留四个字段 + 一条指向本对话框的提示（那个入口必须**可见**，不能靠用户自己发现）。
 *
 * 纯展示：不调接口、不认识 message；五个动作全部以回调交给调用方（页面负责接 hooks 与报错）。
 *
 * 七个必须守住的点：
 *   1. **目标供应商由 props 现给**（页面按 id 从列表里查），所以拉取 / 增删之后列表一重取，
 *      这里的清单跟着刷新 —— 对话框自己不再存一份清单（两份必然漂移）。
 *   2. **目标消失要说出来**：供应商在对话框开着时被别的标签页删掉，`provider` 变成 null，
 *      此时渲染一条可见原因，而不是一片空白或一个还能点但注定 404 的按钮。
 *   3. **草稿（窗口 / 输出上限）按 `open` 与目标 id 重置**：换了一个供应商还留着上一条的输入，
 *      保存下去就是改错了对象 —— 与 `provider-form-modal` 的表单重灌同一条口径。
 *   4. 两格能力的**输入草稿**要能把「用户清空了输入框」与「用户没碰过」分开：前者回调 `null`
 *      （明确清空，服务端据此记住「这是用户的手工表态」），后者回落到清单里的现值。
 *      用 `Object.hasOwn` 判「改过没有」，因为草稿值本身可以是 `null`。
 *   5. **「手工维护」不用 Tag 表达**：改由保存图标变黄 + 提示语承担（少一个 Tag 就少一格宽度竞争）。
 *   6. 中文文案**全部显式给出**：应用没有配 antd 的 locale（见 apps/web-next/app/providers.tsx），
 *      漏给一处就是中英混杂；按钮一律 `autoInsertSpace={false}`（antd 默认会在两个汉字中间插空格，
 *      可访问名随之不再等于文案）。
 *   7. **没有「确定 / 取消」**：这个对话框不做提交 —— 每一次增删与拉取都是**立即生效**的独立请求，
 *      页脚只留一个「关闭」。给它一个「确定」会让人以为不点就不保存。
 */
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Flex, Input, InputNumber, Modal, Table, Tag, Tooltip, Typography } from 'antd';
import type { ProviderModelCapability, ProviderView } from '@aieval/contracts';

export interface ProviderModelsModalProps {
  open: boolean;
  /** 目标供应商；null = 它已不在列表里（对话框给可见原因，不渲染任何操作） */
  provider: ProviderView | null;
  fetchingModels: boolean;
  onClose: () => void;
  onFetchModels: () => void;
  onAddModel: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  /**
   * 设置某条模型的能力两格（窗口 / 输出上限）。`null` = **明确清空** ——
   * 服务端据此把窗口标成「用户手工改过」，下一次拉取不再覆盖它（spec D3）。
   * 两格同一次提交：它们是同一行相邻的两个输入框，用户点一次保存表达的是「这一行就是这样」。
   */
  onSetModelContext: (modelId: string, capability: ProviderModelCapability) => void;
}

/**
 * 模型清单这张表的列宽（px）。**它是 `table-layout: fixed`**（模型列的 `ellipsis` 会把它切成 fixed），
 * 所以每列宽必须自己算够：格子比内容窄时 td 是 `overflow: visible`，内容会**直接压到相邻列上**。
 *
 * 实测过这个坑（在浏览器里量的真实几何，不是推的）：原先输入列写 96px，减左右各 8px 内边距只剩 80px，
 * 而输入框是 7em —— 14px 字号下 **98px** ⇒ 向右溢出 10px，两个输入框互相压、右边界再盖住操作列的图标按钮。
 * 现在的推导：`7em` = 98px + 单元格内边距 16px = 114，取 **116** 留 2px 余量。
 * 字号与内边距都由 antd 的密度/主题给（本仓不手写），故这里把它们当**常量假设**写进推导，
 * 并由 `provider-models-modal.test.tsx` 的列宽守卫盯着（谁把列宽改小到装不下 7em 就会变红）。
 */
export const MODEL_COLUMN_WIDTH = { source: 88, capability: 116, actions: 72 } as const;

/** 弹窗宽度：560 放不下「模型名 + 两个输入 + 两个图标按钮」，模型列会被挤到 140px 只剩省略号 */
export const MODELS_MODAL_WIDTH = 720;

/** 模型来源的中文标签：拉取来的与手工补的必须一眼可分（下一次拉取只会覆盖 fetched 那一批） */
const SOURCE_LABELS: Record<ProviderView['models'][number]['source'], string> = {
  fetched: '自动拉取',
  manual: '手工维护',
};

const SOURCE_COLORS: Record<ProviderView['models'][number]['source'], string> = {
  fetched: 'blue',
  manual: 'gold',
};

/** 表格里两个可编辑的能力格（与 `ProviderModelCapability` 的键一一对应） */
type CapabilityField = 'contextWindow' | 'maxOutputTokens';

export function ProviderModelsModal(props: ProviderModelsModalProps): ReactNode {
  const { open, provider, fetchingModels, onClose, onFetchModels, onAddModel, onRemoveModel, onSetModelContext } =
    props;
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
   * 「手工维护过」这一行的保存提示（用户口径，2026-09-29 二稿）：Tag 删掉之后，
   * 这件事改由**保存图标变黄 + 提示语**承担。tooltip 与可访问名用同一份文案 ——
   * Tooltip 不产生可访问名，两者分开写就会让屏读用户拿到一个「保存窗口」而不知道这是手工行。
   */
  const saveHintOf = (model: ProviderView['models'][number]): string =>
    model.contextWindowSource === 'manual' ? '保存窗口，模型已被手工维护' : '保存窗口';

  return (
    <Modal
      open={open}
      // 标题带上供应商名：从列表里点进来时，人未必记得自己点的是哪一行（两行名字只差一个后缀很常见）
      title={provider === null ? '模型清单' : `模型清单：${provider.name}`}
      onCancel={onClose}
      width={MODELS_MODAL_WIDTH}
      // 不做提交 ⇒ 不给「确定 / 取消」；页脚只留一个明确的出口（右上角的 × 与 Esc 照常可用）
      footer={
        <Button autoInsertSpace={false} onClick={onClose}>
          关闭
        </Button>
      }
    >
      {provider === null ? (
        // 目标在对话框开着时被删掉（别的标签页 / CLI 改配置）：说清去向，而不是给一片空白
        <Alert
          type="warning"
          showIcon
          title="这条供应商已不在列表里"
          description="它可能已被删除或改名：请关闭这个对话框，等列表刷新后重新打开。"
        />
      ) : (
        <Flex vertical gap={8}>
          <Flex align="center" gap={8}>
            <Button
              size="small"
              autoInsertSpace={false}
              loading={fetchingModels}
              // 显式给可访问名：antd 的 loading 图标自带 `role="img" aria-label="loading"`，
              // 拉取中这个名字会变成「loading 拉取模型」—— 同一颗按钮在两种状态下的名字必须一致
              // （与文件头第 6 点同源：图标污染可访问名是本仓反复踩过的一类坑）。
              aria-label="拉取模型"
              onClick={onFetchModels}
            >
              拉取模型
            </Button>
            <Typography.Text type="secondary">拉取只增补，不冲掉手工维护的条目</Typography.Text>
          </Flex>

          {provider.models.length === 0 ? (
            <Typography.Text type="secondary">还没有模型：拉取一次，或手工添加。</Typography.Text>
          ) : (
            /**
             * 模型清单 = small Table（用户口径 2026-09-29 二稿）：列序 **模型 ｜ 来源 ｜ 输入 ｜ 输出 ｜ 操作**，
             * **表头隐藏**（列的含义由输入框占位符与按钮承担），操作列**右对齐**。五条刻意的取舍：
             *   · **模型列开 `ellipsis` 且不套 `code`**：网关的模型名可以很长（`vendor/very-long-name`），
             *     撑破弹窗比截断更糟；`ellipsis` 会让 antd 把 tableLayout 切成 fixed，其余列必须给宽度；
             *   · **两格能力各占一列、都是输入框、都 7em**：值只在输入框里（原先「窗口 Tag + 输入框」
             *     把同一个值显示两遍）；
             *   · **操作用图标按钮 + 右对齐**：两个汉字的文字按钮在这一列里占掉半张表，
             *     图标 + Tooltip 把宽度还给内容；可访问名仍靠 `aria-label`（Tooltip 不产生可访问名）；
             *   · **「手工维护」不再用 Tag**：改由保存图标变黄 + 提示语承担（`saveHintOf`），
             *     少一个 Tag 就少一格宽度竞争；
             *   · **表头隐藏**：五列的含义在占位符里已经写全（窗口 token 数 / 输出上限），
             *     表头只是把同样的话再说一遍，还占掉一行高度。
             */
            <Table
              size="small"
              rowKey="id"
              // 对话框里不分页：清单最多几十条，翻页只会把「我正要改的那一行」藏起来
              pagination={false}
              showHeader={false}
              dataSource={provider.models}
              columns={[
                {
                  title: '模型',
                  dataIndex: 'id',
                  ellipsis: true,
                  // 不套 `code`（用户口径「去掉 tag 包裹」）：模型名本身就是纯文本，等宽字形反而更难读长名
                  render: (_value, model) => model.id,
                },
                {
                  title: '来源',
                  width: MODEL_COLUMN_WIDTH.source,
                  render: (_value, model) => (
                    <Tag color={SOURCE_COLORS[model.source]}>{SOURCE_LABELS[model.source]}</Tag>
                  ),
                },
                {
                  title: '输入',
                  width: MODEL_COLUMN_WIDTH.capability,
                  render: (_value, model) => (
                    <InputNumber
                      size="small"
                      min={1}
                      style={{ width: '7em' }}
                      aria-label={`${model.id} 的上下文窗口`}
                      placeholder="窗口 token 数"
                      value={draftOf(model, 'contextWindow')}
                      onChange={(value) => setDraft(model.id, 'contextWindow', value ?? null)}
                    />
                  ),
                },
                {
                  title: '输出',
                  width: MODEL_COLUMN_WIDTH.capability,
                  render: (_value, model) => (
                    <InputNumber
                      size="small"
                      min={1}
                      style={{ width: '7em' }}
                      aria-label={`${model.id} 的最大输出`}
                      placeholder="输出上限"
                      value={draftOf(model, 'maxOutputTokens')}
                      onChange={(value) => setDraft(model.id, 'maxOutputTokens', value ?? null)}
                    />
                  ),
                },
                {
                  title: '操作',
                  width: MODEL_COLUMN_WIDTH.actions,
                  align: 'right',
                  render: (_value, model) => (
                    <Flex align="center" justify="flex-end" gap={2}>
                      <Tooltip title={saveHintOf(model)}>
                        <Button
                          size="small"
                          // 手工维护过的行：图标变黄（antd 的预设色，随主题走）；`color` 与 `variant` 必须成对给
                          color={model.contextWindowSource === 'manual' ? 'gold' : 'default'}
                          variant="text"
                          icon={<SaveOutlined aria-hidden />}
                          aria-label={saveHintOf(model)}
                          onClick={() =>
                            onSetModelContext(model.id, {
                              contextWindow: draftOf(model, 'contextWindow'),
                              maxOutputTokens: draftOf(model, 'maxOutputTokens'),
                            })
                          }
                        />
                      </Tooltip>
                      <Tooltip title="移除">
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined aria-hidden />}
                          aria-label="移除"
                          onClick={() => onRemoveModel(model.id)}
                        />
                      </Tooltip>
                    </Flex>
                  ),
                },
              ]}
            />
          )}

          <Flex gap={8}>
            <Input
              size="small"
              value={modelInput}
              placeholder="手工添加模型名，如 deepseek-chat"
              onChange={(event) => setModelInput(event.target.value)}
              onPressEnter={addModel}
            />
            <Button
              color="default"
              variant="dashed"
              size="small"
              icon={<PlusOutlined aria-hidden />}
              autoInsertSpace={false}
              onClick={addModel}
            >
              添加
            </Button>
          </Flex>
        </Flex>
      )}
    </Modal>
  );
}
