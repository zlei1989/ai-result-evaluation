// @vitest-environment node
/**
 * 权限表的守卫。
 *
 * 为什么这份守卫是**跨家**的：这几份表只有放在一起才看得出「谁漏了哪一档」，
 * 而漏一档的后果在冒烟里是**静默**的——cc 当时是三家唯一没设写使能的那家，
 * 7 行候选**全部 0 改动**，测试全绿、界面照常出分（只是在空 diff 上打分）。
 * 所以这里钉的不是「字符串写对了」，而是三件会各自静默出错的事：
 *   ① 每一档在**每一家**都有落点（新增一档时漏掉某一家，编译期就会拦，见下面第一条的 `satisfies`）；
 *   ② `full` 档在每一家都**真的**是最宽档（价值判断写在注释里，判据是厂商的值域）；
 *   ③ 需要成对给的选项必须成对出现（claude 的 `bypassPermissions` + `allowDangerouslySkipPermissions`）。
 *
 * pi 的形状与三家**不同**：它没有权限标志位，两档落在**工具白名单**上（见 `permission.ts`）——
 * 故它另有两条专测（值域是 SDK 的 `ToolName`；只读档里一件写工具都不许在）。
 *
 * ⚠️ 本文件里的值域与厂商包的 `.d.ts` 是**两份**，所以每条断言都带一条「变异体」注释：
 * 值域变了（厂商升级 / 有人手滑），这里必须红，而不是继续绿着放行一个不存在的档位。
 */
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PERMISSION_OPTIONS,
  CODEX_PERMISSION_OPTIONS,
  DSH_PERMISSION_OPTIONS,
  PI_PERMISSION_OPTIONS,
  PI_SUBAGENTS_TOOL_NAMES,
  codexPermissionOptions,
} from './permission';
import { listAgentProviders } from './registry';
import type { AgentPermission } from './types';

/** 厂商的值域（逐字来自各自的 `.d.ts`，见 `permission.ts` 的文件头） */
const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'];
const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const DSH_PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
/** pi 的工具名值域（`core/tools/index.d.ts` 的 `ToolName`，本仓只用到其中六件） */
const PI_TOOL_NAMES = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'];

describe('权限表', () => {
  it('每一档在每一家都有落点（四张表都覆盖全部档位）', () => {
    // 覆盖性由类型保证（`Readonly<Record<AgentPermission, …>>`）：新增一档却不补表，
    // `pnpm typecheck` 当场红。这一条把「类型已经保证了」这件事**写下来**，
    // 免得后人以为这里是运行期才发现的问题而改成 `Partial<Record<…>>`（那会让缺档静默）。
    const all: AgentPermission[] = ['full', 'read-only'];
    for (const permission of all) {
      expect(CLAUDE_PERMISSION_OPTIONS[permission], `claude 缺 ${permission}`).toBeDefined();
      expect(CODEX_PERMISSION_OPTIONS[permission], `codex 缺 ${permission}`).toBeDefined();
      expect(DSH_PERMISSION_OPTIONS[permission], `dsh 缺 ${permission}`).toBeDefined();
      expect(PI_PERMISSION_OPTIONS[permission], `pi 缺 ${permission}`).toBeDefined();
    }
  });

  it('每一家的档位名都在厂商的值域里（不是我们编的词）', () => {
    for (const permission of ['full', 'read-only'] as const) {
      const claude = CLAUDE_PERMISSION_OPTIONS[permission];
      expect(CLAUDE_PERMISSION_MODES, `claude ${permission}`).toContain(claude.permissionMode);

      const codex = CODEX_PERMISSION_OPTIONS[permission];
      expect(CODEX_SANDBOX_MODES, `codex ${permission}`).toContain(codex.sandboxMode);

      const dsh = DSH_PERMISSION_OPTIONS[permission];
      expect(DSH_PERMISSION_MODES, `dsh ${permission}`).toContain(dsh.env.DSH_PERMISSION_MODE);

      // pi 的「档位」是工具白名单里的名字：**内置那几件**必须逐字是 SDK 的 `ToolName`
      // （编一个不存在的工具名不会报错，只会让这一轮少一件工具——正是「静默少能力」那种失败）。
      // 扩展注册的工具名**不在**这个值域里（它们由 `@tintinweb/pi-subagents` 注册），
      // 另有专条按扩展的注册面钉它们。
      for (const tool of PI_PERMISSION_OPTIONS[permission].tools) {
        if ((PI_SUBAGENTS_TOOL_NAMES as readonly string[]).includes(tool)) continue;
        expect(PI_TOOL_NAMES, `pi ${permission} 的 ${tool}`).toContain(tool);
      }
    }
    /**
     * 值域之外的**逐字**断言（为什么值域那一层不够）：`readonly` / `danger` 这类错别字
     * **不在** dsh 的值域里，所以那一层能拦；但把只读档写成 `workspace-write`（一个**合法**的值）
     * 时值域照样放行——而它的语义是「可写」。三家的档位名与运行阶段的对应关系是这里唯一的规格，
     * 所以逐字钉一遍：只读档一旦被写成 `workspace-write`（一个**合法**的值），值域那一层照样放行。
     */
    expect(CLAUDE_PERMISSION_OPTIONS.full.permissionMode).toBe('bypassPermissions');
    expect(CLAUDE_PERMISSION_OPTIONS['read-only'].permissionMode).toBe('dontAsk');
    expect(CODEX_PERMISSION_OPTIONS.full.sandboxMode).toBe('danger-full-access');
    expect(CODEX_PERMISSION_OPTIONS['read-only'].sandboxMode).toBe('read-only');
    expect(DSH_PERMISSION_OPTIONS.full.env.DSH_PERMISSION_MODE).toBe('danger-full-access');
    expect(DSH_PERMISSION_OPTIONS['read-only'].env.DSH_PERMISSION_MODE).toBe('read-only');
    // pi 的逐字值另有专条（它的形状与三家不同：白名单而不是开关，见下面那条）
  });

  it('full 档在每一家都是**最宽**档，且成对选项一并给出（少一个就静默失效）', () => {
    // claude：`bypassPermissions` 缺 `allowDangerouslySkipPermissions` 时 CLI 仍逐个工具要批准
    // ——SDK 把它们拼成两个独立 argv，类型面写着「Must be set to true when using …」。
    expect(CLAUDE_PERMISSION_OPTIONS.full).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    // codex：`workspace-write` 默认**关掉网络**（装依赖 / 跑测试会失败），最宽档是 danger-full-access
    expect(CODEX_PERMISSION_OPTIONS.full).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
    // dsh：`danger-full-access` 是唯一把 approval 一起设成 never 的预设（dsh-base 的 `approval` 行）
    expect(DSH_PERMISSION_OPTIONS.full).toEqual({ env: { DSH_PERMISSION_MODE: 'danger-full-access' } });
    // pi：最宽档 = `createCodingTools()` 那四件 **加**子智能体扩展那三件
    //（不给扩展工具的话「声明支持派发」与「工具面里真的有派发工具」就是两句话）
    expect(PI_PERMISSION_OPTIONS.full).toEqual({
      tools: ['read', 'bash', 'edit', 'write', ...PI_SUBAGENTS_TOOL_NAMES],
    });
  });

  it('read-only 档在每一家都不给执行层写能力，且都不留人工批准的口子', () => {
    // claude 这一格按运行阶段分档：只读档是 `dontAsk`，**不是**能写的 `acceptEdits`。
    expect(CLAUDE_PERMISSION_OPTIONS['read-only']).toEqual({
      permissionMode: 'dontAsk',
      permissionPrompts: 'none',
    });
    expect(CODEX_PERMISSION_OPTIONS['read-only']).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    });
    expect(DSH_PERMISSION_OPTIONS['read-only']).toEqual({ env: { DSH_PERMISSION_MODE: 'read-only' } });
    // pi 的只读档 = `createReadOnlyTools()` 那四件，**刻意不含 `bash`**（它能写盘，等于把只读档绕过去）
    expect(PI_PERMISSION_OPTIONS['read-only']).toEqual({ tools: ['read', 'grep', 'find', 'ls'] });
  });

  /**
   * pi 的只读档是**工具白名单**，不是权限开关——这一条守的是「别把写能力留在名单里」。
   *
   * 为什么单独一条：另三家的只读档写歪了会被厂商的值域或沙箱语义挡住（`workspace-write` 那种
   * 「合法的错值」另有逐字断言），而 pi 的名单里多一个 `bash` / `edit` / `write` **什么都不会报**——
   * 评审者照常起得来、照常出分，只是顺手把候选的工作区改了（「查看改动」抽屉按需现算 diff，
   * 污染之后分不清是谁改的）。判据因此是**写工具一件都不在名单里**。
   */
  it('pi 的只读档不含任何写工具（bash / edit / write / powershell 一件都不许在）', () => {
    const readOnly = PI_PERMISSION_OPTIONS['read-only'].tools;
    for (const writer of ['bash', 'edit', 'write', 'powershell']) {
      expect(readOnly, `pi 只读档里出现了写工具 ${writer}`).not.toContain(writer);
    }
    // 反向：它仍然要能自己看改动（只给 read 一件是不够的——评审者的工作是看 diff 与文件）
    expect(readOnly).toContain('grep');
    // 执行档反过来必须**真的有** bash：评测要观察的正是「改完自己跑不跑得起来」
    expect(PI_PERMISSION_OPTIONS.full.tools).toContain('bash');
  });

  /**
   * 候选工具表**至少留一件 `read` 或 `bash`**——它是 pi 系统提示词里**技能清单整段的渲染开关**。
   *
   * 为什么值一条专测：pi 拼系统提示词时按「候选工具表里有没有文件类工具」决定要不要写技能段
   * （`read` 与 `bash` **两件都不在**就整段不渲染），而本仓的技能装载档判据读的正是那一段
   * ⇒ 名单一旦收得只剩搜索类工具（`grep` / `find` / `ls`），技能会**静默**从提示词里消失：
   * 装载、清单、厂商侧 `getSkills()` 三处照样全绿，模型侧却一条技能都看不到。
   *
   * 扫描面按**表里的每一档**遍历（不是逐个档位写字面量）：新增一档却不留这两件时，
   * 逐字断言那几条只认自己点名的档，这一条才拦得住。
   */
  it('pi 的每一档候选工具表都留着 read 或 bash（两件都不在时技能段整段不渲染）', () => {
    for (const [permission, options] of Object.entries(PI_PERMISSION_OPTIONS)) {
      const keepsFileTool = options.tools.includes('read') || options.tools.includes('bash');
      expect(
        keepsFileTool,
        `pi 的 ${permission} 档候选工具表里 read 与 bash 都不在：系统提示词的技能段会静默不渲染`,
      ).toBe(true);
    }
  });

  /**
   * 只读档**一个扩展工具都不给**——尤其是 `Agent`。
   *
   * 为什么它是权限问题而不是「少个工具」：`Agent` 派出的子会话拿的是**完整工具面**
   * （子会话的工具选择由扩展与 agent 类型决定，不受本行白名单约束），评审者经它就能写工作区，
   * 而「只读」正是评分阶段赖以成立的那条不变量。真机形态：名单里给了 `Agent` 时，
   * 出站请求体的 `tools` 数组里**真的有**它——白名单是成员匹配器，给了就是真给了。
   */
  it('pi 的只读档不给任何子智能体扩展工具（Agent 能派发能写的子会话 ⇒ 那是权限提升）', () => {
    const readOnly = PI_PERMISSION_OPTIONS['read-only'].tools;
    for (const tool of PI_SUBAGENTS_TOOL_NAMES) {
      expect(readOnly, `pi 只读档里出现了子智能体扩展工具 ${tool}`).not.toContain(tool);
    }
    // 反向：执行档必须有它们，否则「声明支持派发」落不到工具面上
    for (const tool of PI_SUBAGENTS_TOOL_NAMES) {
      expect(PI_PERMISSION_OPTIONS.full.tools, `pi 执行档缺了 ${tool}`).toContain(tool);
    }
  });

  it('档位之间真的不同（把两档写成同一份配置就是「分级」失效）', () => {
    // 这一条守的是**整张表的意义**：四家的两档若各自相等，说明有人把分档退化成了常量，
    // 而那时所有别处的断言（值域、成对选项）**照样全绿**——它们只看单档。
    expect(CLAUDE_PERMISSION_OPTIONS.full).not.toEqual(CLAUDE_PERMISSION_OPTIONS['read-only']);
    expect(CODEX_PERMISSION_OPTIONS.full).not.toEqual(CODEX_PERMISSION_OPTIONS['read-only']);
    expect(DSH_PERMISSION_OPTIONS.full).not.toEqual(DSH_PERMISSION_OPTIONS['read-only']);
    expect(PI_PERMISSION_OPTIONS.full).not.toEqual(PI_PERMISSION_OPTIONS['read-only']);
  });

  /**
   * extraReadPaths 不落这几张表。
   *
   * 为什么钉**键集合**而不是值：`extraReadPaths` 的映射通道是 claude 的 query option
   * （`Options.additionalDirectories` / `--add-dir`，在 `providers/cc/index.ts` 里转发），
   * 不是权限档选项——把它塞进 `CLAUDE_PERMISSION_OPTIONS` 会逼 codex / dsh / pi 三家的表也去消费
   * 一个它们不映射的格（codex / dsh 的只读档本就全盘可读，pi 的只读档由白名单决定读得到什么）。
   * 键集合逐字钉死：谁往表里加一格，这里当场红，而不是靠「某个值恰好多出来」碰巧被发现。
   */
  it('extraReadPaths 不进这几份权限档表：键集合逐字钉死（它是 claude 的 query option，不是权限档选项）', () => {
    expect(Object.keys(CLAUDE_PERMISSION_OPTIONS.full).sort()).toEqual([
      'allowDangerouslySkipPermissions',
      'permissionMode',
    ]);
    expect(Object.keys(CLAUDE_PERMISSION_OPTIONS['read-only']).sort()).toEqual([
      'permissionMode',
      'permissionPrompts',
    ]);
    expect(Object.keys(CODEX_PERMISSION_OPTIONS.full).sort()).toEqual(['approvalPolicy', 'sandboxMode']);
    expect(Object.keys(CODEX_PERMISSION_OPTIONS['read-only']).sort()).toEqual(['approvalPolicy', 'sandboxMode']);
    expect(Object.keys(DSH_PERMISSION_OPTIONS.full).sort()).toEqual(['env']);
    expect(Object.keys(DSH_PERMISSION_OPTIONS['read-only']).sort()).toEqual(['env']);
    expect(Object.keys(PI_PERMISSION_OPTIONS.full).sort()).toEqual(['tools']);
    expect(Object.keys(PI_PERMISSION_OPTIONS['read-only']).sort()).toEqual(['tools']);
  });

  /**
   * Windows 豁免：codex 的受限沙箱在 Windows 上**起不了任何子进程**
   * （`read-only` 与 `workspace-write` 下连 `echo` / `git status` 都被 policy 拒），而它读文件
   * 只能靠 shell ⇒ 评分阶段会变成盲评（真机：候选三项全达成，评分 0/25）。故只读档在 Windows 上
   * 落最宽档，别的平台一个字不改。
   *
   * 变异：把 `platform === 'win32'` 去掉 ⇒ Linux/darwin 那两条红（只读档名存实亡）；
   * 把 `permission === 'read-only'` 去掉 ⇒ darwin 那条红（豁免外溢到别的档）。
   */
  it('codex 只读档在 Windows 上落 danger-full-access，别的平台保持 read-only', () => {
    expect(codexPermissionOptions('read-only', 'win32').sandboxMode).toBe('danger-full-access');
    // 批准策略是**另一格**，不受这条豁免影响：评测是非交互的
    expect(codexPermissionOptions('read-only', 'win32').approvalPolicy).toBe('never');
    expect(codexPermissionOptions('read-only', 'linux').sandboxMode).toBe('read-only');
    expect(codexPermissionOptions('read-only', 'darwin').sandboxMode).toBe('read-only');
    // 执行档在任何平台都不受豁免影响（本来就最宽）
    expect(codexPermissionOptions('full', 'win32')).toEqual({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' });
    // 豁免是**函数**里的处置，表本身仍是那份真源（别把它就地改掉：那会让别的平台一起变宽）
    expect(CODEX_PERMISSION_OPTIONS['read-only'].sandboxMode).toBe('read-only');
  });

  it('注册表里的每一家都有权限档（新家进来时这条会红，直到它也有表）', () => {
    // 为什么按注册表现比、而不是自己写一个三家数组：`registry.ts` 的 `PROVIDERS` 是**另一处**
    // 静态清单，加一家时最容易漏的就是这里（注册表加了、权限表没加 ⇒ 新那家静默吃厂商默认档）。
    // 断言的两侧都是「约定的名字」：左边来自注册表，右边是本文件显式维护的清单——
    // 它的作用是**逼人回来读这张表**，而不是假装它能自动发现新厂商。
    expect(listAgentProviders().map((provider) => provider.kind).sort()).toEqual([
      'cc',
      'codex',
      'dsh',
      'pi',
    ]);
  });
});
