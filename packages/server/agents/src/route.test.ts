// @vitest-environment node
/**
 * 路由注入：base URL 规范化的三家差异（表驱动）+ 「替换型」子进程环境。
 * /v1 的处理方向三家相反，且用户粘贴的 URL 形态五花八门（尾斜杠 × /v1 后缀 4 种组合），
 * 所以这里逐组合钉死——写错的表现是 404 或「明明配了网关却打到别处」。
 */
import { describe, expect, it } from 'vitest';
import { buildSubprocessEnv, ensureV1Suffix, stripV1Suffix } from './route';

describe('stripV1Suffix（claude-code：拆掉尾部 /v1）', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['https://gw.example.com/anthropic', 'https://gw.example.com/anthropic'],
    ['https://gw.example.com/anthropic/', 'https://gw.example.com/anthropic'],
    ['https://gw.example.com/anthropic/v1', 'https://gw.example.com/anthropic'],
    ['https://gw.example.com/anthropic/v1/', 'https://gw.example.com/anthropic'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(stripV1Suffix(input)).toBe(expected);
  });

  it('只拆结尾那一个 /v1（中间出现的 v1 属于路径，不能动）', () => {
    expect(stripV1Suffix('https://gw.example.com/v1/anthropic')).toBe('https://gw.example.com/v1/anthropic');
  });

  it('`/v1` 与结尾之间夹着重复斜杠时也要拆干净', () => {
    expect(stripV1Suffix('https://gw.example.com/anthropic//v1')).toBe('https://gw.example.com/anthropic');
  });
});

describe('ensureV1Suffix（codex：补上 /v1，只走 Responses wire）', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['https://gw.example.com/openai', 'https://gw.example.com/openai/v1'],
    ['https://gw.example.com/openai/', 'https://gw.example.com/openai/v1'],
    ['https://gw.example.com/openai/v1', 'https://gw.example.com/openai/v1'],
    ['https://gw.example.com/openai/v1/', 'https://gw.example.com/openai/v1'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(ensureV1Suffix(input)).toBe(expected);
  });

  it('重复斜杠收敛后再补 `/v1`（否则拼出 `//v1/responses`）', () => {
    expect(ensureV1Suffix('https://gw.example.com/openai//')).toBe('https://gw.example.com/openai/v1');
  });

  it('裸 host 与纯尾斜杠不产生 `//`（边界）', () => {
    expect(ensureV1Suffix('https://gw.example.com')).toBe('https://gw.example.com/v1');
    expect(ensureV1Suffix('https://gw.example.com/')).toBe('https://gw.example.com/v1');
  });
});

/**
 * 非典型粘贴：用户从设置页粘进来的 baseUrl 可能带 query / fragment / 重复斜杠。
 * 旧实现只看「整串的结尾」，于是要么不拆 `/v1`（claude 变 `/v1/v1/messages`），要么把 `/v1`
 * 追加进 query 值（codex 打到错误路径）——**主动写坏**比原样放过更糟。
 * 口径：只规范化**路径段**（顺便收敛重复斜杠），query / fragment 一个字符都不动。
 *
 * 注：dsh 侧的 `keepBaseUrl` 已随「统一到 llm-pi-ai」退役——pi-ai 不做任何 baseURL
 * 归一化，所以它现在也走 `stripV1Suffix` / `ensureV1Suffix` 这两个函数，与 claude / codex 同源。
 */
describe('带 query / fragment / 重复斜杠的粘贴（只动路径，不动 query）', () => {
  it('query 存在时 `/v1` 的判定落在路径上，query 原样带出', () => {
    expect(stripV1Suffix('https://gw.example.com/anthropic/v1?x=1')).toBe('https://gw.example.com/anthropic?x=1');
    expect(ensureV1Suffix('https://gw.example.com/openai?x=1')).toBe('https://gw.example.com/openai/v1?x=1');
  });

  it('fragment 同理：`/v1` 不得落进 fragment', () => {
    expect(stripV1Suffix('https://gw.example.com/anthropic/v1#frag')).toBe('https://gw.example.com/anthropic#frag');
    expect(ensureV1Suffix('https://gw.example.com/openai#frag')).toBe('https://gw.example.com/openai/v1#frag');
  });
});

describe('buildSubprocessEnv', () => {
  it('注入后返回新对象，宿主 process.env 一个字段都不变（不变量 1）', () => {
    const before = { ...process.env };
    const env = buildSubprocessEnv({ homeDir: 'D:/tmp/row/.agenthome', injected: { ANTHROPIC_API_KEY: 'sk-test' } });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env).not.toBe(process.env);
    expect({ ...process.env }).toEqual(before);
  });

  it('展开宿主环境（补 PATH：不展开子进程连 node 都找不到）', () => {
    /**
     * 大小写不敏感地找 path 键：`buildSubprocessEnv` 保留**宿主**的键名形态，而键名随进程形态变化
     * ——Windows 的环境块通常写 `Path`，vitest worker 里恰是 `PATH`。写死 `env.PATH` 会让这条断言
     * 只在 vitest 形态下成立；本断言要钉的是「PATH 被带过来了」，不是键名的拼写。
     */
    const env = buildSubprocessEnv({ homeDir: 'D:/tmp/row/.agenthome', injected: {} });
    const hostPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
    expect(hostPathKey, '宿主环境里应当有 path 键，否则这条断言没有意义').toBeDefined();
    const childPathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
    expect(childPathKey).toBeDefined();
    expect(env[childPathKey ?? '']).toBe(process.env[hostPathKey ?? '']);
  });

  it('HOME 与 USERPROFILE 都指向该行独立目录（Windows 上只改 HOME 等于没隔离）', () => {
    const env = buildSubprocessEnv({ homeDir: 'D:/tmp/row/.agenthome', injected: {} });
    expect(env.HOME).toBe('D:/tmp/row/.agenthome');
    expect(env.USERPROFILE).toBe('D:/tmp/row/.agenthome');
  });

  it('值为 undefined 的注入键被删掉（避免子进程看到空串凭据）', () => {
    const env = buildSubprocessEnv({ homeDir: 'D:/tmp/row/.agenthome', injected: { ANTHROPIC_API_KEY: undefined } });
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });
});
