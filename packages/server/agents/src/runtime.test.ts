// @vitest-environment node
/**
 * 运行时注入点：默认空、可注入、可复位。
 * 注意：复位必须彻底——残留的假模块会让同一进程里其他用例拿到上一轮的厂商实现。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getAgentRuntime, setAgentRuntimeForTesting } from './runtime';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

describe('AgentRuntime', () => {
  it('默认没有 sdkModule（生产路径不注入任何东西）', () => {
    expect(getAgentRuntime().sdkModule).toBeUndefined();
  });

  it('注入后能按包名取到假模块（三家共用一个字段）', () => {
    const fake = { query: (): undefined => undefined };
    setAgentRuntimeForTesting({ sdkModule: { '@aieval/fake-sdk': fake } });
    const modules = getAgentRuntime().sdkModule as Record<string, unknown>;
    expect(modules['@aieval/fake-sdk']).toBe(fake);
  });

  it('传 null 复位，用例之间不残留', () => {
    setAgentRuntimeForTesting({ sdkModule: { '@aieval/fake-sdk': {} } });
    setAgentRuntimeForTesting(null);
    expect(getAgentRuntime().sdkModule).toBeUndefined();
  });
});
