// @vitest-environment node
/**
 * 设置**出口形态**（`SettingsView`）守卫：落盘的 `Settings` 含明文，出口只出掩码。
 *
 * 为什么这些断言长这样：
 *   1. 判据是「出口那一坨 JSON 里有没有明文子串」而不是「某个字段等于某个值」——前者才是
 *      「谁把响应体原样打进日志/界面」这一整类泄漏的充分条件，后者只盯单点；
 *   2. 掩码口径不在这里重写公式，直接与供应商 `apiKey` 的 `maskApiKey` 对齐（同一份实现），
 *      口径一旦漂移（例如改成「保留后 4」），这条会跟 `provider.test.ts` 一起红；
 *   3. 同时钉住**落盘那份没被动过**——`toSettingsView` 若就地改写（而不是新建对象），
 *      出口是掩码了，可磁盘上的真密钥已经被掩码串覆盖，症状要到下次运行才以 401 现身。
 */
import { describe, expect, it } from 'vitest';
import { maskApiKey } from './provider';
import {
  preserveUnchangedSecrets,
  SETTINGS_DEFAULTS,
  toSettingsView,
  type Settings,
  type SettingsPatch,
  type SettingsView,
} from './settings';

/** 明文密钥：每个都留成「一眼能从 JSON 里搜出来」的形状 */
const HTTP_KEY = 'ctx7-plain-secret-0001';
const ENV_TOKEN = 'ghp-plainsecret0002';
const ENV_PASSWORD = 'p@ssw0rd-plain-text';
/** 长度 6（< 8）：前 3 后 4 会重叠，逐字保留等于把密钥原样吐回界面 */
const SHORT_TOKEN = 'abc123';

/** 落盘那份设置：两台 MCP（http 的 headers 与 stdio 的 env 各一份敏感值）+ 一批非敏感值 */
function storedSettings(): Settings {
  return {
    ...SETTINGS_DEFAULTS,
    mcpServers: {
      context7: {
        transport: 'http',
        enabled: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: HTTP_KEY, Accept: 'application/json' },
      },
      playwright: {
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: {
          GITHUB_TOKEN: ENV_TOKEN,
          DB_PASSWORD: ENV_PASSWORD,
          SHORT_TOKEN,
          EMPTY_SECRET: '',
          NODE_ENV: 'production',
          PLAYWRIGHT_BROWSERS_PATH: '/tmp/pw',
        },
      },
    },
  };
}

/** 取 http 条目的 headers；形状不对就抛——守卫不许因为取不到值而静默通过 */
function headersOf(view: SettingsView, name: string): Record<string, string> {
  const entry = view.mcpServers[name];
  if (entry?.transport !== 'http' || entry.headers === undefined) {
    throw new Error(`出口里找不到 http 条目 ${name} 的 headers（实际：${JSON.stringify(entry)}）`);
  }
  return entry.headers;
}

/** 取 stdio 条目的 env；同一套「取不到就抛」的理由 */
function envOf(view: SettingsView, name: string): Record<string, string> {
  const entry = view.mcpServers[name];
  if (entry?.transport !== 'stdio' || entry.env === undefined) {
    throw new Error(`出口里找不到 stdio 条目 ${name} 的 env（实际：${JSON.stringify(entry)}）`);
  }
  return entry.env;
}

describe('toSettingsView：出口掩码', () => {
  it('headers 里键名命中敏感模式的值出掩码，口径与供应商 apiKey 一致', () => {
    const view = toSettingsView(storedSettings());

    expect(headersOf(view, 'context7')['CONTEXT7_API_KEY']).toBe(maskApiKey(HTTP_KEY));
    // 掩码不是明文，也不是「什么都没做」：两句话都要有，否则「返回空串」的实现也能过
    expect(headersOf(view, 'context7')['CONTEXT7_API_KEY']).not.toBe(HTTP_KEY);
  });

  it('env 里命中 key / token / secret / password / auth 的值出掩码（大小写不敏感）', () => {
    const env = envOf(toSettingsView(storedSettings()), 'playwright');

    expect(env['GITHUB_TOKEN']).toBe(maskApiKey(ENV_TOKEN));
    expect(env['DB_PASSWORD']).toBe(maskApiKey(ENV_PASSWORD));
  });

  it('长度 < 8 的敏感值全掩码，不靠前 3 后 4 把密钥吐回去', () => {
    const env = envOf(toSettingsView(storedSettings()), 'playwright');

    expect(env['SHORT_TOKEN']).toBe(maskApiKey(SHORT_TOKEN));
    expect(env['SHORT_TOKEN']).not.toContain(SHORT_TOKEN);
  });

  it('空串保持空串——界面据此区分「未配置」与「已配置但隐藏」', () => {
    expect(envOf(toSettingsView(storedSettings()), 'playwright')['EMPTY_SECRET']).toBe('');
  });

  it('非敏感键的值原样返回，别把 NODE_ENV 这类也藏起来', () => {
    const view = toSettingsView(storedSettings());

    expect(envOf(view, 'playwright')['NODE_ENV']).toBe('production');
    expect(envOf(view, 'playwright')['PLAYWRIGHT_BROWSERS_PATH']).toBe('/tmp/pw');
    expect(headersOf(view, 'context7')['Accept']).toBe('application/json');
  });

  it('出口 JSON 里搜不到任何一处明文（含 http 与 stdio 两条路径）', () => {
    const json = JSON.stringify(toSettingsView(storedSettings()));

    expect(json).not.toContain(HTTP_KEY);
    expect(json).not.toContain(ENV_TOKEN);
    expect(json).not.toContain(ENV_PASSWORD);
    expect(json).toContain(maskApiKey(HTTP_KEY));
  });

  it('不就地改写入参：落盘那份仍然是明文（服务端注入要用原值）', () => {
    const stored = storedSettings();

    toSettingsView(stored);

    expect(headersOf(stored, 'context7')['CONTEXT7_API_KEY']).toBe(HTTP_KEY);
    expect(envOf(stored, 'playwright')['GITHUB_TOKEN']).toBe(ENV_TOKEN);
    expect(JSON.stringify(stored)).toContain(HTTP_KEY);
  });

  it('没有 MCP 条目时出口与落盘逐字相同（其余设置一个字都不变）', () => {
    // 显式给空 map：`SETTINGS_DEFAULTS` 那一格是**预置两项**，而 context7 的
    // `CONTEXT7_API_KEY` 值是 `${CONTEXT7_API_KEY}` 占位——键名命中敏感模式，出口照口径出掩码
    // （这是对的：出口不区分「占位」与「明文」，两者都不该原样下行）。本条要钉的是「没有条目时
    // 逐字相同」，故显式给一份没有条目的落盘形态，别让默认值里那两台把话题带偏。
    const stored: Settings = { ...SETTINGS_DEFAULTS, mcpServers: {} };

    expect(toSettingsView(stored)).toEqual(stored);
  });
});

/**
 * 「未改动」信号：界面拿到的是掩码，原样回传时**不得**把真密钥覆盖成掩码串。
 * 判据两条都认：值与掩码串**逐字相同**、或值为**空串**（表单那句「留空 = 不修改」）。
 * 这里同时钉住它的**反例**——给了真新值就得真的替换，否则「保留原值」这条规则一旦写宽，
 * 用户改密钥会变成静默无效，而症状要到下次运行才以 401 现身。
 */
describe('preserveUnchangedSecrets：未改动信号', () => {
  /** 从补丁里取回传后的 headers；取不到就抛，守卫不许静默通过 */
  function patchedHeaders(patch: SettingsPatch, name: string): Record<string, string> {
    const entry = patch.mcpServers?.[name];
    if (entry?.transport !== 'http' || entry.headers === undefined) {
      throw new Error(`补丁里找不到 http 条目 ${name} 的 headers（实际：${JSON.stringify(entry)}）`);
    }
    return entry.headers;
  }

  it('敏感值回传掩码串 ⇒ 视为未改动，保留落盘原值', () => {
    const stored = storedSettings();
    const patch: SettingsPatch = {
      mcpServers: {
        context7: {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: maskApiKey(HTTP_KEY), Accept: 'application/json' },
        },
      },
    };

    const resolved = preserveUnchangedSecrets(stored, patch);

    expect(patchedHeaders(resolved, 'context7')['CONTEXT7_API_KEY']).toBe(HTTP_KEY);
  });

  it('敏感值回传空串 ⇒ 视为未改动，保留落盘原值', () => {
    const stored = storedSettings();
    const patch: SettingsPatch = {
      mcpServers: {
        playwright: {
          transport: 'stdio',
          enabled: true,
          command: 'npx',
          env: { GITHUB_TOKEN: '', DB_PASSWORD: '', NODE_ENV: '' },
        },
      },
    };

    const resolved = preserveUnchangedSecrets(stored, patch);
    const entry = resolved.mcpServers?.['playwright'];

    expect(entry?.transport === 'stdio' && entry.env?.['GITHUB_TOKEN']).toBe(ENV_TOKEN);
    expect(entry?.transport === 'stdio' && entry.env?.['DB_PASSWORD']).toBe(ENV_PASSWORD);
    // 空串规则只对**敏感键**成立：非敏感键的空串是用户真填的值（NODE_ENV 被改成空 = 不注入）
    expect(entry?.transport === 'stdio' && entry.env?.['NODE_ENV']).toBe('');
  });

  it('反例：敏感值给了新值 ⇒ 真的替换（「未改动」规则不许吃掉真实修改）', () => {
    const stored = storedSettings();
    const patch: SettingsPatch = {
      mcpServers: {
        context7: {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: 'ctx7-brand-new-value' },
        },
      },
    };

    const resolved = preserveUnchangedSecrets(stored, patch);

    expect(patchedHeaders(resolved, 'context7')['CONTEXT7_API_KEY']).toBe('ctx7-brand-new-value');
  });

  it('落盘里本来就没有这个键时照收新值（没有原值可保留，不该被静默吃掉）', () => {
    const stored = storedSettings();
    const patch: SettingsPatch = {
      mcpServers: {
        context7: {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: 'ctx7-added-now' },
        },
      },
    };

    const resolved = preserveUnchangedSecrets(stored, patch);

    expect(patchedHeaders(resolved, 'context7')['CONTEXT7_API_KEY']).toBe('ctx7-added-now');
  });

  it('补丁里没带 mcpServers 时原样返回（不凭空造出这一格）', () => {
    const stored = storedSettings();

    const resolved = preserveUnchangedSecrets(stored, { theme: 'dark' });

    expect(resolved).toEqual({ theme: 'dark' });
    expect('mcpServers' in resolved).toBe(false);
  });
});
