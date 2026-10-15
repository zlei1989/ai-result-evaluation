// @vitest-environment node
/**
 * 错误归因：加载失败要点名包名与安装方式；401/429/404 各有文案要求。
 * 为什么归因必须由适配器做：事件流里拿到的往往只有一句上游文案，编排层无法知道网关是「限流」还是
 * 「模型名拼错」——这两件事给用户的下一步动作完全不同。
 */
import { describe, expect, it } from 'vitest';
import type { FailureContext } from './errors';
import { AgentLoadError, classifyAgentFailure, classifyAgentMessage } from './errors';

/** 家别是 dsh 的那一份（上面两条厂商码判据只对这一家成立） */
const DSH_CONTEXT: FailureContext = { kind: 'dsh', baseUrl: 'https://gw.example.com/v1' };

const CONTEXT = { kind: 'codex', baseUrl: 'https://gw.example.com/openai/v1' } as const;

describe('`missing` 那一档的补救动作按**层次**分', () => {
  /**
   * 要拦的缺陷：三种成因（没装 / 装了但不全 / 基准无效）在**补救动作上恰好相反**，
   * 却都拿到同一句「`pnpm add`」——包已经在的那两种照做一遍不会有任何变化。
   * 判据是**文案里有没有那句会白做的事**，所以逐档断言关键句，而不是断言三条互不相等。
   */
  const at = (remedy: 'install' | 'repair-package' | 'fix-anchor'): string =>
    new AgentLoadError('@openai/codex', new Error('解析不到'), { remedy }).message;

  it('缺省（没装）⇒ 给安装命令', () => {
    expect(at('install')).toContain('pnpm add @openai/codex');
  });

  it('装了但不全 ⇒ 明说「装一次不会有任何变化」', () => {
    const message = at('repair-package');
    expect(message).toContain('装一次不会有任何变化');
    expect(message).not.toContain('pnpm add @openai/codex');
  });

  it('包与文件都在、基准无效 ⇒ 指向环境而不是重装', () => {
    const message = at('fix-anchor');
    expect(message).toContain('解析基准在当前环境无效');
    expect(message).not.toContain('pnpm add @openai/codex');
    expect(message).not.toContain('装一次不会有任何变化');
  });
});

describe('AgentLoadError', () => {
  it('点名包名 + 安装方式，并保留原始原因', () => {
    const error = new AgentLoadError('@openai/codex', new Error('Cannot find module'));
    expect(error.code).toBe('AGENT_LOAD_FAILED');
    expect(error.packageName).toBe('@openai/codex');
    expect(error.variant).toBe('missing'); // 省略第三参就是「包没装」这一队
    expect(error.message).toContain('@openai/codex');
    expect(error.message).toContain('pnpm add @openai/codex');
    expect(error.message).toContain('Cannot find module');
    expect(error).toBeInstanceOf(Error);
  });

  /**
   * 第二种语义：包**已安装**，只是导出面与适配器期望的不一致。
   * 为什么这条是必修：dsh 在探测回写之前，这条路径是它**唯一**的用户可见结论，而旧模板让它去
   * `pnpm add` 一个已在 `dependencies` 里、`node_modules` 完整、镜像无关的包 ⇒ 补救恒无效，
   * 还把排查方向带向「网络 / 重装」。
   */
  it('shape-mismatch：已安装但不匹配 —— 文案不含 `pnpm add`，点名期望入口与实测导出面', () => {
    const error = new AgentLoadError('@deepseek-ai/dsh-sdk-client', new Error('模块缺少 createRuntime 导出'), {
      variant: 'shape-mismatch',
      expected: 'createRuntime',
      actual: ['DeepSeekHarness', 'HarnessClient'],
    });
    expect(error.code).toBe('AGENT_LOAD_FAILED');
    expect(error.variant).toBe('shape-mismatch');
    expect(error.message).not.toContain('pnpm add'); // 关键：恒无效的指令不得出现在这条分支
    expect(error.message).toContain('已安装');
    expect(error.message).toContain('不是安装问题');
    expect(error.message).toContain('createRuntime'); // 期望的入口
    expect(error.message).toContain('HarnessClient'); // 实测拿到的
    expect(error.message).toContain('模块缺少 createRuntime 导出'); // 原因照传
    expect(error).toBeInstanceOf(Error);
  });

  it('shape-mismatch 且读不到任何导出时，文案有兜底措辞（不出现空括号）', () => {
    const error = new AgentLoadError('@x/y', new Error('没有导出'), { variant: 'shape-mismatch' });
    expect(error.message).toContain('（读不到任何导出）');
    expect(error.message).toContain('（未登记）');
    expect(error.message).not.toContain('pnpm add');
  });

  /**
   * 第三种语义：包与导出面都对，是**运行时太老**。
   * 为什么必须与 `missing` 分开：这条路径上包在、`node_modules` 完整，安装命令同样恒无效，
   * 而补救动作（升级 Node）与另两条完全不同 ⇒ 文案要点名要求下限、本机版本，并排掉重装。
   */
  it('node-version：运行时低于厂商下限 —— 文案点名下限与本机版本，且不含 `pnpm add`', () => {
    const error = new AgentLoadError('@earendil-works/pi-coding-agent', new Error('需要 Node ≥22.19.0，当前 20.11.0'), {
      variant: 'node-version',
      required: '≥22.19.0',
      current: '20.11.0',
    });
    expect(error.code).toBe('AGENT_LOAD_FAILED');
    expect(error.variant).toBe('node-version');
    expect(error.message).not.toContain('pnpm add');
    expect(error.message).toContain('@earendil-works/pi-coding-agent');
    expect(error.message).toContain('Node ≥22.19.0'); // 要求的下限
    expect(error.message).toContain('20.11.0'); // 本机实测版本
    expect(error.message).toContain('升级 Node');
  });

  it('node-version 缺字段时文案有兜底措辞（不出现半截句子）', () => {
    const error = new AgentLoadError('@x/y', new Error('版本不够'), { variant: 'node-version' });
    expect(error.message).toContain('（未登记）');
    expect(error.message).toContain('（读不到版本）');
    expect(error.message).not.toContain('pnpm add');
  });

  it('原因是任意值时也不抛（事件流里的 cause 可能是字符串或对象）', () => {
    expect(() => new AgentLoadError('@x/y', { weird: true })).not.toThrow();
  });
});

describe('classifyAgentFailure', () => {
  it('401 → AUTH_FAILED，文案**只说技术事实**（带 host，不替产品指路）', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('unauthorized'), { status: 401 }), CONTEXT);
    expect(failure.code).toBe('AUTH_FAILED');
    expect(failure.message).toContain('gw.example.com');
    // 「去哪儿改」由编排层按归因码追加（`orchestrator.ts` 的 `withProductHint`）：
    // 适配层替产品说话，会让这个包换一处复用就说不通
    expect(failure.message).not.toContain('设置');
  });

  it('429 → RATE_LIMITED，文案带 host 与本次是哪一家（建议也由编排层补）', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('too many requests'), { statusCode: 429 }), CONTEXT);
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.message).toContain('gw.example.com');
    expect(failure.message).toContain('codex');
    expect(failure.message).not.toContain('串行');
  });

  it('404 / 400 → AGENT_FAILED，且保留上游响应正文', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('model gpt-x not found'), { status: 404 }), CONTEXT);
    expect(failure.code).toBe('AGENT_FAILED');
    expect(failure.message).toContain('404');
    expect(failure.message).toContain('model gpt-x not found');
  });

  it('宿主没有 status 字段时从文案里认状态码（网关常把它写在正文里）', () => {
    expect(classifyAgentFailure(new Error('gateway replied 429'), CONTEXT).code).toBe('RATE_LIMITED');
  });

  it('spawn ENOENT → AGENT_FAILED，并指向缺失的可执行文件', () => {
    const failure = classifyAgentFailure(new Error('spawn codex ENOENT'), CONTEXT);
    expect(failure.code).toBe('AGENT_FAILED');
    expect(failure.message).toContain('可执行文件');
  });

  it('其它错误 → AGENT_FAILED，原文照传（保留排障线索）', () => {
    const failure = classifyAgentFailure(new Error('进程非零退出：3'), CONTEXT);
    expect(failure.code).toBe('AGENT_FAILED');
    expect(failure.message).toBe('进程非零退出：3');
  });

  it('AgentLoadError 原样透出（加载失败要有自己的码）', () => {
    const failure = classifyAgentFailure(new AgentLoadError('@openai/codex', new Error('boom')), CONTEXT);
    expect(failure.code).toBe('AGENT_LOAD_FAILED');
  });
});

/**
 * 字符串型状态码：有的厂商 SDK 给 `status: '429'`，而 `readNumber` 的既定口径是
 * 「只认 number」。若这里不认字符串，`'429'` / `'401'` 会落到兜底分支——用户拿到的是无指向的原文，
 * 而不是「上游限流（host）」/「密钥无效或无权访问（host）」这两条带 host 的归因，
 * 等于 `classifyAgentFailure` 白写（可执行建议由编排层按归因码补）。
 */
describe('字符串型状态码', () => {
  it('`status: "429"` → RATE_LIMITED', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('slow down'), { status: '429' }), CONTEXT);
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.message).toContain('gw.example.com');
  });

  it('`statusCode: "401"` → AUTH_FAILED，文案带 host', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('denied'), { statusCode: '401' }), CONTEXT);
    expect(failure.code).toBe('AUTH_FAILED');
    expect(failure.message).toContain('gw.example.com');
  });

  it('非纯数字字符串不算状态（绝不把 `abc` / 空串硬转成假归因）', () => {
    /**
     * 判据设计（这个地方我第一版写错过，记下来）：
     * ① 文案里**故意**带 `HTTP 404`，好让两条路径的**产物**可区分：
     *    - 正确实现：status 当成「没有」⇒ 退回文案扫描 ⇒ 命中 404 分支 ⇒ 文案形如
     *      `请求被上游拒绝（HTTP 404，host）：…`;
     *    - 把纯数字校验放宽的变异体：status 返回一个非 null 的垃圾值 ⇒ 跳过文案扫描 ⇒ 落到兜底 ⇒
     *      文案就是原文，**没有** `（HTTP 404，host）：…` 那段前缀。
     * ② `toContain('HTTP 404')` **不能**退化成 `toContain('404')`——我第一版就是这么写的，而原文里
     *    恰好也有 `404` 三个字符，于是断言在正确实现与变异体下**都成立**（空转，我实测变异体存活）。
     *    要断言的必须是**分支产物**（带 host 的那句），不是三个数字字符。
     */
    const nonNumeric = classifyAgentFailure(
      Object.assign(new Error('上游把状态字段搞坏了（HTTP 404）'), { status: 'abc' }),
      CONTEXT,
    );
    expect(nonNumeric.code).toBe('AGENT_FAILED');
    expect(nonNumeric.message).toContain('请求被上游拒绝（HTTP 404，gw.example.com）');
    const empty = classifyAgentFailure(
      Object.assign(new Error('上游把状态字段搞坏了（HTTP 404）'), { status: '' }),
      CONTEXT,
    );
    expect(empty.code).toBe('AGENT_FAILED');
    expect(empty.message).toContain('请求被上游拒绝（HTTP 404，gw.example.com）');
  });
});

describe('classifyAgentMessage', () => {
  it('从厂商给的纯文本归因（事件流里没有 Error 对象）', () => {
    expect(classifyAgentMessage('HTTP 401 unauthorized', CONTEXT).code).toBe('AUTH_FAILED');
    expect(classifyAgentMessage('everything is fine', CONTEXT).code).toBe('AGENT_FAILED');
  });

  /**
   * **厂商的结构化失败码**（真机原文逐字取自 dsh 的 `turn/end(kind:'error')`，探针
   * 真机探针三档：空 key / key 带换行 / `contextWindow` 给小 + 长提示词）。缺省那条路会把它们一并归成 `AGENT_FAILED`，
   * 而它在 `TRANSIENT_ROW_RETRY_CODES` 里 ⇒ 一个**确定性**的失败被自动重跑两遍
   * （每次 3 秒 + 一整轮模型时间），而原因还指向「CLI 起不来 / 进程非零退出」这条错方向。
   */
  it('厂商凭证码（空 key / key 带换行）⇒ AUTH_FAILED，而不是可重试的 AGENT_FAILED', () => {
    const missing = classifyAgentMessage(
      '[MISSING_CREDENTIAL] llm-pi-ai: no credential for provider route "aieval-route"; its profile resolves AIEVAL_ROUTE_API_KEY, which is not set — store AIEVAL_ROUTE_API_KEY through the credentials service (the web Models page writes it) or export it',
      DSH_CONTEXT,
    );
    expect(missing.code).toBe('AUTH_FAILED');
    expect(missing.message).toContain('gw.example.com');

    const invalid = classifyAgentMessage(
      '[INVALID_CREDENTIAL] llm-pi-ai: the API key resolved from AIEVAL_ROUTE_API_KEY contains characters no HTTP header can carry; set AIEVAL_ROUTE_API_KEY to the raw key alone (the web Models page writes it)',
      DSH_CONTEXT,
    );
    expect(invalid.code).toBe('AUTH_FAILED');
  });

  it('厂商的上下文超窗码 ⇒ AGENT_CONTEXT_OVERFLOW（确定性失败，同样不可重试）', () => {
    const overflow = classifyAgentMessage(
      '[CONTEXT_WINDOW_EXCEEDED] pi-ai detected context overflow for model "jd/deepseek-v4-flash-0731"',
      DSH_CONTEXT,
    );
    expect(overflow.code).toBe('AGENT_CONTEXT_OVERFLOW');
    expect(overflow.message).toContain('gw.example.com');
    expect(overflow.message).toContain('缩短提示词');
  });

  /**
   * ⚠️ **这四句特征串只对 dsh 成立**：归因函数是四家共用的入口，而这些串全部来自 dsh 侧
   * （`dsh-llm` / `dsh-llm-pi-ai`）。不加家别闸的话，别家普通错误里恰好出现这几个字样就会被顶成
   * 「密钥无效 / 超出上下文窗口」——而这两档**刻意不在重试表里**（错方向的补救建议 + 真因被顶掉）。
   */
  it('这几句特征串只对 dsh 生效：别家的同文案不被顶成 AUTH_FAILED / 超窗', () => {
    for (const kind of ['cc', 'codex', 'pi'] as const) {
      const context = { ...CONTEXT, kind };
      expect(
        classifyAgentMessage('the [MISSING_CREDENTIAL] setting is missing in the tool output', context).code,
      ).toBe('AGENT_FAILED');
      expect(classifyAgentMessage('detected context overflow in the fixture text', context).code).toBe('AGENT_FAILED');
    }
  });

  it('没带厂商码时不误判：普通 401 文案仍走状态码那一支，普通错误仍走 AGENT_FAILED', () => {
    expect(classifyAgentMessage('HTTP 401 unauthorized', CONTEXT).code).toBe('AUTH_FAILED');
    expect(classifyAgentMessage('pi-ai: model not found', CONTEXT).code).toBe('AGENT_FAILED');
  });
});
