// @vitest-environment node
/** 日志：级别门控、上下文透传、debug 生产默认关闭。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger';

// 先删一次，让「开发者 shell 里 export 了 AIEVAL_DEBUG=1」不再影响结果。
// 只靠 afterEach 时全量跑恰好看不出问题（第一条用例的 afterEach 会先把它洗掉），
// 但子集运行会直接误报失败——实测 `vitest run -t 'debug 默认关闭'`：× expected "log" to not be
// called at all, but actually been called 1 times。免疫性不该取决于用例顺序与运行方式。
beforeEach(() => {
  delete process.env.AIEVAL_DEBUG;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AIEVAL_DEBUG;
});

describe('createLogger', () => {
  it('info / warn / error 总是输出，并带上 scope 前缀与上下文', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const log = createLogger('config-store');
    log.info('读取配置', { file: 'a.json' });
    log.warn('配置缺失，用默认值');
    log.error('写盘失败', { path: 'a.json' });

    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toContain('[config-store]');
    expect(String(spy.mock.calls[0]?.[0])).toContain('读取配置');
    // 上下文要真的到达 console，而不是被拼进前缀里（或被 JSON.stringify 后丢掉）
    expect(spy.mock.calls[0]?.[1]).toEqual({ file: 'a.json' });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledOnce();
  });

  it('上下文含循环引用时不抛错（日志器不该能抛）', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => createLogger('x').info('带循环上下文', circular)).not.toThrow();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('debug 默认关闭', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('x').debug('细节');
    expect(spy).not.toHaveBeenCalled();
  });

  it('设了 AIEVAL_DEBUG=1 时 debug 输出', () => {
    process.env.AIEVAL_DEBUG = '1';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('x').debug('细节');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('debug 门控是运行时读环境变量，不是模块加载时读', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('x');
    log.debug('之前');
    process.env.AIEVAL_DEBUG = '1';
    log.debug('之后');
    expect(spy).toHaveBeenCalledOnce();
  });
});
