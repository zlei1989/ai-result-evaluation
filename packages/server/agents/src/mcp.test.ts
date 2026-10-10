// @vitest-environment node
/**
 * MCP **注入落点**的守卫：canonical 条目 → claude 的 `Options.mcpServers` 逐字形状，
 * 以及行内 `.npmrc` 的 registry 落盘。
 *
 * 为什么这些守卫非有不可（三条退化各自都有一个**静默**的坏法）：
 *   1. **停用条目**：漏了它，用户在设置页关掉的那台照样会被注入——而界面上显示的是「已停用」，
 *      于是「我明明关了它」变成一句谁也证不了的话；
 *   2. **`${ENV}` 占位未设**：漏了它，注入的是 `${CONTEXT7_API_KEY}` 这串原文，厂商侧只报
 *      「认证失败 / 401」，真因（环境变量没设）离现场很远；正确形态是跳过该条并在行级观测格记
 *      `skipped`（行照跑）；
 *   3. **宿主没有 registry 配置**：这时**什么都不做**才是对的——凭空写一个公网 registry 进去会把
 *      内网镜像换成公网（行内首次注入从 ~4 s 变成 17.2 s，等待预算就是被这件事撑起来的）。
 *
 * ⚠️ 这一组钉两条硬口径：「占位未设 ⇒ 跳过」与「未解析的占位绝不原样透出去」。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMcpServers, type McpServers } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import { CODEX_MCP_STARTUP_TIMEOUT_SEC, readNpmrcText, toClaudeMcpServers, toCodexMcpServers, toDshMcpPluginLines, writeRowNpmrc } from './mcp';

/** 一份「设置页里那份」条目：启用 + 停用 + 占位未设 + 无需占位，四种形态各一台 */
const SETTINGS_ENTRIES: McpServers = {
  playwright: {
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--browser=chrome'],
  },
  context7: {
    transport: 'http',
    enabled: true,
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
  },
  'turn-off': {
    transport: 'http',
    enabled: false,
    url: 'https://mcp.invalid/mcp',
  },
};

describe('toClaudeMcpServers（canonical → claude 的 Options.mcpServers）', () => {
  it('同一份条目译成 claude 的逐字形状：stdio 无 cwd、http 带 headers', () => {
    const translated = toClaudeMcpServers({
      playwright: {
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: { PLAYWRIGHT_BROWSERS_PATH: '/tmp/browsers' },
      },
      context7: {
        transport: 'http',
        enabled: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: 'sk-live' },
      },
    });

    // 逐字：`type` 是厂商的判别键；stdio 那一条**不许**有 `cwd`
    // （canonical 里刻意没有 `cwd`，claude 的 stdio 也没有这个字段——子进程继承行工作区的 cwd）
    expect(translated).toEqual({
      playwright: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: { PLAYWRIGHT_BROWSERS_PATH: '/tmp/browsers' },
      },
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'sk-live' } },
    });
    expect('cwd' in (translated['playwright'] ?? {})).toBe(false);
  });

  it('三条退化：停用不进、占位未设不进、无需占位的照译（整条管线走一遍）', () => {
    const plan = resolveMcpServers(SETTINGS_ENTRIES, {});
    const translated = toClaudeMcpServers(plan.injectable);

    // 只有 playwright 活下来：`turn-off` 是用户关的、`context7` 的密钥变量没设（被跳过并记账）
    expect(Object.keys(translated)).toEqual(['playwright']);
    expect(plan.skipped.map((item) => item.name)).toEqual(['context7']);
    expect(plan.skipped[0]?.reason).toContain('CONTEXT7_API_KEY');
  });

  it('空集译成空对象（调用方据此**整个键都不给** SDK，而不是给一个空 map）', () => {
    expect(toClaudeMcpServers({})).toEqual({});
  });

  it('未解析的占位**绝不**原样透出去（真值到位时才是真值）', () => {
    const plan = resolveMcpServers(SETTINGS_ENTRIES, { CONTEXT7_API_KEY: 'sk-live' });
    const translated = toClaudeMcpServers(plan.injectable);

    expect(translated['context7']).toEqual({
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: 'sk-live' },
    });
    // 任何一条里都不许留下 `${`
    expect(JSON.stringify(translated)).not.toContain('${');
  });
});

/**
 * 另两家的翻译器：**同一份 canonical → 两家各自的逐字形状**。
 *
 * 为什么三家要各有一条逐字守卫、而且都从**同一份** `SETTINGS_ENTRIES` 出发：
 * 形状错一格的失败方式全是**静默**的——codex 多写一个 `type` 会让整份线程级 config 解析失败
 * （`thread/start` 直接报错，离真因很远）；dsh 少写 `serverName` 会让插件行不认这台服务，
 * 表现为「工具表里就是没有它」，而行照旧跑完。逐字断言是唯一能在合并前拦住它们的判据。
 */
describe('toCodexMcpServers（canonical → codex 的 mcp_servers）', () => {
  it('同一份条目译成 codex 的逐字形状：snake_case、**无 `type`**、http 走 `http_headers`', () => {
    const translated = toCodexMcpServers({
      playwright: {
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: { PLAYWRIGHT_BROWSERS_PATH: '/tmp/browsers' },
      },
      context7: {
        transport: 'http',
        enabled: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: 'sk-live' },
      },
    });

    // 逐字：传输靠字段推断（**没有 `type`**）；`headers` 在 codex 侧叫 `http_headers`
    expect(translated).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: { PLAYWRIGHT_BROWSERS_PATH: '/tmp/browsers' },
        startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC,
      },
      context7: {
        url: 'https://mcp.context7.com/mcp',
        http_headers: { CONTEXT7_API_KEY: 'sk-live' },
        startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC,
      },
    });
    // 反向断言：任何一条里都不许出现 `type` / `headers` / `cwd`（三者都不是 codex 的字段名）
    for (const entry of Object.values(translated)) {
      expect('type' in entry).toBe(false);
      expect('headers' in entry).toBe(false);
      expect('cwd' in entry).toBe(false);
    }
    // 启动超时按等待预算给：缺了它 codex 用默认值，而行内首次注入要下载 61 MB
    expect(translated['playwright']?.startup_timeout_sec).toBe(CODEX_MCP_STARTUP_TIMEOUT_SEC);
    expect(CODEX_MCP_STARTUP_TIMEOUT_SEC).toBeGreaterThanOrEqual(20);
  });

  it('可选格缺席就不写那个键（空数组 / 空对象在厂商侧是「显式声明为空」，与「没声明」不同）', () => {
    const translated = toCodexMcpServers({
      bare: { transport: 'stdio', enabled: true, command: 'node' },
      bareHttp: { transport: 'http', enabled: true, url: 'https://mcp.invalid/mcp' },
    });

    expect(translated).toEqual({
      bare: { command: 'node', startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC },
      bareHttp: { url: 'https://mcp.invalid/mcp', startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC },
    });
  });

  it('三条退化：停用不进、占位未设不进、真值到位时逐字透传（整条管线走一遍）', () => {
    const withoutKey = toCodexMcpServers(resolveMcpServers(SETTINGS_ENTRIES, {}).injectable);
    expect(Object.keys(withoutKey)).toEqual(['playwright']);

    const withKey = toCodexMcpServers(resolveMcpServers(SETTINGS_ENTRIES, { CONTEXT7_API_KEY: 'sk-live' }).injectable);
    expect(withKey['context7']?.http_headers).toEqual({ CONTEXT7_API_KEY: 'sk-live' });
    // 未解析的占位**绝不**原样透出去（同 claude 那一侧）
    expect(JSON.stringify(withKey)).not.toContain('${');
  });

  it('空集译成空对象（调用方据此**整个键都不给**线程级 config）', () => {
    expect(toCodexMcpServers({})).toEqual({});
  });
});

describe('toDshMcpPluginLines（canonical → overlay 的 `insert` 行）', () => {
  it('同一份条目译成插件行的逐字形状：`serverName` = 我们的名字、传输名是 `stdio` / `streamable-http`', () => {
    const lines = toDshMcpPluginLines({
      playwright: {
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: { PLAYWRIGHT_BROWSERS_PATH: '/tmp/browsers' },
      },
      context7: {
        transport: 'http',
        enabled: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: 'sk-live' },
      },
    });

    expect(lines).toEqual([
      '    - id: mcp-playwright',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        serverName: "playwright"',
      '        transport: stdio',
      '        command: "npx"',
      '        args:',
      '          - "-y"',
      '          - "@playwright/mcp@latest"',
      '        env:',
      '          "PLAYWRIGHT_BROWSERS_PATH": "/tmp/browsers"',
      '    - id: mcp-context7',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        serverName: "context7"',
      '        transport: streamable-http',
      '        url: "https://mcp.context7.com/mcp"',
      '        headers:',
      '          "CONTEXT7_API_KEY": "sk-live"',
    ]);
    // 传输名是 dsh 的两档（既不是 claude 的 `type`，也不是 canonical 的 `transport` 字面量）
    const text = lines.join('\n');
    expect(text).not.toContain('transport: http');
    expect(text).not.toContain('type:');
  });

  it('每条插件的 `id` 唯一且不出现在 config 里（`id` 是插件行的身份，不是服务名）', () => {
    const lines = toDshMcpPluginLines({
      a: { transport: 'stdio', enabled: true, command: 'node' },
      b: { transport: 'stdio', enabled: true, command: 'node' },
    });
    const ids = lines.filter((line) => line.includes('- id: '));

    expect(ids).toEqual(['    - id: mcp-a', '    - id: mcp-b']);
  });

  it('三条退化：停用不进、占位未设不进、空集产出空行数组（调用方据此一行都不插）', () => {
    expect(toDshMcpPluginLines(resolveMcpServers(SETTINGS_ENTRIES, {}).injectable).join('\n')).not.toContain('context7');
    expect(toDshMcpPluginLines({})).toEqual([]);
    const withKey = toDshMcpPluginLines(resolveMcpServers(SETTINGS_ENTRIES, { CONTEXT7_API_KEY: 'sk-live' }).injectable);
    expect(withKey.join('\n')).toContain('"CONTEXT7_API_KEY": "sk-live"');
    // 未解析的占位**绝不**原样透出去（与另两家同一条口径）
    expect(withKey.join('\n')).not.toContain('${');
  });

  it('字符串一律双引号 + 转义：命令 / 参数 / 值里出现 `:` / `"` / `\\` 时仍是合法 YAML 标量', () => {
    // 这些字符真出现过（模型名里有 `:`，Windows 路径里有 `\`），裸写会被 YAML 解析成别的结构
    const lines = toDshMcpPluginLines({
      probe: {
        transport: 'stdio',
        enabled: true,
        command: 'C:\\Program Files\\node.exe',
        args: ['--flag=a:b', 'say "hi"'],
        env: { P: 'C:\\x' },
      },
    });

    expect(lines).toContain(`        command: ${JSON.stringify('C:\\Program Files\\node.exe')}`);
    expect(lines).toContain(`          - ${JSON.stringify('say "hi"')}`);
    expect(lines).toContain(`          "P": ${JSON.stringify('C:\\x')}`);
    // 转义过的标量里不许出现裸的双引号（那正是把 YAML 结构写坏的那一格）
    expect(lines.filter((line) => line.startsWith('        command: '))[0]).toBe(
      '        command: "C:\\\\Program Files\\\\node.exe"',
    );
  });
});

/**
 * **翻译器的第二道形状闸**。
 *
 * 上游（契约层 `resolveMcpServers` 的 `invalid` 桶）已经拦过一道，这里守的是**翻译器自己的入口**：
 * 三个翻译器对 `AgentRunInput.mcpServers` 直接开口（`providers/<家>/index.ts`），而畸形条目在这一层的
 * 坏法**不是静默**——dsh 那支对 `undefined` 直接抛 TypeError（`quoteYaml` 里的 `value.replaceAll`），
 * 于是**整行以内部错误收口**。一个手改坏的配置条目不该有这个后果，正确处置是「按契约跳过这一条」。
 *
 * 判据双向：① **不抛**（少了 `isTranslatableEntry` 那道闸，dsh 那支会对 `undefined` 抛 TypeError，
 * 整行以内部错误收口）；② 那一条不许出现（claude / codex 的对象里没有它的键、dsh 的行里没有它的
 * `serverName`），同时**同批的合法条目照常译出**。
 */
describe('三个翻译器的形状闸：拿不到必需格的条目跳过、不抛', () => {
  /** 缺 `url` 的 http + 缺 `command` 的 stdio：两类「拿不到必需格」，混在一条合法条目旁边 */
  const malformed = {
    good: { transport: 'http' as const, enabled: true, url: 'https://mcp.invalid/mcp' },
    'no-url': { transport: 'http' as const, enabled: true },
    'no-command': { transport: 'stdio' as const, enabled: true, args: ['-y', 'pkg'] },
  } as unknown as McpServers;

  it('toDshMcpPluginLines：缺 url / 缺 command 都不抛，且这两条一行都不产出', () => {
    const lines = toDshMcpPluginLines(malformed);
    const text = lines.join('\n');

    expect(text, '合法那一条照常译出').toContain('serverName: "good"');
    expect(text).not.toContain('mcp-no-url');
    expect(text).not.toContain('mcp-no-command');
    // 畸形那两条既不产出 `serverName`，也不产出半个 config（半条 YAML 比不写更糟）
    expect(text.match(/serverName:/g)).toHaveLength(1);
  });

  it('toClaudeMcpServers / toCodexMcpServers：同样跳过畸形条目，合法条目逐字照旧', () => {
    expect(Object.keys(toClaudeMcpServers(malformed))).toEqual(['good']);
    expect(Object.keys(toCodexMcpServers(malformed))).toEqual(['good']);
    // 合法条目那一份不受闸门影响（`url` 与超时照旧）
    expect(toCodexMcpServers(malformed)['good']).toEqual({
      url: 'https://mcp.invalid/mcp',
      startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC,
    });
  });
});

describe('writeRowNpmrc（行内 registry）', () => {
  const registryLine = 'registry=http://registry.m.jd.com/';

  it('宿主有 registry ⇒ 只把那一行写进行 configHome 的 .npmrc，权限位 0600', () => {
    const root = mkdtempSync(join(tmpdir(), 'row-npmrc-'));
    const configHome = join(root, '.agenthome');
    try {
      const written = writeRowNpmrc({
        configHome,
        hostNpmrc: `# 宿主的 npm 配置\n${registryLine}\n//registry.example.com/:_authToken=secret\n`,
      });

      expect(written).toBe(registryLine);
      const target = join(configHome, '.npmrc');
      // **只那一行**：宿主那一行以外的内容（哪怕同文件里还有认证 token）一个字节都不进行内
      expect(readFileSync(target, 'utf8')).toBe(`${registryLine}\n`);
      // 权限位 0600（与 dsh 的 overlay 同口径，与 core 的配置落盘同一个值）
      if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('宿主没有 registry 配置 ⇒ 什么都不做（不建文件）', () => {
    const root = mkdtempSync(join(tmpdir(), 'row-npmrc-'));
    const configHome = join(root, '.agenthome');
    try {
      expect(writeRowNpmrc({ configHome, hostNpmrc: 'save-exact=true\n' })).toBeNull();
      expect(writeRowNpmrc({ configHome, hostNpmrc: null })).toBeNull();
      // 「什么都不做」是字面意思：连目录都不建
      expect(() => statSync(configHome)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('取 registry 那一行：认注释 / 空白 / 大小写，多行时以**最后一条**为准（npm 的 ini 语义）', () => {
    const written: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'row-npmrc-'));
    try {
      for (const hostNpmrc of [
        '# registry=http://old.example.com/\nregistry=http://a.example.com/\n',
        '  REGISTRY = https://b.example.com/  \n',
        'registry=http://first.example.com/\nregistry=http://last.example.com/\n',
      ]) {
        const configHome = join(root, String(written.length));
        mkdirSync(configHome, { recursive: true });
        written.push(writeRowNpmrc({ configHome, hostNpmrc }) ?? '(none)');
      }
      expect(written).toEqual([
        'registry=http://a.example.com/',
        'REGISTRY = https://b.example.com/',
        // 多条同名键：npm 的 ini 是「后者覆盖前者」⇒ 行内必须跟**最终生效**的那一条一致
        'registry=http://last.example.com/',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('读宿主 .npmrc 容错：不存在 / 是目录都给 null，UTF-8 BOM 要剥掉（PowerShell 会写 BOM）', () => {
    const root = mkdtempSync(join(tmpdir(), 'row-npmrc-'));
    const bomFile = join(root, 'bom-npmrc');
    try {
      expect(readNpmrcText(join(root, 'nope', '.npmrc'))).toBeNull();
      expect(readNpmrcText(root)).toBeNull();
      // BOM 不剥掉的话，第一行会变成 `\uFEFFregistry=…`，正则匹配不上 ⇒ 宿主明明配了却「什么都不做」
      writeFileSync(bomFile, `\uFEFF${registryLine}\nsave-exact=true\n`, 'utf8');
      expect(readNpmrcText(bomFile)).toBe(`${registryLine}\nsave-exact=true\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('注入的是行内那份，宿主那份一个字节都不动（不碰宿主是硬要求）', () => {
    const root = mkdtempSync(join(tmpdir(), 'row-npmrc-'));
    const configHome = join(root, '.agenthome');
    const hostFile = join(root, 'host-npmrc');
    const hostText = `${registryLine}\nsave-exact=true\n`;
    writeFileSync(hostFile, hostText, 'utf8');
    try {
      expect(writeRowNpmrc({ configHome, hostNpmrc: readNpmrcText(hostFile) })).toBe(registryLine);
      expect(readFileSync(hostFile, 'utf8')).toBe(hostText);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
