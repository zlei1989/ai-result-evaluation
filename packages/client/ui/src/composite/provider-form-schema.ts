/**
 * 供应商弹窗的 form-local 校验：字段级中文文案 + **两态密钥规则**。
 *
 * 为什么不整份复用 `ProviderCreateSchema`：那一份的 `apiKey` 是**无条件** `min(1)`，而编辑态留空
 * 表示「沿用原密钥」（服务端的空串语义见 `api/providers.ts`）——只有 `ProviderPatchSchema` 的
 * `.partial()` 与编辑态同形。两态由调用方以 `isEdit` 回调给出：schema 只创建一次，
 * 校验那一刻才问「现在是不是编辑态」，避免表单挂载后切换模式时 resolver 还停在旧规则上。
 *
 * 空串与纯空白各给一句（不是一句兜底）：前者是「没填」，后者是「填了但等于没填」，
 * 用户看到的话必须能指出他该改哪里。`criteriaMode` 保持 RHF 的默认 `firstError`，
 * 于是空串上只出现「请填写 API 密钥」——与改造前 async-validator 的行为逐字一致。
 */
import { z } from 'zod';
import type { ProtocolType } from '@aieval/contracts';

/** 表单内部值：`apiKey` 为空串表示编辑态「不修改」 */
export interface ProviderFormInput {
  name: string;
  protocolType: ProtocolType;
  baseUrl: string;
  apiKey: string;
}

/** 两态共用的字段规则；`isEdit` 只在密钥那一格上生效 */
export function providerFormSchema(isEdit: () => boolean) {
  return z
    .object({
      name: z.string().min(1, '请填写名称'),
      // 这一条今天不可能触发（新建初值就是 openai，Radio 又不能取消选中），补 message 只是把
      // zod 的英文默认出口堵死——将来初值一变，界面不会突然冒出一句英文
      protocolType: z.enum(['openai', 'anthropic'], {
        errorMap: () => ({ message: '请选择协议类型' }),
      }),
      baseUrl: z.string().min(1, '请填写 API 地址'),
      apiKey: z.string(),
    })
    .superRefine((values, ctx) => {
      if (isEdit()) return;
      if (values.apiKey === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKey'], message: '请填写 API 密钥' });
        return;
      }
      // 只有空白：`required` 放行、真正落盘的是一个「看着像配好了、实际永远 401」的密钥
      if (values.apiKey.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKey'], message: 'API 密钥不能只有空格' });
      }
    });
}

export type ProviderFormSchema = ReturnType<typeof providerFormSchema>;
export type ProviderFormOutput = z.output<ProviderFormSchema>;
