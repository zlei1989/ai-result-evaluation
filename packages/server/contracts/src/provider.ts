/**
 * 供应商契约：协议类型、落盘形态、下行形态与增删改入参。
 * 三个必须成立的口径：
 *   1. 协议类型是「模型能否驱动某智能体」的唯一判据，故它是枚举而不是自由字符串；
 *   2. 落盘形态含**明文** apiKey（服务端要原 token 才能代调供应商 API），因此它只在服务端内部流转；
 *   3. 下行形态（ProviderView）用 omit 掉 apiKey 而不是「记得别传」——字段的存在与否由类型保证。
 */
import { z } from 'zod';

/**
 * 协议类型：openai 兼容 / anthropic 兼容。
 * 它决定**文本调用怎么接线**：`openai` 走 **Responses**（`POST {地址}/v1/responses`）、
 * `anthropic` 走 **Messages**（`POST {地址}/v1/messages`）——智能体驱动与 evaluator 的 `text-api`
 * 两条通路读同一个判据，故同一个供应商地址在两侧落到同一族端点上（`/v1` 的归一化也同一把尺）。
 * 它**不决定能不能拉模型清单**：清单按地址形态兜底（`{地址}/models` → 404 再依次回退 `{地址}/v1/models`、
 * 站点根的 `/models` 与 `/v1/models`，见 api 的 `modelListCandidates`）。「Anthropic 没有 /models 接口，
 * 模型名只能手工维护」那条只对 api.anthropic.com 成立，自建网关普遍在版本段上提供 OpenAI 风格的清单接口
 * 只是历史上的说法；而 `/anthropic` 一类 Messages 根、`/api/v1` 一类带前缀的地址，清单接口往往挂在站点根上
 * ⇒ 清单候选必须包含站点根那一批。
 */
export const ProtocolTypeSchema = z.enum(['openai', 'anthropic']);
export type ProtocolType = z.infer<typeof ProtocolTypeSchema>;

/** 协议类型的中文标签：设置页与候选池提示共用，避免两处各写一份 */
export const PROTOCOL_LABELS: Record<ProtocolType, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
};

/**
 * **关闭思考**的档名：契约、界面与三家适配器都用这一个值。
 * 它是**本仓统一的关闭档**，不是任何一家厂商的档名——三家的「关闭」在 wire 上根本不是同一个东西，
 * 厂商拼写由各适配器自己翻：claude = `thinking: { type: 'disabled' }`；codex = `none`；
 * dsh 收的也是 `off`（它把这一档在 overlay 里映射成「不发 reasoning」⇒ harness 落到显式关闭）。
 * 它同时是候选池里那个不受上游声明裁剪的档（见 `./effort` 的 `intersectEfforts`）。
 */
export const EFFORT_OFF = 'off';

/**
 * 模型清单条目：source 区分自动拉取与手工维护（拉取是合并，不能冲掉手工项）。
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
   * 空 / 缺省 = 上游没说（实测 47 条里 21 条如此）⇒ 界面给该家**完整档位域**（
   * 见 `contracts/src/effort.ts` 的 `intersectEfforts`）。**改前是「界面上只有『默认』可选」**——那条口径让
   * 「关闭思考」这个档位在本机两个 provider 上永远点不到（它们都没声明过这一格）。
   * **不做归一化、不做「翻译成各家方言」**：档位名是上游的词汇，交集与方言都在别处。
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

/** 下行形态：apiKey 已掩码（「落盘后列表只显示掩码」） */
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

/** 单条模型的增删入参（models 路由）：与落盘条目同形，避免两套字段名 */
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
 * —— 它同样要把 `contextWindowSource` 置成 manual（清空 = 别用上游那个数）。
 * `maxOutputTokens` 可选是为了兼容只改窗口的老客户端。
 */
export const ProviderModelContextSchema = ProviderModelCapabilitySchema.extend({
  id: z.string().min(1),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
});
export type ProviderModelContextInput = z.infer<typeof ProviderModelContextSchema>;

/**
 * 上游 /models 拉取到的**候选**模型（预览形态）。与清单条目（`ProviderModel`）的差别：
 * 没有 `source` —— 要不要进清单由用户在预览对话框里挑选后才定，这里只忠实转述「上游说了什么」。
 * 四格能力与 `ProviderModel` 同名同约束：预览展示与提交入参共用同一份形状，
 * 界面上看到的数就是提交后落盘的数（所见即所得，不引入第二套字段名）。
 */
export const ProviderModelPreviewSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportedEfforts: z.array(z.string().min(1)).optional(),
  recommendedEffort: z.string().min(1).optional(),
});
export type ProviderModelPreview = z.infer<typeof ProviderModelPreviewSchema>;

/** 拉取预览的响应体：`{ models: [...] }`（对象包一层，给后续追加分页 / 来源统计留位） */
export const ProviderModelPreviewListSchema = z.object({
  models: z.array(ProviderModelPreviewSchema),
});
export type ProviderModelPreviewList = z.infer<typeof ProviderModelPreviewListSchema>;

/**
 * 挑选后的提交入参（`models/import` 路由）：条目形状与预览一致（前端把勾选的候选原样回传）。
 * **至少一条**：空提交没有语义，界面上「加入清单」在零勾选时本就不可点。
 * `source` 不在入参里：提交进来的条目一律按 `fetched` 合并 —— `manual` 的唯一入口
 * 是手工增删（与 `manualModels` 同一条口径，不许前端自己声明来源）。
 */
export const ProviderModelsImportSchema = z.object({
  models: z.array(ProviderModelPreviewSchema).min(1),
});
export type ProviderModelsImport = z.infer<typeof ProviderModelsImportSchema>;
