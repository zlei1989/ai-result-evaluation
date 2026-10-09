/**
 * 供应商契约：协议类型、落盘形态、下行形态与增删改入参。
 * 三个必须成立的口径：
 *   1. 协议类型是「模型能否驱动某智能体」的唯一判据（spec §3 F1），故它是枚举而不是自由字符串；
 *   2. 落盘形态含**明文** apiKey（服务端要原 token 才能代调供应商 API），因此它只在服务端内部流转；
 *   3. 下行形态（ProviderView）用 omit 掉 apiKey 而不是「记得别传」——字段的存在与否由类型保证。
 */
import { z } from 'zod';

/**
 * 协议类型：openai 兼容 / anthropic 兼容。
 * 它只决定**文本调用怎么接线**（`/chat/completions` vs `/v1/messages`，见 evaluator 的 `text-api`），
 * **不决定能不能拉模型清单**：清单按地址形态兜底（`{地址}/models` → 404 再依次回退 `{地址}/v1/models`、
 * 站点根的 `/models` 与 `/v1/models`，见 api 的 `modelListCandidates`）。原先「Anthropic 没有 /models 接口，
 * 模型名只能手工维护」那条只对 api.anthropic.com 成立，自建网关普遍在版本段上提供 OpenAI 风格的清单接口
 * （2026-09-26 修订）；而 `/anthropic` 一类 Messages 根、`/api/v1` 一类带前缀的地址，清单接口往往挂在站点根上
 * （2026-09-30 补根回退）。
 */
export const ProtocolTypeSchema = z.enum(['openai', 'anthropic']);
export type ProtocolType = z.infer<typeof ProtocolTypeSchema>;

/** 协议类型的中文标签：设置页与候选池提示共用，避免两处各写一份 */
export const PROTOCOL_LABELS: Record<ProtocolType, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
};

/**
 * 模型清单条目：source 区分自动拉取与手工维护（拉取是合并，不能冲掉手工项，见 spec §6.1）。
 *
 * 后三格是「模型能力」，全部可选 —— **缺省 = 未知**，绝不兜底成 0 或某个默认窗口：
 *   · `contextWindow`：上下文窗口（token）。原生 anthropic / openai 的 /models 不带它，
 *     自建网关也未必给（实测 likecode 47 条里 46 条有、gpt-image-2 没有）；
 *   · `maxOutputTokens`：单次输出上限。今天只有 dsh 的目录用得上（cc / codex 的方言里没有对应项）；
 *   · `contextWindowSource`：**逐字段**来源。'manual' = 用户在设置页改过（或清空过），拉取不得覆盖。
 *     它与条目自身的 `source` 是两件事：fetched 条目一样可以被手工改窗口。值可以缺席 ——
 *     「清空」也是一次明确的表态（语义是「别用上游那个数」），而不只是「别覆盖这个数」。
 */
export const ProviderModelSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['fetched', 'manual']),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  contextWindowSource: z.enum(['fetched', 'manual']).optional(),
  /**
   * 上游声明的思考强度档位（原样保留上游的顺序与拼写：`low` / `medium` / `high` / `xhigh` / `max` …）。
   * 空 / 缺省 = 上游没说（实测 47 条里 21 条如此）⇒ 界面给该家**完整档位域**（2026-10-06 起，
   * 见 `contracts/src/effort.ts` 的 `intersectEfforts`）。**改前是「界面上只有『默认』可选」**——那条口径让
   * 「关闭思考」这个档位在本机两个 provider 上永远点不到（它们都没声明过这一格）。
   * **不做归一化、不做「翻译成各家方言」**：档位名是上游的词汇，交集与方言都在别处（spec D1 / D10）。
   */
  supportedEfforts: z.array(z.string().min(1)).optional(),
  /** 上游推荐的档位；不在 supportedEfforts 里时按「没有推荐」处置（不猜） */
  recommendedEffort: z.string().min(1).optional(),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/** 落盘形态：含明文 apiKey，只在服务端内部流转 */
export const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocolType: ProtocolTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  models: z.array(ProviderModelSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/** 下行形态：apiKey 已掩码（spec §6.1「落盘后列表只显示掩码」） */
export const ProviderViewSchema = ProviderSchema.omit({ apiKey: true }).extend({ apiKeyMasked: z.string() });
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/**
 * 密钥掩码：保留前 3 后 4，中间用 `*` 填满。
 * 长度 < 8 时全掩码——前 3 与后 4 会重叠，逐字保留等于把密钥原样吐回界面。
 * 空串返回空串：不制造 `****` 这种「看起来配了一个密钥」的假象。
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey === '') return '';
  if (apiKey.length < 8) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 3)}${'*'.repeat(apiKey.length - 7)}${apiKey.slice(-4)}`;
}

/** 新增供应商入参：models 缺省为空数组（新供应商必然还没有模型清单） */
export const ProviderCreateSchema = z.object({
  name: z.string().min(1),
  protocolType: ProtocolTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  models: z.array(ProviderModelSchema).default([]),
});
export type ProviderCreate = z.infer<typeof ProviderCreateSchema>;

/** 部分更新：所有字段可选；空对象合法（无改动） */
export const ProviderPatchSchema = ProviderCreateSchema.partial();
export type ProviderPatch = z.infer<typeof ProviderPatchSchema>;

/** 单条模型的增删入参（spec §8 的 models 路由）：与落盘条目同形，避免两套字段名 */
export const ProviderModelInputSchema = ProviderModelSchema;
export type ProviderModelInput = z.infer<typeof ProviderModelInputSchema>;

/**
 * 模型能力的两格（设置页的行内编辑器 / 数据层的入参）：`null` = **明确清空**。
 * 为什么两格同进同出：它们是同一张表格里相邻的两个可编辑列，用户点一次「保存窗口」
 * 表达的是「这一行的能力就是这样」——分两次请求只会让中间态（只存了窗口、输出还是旧的）有机会落盘。
 * 它同时是 ui 与 client 两个包共用的形状（两侧都只依赖 contracts，谁也不依赖谁）。
 */
export const ProviderModelCapabilitySchema = z.object({
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
});
export type ProviderModelCapability = z.infer<typeof ProviderModelCapabilitySchema>;

/**
 * 单条模型的窗口入参（设置页的行内编辑器）：`contextWindow: null` = **明确清空**。
 * 为什么用 null 而不是「字段缺席」：缺席与「不改」在语义上不可区分，而清空是一次真实意图
 * —— 它同样要把 `contextWindowSource` 置成 manual（见 spec D3：清空 = 别用上游那个数）。
 * `maxOutputTokens` 可选是为了兼容只改窗口的老客户端。
 */
export const ProviderModelContextSchema = ProviderModelCapabilitySchema.extend({
  id: z.string().min(1),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
});
export type ProviderModelContextInput = z.infer<typeof ProviderModelContextSchema>;
