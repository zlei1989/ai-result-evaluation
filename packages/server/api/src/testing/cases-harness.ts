// @vitest-environment node
/**
 * 用例服务：CRUD、仓库 / commit 校验、删除时清理缓存仓库，以及「删了用例之后评测记录还读得到」。
 *
 * 仓库一律是 mkdtempSync 出来的**真实临时 git 仓库**（git 原语不许 mock——mock 掉的正是最容易错的地方），
 * 配置目录一律指向临时目录，绝不碰真实的 ~/.aieval 与真实仓库。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import { SETTINGS_DEFAULTS, type CasePatch, type EvalRun, type Rubric, type TestCase } from '@aieval/contracts';
import {
  loadConfig,
  readCase,
  saveConfig,
  setCasesRootForTesting,
  setConfigDirForTesting,
  writeCase,
} from '@aieval/core';

import { createCase, getCase } from '../cases';
import { removeTreeWithRetry } from './cleanup';

// 「缓存删不掉」这条守卫要把 rmSync 打挂一次（真实的 EPERM 在 CI 上造不出来）。
// 只替换 rmSync，其余导出原样透传，config-store / run-store 照常走真实文件系统。
// 注意 cpSync 也被本文件当夹具用（见 fixtureRepo），但那条路径**不经过 mock**：
// 工厂里显式透传了真实实现，只有 `vi.mocked(rmSync)` 那条用例会替换它自己那一次调用。

// 「首次校验不再补一次 fetch」这条守卫要能**看见命令行**（clone 与 fetch 是两条不同的命令）：
// 与上面同一口径——只把 execFileSync 包一层计数，实现原样透传，真 git 一个都不换。

export let dir: string;
export let ws: string;
export let repo: string;
/**
 * 用例根目录（`<casesRoot>/<case-id>.json`）。
 * **必须**由 `setCasesRootForTesting` 指到临时目录：默认根目录是真实的 `~/.aieval-cases`，
 * 而 `setConfigDirForTesting` 只管 `config.json` 所在目录，管不到它——少了这一行，
 * 整套用例测试会去读写开发者的家目录。
 */
export let casesRoot: string;

/**
 * 用例仓库的**模板**：`beforeAll` 里建一次（真实 `git init` + 真实提交），每个用例 `cpSync` 一份。
 *
 * 为什么不是每个用例各建一个：本机的进程创建约 250–400ms（企业杀软在 CreateProcess 上收税，
 * 与跑什么程序无关——实测 `cmd /c exit 0` 也要 250ms，`git --version` 350ms），而
 * `makeRepo` 那条路要走 **4 次**进程创建（init / add / commit / rev-parse）≈ 1.2s。
 * 本文件 37 个用例 ⇒ 光 beforeEach 的夹具就要 40s+，是整条 `pnpm test` 关键路径上最大的一块。
 * `cpSync` 一份仓库是纯文件系统操作（实测 ~10ms），且与生产代码 `copyWorkspace` 的做法同源——
 * 复制出来的仍是**独立、可用**的真实仓库（`git-repo-cache.test.ts` 有守卫钉住这一点）。
 *
 * 模板的提交信息必须逐字是 `第 1 次提交`：`listCommitCandidates` 那条用例断言的就是它。
 */
export let fixtureRepo: string;

/** 跑一条 git 命令：身份用 -c 显式给，避免依赖宿主机的 user.name / user.email 配置 */
export function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/**
 * 造一个真实仓库：返回各次提交的完整 hash（索引 0 是最早的）。
 * `name` 必须由调用方给：同一个用例里要造第二个仓库时，固定目录名会让两个仓库互相覆盖。
 *
 * 用 `--allow-empty` 而不是「写文件 → add → commit」：唯一需要多提交的夹具是
 * 「候选不是白名单」那条的 25 次提交，旧写法每次要 3 个进程（add / commit / rev-parse），
 * 75 次进程创建在本机实测 18.3s，是 api 包单文件 50–65s 的主因。空提交省掉 `add`，
 * hash 用一次 `git log --reverse` 批量取回，降到 27 次。
 * 空提交不改变「25 次提交」这个语义：`listCommits` 的 20 条截断与「最早那条不在候选里」
 * 的断言都与提交内容无关。
 */
export function makeRepo(name: string, commitCount: number): { dir: string; hashes: string[] } {
  const repoDir = join(dir, name);
  mkdirSync(repoDir, { recursive: true });
  git(['init', '-q'], repoDir);
  for (let index = 1; index <= commitCount; index += 1) {
    git(['commit', '-q', '--allow-empty', '-m', `第 ${index} 次提交`], repoDir);
  }
  const hashes = git(['log', '--reverse', '--format=%H'], repoDir)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  return { dir: repoDir, hashes };
}

/**
 * 把本地仓库变成「远端」：裸克隆一份并回 `file://` URL。
 * 用 file:// 而不是真网络：远端链路的每条分支（镜像、探活、超时、失败分类）都要能离线跑到。
 *
 * 本机提醒（实测，与本文件任何断言无关，T8/T9 的远端夹具同样适用）：整文件跑时这**第一次** `git clone`
 * 会撞上一次长停顿——探针实测这一步 113.7s（同一份夹具脱离 vitest 只要 0.47s、`validateRepo` 本体 2.3s，
 * 属进程创建税而非被测代码）；受害者是哪一条取决于运行顺序（实测 三件套 / 只读镜像 / URL 填进 都当过受害者），
 * 且它的表现是**夹具**超时而不是断言失败。
 * 故凡是用本夹具的用例都用下面这个常量声明自己的预算——全局 testTimeout 一字不动（它是套件其余部分的诚实信号）。
 */
/**
 * 远端夹具的**模板缓存**：同一组分支只真建一次，其余每次两个 `cpSync`。
 *
 * 为什么要缓存：`makeRemoteOrigin` 原本每次调用要 `init` + 1 次空提交 + `log` + 分支操作 +
 * `clone --bare` 等 **6–10 个 git 进程**（本机 ≈0.4s/进程），而远端那二十几条用例各调一次
 * ⇒ 光夹具就是 api 包里最大的一块。模板与副本**逐字节同内容**（连同各分支 hash）：
 * 工作仓库自己没有远端（`renameRemoteDefaultBranch` 是按路径 push 的），裸仓库里没有绝对路径依赖。
 * 布局刻意与原实现逐字一致（`<name>-work` 与 `<name>.git` 落在同一个 `dir` 下）：
 * `renameRemoteDefaultBranch` 按名字推路径，布局一改它就会静默找不到目录。
 */
const remoteTemplates = new Map<string, { root: string; hashes: Record<string, string> }>();

export function makeRemoteOrigin(name: string, branches: string[] = ['main']): { url: string; hashes: Record<string, string> } {
  const key = [...branches].sort().join('|');
  let template = remoteTemplates.get(key);
  if (template === undefined) {
    const root = mkdtempSync(join(tmpdir(), 'aieval-remote-template-'));
    template = { root, hashes: buildRemoteOrigin(root, branches) };
    remoteTemplates.set(key, template);
  }
  const workTarget = join(dir, `${name}-work`);
  const bareTarget = join(dir, `${name}.git`);
  cpSync(join(template.root, 'origin-work'), workTarget, { recursive: true });
  cpSync(join(template.root, 'origin.git'), bareTarget, { recursive: true });
  return { url: `file:///${bareTarget.replace(/\\/g, '/')}`, hashes: template.hashes };
}

/** 真建一份远端到模板目录（只在该分支组合第一次用到时执行一次） */
function buildRemoteOrigin(root: string, branches: string[]): Record<string, string> {
  const work = join(root, 'origin-work');
  mkdirSync(work, { recursive: true });
  git(['init', '-q'], work);
  git(['commit', '-q', '--allow-empty', '-m', '第 1 次提交'], work);
  git(['branch', '-M', 'main'], work);
  const first = git(['log', '--reverse', '--format=%H'], work).trim().split(/\r?\n/).filter(Boolean)[0] ?? '';
  const hashes: Record<string, string> = { main: first };
  for (const branch of branches.filter((item) => item !== 'main')) {
    git(['checkout', '-q', '-b', branch], work);
    // 与分支同名的 tag（指向更早的提交）：让「ref 位置交了分支名还是具体 hash」在候选里可观察
    // ——裸名的解析顺序会命中这个 tag，而 `refs/heads/<branch>` 不会（见「填了分支」那条用例）
    git(['tag', branch, first], work);
    writeFileSync(join(work, `${branch.replace(/\//g, '-')}.txt`), `${branch}\n`, 'utf8');
    git(['add', '.'], work);
    git(['commit', '-q', '-m', `${branch} 的提交`], work);
    hashes[branch] = git(['rev-parse', 'HEAD'], work).trim();
  }
  git(['checkout', '-q', 'main'], work);
  git(['clone', '-q', '--bare', work, join(root, 'origin.git')], root);
  return hashes;
}

/**
 * 用 `makeRemoteOrigin` 的用例自己的超时预算：覆盖本机文件内首次克隆的进程创建长停顿
 * （实测 113–117s，另有一次 **230s**——同一个夹具、同样与断言无关，属环境税），
 * 生产路径的墙钟由 core 的 `REMOTE_TRANSFER_TIMEOUT_MS`（600s）界定，与这个夹具预算无关。
 * 取 300s 是给那类停顿留出一倍余量：180s 仍可能因为环境而不是代码变红。
 * 只作用于显式声明它的用例；`vitest.config.ts` 的 `testTimeout` 一字不动。
 */
export const REMOTE_FIXTURE_TIMEOUT_MS = 300_000;

/**
 * 在「远端」上做一次 GitHub 式的默认分支改名：新分支上多一个提交 → 远端 HEAD 指过去 → 旧分支删掉。
 * 一切都在**远端侧**（`makeRemoteOrigin` 建好的工作仓库 + 裸仓库）完成，镜像那边一个字都不动——
 * 被测的正是镜像能不能自己跟上（`fetch --prune` 只剪 ref，不刷新镜像 HEAD，core 的 `mirror-ref.test.ts` 有实测）。
 * 返回新默认分支的 tip hash。工作仓库是 `clone --bare` 的**来源**、自己没有 origin 远端，故按路径推。
 */
export function renameRemoteDefaultBranch(name: string, to: string): string {
  const work = join(dir, `${name}-work`);
  const bare = join(dir, `${name}.git`);
  git(['checkout', '-q', '-B', to], work);
  writeFileSync(join(work, `${to}.txt`), `${to}\n`, 'utf8');
  git(['add', '.'], work);
  git(['commit', '-q', '-m', `${to} 的提交`], work);
  const tip = git(['rev-parse', 'HEAD'], work).trim();
  git(['push', '-q', bare, `HEAD:refs/heads/${to}`], work);
  git(['symbolic-ref', 'HEAD', `refs/heads/${to}`], bare);
  git(['branch', '-D', 'main'], bare);
  return tip;
}

/**
 * 本文件这一轮里跑过的 git 命令行。首次校验「不再补一次 fetch」那条守卫靠它把
 * 「clone 一次」与「clone 完再 fetch 一次」分开——两条是不同的命令，数得清，也不受机器快慢影响。
 */
export function gitCommands(): string[][] {
  return vi
    .mocked(execFileSync)
    .mock.calls.filter((call) => call[0] === 'git')
    .map((call) => (Array.isArray(call[1]) ? [...call[1]] : []));
}

/**
 * 夹具用的评分表（一组一项 / 20 分）：`caseInput` 与 `makeRun` 共用一份。
 * 写侧的非空要求由 `validateRubric` 给，故这份夹具必须是一张**能存下来**的表。
 */
const FIXTURE_RUBRIC: Rubric = { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }] }] };

/** 建用例的最小入参（各个用例只覆盖自己关心的字段） */
export function caseInput(overrides: Partial<Parameters<typeof createCase>[0]> = {}): Parameters<typeof createCase>[0] {
  return {
    title: '为网关补齐转换回归',
    repoPath: repo,
    commitHash: null,
    repoBranch: null,
    taskPrompt: '为 anthropic-to-chat 补一条回归用例',
    rubric: FIXTURE_RUBRIC,
    ...overrides,
  };
}

/**
 * 造一条「历史残留用例级评分模型」的用例（旧版本写下的覆盖值）。
 *
 * 为什么要有这个夹具：用例级覆盖已经删除，但**旧 config.json 里可能还留着这两列**。
 * 读路径的职责是把它们丢掉（契约上它们不存在，裸 spread 漏出去等于给下游一份「类型上没有、
 * 运行时却有」的数据）；写路径的职责是别让它们有机会回来。这个夹具就是那两处的输入。
 */
export function seedLegacyJudgeOverrideCase(caseId: string, override: { providerId: string; modelId: string }): TestCase {
  const current = mustReadCase(caseId);
  writeCase({
    ...current,
    judgeProviderId: override.providerId,
    judgeModelId: override.modelId,
  } as unknown as TestCase);
  return getCase(caseId);
}

/** 取用例文件；不存在就当场失败（夹具的输入错了，不该让断言去测「空气」） */
function mustReadCase(caseId: string): TestCase {
  const found = readCase(caseId);
  if (found === null) throw new Error(`夹具失败：用例文件不存在 ${caseId}`);
  return found;
}

/**
 * 「旧版用例」的两种坏形状（`config.json` 是手可编辑的，两种都可能出现）：
 *   · 整格不见（重构前建的用例就是这样，旧版只有一段 `judgePrompt`）；
 *   · 存在但形状不对（半截对象、`items` 写成字符串）。
 * 对用户的处置是同一句话（`cases.ts` 的 `assertUsableRubric`），故**取详情**与**列表**两侧的用例共用这一份。
 *
 * `carriesJudgePrompt`：这一形状的盘上那一行是否真的带着旧字段 `judgePrompt`
 * （重构前建的用例都带，形状②是手改出来的、不一定）。
 * 为什么把它写在夹具上而不是让调用方自己判断：读侧「丢掉契约上已删除的列」那条守卫需要一条
 * **非空对照**（先证明盘上真有这一格，再断言列表里没有它），否则形状②那种不带它的记录会让
 * 「列表不带 judgePrompt」变成一条恒真的空转断言。夹具自己说清楚哪种形状带、哪种不带。
 */
export const legacyCaseShapes: Array<{ label: string; mangle: (row: TestCase) => TestCase; carriesJudgePrompt: boolean }> = [
  {
    label: '没有 rubric 这一格',
    carriesJudgePrompt: true,
    mangle: (row) => {
      const legacy = { ...row, judgePrompt: '按五维评分，重点看是否真的补了用例' } as unknown as Record<string, unknown>;
      delete legacy.rubric;
      return legacy as unknown as TestCase;
    },
  },
  {
    label: 'rubric 存在但形状不对',
    carriesJudgePrompt: false,
    mangle: (row) => ({ ...row, rubric: { groups: '这不是数组' } }) as unknown as TestCase,
  },
];

/**
 * 造一条「旧版用例」：按历史数据的真实来路——先落盘一条合法用例，再按 `mangle` 把它改成旧版形状
 * （`delete` + 写入旧字段，而不是置 `rubric: undefined`；前者才是旧 config.json 的形态）。
 */
export function seedLegacyCase(label: string, mangle: (row: TestCase) => TestCase): TestCase {
  const created = createCase(caseInput({ title: `旧用例：${label}` }));
  // 按真实来路的第一半：先落一条合法用例；第二半是把它改成旧版形状后**覆盖同一个用例文件**
  writeCase(mangle(mustReadCase(created.id)));
  // 先确认这份「历史数据」真的写进了盘上（否则调用方的断言测的是空气）
  expect(mustReadCase(created.id).rubric).not.toEqual(created.rubric);
  return created;
}

/**
 * 造一条**合法但靠 schema 缺省值补齐**的记录：某一项没写 `id`（`RubricItemSchema.id` 的 `.default('')`
 * 让它合法）。按它的真实来路造——`createCase` 会经 `assertStorable` 把缺省值补齐，所以只能像
 * 手改过的 config.json 那样直接写盘。读侧归一必须把它补成 `id: ''`，而不是把 `undefined` 流出去。
 */
export function seedRowWithoutItemId(): TestCase {
  const base = caseInput();
  const row = {
    id: 'c-hand-edited',
    title: '手改过：某一项没写 id',
    repoPath: base.repoPath,
    commitHash: base.commitHash,
    repoBranch: base.repoBranch,
    taskPrompt: base.taskPrompt,
    rubric: { groups: [{ name: '一、生产代码', items: [{ goal: '没写 id 的一项', weight: 5 }] }] },
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  } as unknown as TestCase;
  // 直接写文件（而不是过 createCase）：这一条要复现的正是「手改过的用例文件」那种绕过写侧自检的来路
  writeCase(row);
  return row;
}

/**
 * 照 UI **真实的提交形状**造一份补丁：`case-form-panel.tsx` 的 `handleFinish` 无条件交回**全部字段**
 * （值由 `initialValues` 灌入，输入框的 `onChange` 只在用户操作时触发，不做任何 diff），
 * 页面 `update(id, values)` 又把它整份发给 `PUT /api/cases/{id}`。
 *
 * 为什么抽成一个夹具而不是每条用例手写：这个形状本身是好几条守卫的**承重条件**，
 * 而「用例手写了一个 UI 永远不会产生的补丁」已经栽过两次——老用例只写 `{ title }`，
 * 于是「改标题不被仓库可用性拦住」在真实路径上不成立，而 `{ title }` 的写法让
 * 「半配置用例仍可编辑标题」在真实路径上同样不成立。集中一处，UI 的字段表一变就一次性影响所有守卫。
 */
export function uiPatchOf(current: TestCase, overrides: Partial<CasePatch> = {}): CasePatch {
  return {
    title: current.title,
    repoPath: current.repoPath,
    commitHash: current.commitHash,
    repoBranch: current.repoBranch,
    taskPrompt: current.taskPrompt,
    rubric: current.rubric,
    ...overrides,
  };
}

/**
 * 造一个引用某用例的运行快照（走真实的 saveRun，而不是手写 run.json）。
 * `rubric` 必须给：`EvalRunSchema.rubric` 是必填快照，`saveRun` 的写侧自检会拒绝一份没有评分表的记录。
 */
export function makeRun(runId: string, caseId: string, caseTitle: string, repoPath: string, commitHash: string | null): EvalRun {
  return {
    id: runId,
    caseId,
    caseTitle,
    repoPath,
    commitHash,
    repoBranch: null,
    rubric: FIXTURE_RUBRIC,
    status: 'done',
    executionMode: 'parallel',
    useAgentJudge: false,
    rows: [],
    workspaceBase: ws,
    createdAt: '2026-09-22T10:00:00.000Z',
    startedAt: '2026-09-22T10:00:01.000Z',
    finishedAt: '2026-09-22T10:05:00.000Z',
  };
}


/**
 * 注册本文件集的公共钩子（4 个：夹具模板 / 临时目录 / 清理）。
 * 为什么做成函数：harness 被多个测试文件共享，钩子必须注册在**调用它的那个文件**的 suite 上。
 */
export function registerCasesHooks(): void {
  beforeAll(() => {
    fixtureRepo = mkdtempSync(join(tmpdir(), 'aieval-cases-fixture-'));
    git(['init', '-q'], fixtureRepo);
    // 带一个真实文件：空树会让模板与 `makeRepo(name, 1)` 造出的仓库**可能**撞成同一个 hash
    // （同一条提交信息 + 同一个提交者 + 同一秒），而「换仓库」那条用例正需要两者互不包含。
    writeFileSync(join(fixtureRepo, 'file-1.txt'), '第 1 次提交\n', 'utf8');
    git(['add', '.'], fixtureRepo);
    git(['commit', '-q', '-m', '第 1 次提交'], fixtureRepo);
  });
  afterAll(() => {
    removeTreeWithRetry(fixtureRepo);
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aieval-cases-'));
    ws = join(dir, 'runs');
    mkdirSync(ws, { recursive: true });
    setConfigDirForTesting(dir);
    // 用例目录也指到临时目录（见 `casesRoot` 的注释）；与 config 目录一并设、一并还原
    casesRoot = join(dir, 'cases');
    setCasesRootForTesting(casesRoot);
    saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: ws, casesRoot } });
    repo = join(dir, 'repo');
    cpSync(fixtureRepo, repo, { recursive: true });
  });
  afterEach(() => {
    setConfigDirForTesting(null);
    setCasesRootForTesting(null);
    removeTreeWithRetry(dir);
  });
}
export { execFileSync } from 'node:child_process';
export { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
export { tmpdir } from 'node:os';
export { join } from 'node:path';
export { SETTINGS_DEFAULTS, ServiceError } from '@aieval/contracts';
export type { CasePatch, EvalRun, TestCase } from '@aieval/contracts';
export { getConfigDir, loadConfig, mirrorDir, saveConfig, setConfigDirForTesting } from '@aieval/core';
// 用例存储（core 的 case-store）：测试要能直接落/读 `<casesRoot>/<id>.json`，以及把根目录指向临时目录
export {
  caseFile,
  deleteCaseFile,
  getCasesRoot,
  listCases as listStoredCases,
  readCase,
  setCasesRootForTesting,
  writeCase,
} from '@aieval/core';
export { getRun, saveRun } from '@aieval/evaluator';
export { createCase, deleteCase, getCase, listCases, listCommitCandidates, normalizeBranch, updateCase, validateRepo } from '../cases';