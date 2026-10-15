// @vitest-environment node
/**
 * pi 的结构化输出通道：装配期预检的判定面 + 「工具参数投影回最终答复」的记账。
 *
 * 为什么判据落在**纯函数**上而不是整条运行上：
 *   · 预检是**装配期**裁定（走原生通道还是降级），它的输入是调用方的 schema、输出是一次判定，
 *     与 SDK 无关；整条运行里验它只会让「哪一条规则拦住了哪一份 schema」变得不可读；
 *   · 投影记账（`owner`）决定的是上报口径——「本轮答复确实来自工具参数」，修正轮里模型改走正文时
 *     它就翻回 `text`。这条规则在这里逐格钉住，请求侧的那一半（schema 真的出站了）在
 *     `conformance.test.ts` 用真实请求体判。
 *
 * 表里每一条拒绝面都对应 `makeStrictJsonSchema` 的一个 `throw`（见该函数的分支顺序）；
 * 变异体：把某条规则从预检里删掉 ⇒ 对应那一格变成「通过」，当场红。
 */
import { describe, expect, it } from 'vitest';
import { foldMessages } from '@aieval/core';
import {
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicDelta,
  anthropicEnd,
  anthropicStart,
  anthropicText,
  anthropicToolUse,
  runPiConformanceRow,
} from '../../testing/pi-conformance-fixture';
import { PI_STRUCTURED_REJECTION_BUDGET } from './events';
import {
  adoptStructuredOutput,
  adoptStructuredArguments,
  createStructuredOutputProjection,
  noteTextReply,
  PI_STRUCTURED_OUTPUT_TOOL,
  preflightStructuredOutput,
  structuredOutputApplied,
} from './structured-output';

/** 本仓评分 schema 的骨架（真实那一份的字段类型与约束都在 strict 子集内） */
function judgeish(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      judgments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { criterion: { type: 'string' }, achieved: { type: 'boolean' } },
          required: ['criterion', 'achieved'],
          additionalProperties: false,
        },
      },
      verdict: { type: 'string' },
    },
    required: ['judgments', 'verdict'],
    additionalProperties: false,
  };
}

/** 通过时 `parameters` 必须是**入参本身**（同一个引用）——预归一化会在这里现形 */
function passes(schema: unknown, protocolType: 'openai' | 'anthropic' = 'openai'): Record<string, unknown> {
  const result = preflightStructuredOutput(schema, protocolType);
  expect(result.reason, `这份 schema 本该通过预检，却被判：${result.reason}`).toBeNull();
  return result.parameters as Record<string, unknown>;
}

/** 拒绝时两格必须互斥：`parameters` 为空、`reason` 有名有姓（日志里要能直接读） */
function rejects(schema: unknown, protocolType: 'openai' | 'anthropic' = 'openai'): string {
  const result = preflightStructuredOutput(schema, protocolType);
  expect(result.parameters).toBeNull();
  expect(result.reason).toBeTruthy();
  return result.reason as string;
}

describe('pi 的 strict 预检：静态关键字（两条 wire 都拒）', () => {
  it.each(['$ref', '$defs', 'definitions', 'allOf', 'oneOf', 'not', 'if', 'prefixItems'])(
    '顶层出现 %s ⇒ 拒，且原因点名该键',
    (key) => {
      const reason = rejects({ type: 'object', [key]: {}, additionalProperties: false });
      expect(reason).toContain(key);
    },
  );

  it('嵌套层级上的禁用键同样被拒（写在 items 里也躲不过）', () => {
    const schema = {
      type: 'object',
      properties: { items: { type: 'array', items: { oneOf: [{ type: 'string' }] } } },
      required: ['items'],
      additionalProperties: false,
    };
    expect(rejects(schema)).toContain('oneOf');
  });
});

describe('pi 的 strict 预检：结构性约束', () => {
  it('根不是 type: object ⇒ 拒（顶层数组与标量都拿不到 strict）', () => {
    expect(rejects({ type: 'array', items: { type: 'string' } })).toContain('根节点必须是 type: object');
    expect(rejects('{"type":"object"}')).toContain('不是一个 JSON 对象');
    expect(rejects([{ type: 'object' }])).toContain('不是一个 JSON 对象');
  });

  it('布尔 schema ⇒ 拒（`true` / `false` 都不是对象节点）', () => {
    const schema = { type: 'object', properties: { anything: true }, required: ['anything'], additionalProperties: false };
    expect(rejects(schema)).toContain('不是对象节点');
  });

  it('对象 / 数组进 anyOf ⇒ 拒（手写可空对象必须改用 type 联合）', () => {
    const handwritten = {
      type: 'object',
      properties: { note: { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] } },
      required: ['note'],
      additionalProperties: false,
    };
    expect(rejects(handwritten)).toContain('object and array unions are unsupported');
  });

  it('可空标量写成 type 联合 ⇒ 过（这正是 anyOf 那条的替代写法）', () => {
    const schema = {
      type: 'object',
      properties: { note: { type: ['string', 'null'] } },
      required: ['note'],
      additionalProperties: false,
    };
    const parameters = passes(schema);
    expect(parameters).toBe(schema);
  });

  it('只含标量分支的 anyOf ⇒ 过（被拒的是「对象/数组进 union」，不是 anyOf 本身）', () => {
    const schema = {
      type: 'object',
      properties: { level: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      required: ['level'],
      additionalProperties: false,
    };
    expect(passes(schema)).toBe(schema);
  });

  it('items 是数组（tuple）⇒ 拒', () => {
    const schema = { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }] } }, required: ['pair'], additionalProperties: false };
    expect(rejects(schema)).toContain('tuple schemas are unsupported');
  });

  it('properties 但是 type 不是 object ⇒ 拒（少写一个 type 键就整份被拒）', () => {
    const schema = { type: 'object', properties: { inner: { properties: { a: { type: 'string' } } } }, required: ['inner'], additionalProperties: false };
    expect(rejects(schema)).toContain('properties require type object');
  });

  it('additionalProperties 为 true 或子 schema ⇒ 拒；缺省与显式 false ⇒ 过（缺省不放行是常见误判）', () => {
    expect(rejects({ type: 'object', additionalProperties: true })).toContain('additionalProperties');
    expect(rejects({ type: 'object', additionalProperties: { type: 'string' } })).toContain('additionalProperties');
    expect(passes({ type: 'object', additionalProperties: false })).toBeTruthy();
    // 缺省过：厂商的判据是「给了且不是 false」，缺省时它随后自己补 false
    expect(passes({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toBeTruthy();
  });

  it('required 点名了 properties 里没有的键 ⇒ 拒', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'b'], additionalProperties: false };
    expect(rejects(schema)).toContain('required 点名了 properties 里没有的属性 b');
  });
});

describe('pi 的 strict 预检：两条 wire 的差集', () => {
  /** 这一组是「预检说能过、运行时零出站请求」的唯一来源：差集少写一条就漏一个 */
  it.each(['minimum', 'maximum', 'maxItems', 'uniqueItems', 'multipleOf', 'minProperties'])(
    '%s 只在 anthropic 那条 wire 上被拒',
    (key) => {
      const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false, [key]: 1 };
      expect(rejects(schema, 'anthropic')).toContain(key);
      expect(passes(schema, 'openai')).toBe(schema);
    },
  );

  it('minItems：anthropic 只放行 0 与 1，2 即被拒；openai 无此限制', () => {
    const two = { type: 'object', properties: { list: { type: 'array', items: { type: 'string' }, minItems: 2 } }, required: ['list'], additionalProperties: false };
    expect(rejects(two, 'anthropic')).toContain('minItems');
    expect(passes(two, 'openai')).toBe(two);
    const one = { type: 'object', properties: { list: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['list'], additionalProperties: false };
    expect(passes(one, 'anthropic')).toBe(one);
  });

  it('format：白名单内的过、白名单外的被 anthropic 拒', () => {
    const uuid = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'], additionalProperties: false };
    expect(passes(uuid, 'anthropic')).toBe(uuid);
    const regex = { type: 'object', properties: { id: { type: 'string', format: 'regex' } }, required: ['id'], additionalProperties: false };
    expect(rejects(regex, 'anthropic')).toContain('format');
    expect(passes(regex, 'openai')).toBe(regex);
  });

  it('minLength / pattern / enum / const 两条 wire 都放行（别白担心）', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, pattern: '^[a-z]+$' },
        level: { enum: ['高', '中', '低'] },
        pinned: { const: 'x' },
      },
      required: ['id', 'level', 'pinned'],
      additionalProperties: false,
    };
    expect(passes(schema, 'anthropic')).toBe(schema);
    expect(passes(schema, 'openai')).toBe(schema);
  });
});

describe('pi 的 strict 预检：原样透传（禁止预归一化）', () => {
  /**
   * 这条钉的是**两条铁律的第①条**：`makeStrictJsonSchema` 非幂等（含可选对象/数组属性的 schema，
   * 其 strict 产物再喂一次会被拒），所以适配器永远交原 schema。
   *
   * 判据取**引用相等**：任何「先算成 strict 形态再传」的写法都会产生一份新对象或改写原对象，
   * 两种都在这里现形（值相等不够——归一化正是「值看起来对、来源不对」）。
   */
  it('通过时返回的就是入参本身，一个字段都没动过', () => {
    const schema = judgeish();
    const before = JSON.stringify(schema);
    const parameters = passes(schema, 'anthropic');
    expect(parameters).toBe(schema);
    expect(JSON.stringify(schema), '预检不许改写入参').toBe(before);
  });

  it('可选的对象型属性（strict 改写会包 anyOf）仍然原样通过', () => {
    const schema = {
      type: 'object',
      properties: {
        required_thing: { type: 'string' },
        optional_obj: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      },
      required: ['required_thing'],
      additionalProperties: false,
    };
    expect(passes(schema)).toBe(schema);
    expect(schema.properties.optional_obj, '预检不许把可选属性包成 anyOf').not.toHaveProperty('anyOf');
  });
});

describe('pi 的结构化输出采纳结论', () => {
  it('没要 schema ⇒ 三格都空（这不是降级，本行与结构化输出无关）', () => {
    expect(adoptStructuredOutput(undefined, 'openai')).toEqual({ tool: null, fallback: null, preflightReason: null });
    expect(adoptStructuredOutput(null, 'anthropic')).toEqual({ tool: null, fallback: null, preflightReason: null });
  });

  it('预检过 ⇒ 工具走 `require`、不带降级提示词', () => {
    const schema = judgeish();
    const adoption = adoptStructuredOutput(schema, 'anthropic');
    expect(adoption.tool?.parameters).toBe(schema);
    expect(adoption.tool?.strict).toBe('require');
    expect(adoption.fallback).toBeNull();
    expect(adoption.preflightReason).toBeNull();
  });

  it('预检不过 ⇒ 显式降级：原因点名、提示词里是**原样**的 schema、工具改走 `prefer`', () => {
    const schema = {
      type: 'object',
      properties: { note: { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] } },
      required: ['note'],
      additionalProperties: false,
    };
    const adoption = adoptStructuredOutput(schema, 'anthropic');
    // 降强度但不撤工具：那一档仍有工具与 schema，只是没有厂商侧强制
    expect(adoption.tool?.parameters).toBe(schema);
    expect(adoption.tool?.strict).toBe('prefer');
    expect(adoption.preflightReason).toContain('object and array unions are unsupported');
    // 降级不收窄 schema：提示词里逐字出现 anyOf 那一格（收窄了这里就读不到它）
    expect(adoption.fallback?.instruction).toContain('"anyOf"');
  });

  /**
   * 非对象 schema（数组 / 标量）按**「没给」**处置：既不声明工具，**也不追加提示词**。
   * 判据是「四家拿到的题目必须逐字相同」——另三家同样只在 schema 可用时才落提示词；
   * 而骨架对这份 schema 只判「合法 JSON」，追加一段「必须符合这份数组 schema」的约束会让
   * 题面比判据严、且与它自相矛盾。
   */
  it('预检不过且那份 schema 根本不是 JSON 对象 ⇒ 按「没给」处置，工具与提示词都不落', () => {
    const adoption = adoptStructuredOutput(['not', 'an', 'object'], 'openai');
    expect(adoption.tool).toBeNull();
    expect(adoption.fallback).toBeNull();
    expect(adoption.preflightReason).toContain('不是一个 JSON 对象');
  });

  /**
   * **`required` 的判据必须与厂商同源**（自有键，不走原型链）。
   *
   * 厂商那一侧取的是 `Object.keys(properties)` 的集合（`makeJsonSchemaNodeStrict` 的
   * `propertyNames.includes(key)`），而 `'toString' in {}` / `'constructor' in {}` 全为真
   * ⇒ 用 `in` 判会**放行**这份 schema，采纳 `strict: 'require'`，厂商在建请求那一刻抛
   * （零出站请求 + `stopReason: 'error'` 的 43 毫秒收场）——正是预检存在的理由。
   */
  it('`required` 点名了一个 Object.prototype 成员 ⇒ 预检必须与厂商同判（拦下，不是放行）', () => {
    for (const key of ['toString', 'constructor', 'valueOf', '__proto__']) {
      const preflight = preflightStructuredOutput(
        { type: 'object', properties: {}, required: [key], additionalProperties: false },
        'openai',
      );
      expect(preflight.parameters, key).toBeNull();
      expect(preflight.reason, key).toContain('properties 里没有的属性');
    }
    // 自有键（真的在 properties 里）照旧放行——这条判据不能把正常 schema 一起拦掉
    expect(preflightStructuredOutput(
      { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false },
      'openai',
    ).parameters).not.toBeNull();
  });

  /**
   * **`required` 的判据要收「自有且可枚举」**，不是「自有」。
   *
   * 厂商那一侧取 `Object.keys(properties)`（可枚举），而 `Object.hasOwn` 收全部自有键
   * ——`Object.defineProperty` 造出来的**非枚举**键会让预检放行、厂商在建请求那一刻抛
   * （`required contains an unknown property`：零出站请求 + `stopReason: 'error'`），
   * 也就是同一类假放行的另一个入口。判据与厂商同源之后两边同判。
   */
  it('`required` 点名了一个**非枚举**自有属性 ⇒ 与厂商同判（拦下，`Object.hasOwn` 会放行它）', () => {
    const properties: Record<string, unknown> = {};
    Object.defineProperty(properties, 'hidden', {
      value: { type: 'string' },
      enumerable: false,
      writable: true,
      configurable: true,
    });
    // 前置：这一格确实是「自有但不可枚举」，否则这条判据测的不是它想测的东西
    expect(Object.hasOwn(properties, 'hidden')).toBe(true);
    expect(Object.keys(properties)).toEqual([]);

    const preflight = preflightStructuredOutput(
      { type: 'object', properties, required: ['hidden'], additionalProperties: false },
      'openai',
    );
    expect(preflight.parameters, '非枚举自有键被当成了可声明的属性 ⇒ 厂商会拒、我们放行').toBeNull();
    expect(preflight.reason).toContain('properties 里没有的属性');
  });

  /**
   * **根是 JSON 对象、但根 `type` 不是 `object` 的那一支：工具照旧声明（降级档）**。
   *
   * 与「根本不是 JSON 对象 ⇒ 两样都不落」是**两档**，判据是结构而不是「根 type 是什么」：
   * 这一份有可声明的参数（`prefer` 档把原 schema 交出去），而 pi 的 `input_schema` 在非 strict
   * 档只取根节点的 `type/properties/required` ⇒ 出站那一份会退化成空对象形态。
   * 这是 schema 形态的已知代价，**如实交付**而不是静默丢掉工具（丢掉的话模型连出口都没有）。
   */
  it('根 `type: "array"` ⇒ 降级档仍然交付工具与填充层（与「不是 JSON 对象」分档）', () => {
    const arrayRoot = { type: 'array', items: { type: 'string' } };
    const adoption = adoptStructuredOutput(arrayRoot, 'anthropic');
    expect(adoption.tool?.strict).toBe('prefer');
    expect(adoption.tool?.parameters).toBe(arrayRoot);
    expect(adoption.fallback?.instruction).toContain('输出约束');
    expect(adoption.preflightReason).toContain('root schema must have type object');
  });
});

describe('pi 的结构化输出投影记账（上报口径的唯一依据）', () => {
  it('原生档：工具参数写进最终答复 ⇒ 上报为真（缩进两格、可 JSON.parse）', () => {
    const state = { finalText: '我先说两句' as string | null };
    const projection = createStructuredOutputProjection(true);
    const text = adoptStructuredArguments({ verdict: '还行' }, state, projection);
    expect(state.finalText).toBe(text);
    expect(JSON.parse(text)).toEqual({ verdict: '还行' });
    expect(structuredOutputApplied(projection)).toBe(true);
  });

  /**
   * 降级档的工具**照旧出站、模型照旧能调**（`strict: 'prefer'` 只是静默回落成非 strict 声明）
   * ⇒ 那一档的参数投影**必须**仍然记 `false`：`applied.structuredOutput` 问的是「厂商有没有按
   * schema 约束形状」，不是「答复有没有走工具」。
   */
  it('降级档：工具参数照样写进最终答复，但上报为假（那一档没有厂商侧强制）', () => {
    const state = { finalText: null as string | null };
    const projection = createStructuredOutputProjection(false);
    const text = adoptStructuredArguments({ verdict: '还行' }, state, projection);
    expect(state.finalText).toBe(text);
    expect(projection.called).toBe(true);
    expect(structuredOutputApplied(projection)).toBe(false);
  });

  it('此后助手正文覆写 ⇒ 翻回 false（修正轮改走正文的那一格）', () => {
    const state = { finalText: null as string | null };
    const projection = createStructuredOutputProjection(true);
    adoptStructuredArguments({ verdict: '还行' }, state, projection);
    expect(structuredOutputApplied(projection)).toBe(true);
    state.finalText = '{"verdict":"还行"}';
    noteTextReply(projection);
    expect(structuredOutputApplied(projection)).toBe(false);
  });

  it('工具没调用过 ⇒ 恒 false（模型走正文是允许的，但形状没有厂商保证）', () => {
    const projection = createStructuredOutputProjection(true);
    noteTextReply(projection);
    expect(structuredOutputApplied(projection)).toBe(false);
    expect(projection.called).toBe(false);
  });

  it('参数里有循环引用 ⇒ 退回原样字符串，绝不抛（日志与结论都不该被它打断）', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const state = { finalText: null as string | null };
    const text = adoptStructuredArguments(cyclic, state, createStructuredOutputProjection(true));
    expect(text).toBe('[object Object]');
    expect(state.finalText).toBe('[object Object]');
  });
});

/**
 * 结构化输出的**文本投影落进哪一格**（真跑一行 + 服务端折叠）。
 *
 * 为什么必须走整条运行 + `foldMessages`：「同一轮的两条投递谁顶掉谁」只在合并器 + 折叠器上现形，
 * 纯函数层看不到。判据是**折叠后**那条助手消息的块序列——界面与 `/messages` 读的就是它。
 *
 * 变异体：把 `piStructuredResultDraft` 的块标识改回缺省 `index: 0`（或去掉 `structured:` 前缀）
 * ⇒ 模型正文块（或工具调用块）被那段 JSON 顶掉，本用例当场红。
 */
describe('pi 的结构化输出文本投影（同一轮消息里的落槽）', () => {
  /** 一条助手消息 = 正文块 + `submit_result` 工具块（真机模型给结构化结果时的自然形态） */
  function textThenSubmit(text: string, args: Record<string, unknown>): string[] {
    return [
      anthropicStart(),
      anthropicBlockStart(0, { type: 'text', text: '' }),
      anthropicDelta(0, { type: 'text_delta', text }),
      anthropicBlockStop(0),
      ...anthropicToolUse(PI_STRUCTURED_OUTPUT_TOOL, args, 'toolu_submit').slice(1),
    ];
  }

  const schema = {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
    additionalProperties: false,
  };

  it('同轮已有正文块：JSON 追加成独立块，模型正文与工具块都不被顶掉', async () => {
    const run = await runPiConformanceRow({
      prompt: '按 schema 作答。',
      outputSchema: schema,
      script: [textThenSubmit('这是结论：', { verdict: 'ok' })],
    });
    const folded = foldMessages(run.product.messages).filter((message) => message.role === 'assistant');
    const blocks = folded.flatMap((message) => message.blocks);
    const kinds = blocks.map((block) => (block.type === 'text' ? `text=${block.text}` : block.type));
    expect(kinds, `折叠后的块序列不对：${JSON.stringify(kinds)}`).toContain('text=这是结论：');
    expect(kinds).toContain('tool-call');
    // 那段 JSON 是这一档的交付面（评分通路读的 `finalText` 就是它），必须同时在场
    expect(kinds.some((kind) => kind.startsWith('text={'))).toBe(true);
  });

  /**
   * **持续交越界参数必须有上限**：厂商在参数校验失败时返回**不带 `terminate`** 的错误结果
   * （校验发生在 `terminate` 之前），模型每交一次就换来一条错误结果、再交一次——两侧都没有轮数上限。
   * 真机读数（脚本式上游，永久回同一段越界调用）：15 秒 **1337 次**出站请求，不挂看门狗直接 OOM。
   *
   * 两件事一起判：① 出站请求数被预算掐住（不是无界）；② 结论是**可读的失败**而不是 canceled
   * （预算中止会 `abort()`，不记那一笔停止来源时 `readAssistantFailure` 会另给一条原因盖掉它）。
   *
   * 变异体：去掉投影层那条 `failure`（或去掉 `index.ts` 里的 `session.abort()`）⇒ 本用例挂死在
   * 无限往返上（超时红）；只去掉停止来源那一笔记账 ⇒ 错误文案变成厂商那条 aborted 原因。
   */
  /**
   * 坏参数的工具调用必须在块层留下**可读的原因**：厂商只给 `arguments: {}` + `argumentsError`
   * （原文含 `is not valid JSON`），不给这一格的话块里就是一个空对象，与「模型真传了空对象」
   * 逐字同形。判据取真路径产物里的块（真包 + 脚本式上游），不是我们传了什么参数。
   *
   * 变异体：把 `readString(block, 'argumentsError')` 那一格去掉 ⇒ 本用例当场红。
   */
  it('参数不是合法 JSON ⇒ 工具块带上厂商的 `inputError`（不是只有一个空对象）', async () => {
    const run = await runPiConformanceRow({
      prompt: '读一个文件。',
      // 厂商对「参数不是合法 JSON」的处置：`arguments` 记 `{}`、原文进 `argumentsError`
      // 第二段是收口：坏参数那一轮之后模型「答一句」，避免网关复用最后一段把这一次探针拖成无限重试
      script: [anthropicRawToolArguments('read', 'this is not json', 'toolu_bad_args'), anthropicText('结束。')],
    });
    /** 块的联合类型要显式收窄（`filter` 谓词不会自动窄化） */
    type BadCall = { type: 'tool-call'; callId: string; input: unknown; inputError?: string | null };
    const calls = run.product.messages
      .flatMap((message) => message.blocks)
      .filter((block): block is BadCall & typeof block => block.type === 'tool-call' && block.callId === 'toolu_bad_args');
    expect(calls.length, '没读到那次工具调用的块，这一条的结论不成立').toBeGreaterThan(0);
    const inputError = calls[0]?.inputError ?? null;
    expect(inputError, '块里必须带厂商那句原文').toContain('not valid JSON');
    // 这一档的 `input` 就是空对象——所以必须有 `inputError` 才分得清「解析失败」与「真传了空对象」
    expect(calls[0]?.input).toEqual({});
  });

  it('模型持续交越界参数 ⇒ 有上限地收手（不是无界往返）', async () => {
    const run = await runPiConformanceRow({
      prompt: '按 schema 作答。',
      outputSchema: schema,
      // 参数不是 schema 的形状 ⇒ 厂商校验失败；剧本越界后复用最后一段 ⇒ 模型「再交一次」
      script: [anthropicToolUse(PI_STRUCTURED_OUTPUT_TOOL, { wrong: true }, 'toolu_bad')],
    });
    expect(run.outcome.ok).toBe(false);
    expect(run.outcome.error?.message ?? '').toContain('结构化输出参数连续');
    expect(run.requests.length, '出站请求数必须被预算掐住').toBeLessThanOrEqual(PI_STRUCTURED_REJECTION_BUDGET + 3);
  }, 60_000);

  it('阴性对照：模型只调工具、不写正文时工具块与 JSON 块都在（顺序为追加）', async () => {
    const run = await runPiConformanceRow({
      prompt: '按 schema 作答。',
      outputSchema: schema,
      script: [anthropicToolUse(PI_STRUCTURED_OUTPUT_TOOL, { verdict: 'ok' }, 'toolu_submit')],
    });
    const blocks = foldMessages(run.product.messages)
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.blocks);
    expect(blocks.map((block) => block.type)).toEqual(['tool-call', 'text']);
  });
});

/** 一次工具调用，但**入参不是合法 JSON**（厂商会记 `arguments: {}` + `argumentsError` 原文） */
function anthropicRawToolArguments(name: string, raw: string, callId: string): string[] {
  return [
    anthropicStart(),
    anthropicBlockStart(0, { type: 'tool_use', id: callId, name, input: {} }),
    anthropicDelta(0, { type: 'input_json_delta', partial_json: raw }),
    anthropicBlockStop(0),
    anthropicEnd('tool_use'),
  ];
}
