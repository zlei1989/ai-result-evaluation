// @vitest-environment node
/**
 * 权限表的守卫。
 *
 * 为什么这份守卫是**跨三家**的：这三份表只有放在一起才看得出「谁漏了哪一档」，
 * 而漏一档的后果在冒烟里是**静默**的——claude-code 当时是三家唯一没设写使能的那家，
 * 7 行候选**全部 0 改动**，测试全绿、界面照常出分（只是在空 diff 上打分）。
 * 所以这里钉的不是「字符串写对了」，而是三件会各自静默出错的事：
 *   ① 每一档在**三家**都有落点（新增一档时漏掉某一家，编译期就会拦，见下面第一条的 `satisfies`）；
 *   ② `full` 档在每一家都**真的**是最宽档（价值判断写在注释里，判据是厂商的值域）；
 *   ③ 需要成对给的选项必须成对出现（claude 的 `bypassPermissions` + `allowDangerouslySkipPermissions`）。
 *
 * ⚠️ 本文件里的值域与厂商包的 `.d.ts` 是**两份**，所以每条断言都带一条「变异体」注释：
 * 值域变了（厂商升级 / 有人手滑），这里必须红，而不是继续绿着放行一个不存在的档位。
 */
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PERMISSION_OPTIONS,
  CODEX_PERMISSION_OPTIONS,
  DSH_PERMISSION_OPTIONS,
  codexPermissionOptions,
} from './permission';
import { listAgentProviders } from './registry';
import type { AgentPermission } from './types';

/** 两家厂商的 `SandboxMode` / `PermissionMode` 值域（逐字来自各自的 `.d.ts`，见 `permission.ts` 的文件头） */
const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'];
const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const DSH_PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

describe('权限表', () => {
  it('每一档在每一家都有落点（三张表都覆盖全部档位）', () => {
    // 覆盖性由类型保证（`Readonly<Record<AgentPermission, …>>`）：新增一档却不补表，
    // `pnpm typecheck` 当场红。这一条把「类型已经保证了」这件事**写下来**，
    // 免得后人以为这里是运行期才发现的问题而改成 `Partial<Record<…>>`（那会让缺档静默）。
    const all: AgentPermission[] = ['full', 'read-only'];
    for (const permission of all) {
      expect(CLAUDE_PERMISSION_OPTIONS[permission], `claude 缺 ${permission}`).toBeDefined();
      expect(CODEX_PERMISSION_OPTIONS[permission], `codex 缺 ${permission}`).toBeDefined();
      expect(DSH_PERMISSION_OPTIONS[permission], `dsh 缺 ${permission}`).toBeDefined();
    }
  });

  it('三家的档位名都在厂商的值域里（不是我们编的词）', () => {
    for (const permission of ['full', 'read-only'] as const) {
      const claude = CLAUDE_PERMISSION_OPTIONS[permission];
      expect(CLAUDE_PERMISSION_MODES, `claude ${permission}`).toContain(claude.permissionMode);

      const codex = CODEX_PERMISSION_OPTIONS[permission];
      expect(CODEX_SANDBOX_MODES, `codex ${permission}`).toContain(codex.sandboxMode);

      const dsh = DSH_PERMISSION_OPTIONS[permission];
      expect(DSH_PERMISSION_MODES, `dsh ${permission}`).toContain(dsh.env.DSH_PERMISSION_MODE);
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
  });

  it('档位之间真的不同（把两档写成同一份配置就是「分级」失效）', () => {
    // 这一条守的是**整张表的意义**：三家的两档若各自相等，说明有人把分档退化成了常量，
    // 而那时所有别处的断言（值域、成对选项）**照样全绿**——它们只看单档。
    expect(CLAUDE_PERMISSION_OPTIONS.full).not.toEqual(CLAUDE_PERMISSION_OPTIONS['read-only']);
    expect(CODEX_PERMISSION_OPTIONS.full).not.toEqual(CODEX_PERMISSION_OPTIONS['read-only']);
    expect(DSH_PERMISSION_OPTIONS.full).not.toEqual(DSH_PERMISSION_OPTIONS['read-only']);
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

  it('注册表里的每一家都有权限档（第四家进来时这条会红，直到它也有表）', () => {
    // 为什么按注册表现比、而不是自己写一个三家数组：`registry.ts` 的 `PROVIDERS` 是**另一处**
    // 静态清单，加第四家时最容易漏的就是这里（注册表加了、权限表没加 ⇒ 新那家静默吃厂商默认档）。
    // 断言的两侧都是「约定的名字」：左边来自注册表，右边是本文件显式维护的清单——
    // 它的作用是**逼人回来读这张表**，而不是假装它能自动发现新厂商。
    expect(listAgentProviders().map((provider) => provider.kind).sort()).toEqual([
      'claude-code',
      'codex',
      'dsh',
    ]);
  });
});
