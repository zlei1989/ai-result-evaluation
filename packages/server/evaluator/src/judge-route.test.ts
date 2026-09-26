// @vitest-environment node
/**
 * 评分路由解析：**只有一个来源**——设置页「评分配置」的全局默认评分模型；
 * 没配（或配成了悬空引用）则 CONFLICT + 指向设置页的中文原因。
 * 本文件覆盖同一件事的两半：`resolveJudgeRoute`（尺子落在哪个模型）与 `requireJudgeAgent`
 * （谁来驱动它，见下面的同名 describe）。
 * 为什么解析放在 evaluator 而不是 api 层：evaluator 在评分阶段（p4）也要自己解析一次，
 * 而 evaluator 不能依赖 api（依赖方向单向）。
 * 注意：本文件用 setConfigDirForTesting + saveConfig 造出真实的配置文件，不 mock loadConfig——
 * 「全局默认那一对 id 真的被读盘读出来」这条只有在真的走一遍读盘时才会被验证到。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError, SETTINGS_DEFAULTS, type AgentKind, type Provider } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { resolveJudgeRoute, requireJudgeAgent } from './judge-route';
// 包根出口的守卫（见文件末尾「evaluator 包根出口」的第二个用例）：p2 / p5 只从
// `@aieval/evaluator` 取 `TextRoute` 这个类型，而类型在运行时被擦除——只有 tsc 看得见。
import type { TextRoute } from './index';

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

/** 写入一份含默认评分模型的配置 */
function seed(defaultJudge: { providerId: string; modelId: string } | null, providers: Provider[]): void {
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
  rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
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
   * 评分路由也带上模型声明的窗口（spec §4.2 / D1）。
   * 为什么必须有：智能体评分通路把这条 route **原样**交给适配器（`judge-agent.ts` 的 `route: input.route`），
   * 少了这一格，cc 驱动的评分模型不会加 `[1m]`、codex 不会写 `model_context_window`、dsh 不会写 settings.yaml
   * —— 与候选行的行为不一致，而界面上看不出任何差别（评分照样出分）。
   * 强度（`effort`）**刻意不在**这条路由上：评分那把尺子要跨轮次可比（spec §2「不做」）。
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
   * 终审 Minor：**枚举之外的值**（手改 config.json 写进 `"gemini"`）必须折成 CONFLICT + 指向评分配置。
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
 * 以下用例**超出 task-14 brief 的用例清单**，是本实现补的守卫。
 * 为什么补：brief 的 `provider()` 夹具把 protocolType 写死成 'openai'，于是
 * `return { protocolType: 'openai', … }` 这种「常量实现」能让上面六条用例全绿——
 * 而真值来自供应商记录：Anthropic 供应商被判成 openai 时，评分会拿着 Bearer 去打
 * `/chat/completions`，症状是 401（或 404），且只在 anthropic 供应商上出现。
 * 归属不变：`protocolType` 的映射是本模块的职责（契约 §5 的 `TextRoute`），不是调用方的。
 */
describe('resolveJudgeRoute —— 补充守卫（brief 的夹具只有 openai 供应商）', () => {
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
 * 以下用例**超出 task-14 brief 的用例清单**，是本实现补的包根出口守卫（变异分析发现的缺口）。
 * 为什么补：上面所有用例都从**模块路径**（`'./text-api'` / `'./judge-route'`）import，
 * 于是本任务 Step 6 的交付物 `src/index.ts` 即使把 `callTextApi` / `TextRoute` 漏掉，
 * 整套用例依然 21/21 全绿（实测：把 `export { callTextApi, type TextRoute } from './text-api';`
 * 整行删掉后全绿）——而 p2 的「AI 生成评分标准项」与 p5 只会从包根 `@aieval/evaluator` 取这两个名字，
 * 漏出口的表现是 p2 开工第一天 `tsc` 报 TS2305，或运行时 `callTextApi is not a function`。
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
