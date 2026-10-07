# 远端 git 仓库来源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用例的「代码仓库」除了本地绝对路径之外还能填远端 git 地址（可选分支），由服务端把它镜像到工作区根下，之后走既有缓存 / 工作区 / 评测链路——全程不做凭据管理。

**Architecture:** 新增 `contracts/repo-source.ts` 作来源形态判定的唯一真源；core 新增 `mirror.ts` 负责裸镜像（`git clone --mirror` + 增量 `fetch --prune`）与基线解析；api / evaluator 在**调用既有 core 函数之前**把远端解析成「本地镜像路径 + 具体 40 位 hash」，于是 `ensureCaseCache` / `checkoutRow` / `collectDiff` 的行为一行不改。

**Tech Stack:** TypeScript 5（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）、zod 3、Next.js App Router、antd 6 + React 19、SWR 2、vitest 4（node / jsdom 双配置）、真实 git CLI（禁 mock）。

**Spec:** `docs/superpowers/specs/2026-09-22-scaffold-design.md` §13.4（下称 spec；来源判定、镜像层、错误文案表都在那里，本计划不重复理由。本线的过程 spec 已并入该文档并从库中删除）

## Global Constraints

- 提交一律**逐个显式** `git add <路径>`，禁止 `git add -A`（本仓可能有别的会话在工作；`git status` 里不属于你的文件保持原样）。
- 每个 Task 收尾前：`pnpm typecheck` → `pnpm lint` 全绿（顺序固定，见 AGENT.md「命令」节）；`pnpm test` 在 Task 14 全量跑一次。
- **每条新守卫都要做变异验证**（Task 14 的四条）：人为制造缺陷 → 确认该守卫**失败** → 还原并核对文件哈希未变。没有见过失败的守卫不算守卫。
- 远端 git 常量（spec §5.6）：探活 `REMOTE_PROBE_TIMEOUT_MS = 15_000`、传输 `REMOTE_TRANSFER_TIMEOUT_MS = 600_000`（可由调用方覆盖，测试用 1ms 制造确定性超时）。
- 远端调用必须带：`GIT_TERMINAL_PROMPT=0`、`stdin` 忽略、`GIT_SSH_COMMAND` **仅当进程环境里没有它时**才追加 `-o BatchMode=yes`（RG3 / RG4）。
- 错误码**只增** `REPO_UNREACHABLE`（400）；认证用 `AUTH_FAILED`、不存在/无法归因用 `NOT_A_GIT_REPO`、分支与提交不存在用 `INVALID_REF`（spec §4.5 / §8）。
- 镜像目录：`{workspaceRoot}/remotes/{slug}-{sha1(归一后 URL).slice(0, 8)}`；就绪判据是「`HEAD` 是文件且 `objects` 是目录」（RG5）；建镜像一律克隆到 `.tmp-<pid>` 再原子 rename（RG6）。
- 一律 `execFileSync`（禁 shell）；远端调用**必须**走 `core/src/git-exec.ts` 的同一个 `execute`（RG2）。
- 注释与日志：中文 JSDoc，先说「做什么」再说「怎么做」；日志上下文作为 `console` 第二参数透传，不 `JSON.stringify`（AGENT.md「注释」「日志」节）。
- 测试：`.tsx` 测试**只能写在库包**（`apps/web-next` 的 `jsx: preserve` 会让 Vite 直接失败）；库包用 `vitest.node.ts` / UI 与 client 用 `vitest.jsdom.ts`；测试**绝不碰真实 `~/.aieval`**（`setConfigDirForTesting`）。
- UI 一律走 antd（主题 token / 紧凑密度 / 语义 `styles`），不手写字号与行内边距，不裸写 `div`。
- RG1–RG13（spec §11）是本计划的硬口径；与本文冲突时以 spec 为准。
- 执行环境：本会话的文件沙箱已放开（`danger-full-access`），git CLI、`pnpm test`（夹具用真 git）、显式 `git add` 提交与真实远端冒烟都能直接跑——spec §9.5 记的那条「需要更宽权限或由人代跑」的约束**已不存在**。

## Review Focus

spec 没有逐条写、但一定会有人踩的五类输入 / 失败模式。每一条都钉在拥有那段代码的 Task 里：

1. **来源串以 `-` 开头**（例如 `--upload-pack=calc`）：远端 URL 是作为**参数**传给 `git clone` / `git ls-remote` 的，一旦放行就是参数注入面 → T1 的拒绝守卫 + T4 的调用姿势。
2. **粘贴串里带换行 / 制表符**：从终端复制 URL 时最常见的形态，控制字符进 git 参数的行为不可预期 → T1 的拒绝守卫。
3. **克隆超时被杀**：必须折成 `REPO_UNREACHABLE`（而不是 `NOT_A_GIT_REPO`，那会把用户指向「改地址」），且**不留半成品**——下一次调用能成功 → T5 的超时映射 + T4 的 tmp 清理。
4. **同一个 URL 被两个用例共用（或两个请求同时 ensureMirror）**：必须复用同一个镜像、不互相破坏、不出现「被使用的半成品」 → T4 的幂等 / rename 竞态用例。
5. **UI 的来源模式与服务端形态判定不一致**（用户把 `https://…` 填进「本地目录」态）：服务端必须仍按**形态**判定出远端并正常工作，不因界面的态而错判 → T7 的服务端用例 + T11 的接线取值。

---

### Task 1: contracts —— 来源形态判定与仓库名（`repo-source.ts`）

**Files:**
- Create: `packages/server/contracts/src/repo-source.ts`
- Create: `packages/server/contracts/src/repo-source.test.ts`
- Modify: `packages/server/contracts/src/index.ts`（导出新模块）

**Interfaces:**
- Consumes: `ServiceError`（`./errors`，已有）
- Produces:
  - `type RepoSource = { kind: 'local'; path: string } | { kind: 'remote'; url: string; host: string; repoName: string }`
  - `parseRepoSource(source: string): RepoSource`（不支持协议 / 含控制字符 / 以 `-` 开头 → 抛 `ServiceError('INVALID_QUERY', …)`）
  - `normalizeRemoteUrl(url: string): string`
  - `repoNameFromSource(source: string): string`
  - `RepoSourceStringSchema: z.ZodEffects<z.ZodString, string, string>`

- [ ] **Step 1: 写失败测试**

Create `packages/server/contracts/src/repo-source.test.ts`:

```ts
// @vitest-environment node
/**
 * 来源形态判定：本地绝对路径 vs 远端 git 地址。
 * 三条容易写错的地方（每条都对应一个真实误判）：
 *   1. Windows 盘符与 UNC 必须先于 URL 判定，否则 `D:/repos` 会被 scp 形态吞掉；
 *   2. scp 形态要额外要求「含 @ 或 host 段含点」，否则 `src:foo` 这种含冒号的相对路径会被判成远端；
 *   3. 归一只有「两侧空白 + 远端尾斜杠」两条——多归一一条，两个不同的远端就会指向同一份镜像。
 */
import { describe, expect, it } from 'vitest';
import { ServiceError } from './errors';
import { normalizeRemoteUrl, parseRepoSource, RepoSourceStringSchema, repoNameFromSource } from './repo-source';

describe('parseRepoSource', () => {
  it('Windows 盘符与 UNC 一律本地（先于 URL 判定）', () => {
    expect(parseRepoSource('D:\\repos\\demo')).toEqual({ kind: 'local', path: 'D:\\repos\\demo' });
    expect(parseRepoSource('D:/repos/demo')).toEqual({ kind: 'local', path: 'D:/repos/demo' });
    expect(parseRepoSource('\\\\host\\share\\repo')).toEqual({ kind: 'local', path: '\\\\host\\share\\repo' });
  });

  it('POSIX 绝对路径、相对路径、含冒号的相对路径都是本地', () => {
    expect(parseRepoSource('/home/me/repo').kind).toBe('local');
    expect(parseRepoSource('./repo').kind).toBe('local');
    // 含冒号但不是 scp 形态：host 段无点、无 @
    expect(parseRepoSource('src:foo').kind).toBe('local');
    expect(parseRepoSource('localhost:repo').kind).toBe('local');
  });

  it('五种白名单 scheme 是远端，并解析出 host 与仓库名', () => {
    expect(parseRepoSource('https://coding.jd.com/FlowAI/rbac-server.git')).toEqual({
      kind: 'remote',
      url: 'https://coding.jd.com/FlowAI/rbac-server.git',
      host: 'coding.jd.com',
      repoName: 'rbac-server',
    });
    expect(parseRepoSource('ssh://git@coding.jd.com:2222/FlowAI/rbac-server.git').host).toBe('coding.jd.com');
    expect(parseRepoSource('git://github.com/x/y.git').repoName).toBe('y');
    expect(parseRepoSource('file:///D:/tmp/origin.git')).toEqual({
      kind: 'remote',
      url: 'file:///D:/tmp/origin.git',
      host: 'localhost',
      repoName: 'origin',
    });
  });

  it('scp 形态：含 @ 或 host 段含点才算远端', () => {
    expect(parseRepoSource('git@coding.jd.com:FlowAI/rbac-server.git')).toEqual({
      kind: 'remote',
      url: 'git@coding.jd.com:FlowAI/rbac-server.git',
      host: 'coding.jd.com',
      repoName: 'rbac-server',
    });
    expect(parseRepoSource('github.com:x/y.git').kind).toBe('remote');
  });

  it('两侧空白与远端尾斜杠按归一处理，其余不做归一', () => {
    expect(parseRepoSource('  D:\\repos\\demo  ')).toEqual({ kind: 'local', path: 'D:\\repos\\demo' });
    expect(parseRepoSource(' https://host/x.git/ ')).toMatchObject({ url: 'https://host/x.git' });
    expect(normalizeRemoteUrl('  https://host/x.git/ ')).toBe('https://host/x.git');
    // 大小写与 .git 后缀都不归一：它们是镜像 key 与「来源是否改变」的判据
    expect(normalizeRemoteUrl('https://HOST/X.GIT')).toBe('https://HOST/X.GIT');
  });

  it('非白名单协议直接拒绝，文案点名协议', () => {
    const caught = (() => {
      try {
        parseRepoSource('ftp://host/x.git');
        return null;
      } catch (error) {
        return error as ServiceError;
      }
    })();
    expect(caught?.code).toBe('INVALID_QUERY');
    expect(caught?.message).toContain('ftp');
  });

  it('含控制字符或以 - 开头一律拒绝（RG13：参数注入面）', () => {
    const control = (() => {
      try {
        parseRepoSource('https://host/x.git\n');
        return null;
      } catch (error) {
        return error as ServiceError;
      }
    })();
    expect(control?.code).toBe('INVALID_QUERY');
    expect(control?.message).toContain('控制字符');

    const dash = (() => {
      try {
        parseRepoSource('--upload-pack=calc');
        return null;
      } catch (error) {
        return error as ServiceError;
      }
    })();
    expect(dash?.code).toBe('INVALID_QUERY');
    expect(dash?.message).toContain('不能以 - 开头');
  });
});

describe('repoNameFromSource', () => {
  it('远端取末段去 .git，末段为空时回落 host；本地取路径末段', () => {
    expect(repoNameFromSource('git@coding.jd.com:FlowAI/rbac-server.git')).toBe('rbac-server');
    expect(repoNameFromSource('https://host/')).toBe('host');        // 没有路径段时才回落主机名
    expect(repoNameFromSource('https://host/x.git/')).toBe('x');     // 尾斜杠与镜像 key 的归一口径一致
    expect(repoNameFromSource('https://host/group/')).toBe('group'); // 尾斜杠不是「空末段」（裁定：以镜像 key 的归一口径为准）
    expect(repoNameFromSource('D:\\repos\\demo\\')).toBe('demo');
    expect(repoNameFromSource('/home/me/tool-id')).toBe('tool-id');
  });
});

describe('RepoSourceStringSchema', () => {
  it('合法来源通过，非法来源带上 ServiceError 的中文原因', () => {
    expect(RepoSourceStringSchema.safeParse('D:\\repos\\demo').success).toBe(true);
    expect(RepoSourceStringSchema.safeParse('git@host:group/repo.git').success).toBe(true);
    const parsed = RepoSourceStringSchema.safeParse('ftp://host/x.git');
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain('不支持的 git 地址协议');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test -- repo-source`
Expected: FAIL —— `Failed to resolve import "./repo-source"`（模块还不存在）

- [ ] **Step 3: 实现 `repo-source.ts`**

```ts
/**
 * 用例的代码来源：形态判定（本地绝对路径 / 远端 git 地址）、归一与仓库名解析。
 *
 * 为什么放 contracts：core 的镜像层、api 的校验与文案、ui 的标签三层都要用它，各写一份必然漂移，
 * 而漂移的代价是「同一个字符串在保存时是远端、在准备时是本地」（RG1）。
 * 判定顺序是承重的，见 parseRepoSource 内的逐条注释。
 */
import { z } from 'zod';
import { ServiceError } from './errors';

/** 白名单 scheme：只有这五种前缀会被当成远端 git 地址 */
const REMOTE_SCHEMES = new Set(['ssh', 'http', 'https', 'git', 'file']);

/** `scheme://` 前缀（scheme 字符集按 RFC 3986，大小写不敏感） */
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
/** Windows 盘符（`D:\…` / `D:/…`）与 UNC（`\\host\share`） */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC_PREFIX = /^\\\\/;
/** scp 形态：`[user@]host:path`（host 段至少 2 字符，排除 `D:` 这种单字母盘符） */
const SCP_LIKE = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]{2,}):(.+)$/;
/** 控制字符（含换行与制表符）：粘贴事故的主要形态，且会污染 git 参数 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type RepoSource =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; url: string; host: string; repoName: string };

/**
 * 形态判定 + 归一 + 解析 host 与仓库名。
 * 判定顺序（改顺序就会误判）：
 *   ① 控制字符 / 以 `-` 开头 —— 硬拒绝（RG13：远端 URL 会作为参数交给 git）；
 *   ② Windows 盘符与 UNC —— 本地（必须先于 scp 形态，`D:/repos` 会被 scp 正则吞掉）；
 *   ③ `scheme://` —— 白名单内是远端，白名单外**拒绝**（不回落成本地路径）；
 *   ④ `[user@]host:path` 且（含 `@` 或 host 段含点）—— 远端；
 *   ⑤ 其余一律本地路径：本地路径的合法性由 git 自己判（`resolveRepoInfo`），这里不抢它的活。
 */
export function parseRepoSource(source: string): RepoSource {
  const trimmed = source.trim();
  if (CONTROL_CHARS.test(trimmed)) {
    throw new ServiceError('INVALID_QUERY', '代码来源里含控制字符（换行、制表符等），请重新粘贴');
  }
  if (trimmed.startsWith('-')) {
    throw new ServiceError('INVALID_QUERY', `代码来源不能以 - 开头：${trimmed}`);
  }
  if (WINDOWS_DRIVE.test(trimmed) || UNC_PREFIX.test(trimmed)) return { kind: 'local', path: trimmed };

  const schemeMatch = SCHEME_PREFIX.exec(trimmed);
  if (schemeMatch !== null) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    if (!REMOTE_SCHEMES.has(scheme)) {
      throw new ServiceError(
        'INVALID_QUERY',
        `不支持的 git 地址协议：${scheme}（支持 ssh:// / http:// / https:// / git:// / file:// 与 user@host:path）`,
      );
    }
    const url = normalizeRemoteUrl(trimmed);
    return { kind: 'remote', url, host: hostOf(url), repoName: remoteRepoName(url) };
  }

  const scpMatch = SCP_LIKE.exec(trimmed);
  const scpHost = scpMatch?.[2] ?? '';
  if (scpMatch !== null && (trimmed.includes('@') || scpHost.includes('.'))) {
    return { kind: 'remote', url: trimmed, host: scpHost, repoName: stripGitSuffix(lastSegment(scpMatch[3] ?? '')) || scpHost };
  }

  return { kind: 'local', path: trimmed };
}

/**
 * 远端 URL 的归一：仅去尾部斜杠。
 * 刻意**不**做大小写折叠、不剥 `.git`、不把 https 改写成 ssh：它是镜像 key 与
 * 「用例来源是否改变」的判据，过度归一会让两个不同的远端指向同一份镜像（spec §4.1）。
 */
export function normalizeRemoteUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** 仓库名：远端取末段去 `.git`，本地取路径末段（界面标签与远端提示词共用） */
export function repoNameFromSource(source: string): string {
  const parsed = parseRepoSource(source);
  return parsed.kind === 'remote' ? parsed.repoName : lastSegment(parsed.path);
}

/** 给用例契约用的来源校验：失败时把 ServiceError 的中文原因原样带进 zod issue */
export const RepoSourceStringSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      parseRepoSource(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof ServiceError ? error.message : '代码来源不合法',
      });
    }
  });

/** 远端 URL 的主机名；`file://` 没有主机，统一记作 `localhost`（文案里不会出现空主机） */
function hostOf(url: string): string {
  if (url.startsWith('file://')) return 'localhost';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 远端 URL 的仓库名：**先剥尾分隔符**再取末段、去 `.git`；**没有任何路径段**（`https://host/`）时才回落主机名 */
function remoteRepoName(url: string): string {
  const path = url.startsWith('file://') ? url.slice('file://'.length) : safePathname(url);
  return stripGitSuffix(lastSegment(path)) || hostOf(url) || 'repo';
}

/** `new URL()` 解析不出路径时给空串（scp 形态不走这里；畸形 URL 由 git 去报错） */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** 取路径末段：先去尾部分隔符，再从最后一个分隔符切（两种斜杠都认） */
function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed === '') return '';
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** 去掉 `.git` 后缀（只去一次，`x.git.git` → `x.git`） */
function stripGitSuffix(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -'.git'.length) : name;
}
```

- [ ] **Step 4: 导出到 `index.ts`**

在 `packages/server/contracts/src/index.ts` 的 `./case` 导出一行之前插入：

```ts
export {
  RepoSourceStringSchema,
  normalizeRemoteUrl,
  parseRepoSource,
  repoNameFromSource,
  type RepoSource,
} from './repo-source';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/contracts test -- repo-source`
Expected: PASS（3 个 describe 全绿）

- [ ] **Step 6: 提交**

```bash
git add packages/server/contracts/src/repo-source.ts packages/server/contracts/src/repo-source.test.ts packages/server/contracts/src/index.ts
git commit -m "feat(contracts): 来源形态判定与仓库名解析（远端 git 地址 / 本地路径）"
```

---

### Task 2: contracts —— 用例 / 运行 / 错误码契约变更（含 core 的签名级适配）

**Files:**
- Modify: `packages/server/contracts/src/case.ts`
- Modify: `packages/server/contracts/src/run.ts`
- Modify: `packages/server/contracts/src/errors.ts`
- Modify: `packages/server/contracts/src/index.ts`（导出新 schema 与类型）
- Modify: `packages/server/core/src/git.ts`（`resolveRepoInfo` 补 `RepoInfo` 新字段、`listCommits` 增可选 ref —— RG7 允许的两处）
- Modify: `packages/server/core/src/index.ts`（无需改；确认 `listCommits` 已导出）
- Test: `packages/server/contracts/src/case.test.ts`、`packages/server/contracts/src/run.test.ts`、`packages/server/contracts/src/errors.test.ts`、`packages/server/core/src/git.repo.test.ts`
- Modify（类型夹具，会被 tsc 抓到）: `packages/client/client/src/cases.test.tsx`、`packages/client/ui/src/composite/case-form-panel.test.tsx`、`packages/server/api/src/cases.test.ts`（`RepoInfo` 字面量）

**Interfaces:**
- Consumes: `RepoSourceStringSchema`（Task 1）
- Produces:
  - `TestCase.repoBranch: string | null`、`CaseCreate.repoBranch: string | null`、`EvalRun.repoBranch: string | null`（缺字段读成 `null`）
  - `RepoInfo = { repoPath; repoName; branch; kind: 'local' | 'remote'; mirrorPath: string | null; mirrorReady: boolean; mirrorFetchedAt: string | null; tip: string | null }`
  - `RepoValidateInputSchema` / `RepoCommitsInputSchema`（= `{ repoPath: string; repoBranch: string | null }`）
  - `ERROR_CODES` 增 `'REPO_UNREACHABLE'`（400）
  - `resolveRepoInfo(path): RepoInfo`（本地常量字段齐全）、`listCommits(repoPath: string, limit?: number, ref?: string | null)`

- [ ] **Step 1: 写失败测试（contracts）**

在 `packages/server/contracts/src/case.test.ts` 追加：

```ts
it('repoBranch 缺字段读成 null（旧 config.json 的用例没有这一列）', () => {
  const parsed = TestCaseSchema.parse({ ...validCase(), repoBranch: undefined });
  expect(parsed.repoBranch).toBeNull();
});

it('repoPath 走来源判定：ftp:// 被拒、git 地址通过', () => {
  expect(TestCaseSchema.safeParse({ ...validCase(), repoPath: 'ftp://host/x.git' }).success).toBe(false);
  expect(TestCaseSchema.safeParse({ ...validCase(), repoPath: 'git@host:group/repo.git' }).success).toBe(true);
});

it('RepoInfo 的远端字段是必填（界面靠 kind 决定回显哪一套）', () => {
  const remote = {
    repoPath: 'git@host:group/repo.git',
    repoName: 'repo',
    branch: 'main',
    kind: 'remote',
    mirrorPath: 'C:/runs/remotes/repo-1a2b3c4d',
    mirrorReady: true,
    mirrorFetchedAt: '2026-09-26T04:00:00.000Z',
    tip: 'abc1234',
  };
  expect(RepoInfoSchema.parse(remote).kind).toBe('remote');
  expect(RepoInfoSchema.safeParse({ repoPath: 'D:/r', repoName: 'r', branch: 'main' }).success).toBe(false);
});

it('校验 / 候选入参带可选分支，缺省为 null', () => {
  expect(RepoValidateInputSchema.parse({ repoPath: 'D:/r' }).repoBranch).toBeNull();
  expect(RepoCommitsInputSchema.parse({ repoPath: 'D:/r', repoBranch: 'feat/x' }).repoBranch).toBe('feat/x');
});
```

（`validCase()` 若测试文件里没有，就按该文件既有写法内联一份最小用例对象；不要新增共享 helper。）

在 `packages/server/contracts/src/run.test.ts` 追加：

```ts
it('EvalRun.repoBranch 缺字段读成 null（旧 run.json 没有这一列）', () => {
  const run = EvalRunSchema.parse({ ...validRun(), repoBranch: undefined });
  expect(run.repoBranch).toBeNull();
});
```

在 `packages/server/contracts/src/errors.test.ts`：把 `ERROR_CODES` 的精确列表断言补上 `'REPO_UNREACHABLE'`（位置与 `errors.ts` 一致），并在 `httpStatusFor` 的逐码断言里补 `expect(httpStatusFor('REPO_UNREACHABLE')).toBe(400);`。

在 `packages/server/core/src/git.repo.test.ts` 追加：

```ts
it('resolveRepoInfo 回显本地来源的常量字段（RepoInfo 契约要求齐全）', () => {
  const repo = makeRepo('local-const', 1);
  expect(resolveRepoInfo(repo)).toMatchObject({
    kind: 'local',
    mirrorPath: null,
    mirrorReady: false,
    mirrorFetchedAt: null,
    tip: null,
  });
});

it('listCommits 不给 ref 时行为不变（读 HEAD），给了 ref 时读该 ref 的历史', () => {
  const repo = makeRepo('commits-ref', 2);
  expect(listCommits(repo, 20).length).toBe(2);
  expect(listCommits(repo, 1, 'HEAD~1')[0]?.subject).toBe('第 1 次提交');
});
```

（`makeRepo` 用该测试文件已有的那个同义 helper；名字不同就按文件里的实际名字写，不要新造一个。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test -- case run errors` 与 `pnpm --filter @aieval/core test -- git.repo`
Expected: FAIL —— `repoBranch` 不在 schema 里 / `ERROR_CODES` 不含 `REPO_UNREACHABLE` / `listCommits` 收到 3 个参数报错

- [ ] **Step 3: 改 `case.ts`**

替换 import 与三个 schema 的对应字段（其余不动）：

```ts
import { RepoSourceStringSchema } from './repo-source';

export const TestCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** 代码来源：本地绝对路径 或 远端 git 地址（形态判定见 repo-source.ts） */
  repoPath: RepoSourceStringSchema,
  /** null = 默认分支 HEAD；填了必须能通过 `git cat-file -e <hash>^{commit}` */
  commitHash: z.string().min(1).nullable(),
  /** 远端来源的分支；null = 远端默认分支。本地来源必须是 null（写侧拦） */
  repoBranch: z.string().min(1).nullable().default(null),
  taskPrompt: z.string().min(1),
  judgePrompt: z.string().min(1),
  judgeProviderId: z.string().min(1).nullable(),
  judgeModelId: z.string().min(1).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
```

`CaseCreateSchema` 同样加 `repoBranch: z.string().min(1).nullable().default(null)`；`RepoInfoSchema` 换成：

```ts
/** 仓库校验结果：本地来源只填前三项 + kind='local'，远端另有镜像三件套与 tip（spec §4.3） */
export const RepoInfoSchema = z.object({
  repoPath: z.string(),
  repoName: z.string(),
  branch: z.string(),
  kind: z.enum(['local', 'remote']),
  mirrorPath: z.string().nullable(),
  mirrorReady: z.boolean(),
  mirrorFetchedAt: z.string().nullable(),
  tip: z.string().nullable(),
});
```

并把 `RepoPathInputSchema` 下面追加：

```ts
/**
 * 来源 + 可选分支的入参：校验与候选共用同一形状。
 * 保留两个名字是因为它们在接口上是两件事（校验仓库 / 列提交候选），实现共用一份 schema——
 * 写两遍必然漂移，而漂移的症状是「两个接口对同一个来源给出不同判定」。
 */
const RepoSourceQuerySchema = RepoPathInputSchema.extend({
  repoBranch: z.string().min(1).nullable().default(null),
});
export const RepoValidateInputSchema = RepoSourceQuerySchema;
export const RepoCommitsInputSchema = RepoSourceQuerySchema;
export type RepoValidateInput = z.infer<typeof RepoValidateInputSchema>;
export type RepoCommitsInput = z.infer<typeof RepoCommitsInputSchema>;
```

- [ ] **Step 4: 改 `run.ts` 与 `errors.ts`**

`run.ts` 的 `EvalRunSchema` 在 `commitHash` 之后加：

```ts
  /** 冗余快照：用例被改分支或删除后，这一轮从哪个分支起跑仍可追溯（与 repoPath 同口径） */
  repoBranch: z.string().min(1).nullable().default(null),
```

`errors.ts` 在 `'NOT_A_GIT_REPO'` 之后加一行 `'REPO_UNREACHABLE', // 400 远端 git 仓库不可达（DNS / 连接超时 / 连接被拒 / SSH 主机指纹未信任 / 拉取超时）`，并在 `STATUS_BY_CODE` 里加 `REPO_UNREACHABLE: 400,`。

- [ ] **Step 5: 改 `git.ts` 的两处签名（RG7 允许的全部改动）**

`resolveRepoInfo` 的返回改为（`log.debug` 行保持不变）：

```ts
  const repoName = basename(topLevel) || topLevel;
  log.debug('仓库校验通过', { repoPath, repoName, branch });
  // RepoInfo 契约新增的四个字段对本地来源是常量取值：远端那套（镜像路径 / 就绪 / 更新时间 / tip）
  // 一律为 null / false，界面按 kind 决定回显哪一套（spec §4.3）
  return { repoPath, repoName, branch, kind: 'local', mirrorPath: null, mirrorReady: false, mirrorFetchedAt: null, tip: null };
```

`listCommits` 的签名与 execute 调用改为：

```ts
export function listCommits(repoPath: string, limit = 20, ref: string | null = null): CommitCandidate[] {
  let output: string;
  try {
    // ref 只在远端候选那条路上给（镜像里的具体 ref）；不给时与既有行为逐字相同（读 HEAD）
    const args = ['log', '--format=%h%x09%s', '-n', String(limit), ...(ref === null ? [] : [ref])];
    output = execute(repoPath, args);
  } catch (error) {
```

- [ ] **Step 6: 修 tsc 抓出来的类型夹具**

Run: `pnpm typecheck`
Expected: 报出所有 `RepoInfo` 字面量缺字段的位置。已知会中招的文件（以 tsc 输出为准，别漏）：

- `packages/client/client/src/cases.test.tsx`（`const info: RepoInfo = …`）
- `packages/client/ui/src/composite/case-form-panel.test.tsx`（`REPO_INFO`）
- `packages/server/api/src/cases.test.ts`（`expect(info.repoPath)` 与字面量）
- `packages/server/evaluator/src/testing/fixtures.ts`（`makeCaseFixture` / `makeRunFixture` 要补 `repoBranch: null`）
- `packages/server/api/src/testing/run-fixtures.ts`、`packages/client/client/src/testing/run-fixtures.ts`（`EvalRun` 字面量补 `repoBranch: null`）
- `packages/server/evaluator/src/run-store.test.ts`（`EvalRun` 字面量）

逐个补上本地常量字段，例如：

```ts
const REPO_INFO: RepoInfo = {
  repoPath: 'D:\\projects\\gateway',
  repoName: 'gateway',
  branch: 'main',
  kind: 'local',
  mirrorPath: null,
  mirrorReady: false,
  mirrorFetchedAt: null,
  tip: null,
};
```

同时给这些测试文件里造用例字面量的地方补 `repoBranch: null`（`TestCase` / `CaseCreate` 都是必填输出字段；`z.infer` 的输出类型里 `.default(null)` 让它是必填的 `string | null`）。

- [ ] **Step 7: 运行测试与类型检查确认通过**

Run: `pnpm --filter @aieval/contracts test` → PASS
Run: `pnpm --filter @aieval/core test` → PASS（既有 git 测试不改一行仍全绿，是 RG7 的证据）
Run: `pnpm typecheck` → 0 error

- [ ] **Step 8: 提交**

```bash
git add packages/server/contracts/src/case.ts packages/server/contracts/src/case.test.ts packages/server/contracts/src/run.ts packages/server/contracts/src/run.test.ts packages/server/contracts/src/errors.ts packages/server/contracts/src/errors.test.ts packages/server/contracts/src/index.ts packages/server/core/src/git.ts packages/server/core/src/git.repo.test.ts packages/client/client/src/cases.test.tsx packages/client/ui/src/composite/case-form-panel.test.tsx packages/server/api/src/cases.test.ts
git commit -m "feat(contracts): 用例/评测契约支持远端来源与分支，错误码增 REPO_UNREACHABLE"
```

---

### Task 3: core —— 抽出 `git-exec.ts`（纯重构，行为不变）

**Files:**
- Create: `packages/server/core/src/git-exec.ts`
- Create: `packages/server/core/src/git-exec.test.ts`
- Modify: `packages/server/core/src/git.ts`（删掉本地 `execute` / `gitMessage`，改为 import）

**Interfaces:**
- Produces:
  - `execute(dir: string, args: string[], options?: GitExecOptions): string`，`GitExecOptions = { env?: Record<string, string>; timeoutMs?: number }`
  - `gitMessage(error: unknown): string`
  - `isTimeoutKill(error: unknown): boolean`（Task 5 的超时映射用）

- [ ] **Step 1: 写失败测试**

Create `packages/server/core/src/git-exec.test.ts`:

```ts
// @vitest-environment node
/**
 * git 进程封装：追加环境变量、墙钟超时、超时判定。
 * 三条都必须在**真进程**上验：超时的错误形状（signal / code）是 Node 的实现细节，
 * 用 mock 验等于把自己的假设抄一遍。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execute, gitMessage, isTimeoutKill } from './git-exec';

const created: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aieval-exec-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('execute', () => {
  it('返回 stdout（含中文，utf8 不乱码）', () => {
    expect(execute(makeTmp(), ['--version'])).toContain('git version');
  });

  it('追加的环境变量对子进程可见（远端调用靠它禁交互式提示）', () => {
    const dir = makeTmp();
    // 用 git 自己把环境变量读出来：`git var GIT_AUTHOR_IDENT` 会读 GIT_AUTHOR_NAME
    execute(dir, ['init', '-q']);
    const ident = execute(dir, ['var', 'GIT_AUTHOR_IDENT'], {
      env: { GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.com' },
    });
    expect(ident).toContain('probe');
  });

  it('超时被杀：isTimeoutKill 为真，且不是普通失败', () => {
    const dir = makeTmp();
    let caught: unknown = null;
    try {
      // 1ms 上限对一个真实的 git 进程必定超时（确定性，不依赖机器快慢）
      execute(dir, ['init', '-q'], { timeoutMs: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(isTimeoutKill(caught)).toBe(true);
    expect(gitMessage(caught)).not.toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test -- git-exec`
Expected: FAIL —— `Failed to resolve import "./git-exec"`

- [ ] **Step 3: 实现 `git-exec.ts`**

把 `git.ts` 里的 `execute` / `gitMessage` 原样搬过来，并加上两个可选能力（注释里保留原有的两条 `-c` 理由，指向 git.ts 文件头）：

```ts
/**
 * git 进程封装：core 内**唯一**的执行入口（本地与远端调用共用，RG2）。
 * `execFileSync` 而不是 `execSync`：参数里有用户填的 URL / 路径 / commit hash，走 shell 会引入注入面。
 * 两个 `-c` 见 git.ts 文件头的口径（非 ASCII 路径不乱码、工作树字节与仓库一致）。
 * 本文件相对 git.ts 多出来的只有两件事：追加环境变量、墙钟超时（远端调用需要）。
 */
import { execFileSync } from 'node:child_process';

export interface GitExecOptions {
  /** 追加/覆盖的环境变量（远端调用用它禁交互式提示，见 mirror.ts 的 remoteOptions） */
  env?: Record<string, string>;
  /** 墙钟上限（毫秒）；到点按 killSignal 杀子进程 */
  timeoutMs?: number;
}

export function execute(dir: string, args: string[], options: GitExecOptions = {}): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    // 大仓库的 diff / status 可能超过默认 1MB 的 maxBuffer，直接调大避免静默截断
    maxBuffer: 64 * 1024 * 1024,
    // stdin 必须断开：ssh 拿不到输入时会立即失败，而不是等着谁来敲密码（RG3）
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: 'SIGTERM' as const }),
  });
}

/** 取 execFileSync 抛出的错误里的 stderr 原文（git 的人类可读报错都在这里） */
export function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

/**
 * 是不是「被我们的墙钟上限杀掉」。
 * 判据是**信号**而不是文案：远端自己报 timeout 的原文里也常有 `timed out`，
 * 按关键词匹配会把「远端不可达」与「我们杀的那次」混成一类（spec §8.2 末段）。
 * Node 在超时时给错误带上 signal（killSignal）与 code=ETIMEDOUT，两者都认。
 */
export function isTimeoutKill(error: unknown): boolean {
  const shape = error as { signal?: unknown; code?: unknown };
  return shape.signal === 'SIGTERM' || shape.code === 'ETIMEDOUT';
}
```

- [ ] **Step 4: 改 `git.ts` 用新模块**

删掉 `git.ts` 里 `function execute(...)` 与 `function gitMessage(...)` 两段实现（含其 JSDoc），把文件头的口径注释保留，并在 import 区加：

```ts
import { execute, gitMessage } from './git-exec';
```

文件头第一段补一句：`执行入口与两个 -c 的完整理由见 git-exec.ts。`

- [ ] **Step 5: 运行测试确认通过（既有 git 测试是重构的守卫）**

Run: `pnpm --filter @aieval/core test` → PASS（`git.repo` / `git.diff` / `workspace` 等既有用例一行未改）
Run: `pnpm --filter @aieval/core test -- git-exec` → PASS

- [ ] **Step 6: 提交**

```bash
git add packages/server/core/src/git-exec.ts packages/server/core/src/git-exec.test.ts packages/server/core/src/git.ts
git commit -m "refactor(core): git 进程封装抽到 git-exec 并支持追加环境变量与墙钟超时"
```

---

### Task 4: core —— 镜像存在性层（`mirrorDir` / `ensureMirror`）

**Files:**
- Create: `packages/server/core/src/mirror.ts`
- Create: `packages/server/core/src/mirror.test.ts`
- Modify: `packages/server/core/src/index.ts`（导出 `ensureMirror` / `mirrorDir` / `remotesDir`）

**Interfaces:**
- Consumes: `execute` / `gitMessage`（Task 3）、`normalizeRemoteUrl`（Task 1）、`ServiceError`
- Produces:
  - `remotesDir(workspaceRoot: string): string` → `{workspaceRoot}/remotes`
  - `mirrorDir(workspaceRoot: string, url: string): string` → `{remotesDir}/{slug}-{sha1(normalizeRemoteUrl(url)).slice(0,8)}`
  - `ensureMirror(input: { workspaceRoot: string; url: string; timeoutMs?: number }): { mirrorDir: string; created: boolean }`（**不联网更新**，只保证存在）
  - `promoteMirror(tmpDir: string, targetDir: string): 'created' | 'reused-existing'`（内部步骤，单独导出只为了让「rename 撞车」这条分支可测——它靠并发才可达）
  - `isMirrorReady(mirrorDir: string): boolean`

- [ ] **Step 1: 写失败测试**

Create `packages/server/core/src/mirror.test.ts`:

```ts
// @vitest-environment node
/**
 * 远端镜像的存在性层：目录 key、克隆到 tmp + 原子 rename、幂等与半成品重建。
 * 夹具是**真 git 仓库**（file:// 指向一个裸克隆），不打网络——远端链路的每条路径都要能在离线跑。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureMirror, isMirrorReady, mirrorDir, promoteMirror, remotesDir } from './mirror';

const created: string[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** 跑一条 git 命令（身份显式给，避免依赖宿主机配置） */
function git(dir: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8' },
  );
}

/** 造一个「远端」：工作仓库 → 裸克隆 → file:// URL（分支含 main 与调用方给的那些） */
function makeOriginRepo(root: string, branches: string[] = []): { bareDir: string; url: string; hashes: Record<string, string> } {
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  writeFileSync(join(work, 'a.txt'), 'a\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'first']);
  const hashes: Record<string, string> = { main: git(work, ['rev-parse', 'HEAD']).trim() };
  for (const branch of branches) {
    git(work, ['checkout', '-q', '-B', branch]);
    writeFileSync(join(work, `${branch.replace(/\//g, '-')}.txt`), `${branch}\n`, 'utf8');
    git(work, ['add', '.']);
    git(work, ['commit', '-q', '-m', `${branch} 的提交`]);
    hashes[branch] = git(work, ['rev-parse', 'HEAD']).trim();
  }
  git(work, ['checkout', '-q', 'main']);
  const bareDir = join(root, 'origin.git');
  git(root, ['clone', '-q', '--bare', work, bareDir]);
  return { bareDir, url: `file:///${bareDir.replace(/\\/g, '/')}` , hashes };
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mirrorDir', () => {
  it('同一 URL（两侧空白 / 尾斜杠差异）映射同一目录；不同形态映射不同目录', () => {
    const root = 'C:/runs';
    expect(mirrorDir(root, ' https://host/x.git/ ')).toBe(mirrorDir(root, 'https://host/x.git'));
    expect(mirrorDir(root, 'https://host/x.git')).not.toBe(mirrorDir(root, 'git@host:x.git'));
    expect(mirrorDir(root, 'https://host/x.git')).toContain(join(remotesDir(root), 'x-'));
  });
});

describe('ensureMirror', () => {
  it('首次建镜像：目录满足就绪判据，且来源的全部分支都在（含非默认分支）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root, ['feat/x']);

    const first = ensureMirror({ workspaceRoot, url: origin.url });

    expect(first.created).toBe(true);
    expect(isMirrorReady(first.mirrorDir)).toBe(true);
    const refs = git(first.mirrorDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').map((l) => l.trim());
    expect(refs).toContain('main');
    expect(refs).toContain('feat/x');
  });

  it('幂等且不联网：第二次 created=false，且来源仓库**被移走**也照样成功', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const first = ensureMirror({ workspaceRoot, url: origin.url });

    // 把来源整体改名：任何联网/读取来源的行为都会在这里失败（这就是「不联网」的证据）
    renameSync(origin.bareDir, `${origin.bareDir}.moved`);

    const second = ensureMirror({ workspaceRoot, url: origin.url });
    expect(second.created).toBe(false);
    expect(second.mirrorDir).toBe(first.mirrorDir);
  });

  it('半成品目录（有目录没有 objects）被重建', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const dir = mirrorDir(workspaceRoot, origin.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README'), '半成品\n', 'utf8');

    expect(isMirrorReady(dir)).toBe(false);
    const built = ensureMirror({ workspaceRoot, url: origin.url });
    expect(built.created).toBe(true);
    expect(isMirrorReady(built.mirrorDir)).toBe(true);
  });

  it('克隆失败不留 tmp 残留（超时/不可达之后，下一次调用能干净地重建）', async () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);

    expect(() => ensureMirror({ workspaceRoot, url: origin.url, timeoutMs: 1 })).toThrow();
    const remotes = remotesDir(workspaceRoot);
    expect(existsSync(remotes) ? readdirSync(remotes).filter((name) => name.includes('.tmp-')) : []).toEqual([]);

    // 下一次调用（正常超时）能成功——证明上一步没留下让 clone 以「目标非空」失败的东西
    expect(ensureMirror({ workspaceRoot, url: origin.url }).created).toBe(true);
  });
});

describe('promoteMirror', () => {
  it('目标已存在且就绪时复用既有目录并清掉 tmp（rename 撞车的可达路径）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const target = ensureMirror({ workspaceRoot, url: origin.url }).mirrorDir;
    const tmp = `${target}.tmp-999`;
    git(remotesDir(workspaceRoot), ['clone', '-q', '--mirror', origin.url, tmp]);

    expect(promoteMirror(tmp, target)).toBe('reused-existing');
    expect(existsSync(tmp)).toBe(false);
    expect(isMirrorReady(target)).toBe(true);
  });

  it('目标不存在时把 tmp 改名过去', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const target = mirrorDir(workspaceRoot, origin.url);
    mkdirSync(remotesDir(workspaceRoot), { recursive: true });
    const tmp = `${target}.tmp-999`;
    git(remotesDir(workspaceRoot), ['clone', '-q', '--mirror', origin.url, tmp]);

    expect(promoteMirror(tmp, target)).toBe('created');
    expect(isMirrorReady(target)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test -- mirror`
Expected: FAIL —— `Failed to resolve import "./mirror"`

- [ ] **Step 3: 实现 `mirror.ts` 的存在性部分**

```ts
/**
 * 远端仓库镜像层：把 git 地址物化成工作区根下的**裸镜像**，并把基线解析成具体 hash。
 * 三条口径（spec §5）：
 *   1. 镜像是**缓存**，不是产物：跨用例复用、不随删用例消失、不自动清理；
 *   2. 存在性与更新**分成两个函数**（ensureMirror 不联网、fetchMirror 才联网）——
 *      候选列表要快、校验与评测准备要新鲜，把 fetch 混进 ensure 会让准备路径连着抓两次；
 *   3. 建镜像一律「克隆到 `.tmp-<pid>` → 原子 rename」（RG6）：跨请求并发下不允许出现
 *      被使用的半成品，也不允许一个失败留下让下次 clone 以「目标非空」失败的残留。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ServiceError, normalizeRemoteUrl } from '@aieval/contracts';
import { createLogger } from './logger';
import { execute, gitMessage } from './git-exec';

const log = createLogger('mirror');

/** 工作区根下的镜像父目录（与 cases / {runId} 平级，RG12：不进任何行工作区） */
export function remotesDir(workspaceRoot: string): string {
  return join(workspaceRoot, 'remotes');
}

/**
 * 镜像目录：`{remotesDir}/{slug}-{sha1(归一后 URL).slice(0,8)}`。
 * 身份判据是 hash 段，slug 只为人眼可读（排查时能一眼看出这是哪个仓库）。
 */
export function mirrorDir(workspaceRoot: string, url: string): string {
  const normalized = normalizeRemoteUrl(url);
  const key = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return join(remotesDir(workspaceRoot), `${slugOf(normalized)}-${key}`);
}

/**
 * 就绪判据是**内容**（`HEAD` 是文件且 `objects` 是目录），不是「目录存在」（RG5）。
 * 克隆中途失败会留下一个看似存在的空目录，只看目录存在会让下一轮评测拿它去复制，
 * 把失败点推到 checkout（与 ensureCaseCache 的同一条口径）。
 */
export function isMirrorReady(dir: string): boolean {
  try {
    return statSync(join(dir, 'HEAD')).isFile() && statSync(join(dir, 'objects')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 确保镜像存在：就绪即复用（**不联网**），否则清残留 → 克隆到 tmp → 原子 rename。
 * 失败一律经 classifyRemoteFailure 折成带中文原因的 ServiceError（Task 5 实现）。
 */
export function ensureMirror(input: { workspaceRoot: string; url: string; timeoutMs?: number }): {
  mirrorDir: string;
  created: boolean;
} {
  const dir = mirrorDir(input.workspaceRoot, input.url);
  const parent = remotesDir(input.workspaceRoot);
  mkdirSync(parent, { recursive: true });
  if (isMirrorReady(dir)) return { mirrorDir: dir, created: false };

  // 残留（半成品目录 / 上一次中断的 tmp）先清掉：clone 要求目标不存在
  rmSync(dir, { recursive: true, force: true });
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    execute(parent, ['clone', '--mirror', '--quiet', input.url, tmp], {
      ...remoteOptions(input.timeoutMs),
    });
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw classifyRemoteFailure(error, { url: input.url, what: '克隆远端镜像' });
  }

  const outcome = promoteMirror(tmp, dir);
  log.info('远端镜像已建立', { url: input.url, mirrorDir: dir, outcome });
  return { mirrorDir: dir, created: outcome === 'created' };
}

/**
 * 把克隆好的 tmp 提升为目标目录。
 * **单独导出**只为让「rename 撞车」这条分支可测：它靠两个请求并发才可达，
 * 而在单进程同步 git 调用下测试无法稳定制造那个窗口。
 * 撞车时的处置是复用既有目录（不覆盖、不报错）：另一个请求建的是同一个 URL 的镜像，内容等价。
 */
export function promoteMirror(tmpDir: string, targetDir: string): 'created' | 'reused-existing' {
  try {
    renameSync(tmpDir, targetDir);
    return 'created';
  } catch (error) {
    if (isMirrorReady(targetDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
      return 'reused-existing';
    }
    rmSync(tmpDir, { recursive: true, force: true });
    throw new ServiceError('INTERNAL', `远端镜像改名失败：${tmpDir} → ${targetDir}`, { cause: error });
  }
}

/** URL 末段去 `.git` 作 slug（非 `[A-Za-z0-9._-]` 归一成 `-`，小写，截 40 字符；空则 `repo`） */
function slugOf(url: string): string {
  const path = url.startsWith('file://') ? url.slice('file://'.length) : url;
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'), trimmed.lastIndexOf(':'));
  const segment = (index === -1 ? trimmed : trimmed.slice(index + 1)).replace(/\.git$/, '');
  const slug = segment.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40);
  return slug === '' ? 'repo' : slug;
}
```

> `remoteOptions` / `classifyRemoteFailure` 在 Task 5 落地；本步先把它们写成最小占位实现，让 Task 4 的用例能过：
> **超时只认正数**（Task 3/4 已落地的口径，T5 不得退回 `??`）：
> `function remoteOptions(timeoutMs?: number) { return { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : REMOTE_TRANSFER_TIMEOUT_MS }; }`
> 理由：Node 把 `timeout: 0` 当成「不超时」，`??` 会让调用方传 0 时静默取消 RG3 的墙钟保证。T5 会把这段替换成正式实现（§5.6），**必须保留正数口径**。
> `function classifyRemoteFailure(error: unknown, ctx: { url: string; what: string }): ServiceError { return new ServiceError('NOT_A_GIT_REPO', `${ctx.what}失败：${ctx.url}（${gitMessage(error)}）`, { context: { ...ctx, gitMessage: gitMessage(error) } }); }`
> （Task 5 会把 `classifyRemoteFailure` 换成按 spec §8.1 分类的版本，并补上分类用例。）

- [ ] **Step 4: 导出到 `core/src/index.ts`**

在 `./git` 导出块之后插入：

```ts
export { ensureMirror, isMirrorReady, mirrorDir, remotesDir } from './mirror';
```

（`promoteMirror` **不导出**：它是模块内部步骤，只给测试直接用。）

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test -- mirror`
Expected: PASS（mirrorDir 1 / ensureMirror 4 / promoteMirror 2）

- [ ] **Step 6: 提交**

```bash
git add packages/server/core/src/mirror.ts packages/server/core/src/mirror.test.ts packages/server/core/src/index.ts
git commit -m "feat(core): 远端仓库镜像层（裸镜像 + tmp/原子 rename + 就绪判据）"
```

---

### Task 5: core —— 镜像更新、镜像记录、远端探活与失败分类

**Files:**
- Modify: `packages/server/core/src/mirror.ts`
- Modify: `packages/server/core/src/mirror.test.ts`
- Modify: `packages/server/core/src/index.ts`（导出 `fetchMirror` / `probeRemote` / `readMirrorRecord`）

**Interfaces:**
- Consumes: Task 3 的 `isTimeoutKill`
- Produces:
  - `REMOTE_PROBE_TIMEOUT_MS = 15_000`、`REMOTE_TRANSFER_TIMEOUT_MS = 600_000`
  - `fetchMirror(mirrorDir: string, url: string, options?: { timeoutMs?: number }): { fetchedAt: string }`
  - `readMirrorRecord(mirrorDir: string): { url: string; fetchedAt: string } | null`
  - `probeRemote(url: string, options: { cwd: string; timeoutMs?: number }): { defaultBranch: string; tip: string }`
  - `classifyRemoteFailure(error: unknown, ctx: { url: string; what: string; host?: string; timeoutMs?: number }): ServiceError`

- [ ] **Step 1: 写失败测试**

在 `packages/server/core/src/mirror.test.ts` 追加：

```ts
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fetchMirror, probeRemote, readMirrorRecord } from './mirror';
import { ServiceError } from '@aieval/contracts';

/** 拿一个确定没人监听的端口：先绑定再关掉 */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 把 ServiceError 抓出来断言 code（比 toThrowError 更能钉住归因） */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return '（没有抛错）';
  } catch (error) {
    return error instanceof ServiceError ? error.code : `非 ServiceError：${String(error)}`;
  }
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
    return '（没有抛错）';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('fetchMirror', () => {
  it('增量更新拿到来源的新提交，并写镜像记录（url 原文 + fetchedAt 前进）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    const before = readMirrorRecord(dir);
    expect(before?.url).toBe(origin.url);

    // 来源新增一个提交（直接往裸仓库里推：模拟远端前进）
    const work2 = join(root, 'work2');
    git(root, ['clone', '-q', origin.url, work2]);
    writeFileSync(join(work2, 'b.txt'), 'b\n', 'utf8');
    git(work2, ['add', '.']);
    git(work2, ['commit', '-q', '-m', 'second']);
    const tip = git(work2, ['rev-parse', 'HEAD']).trim();
    git(work2, ['push', '-q', 'origin', 'HEAD:main']);

    const fetched = fetchMirror(dir, origin.url);

    expect(git(dir, ['rev-parse', 'refs/heads/main']).trim()).toBe(tip);
    expect(readMirrorRecord(dir)?.fetchedAt).toBe(fetched.fetchedAt);
    expect(readMirrorRecord(dir)?.fetchedAt).not.toBe(before?.fetchedAt);
  });

  it('来源不可达 → REPO_UNREACHABLE（不是 NOT_A_GIT_REPO）', async () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    renameSync(origin.bareDir, `${origin.bareDir}.moved`);

    expect(codeOf(() => fetchMirror(dir, origin.url))).toBe('REPO_UNREACHABLE');
    await Promise.resolve();
  });

  it('镜像记录缺失或损坏不影响就绪判据（按「没有记录」处理，不重建）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    rmSync(join(dir, 'aieval-mirror.json'), { force: true });
    expect(readMirrorRecord(dir)).toBeNull();
    expect(isMirrorReady(dir)).toBe(true);
    expect(ensureMirror({ workspaceRoot, url: origin.url }).created).toBe(false);

    writeFileSync(join(dir, 'aieval-mirror.json'), '{ 不是 JSON', 'utf8');
    expect(readMirrorRecord(dir)).toBeNull();
    expect(isMirrorReady(dir)).toBe(true);
  });
});

describe('probeRemote', () => {
  it('正常：回默认分支与 40 位 tip', () => {
    const root = makeTmp('aieval-mirror-');
    const origin = makeOriginRepo(root, ['feat/x']);
    const probe = probeRemote(origin.url, { cwd: root });
    expect(probe.defaultBranch).toBe('main');
    expect(probe.tip).toBe(origin.hashes.main);
    expect(probe.tip).toHaveLength(40);
  });

  it('空仓库 → NOT_A_GIT_REPO，文案说明「还没有任何提交」', () => {
    const root = makeTmp('aieval-mirror-');
    const empty = join(root, 'empty.git');
    git(root, ['init', '-q', '--bare', empty]);
    const url = `file:///${empty.replace(/\\/g, '/')}`;
    expect(codeOf(() => probeRemote(url, { cwd: root }))).toBe('NOT_A_GIT_REPO');
    expect(messageOf(() => probeRemote(url, { cwd: root }))).toContain('还没有任何提交');
  });

  it('不存在的路径 → NOT_A_GIT_REPO（远端报 not found）', () => {
    const root = makeTmp('aieval-mirror-');
    const url = `file:///${join(root, 'nope.git').replace(/\\/g, '/')}`;
    expect(codeOf(() => probeRemote(url, { cwd: root }))).toBe('NOT_A_GIT_REPO');
  });

  it('没人监听的端口 → REPO_UNREACHABLE', async () => {
    const root = makeTmp('aieval-mirror-');
    const port = await unusedPort();
    expect(codeOf(() => probeRemote(`http://127.0.0.1:${port}/x.git`, { cwd: root }))).toBe('REPO_UNREACHABLE');
  });

  it('超时被杀 → REPO_UNREACHABLE 且文案含「超时」（不是 NOT_A_GIT_REPO）', async () => {
    const root = makeTmp('aieval-mirror-');
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/x.git`;
    // 1ms 上限：git 来不及连上就被杀，与机器快慢、网络环境无关
    expect(codeOf(() => probeRemote(url, { cwd: root, timeoutMs: 1 }))).toBe('REPO_UNREACHABLE');
    expect(messageOf(() => probeRemote(url, { cwd: root, timeoutMs: 1 }))).toContain('超时');
  });
});
```

> `readFileSync` 这行 import 若在追加后未被使用，就删掉（lint 的 no-unused-vars 会红）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test -- mirror`
Expected: FAIL —— `fetchMirror` / `probeRemote` / `readMirrorRecord` 未导出；不可达被归成 `NOT_A_GIT_REPO`

- [ ] **Step 3: 实现（替换 Task 4 的占位实现）**

在 `mirror.ts` 里加常量、记录读写、`fetchMirror`、`probeRemote`、`classifyRemoteFailure`，并把 Task 4 的占位 `remoteOptions` / `classifyRemoteFailure` 换成下面的版本：

```ts
/** 探活（ls-remote）的墙钟上限：它只是「能不能连上」的快路径，不该让人等 */
export const REMOTE_PROBE_TIMEOUT_MS = 15_000;
/** 克隆 / 抓取的墙钟上限：大仓库首次克隆的真实代价，超时后给可处置的错误而不是冻住服务 */
export const REMOTE_TRANSFER_TIMEOUT_MS = 600_000;

/** 远端调用的环境与超时：禁交互式提示（RG3），SSH 非交互（RG4，不覆盖用户自己的 GIT_SSH_COMMAND） */
function remoteOptions(timeoutMs?: number): { env: Record<string, string>; timeoutMs: number } {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (process.env.GIT_SSH_COMMAND === undefined) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return { env, timeoutMs: timeoutMs ?? REMOTE_TRANSFER_TIMEOUT_MS };
}

/** 镜像记录的落点：镜像仓库根下（它是裸仓库，多一个文件不影响任何 git 操作） */
function mirrorRecordFile(mirrorDir: string): string {
  return join(mirrorDir, 'aieval-mirror.json');
}

/**
 * 读镜像记录。**不参与就绪判据**（判据见 isMirrorReady）：缺失 / 不可解析一律按「没有记录」处理，
 * 由调用方决定要不要重建——记录坏掉不该让一份完好的镜像不可用。
 */
export function readMirrorRecord(mirrorDir: string): { url: string; fetchedAt: string } | null {
  const file = mirrorRecordFile(mirrorDir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { url, fetchedAt } = parsed as { url?: unknown; fetchedAt?: unknown };
    if (typeof url !== 'string' || url === '' || typeof fetchedAt !== 'string') return null;
    return { url, fetchedAt };
  } catch (error) {
    log.warn('镜像记录不可解析，按「没有记录」处理', { file, error });
    return null;
  }
}

/** 写镜像记录；失败只 WARN——记录写不进去的后果只是「回显少一行更新于」，不该让本次操作失败 */
function writeMirrorRecord(mirrorDir: string, record: { url: string; fetchedAt: string }): void {
  try {
    writeFileSync(mirrorRecordFile(mirrorDir), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    log.warn('写入镜像记录失败（回显里会少一行更新时间）', { mirrorDir, error });
  }
}

/**
 * 更新镜像：`git fetch --prune`（`--mirror` 克隆的 config 里 `remote.origin.mirror=true`，
 * 普通 fetch 即镜像语义的全 refs 同步）。失败**不吞**：调用方必须知道自己读的是不是最新的。
 */
export function fetchMirror(mirrorDir: string, url: string, options: { timeoutMs?: number } = {}): { fetchedAt: string } {
  try {
    execute(mirrorDir, ['fetch', '--prune', 'origin'], remoteOptions(options.timeoutMs));
  } catch (error) {
    throw classifyRemoteFailure(error, {
      url,
      what: '更新远端镜像',
      timeoutMs: options.timeoutMs ?? REMOTE_TRANSFER_TIMEOUT_MS,
    });
  }
  const fetchedAt = new Date().toISOString();
  writeMirrorRecord(mirrorDir, { url: normalizeRemoteUrl(url), fetchedAt });
  log.info('远端镜像已更新', { url, mirrorDir, fetchedAt });
  return { fetchedAt };
}

/**
 * 探活（不克隆）：`git ls-remote --symref <url> HEAD` → 默认分支名 + tip。
 * `cwd` 由调用方显式给（api 传 `{workspaceRoot}/remotes`）：刻意不回落 `process.cwd()`，
 * 那会把「服务进程恰好在一个仓库目录里」变成隐式输入。
 */
export function probeRemote(url: string, options: { cwd: string; timeoutMs?: number }): { defaultBranch: string; tip: string } {
  const timeoutMs = options.timeoutMs ?? REMOTE_PROBE_TIMEOUT_MS;
  let output: string;
  try {
    output = execute(options.cwd, ['ls-remote', '--symref', url, 'HEAD'], remoteOptions(timeoutMs));
  } catch (error) {
    throw classifyRemoteFailure(error, { url, what: '读取远端仓库', timeoutMs });
  }

  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const symrefLine = lines.find((line) => line.startsWith('ref:'));
  const headLine = lines.find((line) => !line.startsWith('ref:') && line.endsWith('HEAD'));
  const tip = (headLine ?? '').split('\t')[0] ?? '';
  if (tip === '') {
    throw new ServiceError('NOT_A_GIT_REPO', `远端仓库还没有任何提交：${url}`);
  }
  const defaultBranch = (symrefLine ?? '').split('\t')[0]?.replace('ref: refs/heads/', '') ?? '';
  return { defaultBranch, tip };
}

/**
 * 远端失败的分类（spec §8.1 / §8.2）。三件事按序判：
 *   ① 超时（靠信号判定，不靠关键词——远端自己报的 timeout 原文长得很像）；
 *   ② 关键词表：认证 / DNS / 不可达 / 主机指纹 / 不存在；
 *   ③ 其余归成 NOT_A_GIT_REPO 并把原文带上（中文原因在前，git 原文在后，RG11）。
 */
export function classifyRemoteFailure(
  error: unknown,
  ctx: { url: string; what: string; host?: string; timeoutMs?: number },
): ServiceError {
  const detail = gitMessage(error);
  const host = ctx.host ?? hostOfUrl(ctx.url);

  if (isTimeoutKill(error)) {
    const minutes = Math.round((ctx.timeoutMs ?? REMOTE_TRANSFER_TIMEOUT_MS) / 60_000);
    return new ServiceError('REPO_UNREACHABLE', `远端仓库拉取超时（超过 ${minutes} 分钟）：${ctx.url}（已终止 git 进程）`, {
      context: { ...ctx, gitMessage: detail },
    });
  }
  if (AUTH_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new ServiceError(
      'AUTH_FAILED',
      `远端仓库认证失败：${host}（请确认本机 SSH key 已加入 ssh-agent，或 HTTPS 凭据助手可用）`,
      { context: { ...ctx, host, gitMessage: detail } },
    );
  }
  if (detail.includes('Could not resolve host')) {
    return new ServiceError('REPO_UNREACHABLE', `无法解析远端主机：${host}（${detail}）`, {
      context: { ...ctx, host, gitMessage: detail },
    });
  }
  if (UNREACHABLE_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new ServiceError('REPO_UNREACHABLE', `无法连接远端仓库：${host}（${detail}）`, {
      context: { ...ctx, host, gitMessage: detail },
    });
  }
  if (detail.includes('Host key verification failed')) {
    return new ServiceError(
      'REPO_UNREACHABLE',
      `SSH 主机指纹未信任：${host}（请先在本机手工 git clone 一次以确认指纹）`,
      { context: { ...ctx, host, gitMessage: detail } },
    );
  }
  if (NOT_FOUND_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new ServiceError(
      'NOT_A_GIT_REPO',
      `远端仓库不存在或无权访问：${ctx.url}（${detail}；私有仓库在凭据不可用时也会这样报）`,
      { context: { ...ctx, gitMessage: detail } },
    );
  }
  return new ServiceError('NOT_A_GIT_REPO', `无法读取远端仓库：${ctx.url}（${detail}）`, {
    context: { ...ctx, gitMessage: detail },
  });
}

/** 认证类原文（顺序无关，命中即认证失败） */
const AUTH_PATTERNS = [
  'Permission denied (publickey',
  'Authentication failed',
  'could not read Username',
  'HTTP Basic: Access denied',
  'terminal prompts disabled',
];
/** 网络类原文 */
const UNREACHABLE_PATTERNS = ['Connection timed out', 'Connection refused', 'Network is unreachable', 'Operation timed out'];
/** 远端不存在 / 不是仓库 */
const NOT_FOUND_PATTERNS = ['not found', 'does not appear to be a git repository', 'Repository not found'];

/** 从来源串里取主机名（分类文案要用；scp 形态取冒号前那段） */
function hostOfUrl(url: string): string {
  if (url.startsWith('file://')) return 'localhost';
  try {
    return new URL(url).hostname;
  } catch {
    const scp = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]{2,}):/.exec(url);
    return scp?.[2] ?? url;
  }
}
```

同时把文件头的 import 补齐：`readFileSync` / `writeFileSync`（`node:fs`）、`isTimeoutKill`（`./git-exec`）。

- [ ] **Step 4: 更新导出**

`core/src/index.ts` 的 mirror 导出行改为：

```ts
export {
  REMOTE_PROBE_TIMEOUT_MS,
  REMOTE_TRANSFER_TIMEOUT_MS,
  ensureMirror,
  fetchMirror,
  isMirrorReady,
  mirrorDir,
  probeRemote,
  readMirrorRecord,
  remotesDir,
} from './mirror';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test -- mirror`
Expected: PASS（含超时映射与四类 probe 失败）

- [ ] **Step 6: 提交**

```bash
git add packages/server/core/src/mirror.ts packages/server/core/src/mirror.test.ts packages/server/core/src/index.ts
git commit -m "feat(core): 镜像增量更新、镜像记录、远端探活与失败分类（含超时映射）"
```

---

### Task 6: core —— 基线解析 `resolveRemoteRef`

**Files:**
- Modify: `packages/server/core/src/mirror.ts`
- Modify: `packages/server/core/src/mirror.test.ts`
- Modify: `packages/server/core/src/index.ts`

**Interfaces:**
- Produces:
  - `defaultBranchName(mirrorDir: string): string`（读镜像 HEAD；解析不出 → `NOT_A_GIT_REPO`）
  - `resolveRemoteRef(mirrorDir: string, url: string, input: { branch: string | null; commitHash: string | null; fetch?: boolean; timeoutMs?: number }): string` → 40 位 hash

- [ ] **Step 1: 写失败测试**

在 `mirror.test.ts` 追加：

```ts
import { defaultBranchName, resolveRemoteRef } from './mirror';

describe('resolveRemoteRef', () => {
  it('三条路都回 40 位具体 hash：指定分支 / 默认分支 / 指定 commit', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root, ['feat/x']);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null })).toBe(origin.hashes.main);
    expect(resolveRemoteRef(dir, origin.url, { branch: 'feat/x', commitHash: null })).toBe(origin.hashes['feat/x']);
    // commit 优先于分支
    expect(resolveRemoteRef(dir, origin.url, { branch: 'feat/x', commitHash: origin.hashes.main })).toBe(origin.hashes.main);
    expect(defaultBranchName(dir)).toBe('main');
  });

  it('默认分支跟随远端前进（fetch 后重新解析到新 tip）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    const work2 = join(root, 'work2');
    git(root, ['clone', '-q', origin.url, work2]);
    writeFileSync(join(work2, 'b.txt'), 'b\n', 'utf8');
    git(work2, ['add', '.']);
    git(work2, ['commit', '-q', '-m', 'second']);
    const tip = git(work2, ['rev-parse', 'HEAD']).trim();
    git(work2, ['push', '-q', 'origin', 'HEAD:main']);

    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null })).toBe(tip);
    // fetch:false（候选列表那条路）读到的是镜像里的旧值——这正是「候选不联网」的语义
    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null, fetch: false })).toBe(origin.hashes.main);
  });

  it('分支不存在 → INVALID_REF，文案点名分支与远端', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: 'feat/nope', commitHash: null }))).toBe('INVALID_REF');
    const message = messageOf(() => resolveRemoteRef(dir, origin.url, { branch: 'feat/nope', commitHash: null }));
    expect(message).toContain('feat/nope');
    expect(message).toContain(origin.url);
  });

  it('commit 不存在（fetch 后仍无）→ INVALID_REF，文案说明已 fetch', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    const orphan = '0'.repeat(40);

    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: null, commitHash: orphan }))).toBe('INVALID_REF');
    expect(messageOf(() => resolveRemoteRef(dir, origin.url, { branch: null, commitHash: orphan }))).toContain('git fetch');
  });

  it('钉死的 commit 已在镜像里 → 不联网（把来源移走也能解析出基线）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    renameSync(origin.bareDir, `${origin.bareDir}.moved`);

    // 与 ensureCaseCache「缓存里有就不 fetch」同口径：已经能确定起点的一轮不该因为远端临时不可达而失败
    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: origin.hashes.main })).toBe(origin.hashes.main);
    // 但「跟随分支 / 默认分支」要求新鲜度，来源不可达时必须抛（RG10：绝不静默沿用旧镜像）
    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null }))).toBe('REPO_UNREACHABLE');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test -- mirror`
Expected: FAIL —— `resolveRemoteRef` / `defaultBranchName` 未导出

- [ ] **Step 3: 实现**

在 `mirror.ts` 追加：

```ts
/** 镜像的默认分支名：`--mirror` 克隆时镜像的 HEAD 就是远端的 HEAD；两条读法都失败 → NOT_A_GIT_REPO */
export function defaultBranchName(mirrorDir: string): string {
  try {
    const name = execute(mirrorDir, ['symbolic-ref', '--short', 'HEAD']).trim();
    if (name !== '') return name;
  } catch {
    // 退回 --abbrev-ref（symbolic-ref 在个别 git 版本上对裸仓库的行为不一致）
  }
  try {
    const name = execute(mirrorDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (name !== '' && name !== 'HEAD') return name;
  } catch {
    // 落到下面的统一报错
  }
  throw new ServiceError('NOT_A_GIT_REPO', `无法确定远端默认分支：${mirrorDir}`);
}

/**
 * 把「来源 + 分支 + commit」解析成 40 位具体 hash（spec §6.7 的规则表）。
 * 抓取时机是**按需**的（不是无脑先 fetch），三条路各有各的理由：
 *   · 钉死的 commit 已在镜像里 → 不联网：已经能确定起点的一轮不该因为远端临时不可达而失败
 *     （与 ensureCaseCache「缓存里有就不 fetch」同一条口径）；
 *   · 钉死的 commit 不在镜像里 → 只抓一次再判，仍没有才 INVALID_REF；
 *   · 分支 / 默认分支 → 跟随语义要求新鲜度，先 fetch（`fetch: false` 是候选列表的「不联网」语义）。
 * 默认分支这条路本身**不联网**：镜像的 HEAD 已经是远端的事实，再连一次只会白花一次握手。
 */
export function resolveRemoteRef(
  mirrorDir: string,
  url: string,
  input: { branch: string | null; commitHash: string | null; fetch?: boolean; timeoutMs?: number },
): string {
  const commit = input.commitHash?.trim() ?? '';
  if (commit !== '') {
    if (hasCommitInMirror(mirrorDir, commit)) return revisionOf(mirrorDir, commit);
    fetchMirror(mirrorDir, url, { timeoutMs: input.timeoutMs });
    if (hasCommitInMirror(mirrorDir, commit)) return revisionOf(mirrorDir, commit);
    throw new ServiceError(
      'INVALID_REF',
      `commit 不存在：${commit}（远端：${url}，已在镜像中执行 git fetch，仍找不到该 commit）`,
      { context: { mirrorDir, url, commit } },
    );
  }

  if (input.fetch !== false) fetchMirror(mirrorDir, url, { timeoutMs: input.timeoutMs });

  const branch = input.branch?.trim() ?? '';
  if (branch !== '') {
    try {
      return execute(mirrorDir, ['rev-parse', `refs/heads/${branch}^{commit}`]).trim();
    } catch (error) {
      throw new ServiceError('INVALID_REF', `分支不存在：${branch}（远端：${url}）`, {
        context: { mirrorDir, url, branch, gitMessage: gitMessage(error) },
      });
    }
  }

  const name = defaultBranchName(mirrorDir);
  try {
    return execute(mirrorDir, ['rev-parse', `refs/heads/${name}^{commit}`]).trim();
  } catch (error) {
    throw new ServiceError('NOT_A_GIT_REPO', `无法解析远端默认分支：${name}（远端：${url}）`, {
      context: { mirrorDir, url, name, gitMessage: gitMessage(error) },
    });
  }
}

/** 某个 commit 在不在镜像里（`^{commit}` 与 assertCommit 同一口径：blob / tree 不算） */
function hasCommitInMirror(mirrorDir: string, commit: string): boolean {
  try {
    execute(mirrorDir, ['cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** 把任意可解析写法归一成 40 位 hash */
function revisionOf(mirrorDir: string, commit: string): string {
  return execute(mirrorDir, ['rev-parse', `${commit}^{commit}`]).trim();
}
```

- [ ] **Step 4: 更新导出**

`core/src/index.ts` 的 mirror 导出块补 `defaultBranchName` 与 `resolveRemoteRef`。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test -- mirror` → PASS
Run: `pnpm --filter @aieval/core test` → PASS（既有用例不受影响）

- [ ] **Step 6: 提交**

```bash
git add packages/server/core/src/mirror.ts packages/server/core/src/mirror.test.ts packages/server/core/src/index.ts
git commit -m "feat(core): 远端基线解析（分支 tip / 默认分支 / 钉死 commit）"
```

---

### Task 7: api —— 远端校验（`validateRepo` + 校验路由）

**Files:**
- Modify: `packages/server/api/src/cases.ts`（`validateRepo` 换成带来源与分支的版本 + 两个私有 helper）
- Modify: `apps/web-next/app/api/cases/validate-repo/route.ts`（入参换 `RepoValidateInputSchema`）
- Test: `packages/server/api/src/cases.test.ts`
- Test（路由层，若既有断言覆盖了请求体形状）: `apps/web-next/src/route-cases.test.ts`

**Interfaces:**
- Consumes: `parseRepoSource`、`RepoValidateInputSchema`（Task 1/2）、`probeRemote` / `ensureMirror` / `fetchMirror` / `resolveRemoteRef` / `defaultBranchName` / `remotesDir`（Task 4–6）、`getSettings`（已有）
- Produces（api 内部共用，Task 8/9 也用它）:
  - `validateRepo(input: { repoPath: string; repoBranch: string | null }): RepoInfo`
  - `normalizeBranch(repoBranch: string | null | undefined): string | null`

- [ ] **Step 1: 写失败测试**

在 `packages/server/api/src/cases.test.ts` 追加（放在仓库夹具区，与 `makeRepo` 并列）：

```ts
/**
 * 把本地仓库变成「远端」：裸克隆一份并回 `file://` URL。
 * 用 file:// 而不是真网络：远端链路的每条分支（镜像、探活、超时、失败分类）都要能离线跑到。
 */
function makeRemoteOrigin(name: string, branches: string[] = ['main']): { url: string; hashes: Record<string, string> } {
  const work = makeRepo(`${name}-work`, 1);
  git(['branch', '-M', 'main'], work.dir);
  const hashes: Record<string, string> = { main: work.hashes[0]! };
  for (const branch of branches.filter((item) => item !== 'main')) {
    git(['checkout', '-q', '-b', branch], work.dir);
    writeFileSync(join(work.dir, `${branch.replace(/\//g, '-')}.txt`), `${branch}\n`, 'utf8');
    git(['add', '.'], work.dir);
    git(['commit', '-q', '-m', `${branch} 的提交`], work.dir);
    hashes[branch] = git(['rev-parse', 'HEAD'], work.dir).trim();
  }
  git(['checkout', '-q', 'main'], work.dir);
  const bare = join(dir, `${name}.git`);
  git(['clone', '-q', '--bare', work.dir, bare], dir);
  return { url: `file:///${bare.replace(/\\/g, '/')}`, hashes };
}

describe('validateRepo（远端来源）', () => {
  it('回显远端三件套：仓库名 / 分支 / tip / 镜像路径与更新时间，并把镜像建在工作区根下', () => {
    const origin = makeRemoteOrigin('remote-validate');
    const info = validateRepo({ repoPath: origin.url, repoBranch: null });

    expect(info).toMatchObject({
      repoPath: origin.url,
      repoName: 'remote-validate',
      branch: 'main',
      kind: 'remote',
      mirrorReady: true,
      tip: origin.hashes.main!.slice(0, 7),
    });
    expect(info.mirrorPath).toBe(join(ws, 'remotes', `remote-validate-${info.mirrorPath!.split('-').at(-1)}`));
    expect(info.mirrorFetchedAt).not.toBeNull();
    expect(existsSync(join(info.mirrorPath!, 'HEAD'))).toBe(true);
  });

  it('填了分支：回显该分支与它的 tip（分支不存在 → INVALID_REF）', () => {
    const origin = makeRemoteOrigin('remote-branch', ['feat/x']);
    expect(validateRepo({ repoPath: origin.url, repoBranch: 'feat/x' })).toMatchObject({
      branch: 'feat/x',
      tip: origin.hashes['feat/x']!.slice(0, 7),
    });
    expect(() => validateRepo({ repoPath: origin.url, repoBranch: 'feat/nope' })).toThrow(/分支不存在/);
  });

  it('URL 填进「本地路径」的位置也按形态判定成远端（界面的态不影响服务端判定）', () => {
    const origin = makeRemoteOrigin('remote-shape');
    expect(validateRepo({ repoPath: origin.url, repoBranch: null }).kind).toBe('remote');
  });

  it('本地来源仍然照旧：kind=local、mirrorPath=null、tip=null，且填分支被拒', () => {
    expect(validateRepo({ repoPath: repo, repoBranch: null })).toMatchObject({
      kind: 'local',
      mirrorPath: null,
      mirrorFetchedAt: null,
      tip: null,
    });
    expect(() => validateRepo({ repoPath: repo, repoBranch: 'main' })).toThrow(/不支持分支/);
  });

  it('不支持的协议在 api 层就拦下（INVALID_QUERY）', () => {
    expect(() => validateRepo({ repoPath: 'ftp://host/x.git', repoBranch: null })).toThrow(/不支持的 git 地址协议/);
  });
});
```

（`ws` / `dir` / `repo` / `git` / `makeRepo` 都是该文件既有的 beforeEach 产物与 helper；`existsSync` 已在文件顶部 import。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/api test -- cases`
Expected: FAIL —— `validateRepo` 目前只接受一个字符串参数 / 返回对象没有 `kind`

- [ ] **Step 3: 实现 api 侧**

`packages/server/api/src/cases.ts`：import 区补上 `mkdirSync`（`node:fs`）与 core 的新函数：

```ts
import {
  assertCommit,
  caseCacheDir,
  createLogger,
  defaultBranchName,
  ensureMirror,
  fetchMirror,
  getConfigDir,
  listCommits,
  loadConfig,
  probeRemote,
  remotesDir,
  resolveRemoteRef,
  resolveRepoInfo,
  saveConfig,
} from '@aieval/core';
import { parseRepoSource, type RepoSource } from '@aieval/contracts';
```

替换 `validateRepo`：

```ts
/**
 * 仓库校验：本地走既有 git 口径；远端先快探活、再确保镜像并增量更新，最后解析要用的分支（spec §6.1）。
 * 顺序有意如此：探活（15s 上限）先把「不可达 / 认证失败 / 不存在 / 空仓库」分开，
 * 再让用户为一次真实克隆等待——两者失败时的处置完全不同。
 */
export function validateRepo(input: { repoPath: string; repoBranch: string | null }): RepoInfo {
  const source = parseRepoSource(input.repoPath);
  const branch = normalizeBranch(input.repoBranch);
  if (source.kind === 'local') {
    // 本地来源的分支一律拒绝（不静默忽略）：用户以为生效了才是最坏的（RG9）
    if (branch !== null) throw new ServiceError('INVALID_QUERY', `本地目录来源不支持分支：${source.path}`);
    return resolveRepoInfo(source.path);
  }

  const workspaceRoot = getSettings().workspaceRoot;
  const cwd = remotesDir(workspaceRoot);
  mkdirSync(cwd, { recursive: true });

  probeRemote(source.url, { cwd });
  const { mirrorDir } = ensureMirror({ workspaceRoot, url: source.url });
  const { fetchedAt } = fetchMirror(mirrorDir, source.url);
  // 镜像刚更新过，这里不再联网；分支不存在在 resolveRemoteRef 里被拦成 INVALID_REF
  const tip = resolveRemoteRef(mirrorDir, source.url, { branch, commitHash: null, fetch: false });
  const resolvedBranch = branch ?? defaultBranchName(mirrorDir);

  log.info('远端仓库校验通过', { url: source.url, branch: resolvedBranch, mirrorDir });
  return {
    repoPath: source.url,
    repoName: source.repoName,
    branch: resolvedBranch,
    kind: 'remote',
    mirrorPath: mirrorDir,
    mirrorReady: true,
    mirrorFetchedAt: fetchedAt,
    tip: tip.slice(0, 7),
  };
}

/** 分支归一：null / undefined / 空串（表单清空拿到的是空串）都表示「不指定分支」 */
export function normalizeBranch(repoBranch: string | null | undefined): string | null {
  if (repoBranch === null || repoBranch === undefined) return null;
  const trimmed = repoBranch.trim();
  return trimmed === '' ? null : trimmed;
}

/** 确保远端镜像存在（不存在才克隆），回镜像路径。三个消费方（校验 / 候选 / 保存）共用一处口径 */
function ensureRemoteMirror(url: string): string {
  return ensureMirror({ workspaceRoot: getSettings().workspaceRoot, url }).mirrorDir;
}
```

`apps/web-next/app/api/cases/validate-repo/route.ts`：

```ts
import { validateRepo } from '@aieval/api';
import { RepoValidateInputSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const { repoPath, repoBranch } = RepoValidateInputSchema.parse(await readJsonBody(req));
    return Response.json(validateRepo({ repoPath, repoBranch }));
  } catch (error) {
    return handleApiError(error);
  }
}
```
（文件头注释补一句：入参带可选分支，远端才有意义。）

- [ ] **Step 4: 路由层断言同步**

Run: `grep -n "validate-repo" apps/web-next/src/route-cases.test.ts`
若该文件断言了请求体或调用了被 mock 的 `validateRepo`，把调用形状同步成 `{ repoPath, repoBranch }`（`vi.mock` 的替身签名要与真实签名一致，否则测试会以「类型对不上」或「mock 不生效」的形式骗人）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/api test -- cases` → PASS
Run: `pnpm --filter @aieval/web-next test -- route-cases` → PASS
Run: `pnpm typecheck` → 0 error

- [ ] **Step 6: 提交**

```bash
git add packages/server/api/src/cases.ts packages/server/api/src/cases.test.ts apps/web-next/app/api/cases/validate-repo/route.ts apps/web-next/src/route-cases.test.ts
git commit -m "feat(api): 远端仓库校验（探活 + 镜像更新 + 分支回显）"
```

---

### Task 8: api —— 远端 commit 候选（`listCommitCandidates` + 候选路由）

**Files:**
- Modify: `packages/server/api/src/cases.ts`（`listCommitCandidates`）
- Modify: `apps/web-next/app/api/cases/commits/route.ts`（入参换 `RepoCommitsInputSchema`）
- Test: `packages/server/api/src/cases.test.ts`

**Interfaces:**
- Consumes: `listCommits(repoPath, limit, ref)`（Task 2）、`ensureRemoteMirror` / `normalizeBranch`（Task 7）
- Produces: `listCommitCandidates(input: { repoPath: string; repoBranch: string | null }): CommitCandidate[]`

- [ ] **Step 1: 写失败测试**

```ts
describe('listCommitCandidates（远端来源）', () => {
  it('候选来自镜像：来源被移走后仍列得出来（证明这一步不联网）', () => {
    const origin = makeRemoteOrigin('remote-candidates');
    const expected = listCommitCandidates({ repoPath: origin.url, repoBranch: null });
    expect(expected.length).toBeGreaterThan(0);
    expect(expected[0]?.subject).toBe('第 1 次提交');

    // 把「远端」整体改名：任何联网行为都会在这里失败
    renameSync(join(dir, 'remote-candidates.git'), join(dir, 'remote-candidates.git.moved'));
    expect(listCommitCandidates({ repoPath: origin.url, repoBranch: null })).toEqual(expected);
  });

  it('填了分支：候选是该分支的历史；分支不存在 → INVALID_REF', () => {
    const origin = makeRemoteOrigin('remote-candidates-branch', ['feat/x']);
    const commits = listCommitCandidates({ repoPath: origin.url, repoBranch: 'feat/x' });
    expect(commits[0]?.hash).toBe(origin.hashes['feat/x']!.slice(0, 7));
    expect(() => listCommitCandidates({ repoPath: origin.url, repoBranch: 'feat/nope' })).toThrow(/分支不存在/);
  });

  it('本地来源照旧（不传分支读 HEAD；传分支被拒）', () => {
    const local = makeRepo('local-candidates', 2);
    expect(listCommitCandidates({ repoPath: local.dir, repoBranch: null }).length).toBe(2);
    expect(() => listCommitCandidates({ repoPath: local.dir, repoBranch: 'main' })).toThrow(/不支持分支/);
  });
});
```

（`renameSync` 记得加进该文件的 `node:fs` import。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/api test -- cases`
Expected: FAIL —— 现有签名只接受字符串

- [ ] **Step 3: 实现**

```ts
/**
 * commit 候选（spec §6.2）：本地照旧；远端从**镜像**读（不联网——镜像在校验时已更新）。
 * 「候选只是便利、手工输入任意合法 hash 仍可行」这条口径不变。
 */
export function listCommitCandidates(input: { repoPath: string; repoBranch: string | null }): CommitCandidate[] {
  const source = parseRepoSource(input.repoPath);
  const branch = normalizeBranch(input.repoBranch);
  if (source.kind === 'local') {
    if (branch !== null) throw new ServiceError('INVALID_QUERY', `本地目录来源不支持分支：${source.path}`);
    return listCommits(source.path);
  }
  const mirrorDir = ensureRemoteMirror(source.url);
  const tip = resolveRemoteRef(mirrorDir, source.url, { branch, commitHash: null, fetch: false });
  return listCommits(mirrorDir, 20, tip);
}
```

`apps/web-next/app/api/cases/commits/route.ts` 同样换成 `RepoCommitsInputSchema.parse(...)` 并传 `{ repoPath, repoBranch }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/api test -- cases` → PASS
Run: `pnpm typecheck` → 0 error

- [ ] **Step 5: 提交**

```bash
git add packages/server/api/src/cases.ts packages/server/api/src/cases.test.ts apps/web-next/app/api/cases/commits/route.ts
git commit -m "feat(api): 远端 commit 候选从镜像读取（不联网）"
```

---

### Task 9: api —— 保存侧判定（`createCase` / `updateCase` / 评分提示词的仓库名）

**Files:**
- Modify: `packages/server/api/src/cases.ts`
- Modify: `packages/server/api/src/judge.ts`
- Test: `packages/server/api/src/cases.test.ts`、`packages/server/api/src/judge.test.ts`

**Interfaces:**
- Consumes: Task 7/8 的 helper、`assertCommit`（core）、`fetchMirror`（core）
- Produces:
  - `createCase` / `updateCase` 落盘 `repoPath`（归一侧）与 `repoBranch`
  - 私有 `resolveCaseSource(repoPath, repoBranch)`、`resolveCommitInput(source, commitHash)`

- [ ] **Step 1: 写失败测试**

```ts
describe('用例保存（远端来源）', () => {
  it('远端用例落盘 URL 原文与归一后的分支；commit 留空即 null', () => {
    const origin = makeRemoteOrigin('remote-save', ['feat/x']);
    const created = createCase(caseInput({ repoPath: `  ${origin.url}/  `, repoBranch: ' feat/x ' }));

    expect(created.repoPath).toBe(origin.url);
    expect(created.repoBranch).toBe('feat/x');
    expect(loadConfig().cases.find((item) => item.id === created.id)).toMatchObject({
      repoPath: origin.url,
      repoBranch: 'feat/x',
    });
  });

  it('坏值不在写入口放行：分支不存在 / commit 不存在都拒绝且不落盘', () => {
    const origin = makeRemoteOrigin('remote-save-bad');
    expect(() => createCase(caseInput({ repoPath: origin.url, repoBranch: 'feat/nope' }))).toThrow(/分支不存在/);
    expect(() => createCase(caseInput({ repoPath: origin.url, commitHash: '0'.repeat(40) }))).toThrow(/commit 不存在/);
    expect(loadConfig().cases).toHaveLength(0);
  });

  it('远端刚推上来的分支仍能保存（判不过时只 fetch 一次再判）', () => {
    const origin = makeRemoteOrigin('remote-save-fresh');
    // 先建用例把镜像建出来，再在「远端」新增分支——镜像里此刻还没有它
    createCase(caseInput({ repoPath: origin.url }));
    const work = join(dir, 'fresh-work');
    git(['clone', '-q', origin.url, work], dir);
    git(['checkout', '-q', '-b', 'feat/fresh'], work);
    writeFileSync(join(work, 'fresh.txt'), 'fresh\n', 'utf8');
    git(['add', '.'], work);
    git(['commit', '-q', '-m', 'fresh']);
    git(['push', '-q', 'origin', 'HEAD:feat/fresh'], work);

    const created = createCase(caseInput({ repoPath: origin.url, repoBranch: 'feat/fresh' }));
    expect(created.repoBranch).toBe('feat/fresh');
  });

  it('本地来源填分支 → INVALID_QUERY（按值判，不受全量补丁影响）', () => {
    const created = createCase(caseInput({ repoPath: repo }));
    expect(() => updateCase(created.id, { repoBranch: 'main' })).toThrow(/不支持分支/);
    // 值没变的「假改动」不该被拦（UI 发出来的补丁永远是全量的）
    expect(() => updateCase(created.id, { repoPath: repo, repoBranch: null })).not.toThrow();
  });

  it('删除用例只清用例缓存，不动镜像（镜像是跨用例复用的缓存，spec §6.3 / D11）', () => {
    const origin = makeRemoteOrigin('remote-delete');
    const created = createCase(caseInput({ repoPath: origin.url }));
    expect(readdirSync(join(ws, 'remotes'))).toHaveLength(1);

    deleteCase(created.id);

    expect(existsSync(join(ws, 'cases', created.id))).toBe(false);
    expect(readdirSync(join(ws, 'remotes'))).toHaveLength(1);
  });
});
```

（`readdirSync` 记得加进该文件的 `node:fs` import。）

在 `judge.test.ts` 追加（用该文件既有的 `configureGlobalJudge` / `modelReplies` / `generateInput` 三个 helper，不真发 HTTP）：

```ts
it('远端来源的仓库名取 URL 末段（不联网、不需要镜像）', async () => {
  configureGlobalJudge();
  modelReplies(
    JSON.stringify({
      prompt: '评分提示词正文',
      dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'],
    }),
  );

  await generateJudgePrompt(generateInput({ repoPath: 'git@coding.jd.com:FlowAI/rbac-server.git' }));

  const [, request] = vi.mocked(callTextApi).mock.calls[0]!;
  expect(request.prompt).toContain('rbac-server');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/api test -- cases judge`
Expected: FAIL —— 远端分支未实现 / `resolveCommitInput` 仍是单参数

- [ ] **Step 3: 实现保存侧**

`createCase` 改为（其余字段不动）：

```ts
export function createCase(input: CaseCreate): TestCase {
  const resolved = resolveCaseSource(input.repoPath, input.repoBranch);
  const now = new Date().toISOString();
  const created: TestCase = {
    id: randomUUID(),
    title: input.title.trim(),
    repoPath: resolved.repoPath,
    commitHash: resolveCommitInput(resolved.source, input.commitHash),
    repoBranch: resolved.repoBranch,
    taskPrompt: input.taskPrompt,
    judgePrompt: input.judgePrompt,
    judgeProviderId: input.judgeProviderId ?? null,
    judgeModelId: input.judgeModelId ?? null,
    createdAt: now,
    updatedAt: now,
  };
（`createCase` 里 `assertJudgePair` → `assertStorable` → 推入 `config.cases` → `saveCases` → 成功日志这一段**逐字不动**，只把构造 `created` 时用的 `repoPath` / `commitHash` 换成上面的 `resolved` / `resolveCommitInput(resolved.source, …)`，并新增 `repoBranch: resolved.repoBranch`。）
}
```

`updateCase` 的仓库 / 分支判定段替换为：

```ts
  // 来源与分支都按**值**判「这次到底改没改」（UI 发出来的补丁永远是全量的，口径同 F1）
  const nextRepoPath = patch.repoPath === undefined ? current.repoPath : normalizeSourceString(patch.repoPath);
  const repoChanged = nextRepoPath !== current.repoPath;
  const nextBranch = patch.repoBranch === undefined ? current.repoBranch : normalizeBranch(patch.repoBranch);
  const branchTouched = nextBranch !== current.repoBranch;

  const resolved =
    repoChanged || branchTouched
      ? resolveCaseSource(nextRepoPath, nextBranch)
      : { source: parseRepoSource(current.repoPath), repoPath: current.repoPath, repoBranch: current.repoBranch };

  const commitTouched = patch.commitHash !== undefined && patch.commitHash !== current.commitHash;
  const commitHash = commitTouched || repoChanged || branchTouched
    ? resolveCommitInput(resolved.source, patch.commitHash === undefined ? current.commitHash : patch.commitHash)
    : current.commitHash;
```

（`next` 对象里 `repoPath: resolved.repoPath`、新增 `repoBranch: resolved.repoBranch`。）

新增三个私有 helper：

```ts
/** 来源串的归一侧（本地 = 路径、远端 = 去尾斜杠的 URL）：它是「来源是否改变」的判据 */
function normalizeSourceString(repoPath: string): string {
  const source = parseRepoSource(repoPath);
  return source.kind === 'local' ? source.path : source.url;
}

/**
 * 落盘前把来源与分支判定成型（spec §6.3）：本地来源不允许分支；远端来源先确保镜像，
 * 分支判不过时**只 fetch 一次**再判——远端刚推上来的分支不该因为镜像还没更新而被拒
 * （与 ensureCaseCache「先本地判、失败只抓一次」同口径）。
 */
function resolveCaseSource(
  repoPath: string,
  repoBranch: string | null,
): { source: RepoSource; repoPath: string; repoBranch: string | null } {
  const source = parseRepoSource(repoPath);
  const branch = normalizeBranch(repoBranch);
  if (source.kind === 'local') {
    if (branch !== null) throw new ServiceError('INVALID_QUERY', `本地目录来源不支持分支：${source.path}`);
    resolveRepoInfo(source.path);
    return { source, repoPath: source.path, repoBranch: null };
  }
  const mirrorDir = ensureRemoteMirror(source.url);
  try {
    resolveRemoteRef(mirrorDir, source.url, { branch, commitHash: null, fetch: false });
  } catch (error) {
    if (!(error instanceof ServiceError) || error.code !== 'INVALID_REF') throw error;
    resolveRemoteRef(mirrorDir, source.url, { branch, commitHash: null, fetch: true });
  }
  return { source, repoPath: source.url, repoBranch: branch };
}

/** commit 输入归一：null / undefined / 空串 = 默认分支 HEAD；其余解析成 40 位（远端在镜像里判） */
function resolveCommitInput(source: RepoSource, commitHash: string | null | undefined): string | null {
  if (commitHash === null || commitHash === undefined) return null;
  const trimmed = commitHash.trim();
  if (trimmed === '') return null;
  if (source.kind === 'local') return assertCommit(source.path, trimmed);

  const mirrorDir = ensureRemoteMirror(source.url);
  try {
    return assertCommit(mirrorDir, trimmed);
  } catch (error) {
    if (!(error instanceof ServiceError) || error.code !== 'INVALID_REF') throw error;
    fetchMirror(mirrorDir, source.url);
    try {
      return assertCommit(mirrorDir, trimmed);
    } catch {
      // 文案点名**远端 URL**：assertCommit 原本的 message 里是镜像路径，会把用户指向无关的地方
      throw new ServiceError(
        'INVALID_REF',
        `commit 不存在：${trimmed}（远端：${source.url}，已在镜像中执行 git fetch，仍找不到该 commit）`,
        { context: { url: source.url, commit: trimmed, mirrorDir } },
      );
    }
  }
}
```

`judge.ts` 的仓库名一行改为：

```ts
  const source = parseRepoSource(input.repoPath);
  const repoName = source.kind === 'local' ? resolveRepoInfo(source.path).repoName : source.repoName;
```
（`buildUserPrompt({ taskPrompt: input.taskPrompt, repoName })` 一行不变。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/api test` → PASS
Run: `pnpm typecheck` → 0 error

- [ ] **Step 5: 提交**

```bash
git add packages/server/api/src/cases.ts packages/server/api/src/cases.test.ts packages/server/api/src/judge.ts packages/server/api/src/judge.test.ts
git commit -m "feat(api): 远端用例保存判定与评分提示词的仓库名解析"
```

---

### Task 10: evaluator —— 远端来源的行准备与评测快照

**Files:**
- Modify: `packages/server/api/src/runs.ts`（`EvalRun.repoBranch` 快照）
- Modify: `packages/server/evaluator/src/orchestrator.ts`（远端准备）
- Modify: `packages/server/evaluator/src/testing/fixtures.ts`（`makeCaseFixture` / `makeRunFixture` 补 `repoBranch`）
- Test: `packages/server/api/src/runs.test.ts`、`packages/server/evaluator/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: `parseRepoSource`、`ensureMirror` / `resolveRemoteRef`（Task 4–6）
- Produces: 远端轮次的 `EvalRow.baselineCommit` = 解析后的 40 位 hash；行工作区来自镜像（行为契约，无新导出）

- [ ] **Step 1: 写失败测试**

`packages/server/api/src/runs.test.ts` 追加：

```ts
it('创建评测时把用例的分支快照进这一轮', () => {
  const testCase = makeCaseFixture({ repoBranch: 'feat/x' });
  seedConfig({ workspaceRoot: ws, providers: [provider], cases: [testCase] });
  const run = createRun({ caseId: testCase.id, executionMode: 'parallel', rows: [rowInput] });
  expect(run.repoBranch).toBe('feat/x');
  expect(getRun(run.id).repoBranch).toBe('feat/x');
});
```

`packages/server/evaluator/src/orchestrator.test.ts`：先给该文件里 `seedRunnableRun` 的 options 增 `repoBranch?: string | null`（默认 null）并透传给 `makeRunFixture`，然后追加：

```ts
it('远端来源：准备阶段落具体基线 hash，行工作区来自镜像（core 只见本地路径）', async () => {
  // 「远端」= 本地真仓库的裸克隆 + file:// URL
  const origin = initFixtureRepo(join(dir, 'remote-origin-work'));
  const bare = join(dir, 'remote-origin.git');
  execFileSync('git', ['clone', '-q', '--bare', origin.repoPath, bare], { cwd: dir });
  const url = `file:///${bare.replace(/\\/g, '/')}`;

  const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', repoPath: url });
  // 按该文件既有的方式驱动这一轮（假适配器 + 假评分）：
  await runToCompletion(run.id); // ← 用文件里既有的驱动 helper，名字以文件实际为准

  const row = getRun(run.id).rows[0]!;
  expect(row.status).toBe('judged');
  expect(row.baselineCommit).toBe(origin.commit);
  expect(existsSync(join(row.workspacePath, '.git'))).toBe(true);
  // 镜像落点与用例缓存落点都在工作区根下，且**镜像不在行工作区里**（RG12）
  expect(existsSync(join(ws, 'remotes'))).toBe(true);
  expect(existsSync(join(row.workspacePath, 'remotes'))).toBe(false);
});

it('远端来源 + 分支：重复一轮会重新解析分支 tip（跟随语义）', async () => {
  const origin = initFixtureRepo(join(dir, 'remote-branch-work'));
  const bare = join(dir, 'remote-branch.git');
  execFileSync('git', ['clone', '-q', '--bare', origin.repoPath, bare], { cwd: dir });
  const url = `file:///${bare.replace(/\\/g, '/')}`;

  const first = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', repoPath: url });
  await runToCompletion(first.run.id);
  expect(getRun(first.run.id).rows[0]!.baselineCommit).toBe(origin.commit);

  // 远端前进一个提交
  const work = join(dir, 'advance');
  execFileSync('git', ['clone', '-q', url, work], { cwd: dir });
  writeFileSync(join(work, 'next.txt'), 'next\n', 'utf8');
  execFileSync('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'add', '.'], { cwd: work });
  execFileSync('git', ['-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'next'], { cwd: work });
  const advanced = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: work });

  const second = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', repoPath: url });
  await runToCompletion(second.run.id);
  expect(getRun(second.run.id).rows[0]!.baselineCommit).toBe(advanced);
});

it('远端不可达：该行 failed 且错误码是 REPO_UNREACHABLE（绝不静默沿用旧镜像）', async () => {
  const origin = initFixtureRepo(join(dir, 'remote-down-work'));
  const bare = join(dir, 'remote-down.git');
  execFileSync('git', ['clone', '-q', '--bare', origin.repoPath, bare], { cwd: dir });
  const url = `file:///${bare.replace(/\\/g, '/')}`;

  // 先把镜像建出来（第一次正常），再把「远端」整体移走
  const warmup = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', repoPath: url });
  await runToCompletion(warmup.run.id);
  renameSync(bare, `${bare}.moved`);

  const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', repoPath: url });
  await runToCompletion(run.id);

  const row = getRun(run.id).rows[0]!;
  expect(row.status).toBe('failed');
  expect(row.error?.code).toBe('REPO_UNREACHABLE');
});

it('镜像目录不会被评测列表当成一轮评测', async () => {
  const origin = initFixtureRepo(join(dir, 'remote-listrun-work'));
  const bare = join(dir, 'remote-listrun.git');
  execFileSync('git', ['clone', '-q', '--bare', origin.repoPath, bare], { cwd: dir });
  const url = `file:///${bare.replace(/\\/g, '/')}`;

  const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', repoPath: url });
  await runToCompletion(run.id);

  // remotes/ 与 cases/ 一样是工作区根下的兄弟目录：listRuns 只认「目录下有合法 run.json」的那些
  expect(existsSync(join(ws, 'remotes'))).toBe(true);
  expect(listRuns().map((item) => item.id)).toEqual([run.id]);
});
```

（`runToCompletion` / `seedRunnableRun` 的**真实名字以 `orchestrator.test.ts` 现有的 helper 为准**；该文件已经有「真仓库 + 假适配器跑完一轮」的现成路径，照它写，不要另造驱动方式。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/evaluator test -- orchestrator` 与 `pnpm --filter @aieval/api test -- runs`
Expected: FAIL —— 远端 URL 被当成路径交给 `prepareRowWorkspace`（`NOT_A_GIT_REPO` 或 `baselineCommit` 为空）；`repoBranch` 未进快照

- [ ] **Step 3: 实现**

`packages/server/api/src/runs.ts` 的 `run` 字面量在 `commitHash` 之后加一行：

```ts
    repoBranch: testCase.repoBranch,
```

`packages/server/evaluator/src/orchestrator.ts`：import 区补 `ensureMirror, resolveRemoteRef`（`@aieval/core`）与 `parseRepoSource`（`@aieval/contracts`），把 `prepareRowWorkspace(...)` 的调用点替换为：

```ts
  // 来源解析：远端在这里被物化成「本地镜像路径 + 具体 40 位 hash」，core 只见本地路径（RG7）。
  // 第 1 步（用例级缓存）仍由 prepareRowWorkspace 内部调用，编排层不重复调（见本节第 12 条）。
  const source = parseRepoSource(run.repoPath);
  let preparedRepoPath = source.path ?? '';
  let preparedCommit = run.commitHash;
  if (source.kind === 'remote') {
    const { mirrorDir } = ensureMirror({ workspaceRoot: run.workspaceBase, url: source.url });
    // 分支 tip 在这一步被重新解析（spec §6.7）：这是「跟随分支」与「钉死 commit」的分岔点。
    // 传具体 hash 而不是 null：镜像刚 fetch 过，缓存只需从镜像取对象，
    // 不走 ensureCaseCache 的「刷新到来源 HEAD」分支（那条分支读的是**本地** HEAD 语义）。
    preparedRepoPath = mirrorDir;
    preparedCommit = resolveRemoteRef(mirrorDir, source.url, { branch: run.repoBranch, commitHash: run.commitHash });
  }

  const prepared = prepareRowWorkspace({
    workspaceRoot: run.workspaceBase,
    caseId: run.caseId,
    repoPath: preparedRepoPath,
    runId,
    rowId,
    commitHash: preparedCommit,
    branch,
  });
```

（`let preparedRepoPath = source.path ?? ''` 在 TS 里收窄不成立——本地分支应写成：

```ts
  const source = parseRepoSource(run.repoPath);
  let preparedRepoPath: string;
  let preparedCommit = run.commitHash;
  if (source.kind === 'local') {
    preparedRepoPath = source.path;
  } else {
    /* 上面的远端分支 */
  }
```
按这个形状写，别用 `?? ''` 糊过去——空串会让 `ensureCaseCache` 拿到一个不存在的来源路径。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/evaluator test` → PASS
Run: `pnpm --filter @aieval/api test -- runs` → PASS
Run: `pnpm typecheck` → 0 error

- [ ] **Step 5: 提交**

```bash
git add packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts packages/server/evaluator/src/orchestrator.ts packages/server/evaluator/src/orchestrator.test.ts packages/server/evaluator/src/testing/fixtures.ts
git commit -m "feat(evaluator): 远端来源的行准备（镜像 + 分支 tip 每轮重解析）与分支快照"
```

---

### Task 11: client / web-next —— 数据层与用例页接线

**Files:**
- Modify: `packages/client/client/src/cases.ts`（校验与候选带分支）
- Modify: `apps/web-next/app/cases/page.tsx`（校验入参、候选按「来源 + 分支」取、仓库名统一）
- Delete: `apps/web-next/src/repo-name.ts` 与 `apps/web-next/src/repo-name.test.ts`（被 `contracts.repoNameFromSource` 取代）
- Test: `packages/client/client/src/cases.test.tsx`

**Interfaces:**
- Consumes: `repoNameFromSource`（contracts）
- Produces:
  - `useValidateRepo(): { validate: (input: { repoPath: string; repoBranch: string | null }) => Promise<RepoInfo>; isValidating: boolean }`
  - `useCommitCandidates(repoPath: string | null, repoBranch: string | null)`

- [ ] **Step 1: 写失败测试**

在 `packages/client/client/src/cases.test.tsx` 追加：

```tsx
it('校验请求带上分支（远端来源必填，本地传 null）', async () => {
  // 按该文件既有写法渲染 hook（renderHook + fetchMock）
  await act(async () => {
    await result.current.validate.validate({ repoPath: 'git@host:g/r.git', repoBranch: 'feat/x' });
  });
  expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe(
    JSON.stringify({ repoPath: 'git@host:g/r.git', repoBranch: 'feat/x' }),
  );
});

it('候选的 cache key 含分支：切分支即换一条缓存', async () => {
  // 断言 key 形状（`[COMMITS_KEY, repoPath, repoBranch]`）——两条分支不能共用一份候选
  expect(matchesCommitsKey([COMMITS_KEY, 'D:/r', 'feat/x'])).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/client test -- cases`
Expected: FAIL —— `validate` 只接受字符串 / 请求体里没有 `repoBranch`

- [ ] **Step 3: 实现数据层**

`packages/client/client/src/cases.ts`：

```ts
export function useValidateRepo(): {
  validate: (input: { repoPath: string; repoBranch: string | null }) => Promise<RepoInfo>;
  isValidating: boolean;
} {
  const { trigger, isMutating } = useSWRMutation(
    VALIDATE_REPO_KEY,
    (key: string, { arg }: { arg: { repoPath: string; repoBranch: string | null } }) => postJson<RepoInfo>(key, arg),
    { populateCache: false, revalidate: false },
  );
  return { validate: (input) => trigger(input), isValidating: isMutating };
}

/** commit 候选：key 里带分支——同一仓库的不同分支是两份不同的历史，共用缓存会串台 */
export function useCommitCandidates(repoPath: string | null, repoBranch: string | null): {
  commits: CommitCandidate[] | undefined;
  isLoading: boolean;
} {
  const key = repoPath === null || repoPath === '' ? null : ([COMMITS_KEY, repoPath, repoBranch ?? ''] as const);
  const { data, isLoading } = useSWR<CommitCandidate[]>(
    key,
    ([url, path, branch]) => postJson<CommitCandidate[]>(url, { repoPath: path, repoBranch: branch === '' ? null : branch }),
    { revalidateOnFocus: false },
  );
  return { commits: data, isLoading };
}
```

- [ ] **Step 4: 改用例页接线**

`apps/web-next/app/cases/page.tsx`：

1. `import { repoNameFromSource } from '@aieval/contracts';`，删掉 `import { repoNameOf } from '@/src/repo-name';`，把列表「仓库名」列的 `repoNameOf(repoPath)` 换成 `repoNameFromSource(repoPath)`；
2. `const [validatedRepoPath, setValidatedRepoPath] = useState<string | null>(null);` 旁边加 `const [validatedRepoBranch, setValidatedRepoBranch] = useState<string | null>(null);`，`useCommitCandidates(validatedRepoPath, validatedRepoBranch)`；
3. `handleValidateRepo` 签名改为收 `{ repoPath, repoBranch }`，成功后 `setValidatedRepoPath(info.repoPath)`（用**回显的归一值**）与 `setValidatedRepoBranch(repoBranch)`；
4. `go()` 里的复位补 `setValidatedRepoBranch(null);`；
5. `reloadCommits` 的注释补一句：候选按「来源 + 分支」缓存，过滤器仍然只看 key 第一段（`matchesCommitsKey`）。

删除 `apps/web-next/src/repo-name.ts` 与 `apps/web-next/src/repo-name.test.ts`（先 `grep -rn "repo-name'" apps/web-next` 确认没有别的引用）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/client test` → PASS
Run: `pnpm --filter @aieval/web-next test` → PASS
Run: `pnpm typecheck` → 0 error（若报出 `CaseFormPanel` 的 `onValidateRepo` 类型不匹配，那是 Task 12 要改的面板签名——先做 Task 12 再回来提交本任务，或把两个任务的提交合成一次；**不要**为了让 tsc 过去而在页面里把分支丢掉）

- [ ] **Step 6: 提交**

```bash
git add packages/client/client/src/cases.ts packages/client/client/src/cases.test.tsx apps/web-next/app/cases/page.tsx
git rm apps/web-next/src/repo-name.ts apps/web-next/src/repo-name.test.ts
git commit -m "feat(web): 用例页与数据层接线远端来源（校验与候选带分支、仓库名统一走 contracts）"
```

---

### Task 12: UI —— 用例表单的来源切换、分支字段与远端回显

**Files:**
- Modify: `packages/client/ui/src/composite/case-form-panel.tsx`
- Test: `packages/client/ui/src/composite/case-form-panel.test.tsx`

**Interfaces:**
- Consumes: `parseRepoSource` / `repoNameFromSource`（contracts）、`RepoInfo`（Task 2）、`formatDateTime`（同包 `base`，已有）
- Produces: `CaseFormPanelProps.onValidateRepo: (input: { repoPath: string; repoBranch: string | null }) => Promise<RepoInfo>`（**签名变更**，Task 11 的页面已按它接线）

- [ ] **Step 1: 写失败测试**

在 `case-form-panel.test.tsx` 追加：

```tsx
const REMOTE_INFO: RepoInfo = {
  repoPath: 'git@host:group/repo.git',
  repoName: 'repo',
  branch: 'main',
  kind: 'remote',
  mirrorPath: 'C:/runs/remotes/repo-1a2b3c4d',
  mirrorReady: true,
  mirrorFetchedAt: '2026-09-26T04:00:00.000Z',
  tip: 'abc1234',
};

/** 远端初值：编辑一条远端用例（来源态必须从初值判定出来，否则编辑远端用例会渲染成本地态） */
const REMOTE_CASE: TestCase = { ...INITIAL, repoPath: 'git@host:group/repo.git', repoBranch: 'feat/x' };

describe('CaseFormPanel 来源切换（远端）', () => {
  it('默认按初值判定来源：本地初值没有分支字段，远端初值有', () => {
    const { unmount } = setup({ mode: 'edit', initial: INITIAL });
    expect(screen.queryByTestId('case-repo-branch')).not.toBeInTheDocument();
    unmount();

    setup({ mode: 'edit', initial: REMOTE_CASE });
    expect(screen.getByTestId('case-repo-branch')).toBeInTheDocument();
  });

  it('切回本地必须清空分支：提交的分支恒为 null（服务端对「本地 + 分支」是硬拒绝）', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit, mode: 'edit', initial: REMOTE_CASE });
    expect((screen.getByTestId('case-repo-branch') as HTMLInputElement).value).toBe('feat/x');

    fireEvent.click(screen.getByRole('radio', { name: '本地目录' }));
    expect(screen.queryByTestId('case-repo-branch')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('case-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      repoPath: 'git@host:group/repo.git',
      repoBranch: null,
    });
  });

  it('校验把来源与分支一起交给页面', async () => {
    const onValidateRepo = vi.fn(async () => REMOTE_INFO);
    setup({ onValidateRepo, mode: 'edit', initial: REMOTE_CASE });

    fireEvent.click(screen.getByTestId('case-validate-repo'));

    await waitFor(() =>
      expect(onValidateRepo).toHaveBeenCalledWith({ repoPath: 'git@host:group/repo.git', repoBranch: 'feat/x' }),
    );
  });

  it('远端回显含仓库名 / 分支 / tip / 镜像更新时间；本地回显逐字不变', async () => {
    const { unmount } = setup({ mode: 'edit', initial: REMOTE_CASE, repoInfo: REMOTE_INFO });
    fireEvent.click(screen.getByTestId('case-validate-repo'));
    await waitFor(() => expect(screen.getByTestId('case-repo-info')).toBeInTheDocument());
    const remoteText = screen.getByTestId('case-repo-info').textContent ?? '';
    expect(remoteText).toContain('仓库：repo');
    expect(remoteText).toContain('分支：main');
    expect(remoteText).toContain('tip abc1234');
    expect(remoteText).toContain('镜像：已就绪');
    expect(remoteText).toContain('更新于');
    unmount();

    setup({ mode: 'edit', initial: INITIAL, repoInfo: REPO_INFO });
    fireEvent.click(screen.getByTestId('case-validate-repo'));
    await waitFor(() => expect(screen.getByTestId('case-repo-info')).toBeInTheDocument());
    expect(screen.getByTestId('case-repo-info').textContent).toBe('仓库：gateway · 当前分支：main');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/ui test -- case-form-panel`
Expected: FAIL —— 没有「远端仓库」单选、没有分支字段、`onValidateRepo` 只收字符串

- [ ] **Step 3: 实现**

`case-form-panel.tsx` 的改动（其余部分逐字保留）：

```tsx
import { parseRepoSource } from '@aieval/contracts';
import { Alert, AutoComplete, Button, Card, Flex, Form, Input, Radio, Select, Tooltip, Typography, theme } from 'antd';

/** 来源类型：界面的态（用户可以显式选），与服务端「按形态判定」是两件事——那边永远以字符串形态为准 */
type SourceKind = 'local' | 'remote';

/** 初值看起来是远端就按远端渲染；判定失败（未填 / 协议不支持）按本地渲染，让用户在本地态里改掉它 */
function initialSourceKind(initial: TestCase | null): SourceKind {
  if (initial === null) return 'local';
  try {
    return parseRepoSource(initial.repoPath).kind;
  } catch {
    return 'local';
  }
}
```

组件内新增 state 与派生值：

```tsx
  const [sourceKind, setSourceKind] = useState<SourceKind>(() => initialSourceKind(initial));
  const repoBranchValue = (Form.useWatch('repoBranch', form) as string | undefined) ?? '';
  const repoPathExtra =
    sourceKind === 'local'
      ? '只支持本地目录：填仓库根目录（含 .git）'
      : '认证使用本机 git 的 SSH key / 凭据助手，工具不保存任何凭据；首次校验会克隆远端仓库到工作区根下，可能较慢';
```

在「代码仓库」`Form.Item` 之前插入来源单选：

```tsx
        <Form.Item label="来源类型" extra="远端仓库的代码由服务端镜像到工作区根下，评测时按分支或 commit 取起点">
          <Radio.Group
            size="small"
            value={sourceKind}
            data-testid="case-source-kind"
            onChange={(event) => {
              const next = event.target.value as SourceKind;
              setSourceKind(next);
              // 切到本地必须清空分支：服务端对「本地 + 分支」是硬拒绝（RG9），
              // 留着一个看不见的值会让保存以一句与字段无关的报错失败
              if (next === 'local') form.setFieldValue('repoBranch', '');
              // 来源形态变了，上一次的校验回显必须失效（两套回显的内容不可比）
              setValidatedPath(null);
            }}
            options={[
              { label: '本地目录', value: 'local' },
              { label: '远端仓库', value: 'remote' },
            ]}
          />
        </Form.Item>
```

「代码仓库」`Form.Item` 的 `rules` / `extra` / `placeholder` 改成按态取：

```tsx
          rules={[
            { required: true, message: sourceKind === 'local' ? '请填写代码仓库的本地绝对路径' : '请填写 git 地址' },
            { whitespace: true, message: sourceKind === 'local' ? '请填写代码仓库的本地绝对路径' : '请填写 git 地址' },
          ]}
          extra={repoPathExtra}
        >
          <Input
            data-testid="case-repo-path"
            placeholder={sourceKind === 'local' ? 'D:\\projects\\gateway' : 'git@coding.jd.com:FlowAI/rbac-server.git'}
            suffix={/* 「校验」按钮原样保留 */}
          />
        </Form.Item>
```

在「代码仓库」之后插入分支字段（只在远端渲染）：

```tsx
        {sourceKind === 'remote' && (
          <Form.Item
            name="repoBranch"
            label="分支"
            extra="留空 = 远端默认分支 HEAD；填了就用该分支的 tip，每次评测重新解析"
          >
            <Input data-testid="case-repo-branch" placeholder="例如：feat/multi-protocol-inbound" />
          </Form.Item>
        )}
```

回显 Alert 的 `title` 改为按 `repoInfo.kind` 分派（本地那句**逐字不变**）：

```tsx
              title={
                repoInfo.kind === 'remote'
                  ? `仓库：${repoInfo.repoName} · ${repoBranchValue.trim() === '' ? '默认分支' : '分支'}：${repoInfo.branch}` +
                    `${repoInfo.tip === null ? '' : ` · tip ${repoInfo.tip}`}` +
                    ` · 镜像：已就绪${repoInfo.mirrorFetchedAt === null ? '' : `（更新于 ${formatDateTime(repoInfo.mirrorFetchedAt)}）`}`
                  : `仓库：${repoInfo.repoName} · 当前分支：${repoInfo.branch}`
              }
```

`handleValidate` / `handleFinish` 带上分支：

```tsx
  /** 提交给服务端的分支：本地态恒为 null（不让界面上残留的值溜进请求） */
  const submitBranch = (value: string | undefined): string | null => {
    if (sourceKind === 'local') return null;
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? null : trimmed;
  };
```

- `handleValidate`：`await onValidateRepo({ repoPath: (values.repoPath ?? '').trim(), repoBranch: submitBranch(values.repoBranch) })`；
- `handleFinish`：`repoBranch: submitBranch(values.repoBranch)`；
- `CaseFormValues` 增 `repoBranch?: string`，`initialValues` 增 `repoBranch: initial.repoBranch ?? ''`；
- 文件头「四个必须守住的行为」补第五条：**来源态只影响渲染与提交的分支归一，服务端永远按字符串形态判定**——界面切错态不该让服务端判错。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/ui test -- case-form-panel` → PASS
Run: `pnpm typecheck` → 0 error
Run: `pnpm lint` → 0 error（antd 组件用 `Radio.Group` 的 options 写法，别手写 `Radio` 子元素）

- [ ] **Step 5: 提交**

```bash
git add packages/client/ui/src/composite/case-form-panel.tsx packages/client/ui/src/composite/case-form-panel.test.tsx
git commit -m "feat(ui): 用例表单支持远端来源与分支（含镜像回显与服务端判定口径注释）"
```

---

### Task 13: UI —— 列表 / 详情 / 评测页显示与 README 更新

**Files:**
- Modify: `packages/client/ui/src/composite/case-detail-panel.tsx`（+ 同名测试）
- Modify: `packages/client/ui/src/composite/run-create-panel.tsx`（+ 同名测试）
- Modify: `packages/client/ui/src/composite/run-detail-panel.tsx`（+ 同名测试）
- Modify: `README.md`（使用手册四处）

**Interfaces:**
- Consumes: `repoNameFromSource`（contracts）、`TestCase.repoBranch` / `EvalRun.repoBranch`（Task 2）
- Produces: 无新导出（纯展示）

- [ ] **Step 1: 写失败测试**

```tsx
// case-detail-panel.test.tsx（沿用该文件既有的 CASE 常量与渲染方式）
it('远端用例：来源显示 URL，并多一行「分支」', () => {
  render(
    <CaseDetailPanel
      testCase={{ ...CASE, repoPath: 'git@host:g/r.git', repoBranch: 'feat/x' }}
      referencedRuns={null}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      deleting={false}
    />,
  );
  expect(screen.getByText('git@host:g/r.git')).toBeInTheDocument();
  expect(screen.getByText('feat/x')).toBeInTheDocument();
});

it('本地用例：不显示分支行（旧数据的界面逐字不变）', () => {
  render(
    <CaseDetailPanel
      testCase={{ ...CASE, repoBranch: null }}
      referencedRuns={null}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      deleting={false}
    />,
  );
  expect(screen.queryByText('分支')).not.toBeInTheDocument();
});

// run-create-panel.test.tsx（沿用该文件的用例夹具与渲染方式；props 见 panel 的公开签名）
it('用例下拉里的仓库名对 URL 也取末段（不再按路径分隔符切）', () => {
  render(
    <RunCreatePanel
      cases={[{ ...RUN_CASE, repoPath: 'git@coding.jd.com:FlowAI/rbac-server.git' }]}
      modelOptionsFor={() => []}
      saving={false}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.mouseDown(screen.getByLabelText('用例'));
  expect(screen.getByText(/rbac-server/)).toBeInTheDocument();
});

// run-detail-panel.test.tsx：用该文件**既有的**渲染方式渲染（它已经拼好了 run 与回调 props），
// 只把 run.repoBranch 覆盖成 'feat/x'，然后断言页面上出现该分支字符串
it('远端轮次显示分支', () => {
  renderRunDetail({ ...RUN, repoBranch: 'feat/x' }); // ← helper 的真实名字/形状以该文件现状为准
  expect(screen.getByText('feat/x')).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/ui test -- detail` 与 `-- run-create`
Expected: FAIL —— 没有分支行 / URL 的仓库名被切成整条 URL

- [ ] **Step 3: 实现**

- `case-detail-panel.tsx`：`repoPath` 那一行之后条件插入一行（`label: '分支'`，值用 `Typography.Text code`），仅当 `testCase.repoBranch !== null`；
- `run-create-panel.tsx`：删掉本文件里的 `repoNameOf`，改用 `import { repoNameFromSource } from '@aieval/contracts'`（下拉标签拼装处一行替换）；
- `run-detail-panel.tsx`：仓库行之后条件插入「分支」（`run.repoBranch !== null` 时）。

- [ ] **Step 4: 改 README（spec §13 四处）**

1. 使用手册 ②「建用例」字段表：把「代码仓库」一行改为「本地绝对路径**或** git 地址（`ssh://` / `http(s)://` / `git://` / `file://` / `user@host:path`），旁边「校验」按钮回显仓库名与分支」，并新增「分支」一行（「仅远端来源可填；留空 = 远端默认分支 HEAD，填了用该分支 tip 且每次评测重新解析」）；
2. ② 节正文补一段：**认证走本机 git**（SSH key / 凭据助手），工具不保存任何凭据；远端首次校验会把仓库镜像到 `{workspaceRoot}/remotes/`（大仓库可能较慢）；
3. ⑥ 排障表补三行：`REPO_UNREACHABLE`（查网络 / VPN）、`AUTH_FAILED`（配本机 SSH key 或凭据助手）、远端 `NOT_A_GIT_REPO`（改地址；私有仓库在凭据不可用时会这样报）、`INVALID_REF` 分支不存在（改分支名）；
4. 「数据落在哪」表补一行 `{workspaceRoot}/remotes/{slug}-{hash8}/`（远端仓库镜像；跨用例复用、不随删用例消失）；「本期不做」里的「云端仓库与凭据管理」改为「凭据管理（远端仓库本身已支持，认证走本机 git）」。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/ui test` → PASS
Run: `pnpm typecheck` / `pnpm lint` → 0 error

- [ ] **Step 6: 提交**

```bash
git add packages/client/ui/src/composite/case-detail-panel.tsx packages/client/ui/src/composite/case-detail-panel.test.tsx packages/client/ui/src/composite/run-create-panel.tsx packages/client/ui/src/composite/run-create-panel.test.tsx packages/client/ui/src/composite/run-detail-panel.tsx packages/client/ui/src/composite/run-detail-panel.test.tsx README.md
git commit -m "feat(ui): 用例与评测界面显示远端来源与分支；README 手册同步"
```

---

### Task 14: 关账 —— 变异验证、全量检查与冒烟

**Files:**
- Create: `docs/superpowers/notes/2026-09-26-remote-git-source-smoke.md`
- Create（若实施期出现需要裁决的接口分歧）: `docs/superpowers/notes/2026-09-26-remote-git-source-plan-interfaces.md`

- [ ] **Step 1: 四条变异验证（AGENT.md 硬要求：没有见过失败的守卫不算守卫）**

逐条做：制造缺陷 → 跑对应用例确认**变红** → 逐字节还原 → 核对文件哈希未变（`Get-FileHash`）。四条都必须留下命令与输出片段作为证据。

| # | 制造什么缺陷 | 期望哪条变红 |
|---|---|---|
| 1 | `ensureMirror` 的 `git clone --mirror` 改成 `--bare`（去掉镜像语义的 refspec） | T5「增量更新拿到来源的新提交，并写镜像记录」红 —— `fetch --prune origin` 会把提交写到 `refs/remotes/origin/*`，而 `refs/heads/main` 不再前进 |
| 2 | `promoteMirror` 的 rename 失败分支去掉「目标已就绪则复用」，改成直接抛 `INTERNAL` | T4「目标已存在且就绪时复用既有目录并清掉 tmp」红 |
| 3 | `classifyRemoteFailure` 的超时分支改成返回 `NOT_A_GIT_REPO` | T5「超时被杀 → REPO_UNREACHABLE 且文案含超时」红 |
| 4 | `resolveCaseSource` 去掉「本地来源 + 分支 → INVALID_QUERY」这条拦截 | T9「本地来源填分支 → INVALID_QUERY」红 |

> 关于 spec §9.4 的第 1 条（「`git clone <裸镜像>` 只建一个本地分支」）：它是一条**属性断言**——钉住 R20 的前提（本地路径克隆只建一个本地分支），而不是一段可能被人改坏的代码。它的变异方向不可达（无论把镜像建成 `--bare` 还是 `--mirror`，克隆它都只建一个本地分支），故不计入上表的四条；实施时按本计划处理，并在冒烟记录里写明这条属性断言的证据（`git clone <镜像>` 后 `for-each-ref refs/heads` 恰好一行）。

```powershell
# 还原后核对哈希（示例：以实际路径为准）
Get-FileHash packages\server\core\src\mirror.ts -Algorithm SHA256
```

- [ ] **Step 2: 全量检查**

```bash
pnpm typecheck
pnpm lint
pnpm test
```
Expected：三条全绿；`pnpm test` 的用例总数 ≥ 改动前的 1109（新增用例全部被根 `vitest.config.ts` 的 `projects` 收集到——新增测试文件落在既有包目录内，不需要改收集配置）。

- [ ] **Step 3: 冒烟（spec §12 夹具 A：`file://` 全链路）**

按 AGENT.md 的冒烟流程：`pnpm dev`（:3083）→ 用浏览器按真实用户路径操作 → 用 CLI 复核落盘事实。逐项：

1. `/cases` →「创建用例」→ 来源切「远端仓库」→ 填夹具 URL（`file:///<tmp>/origin.git`，含 `main` + `feat/x`）→ 点「校验」→ 断言回显含仓库名、默认分支、tip、镜像就绪与更新时间；
2. 保存 → 用 CLI 读 `~/.aieval/config.json`（或 `AIEVAL_CONFIG_DIR`）核对 `repoPath` 是 URL、`repoBranch` 为 `null`；
3. 把夹具仓库临时改名（制造「远端不可达」）→ 点「重新加载候选」→ 候选照常列出（证明不联网）→ 改回；
4. 建一轮评测（假上游供应商，沿用 p5 冒烟 `127.0.0.1:3099` 的手法）→ 断言行准备成功、`baselineCommit` = 默认分支 tip、diff 抽屉可用；
5. 夹具新增提交 → 重跑该行 → 断言新基线 = 新 tip；
6. 用例改填分支 `feat/x` → 校验回显分支 tip → 重跑 → 断言基线 = 该分支 tip；
7. 负例：不存在的 `file://` → `NOT_A_GIT_REPO`；`http://127.0.0.1:<空闲端口>` → `REPO_UNREACHABLE`；本地用例填分支 → `INVALID_QUERY`。

- [ ] **Step 4: 冒烟（spec §12 夹具 B：真实远端，只做校验与候选）**

`git@coding.jd.com:FlowAI/rbac-server.git` → 校验（断言认证走通、回显仓库名与默认分支）+ 建用例 + 拉候选。**不真跑 agent**（避免打额度），把「未跑满一轮」写进未覆盖项。

- [ ] **Step 5: 写冒烟记录**

`docs/superpowers/notes/2026-09-26-remote-git-source-smoke.md`，四要素（AGENT.md「冒烟测试」节）：① 范围清单（逐项 ✅/❌/跳过 + 理由）；② 操作路径（点击 / 输入序列）；③ 证据（浏览器状态 + CLI 输出互证，例如 `run.json` 里的 `baselineCommit` 与 `git -C <镜像> rev-parse` 的原文）；④ 未覆盖项与后续计划（至少含：真实远端未跑满一轮、镜像无清理入口、克隆期间服务阻塞未量化）。

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/notes/2026-09-26-remote-git-source-smoke.md
git commit -m "docs(notes): 远端 git 来源的冒烟记录与变异验证证据"
```

---

## 交付后的已知限制（不是缺陷，是本期范围）

- 不做凭据管理：认证失败只能提示「配本机 SSH key / 凭据助手」；
- 镜像不自动清理、无管理界面、不随删用例消失（改工作区根目录后旧镜像不再被看到，会重新克隆）；
- 同步 git 调用在 clone / fetch 期间阻塞整个服务进程（有 10 分钟墙钟上限兜底）；
- 不区分「私有仓库无权限」与「仓库不存在」（远端两者同形，文案并列说明）；
- 多实例（同机两个 dev server）不保证镜像竞态安全（单实例假设）。

---

## 实施期控制方修订（执行本计划时生效，优先于上文对应片段）

| # | 涉及任务 | 修订 | 理由 |
|---|---|---|---|
| A1 | T1 | `repoNameFromSource` 的仓库名口径 = **先剥尾分隔符再取末段**（`https://host/group/` → `group`；只有**没有路径段**时才回落主机名，`https://host/` → `host`）。T1 测试里的 `'https://host/group/' → 'host'` 期望作废（正文已改）。 | 与 `normalizeRemoteUrl`（镜像 key 的归一口径）一致：标签必须描述我们真正交给 git 的那个串 |
| A2 | T3 | `timeoutMs` 的语义在 `git-exec.ts` **只记录不夹取**；`timeout: 0` = Node 语义「不超时」，远端调用不得传非正值。 | 夹取点只留一个（镜像层），避免两处夹取漂移 |
| A3 | T4/T5 | 超时**只认正数**（`value !== undefined && value > 0`，绝不用 `??`）；`REMOTE_TRANSFER_TIMEOUT_MS` 在 T4 是本地 const，T5 加 `export` 即可、不得重复声明。 | `??` 会让调用方传 `0` 时静默取消 RG3 的墙钟保证（Node 把 0 当不超时） |
| A4 | T5 | `GIT_SSH_COMMAND` 追加 `BatchMode=yes`（仅当进程环境没有它）由 T5 落地（T4 的 `remoteOptions` 只带了 `GIT_TERMINAL_PROMPT`）。 | brief 把 `remoteOptions` 整体划给 T5 |
| A5 | T5 | 「把 `file://` 夹具仓库改名/移走」= **远端不存在** → 断言 `NOT_A_GIT_REPO`（git 原文 `does not appear to be a git repository`），**不是** `REPO_UNREACHABLE`；`REPO_UNREACHABLE` 的确定性覆盖 = 未监听端口 + `classifyRemoteFailure` 表驱动单测（认证 / DNS / 拒绝 / 不存在 / 超时五类各断码与文案片段）。 | spec §8.1 的映射；原片段的期望码会把用户指向「查网络」而不是「改地址」 |
| A6 | T6 | 同上：`resolveRemoteRef` 那条「钉死 commit 已在镜像 → 不联网；分支/默认分支需新鲜度」的测试里，来源被移走时断言 `NOT_A_GIT_REPO`。 | 同 A5 |
| A7 | T10 | 同上：远端来源被移走时该行 `failed` 且 `error.code === 'NOT_A_GIT_REPO'`（测试标题同步），它仍然证明「绝不静默沿用旧镜像」。 | 同 A5 |
| A8 | T5 | 把 brief 里无区分力的 clone 失败用例（`timeoutMs: 1`，杀得太早、磁盘上本无残骸）换成**已验证可用**的确定性构造：起一个 `node:net` 「哑远端」（接受连接但**不发 ref advertisement**），对 `git://127.0.0.1:<port>/x.git` 调 `ensureMirror({ timeoutMs: 3000 })` → 3s 后墙钟开枪（ETIMEDOUT/SIGTERM、stderr 为空），此时目标目录已由 git 的 `init_db` 建好 → 断言 `remotesDir` 无 `.tmp-*` 残留（Windows 上有区分力：删掉 catch 里的 `rmSync` 必红；POSIX 上 git 自清，退化为空过）。**注意**：T4 评审最初建议的 `uploadpack.packObjectsHook`（写在夹具裸仓库自己的 config 里）**实测无效** —— git 有意忽略来自不可信仓库的该配置，钩子从不执行、克隆 674ms 正常完成，别再走那条路。 | 本仓硬规则「没有见过失败的守卫不算守卫」；该断言原先永远不会红 |
| A9 | T8 | `listCommits(dir, limit, ref)` 的 `ref` 只传 `resolveRemoteRef` 解析出的 40 位 hash；分支名只出现在 `refs/heads/<branch>` 位置（不是选项形状）。 | 避免把用户可控串直接放进 git argv |
| A10 | T9 | 三条 carry-forward：(i) `api/src/cases.test.ts` 的 `uiPatchOf` 夹具补 `repoBranch`（它自称「真实 UI 提交形状」）；(ii) `updateCase` 必须合并 `patch.repoBranch`，否则编辑分支**静默无效**；(iii) 读取侧归一 `repoBranch ?? null`（旧 config 的用例缺这一列）。 | T2 评审的 Important 与读侧类型谎 |
| A11 | T11+T12 | 面板加分支输入时必须把 `handleFinish` 里预先落下的 `repoBranch: null` 换成 `submitBranch(values.repoBranch)`；T11 与 T12 **合并为一个派发单元**（面板 props 与页面/数据层互相依赖，单独任何一个都过不了 typecheck）。 | 否则编辑用例会把分支静默清空 |
| A12 | T14 | 默认 20s 上限下整包跑在本机（多会话共用）会 flake（`Test timed out`，非断言失败）；复跑口径 = 隔离复跑 + **仅 CLI** 的 `--testTimeout` 诊断跑，**不得**改仓库 `testTimeout` 配置；同时复跑 `pnpm --filter @aieval/core test -- git.repo`。 | 环境噪声与真实回归必须分开记录 |


