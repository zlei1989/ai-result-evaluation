// @vitest-environment node
/**
 * 评分路由解析：**只有一个来源**——设置页「评分配置」的全局默认评分模型；
 * 没配（或配成了悬空引用）则 CONFLICT + 指向设置页的中文原因。
 * 本文件覆盖同一件事的两半：`resolveJudgeRoute`（尺子落在哪个模型）与 `requireJudgeAgent`
 * （谁来驱动它，见下面的同名 describe）。
 * 为什么解析放在 evaluator 而不是 api 层：evaluator 在评分阶段也要自己解析一次，
 * 而 evaluator 不能依赖 api（依赖方向单向）。
 * 注意：本文件用 setConfigDirForTesting + saveConfig 造出真实的配置文件，不 mock loadConfig——
 * 「全局默认那一对 id 真的被读盘读出来」这条只有在真的走一遍读盘时才会被验证到。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError, SETTINGS_DEFAULTS, type AgentKind, type Provider } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { requireJudgeAgent, requireJudgeEffort, resolveJudgeEffort, resolveJudgeRoute } from './judge-route';
// 包根出口的守卫（见文件末尾「evaluator 包根出口」的第二个用例）：api 层只从
// `@aieval/evaluator` 取 `TextRoute` 这个类型，而类型在运行时被擦除——只有 tsc 看得见。
import type { TextRoute } from './index';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;

/** 造一个供应商记录（apiKey 是明文，本模块必须把它原样带进路由） */
function provider(id: string, models: string[]): Provider {
  return {
    id,
    name: `供应商 ${id}`,
    protocolType: 'openai',
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: `sk-${id}-secret`,
    models: models.map((modelId) => ({ id: modelId, source: 'manual' as const })),
    createdAt: '2026-09-22T10:30:00.000Z',
    updatedAt: '2026-09-22T10:30:00.000Z',
  };
}

/**
 * 写入一份含默认评分模型的配置。
 * `effort` 可选：`resolveJudgeEffort` 读的就是这一格，缺它就没法造出
 * 「配置里带了档位」这个初态。省略时**不写这个键**（与老配置读盘后的形状一致：`undefined` = 未指定）。
 */
function seed(defaultJudge: { providerId: string; modelId: string; effort?: string } | null, providers: Provider[]): void {
  const config = loadConfig();
  config.settings = { ...SETTINGS_DEFAULTS, defaultJudge };
  config.providers = providers;
  saveConfig(config);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-judge-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  setConfigDirForTesting(null);
  removeTreeWithRetry(dir);
});

describe('resolveJudgeRoute', () => {
  it('用全局默认（并带上明文 apiKey 与 baseUrl）', () => {
    seed({ providerId: 'p1', modelId: 'm1' }, [provider('p1', ['m1', 'm2'])]);
    expect(resolveJudgeRoute()).toEqual({
      protocolType: 'openai',
      baseUrl: 'https://p1.example.com/v1',
      apiKey: 'sk-p1-secret',
      modelId: 'm1',
    });
  });

  /**
   * 评分路由也带上模型声明的窗口。
   * 为什么必须有：智能体评分通路把这条 route **原样**交给适配器（`judge-agent.ts` 的 `route: input.route`），
   * 少了这一格，cc 驱动的评分模型不会加 `[1m]`、codex 不会写 `model_context_window`、dsh 不会写 settings.yaml
   * —— 与候选行的行为不一致，而界面上看不出任何差别（评分照样出分）。
   * 强度（`effort`）**也不在**这条路由上，但理由与上面两条不同：它是**请求参数**，不是连接事实
   * 由 `resolveJudgeEffort()` 读出来后走 `judgeEffort` 入参进两条评分通路；
   * 「跨轮次可比」改由**记账**保证（`ScoreResult.judgeEffort`：不同强度打的分数在数据上可分）。
   */
  it('带上该模型声明的窗口与输出上限；没声明时这两个键都不出现', () => {
    const p1 = provider('p1', []);
    p1.models = [
      { id: 'm1', source: 'manual', contextWindow: 1_048_576, maxOutputTokens: 131_072 },
      { id: 'm2', source: 'manual' },
    ];
    seed({ providerId: 'p1', modelId: 'm1' }, [p1]);
    expect(resolveJudgeRoute()).toEqual({
      protocolType: 'openai',
      baseUrl: 'https://p1.example.com/v1',
      apiKey: 'sk-p1-secret',
      modelId: 'm1',
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
    });

    seed({ providerId: 'p1', modelId: 'm2' }, [p1]);
    const bare = resolveJudgeRoute();
    // 判据用 Object.hasOwn 而不是 toBeUndefined：后者对「键在但值是 undefined」与「键不在」同解，
    // 而适配器一律按「键不存在 = 未知」处理（多一个 undefined 键会让某些 SDK 自己拼参数时出错）
    expect(Object.hasOwn(bare, 'contextWindow')).toBe(false);
    expect(Object.hasOwn(bare, 'maxOutputTokens')).toBe(false);
  });

  it('签名无参：拿不到「传一对 id 进来」的入口（用例级覆盖已删除）', () => {
    // 两层都要：`length` 管「形参位置」这种最直白的回退，行为探针管「带了默认值 / 从别处读入参」那种
    // ——`Function.length` 只数到第一个带默认值的形参为止（`isJudgeConfigured` 的覆盖参数当初就带默认值，
    // 实测 `.length` 对它完全无感），所以只有 `length` 一条是不够的。
    seed({ providerId: 'p1', modelId: 'm1' }, [provider('p1', ['m1']), provider('p2', ['m9'])]);
    expect(resolveJudgeRoute.length).toBe(0);
    // 语义面：把一对**有效**的用例级 id 塞进去，路由必须还是全局默认那一把尺子
    const hostile = resolveJudgeRoute as unknown as (arg?: unknown) => { modelId: string; baseUrl: string };
    expect(hostile({ judgeProviderId: 'p2', judgeModelId: 'm9' }).modelId).toBe('m1');
    expect(hostile({ judgeProviderId: 'p2', judgeModelId: 'm9' }).baseUrl).toBe('https://p1.example.com/v1');
  });

  it('没配置全局默认时抛 CONFLICT，message 指向设置页（未配置评分模型时按钮禁用 + Tooltip 的去向）', () => {
    seed(null, [provider('p1', ['m1'])]);
    let caught: unknown;
    try {
      resolveJudgeRoute();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toContain('评分模型');
    expect((caught as Error).message).toContain('设置');
  });

  it('全局默认指向一个已被删除的供应商时抛 CONFLICT 并点名（不静默回落到别的供应商）', () => {
    seed({ providerId: 'gone', modelId: 'm1' }, [provider('p1', ['m1'])]);
    let caught: unknown;
    try {
      resolveJudgeRoute();
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toContain('gone');
  });

  it('全局默认指向的模型不在该供应商的清单里时抛 CONFLICT（配错了要在调用前就报，不是等模型 404）', () => {
    seed({ providerId: 'p1', modelId: 'not-listed' }, [provider('p1', ['m1'])]);
    let caught: unknown;
    try {
      resolveJudgeRoute();
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toContain('not-listed');
    expect((caught as Error).message).toContain('p1');
  });
});

/**
 * 「谁驱动这一分」的解析：与 `resolveJudgeRoute` 是同一件事的两半（尺子落在哪个模型 / 谁来驱动它），
 * 故与它同文件、同一层。两种配置问题都要折成**可直接展示的中文 CONFLICT**：
 * 抛别的码会让界面显示不出「去设置页改哪一格」，而这两处恰恰是用户自己就能改的。
 * 注意本文件**不 mock** `@aieval/agents`：协议兼容性断言的价值全在「读的是真实注册表元数据」，
 * 拿被 mock 的假元数据去测这条守卫，绿色就建立在假设上了（与 fixtures.ts 里 dsh 那条同一条教训）。
 */
describe('requireJudgeAgent', () => {
  it('requireJudgeAgent：没配置默认评分智能体 → CONFLICT，且指出两条出路', () => {
    let caught: unknown;
    try {
      requireJudgeAgent({ defaultJudgeAgent: null, route: { protocolType: 'anthropic', baseUrl: 'x', apiKey: 'k', modelId: 'm' } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toMatch(/没有配置默认评分智能体/);
    // 两条出路都要写全：去设置页选一个，或这一轮关掉智能体评分（只写一条等于把另一半用户卡死）
    expect((caught as Error).message).toMatch(/设置/);
    expect((caught as Error).message).toMatch(/使用智能体评分/);
  });

  it('requireJudgeAgent：协议不匹配 → CONFLICT，并点名两家', () => {
    // codex 只吃 openai 协议（注册表元数据），拿 anthropic 的路由喂它必然在运行时才炸
    let caught: unknown;
    try {
      requireJudgeAgent({
        defaultJudgeAgent: 'codex',
        route: { protocolType: 'anthropic', baseUrl: 'x', apiKey: 'k', modelId: 'model-from-anthropic-provider' },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toMatch(/Codex 只接受 OpenAI 兼容协议/);
    // 两种协议 + 具体模型 id 都要在文案里：只说「不匹配」，用户不知道该换哪一个
    //（模型 id 用足够独特的一个字面量，避免断言被文案里的其它英文单词顺带满足）
    expect((caught as Error).message).toContain('Anthropic 兼容');
    expect((caught as Error).message).toContain('model-from-anthropic-provider');
  });

  it('requireJudgeAgent：匹配时原样返回那个 kind', () => {
    expect(
      requireJudgeAgent({ defaultJudgeAgent: 'codex', route: { protocolType: 'openai', baseUrl: 'x', apiKey: 'k', modelId: 'm' } }),
    ).toBe('codex');
    expect(
      requireJudgeAgent({ defaultJudgeAgent: 'dsh', route: { protocolType: 'anthropic', baseUrl: 'x', apiKey: 'k', modelId: 'm' } }),
    ).toBe('dsh');
    // claude-code 也是 anthropic 协议：三家都要被覆盖到，否则「只放行 dsh」的实现也能全绿
    expect(
      requireJudgeAgent({
        defaultJudgeAgent: 'claude-code',
        route: { protocolType: 'anthropic', baseUrl: 'x', apiKey: 'k', modelId: 'm' },
      }),
    ).toBe('claude-code');
  });

  /**
   * **枚举之外的值**（手改 config.json 写进 `"gemini"`）必须折成 CONFLICT + 指向评分配置。
   *
   * 为什么这条守卫真的需要：`loadConfig()` 不做 zod 校验（只把磁盘 json 与默认值合并），
   * 于是这个值能一路走到 agents 的 `getProvider()`——那里抛的是裸 `Error`，路由层折成
   * 500「服务端内部错误」：使用者拿着一个指向服务端的报错，而该做的是去改评分配置那一格。
   * 类型断言是刻意的：这一段测的就是「类型系统拦不住的那条路」（磁盘上的 json 不受 TS 约束）。
   */
  it('requireJudgeAgent：枚举之外的默认评分智能体 → CONFLICT 并指向评分配置，而不是裸 Error', () => {
    let caught: unknown;
    try {
      requireJudgeAgent({
        defaultJudgeAgent: 'gemini' as AgentKind,
        route: { protocolType: 'openai', baseUrl: 'x', apiKey: 'k', modelId: 'm' },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toContain('gemini');
    expect((caught as Error).message).toMatch(/评分配置/);
    // 阴性面：绝不能是 agents 那个裸 Error 的原文（那一条会以 500 上屏，且指向错误的方向）
    expect((caught as Error).message).not.toContain('未注册的智能体');
  });
});

/**
 * 评分档位的**读点**（`resolveJudgeEffort`）与**第二道门**（`requireJudgeEffort`）。
 *
 * 为什么这道门必须有：`effort: ''` / 越域档位的守卫只作用于走 schema 的**写下侧**（设置页那条
 * patch 路由），而 `loadConfig()` **故意不做 schema 校验**（一条手改坏的值不该让设置页打不开）
 * ⇒ 手改 `config.json` 写进去的值会一路到消费方。不拦的话要跑到 dsh 的
 * `UNSUPPORTED_REASONING_EFFORT` 才失败——症状离真因很远（这正是要消灭的那类报错）。
 * 判据与创建评测时的档位校验（`api/runs.ts` 的 `resolveRunRows`）**同源**：都用 `intersectEfforts`，
 * 故这里不 mock `@aieval/agents`：`allowed` 的取值全在「真实注册表元数据」上（dsh 的域没有 `medium`）。
 */
describe('resolveJudgeEffort / requireJudgeEffort', () => {
  it('resolveJudgeEffort 与 defaultJudge 同源；未配置时 undefined（未指定，不是某一档）', () => {
    seed({ providerId: 'p1', modelId: 'm1', effort: 'max' }, [provider('p1', ['m1'])]);
    expect(resolveJudgeEffort()).toBe('max');

    // 未配置 = 一个强度键都不发（听网关缺省）；它不是 `off`（显式关闭），也不是某一档
    seed(null, [provider('p1', ['m1'])]);
    expect(resolveJudgeEffort()).toBeUndefined();
  });

  it('dsh 收不了 medium ⇒ CONFLICT，且 allowed 恰好是 off/low/high/max（第二道门存在的理由）', () => {
    let caught: unknown;
    try {
      requireJudgeEffort({
        effort: 'medium',
        model: { id: 'm1', source: 'manual' },
        // dsh 的域是 off/low/high/max —— 没有 medium。上游没声明 supportedEfforts 时兜规范五档，
        // 但**兜底那份也要过智能体这道筛**（Ruling 27）：少了这一筛，medium 会摆到一个 dsh 硬报错的档上
        agentKind: 'dsh',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toMatch(/评分配置/);
    expect((caught as Error).message).toContain('medium');
    // `allowed` 那一格是这条门的判据本身，故逐字钉住（`toContain` 的写法对「多了 medium」无感）
    expect((caught as ServiceError).context).toEqual({ effort: 'medium', allowed: ['off', 'low', 'high', 'max'] });
  });

  it('同一个 medium 换成 codex 就合法（域是「模型 ∩ 智能体」，不是智能体自己那一份）', () => {
    expect(() =>
      requireJudgeEffort({ effort: 'medium', model: { id: 'm1', source: 'manual' }, agentKind: 'codex' }),
    ).not.toThrow();
  });

  it('上游声明过档位 ⇒ 越出模型声明的档同样拦（声明那一份优先于规范五档）', () => {
    const model = { id: 'm1', source: 'manual' as const, supportedEfforts: ['low', 'high'] };
    // 声明过就按声明算（并上关闭档）：`max` 既不在模型声明里，也不该被规范五档捞回来
    expect(() => requireJudgeEffort({ effort: 'max', model, agentKind: 'codex' })).toThrow(ServiceError);
    expect(() => requireJudgeEffort({ effort: 'low', model, agentKind: 'codex' })).not.toThrow();
  });

  it('未配置档位（undefined）⇒ 放行：「未指定」不是越域', () => {
    expect(() =>
      requireJudgeEffort({ effort: undefined, model: { id: 'm1', source: 'manual' }, agentKind: 'dsh' }),
    ).not.toThrow();
  });

  /**
   * 空串是**填坏了的档位**，不是「未指定」（`DefaultJudgeSchema.effort` 是 `z.string().min(1).optional()`）。
   * 写下侧那条 schema 拦得住它，而手改 `config.json` 的那一份只能靠这道门——放行的话它会一路传进请求体。
   */
  it('空串不是「未指定」⇒ 拦下，且文案不出现「强度  不可用」这种读不出是什么值的句子', () => {
    let caught: unknown;
    try {
      requireJudgeEffort({ effort: '', model: { id: 'm1', source: 'manual' }, agentKind: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    // 空串在模板里会渲染成一片空白：用户读到的是「思考强度  不可用」，认不出是哪一格坏了
    expect((caught as Error).message).toContain('（空串）');
    expect((caught as Error).message).toMatch(/评分配置/);
  });

  it('没配评分智能体 ⇒ 规范五档当智能体域（codex 的 xhigh 在这一支非法）', () => {
    // 兜底域是「两条驱动方式都能表达」的那一组：xhigh 只有 codex 收，故未配智能体时它不该放行
    expect(() =>
      requireJudgeEffort({ effort: 'xhigh', model: { id: 'm1', source: 'manual' }, agentKind: null }),
    ).toThrow(ServiceError);
    expect(() =>
      requireJudgeEffort({ effort: 'medium', model: { id: 'm1', source: 'manual' }, agentKind: null }),
    ).not.toThrow();
  });

  /**
   * 越枚举的评分智能体（手改 `config.json` 写 `"gemini"`）**按「未配」判**，不抛裸 Error。
   * 为什么不能照直交给 `getProvider()`：它抛的是裸 `Error`（`agents/src/registry.ts`），路由层折成
   * 500「服务端内部错误」——而这条路上真正该改的是评分配置。该字段的归因留给 `requireJudgeAgent`
   * （它有专门的第三道判据与中文文案）；生成 / 识别那条文本通路**压根不读**这一格，
   * 因一个它不读的字段把功能拒掉属于越权误伤。
   */
  it('越枚举的评分智能体按「未配」判：medium 放行、xhigh 仍拦（说明用的是规范五档）', () => {
    expect(() =>
      requireJudgeEffort({ effort: 'medium', model: { id: 'm1', source: 'manual' }, agentKind: 'gemini' as AgentKind }),
    ).not.toThrow();
    // 阴性面：若这里退化成「枚举外的值一律跳过校验」，下面这条就不会红
    let caught: unknown;
    try {
      requireJudgeEffort({ effort: 'xhigh', model: { id: 'm1', source: 'manual' }, agentKind: 'gemini' as AgentKind });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
  });
});

/**
 * 以下用例**不在用例清单里**，是补的守卫。
 * 为什么补：现成的 `provider()` 夹具把 protocolType 写死成 'openai'，于是
 * `return { protocolType: 'openai', … }` 这种「常量实现」能让上面六条用例全绿——
 * 而真值来自供应商记录：Anthropic 供应商被判成 openai 时，评分会拿着 Bearer 去打
 * `/chat/completions`，症状是 401（或 404），且只在 anthropic 供应商上出现。
 * 归属不变：`protocolType` 的映射是本模块的职责（`TextRoute`），不是调用方的。
 */
describe('resolveJudgeRoute —— 补充守卫（夹具只有 openai 供应商）', () => {
  it('供应商是 anthropic 时 protocolType 原样带进路由，而不是写死的 openai', () => {
    seed({ providerId: 'pa', modelId: 'ma' }, [
      { ...provider('pa', ['ma']), protocolType: 'anthropic', baseUrl: 'https://pa.example.com/anthropic' },
    ]);
    expect(resolveJudgeRoute()).toEqual({
      protocolType: 'anthropic',
      baseUrl: 'https://pa.example.com/anthropic',
      apiKey: 'sk-pa-secret',
      modelId: 'ma',
    });
  });
});

/**
 * 以下用例**不在用例清单里**，是补的包根出口守卫（变异分析发现的缺口）。
 * 为什么补：上面所有用例都从**模块路径**（`'./text-api'` / `'./judge-route'`）import，
 * 于是包根出口 `src/index.ts` 即便把 `callTextApi` / `TextRoute` 漏掉，
 * 整套用例依然 21/21 全绿（实测：把 `export { callTextApi, type TextRoute } from './text-api';`
 * 整行删掉后全绿）——而「AI 生成评分标准项」与 api 层只会从包根 `@aieval/evaluator` 取这两个名字，
 * 漏出口的表现是接入第一天 `tsc` 报 TS2305，或运行时 `callTextApi is not a function`。
 * 两个名字的可见性不同，故分两条：运行时看得到的是函数，类型只有 tsc 看得见。
 */
describe('evaluator 包根出口（`@aieval/evaluator`）', () => {
  it('callTextApi 与 resolveJudgeRoute 都能从包根拿到', async () => {
    const evaluator = await import('./index');
    for (const name of ['callTextApi', 'resolveJudgeRoute']) {
      expect(typeof (evaluator as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('包根还导出类型 TextRoute（类型擦除，守卫本体是文件顶部的 import type）', () => {
    // 这条用例的实质在编译期：`import type { TextRoute } from './index'` 一旦取不到，
    // `pnpm --filter @aieval/evaluator typecheck` 会以 TS2305 点名本文件。
    // 下面的断言只是让这个类型在值层面「被用到」，不被 tsc / eslint 当死代码。
    const probe: TextRoute | null = null;
    expect(probe).toBeNull();
  });
});
