// @vitest-environment node
/**
 * 错误归因：加载失败要点名包名与安装方式；401/429/404 的文案要求见 §5.6.6 的表。
 * 为什么归因必须由适配器做：事件流里拿到的往往只有一句上游文案，编排层无法知道网关是「限流」还是
 * 「模型名拼错」——这两件事给用户的下一步动作完全不同。
 */
import { describe, expect, it } from 'vitest';
import { AgentLoadError, classifyAgentFailure, classifyAgentMessage } from './errors';

const CONTEXT = { kind: 'codex', baseUrl: 'https://gw.example.com/openai/v1' } as const;

describe('AgentLoadError', () => {
  it('点名包名 + 安装方式，并保留原始原因', () => {
    const error = new AgentLoadError('@openai/codex-sdk', new Error('Cannot find module'));
    expect(error.code).toBe('AGENT_LOAD_FAILED');
    expect(error.packageName).toBe('@openai/codex-sdk');
    expect(error.variant).toBe('missing'); // 省略第三参就是「包没装」这一队
    expect(error.message).toContain('@openai/codex-sdk');
    expect(error.message).toContain('pnpm add @openai/codex-sdk');
    expect(error.message).toContain('Cannot find module');
    expect(error).toBeInstanceOf(Error);
  });

  /**
   * 第二种语义（评审 M1）：包**已安装**，只是导出面与适配器期望的不一致。
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

  it('原因是任意值时也不抛（事件流里的 cause 可能是字符串或对象）', () => {
    expect(() => new AgentLoadError('@x/y', { weird: true })).not.toThrow();
  });
});

describe('classifyAgentFailure', () => {
  it('401 → AUTH_FAILED，文案带 host 并指向设置页', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('unauthorized'), { status: 401 }), CONTEXT);
    expect(failure.code).toBe('AUTH_FAILED');
    expect(failure.message).toContain('gw.example.com');
    expect(failure.message).toContain('设置');
  });

  it('429 → RATE_LIMITED，文案建议改用串行', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('too many requests'), { statusCode: 429 }), CONTEXT);
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.message).toContain('串行');
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
    const failure = classifyAgentFailure(new AgentLoadError('@openai/codex-sdk', new Error('boom')), CONTEXT);
    expect(failure.code).toBe('AGENT_LOAD_FAILED');
  });
});

/**
 * 字符串型状态码（评审 N1）：有的厂商 SDK 给 `status: '429'`，而 `readNumber` 的既定口径是
 * 「只认 number」。若这里不认字符串，`'429'` / `'401'` 会落到兜底分支——用户拿到的是无指向的原文，
 * 而不是「改用串行」/「去设置页核对密钥」这两条可执行建议，等于 `classifyAgentFailure` 白写。
 */
describe('字符串型状态码（评审 N1）', () => {
  it('`status: "429"` → RATE_LIMITED，文案建议改用串行', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('slow down'), { status: '429' }), CONTEXT);
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.message).toContain('串行');
  });

  it('`statusCode: "401"` → AUTH_FAILED，文案带 host 并指向设置页', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('denied'), { statusCode: '401' }), CONTEXT);
    expect(failure.code).toBe('AUTH_FAILED');
    expect(failure.message).toContain('gw.example.com');
    expect(failure.message).toContain('设置');
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
});
