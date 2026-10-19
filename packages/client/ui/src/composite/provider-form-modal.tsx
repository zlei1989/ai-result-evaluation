'use client';

/**
 * 供应商新增 / 编辑弹窗：**只有四个字段** —— 名称 + 协议单选 + API 地址 + 密钥。
 * 纯展示：不调接口，所有动作走回调；异步与错误提示留在调用方（本组件不认识提示通道）。
 *
 * 六个刻意的取舍（每条都对应一个真实会伤到用户的情形）：
 *   1. **模型清单不在这里**：它已单独提成 `provider-models-modal.tsx`，
 *      入口是列表每行的「模型」按钮。理由是两者的使用频率差一个量级 —— 清单维护是高频动作，
 *      而接线字段很少改；挤在一起的结果是「改个模型名要先把整张表单拉出来」。
 *      **但入口必须在这里可见**：本弹窗留一条说明指向那个按钮，不能让用户自己去找
 *      （把一块功能搬走却不留路标，读起来就是「功能没了」）；
 *   2. **编辑态密钥框留空 = 不修改**（占位符回显当前掩码）：服务端不把掩码当密钥，
 *      要求用户为了改个名字重填一遍密钥是不可接受的；
 *   3. **表单值只在打开 / 换目标时重灌**，且重灌只依赖 `open` 与被编辑者的 id：
 *      列表每次刷新都会给出新的 ProviderView 对象，若依赖它，用户打字中途就会被清空输入；
 *   4. **保存按钮的可访问名与可见文案逐字一致**（「保存」两个汉字不插空格）：
 *      屏读器按名字念、用例按名字定位，两者必须同源；
 *   5. **模型能否拉取不由协议判定**（随「模型」按钮一起搬走）：
 *      「anthropic 一律禁用」的依据是「该协议没有 /models 接口」，而多数自建网关在版本段上
 *      同时提供 OpenAI 风格的清单接口 —— 服务端已按地址形态兜底（`{地址}/models` 404 再依次回退
 *      `{地址}/v1/models` 与站点根的两条）。这条判据现在住在模型对话框里，那里也没有禁用；
 *   6. **地址只要求填站点根**：`openai` 打 Responses（`{地址}/v1/responses`）、`anthropic` 打
 *      Messages（`{地址}/v1/messages`）；缺 `/v1` 由服务端自动补、多写也不会叠。占位符刻意只写
 *      站点根——写成 `…/v1` 会让人以为路径要自己拼对，拼错只报上游 404，而这里一个字都不会提示。
 *
 * 表单状态由 react-hook-form 持有，校验规则全在 `provider-form-schema.ts`（zod resolver）：
 * 组件里只有绑定与渲染，没有第二套规则。
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { PROTOCOL_LABELS, type ProtocolType, type ProviderView } from '@aieval/contracts';
import type { z } from 'zod';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel, FieldTitle } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { providerFormSchema } from './provider-form-schema';
import { SettingsAlert } from './settings-alert';

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

/** 新建态的空白初值：协议默认 openai（本仓的 openai 是 Responses 接口） */
const EMPTY: ProviderFormValues = { name: '', protocolType: 'openai', baseUrl: '', apiKey: '' };

/** 弹窗宽度：四个字段一列排下来，560 就够（模型清单那张表已搬走） */
export const MODAL_WIDTH = 560;

/** 单选项一行：标签包住圆圈与文案，点文字也能选中（原生 radio 的 label 语义） */
function ProtocolOption({ value, label }: { value: ProtocolType; label: string }): ReactNode {
  return (
    <label className="flex items-center gap-2 text-sm">
      <RadioGroupItem value={value} />
      {label}
    </label>
  );
}

export function ProviderFormModal(props: ProviderFormModalProps): ReactNode {
  const { open, initial, saving, onSubmit, onCancel } = props;
  const isEdit = initial !== null;
  const initialId = initial?.id ?? null;

  /**
   * schema 只建一次、校验那一刻才问 `isEdit`：新建 / 编辑共用同一个 form 实例
   * （弹窗的输入状态常驻），密钥规则必须跟着当前模式走，不能停在首次渲染时的那个分支上。
   */
  const schema = providerFormSchema(() => isEdit);
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY,
  });
  const { control, handleSubmit, reset } = form;

  // 依赖里只放 open 与 id，**不放 initial 对象本身**：列表每次刷新（例如刚加了一个模型）都会给出
  // 一个新的 ProviderView 对象，把它放进依赖会让 effect 在用户打字中途重灌表单、清掉没保存的输入。
  useEffect(() => {
    if (!open) return;
    // `reset` 一步重灌：既换值也清掉上一次失败的校验红字（这正是「打开时不该带着旧红字」的要求）
    reset(
      initial === null
        ? EMPTY
        : { name: initial.name, protocolType: initial.protocolType, baseUrl: initial.baseUrl, apiKey: '' },
    );
  }, [open, initialId, reset]);

  const submit = handleSubmit((values) => onSubmit(values));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 只有「关掉」这一支交给调用方：打开由外部状态驱动，这里不接
        if (!next) onCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-[560px]"
        style={{ maxWidth: MODAL_WIDTH }}
        data-testid="provider-form-dialog"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑供应商' : '添加供应商'}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <Controller
            control={control}
            name="name"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="provider-name">名称</FieldLabel>
                <Input
                  {...field}
                  id="provider-name"
                  aria-invalid={fieldState.invalid}
                  placeholder="如「DeepSeek 官方」"
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          {/* 协议是单选组：标签用 `FieldTitle`（不指向某个 input 的 `<label>`），
              可访问名由 RadioGroup 的 `aria-label` 承担 */}
          <Controller
            control={control}
            name="protocolType"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldTitle>协议类型</FieldTitle>
                <RadioGroup
                  value={field.value}
                  onValueChange={(value) => field.onChange(value)}
                  aria-label="协议类型"
                  aria-invalid={fieldState.invalid}
                  className="flex flex-row gap-4"
                >
                  <ProtocolOption value="openai" label={PROTOCOL_LABELS.openai} />
                  <ProtocolOption value="anthropic" label={PROTOCOL_LABELS.anthropic} />
                </RadioGroup>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          <Controller
            control={control}
            name="baseUrl"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="provider-base-url">API 地址</FieldLabel>
                <Input
                  {...field}
                  id="provider-base-url"
                  aria-invalid={fieldState.invalid}
                  placeholder="https://api.deepseek.com"
                />
                <FieldDescription>
                  OpenAI Responses API / Anthropic Messages API。地址填到站点即可，不用带 /v1，请求路径由程序自动补全
                </FieldDescription>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          <Controller
            control={control}
            name="apiKey"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="provider-api-key">API 密钥</FieldLabel>
                <Input
                  {...field}
                  id="provider-api-key"
                  type="password"
                  aria-invalid={fieldState.invalid}
                  autoComplete="off"
                  placeholder={isEdit ? `留空表示不修改（当前：${initial.apiKeyMasked}）` : 'sk-…'}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          {/* 模型清单已搬进独立的对话框（文件头第 1 点）：这里只留**可见的路标**。
              文案分两态：新建态还没有 id（列表里也还没有这一行），编辑态则指向列表那一行的按钮。 */}
          {isEdit ? (
            <SettingsAlert
              tone="info"
              title="模型清单在列表的「模型」按钮里维护"
              description="拉取模型、手工增删、窗口与输出上限都在那个对话框里；这里只改名称、协议类型、API 地址与密钥。"
            />
          ) : (
            <SettingsAlert
              tone="info"
              title="保存后可维护模型清单"
              description="新建时还没有供应商 id；保存后到列表里点这一行的「模型」按钮，在对话框里拉取或手工增删。"
            />
          )}

          <DialogFooter>
            <Button variant="outline" type="button" onClick={onCancel}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
