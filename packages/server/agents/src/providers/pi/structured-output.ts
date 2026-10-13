/**
 * pi 的原生结构化输出通道：**装配期预检 + 工具参数即权威 schema + 把参数投影回最终答复**。
 *
 * 本家的通道走 pi 的 `constrainedSampling: { type: 'json_schema', strict: 'require' }`
 * （`ToolDefinition` 上的公开字段）：pi 建请求时把这份 schema 交给 `makeStrictJsonSchema` 转成
 * strict 形态，作为 `tools[].function.parameters` 出站，并带上 `strict: true`——形状由**厂商侧强制**。
 * 产物落在**工具调用的参数**里（不走正文），所以本模块的第三件事就是把那份参数投影回最终答复。
 *
 * 三条口径（每一条都对应一类只在真机上才看得见的缺陷）：
 *
 * 1. **永远把调用方原 schema 交给工具参数，禁止预归一化**。
 *    pi 的 `makeStrictJsonSchema` **非幂等**：含「可选的对象型 / 数组型属性」的 schema，其 strict
 *    产物（该属性被改写成 `anyOf: [<原属性>, {type:'null'}]`）再喂一次会被它自己拒
 *    （`object and array unions are unsupported`）。所以本模块只**遍历**、只**判断**，
 *    绝不改写、绝不缓存 strict 产物——改写在这里的代价不是「多一次转换」，而是整轮零出站请求。
 *
 * 2. **预检在装配期做，判据与厂商同一份**。`strict: 'require'` 的失败姿态是「零出站请求 +
 *    `stopReason: 'error'`、43 毫秒收场」，`prompt()` 也不会 reject ⇒ 从界面上看就是「这一行
 *    莫名其妙失败了」。故把这件事提前到装配期由我们显式裁定：落在子集内就走原生通道（`'require'`），
 *    落在子集外就**由我们显式降级**（工具改声明成 `'prefer'` + 调用方落 WARN + 走填充层），
 *    而不是让厂商在第一次请求时炸。本模块因此把「会不会被拒」按两条 wire 的差集各写一遍
 *    （见 `preflightStructuredOutput`）。
 *
 *    降级档**仍然声明那件工具**：`'prefer'` 的语义是「拿不到 strict 就静默回落成非 strict 声明」
 *    （`constrained-sampling.js` 的 `resolveJsonSchemaStrictSampling`：转换失败且不是 `'require'`
 *    就返回 `undefined`），工具照旧出站、模型照旧可以调它。代价是那一档的 schema **没有厂商侧强制**
 *    ⇒ 上报口径必须跟着分开（见 `structuredOutputApplied` 的 `enforced` 那一维）。
 *
 * 3. **降级不收窄 schema**。预检失败时那份 schema 仍然原样进提示词（`buildStructuredOutputInstruction`）
 *    与修正轮——四家拿到的题目必须逐字相同，为某一家改窄 schema 会让「同一道题四家表现不同」
 *    多一个与题目无关的解释变量。工具参数那一份也**原样**交给厂商（不预先算成 strict 形态，见第 1 条）；
 *    非 strict 档下 anthropic 那条 wire 只取根节点的 `type` / `properties` / `required`
 *    （`convertTools` 的 `legacyInputSchema`），故**提示词那一份才是完整的题目**。
 *
 * 已知边界（写在 `docs/protocols/pi.md` 的同一节里，改这里时同步）：`ToolChoice` 只有
 * `auto | none` ⇒ **模型可以不调用这个工具**（那时形状没有任何厂商保证，最终答复来自正文）。
 * 这一格由 `StructuredOutputAdoption.forcedReply` 如实交给上报口径，而不是在这里假装成功。
 */
import { asRecord } from '../../json';
import { asSchemaObject, buildStructuredOutputInstruction } from '../../structured-output';
import type { ProtocolType } from '../../types';

/**
 * 结构化输出工具的**参数名**（也是 `piRequestToolNames` 会读到的工具名）。
 * 名字与另三家无关：它只是本行 `tools[]` 里的一件，不参与跨家比对。
 */
export const PI_STRUCTURED_OUTPUT_TOOL = 'submit_result';

/**
 * 工具描述：交给模型看的一句人话。
 * 不提「schema」二字——那份 JSON Schema 就在参数声明里，描述里再复述一遍只会多一处可能与它漂移的副本。
 */
export const PI_STRUCTURED_OUTPUT_DESCRIPTION =
  '提交本次运行的最终结果。参数就是要交付的 JSON 对象本身，必须是本次运行的结论，不要放进任何解释文字。';

/**
 * pi 无条件拒绝的 schema 关键字（`UNSUPPORTED_STRICT_SCHEMA_KEYS`）。
 * 两条 wire 共用这一份：差集在 `isAnthropicUnsupportedKeyword` 那一格。
 */
const UNSUPPORTED_KEYS = new Set([
  '$ref',
  '$defs',
  'definitions',
  'allOf',
  'oneOf',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
  'unevaluatedProperties',
  'propertyNames',
  'contains',
  'prefixItems',
  'not',
  'if',
  'then',
  'else',
]);

/**
 * anthropic 那条 wire 额外拒的 11 个键（`isAnthropicStrictUnsupportedKeyword`）。
 * 本仓今天两份真实 schema 都没用到它们，但 strict 子集要求逐条点名——少一条就是「预检说能过、
 * 运行时零出站请求」。
 */
const ANTHROPIC_UNSUPPORTED_KEYS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'uniqueItems',
  'minContains',
  'maxContains',
  'minProperties',
  'maxProperties',
]);

/**
 * anthropic 放行的 `format` 白名单（逐字来自 `anthropic-messages.js` 的集合）。
 * `format` 不在这个白名单里（`regex` / `uri-reference` 之类）即被拒。
 */
const ANTHROPIC_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/**
 * 预检结论：`parameters` 非空 = 这份 schema 可以走原生通道，**原样**当工具参数；
 * `reason` 非空 = 落在 strict 子集外，调用方必须显式降级（走填充层 + 记 `false`）。
 * 两格互斥，但都用可空表示——调用方读哪一格由它自己的分支决定，不需要再收窄一次联合类型。
 */
export interface StrictSchemaPreflight {
  /** 通过时是**调用方原 schema 本身**（同一个引用，未经任何改写） */
  parameters: Record<string, unknown> | null;
  /** 未通过时是中文原因（含字段路径），交给调用方的 WARN 与日志 */
  reason: string | null;
}

/**
 * 这份节点算不算「结构化」——与厂商 `isStructuredSchema` 逐条同源：
 * `type` 含 `object` / `array`，或带 `properties` / `items`。
 * 它是 `anyOf` 分支的判据：pi 不许把对象或数组放进 union（`object and array unions are unsupported`）。
 */
function isStructuredSchema(node: unknown): boolean {
  const record = asRecord(node);
  if (record === null) return false;
  const type = record['type'];
  const names = typeof type === 'string' ? [type] : Array.isArray(type) ? type : [];
  return (
    names.includes('object')
    || names.includes('array')
    || record['properties'] !== undefined
    || record['items'] !== undefined
  );
}

/**
 * 这份节点自己（含 `type` 联合与 `enum` / `const`）允不允许 `null`。
 * 厂商用它决定「要不要给非必填属性包一层 `anyOf: [<原属性>, {type:'null'}]`」——
 * 已经允许 `null` 的属性不会再被包，所以它**不**构成 §1.5 那条非幂等陷阱。
 */
function schemaAllowsNull(node: unknown): boolean {
  const record = asRecord(node);
  if (record === null) return false;
  const type = record['type'];
  if (type === 'null') return true;
  if (Array.isArray(type) && type.includes('null')) return true;
  if (record['const'] === null) return true;
  if (Array.isArray(record['enum']) && record['enum'].includes(null)) return true;
  return Array.isArray(record['anyOf']) && record['anyOf'].some((variant) => schemaAllowsNull(variant));
}

/**
 * anthropic 的 provider 钩子：返回该键被拒的中文原因，放行则 `null`。
 * 三条规则与 `isAnthropicStrictUnsupportedKeyword` 一一对应（含 `minItems` 只放行 0 / 1 这条特例）。
 */
function anthropicKeywordReason(key: string, value: unknown): string | null {
  if (ANTHROPIC_UNSUPPORTED_KEYS.has(key)) return `${key}: ${JSON.stringify(value)} 在 anthropic 那条 wire 上不被支持`;
  if (key === 'minItems' && value !== 0 && value !== 1) {
    return `minItems: ${JSON.stringify(value)} 在 anthropic 那条 wire 上不被支持（只放行 0 与 1）`;
  }
  if (key === 'format' && (typeof value !== 'string' || !ANTHROPIC_FORMATS.has(value))) {
    return `format: ${JSON.stringify(value)} 不在 anthropic 那条 wire 的白名单里`;
  }
  return null;
}

/** 逐节点判一次；返回被拒原因，通过则 `null`。`path` 是给排障用的字段路径（`$.properties.id`） */
function preflightNode(node: unknown, path: string, protocolType: ProtocolType): string | null {
  // 布尔 schema（`true` / `false`）与标量都不是对象节点，厂商一律拒
  const record = asRecord(node);
  if (record === null) return `${path} 不是对象节点（布尔 schema 与标量都不在 strict 子集内）`;

  for (const key of UNSUPPORTED_KEYS) {
    if (record[key] !== undefined) return `${path}.${key} 不在 strict 子集内（${key} schemas are unsupported）`;
  }
  if (protocolType === 'anthropic') {
    for (const [key, value] of Object.entries(record)) {
      const reason = anthropicKeywordReason(key, value);
      if (reason !== null) return `${path}：${reason}`;
    }
  }

  const anyOf = record['anyOf'];
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf) || anyOf.length === 0) return `${path}.anyOf 必须是非空数组`;
    for (const [index, variant] of anyOf.entries()) {
      /**
       * 对象 / 数组进 union 一律被拒。这条同时封掉了「手写 `anyOf: [{type:'string'}, {type:'null'}]`
       * 之外的可空写法」——可空标量该写成 `type: ['string', 'null']`（两边都放行）。
       */
      if (isStructuredSchema(variant)) {
        return `${path}.anyOf[${index}] 是对象或数组（object and array unions are unsupported）`;
      }
      const nested = preflightNode(variant, `${path}.anyOf[${index}]`, protocolType);
      if (nested !== null) return nested;
    }
  }

  const items = record['items'];
  if (items !== undefined) {
    // `items` 是数组（tuple / `prefixItems` 时代写法）不在子集里
    if (Array.isArray(items)) return `${path}.items 是 tuple（tuple schemas are unsupported）`;
    const nested = preflightNode(items, `${path}.items`, protocolType);
    if (nested !== null) return nested;
  }

  const properties = record['properties'];
  if (properties !== undefined && record['type'] !== 'object') {
    return `${path} 有 properties 但 type 不是 object（properties require type object）`;
  }
  if (record['type'] !== 'object') return null;

  /**
   * 从这里往下只对对象节点判（与厂商 `makeJsonSchemaNodeStrict` 的顺序一致）。
   * `additionalProperties` 的三态里只有**显式** `true` 与子 schema 被拒：缺省放行（厂商随后会把它
   * 强制改成 `false`，那时这份 schema 已经由厂商改写过了，与我们交出去的那一份无关）。
   * 本仓两份真实 schema 都显式写了 `false`——不是因为缺省会被拒，而是因为「开放对象」在题面上
   * 就是另一个意思，写清楚才没有歧义。
   */
  if (record['additionalProperties'] !== undefined && record['additionalProperties'] !== false) {
    return `${path}.additionalProperties 不能是 true 或子 schema（schema-valued or true additionalProperties is unsupported）`;
  }
  const propertyMap = properties === undefined ? {} : asRecord(properties);
  if (propertyMap === null) return `${path}.properties 不是对象 map`;
  const required = record['required'];
  if (required !== undefined && (!Array.isArray(required) || required.some((key) => typeof key !== 'string'))) {
    return `${path}.required 不是字符串数组`;
  }
  const requiredNames = new Set(Array.isArray(required) ? (required as string[]) : []);
  for (const key of requiredNames) {
    if (!(key in propertyMap)) return `${path}.required 点名了 properties 里没有的属性 ${key}`;
  }
  for (const [key, value] of Object.entries(propertyMap)) {
    const nested = preflightNode(value, `${path}.properties.${key}`, protocolType);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * **装配期预检**：这份调用方 schema 在这条 wire 上能不能拿 strict。
 *
 * 输入是 `unknown`（调用方给什么都有可能）：非对象直接判不通过，**不做任何收窄**——
 * 收窄过的 schema 与另三家拿到的就不是同一份了（见文件头第 3 条）。
 * 通过时 `parameters` 是**入参本身**：调用方拿它当工具参数即可，中间一个字段都没动过。
 */
export function preflightStructuredOutput(outputSchema: unknown, protocolType: ProtocolType): StrictSchemaPreflight {
  const record = asRecord(outputSchema);
  if (record === null) {
    return { parameters: null, reason: '这份 schema 不是一个 JSON 对象（数组 / 标量 / null 都拿不到 strict）' };
  }
  if (record['type'] !== 'object') {
    return { parameters: null, reason: '根节点必须是 type: object（root schema must have type object）' };
  }
  const reason = preflightNode(record, '$', protocolType);
  return reason === null ? { parameters: record, reason: null } : { parameters: null, reason };
}

/**
 * 本行的结构化输出**采纳结论**（装配期一次算好，随运行闭包走）。
 *
 * 为什么把「降级提示词」也放在这里：降级时那份约束必须**加在首轮提示词上**，
 * 而装配面只在 `input.prompt` 一个地方能改它——两处各判一次「是不是降级了」必然漂移，
 * 而漂移的表现是「装配时说降级、提示词里没加约束」，正好是静默失败。
 */
export interface StructuredOutputAdoption {
  /**
   * **工具通道**：要走就走这一格，`strict` 就是这一档的强度。
   *   · `'require'` = 原生通道（schema 落在 strict 子集内，厂商拿不到 strict 就抛）；
   *   · `'prefer'` = 降级档（拿不到 strict 就静默回落成非 strict 声明）——它**仍然**把工具
   *     与那份 schema 交给模型，只是形状不再有厂商保证。
   * 走哪一档由预检的结论定，调用方只负责把 `parameters` 与 `strict` 原样转交厂商。
   */
  tool: { parameters: Record<string, unknown>; strict: 'require' | 'prefer' } | null;
  /** 降级：**原样**往首轮提示词追加的约束段（不收窄 schema）；没要 schema 时为 `null` */
  fallback: { instruction: string } | null;
  /** 预检不通过的原因（原生通道为 `null`）；调用方据此落一条点名的 WARN */
  preflightReason: string | null;
}

/**
 * 装配期裁定一次：走原生通道还是降级档。
 *
 * `undefined` / `null` 表示调用方没要 schema ⇒ 三格都空，本行与这件事无关（不是「降级」）。
 * 要了 schema 而预检不过时**只降强度、不改 schema**：那份原样的 schema 进工具参数、提示词与修正轮，
 * 四家拿到的题目因此逐字相同。
 */
export function adoptStructuredOutput(outputSchema: unknown, protocolType: ProtocolType): StructuredOutputAdoption {
  if (outputSchema === undefined || outputSchema === null) {
    return { tool: null, fallback: null, preflightReason: null };
  }
  const preflight = preflightStructuredOutput(outputSchema, protocolType);
  if (preflight.parameters !== null) {
    return { tool: { parameters: preflight.parameters, strict: 'require' }, fallback: null, preflightReason: null };
  }
  /**
   * 降级那一段用的是骨架的**同一份原料**（`buildStructuredOutputInstruction`，dsh 的填充层也是它）：
   * 两家走填充层时给模型的交代逐字相同，跨家对比才不比出一段我们自己写的措辞差异。
   * 传进去的是 `asSchemaObject` 的收窄结果——提示词要渲染它，非对象得先挡掉。
   *
   * 工具通道那一格以**同一份收窄结果**为门槛：调用方给的不是 JSON 对象（数组 / 标量 / 字符串）
   * 时没有可声明的 `parameters`，这一档就只剩提示词（声明一件「参数随便什么都行」的工具
   * 比不声明更坏——模型会以为形状有保证，而那一档本来就没有）。
   */
  const renderable = asSchemaObject(outputSchema);
  return {
    tool: renderable === null ? null : { parameters: renderable, strict: 'prefer' },
    fallback: { instruction: buildStructuredOutputInstruction(renderable ?? outputSchema) },
    preflightReason: preflight.reason ?? '这份 schema 不在 strict 子集内',
  };
}

/** 工具参数 → 最终答复的原文（缩进两格，与提示词里那份 schema 的排版一致，便于人读日志） */
export function renderStructuredArguments(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return String(args);
  }
}

/**
 * 一次运行的**结构化输出投影态**：工具参数覆写最终答复的记账。
 *
 * 为什么要单独记账而不是直接写 `state.finalText`：`applied.structuredOutput` 的口径是
 * 「本轮答复**确实来自**被 strict 约束的工具参数」，而 `state.finalText` 只回答「答复是什么」。
 * 两者在修正轮里会分家——模型改走正文时正文会覆写那一格，而「最后写进去的是谁」这个事实
 * 只在写入侧看得见，事后从文本上判不出来。
 */
export interface StructuredOutputProjection {
  /** 结构化工具**调用过**（`tool_execution_start` 到过一次）；只用于日志与上报口径的措辞 */
  called: boolean;
  /**
   * 当前这一份最终答复的**生产者**：`'structured'` = 结构化工具的参数投影；
   * `'text'` = 助手正文（含初始值与每一轮回复）。初始值 `'text'` 是保守的那一侧——
   * 还没有任何答复时它不该被读成「走了原生通道」。
   */
  owner: 'structured' | 'text';
  /**
   * 本行的工具声明**带不带厂商侧强制**（装配期由采纳档位定死，运行期不变）：
   * 原生通道（`strict: 'require'`）为真；降级档（`'prefer'`）为假——那一档的工具调用
   * **照样**把参数投影进最终答复，但没有厂商按 schema 约束过形状 ⇒ 上报口径必须一起看这一格，
   * 否则「降级档模型调了工具」会被记成「形状由厂商保证」。
   */
  enforced: boolean;
}

/**
 * 造一份投影态：`enforced` 由装配期的采纳档位定（原生通道 = `strict === 'require'`）。
 * 没走工具通道时它恒为假，上报口径自然给 `false`。
 */
export function createStructuredOutputProjection(enforced: boolean): StructuredOutputProjection {
  return { called: false, owner: 'text', enforced };
}

/**
 * 记一次结构化工具调用：写最终答复并翻归属，返回**写进去的那份原文**。
 *
 * 为什么返回值是文本而不是草稿：草稿的形状归 `message.ts`（消息归一那一层），这里只管
 * 「最终答复是什么」与「它是不是工具参数投影出来的」。调用方把这份文本交给消息层造快照——
 * 两边共用同一个字符串，各序列化一次必然漂移。
 *
 * 三条边界：
 *   · **不吞异常**：`JSON.stringify` 抛（循环引用）时退回原样字符串，绝不把异常冒进适配器主流程；
 *   · 写进 `state.finalText` 的是**缩进两格**的形态（人读），下游判据只做 `JSON.parse`，排版不影响判定；
 *   · 同时把 `owner` 翻成 `'structured'`——「这一份答复是谁产出的」是上报口径的唯一依据。
 */
export function adoptStructuredArguments(
  args: unknown,
  state: { finalText: string | null },
  projection: StructuredOutputProjection,
): string {
  const text = renderStructuredArguments(args);
  state.finalText = text;
  projection.called = true;
  projection.owner = 'structured';
  return text;
}

/**
 * 这条厂商载荷是不是**我们自己造的结构化产出快照**（`piStructuredResultDraft` 的 `raw`）。
 *
 * 为什么要认它：它是唯一一条「不是从模型答复来的」助手消息，常规归一通路会在它身上重复落正文
 * （已经写过了）与用量（它压根没有）——`message_end` 那一侧据此短路。
 */
export function isStructuredResultMessage(message: Record<string, unknown> | null): boolean {
  return message?.['type'] === PI_STRUCTURED_RESULT_PAYLOAD_TYPE;
}

/** `piStructuredResultDraft` 造出来的那条草稿的判别键（两处共用，避免各写一个字面串） */
export const PI_STRUCTURED_RESULT_PAYLOAD_TYPE = 'structured_output';

/** 助手正文写进最终答复时同步翻牌（`projectMessageEnd` 的那一处调用它） */
export function noteTextReply(projection: StructuredOutputProjection): void {
  projection.owner = 'text';
}

/**
 * 上报口径的那一格（**方法**，不是结果）：只有「本轮答复确实来自被 strict 约束的工具参数」
 * 才为真——`enforced` 那一维把降级档摘出去（`'prefer'` 的工具调用没有厂商侧强制）。
 *
 * 三种 `false` 的含义不同、日志里要分得开：
 *   · 降级 / 没要 schema ⇒ 压根没有厂商侧强制（降级档仍有工具，但它不是「原生通道」）；
 *   · 要了、工具也声明了，但模型没调它（`ToolChoice` 只有 `auto | none`，它完全可以走正文）
 *     ⇒ 这一分的形状**没有任何厂商保证**；
 *   · 调了，但之后某一轮（含修正轮）改走了正文 ⇒ 最终答复不是工具参数投影出来的那一份。
 */
export function structuredOutputApplied(projection: StructuredOutputProjection): boolean {
  return projection.enforced && projection.called && projection.owner === 'structured';
}
