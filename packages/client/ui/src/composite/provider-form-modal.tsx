'use client';

/**
 * 供应商新增 / 编辑弹窗：**只有四个字段** —— 名称 + 协议 Radio + API 地址 + 密钥 Password。
 * 纯展示：不调接口，所有动作走回调；异步与错误提示留在调用方（本组件不认识 message）。
 *
 * 五个刻意的取舍（每条都对应一个真实会伤到用户的情形）：
 *   1. **模型清单不在这里**：它已单独提成 `provider-models-modal.tsx`，
 *      入口是列表每行的「模型」按钮。理由是两者的使用频率差一个量级 —— 清单维护是高频动作，
 *      而接线字段很少改；挤在一起的结果是「改个模型名要先把整张表单拉出来」。
 *      **但入口必须在这里可见**：本弹窗留一条 Alert 指向那个按钮，不能让用户自己去找
 *      （把一块功能搬走却不留路标，读起来就是「功能没了」）；
 *   2. **编辑态密钥框留空 = 不修改**（占位符回显当前掩码）：服务端不把掩码当密钥，
 *      要求用户为了改个名字重填一遍密钥是不可接受的；
 *   3. **表单用 `forceRender` 常挂载 + effect 重灌初值**，且重灌只依赖 `open` 与被编辑者的 id：
 *      列表每次刷新都会给出新的 ProviderView 对象，若依赖它，用户打字中途就会被清空输入；
 *   4. **按钮一律 `autoInsertSpace={false}`**（含 Modal 的页脚按钮）：antd 默认会给**两个汉字**的
 *      标签中间插一个空格（`保 存`），可访问名随之不再等于文案 —— 屏幕阅读器把「保存」读成两个字，
 *      按名字定位按钮也会失配；
 *   5. **模型能否拉取不由协议判定**（随「模型」按钮一起搬走）：
 *      「anthropic 一律禁用」的依据是「该协议没有 /models 接口」，而多数自建网关在版本段上
 *      同时提供 OpenAI 风格的清单接口 —— 服务端已按地址形态兜底（`{地址}/models` 404 再依次回退
 *      `{地址}/v1/models` 与站点根的两条）。这条判据现在住在模型对话框里，那里也没有禁用：
 *      将来若真出现禁用，原因要写成**可见文本**而不是只挂在 Tooltip 上（触屏与键盘用户看不到 hover 浮层）。
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Alert, Form, Input, Modal, Radio } from 'antd';
import { PROTOCOL_LABELS, type ProtocolType, type ProviderView } from '@aieval/contracts';

/** 表单提交载荷：`apiKey` 为空串表示「不修改密钥」（编辑态留空），新建态由表单校验挡下空串 */
export interface ProviderFormValues {
  name: string;
  protocolType: ProtocolType;
  baseUrl: string;
  apiKey: string;
}

export interface ProviderFormModalProps {
  open: boolean;
  /** 编辑态传当前供应商（编辑态只需要它的字段与掩码；模型清单不在这里维护）；新建态传 null */
  initial: ProviderView | null;
  saving: boolean;
  onSubmit: (values: ProviderFormValues) => void;
  onCancel: () => void;
}

/** 新建态的空白初值：协议默认 openai（多数网关是 OpenAI 兼容） */
const EMPTY: ProviderFormValues = { name: '', protocolType: 'openai', baseUrl: '', apiKey: '' };

/** 弹窗宽度：四个字段一列排下来，560 就够（模型清单那张表已搬走） */
export const MODAL_WIDTH = 560;

export function ProviderFormModal(props: ProviderFormModalProps): ReactNode {
  const { open, initial, saving, onSubmit, onCancel } = props;
  const [form] = Form.useForm<ProviderFormValues>();
  const isEdit = initial !== null;
  const initialId = initial?.id ?? null;

  // 依赖里只放 open 与 id，**不放 initial 对象本身**：列表每次刷新（例如刚加了一个模型）都会给出
  // 一个新的 ProviderView 对象，把它放进依赖会让 effect 在用户打字中途重灌表单、清掉没保存的输入。
  useEffect(() => {
    if (!open) return;
    // 先 resetFields 再 setFieldsValue：只 setFieldsValue 会把上一次失败的校验红字留在界面上
    form.resetFields();
    form.setFieldsValue(
      initial === null
        ? EMPTY
        : { name: initial.name, protocolType: initial.protocolType, baseUrl: initial.baseUrl, apiKey: '' },
    );
  }, [open, initialId, form]);

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑供应商' : '添加供应商'}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => form.submit()}
      onCancel={onCancel}
      width={MODAL_WIDTH}
      // 「保存」/「取消」都是两个汉字：不关掉 autoInsertSpace，可访问名会是「保 存」/「取 消」
      okButtonProps={{ autoInsertSpace: false }}
      cancelButtonProps={{ autoInsertSpace: false }}
      // 表单要始终连着 useForm 实例，否则首次打开时 setFieldsValue 落空（值灌不进去）。
      // 这里刻意**不用** destroyOnHidden：与 forceRender 叠加会在「打开」这一帧留下
      // 「表单尚未挂载」的窗口，重灌初值就变成了随机成功。
      forceRender
    >
      <Form form={form} layout="vertical" size="small" initialValues={EMPTY} onFinish={(values) => onSubmit(values)}>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填写名称' }]}>
          <Input placeholder="如「DeepSeek 官方」" />
        </Form.Item>

        {/* 应用没有配 antd locale，缺 message 的规则会渲染英文默认文案（`Please enter 协议类型`）：
            这条规则今天不可能触发（新建初值就是 openai，Radio 又不能取消选中），补 message 只是
            把英文默认出口堵死——将来初值一变，界面不会突然冒出一句英文。 */}
        <Form.Item name="protocolType" label="协议类型" rules={[{ required: true, message: '请选择协议类型' }]}>
          <Radio.Group>
            <Radio value="openai">{PROTOCOL_LABELS.openai}</Radio>
            <Radio value="anthropic">{PROTOCOL_LABELS.anthropic}</Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item
          name="baseUrl"
          label="API 地址"
          rules={[{ required: true, message: '请填写 API 地址' }]}
          extra="OpenAI 兼容填到 /v1，Anthropic 兼容填到 /anthropic"
        >
          <Input placeholder="https://api.deepseek.com/v1" />
        </Form.Item>

        <Form.Item
          name="apiKey"
          label="API 密钥"
          // 编辑态不要求重填：留空表示沿用原密钥（服务端的空串/纯空白语义见 api/providers.ts）
          // 新建态两条规则：
          //   ① required 只判空串（`${label} is required` 会被替换成下面的中文）；
          //   ② whitespace 只判纯空白 —— 少了它，`'   '` 能直接过校验，到服务端才被拒（多一次往返），
          //      而在没有这道规则之前它更糟：服务端会把空格当成一次真实的密钥替换。
          // 两条规则的失败不会同时出现：async-validator 对空串会跳过 whitespace 检查。
          rules={
            isEdit
              ? []
              : [
                { required: true, message: '请填写 API 密钥' },
                { whitespace: true, message: 'API 密钥不能只有空格' },
              ]
          }
        >
          <Input.Password
            autoComplete="off"
            placeholder={isEdit ? `留空表示不修改（当前：${initial.apiKeyMasked}）` : 'sk-…'}
          />
        </Form.Item>

        {/* 模型清单已搬进独立的对话框（文件头第 1 点）：这里只留**可见的路标**。
            文案分两态：新建态还没有 id（列表里也还没有这一行），编辑态则指向列表那一行的按钮。 */}
        {isEdit ? (
          <Alert
            type="info"
            showIcon
            title="模型清单在列表的「模型」按钮里维护"
            description="拉取模型、手工增删、窗口与输出上限都在那个对话框里；这里只改名称、协议类型、API 地址与密钥。"
          />
        ) : (
          <Alert
            type="info"
            showIcon
            title="保存后可维护模型清单"
            description="新建时还没有供应商 id；保存后到列表里点这一行的「模型」按钮，在对话框里拉取或手工增删。"
          />
        )}
      </Form>
    </Modal>
  );
}
