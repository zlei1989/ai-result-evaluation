// @vitest-environment node
/**
 * 路由层端到端：`GET` / `PUT /api/settings`。
 *
 * 这份用例的存在理由有两个，缺一不可：
 *   1. **它是 `@/*` 别名在 vitest 里的守卫。** 路由文件 import 的是 `@/src/server-context`，
 *      而 vitest 不读 tsconfig 的 `paths`——没有 `vitest.config.ts` 里那份 `resolve.alias`，
 *      本文件在**收集阶段**就失败（`Cannot find package '@/src/server-context'`），
 *      `tsc` 却是绿的。用 `@/…` 导入路由（而不是相对路径）正是为了让别名本身受测。
 *   2. **它把「zod 解析 → 调 service → 映射错误」这条链路整条钉住。** `server-context.test.ts`
 *      喂给 `handleApiError` 的是本地 new 出来的 ZodError，证明不了路由真的在用 contracts 导出的
 *      那一份 `SettingsPatchSchema`；这里用坏值走一遍真实请求，只有同一个 zod 实例才会映射成
 *      400 + issues（复制出来的第二份 zod 会以 `instanceof ZodError` 为假落到 500）。
 *
 * 配置目录一律指向 `mkdtempSync` 出来的临时目录，并在 `afterEach` 复位——
 * 绝不碰真实的 `~/.aieval` / `~/.aieval-runs`。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, maskApiKey, type SettingsView } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { GET, PUT } from '@/app/api/settings/route';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  // 顺序要紧：先复位再删目录，否则万一删目录抛错，覆盖值会漏给下一个文件
  //（vitest 默认每文件一个进程，但同文件内的用例共享模块状态）。
  setConfigDirForTesting(null);
  removeTreeWithRetry(dir);
});

/** 用真实的 Request 全局构造请求，和 Next 交给路由的入参同形 */
function putRequest(body: string): Request {
  return new Request('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('PUT /api/settings', () => {
  it('合法补丁返回 200，且改动真的落盘', async () => {
    const res = await PUT(putRequest('{"theme":"dark"}'));

    expect(res.status).toBe(200);
    expect((await res.json()).theme).toBe('dark');
    // 响应体是服务内存里的对象，证明不了「持久化」。重新读配置文件，拿的是磁盘上的那份。
    expect(loadConfig().settings.theme).toBe('dark');
  });

  // 断言 `context[0].path` 而不是 `Array.isArray(context)`：后者对 `context: []` 也成立，
  // 抓不到「zod 被装了两份」这个真实故障。
  it('取值非法返回 400 INVALID_QUERY，context 是真 zod 的 issues（path 指向 theme）', async () => {
    const res = await PUT(putRequest('{"theme":"blue"}'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.context[0].path).toEqual(['theme']);
    // 被拒的补丁不得落盘。少了这条，「先调服务再 parse」这种写法会 3/3 全绿——
    // updateSettings 不校验 theme（只校验 workspaceRoot），响应字段完全一致，
    // 只有磁盘能区分顺序。
    expect(loadConfig().settings.theme).toBe('auto');
  });

  it('语法坏掉的请求体返回 400「请求体不是合法 JSON」，且不带 context 键', async () => {
    const res = await PUT(putRequest('{bad json'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toBe('请求体不是合法 JSON');
    expect('context' in body.error).toBe(false);
  });
});

/**
 * 出口守卫（HTTP 层）：`GET /api/settings` 是密钥离开服务端的**唯一**一道门，判据取
 * 「把响应体原文（text，不是解析后的对象）搜明文子串」——它同时覆盖 http 的 `headers`、
 * stdio 的 `env` 两条路径，也覆盖将来有人多加一条下行通道。
 *
 * 与 `@aieval/api` 那组守卫的分工：那边钉的是服务函数的返回值，这边钉的是**真路由**——
 * 少了它，「路由忘了用出口形态」（例如又 import 回服务端真源）这种改法可以全绿。
 */
describe('GET /api/settings 的出口形态', () => {
  const HTTP_KEY = 'ctx7-route-plain-0001';

  /** 明文密钥写进落盘配置：出口守卫必须从真实读盘路径上验 */
  function seedPlaintextConfig(): void {
    saveConfig({
      ...loadConfig(),
      settings: {
        ...SETTINGS_DEFAULTS,
        mcpServers: {
          context7: {
            transport: 'http',
            enabled: true,
            url: 'https://mcp.context7.com/mcp',
            headers: { CONTEXT7_API_KEY: HTTP_KEY, Accept: 'application/json' },
          },
        },
      },
    });
  }

  it('响应体原文里搜不到明文，敏感值出的是掩码、非敏感值照常可见', async () => {
    seedPlaintextConfig();

    const res = await GET();

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(HTTP_KEY);
    expect(text).toContain(maskApiKey(HTTP_KEY));
    expect(text).toContain('application/json');
  });

  it('把出口那份原样 PUT 回去：落盘的真密钥不被掩码串覆盖', async () => {
    seedPlaintextConfig();
    const view = (await (await GET()).json()) as SettingsView;

    const res = await PUT(putRequest(JSON.stringify({ mcpServers: view.mcpServers })));

    expect(res.status).toBe(200);
    const entry = loadConfig().settings.mcpServers['context7'];
    // 取不到就抛：守卫不许因为形状变了而静默通过
    if (entry?.transport !== 'http' || entry.headers === undefined) {
      throw new Error(`落盘里找不到 http 条目 context7 的 headers（实际：${JSON.stringify(entry)}）`);
    }
    expect(entry.headers['CONTEXT7_API_KEY']).toBe(HTTP_KEY);
  });
});
