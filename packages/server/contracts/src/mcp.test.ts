// @vitest-environment node
/**
 * MCP 条目形状的最小守卫：**判别联合**、名字与 `env` 键名的字符集、`enabled` 的缺省。
 *
 * 为什么这几条非有不可（而不是「等用它的界面那票再补」）：
 *   1. 名字与 `env` 键名的模式是「一处拦、三家都安全」的那一处——放到运行期再让某一家静默失灵，
 *      用户要拿一个跑不通的行去反推是名字里的点号；
 *   2. `enabled` 的缺省必须是 `true`（`.default(true)`）：缺省被写成 `false` 的话，
 *      配置里没写这一格的条目会**静默不注入**，而界面照旧显示「启用」；
 *   3. 跨传输字段（stdio 条目里带 `url`）必须按「不认识」strip 掉，不能悄悄留下——
 *      否则配置文件里有、厂商翻译器不认，又成了一处静默失灵。
 */
import { describe, expect, it } from 'vitest';
import {
  CODEX_MCP_DISPATCH_GAP_NOTE,
  McpServerConfigSchema,
  McpServersSchema,
  resolveMcpServers,
  type McpServers,
} from './mcp';

describe('McpServersSchema', () => {
  it('名字只认三家交集的那套字符集（dsh 的 serverName 最严）', () => {
    const entry = { transport: 'http', enabled: true, url: 'https://mcp.invalid/mcp' };

    expect(McpServersSchema.safeParse({ 'my-server_1': entry }).success).toBe(true);
    // 点号是典型反例（贴进来的 JSON 里很常见），必须在这一层就被拒
    expect(McpServersSchema.safeParse({ 'my.server': entry }).success).toBe(false);
    expect(McpServersSchema.safeParse({ ['a'.repeat(33)]: entry }).success).toBe(false);
  });

  it('stdio 的 env 键名走环境变量形状，带点号 / 空格 / 数字开头都被拒', () => {
    const ok = { transport: 'stdio', enabled: true, command: 'npx', env: { CONTEXT7_API_KEY: 'x' } };
    expect(McpServersSchema.safeParse({ s: ok }).success).toBe(true);
    for (const bad of ['MY.KEY', 'MY KEY', '1KEY', 'MY-KEY']) {
      expect(McpServersSchema.safeParse({ s: { ...ok, env: { [bad]: 'x' } } }).success).toBe(false);
    }
  });
});

describe('McpServerConfigSchema', () => {
  it('enabled 缺省为 true（缺省写成 false 会让条目静默不注入）', () => {
    const parsed = McpServerConfigSchema.parse({ transport: 'http', url: 'https://mcp.invalid/mcp' });

    expect(parsed.enabled).toBe(true);
  });

  it('跨传输字段按「不认识」strip 掉，不留进解析结果', () => {
    const parsed = McpServerConfigSchema.parse({
      transport: 'stdio',
      command: 'npx',
      url: 'https://mcp.invalid/mcp',
      alwaysAllow: ['read'],
    });

    expect('url' in parsed).toBe(false);
    expect('alwaysAllow' in parsed).toBe(false);
  });
});

/**
 * `resolveMcpServers`：从设置页那份条目到**真正要注入的那一份**。
 *
 * 三条口径各自都有「静默坏掉」的形态，故各自一条守卫：
 *   · **停用条目整条跳过**（不是「注入了但厂商不认」）——漏了它，用户关掉的那台照样会跑起来，
 *     而界面上显示的是「已停用」；
 *   · **`${ENV}` 未设置的条目跳过并记账**（不是注入一个字面量 `${CONTEXT7_API_KEY}`）——
 *     漏了它，密钥位置会被塞进一串占位原文，厂商侧只报「认证失败」，真因离现场很远；
 *   · **密钥永不落盘、只在注入时解析**——解析结果必须真的进 `injectable`（否则「跳过」与
 *     「原样注入」两条路都错），而原 map 一个字节都不许被改写（它是落盘的那一份）。
 *
 * 另有两条闸（各自的守卫在下面 `describe` 里）：
 *   · **形状闸**：`loadConfig` 不做 schema 校验 ⇒ 手改 `config.json` 写进去的畸形条目
 *     （缺 `transport` / 缺 `url` / 缺 `command` / 跨传输）必须在**唯一那个消费点**被摘出来，
 *     否则它会被当 http 一路翻成 `{type:'http', url: undefined}`；
 *   · **占位闸**：`command` / `url` / `args` 不支持占位，手改配置绕过界面时
 *     这几格里的 `${…}` 会原样注入厂商。
 */
describe('resolveMcpServers', () => {
  it('enabled:false 整条跳过：不进注入集、也不出现在 skipped 里（它根本不是「跳过」而是「用户关了」）', () => {
    const plan = resolveMcpServers(
      {
        on: { transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'pkg'] },
        off: { transport: 'http', enabled: false, url: 'https://mcp.invalid/mcp' },
      },
      {},
    );

    expect(Object.keys(plan.injectable)).toEqual(['on']);
    expect(plan.skipped).toEqual([]);
    expect(plan.invalid).toEqual([]);
  });

  it('${ENV} 已设置 ⇒ 解析成字面量；未设置 ⇒ 整条跳过并如实记 skipped（行照跑）', () => {
    const servers = {
      context7: {
        transport: 'http' as const,
        enabled: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
      },
      'local-tool': {
        transport: 'stdio' as const,
        enabled: true,
        command: 'node',
        env: { TOOL_TOKEN: '${TOOL_TOKEN}', STATIC: 'plain' },
      },
    };
    const plan = resolveMcpServers(servers, { CONTEXT7_API_KEY: 'sk-live' });

    // 设了的那台：占位被换成真值，其余键原样
    expect(plan.injectable['context7']).toEqual({
      transport: 'http',
      enabled: true,
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: 'sk-live' },
    });
    // 没设的那台：**整条**不进注入集（半条注入等于给厂商一个坏配置）
    expect('local-tool' in plan.injectable).toBe(false);
    expect(plan.skipped.map((item) => item.name)).toEqual(['local-tool']);
    // 跳过的原因要能指回**哪个键的哪个变量**（日志要照它写，否则用户只能猜）
    expect(plan.skipped[0]?.reason).toContain('TOOL_TOKEN');
    // 原 map 一个字节都不许被改写：它就是落盘的那一份（密钥落盘是原文）
    expect(servers.context7.headers.CONTEXT7_API_KEY).toBe('${CONTEXT7_API_KEY}');
  });

  it('空串按「未设置」处置（`FOO=` 与没有这个变量在子进程里是同一件事）', () => {
    const plan = resolveMcpServers(
      { s: { transport: 'stdio', enabled: true, command: 'node', env: { TOKEN: '${TOKEN}' } } },
      { TOKEN: '' },
    );

    expect(plan.injectable).toEqual({});
    expect(plan.skipped.map((item) => item.name)).toEqual(['s']);
  });

  it('不支持的 shell 写法（`${VAR:-default}`）按跳过处置——绝不把占位原文注入厂商', () => {
    const plan = resolveMcpServers(
      { s: { transport: 'http', enabled: true, url: 'https://mcp.invalid/mcp', headers: { A: '${TOKEN:-fallback}' } } },
      { TOKEN: 'sk-live' },
    );

    expect(plan.injectable).toEqual({});
    expect(plan.skipped.map((item) => item.name)).toEqual(['s']);
  });

  it('没有占位符的条目原样进注入集（`env` / `headers` 缺席时也不凭空补一个空对象）', () => {
    const plan = resolveMcpServers(
      {
        a: { transport: 'stdio', enabled: true, command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
        b: { transport: 'http', enabled: true, url: 'https://mcp.invalid/mcp', headers: { Authorization: 'Bearer fixed' } },
      },
      {},
    );

    expect(plan.injectable['a']).toEqual({
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    });
    expect(plan.injectable['b']).toEqual({
      transport: 'http',
      enabled: true,
      url: 'https://mcp.invalid/mcp',
      headers: { Authorization: 'Bearer fixed' },
    });
    expect(plan.skipped).toEqual([]);
    expect(plan.invalid).toEqual([]);
  });
});

/**
 * **形状闸**（「手改配置文件能被读到」那一面）。
 *
 * 这一条守的是「唯一那个消费点」：`loadConfig` 故意不做 schema 校验（一条手改坏的值不该让设置页
 * 打不开），于是 `McpServersSchema` 在运行时**不是**真源——真正拦它的地方只有这里。
 *
 * 缺陷现象（修前实测）：缺 `transport` 的条目在 `resolveMcpServers` 里走到
 * `entry.transport === 'stdio' ? … : …` 的 else 支 ⇒ 当 http 注入 ⇒ 厂商侧拿到
 * `{type:'http', url: undefined}`；而**没有任何一层会报错**，界面上那一条还写着「启用」。
 *
 * 四类畸形各自一条（缺 `transport` / 缺 `url` / 缺 `command` / 跨传输=写了另一支的字段），
 * 外加名字不合法（名字模式同样是 `McpServersSchema` 的一部分）。
 * ⚠️ 跨传输**只**指「stdio 条目只有 `url`、没有 `command`」——两支字段都写齐时按
 * 「不认识就 strip」处置（那是**合法**条目，不在这里拒绝），这条边界由上面那条用例的 `b` 覆盖。
 */
describe('resolveMcpServers 的形状闸（畸形条目不注入、进 invalid 桶）', () => {
  it('缺 transport / 缺 url / 缺 command / 跨传输 ⇒ 都不进注入集，且逐条进 invalid', () => {
    const plan = resolveMcpServers(
      {
        'no-transport': { enabled: true, url: 'https://mcp.invalid/mcp' },
        'http-no-url': { transport: 'http', enabled: true, headers: { A: 'b' } },
        'stdio-no-command': { transport: 'stdio', enabled: true, args: ['-y', 'pkg'] },
        'stdio-with-url': { transport: 'stdio', enabled: true, url: 'https://mcp.invalid/mcp' },
      } as unknown as McpServers,
      {},
    );

    expect(plan.injectable).toEqual({});
    expect(plan.skipped, '形状不对的条目不该混进 skipped——两桶的处置动作相反').toEqual([]);
    expect(plan.invalid.map((item) => item.name)).toEqual([
      'no-transport',
      'http-no-url',
      'stdio-no-command',
      'stdio-with-url',
    ]);
    // 原因要能指回**哪一格**（日志只有这一句，用户照它回设置页改哪一条）
    const reasonOf = (name: string): string => plan.invalid.find((item) => item.name === name)?.reason ?? '';
    expect(reasonOf('no-transport')).toContain('transport');
    expect(reasonOf('http-no-url')).toContain('url');
    expect(reasonOf('stdio-no-command')).toContain('command');
    expect(reasonOf('stdio-with-url')).toContain('command');
  });

  it('名字不合法同样摘进 invalid（三家对坏名字的失灵方式各不相同，早报比晚报好）', () => {
    const plan = resolveMcpServers(
      { 'my.server': { transport: 'http', enabled: true, url: 'https://mcp.invalid/mcp' } },
      {},
    );

    expect(plan.injectable).toEqual({});
    expect(plan.invalid.map((item) => item.name)).toEqual(['my.server']);
    expect(plan.invalid[0]?.reason).toContain('名字');
  });

  it('其余格子类型不对（env 键名带点号）也退回 invalid，且原因取自 schema 的中文文案', () => {
    const plan = resolveMcpServers(
      { s: { transport: 'stdio', enabled: true, command: 'npx', env: { 'MY.KEY': 'x' } } },
      {},
    );

    expect(plan.injectable).toEqual({});
    expect(plan.invalid.map((item) => item.name)).toEqual(['s']);
    expect(plan.invalid[0]?.reason).toContain('env');
  });

  it('合法条目一条不受影响：畸形与合法混在一份 map 里时，只有合法的进注入集', () => {
    const plan = resolveMcpServers(
      {
        good: { transport: 'http', enabled: true, url: 'https://mcp.invalid/mcp' },
        bad: { transport: 'http', enabled: true },
      } as unknown as McpServers,
      {},
    );

    expect(Object.keys(plan.injectable)).toEqual(['good']);
    expect(plan.invalid.map((item) => item.name)).toEqual(['bad']);
  });
});

/**
 * **占位闸**。
 *
 * 只有 `env` / `headers` 的**值**支持 `${ENV}`；`command` / `url` / `args` 里写了占位时，
 * 贴入层会拒绝该条并点名，而**手改 `config.json` 绕过界面**这条路只有注入层拦得住。
 * 缺陷现象：占位原文被原样注入厂商 ⇒ 「找不到命令 `/bin/${TOOL}`」「主机名不合法」这类
 * 与真因（占位写错了地方）很远的话。
 */
describe('resolveMcpServers 的占位闸（command / url / args 里不许有 ${…}）', () => {
  it('四格各一例：command / url / args 里带 ${X} ⇒ 不进注入集、进 skipped（与「环境变量未设置」同档）', () => {
    const plan = resolveMcpServers(
      {
        'placeholder-command': { transport: 'stdio', enabled: true, command: '${TOOL}' },
        'placeholder-args': { transport: 'stdio', enabled: true, command: 'npx', args: ['-y', '${PKG}@latest'] },
        'placeholder-url': { transport: 'http', enabled: true, url: 'https://${HOST}/mcp' },
        'placeholder-header': {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.invalid/mcp',
          headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
        },
      },
      {},
    );

    expect(plan.injectable).toEqual({});
    expect(plan.invalid, '这几条形状是对的，不该落进 invalid 桶').toEqual([]);
    expect(plan.skipped.map((item) => item.name)).toEqual([
      'placeholder-command',
      'placeholder-args',
      'placeholder-url',
      'placeholder-header',
    ]);
    // 原因要点到**哪一格**：`args[0]` 与 `command` 是两条不同的去处
    const reasonOf = (name: string): string => plan.skipped.find((item) => item.name === name)?.reason ?? '';
    expect(reasonOf('placeholder-command')).toContain('command');
    expect(reasonOf('placeholder-args')).toContain('args[1]');
    expect(reasonOf('placeholder-url')).toContain('url');
    expect(reasonOf('placeholder-header'), 'env / headers 那一格走的是「未设置」那条老路').toContain(
      'CONTEXT7_API_KEY',
    );
  });

  it('不支持的写法（`${VAR:-default}`）在 command 里同样按跳过处置', () => {
    const plan = resolveMcpServers(
      { s: { transport: 'stdio', enabled: true, command: 'node', args: ['${TOKEN:-fallback}'] } },
      { TOKEN: 'sk-live' },
    );

    expect(plan.injectable).toEqual({});
    expect(plan.skipped.map((item) => item.name)).toEqual(['s']);
  });

  it('`$HOME` 这种不带花括号的写法不算占位（它不是本仓的语法，本来就按字面透传）', () => {
    const plan = resolveMcpServers(
      { s: { transport: 'stdio', enabled: true, command: 'node', args: ['--root=$HOME/x'] } },
      {},
    );

    expect(Object.keys(plan.injectable)).toEqual(['s']);
    expect(plan.skipped).toEqual([]);
  });
});

/**
 * codex 的 **MCP 能力缺口文案**（「写进界面提示与文档，不藏起来」）。
 *
 * 为什么值得一条守卫：它是**面向用户的一句话**，三个消费方（行卡片浮层、环境抽屉、知识库/FAQ）
 * 引的是同一份常量。改写它时最容易犯的两种错——把它写成「未证实」（那是**已定位**的上游缺口，
 * 写成未证实会让下一个人又去跑一遍矩阵）与写成「本仓的问题」（会诱人去硬修一个上游问题）——
 * 都在这里当场拦下。
 */
describe('CODEX_MCP_DISPATCH_GAP_NOTE', () => {
  it('说清三件事：缺口是什么、归谁、影响面（且不许写成「未证实」）', () => {
    expect(CODEX_MCP_DISPATCH_GAP_NOTE).toContain('unsupported call');
    expect(CODEX_MCP_DISPATCH_GAP_NOTE).toContain('上游');
    expect(CODEX_MCP_DISPATCH_GAP_NOTE).toContain('不影响其它两家');
    expect(CODEX_MCP_DISPATCH_GAP_NOTE).not.toContain('未证实');
  });
});
