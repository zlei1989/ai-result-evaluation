// @vitest-environment node
/**
 * 贴入识别（JSONC 剥离 + 五步判别 + 条目化 + 上限 + 合并语义）的表驱动守卫。
 *
 * 为什么这个文件必须存在（而不是等界面那票的渲染断言）：
 *   1. 手写剥离器是唯一「自己写解析」的地方，`http://` 里的 `//` 被当成注释是它的头号缺陷
 *      —— 这类缺陷在界面上表现为「贴进去没反应」，看不出根因；
 *   2. 五步判别与传输判定是**不递归不猜**的固定文法：判别顺序错一步，症状是「另一种形状
 *      悄悄被当成裸单项」，而预览看起来一切正常；
 *   3. 判据全部走 `parseMcpPaste` 这一个出口（纯函数、无 IO），预览与落盘用的是同一份结果。
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_PASTE_MAX_BYTES,
  MCP_PASTE_MAX_ENTRIES,
  MCP_PASTE_SHAPE_EXAMPLES,
  applyMcpPaste,
  mcpPasteNameIssue,
  parseMcpPaste,
  sanitizeMcpName,
  stripJsonComments,
} from './mcp-paste';
import type { McpServers } from './mcp';

describe('stripJsonComments（JSONC 容错的手写剥离器）', () => {
  it('剥掉 // 行注释、/* */ 块注释与尾逗号，剥完仍是合法 JSON', () => {
    const text = [
      '{',
      '  // 连接本机的代理',
      '  "a": 1, /* 内联注释 */',
      '  "b": [1, 2,],',
      '}',
    ].join('\n');

    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 1, b: [1, 2] });
  });

  /**
   * 关键判据：字符串字面量里的 `//` 不是注释。
   * 断言用**逐字相等**而不是「解析出来对」——不等长时（少了一段 URL）后面那条断言也会红，
   * 但逐字相等能一眼看出是被注释吞掉的。
   */
  it('字符串里的 // 与 /* */ 原样留下（http:// 不许被误伤）', () => {
    const text = '{"url":"http://localhost:8080/mcp","re":"a/*b*/c"}';

    expect(stripJsonComments(text)).toBe(text);
  });

  it('单引号串与无引号键给明确的中文错误（带行号），不让 JSON.parse 的英文报错冒充', () => {
    expect(() => stripJsonComments('{\n  \'a\': 1\n}')).toThrow(/第 2 行[\s\S]*单引号/);
    expect(() => stripJsonComments('{\n\n  a: 1\n}')).toThrow(/第 3 行[\s\S]*无引号/);
  });
});

describe('parseMcpPaste：五步判别（固定顺序，不递归不猜）', () => {
  it('第 1 步：顶层对象的 mcpServers 是对象 ⇒ 取它（Claude / Cursor 的形状）', () => {
    const result = parseMcpPaste(
      JSON.stringify({
        mcpServers: {
          context7: {
            type: 'http',
            url: 'https://mcp.context7.com/mcp',
            headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
          },
        },
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe('context7');
    // enabled 显式写出（缺省 true，但落盘形态里不许靠「没写」表达）
    expect(result.entries[0]?.entry).toEqual({
      transport: 'http',
      enabled: true,
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
    });
    expect(result.entries[0]?.action).toBe('add');
    expect(result.entries[0]?.renamable).toBe(false);
  });

  it('第 2 步：VS Code 的 servers 信封 ⇒ 取它，兄弟键整份丢弃并在预览里点名', () => {
    const result = parseMcpPaste(
      [
        '{',
        '  // VS Code 的 mcp.json',
        '  "inputs": [{ "type": "promptString", "id": "token" }],',
        '  "servers": {',
        '    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"], "env_http_headers": {} },',
        '  },',
        '}',
      ].join('\n'),
    );

    expect(result.error).toBeUndefined();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.entry).toEqual({
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    });
    // inputs 是整份级别的丢弃（它是 VS Code 的输入外壳，不是某一条的字段）
    expect(result.droppedFields).toContain('inputs');
    // env_http_headers 是这一条自己的字段（「其余 strip 并点名」）
    expect(result.entries[0]?.droppedFields).toContain('env_http_headers');
  });

  it('第 3 步：顶层对象自身含 url / command ⇒ 当作裸单项，名字按内容猜且可改', () => {
    const http = parseMcpPaste('{ "url": "https://mcp.context7.com/mcp" }');
    expect(http.entries[0]?.name).toBe('context7');
    expect(http.entries[0]?.renamable).toBe(true);
    expect(http.entries[0]?.entry).toEqual({ transport: 'http', enabled: true, url: 'https://mcp.context7.com/mcp' });

    const stdio = parseMcpPaste('{ "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }');
    expect(stdio.entries[0]?.name).toBe('playwright');
    expect(stdio.entries[0]?.entry).toEqual({
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    });
  });

  it('裸单项自带 name 时用它当默认名，且不再把它算进「被丢字段」；不是字符串时照常点名', () => {
    const used = parseMcpPaste('{ "name": "My Server", "command": "npx" }');
    expect(used.entries[0]?.name).toBe('my-server');
    expect(used.entries[0]?.droppedFields).toEqual([]);

    const ignored = parseMcpPaste('{ "name": 5, "command": "npx" }');
    expect(ignored.entries[0]?.name).toBe('npx');
    expect(ignored.entries[0]?.droppedFields).toEqual(['name']);
  });

  it('第 4 步：顶层是数组 ⇒ 不认（不猜「大概是若干台」）', () => {
    const result = parseMcpPaste('[{"command":"npx"}]');

    expect(result.entries).toHaveLength(0);
    expect(result.error?.message).toContain('数组');
    expect(result.error?.message).toMatch(/mcpServers/);
  });

  it('第 5 步：其余 ⇒ 不认，并列出**实际看到的顶层键**', () => {
    const result = parseMcpPaste('{ "foo": 1, "bar": { "baz": 2 } }');

    expect(result.entries).toHaveLength(0);
    expect(result.error?.topLevelKeys).toEqual(['foo', 'bar']);
    expect(result.error?.message).toContain('foo');
  });

  it('servers 里再套 servers 不特殊处理：那一格被当条目解析后报「不是一台 MCP 服务器」', () => {
    const result = parseMcpPaste('{ "servers": { "outer": { "servers": { "inner": { "command": "npx" } } } } }');

    expect(result.entries).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.name).toBe('outer');
    expect(result.rejected[0]?.reason).toContain('不是一台 MCP 服务器');
  });

  it('四类形状的示例自己必须是能认的形状（示例不许是编的）', () => {
    expect(MCP_PASTE_SHAPE_EXAMPLES).toHaveLength(4);
    for (const example of MCP_PASTE_SHAPE_EXAMPLES) {
      const result = parseMcpPaste(example);
      expect(result.error, example).toBeUndefined();
      expect(result.entries.length + result.rejected.length, example).toBeGreaterThan(0);
    }
  });
});

describe('parseMcpPaste：上限先于解析', () => {
  it('超过 256 KB 直接给中文原因，连剥离都不做（内容根本不是 JSON 也轮不到语法错）', () => {
    const result = parseMcpPaste('x'.repeat(MCP_PASTE_MAX_BYTES + 1));

    expect(result.error?.message).toContain('256 KB');
    expect(result.error?.message).not.toContain('JSON');
    expect(result.entries).toHaveLength(0);
  });

  it('超过 100 条给中文原因（数得清的才叫「太多了」）', () => {
    const servers: Record<string, unknown> = {};
    for (let index = 0; index <= MCP_PASTE_MAX_ENTRIES; index += 1) {
      servers[`server-${index}`] = { command: 'npx' };
    }
    const result = parseMcpPaste(JSON.stringify({ mcpServers: servers }));

    expect(result.error?.message).toContain('100');
    expect(result.entries).toHaveLength(0);
  });
});

/**
 * 四类形状的**成功路径**与「逐条点名不导入」的清单。
 * 这些断言都从 `parseMcpPaste` 这一个出口看：预览与落盘用的是同一份判定。
 */
describe('parseMcpPaste：条目化与逐条拒绝', () => {
  it('四类形状各成功导入一次，JSONC 里的 http:// 逐字还在', () => {
    const shapes = [
      '{ "mcpServers": { "local": { "url": "http://localhost:8080/mcp" } } }',
      '{ "servers": { "local": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] } }, "inputs": [] }',
      '{ "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }',
      '{ // 本机代理\n  "mcpServers": { "local": { "url": "http://localhost:8080/mcp" }, },\n}',
    ];

    for (const shape of shapes) {
      const result = parseMcpPaste(shape);
      expect(result.error, shape).toBeUndefined();
      expect(result.entries, shape).toHaveLength(1);
      expect(result.rejected, shape).toHaveLength(0);
    }
    expect(parseMcpPaste(shapes[3] as string).entries[0]?.entry).toEqual({
      transport: 'http',
      enabled: true,
      url: 'http://localhost:8080/mcp',
    });
  });

  it('键名不合法的条目点名不导入，其余条目照常导入（不做「任一条不合法就整份拒绝」）', () => {
    const result = parseMcpPaste(
      '{ "mcpServers": { "my.server": { "command": "npx" }, "ok-server": { "command": "npx" } } }',
    );

    expect(result.entries.map((item) => item.name)).toEqual(['ok-server']);
    expect(result.rejected[0]?.name).toBe('my.server');
    expect(result.rejected[0]?.reason).toContain('名字');
  });

  it('type: \'sse\' / \'sdk\' 逐条点名不导入（认得出来的构造，不当成「不认识」）', () => {
    const result = parseMcpPaste(
      JSON.stringify({
        mcpServers: {
          old: { type: 'sse', url: 'https://x/sse' },
          sdk: { type: 'sdk', command: 'node' },
          fine: { type: 'http', url: 'https://x/mcp' },
        },
      }),
    );

    expect(result.rejected.map((item) => item.name)).toEqual(['old', 'sdk']);
    expect(result.rejected[0]?.reason).toContain('\'sse\'');
    expect(result.rejected[1]?.reason).toContain('\'sdk\'');
    expect(result.entries.map((item) => item.name)).toEqual(['fine']);
  });

  it('${input:…} 这类非 ${ENV_NAME} 的占位 ⇒ 该条不导入并点名；${ENV_NAME} 在 env / headers 的值里合法', () => {
    const result = parseMcpPaste(
      JSON.stringify({
        mcpServers: {
          vscode: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${input:token}' } },
          shell: { command: 'npx', env: { TOKEN: '${TOKEN:-fallback}' } },
          ok: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
        },
      }),
    );

    expect(result.rejected.map((item) => item.name)).toEqual(['vscode', 'shell']);
    expect(result.rejected[0]?.reason).toContain('${input:token}');
    expect(result.rejected[1]?.reason).toContain('${TOKEN:-fallback}');
    expect(result.entries.map((item) => item.name)).toEqual(['ok']);
  });

  it('command / url / args 里一个占位都不支持（占位只在 env / headers 的值里解析）', () => {
    const result = parseMcpPaste(
      JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['--token=${TOKEN}'] } } }),
    );

    expect(result.entries).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('${TOKEN}');
  });

  it('跨传输字段按「不认识」处置：声明了 stdio 的条目里带 url ⇒ 丢 url 并点名，不拒绝整条', () => {
    const result = parseMcpPaste(
      JSON.stringify({ mcpServers: { a: { transport: 'stdio', command: 'npx', url: 'https://x/mcp' } } }),
    );

    expect(result.rejected).toHaveLength(0);
    expect(result.entries[0]?.entry).toEqual({ transport: 'stdio', enabled: true, command: 'npx' });
    expect(result.entries[0]?.droppedFields).toEqual(['url']);
  });

  it('两边都有却没声明传输 ⇒ 不导入并点名（宁可不动，也不猜错方向）', () => {
    const result = parseMcpPaste(
      JSON.stringify({ mcpServers: { a: { command: 'npx', url: 'https://x/mcp' } } }),
    );

    expect(result.entries).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('分不出');
  });

  it('未知字段 strip 并点名；enabled 是布尔就沿用（停用的没写这一格会被悄悄打开）', () => {
    const result = parseMcpPaste(
      JSON.stringify({
        mcpServers: {
          a: {
            command: 'npx',
            alwaysAllow: ['read'],
            enabled: false,
            env: { OK: '1', 'MY.KEY': 'x' },
            args: ['-y', 7],
          },
        },
      }),
    );

    expect(result.entries[0]?.entry).toEqual({
      transport: 'stdio',
      enabled: false,
      command: 'npx',
      args: ['-y'],
      env: { OK: '1' },
    });
    expect(result.entries[0]?.droppedFields).toEqual(['alwaysAllow', 'env.MY.KEY', 'args[1]']);
  });

  it('enabled 不是布尔时丢掉并点名，回落缺省的 true', () => {
    const result = parseMcpPaste(JSON.stringify({ mcpServers: { a: { command: 'npx', enabled: 'false' } } }));

    expect(result.entries[0]?.entry).toEqual({ transport: 'stdio', enabled: true, command: 'npx' });
    expect(result.entries[0]?.droppedFields).toEqual(['enabled']);
  });
});

/**
 * 名字与合并语义：裸单项补名字的净化规则、预览里改名的校验、以及「同名默认覆盖」这条导入语义。
 * 这三条都由**兼容的纯函数**承担，界面与用例用同一份——预览说「覆盖」，落盘就必须真的是覆盖。
 */
describe('sanitizeMcpName（裸单项的默认名）', () => {
  it('小写 → 非法字符转 - → 折叠连续 - → 去首尾 - → 截 32 位 → 空则 server-1', () => {
    expect(sanitizeMcpName('Context7 MCP')).toBe('context7-mcp');
    expect(sanitizeMcpName('a. b//c')).toBe('a-b-c');
    expect(sanitizeMcpName('--x--')).toBe('x');
    expect(sanitizeMcpName('重'.repeat(40))).toBe('server-1');
    expect(sanitizeMcpName('A'.repeat(40))).toBe('a'.repeat(32));
    expect(sanitizeMcpName('')).toBe('server-1');
    // 幂等：净化过的名字再净化一次不变（预览里改完名字按同一把尺子校验）
    const once = sanitizeMcpName('Context7 MCP');
    expect(sanitizeMcpName(once)).toBe(once);
  });
});

describe('mcpPasteNameIssue（预览里改名的校验）', () => {
  it('空名字不许导入', () => {
    expect(mcpPasteNameIssue('', ['a'])).toContain('不能为空');
    expect(mcpPasteNameIssue('   ', [])).toContain('不能为空');
  });

  it('字符集不合法不许导入（与契约那条正则同一把尺子）', () => {
    expect(mcpPasteNameIssue('my.server', [])).toContain('名字');
    expect(mcpPasteNameIssue('a'.repeat(33), [])).toContain('名字');
  });

  it('与本次导入内另一台**净化后**撞名不许导入（大小写不同也算撞）', () => {
    expect(mcpPasteNameIssue('context7', ['context7'])).toContain('重名');
    expect(mcpPasteNameIssue('Context7', ['context7'])).toContain('重名');
    expect(mcpPasteNameIssue('context7', ['playwright'])).toBeNull();
  });
});

describe('同名默认覆盖与一次原子落盘', () => {
  const existing: McpServers = {
    context7: { transport: 'http', enabled: true, url: 'https://old.invalid/mcp' },
  };

  it('同名 ⇒ action 是 overwrite 并带上被覆盖的那一条；不同名 ⇒ add', () => {
    const result = parseMcpPaste(
      JSON.stringify({
        mcpServers: { context7: { url: 'https://new.invalid/mcp' }, fresh: { command: 'npx' } },
      }),
      existing,
    );

    expect(result.entries[0]?.action).toBe('overwrite');
    expect(result.entries[0]?.existing).toEqual(existing.context7);
    expect(result.entries[1]?.action).toBe('add');
    expect(result.entries[1]?.existing).toBeUndefined();
  });

  it('applyMcpPaste：覆盖的挪到末尾（与 upsertServer 同口径），新增按贴入顺序追加，入参不变', () => {
    const parsed = parseMcpPaste(
      JSON.stringify({ mcpServers: { context7: { url: 'https://new.invalid/mcp' }, fresh: { command: 'npx' } } }),
      existing,
    );
    const rows = parsed.entries.map((item) => ({ name: item.name, entry: item.entry }));

    const next = applyMcpPaste(existing, rows, false);

    expect(Object.keys(next)).toEqual(['context7', 'fresh']);
    expect(next.context7).toBe(rows[0]?.entry);
    // 入参（现有集合）不许被就地改写：改完界面上的列表与将要落盘的那份会共享引用
    expect(JSON.stringify(existing)).toBe(
      JSON.stringify({ context7: { transport: 'http', enabled: true, url: 'https://old.invalid/mcp' } }),
    );
  });

  it('先清空再导入：现有条目一条不剩，只剩本次贴进来的', () => {
    const rows = [{ name: 'fresh', entry: { transport: 'stdio', enabled: true, command: 'npx' } as const }];

    expect(Object.keys(applyMcpPaste(existing, rows, true))).toEqual(['fresh']);
    // 清空 + 什么都没导入 = 空集合（「先清空」是一条独立的意图，不该被解释成「没变化」）
    expect(applyMcpPaste(existing, [], true)).toEqual({});
    // 不清空 + 什么都没导入 = 原样的一份**新** map
    const untouched = applyMcpPaste(existing, [], false);
    expect(untouched).toEqual(existing);
    expect(untouched).not.toBe(existing);
  });

  it('跳过的行不进 rows：它的名字既不覆盖也不新增（逐行可切跳过）', () => {
    const skipped = applyMcpPaste(existing, [], false);

    expect(Object.keys(skipped)).toEqual(['context7']);
    expect(skipped.context7).toEqual(existing.context7);
  });
});
