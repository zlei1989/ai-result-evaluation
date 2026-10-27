// @vitest-environment node
/**
 * 自定义请求头在 agents 侧的两个落点工具：可发送性闸（摘掉 + WARN 只记键名）与 cc 的换行格式。
 *
 * 为什么这两条各自值得一条守卫：
 *   · 形状闸被四家共用。它一旦「不摘」而是「原样透」，坏头会在厂商那一侧变成一个 400，
 *     界面上看起来是「模型报错」，而真因在设置里那一条手改坏的行上——离现场极远；
 *   · 换行格式是 cc 那一家唯一的落点。格式写错（`=`、JSON、多行拼接漏一个）时 CLI 会
 *     **静默地一条都不加**：请求照常成功，只是没带上用户的头。
 */
import { describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_CUSTOM_HEADERS_ENV, formatCustomHeaderLines, sendableRequestHeaders } from './request-headers';

/**
 * 捕获 console.warn 的原文（log 的 WARN 走 console.warn 这条路）。
 * 上下文是**第二个实参**（对象），按仓库口径原样透传而不是 JSON 化——这里也照它的实际形状读：
 * 第一参是那句话、其余逐个 `String()`，于是「值有没有被写进日志」这条判据能看见对象里的每一个字。
 */
function captureWarns(): string[] {
  const messages: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    messages.push(
      args
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg)))
        .join(' '),
    );
  });
  return messages;
}

describe('sendableRequestHeaders', () => {
  it('缺省 / 空表都回 undefined（「没配」与「配了零条」在厂商那一侧是同一个形状）', () => {
    expect(sendableRequestHeaders(undefined)).toBeUndefined();
    expect(sendableRequestHeaders({})).toBeUndefined();
  });

  it('正常值原样通过（含冒号、空格与 ASCII 以外的 Latin-1 字符）', () => {
    silentWarn(() => {
      expect(sendableRequestHeaders({ 'X-Trace-Id': 'abc:123 456', 'X-Team': 'évaluation' })).toEqual({
        'X-Trace-Id': 'abc:123 456',
        'X-Team': 'évaluation',
      });
    });
  });

  /**
   * **非 Latin-1 的字发不出去**：`Headers` 按 ByteString 校验，一个汉字就让构造抛错
   * （原文 `Cannot convert argument to a ByteString … value of 35780 which is greater than 255`）。
   * 四家的请求走 fetch，这条因此是「真发不出去」而不是我们的额外限制——摘掉并 WARN 才是对的那一手：
   * 原样透下去会让整个请求在厂商伪造层之外的地方抛，看起来像「这家 SDK 挂了」。
   */
  it('含中文等非 Latin-1 字符的值被摘掉（Headers 按 ByteString 校验）', () => {
    const warns = captureWarns();
    const result = sendableRequestHeaders({ 'X-Team': '评测组', 'X-Trace-Id': 'abc' });
    vi.restoreAllMocks();

    expect(result).toEqual({ 'X-Trace-Id': 'abc' });
    expect(warns.join('\n')).toContain('X-Team');
  });

  it('发不出去的条目被摘掉，其余照发（一条坏头不该拖垮整张表）', () => {
    const warns = captureWarns();
    const result = sendableRequestHeaders({ 'X Trace': 'v', 'X-Trace-Id': 'abc', 'X-Bad': 'a\nb' });
    vi.restoreAllMocks();

    expect(result).toEqual({ 'X-Trace-Id': 'abc' });
    expect(warns.join('\n')).toContain('X Trace');
    expect(warns.join('\n')).toContain('X-Bad');
  });

  /**
   * 只记键名、不记值：值是用户填的密钥时，整条打出来就是把密钥写进日志。
   * 判据取「值里的哨兵串一次都不许出现在 WARN 里」。
   */
  it('WARN 只记键名，不记值', () => {
    const warns = captureWarns();
    sendableRequestHeaders({ 'X Bad': 'super-secret-value-0001' });
    vi.restoreAllMocks();

    expect(warns.join('\n')).toContain('X Bad');
    expect(warns.join('\n')).not.toContain('super-secret-value-0001');
  });

  it('全坏时回 undefined（不是空表）', () => {
    silentWarn(() => expect(sendableRequestHeaders({ 'X Bad': 'v' })).toBeUndefined());
  });

  it('返回的是新对象：改它不改入参', () => {
    const input = { 'X-Trace-Id': 'abc' };
    silentWarn(() => {
      const out = sendableRequestHeaders(input);
      if (out === undefined) throw new Error('应当有可发送的条目');
      out['X-Trace-Id'] = 'changed';
    });

    expect(input['X-Trace-Id']).toBe('abc');
  });
});

/** 在静音状态下跑一段（不关心 WARN 的用例别把噪声打进测试输出） */
function silentWarn<T>(run: () => T): T {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

describe('formatCustomHeaderLines', () => {
  it('一条头一行「名字: 值」，行间用换行（CLI 的唯一格式）', () => {
    expect(formatCustomHeaderLines({ 'X-Trace-Id': 'abc', 'X-Team': 'évaluation' })).toBe(
      'X-Trace-Id: abc\nX-Team: évaluation',
    );
  });

  it('空 / 缺省都回 undefined（不注入空串去顶掉宿主同名变量）', () => {
    expect(formatCustomHeaderLines(undefined)).toBeUndefined();
    expect(formatCustomHeaderLines({})).toBeUndefined();
  });

  it('值里的冒号不会被当成分隔符切坏（只切第一个冒号是 CLI 那侧的事）', () => {
    expect(formatCustomHeaderLines({ 'X-Url': 'https://gw.example.com:8443/a' })).toBe('X-Url: https://gw.example.com:8443/a');
  });

  it('环境变量名逐字钉住（拼错的表现是一条头都不加，且没有任何报错）', () => {
    expect(ANTHROPIC_CUSTOM_HEADERS_ENV).toBe('ANTHROPIC_CUSTOM_HEADERS');
  });
});
