# 功能阶段 p1 实施计划：设置域（供应商 / 评分配置 / 工作区）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置域做完整——模型供应商（含两种协议类型、密钥掩码、模型清单的手工维护与 `/models` 自动拉取且**合并而非覆盖**）、评分配置（默认评分模型 + 行超时 + diff 上限 + 输出契约预览）、工作区根目录（校验通过才落盘），并把这三块接到 `/settings` 页的三个占位 Tab 上。

**Architecture:** 沿脚手架的四层走，每层只做一件事：`api` 的 `providers.ts` 承载全部业务规则（含「Anthropic 协议没有 `/models` 接口」这条服务端拒绝），`client` 的 `providers.ts` 只做 SWR 数据获取与列表刷新，`ui` 的四个组件纯展示（数据与回调全走 props），`web-next` 的四个路由文件只做「zod 校验 → 调 api → 错误映射」。明文密钥只允许出现在 `core` 的配置文件与 `api` 内部，跨层出口一律是 `ProviderView`（只有掩码）。评分配置与工作区**不新开路由**，复用已有的 `PUT /api/settings`。

**Tech Stack:** TypeScript 5（strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）· antd 6.6.5 · SWR 2 · zod 3 · Next.js 16.2.7（App Router Route Handlers）· vitest 4（node / jsdom 双配置）

**Spec:** docs/superpowers/specs/2026-09-22-features-design.md §3 F1 / §6 / §8 / §10 / §12

**Interfaces source:** docs/superpowers/notes/2026-09-22-features-plan-interfaces.md（§2/§6/§7/§8/§9）

> **勘误（2026-09-26，Anthropic 拉取口径修订）—— 本计划下列内容已作废，原文一字未改，读法以此处为准。**
> 现行口径：**能否拉取模型不由协议判定**，改由地址形态兜底 —— `GET {地址}/models`，**仅 404** 时回退 `GET {地址}/v1/models`
> （地址已以 `/v1` 结尾时只留前者；401/403/429/5xx 说明路径是通的，不回退），两条都 404 时错误文案点名两条实际路径。
> 出处：spec §3 F1 / §6.1 的 2026-09-26 修订；实现见 `packages/server/api/src/providers.ts` 的 `modelListCandidates` / `fetchModelIds`；
> 界面见 `packages/client/ui/src/composite/provider-form-modal.tsx`（拉取按钮只剩「新建态没有 id」一种禁用）。
> **2026-09-30 更新（模型清单独立成对话框）**：模型清单已从 `provider-form-modal.tsx` 搬进
> `provider-models-modal.tsx`，入口是列表每行操作列的「模型」按钮（排在「编辑」之前）；编辑弹窗只剩四个字段
> （宽度 720 → 560）并留一条指路 Alert。上面那句「拉取按钮只剩新建态没有 id 一种禁用」的判据随之搬到模型对话框里
> （那里也没有禁用）。守卫：`provider-table.test.tsx`（按钮存在/顺序）、`provider-models-modal.test.tsx`（清单本体）、
> `provider-form-modal.test.tsx`（清单不在这里 + 去向可见）。
> **2026-09-30 再修订（补站点根回退）**：候选从两条变四条 —— `{地址}/models` → `{地址}/v1/models`（地址已以 `/v1` 结尾时跳过）
> → 站点根 `/models` → 站点根 `/v1/models`（重复 URL 只留一次），仍**只有 404** 才换下一条，
> 全都不通时文案点名**试过的每一条**路径。于是地址填 `/anthropic`（Messages 根）或 `/api/v1`（带前缀）也能拉到，
> 出处同上（spec §6.1 第 3 点的 2026-09-30 再修订）。
> 受影响（行号按本文件当前文本）：`:7`（Architecture 的「含『Anthropic 协议没有 `/models` 接口』这条服务端拒绝」）、`:21`（Global Constraint「Anthropic 协议下不提供拉取」）、
> `:767`/`:787`（Task 2 的协议拒绝用例与文案断言）、`:1093`/`:1101`（Task 2 的服务端拒绝实现）、`:1222`（被注释掉的旧实现）、
> `:2150`/`:2301`（Task 5 的按钮禁用与「该协议无 /models 接口」提示）、`:3337`/`:3484`（Task 7/8 的路由 400 用例）、
> `:3888`（Task 10 冒烟归属第 1 项）、`:3951`（跨任务引用里对「没有 /models 接口」文案的依赖）。
> **仍成立**：本计划其余部分（明文密钥只进不出、拉取是合并而非覆盖、密钥安全取舍、原子写、按协议过滤候选池、两汉字按钮不插空格）与本次修订无关。

## Global Constraints

- 包名 `@aieval/*`；本计划只碰 `packages/server/api`、`packages/client/{client,ui}`、`apps/web-next` 四个包。依赖方向由 `eslint.shared.ts` 的 `withBoundary()` 硬约束：`api → core / contracts`、`client → contracts`、`ui → contracts`（**`ui` 不得 import `client`**）、`web-next → api / ui / client / contracts`。
- 源码一律 ESM（禁 `require`）；`verbatimModuleSyntax` 开着，**类型必须 `import type`**。
- **明文密钥只进不出**：落盘的 `Provider.apiKey` 是明文（服务端必须拿原 token 才能代调上游，spec §6.1）；任何跨层出口（`api` 返回值、HTTP 响应、`ui` 的 props）一律是 `ProviderView`（只有 `apiKeyMasked`）。掩码函数用 contracts 的 `maskApiKey`，**不得自己再写一份**。
- **拉取是合并而非覆盖**：`source: 'manual'` 的条目在任何一次拉取后都必须原样存在（spec §6.1、§9「拉模型合并」）。
- **Anthropic 协议下不提供拉取**：服务端按**已保存**的 `protocolType` 拒绝并给中文原因（F1 / §6.1）；前端禁用按钮只是第二道，不是唯一一道。
  > **2026-09-26 修订：本条已作废**（原文保留不改）。协议**不再**参与能否拉取的判定，改为按地址形态兜底（见文首勘误）。
- **拉模型的 HTTP 调用只能注入假上游，测试不得打真实网络**：一律 `vi.stubGlobal('fetch', …)`，且文件级 `afterEach(() => vi.unstubAllGlobals())`。
- 配置落盘一律走 core 的 `saveConfig`（原子写 + `chmod 0600`，见 §6.1 末尾的安全取舍）；`saveConfig` 抛出的原始 errno 必须折成**带配置目录的中文 `INTERNAL`**，不得把英文原文回给用户。
- 时间字段一律 ISO 8601 带时区字符串（`new Date().toISOString()`）；实体 id 一律 UUID v4（`node:crypto` 的 `randomUUID()`），由服务端生成。
- 评分配置与工作区**复用 `PUT /api/settings`**，不新增路由；工作区「校验并保存」= `PUT { workspaceRoot }`，服务端校验通过才落盘（§6.3）。
- **样式一律走 antd**（主题 token / 紧凑密度 / 语义 `styles`）：不手写字号、不手调行内边距、不裸写 `div` 布局（用 `Flex` / `Card` / `Form` / `Table` 等 antd 组件）。**紧凑密度下绝不显式写 `fontSize`**。
- **antd 6 的四个已核实细节（本机 6.6.5 的类型与源码）**：`Alert` 用 `title`（`message` 已弃用）；`Modal` 用 `destroyOnHidden`（`destroyOnClose` 已弃用）；`InputNumber` 的 `addonAfter` 已弃用（单位用 `suffix`）；`Select.Option` / `Select.OptGroup` 子节点已弃用（选项一律走 `options` 属性）。另外 `Tag` 在 v6 去掉了默认右外边距，标签间距靠 `Flex gap`。
- **应用没有配 antd 的 `locale`**（`apps/web-next/app/providers.tsx` 只给了 theme），antd 内置文案默认英文：本计划新增的每个浮层都必须显式给中文 `okText` / `cancelText` / `emptyText`，否则界面中英混杂。
- `apps/web-next` 保留 `jsx: preserve`，**该应用内不能写 `.tsx` 测试**（AGENT.md）：设置页本身没有自动化测试，页面逻辑必须薄到只剩「取值 → 传参 → 折错误」。
- 每个任务结束时 `pnpm typecheck` 零错误；收尾任务跑 `pnpm lint` 与 `pnpm test`。
- **提交信息中文**；`git add` 逐个显式写路径，**禁 `git add -A`**。`git status` 里出现不属于本计划的文件时保持原样。
- **每条新增的回归守卫都必须做变异验证**：把要拦的缺陷人为制造回去（改实现、不改测试），确认守卫**失败**，再还原并核对文件哈希。本计划对四条守卫做了变异验证（见文末「变异验证清单」）。

## Review Focus

以下五类输入/条件 spec 与契约都没有明说，但坏了会直接伤到使用者，按最可能发生的顺序排列。每条都钉在拥有该代码的任务的测试步骤里。

1. **编辑供应商时密钥框留空**（用户只想改名字）→ 期望原密钥被保留、掩码不变；空串既不落盘也不下发。`ProviderPatchSchema.apiKey` 是 `min(1)`，空串会被 zod 判成非法补丁，而若被放过就会把用户的密钥抹成空——此后所有代调都是 401。落到 **Task 1**（服务端语义）、**Task 5**（弹窗留空提交）、**Task 7**（页面折成「不下发 `apiKey`」+ 路由回读磁盘断言密钥未变）。
2. **`settings.defaultJudge` 指向已被删除的供应商或模型**（悬空引用）→ 期望评分配置卡显式提示「已失效」并要求重选，而不是静默显示成「未配置」（那会让人以为只是没选，直到跑评测才发现评分不可用）。落到 **Task 1**（删除不级联改写设置）、**Task 6**（卡片提示）、**Task 7**（路由层不碰设置）。
3. **模型 id 含 URL 特殊字符**（`vendor/model+x`、`a#1`、含空格或中文）→ 期望删除请求按 `encodeURIComponent` 传参、服务端解出的 id 与配置里逐字符相等，且只删那一条。不编码时 `#` 之后会被当片段丢掉、`+` 会被解成空格，表现为「点了删除没反应」或删错条目。落到 **Task 3**（客户端 URL ★变异验证④）、**Task 7**（路由 `?modelId` 解码）。
4. **上游 `/models` 返回非预期结构**（`{ models: [...] }`、`data` 缺失、元素是 `null` / `{}` / 数字、整个响应是 HTML 登录页）→ 期望：能识别的部分照常合并；一条都认不出或响应非 JSON 时给**含 host 的中文原因**且**不落盘**——绝不能用空清单覆盖掉用户手工维护的模型。落到 **Task 2**。
5. **供应商协议被从 openai 改成 anthropic 之后再点「拉取模型」**→ 期望服务端按**已保存**的协议拒绝、给中文原因且**一次网络请求都不发**；前端按钮的禁用状态同样依据已保存的协议（跟着未保存的单选值变灰只会让人以为「拉取坏了」）。落到 **Task 2**（★变异验证③）、**Task 5**（按钮禁用依据）、**Task 7**（路由 400 + fetch 桩未被调用）。

## 本计划对 spec / 契约的实现层修正

计划编写期读了本机实际安装的 Next 16.2.7 与 antd 6.6.5，以下七条按契约与实现现实执行（**不改任何已钉死的名字与参数**）：

1. **`fetchProviderModels` 返回 `Promise<ProviderView>`**。契约 §6 把它写成同步返回 `ProviderView`，但它必须发一次 HTTP 请求，只能是异步；契约 §7 的客户端 `fetchModels: (id: string) => Promise<ProviderView>` 也印证了这一点。本计划不改名、不改参数，只把返回值包成 Promise。详见文末「契约冲突」。
2. **spec §8 的 `/settings` hooks 行与契约 §7 不一致**：spec 写了 `useFetchModels()` 与 `useValidateWorkspaceRoot()`，契约 §7 只有 `useFetchProviderModels`，且工作区校验没有独立 hook。**以契约为准**：用 `useFetchProviderModels`，工作区「校验并保存」走 `useSettings().update({ workspaceRoot })`（复用 `PUT /api/settings`，不新开路由）。
3. **spec §7.1 的 `providers.json` / `cases.json` 不采用**：契约 §10 与 core 的实现都是单份 `~/.aieval/config.json`（`AppConfig = { settings, providers, cases }`）。本计划按 core 的现状读写，不新增配置文件。
4. **模型清单的 `source` 由服务端固定**：HTTP 请求体里带的 `source` 只用于过契约校验；`createProvider` 的初始清单与 `addProviderModel` 一律落成 `manual`。`fetched` 的唯一合法来源是一次真实的拉取调用——允许客户端声明 `fetched`，用户手工填的模型就会在下一次拉取里被按「已下架」清掉（正是 §6.1「合并而非覆盖」要防的那类损失）。
5. **设置页的评分配置 Select 直接在前端由 `providers` 派生选项**，不经 HTTP：`ProviderView[]` 已含 `protocolType` 与完整模型清单，为此开一条 `GET /api/providers/model-options` 属于为同一个投影多养一条路由。契约 §6 钉死的 `listAllModelOptions()` 仍然交付（并在 Task 1 验收），它的消费方是服务端（用例表单的候选池、评测行的校验，归 p2/p5）。
6. **`ui` 新增一个局部类型 `ProviderFormValues`**：契约 §8 只钉了弹窗的 props 名，没有钉提交载荷的形状；「编辑态留空密钥」需要一种能表达「本次不下发 `apiKey`」的载荷，故新增这个 p1 内部类型（不跨计划可见）。
7. **antd 6 的具体写法**（已在 Global Constraints 里逐条列出，此处不重复），其中 `Alert` 的 `title`、`Modal` 的 `destroyOnHidden`、`InputNumber` 改用 `suffix`、`Select` 选项走 `options` 四条都是本机 6.6.5 的实测结论。

---

## 文件结构总览

```
packages/server/api/src/
├── providers.ts                                # 新增：供应商 CRUD + 模型清单 + /models 拉取（Task 1、Task 2）
├── providers.test.ts                           # 新增：服务层全部用例（Task 1、Task 2）
└── index.ts                                    # 改：追加 providers 的出口（Task 1、Task 2）

packages/client/client/src/
├── providers.ts                                # 新增：六个 hooks（Task 3）
├── providers.test.tsx                          # 新增：jsdom 用例（Task 3）
└── index.ts                                    # 改：追加 hooks 出口（Task 3）

packages/client/ui/src/composite/
├── provider-table.tsx / provider-table.test.tsx           # 新增（Task 4）
├── provider-form-modal.tsx / ....test.tsx                 # 新增（Task 5）
├── judge-settings-card.tsx / ....test.tsx                 # 新增（Task 6）
├── workspace-settings-card.tsx / ....test.tsx             # 新增（Task 6）
packages/client/ui/src/index.ts                            # 改：追加四个组件出口（Task 4、5、6）

apps/web-next/
├── app/api/providers/route.ts                             # 新增：GET 列表 / POST 新增（Task 7）
├── app/api/providers/[providerId]/route.ts                # 新增：PUT 改 / DELETE 删（Task 7）
├── app/api/providers/[providerId]/models/route.ts         # 新增：POST 加一条 / DELETE 删一条（Task 7）
├── app/api/providers/[providerId]/models/fetch/route.ts   # 新增：POST 拉取并合并（Task 7）
├── app/api/settings/route.ts                              # 改：文件头注释说明它同时承担评分配置与工作区（Task 7）
├── src/route-providers.test.ts                            # 新增：四个路由的端到端（Task 7）
└── app/settings/page.tsx                                  # 改：填三个占位 Tab（Task 8）
```

**本计划不产出的东西**（避免执行者顺手扩范围）：`listModelOptions(agentKind)`（p5，读 `agents` 注册表）、任何新的 `/api/settings` 路由、`apps/web-next/src/nav.ts` 的改动（`/settings` 项已在）、`app/demo/page.tsx` 的删除（p2）。

---

## Task 1: `api` —— 供应商 CRUD、模型清单手工维护与掩码出口

**Files:**
- Create: `packages/server/api/src/providers.ts`
- Create: `packages/server/api/src/providers.test.ts`
- Modify: `packages/server/api/src/index.ts:1-2`（在现有两行后追加一段）

**Interfaces:**
- Consumes: p0 的 `contracts` 出口 `Provider` / `ProviderView` / `ProviderCreate` / `ProviderPatch` / `ProtocolType` / `maskApiKey` / `ServiceError`；脚手架已有 `core` 出口 `loadConfig` / `saveConfig` / `getConfigDir` / `createLogger` / `AppConfig`。
- Produces（签名逐字来自契约 §6）：
  - `listProviders(): ProviderView[]`
  - `createProvider(input: ProviderCreate): ProviderView`
  - `updateProvider(providerId: string, patch: ProviderPatch): ProviderView`
  - `deleteProvider(providerId: string): void`
  - `addProviderModel(providerId: string, modelId: string): ProviderView`
  - `removeProviderModel(providerId: string, modelId: string): ProviderView`
  - `listAllModelOptions(): { providerId: string; providerName: string; protocolType: ProtocolType; modelId: string; source: 'fetched' | 'manual' }[]`
  - （任务内部、不导出）`toView` / `persist` / `requireProvider` / `replaceProvider` / `manualModels` / `reason`

- [ ] **Step 1: 写失败测试 `providers.test.ts`**

```ts
// @vitest-environment node
/**
 * 供应商服务：CRUD、掩码出口、模型清单的手工维护、全部模型候选。
 * 配置目录一律指向 mkdtempSync 出来的临时目录并在 afterEach 复位 —— 绝不碰真实的 ~/.aieval。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, maskApiKey, type ProviderCreate } from '@aieval/contracts';
import { loadConfig, setConfigDirForTesting } from '@aieval/core';
import {
  addProviderModel,
  createProvider,
  deleteProvider,
  listAllModelOptions,
  listProviders,
  removeProviderModel,
  updateProvider,
} from './providers';
import { updateSettings } from './settings';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-providers-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  // 顺序要紧：先复位再删目录，否则万一删目录抛错，覆盖值会漏给下一个文件
  setConfigDirForTesting(null);
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** 用例通用的新增入参（密钥是明文，落盘形态与真实一致） */
const CREATE: ProviderCreate = {
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-abcdefghijklmnop',
  models: [],
};

/** 从磁盘上取一条供应商（用来断言「落盘的到底是什么」，而不是只看内存返回值） */
function stored(providerId: string) {
  return loadConfig().providers.find((item) => item.id === providerId);
}

describe('listProviders / createProvider', () => {
  it('新建后能列出，且下行对象只有掩码、没有 apiKey 这个键', () => {
    const created = createProvider(CREATE);

    expect(created.name).toBe(CREATE.name);
    expect(created.apiKeyMasked).toBe(maskApiKey(CREATE.apiKey));
    // 不是「值为空」而是**键不存在**：`{ apiKey: undefined }` 会让 JSON.stringify 丢键、
    // 但 `'apiKey' in obj` 仍为 true，客户端一个 `obj.apiKey ?? ''` 就能把它当字段用。
    expect('apiKey' in created).toBe(false);
    expect(listProviders().map((item) => item.id)).toEqual([created.id]);
    // 最终的判据：整个出口的序列化结果里不得出现明文
    expect(JSON.stringify(listProviders())).not.toContain(CREATE.apiKey);
  });

  it('落盘的是明文密钥（服务端要拿原 token 代调上游），出口已掩码', () => {
    const created = createProvider(CREATE);

    expect(stored(created.id)?.apiKey).toBe(CREATE.apiKey);
    expect(created.apiKeyMasked).not.toBe(CREATE.apiKey);
  });

  it('id 是 UUID v4，createdAt / updatedAt 是 ISO 8601 带时区字符串且初始相等', () => {
    const created = createProvider(CREATE);

    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(created.createdAt).toBe(created.updatedAt);
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
  });

  it('新建时带的模型清单一律归一成 manual，并去掉空白项与重复项', () => {
    // `fetched` 的唯一合法来源是一次真实的拉取调用：允许客户端在新建时声明 fetched，
    // 用户手工填的模型就会在下次拉取时被按「已下架」静默清掉（§6.1 合并而非覆盖要防的正是这个）。
    const created = createProvider({
      ...CREATE,
      models: [
        { id: 'm1', source: 'fetched' },
        { id: ' m1 ', source: 'manual' },
        { id: '', source: 'manual' },
        { id: 'm2', source: 'manual' },
      ],
    });

    expect(created.models).toEqual([
      { id: 'm1', source: 'manual' },
      { id: 'm2', source: 'manual' },
    ]);
  });
});

describe('updateProvider', () => {
  it('只改传入的字段，其余保持原值', () => {
    const created = createProvider(CREATE);

    const next = updateProvider(created.id, { name: '改过的名字' });

    expect(next.name).toBe('改过的名字');
    expect(next.protocolType).toBe(CREATE.protocolType);
    expect(next.baseUrl).toBe(CREATE.baseUrl);
    expect(stored(created.id)?.name).toBe('改过的名字');
  });

  // ProviderPatch 的每个字段都是 `T | undefined`（ProviderCreateSchema.partial()），所以
  // `{ ...provider, ...patch }` 这种写法会把存量字段覆盖成 undefined 后落盘 ——
  // 坏值不在这次响应里，而在**下一次读取**，于是表现为「打开设置页供应商就少了一列」。
  it('显式传 undefined 的补丁不把存量字段覆盖成 undefined', () => {
    const created = createProvider(CREATE);

    const next = updateProvider(created.id, { name: undefined, baseUrl: undefined });

    expect(next.name).toBe(CREATE.name);
    expect(next.baseUrl).toBe(CREATE.baseUrl);
    expect(stored(created.id)?.baseUrl).toBe(CREATE.baseUrl);
  });

  it('不传或传空串的 apiKey 都保留原密钥（掩码不变）', () => {
    const created = createProvider(CREATE);

    const renamed = updateProvider(created.id, { name: '改名了' });
    expect(renamed.apiKeyMasked).toBe(created.apiKeyMasked);
    expect(stored(created.id)?.apiKey).toBe(CREATE.apiKey);

    // 空串是「编辑弹窗留空」的真实取值：写进去等于把用户配好的密钥抹掉，此后所有代调都是 401
    const emptied = updateProvider(created.id, { apiKey: '' });
    expect(emptied.apiKeyMasked).toBe(created.apiKeyMasked);
    expect(stored(created.id)?.apiKey).toBe(CREATE.apiKey);
  });

  it('给了非空 apiKey 时替换，掩码随之变化', () => {
    const created = createProvider(CREATE);

    const next = updateProvider(created.id, { apiKey: 'sk-zzzzzzzzzzzz' });

    expect(stored(created.id)?.apiKey).toBe('sk-zzzzzzzzzzzz');
    expect(next.apiKeyMasked).toBe(maskApiKey('sk-zzzzzzzzzzzz'));
    expect(next.apiKeyMasked).not.toBe(created.apiKeyMasked);
  });

  it('更新推进 updatedAt 且不动 createdAt（用假时钟，不依赖真实耗时）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T10:00:00.000Z'));
    const created = createProvider(CREATE);
    vi.setSystemTime(new Date('2026-09-22T10:05:00.000Z'));

    const next = updateProvider(created.id, { name: 'x' });

    expect(next.createdAt).toBe('2026-09-22T10:00:00.000Z');
    expect(next.updatedAt).toBe('2026-09-22T10:05:00.000Z');
  });

  it('不存在的 id 抛 NOT_FOUND', () => {
    let caught: unknown;
    try {
      updateProvider('nope', { name: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });
});

describe('deleteProvider', () => {
  it('删除后列表里不再有它', () => {
    const created = createProvider(CREATE);

    deleteProvider(created.id);

    expect(listProviders()).toEqual([]);
  });

  it('不存在的 id 抛 NOT_FOUND（而不是静默成功）', () => {
    let caught: unknown;
    try {
      deleteProvider('nope');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });

  // 删供应商**不**级联改写 settings.defaultJudge：那会把「删一个供应商」变成一次跨域事务
  //（要在同一次保存里改动另一块配置）。悬空引用由设置页显式提示（Task 6），
  // 并在评分时由 resolveJudgeRoute 兜底报错。这条用例把这个决定钉住。
  it('删除供应商不改写 settings.defaultJudge（悬空引用留给设置页提示）', () => {
    const created = createProvider(CREATE);
    updateSettings({ defaultJudge: { providerId: created.id, modelId: 'm1' } });

    deleteProvider(created.id);

    expect(loadConfig().settings.defaultJudge).toEqual({ providerId: created.id, modelId: 'm1' });
  });
});

describe('addProviderModel / removeProviderModel', () => {
  it('手工添加的条目标记为 manual，并落盘', () => {
    const created = createProvider(CREATE);

    const next = addProviderModel(created.id, 'deepseek-chat');

    expect(next.models).toEqual([{ id: 'deepseek-chat', source: 'manual' }]);
    expect(stored(created.id)?.models).toEqual([{ id: 'deepseek-chat', source: 'manual' }]);
  });

  it('重复添加同 id 是幂等的：不新增、不改来源', () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');

    const next = addProviderModel(created.id, 'm1');

    expect(next.models).toEqual([{ id: 'm1', source: 'manual' }]);
  });

  it('添加时去掉首尾空白；纯空白串被拒（INVALID_QUERY）', () => {
    const created = createProvider(CREATE);

    expect(addProviderModel(created.id, '  m1  ').models).toEqual([{ id: 'm1', source: 'manual' }]);

    let caught: unknown;
    try {
      addProviderModel(created.id, '   ');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INVALID_QUERY');
  });

  it('删除一条只删那一条', () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');
    addProviderModel(created.id, 'm2');

    const next = removeProviderModel(created.id, 'm1');

    expect(next.models).toEqual([{ id: 'm2', source: 'manual' }]);
    expect(stored(created.id)?.models).toEqual([{ id: 'm2', source: 'manual' }]);
  });

  // 静默成功会让「删除没生效」看起来像界面 bug，而真正的原因（id 传错、模型早已被拉取覆盖掉）
  // 反而被藏起来。
  it('删除不存在的模型抛 NOT_FOUND', () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');

    let caught: unknown;
    try {
      removeProviderModel(created.id, 'nope');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    expect(stored(created.id)?.models).toEqual([{ id: 'm1', source: 'manual' }]);
  });
});

describe('listAllModelOptions', () => {
  // 评分走纯文本 API、不经过智能体（F3 / §6.2），所以 anthropic 协议的模型和 openai 协议的一样可选：
  // 这里刻意不做协议过滤。过滤掉一半候选，等于把「默认评分模型」的选择面砍掉一半。
  it('两种协议的模型都出现', () => {
    const openai = createProvider({ ...CREATE, name: 'A 网关', protocolType: 'openai' });
    const anthropic = createProvider({
      ...CREATE,
      name: 'B 网关',
      protocolType: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
    });
    addProviderModel(openai.id, 'deepseek-chat');
    addProviderModel(anthropic.id, 'claude-sonnet-5');

    const options = listAllModelOptions();

    expect(options.map((option) => `${option.providerName}/${option.modelId}:${option.protocolType}`)).toEqual([
      'A 网关/deepseek-chat:openai',
      'B 网关/claude-sonnet-5:anthropic',
    ]);
    expect(options[0]).toEqual({
      providerId: openai.id,
      providerName: 'A 网关',
      protocolType: 'openai',
      modelId: 'deepseek-chat',
      source: 'manual',
    });
  });

  it('一个供应商都没有时返回空数组（不是 undefined）', () => {
    expect(listAllModelOptions()).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test`
Expected: FAIL —— 收集阶段即失败：`Failed to resolve import "./providers" from "src/providers.test.ts"`。

- [ ] **Step 3: 写最小实现 `packages/server/api/src/providers.ts`**

```ts
/**
 * 供应商服务：CRUD + 模型清单手工维护 + 全部模型候选（评分配置用）。
 * 自动拉取（/models）在下一个任务里追加到本文件末尾——两者共用同一份清单与同一套落盘口径。
 *
 * 三条不可动摇的口径：
 *   1. **明文密钥只进不出**：落盘的 `Provider.apiKey` 是明文（服务端必须拿原 token 才能代调上游），
 *      但任何对外返回值一律是 `ProviderView` —— 只有 `apiKeyMasked`，没有 `apiKey` 字段；
 *   2. **模型清单的来源只有两个**：手工增删（`source: 'manual'`）与拉取（`source: 'fetched'`），
 *      拉取的合并规则见 `fetchProviderModels`（不冲掉手工条目）；
 *   3. **删除供应商不级联改写 `settings.defaultJudge` 与用例的评分模型**：那会把「删一个供应商」
 *      变成一次跨域事务；悬空引用由设置页显式提示、由评分路由解析时报错兜底。
 *
 * 密钥的安全取舍（spec §6.1 末段，必须留在代码里）：服务端需要原 token 才能代调供应商 API，
 * 无法只存哈希；缓解措施是配置文件写盘时 `chmod 0600`（属主独占，见 core 的 `saveConfig`）
 * 加上对外出口一律掩码。Windows 无 POSIX 权限位，`chmod` 仅能近似切换只读位，
 * 属主独占实际由 NTFS ACL 与用户目录隔离承担 —— 尽力而为、失败不报错、不阻断保存。
 */
import { randomUUID } from 'node:crypto';
import {
  ServiceError,
  maskApiKey,
  type Provider,
  type ProviderCreate,
  type ProviderPatch,
  type ProviderView,
  type ProtocolType,
} from '@aieval/contracts';
import { createLogger, getConfigDir, loadConfig, saveConfig, type AppConfig } from '@aieval/core';

const log = createLogger('api/providers');

/** 落盘 → 下行：剥掉明文密钥、只留掩码。**唯一**的下行出口，所有函数都必须经它返回 */
function toView(provider: Provider): ProviderView {
  const { apiKey, ...rest } = provider;
  return { ...rest, apiKeyMasked: maskApiKey(apiKey) };
}

/** 取错误的人类可读原因（error 不一定是 Error） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 保存整份配置。saveConfig 会抛原始 errno（EPERM / ENOSPC / 只读盘），而契约要求对外错误
 * 一律是可直接展示的中文原因 —— 这里折成 INTERNAL 并带上配置目录，
 * 否则路由层会把英文 errno 原文回给用户（排查方向也被带偏）。
 */
function persist(config: AppConfig): void {
  try {
    saveConfig(config);
  } catch (error) {
    throw error instanceof ServiceError
      ? error
      : new ServiceError('INTERNAL', `供应商配置保存失败（${getConfigDir()}）：${reason(error)}`, { cause: error });
  }
}

/** 按 id 取供应商（含明文密钥，仅服务端内部使用）；不存在抛 NOT_FOUND */
function requireProvider(config: AppConfig, providerId: string): Provider {
  const provider = config.providers.find((item) => item.id === providerId);
  if (provider === undefined) {
    throw new ServiceError('NOT_FOUND', `供应商不存在：${providerId}`);
  }
  return provider;
}

/** 写回单条供应商并落盘 */
function replaceProvider(config: AppConfig, next: Provider): void {
  config.providers = config.providers.map((item) => (item.id === next.id ? next : item));
  persist(config);
}

/**
 * 归一化一批模型 id：去首尾空白、去重（按首次出现顺序），来源一律 `manual`。
 * 为什么来源不能由调用方给：`fetched` 的唯一合法来源是一次真实的拉取调用 ——
 * 允许在这里声明 fetched，用户手工填的模型就会在下一次拉取里被按「上游已下架」清掉。
 */
function manualModels(ids: readonly string[]): Provider['models'] {
  const seen = new Set<string>();
  const models: Provider['models'] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, source: 'manual' });
  }
  return models;
}

export function listProviders(): ProviderView[] {
  return loadConfig().providers.map(toView);
}

export function createProvider(input: ProviderCreate): ProviderView {
  const config = loadConfig();
  const now = new Date().toISOString();
  const provider: Provider = {
    id: randomUUID(),
    name: input.name,
    protocolType: input.protocolType,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    models: manualModels(input.models.map((model) => model.id)),
    createdAt: now,
    updatedAt: now,
  };
  config.providers = [...config.providers, provider];
  persist(config);
  log.info('供应商已创建', {
    providerId: provider.id,
    protocolType: provider.protocolType,
    models: provider.models.length,
  });
  return toView(provider);
}

export function updateProvider(providerId: string, patch: ProviderPatch): ProviderView {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);
  const next: Provider = {
    id: provider.id,
    createdAt: provider.createdAt,
    updatedAt: new Date().toISOString(),
    // 逐字段 `??` 合并，**不能写成 `{ ...provider, ...patch }`**：ProviderPatch 的每个字段都是
    // `T | undefined`（ProviderCreateSchema.partial()），显式传 undefined 的补丁会在展开时
    // 把存量字段覆盖成 undefined 后落盘 —— 坏值不在这次响应里，而在下一次读取。
    name: patch.name ?? provider.name,
    protocolType: patch.protocolType ?? provider.protocolType,
    baseUrl: patch.baseUrl ?? provider.baseUrl,
    // 密钥只在补丁给了**非空**值时替换：编辑弹窗里「留空表示不修改」，把空串写进去等于
    // 把用户已配好的密钥抹掉 —— 此后所有代调都是 401，而界面上只剩一个空掩码。
    apiKey: patch.apiKey !== undefined && patch.apiKey !== '' ? patch.apiKey : provider.apiKey,
    // 模型清单的整份替换在这里是允许的（契约里 models 是补丁字段），但设置页不发这个字段 ——
    // 清单的日常增删走 addProviderModel / removeProviderModel，那里才带「保留手工条目」的语义。
    models: patch.models ?? provider.models,
  };
  replaceProvider(config, next);
  // 只记「密钥是否变过」，绝不把密钥本身写进日志
  log.info('供应商已更新', { providerId, apiKeyChanged: next.apiKey !== provider.apiKey });
  return toView(next);
}

export function deleteProvider(providerId: string): void {
  const config = loadConfig();
  // 不存在就抛 NOT_FOUND：静默成功会掩盖前端把 id 传错这类问题
  requireProvider(config, providerId);
  config.providers = config.providers.filter((item) => item.id !== providerId);
  persist(config);
  log.info('供应商已删除', { providerId });
}

export function addProviderModel(providerId: string, modelId: string): ProviderView {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);
  const [normalized] = manualModels([modelId]);
  if (normalized === undefined) {
    throw new ServiceError('INVALID_QUERY', '模型名不能为空');
  }
  // 同 id 已存在时原样返回（幂等）：不改它的 source、不产生重复条目。
  // 把已存在的条目改写成 manual 看似无害，实际会把「上次拉取到的条目」变成永久的手工条目 ——
  // 之后上游下架该模型，清单里也再清不掉它。
  if (provider.models.some((model) => model.id === normalized.id)) {
    return toView(provider);
  }
  const next: Provider = {
    ...provider,
    models: [...provider.models, normalized],
    updatedAt: new Date().toISOString(),
  };
  replaceProvider(config, next);
  log.info('模型已手工添加', { providerId, modelId: normalized.id });
  return toView(next);
}

export function removeProviderModel(providerId: string, modelId: string): ProviderView {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);
  const models = provider.models.filter((model) => model.id !== modelId);
  if (models.length === provider.models.length) {
    throw new ServiceError('NOT_FOUND', `该供应商下没有模型：${modelId}`);
  }
  const next: Provider = { ...provider, models, updatedAt: new Date().toISOString() };
  replaceProvider(config, next);
  log.info('模型已移除', { providerId, modelId });
  return toView(next);
}

/**
 * 全部可选的评分模型（**两种协议都要**，spec §4.2 / §6.2）：评分走纯文本 API、不经过智能体，
 * 因此 anthropic 协议的模型与 openai 协议的一样可选 —— 这里刻意不做协议过滤。
 * 消费方是服务端（用例表单的候选池、评测行的校验）；设置页的 Select 直接由 `ProviderView[]`
 * 在前端派生，不为本函数开 HTTP 路由（见「本计划对 spec / 契约的实现层修正」第 5 条）。
 */
export function listAllModelOptions(): {
  providerId: string;
  providerName: string;
  protocolType: ProtocolType;
  modelId: string;
  source: 'fetched' | 'manual';
}[] {
  return loadConfig().providers.flatMap((provider) =>
    provider.models.map((model) => ({
      providerId: provider.id,
      providerName: provider.name,
      protocolType: provider.protocolType,
      modelId: model.id,
      source: model.source,
    })),
  );
}
```

- [ ] **Step 4: 追加 `src/index.ts` 的出口**

```ts
/** api 公共出口：业务服务层，框架层只从这里 import。 */
export { getSettings, updateSettings } from './settings';
export {
  addProviderModel,
  createProvider,
  deleteProvider,
  listAllModelOptions,
  listProviders,
  removeProviderModel,
  updateProvider,
} from './providers';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test`
Expected: PASS（`providers.test.ts` 共 5 个 `describe` / 20 个 `it` 全绿；`settings.test.ts` 也仍然全绿）。

Run: `pnpm typecheck`
Expected: 通过（8 个包零错误）。

- [ ] **Step 6: 提交**

```bash
git add packages/server/api/src/providers.ts packages/server/api/src/providers.test.ts packages/server/api/src/index.ts
git commit -m "feat(api): 供应商 CRUD 与模型清单手工维护（明文密钥只进不出 + 空串密钥不覆盖）"
```

- [ ] **Step 7: 变异验证①：掩码出口的守卫**

这条断言（`expect('apiKey' in created).toBe(false)`）是「明文密钥只进不出」唯一的守卫，必须亲眼见它失败一次。

先把当前实现哈希记下来：

```bash
git hash-object packages/server/api/src/providers.ts
```

制造变异体（改实现、不改测试）：把 `toView` 换成保留明文密钥的写法 ——

```ts
/** 变异体：直接把落盘对象摊开，apiKey 跟着一起出去 */
function toView(provider: Provider): ProviderView {
  return { ...provider, apiKeyMasked: maskApiKey(provider.apiKey) } as ProviderView;
}
```

Run: `pnpm --filter @aieval/api test`
Expected: FAIL，形如：

```
FAIL  src/providers.test.ts > listProviders / createProvider > 新建后能列出，且下行对象只有掩码、没有 apiKey 这个键
AssertionError: expected true to be false
 ❯ src/providers.test.ts:70:32
```

（期望输出里的行号取决于那条断言在 `providers.test.ts` 里的实际位置；报错信息与断言内容对得上即算通过。若先失败在同一个用例里的 `JSON.stringify(listProviders())` 那条，同样是这条守卫在开火，两者任一即算通过。）

还原变异体，再核对哈希：

```bash
git hash-object packages/server/api/src/providers.ts   # 必须与变异前记录的值逐字符相同
pnpm --filter @aieval/api test                          # 必须重新全绿
```

---

## Task 2: `api` —— `/models` 自动拉取（合并而非覆盖 + Anthropic 服务端拒绝）

**Files:**
- Modify: `packages/server/api/src/providers.ts`（在 Task 1 的文件末尾追加一段）
- Modify: `packages/server/api/src/providers.test.ts`（在文件末尾追加两组 `describe`）
- Modify: `packages/server/api/src/index.ts`（追加 `fetchProviderModels`）

**Interfaces:**
- Consumes: Task 1 的 `requireProvider` / `replaceProvider` / `toView` / `reason`；`ProviderModel`（来自 contracts）。
- Produces: `fetchProviderModels(providerId: string): Promise<ProviderView>`（契约 §6 写作同步返回，见「实现层修正」第 1 条）。
- 任务内部（不导出）：`ModelsPayload` / `hostOf` / `extractModelIds` / `upstreamError` / `readJson`，以及测试内部的 `stubUpstream`。

- [ ] **Step 1: 写失败测试（追加到 `providers.test.ts` 末尾）**

```ts
// ─────────────────────────── /models 自动拉取 ───────────────────────────

/**
 * 假上游：只认 /models，返回给定响应。
 * 测试绝不打真实网络 —— 拉模型是本计划唯一会对外发 HTTP 的地方，一次真实调用会让用例
 * 依赖外部服务、还会把用户的密钥送到真实网关。
 *
 * 为什么它不会污染其它用例：`vi.stubGlobal` 改的是本 worker 的 globalThis，文件末尾的
 * `afterEach` 会 `vi.unstubAllGlobals()` 立刻还原；vitest 默认每个测试文件一个进程，
 * 同文件内的用例也都显式 stub 自己需要的那一份。不 stub 的用例（CRUD 那些）压根不触发网络。
 */
function stubUpstream(body: string | unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 取一次 fetch 调用的 [url, init]，断言时用 */
function firstCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit];
}

describe('fetchProviderModels：请求形状', () => {
  it('请求照 Authorization: Bearer <key> 发，URL 是 {baseUrl}/models（尾斜杠不重复）', async () => {
    const created = createProvider({ ...CREATE, baseUrl: 'https://api.deepseek.com/v1/' });
    const fetchMock = stubUpstream({ data: [{ id: 'm1' }] });

    await fetchProviderModels(created.id);

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('https://api.deepseek.com/v1/models');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${CREATE.apiKey}`);
  });

  it('供应商不存在抛 NOT_FOUND，且一次请求都不发', async () => {
    const fetchMock = stubUpstream({ data: [] });

    await expect(fetchProviderModels('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchProviderModels：Anthropic 协议的服务端拒绝', () => {
  // F1 / §6.1：Anthropic 协议没有 /models 接口。按钮禁用只是体验，老页面缓存、直接打接口
  // 都绕得过去 —— 那一绕就会往一个不存在的地址发请求，拿到 404 的 HTML 再被当成模型清单解析。
  // 所以拒绝必须在服务端，并且**一次网络都不发**。
  it('anthropic 协议拒绝拉取：INVALID_QUERY + 中文原因，且 fetch 未被调用', async () => {
    const created = createProvider({
      ...CREATE,
      protocolType: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
    });
    const fetchMock = stubUpstream({ data: [{ id: '不该被读到' }] });

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_QUERY');
    expect((caught as ServiceError).message).toContain('没有 /models 接口');
    expect(fetchMock).not.toHaveBeenCalled();
    // 被拒的调用不动清单
    expect(stored(created.id)?.models).toEqual([]);
  });

  it('openai 协议照常拉取（对照组：证明拒绝来自协议而不是「拉取整体坏了」）', async () => {
    const created = createProvider(CREATE);
    stubUpstream({ data: [{ id: 'm1' }] });

    await fetchProviderModels(created.id);

    expect(stored(created.id)?.models).toEqual([{ id: 'm1', source: 'fetched' }]);
  });
});

describe('fetchProviderModels：合并而非覆盖', () => {
  // §6.1 的两个实现要点之一，也是本计划最重要的回归守卫：手工补的模型每次拉取都丢，
  // 用户会以为是「界面没保存」，而实际上是被 fetched 结果整体冲掉了。
  it('手工条目原样保留（顺序在前、source 不变），新 id 追加为 fetched', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');
    addProviderModel(created.id, 'm2');
    stubUpstream({ data: [{ id: 'm1' }, { id: 'm3' }] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([
      { id: 'm1', source: 'manual' },
      { id: 'm2', source: 'manual' },
      { id: 'm3', source: 'fetched' },
    ]);
    expect(stored(created.id)?.models).toEqual(next.models);
  });

  it('上一轮 fetched 的条目这次没再返回时被清掉，手工条目照旧留下', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'manual-keep');
    await fetchProviderModelsWith(created.id, [{ id: 'stale' }, { id: 'keep' }]);
    stubUpstream({ data: [{ id: 'keep' }] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([
      { id: 'manual-keep', source: 'manual' },
      { id: 'keep', source: 'fetched' },
    ]);
  });

  it('拉取结果里与手工条目同 id 的条目不会把它顶掉、也不会出现两条', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');
    stubUpstream({ data: [{ id: 'm1' }] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([{ id: 'm1', source: 'manual' }]);
  });

  it('重复 id 在 fetched 集合里去重', async () => {
    const created = createProvider(CREATE);
    stubUpstream({ data: [{ id: 'm1' }, { id: 'm1' }, { id: 'm1' }] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([{ id: 'm1', source: 'fetched' }]);
  });
});

describe('fetchProviderModels：响应解析容错', () => {
  it('同时容忍 data[].id 与 data 为字符串数组两种形态', async () => {
    const created = createProvider(CREATE);
    stubUpstream({ data: [{ id: 'obj-form' }, 'str-form', { id: '' }, null, 42, {}] });

    const next = await fetchProviderModels(created.id);

    // 认不出的元素被跳过，**不能**兜底成 String(entry)：那会把 'null' / '[object Object]' 当模型名存进去
    expect(next.models).toEqual([
      { id: 'obj-form', source: 'fetched' },
      { id: 'str-form', source: 'fetched' },
    ]);
  });

  it('data 缺失或不是数组时一条都认不出：报含 host 的中文原因，且不落盘', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'manual-keep');
    stubUpstream({ models: [{ id: 'm1' }] });

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('api.deepseek.com');
    expect((caught as ServiceError).message).toContain('没有可识别的模型');
    // 关键：空结果绝不覆盖已有清单，否则用户手工维护的模型会被一次异常响应清空
    expect(stored(created.id)?.models).toEqual([{ id: 'manual-keep', source: 'manual' }]);
  });

  it('响应体不是合法 JSON（网关返回登录页 HTML）时报中文原因且不落盘', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'manual-keep');
    stubUpstream('<html>请先登录</html>');

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('不是合法 JSON');
    expect(stored(created.id)?.models).toEqual([{ id: 'manual-keep', source: 'manual' }]);
  });
});

describe('fetchProviderModels：上游错误码映射', () => {
  it('401 映射 AUTH_FAILED 且 context 带 host（界面据此指向设置页）', async () => {
    const created = createProvider(CREATE);
    stubUpstream({ error: 'bad key' }, 401);

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('AUTH_FAILED');
    expect((caught as ServiceError).context).toEqual({ host: 'api.deepseek.com' });
    expect((caught as ServiceError).message).toContain('API 密钥');
  });

  it('429 映射 RATE_LIMITED', async () => {
    const created = createProvider(CREATE);
    stubUpstream({ error: 'slow down' }, 429);

    await expect(fetchProviderModels(created.id)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('其余状态码映射 INTERNAL 并带上状态码与 host', async () => {
    const created = createProvider(CREATE);
    stubUpstream('<html>502 Bad Gateway</html>', 502);

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('502');
    expect((caught as ServiceError).message).toContain('api.deepseek.com');
  });

  it('连不上时映射 INTERNAL 且 message 含 host（baseUrl 不是合法 URL 时也不抛第二个错）', async () => {
    const created = createProvider({ ...CREATE, baseUrl: '不是一个地址' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('不是一个地址');
  });
});
```

同时，在 `describe('fetchProviderModels：合并而非覆盖')` 之前补一个测试内的小助手（函数声明会提升，放哪都能用，但放在使用它的 `describe` 之前最好读），让「先跑一次拉取把 fetched 条目铺进去」这件事只有一处写法：

```ts
/** 跑一次拉取并丢弃结果：用于把上一轮的 fetched 条目铺进清单 */
async function fetchProviderModelsWith(providerId: string, data: unknown[]): Promise<void> {
  stubUpstream({ data });
  await fetchProviderModels(providerId);
  vi.unstubAllGlobals();
}
```

并在上面那段 import 里补一行（`fetchProviderModels` 与 Task 1 的七个函数从同一个模块导出）：

```ts
import { fetchProviderModels } from './providers';
```

以及 `afterEach` 里补一句还原全局（`fetch` 桩必须每个用例后还原，否则会漏给同文件后面「不该发请求」的断言）：

```ts
afterEach(() => {
  // 顺序要紧：先复位再删目录，否则万一删目录抛错，覆盖值会漏给下一个文件
  setConfigDirForTesting(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test`
Expected: FAIL —— 链接阶段报该导出不存在，形如：

```
SyntaxError: The requested module '/src/providers.ts' does not provide an export named 'fetchProviderModels'
```

（vitest 的措辞可能是 `[vitest] No "fetchProviderModels" export is defined on the "./providers" mock` 一类；只要指名道姓说这个导出拿不到，就是我们想要的「先失败」。）

- [ ] **Step 3: 写实现（追加到 `packages/server/api/src/providers.ts` 末尾）**

```ts
/** 上游 /models 响应的最小形状：只声明我们真正读的字段（字段名并不统一，见 extractModelIds） */
interface ModelsPayload {
  data?: unknown;
}

/** 取 host 用于错误文案：baseUrl 可能根本不是合法 URL（用户填错），取不到就回落整串 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 从 /models 响应里抽出模型 id。
 * 为什么要容忍两种形态（spec §6.1 第 1 点）：不同供应商与自建网关返回的字段并不一致 ——
 * 既有 `{ data: [{ id: 'a' }] }`，也有 `{ data: ['a', 'b'] }`。
 * 判空用 trim，但入库的是**原串**：模型名是要发给上游的标识符，服务端不替它做规范化。
 */
function extractModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as ModelsPayload).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry): string[] => {
    if (typeof entry === 'string') return entry.trim() === '' ? [] : [entry];
    if (typeof entry === 'object' && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id.trim() !== '') return [id];
    }
    // 既不是字符串、也没有可用的 id（null / 数字 / {}）：跳过。
    // 关键是**不能**兜底成 String(entry)，那会把 'null' / '[object Object]' 当成模型名存进去。
    return [];
  });
}

/** 读上游 JSON：解析失败要给含 host 的中文原因（网关返回登录页 HTML 是常见情形），而不是抛 SyntaxError */
async function readJson(res: Response, url: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (error) {
    throw new ServiceError(
      'INTERNAL',
      `拉取模型失败：${hostOf(url)} 返回的不是合法 JSON（可能被网关或登录页拦截）`,
      { cause: error },
    );
  }
}

/**
 * 上游非 2xx → 契约错误码：401/403 → AUTH_FAILED（context 带 host），
 * 429 → RATE_LIMITED（§10 要求限流提示改用串行），其余 INTERNAL 并带上状态码与 host。
 */
async function upstreamError(res: Response, url: string): Promise<ServiceError> {
  const host = hostOf(url);
  if (res.status === 401 || res.status === 403) {
    return new ServiceError('AUTH_FAILED', `${host} 拒绝了该密钥（HTTP ${res.status}），请到设置里检查 API 密钥`, {
      context: { host },
    });
  }
  if (res.status === 429) {
    return new ServiceError('RATE_LIMITED', `${host} 触发限流（HTTP 429），请稍后重试`, { context: { host } });
  }
  // 上游正文可能是一整页 HTML：只留前 200 字，避免把登录页塞进界面
  const detail = await res.text().catch(() => '');
  const suffix = detail === '' ? '' : `：${detail.slice(0, 200)}`;
  return new ServiceError('INTERNAL', `拉取模型失败：${host} 返回 HTTP ${res.status}${suffix}`);
}

/**
 * 拉取供应商的模型清单并**合并**进现有清单（spec §6.1 的两个实现要点）。
 *
 * 合并规则（三条，缺一条都会丢用户的数据）：
 *   - `source: 'manual'` 的条目**原样保留**（位置在前、来源不变），拉取结果里同 id 的条目不会顶掉它；
 *   - 上一轮 `fetched` 的条目这次没再返回，视为上游已下架，清掉 —— 这才是「刷新」的语义；
 *   - 其余新 id 追加为 `fetched`。
 *
 * 返回 `Promise<ProviderView>`：契约 §6 把本函数写成同步返回，但它必须发一次 HTTP 请求，
 * 只能是异步（契约 §7 的客户端 `fetchModels` 也返回 Promise）。不改名、不改参数，只把返回值包成 Promise。
 *
 * 为什么 Anthropic 协议在这里直接拒绝、而不是只靠前端禁用按钮：按钮禁用只是体验，
 * 老页面缓存 / 直接打接口都绕得过去 —— 那一绕就会往一个没有 /models 的地址发请求，
 * 拿到 404 的 HTML 再被当成模型清单解析（F1 / §6.1）。
 */
export async function fetchProviderModels(providerId: string): Promise<ProviderView> {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);

  if (provider.protocolType === 'anthropic') {
    throw new ServiceError('INVALID_QUERY', 'Anthropic 兼容协议没有 /models 接口，模型清单请手工维护');
  }

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`;
  // 只记 URL，不记密钥
  log.debug('拉取模型清单', { providerId, url });

  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${provider.apiKey}` } });
  } catch (error) {
    throw new ServiceError('INTERNAL', `拉取模型失败：无法连接 ${hostOf(url)}（${reason(error)}）`, { cause: error });
  }
  if (!res.ok) {
    throw await upstreamError(res, url);
  }

  const ids = extractModelIds(await readJson(res, url));
  if (ids.length === 0) {
    // 一条都认不出时**不落盘**：把空清单写回去会静默清掉用户手工维护的模型，
    // 而「上游这次返回了空」与「我们没看懂它的响应」在界面上完全无法区分（§10）。
    throw new ServiceError(
      'INTERNAL',
      `拉取模型失败：${hostOf(url)} 的响应里没有可识别的模型（data 字段缺失或为空）`,
    );
  }

  const manual = provider.models.filter((model) => model.source === 'manual');
  const manualIds = new Set(manual.map((model) => model.id));
  const fetchedIds = [...new Set(ids)].filter((id) => !manualIds.has(id));
  const next: Provider = {
    ...provider,
    models: [...manual, ...fetchedIds.map((id) => ({ id, source: 'fetched' as const }))],
    updatedAt: new Date().toISOString(),
  };
  replaceProvider(config, next);
  log.info('模型清单已更新', { providerId, manual: manual.length, fetched: fetchedIds.length });
  return toView(next);
}
```

- [ ] **Step 4: 追加 `src/index.ts` 的出口**

把 `fetchProviderModels` 按字母序插进 Task 1 那段导出里：

```ts
/** api 公共出口：业务服务层，框架层只从这里 import。 */
export { getSettings, updateSettings } from './settings';
export {
  addProviderModel,
  createProvider,
  deleteProvider,
  fetchProviderModels,
  listAllModelOptions,
  listProviders,
  removeProviderModel,
  updateProvider,
} from './providers';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test`
Expected: PASS（`providers.test.ts` 共 10 个 `describe` / 35 个 `it` 全绿 —— 本任务新增 5 个 `describe` / 15 个 `it`）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/server/api/src/providers.ts packages/server/api/src/providers.test.ts packages/server/api/src/index.ts
git commit -m "feat(api): 拉取上游 /models 并合并清单（手工条目不被冲掉 + Anthropic 协议服务端拒绝）"
```

- [ ] **Step 7: 变异验证②：合并而非覆盖**

记录哈希：`git hash-object packages/server/api/src/providers.ts`

制造变异体（把合并改成整体替换 —— 这正是「用户手工补的模型每次拉取都会丢」那个缺陷）：

```ts
  // 变异体：丢掉 manual，整体替换成这次拉到的
  const models = [...new Set(ids)].map((id) => ({ id, source: 'fetched' as const }));
```

Run: `pnpm --filter @aieval/api test`
Expected: FAIL，形如：

```
FAIL  src/providers.test.ts > fetchProviderModels：合并而非覆盖 > 手工条目原样保留（顺序在前、source 不变），新 id 追加为 fetched
AssertionError: expected [ { id: 'm3', source: 'fetched' } ] to deeply equal [ { id: 'm1', source: 'manual' }, { id: 'm2', source: 'manual' }, { id: 'm3', source: 'fetched' } ]

- Expected
+ Received

  Array [
-   Object { "id": "m1", "source": "manual" },
-   Object { "id": "m2", "source": "manual" },
    Object { "id": "m3", "source": "fetched" },
  ]
```

（同一变异体还会带倒「拉取结果里与手工条目同 id 的条目不会把它顶掉」与「上一轮 fetched 被清掉、手工条目照旧留下」两条 —— 都应一起失败。只失败一条说明另外两条的断言没有区分力，要回来把它们写成可观测的差异。）

还原并核对哈希与用例：

```bash
git hash-object packages/server/api/src/providers.ts   # 必须与变异前记录的值逐字符相同
pnpm --filter @aieval/api test                          # 必须重新全绿
```

- [ ] **Step 8: 变异验证③：Anthropic 协议的服务端拒绝**

记录哈希：`git hash-object packages/server/api/src/providers.ts`

制造变异体（删掉整段协议判定，让流程直接往下走去发请求）：

```ts
  // 变异体：去掉协议判定
  // if (provider.protocolType === 'anthropic') {
  //   throw new ServiceError('INVALID_QUERY', 'Anthropic 兼容协议没有 /models 接口，模型清单请手工维护');
  // }
```

Run: `pnpm --filter @aieval/api test`
Expected: FAIL，形如：

```
FAIL  src/providers.test.ts > fetchProviderModels：Anthropic 协议的服务端拒绝 > anthropic 协议拒绝拉取：INVALID_QUERY + 中文原因，且 fetch 未被调用
AssertionError: expected undefined to be an instance of ServiceError
```

（变异体下函数没有抛错，`caught` 仍是 `undefined`，用例在第一条断言就失败；把断言顺序换成先查 `expect(fetchMock).not.toHaveBeenCalled()` 也能看到第二条开火 —— 请求确实发出去了，这正是这条守卫要拦的事。）

还原，再核对：

```bash
git hash-object packages/server/api/src/providers.ts   # 与记录值逐字符相同
pnpm --filter @aieval/api test                          # 重新全绿
```

---

## Task 3: `client` —— 供应商 hooks（列表 + CRUD + 模型清单 + 拉取）

**Files:**
- Create: `packages/client/client/src/providers.ts`
- Create: `packages/client/client/src/providers.test.tsx`
- Modify: `packages/client/client/src/index.ts:1-3`（追加一段导出）

**Interfaces:**
- Consumes: 脚手架已有的 `./http` 的 `getJson` / `postJson` / `putJson` / `delJson`；contracts 的 `ProviderView` / `ProviderCreate` / `ProviderPatch`。
- Produces（签名逐字来自契约 §7）：
  - `useProviders(): { providers: ProviderView[] | undefined; error: unknown; isLoading: boolean; refresh: () => void }`
  - `useCreateProvider(): { create: (input: ProviderCreate) => Promise<ProviderView>; isCreating: boolean }`
  - `useUpdateProvider(): { update: (id: string, patch: ProviderPatch) => Promise<ProviderView>; isUpdating: boolean }`
  - `useDeleteProvider(): { remove: (id: string) => Promise<void>; isDeleting: boolean }`
  - `useFetchProviderModels(): { fetchModels: (id: string) => Promise<ProviderView>; isFetching: boolean }`
  - `useProviderModels(): { add: (id: string, modelId: string) => Promise<ProviderView>; remove: (id: string, modelId: string) => Promise<ProviderView>; isMutating: boolean }`
  - （任务内部、不导出）`LIST_KEY` / `modelsUrl` / `OkBody`

- [ ] **Step 1: 写失败测试 `providers.test.tsx`**

```tsx
/**
 * 供应商 hooks：列表读取与 refresh、增删改、模型清单增删、拉取，以及**mutation 后列表刷新**。
 *
 * 每个用例挂一份全新的 SWR 缓存：默认 cache 是模块级单例，沿用同一份会让第二个用例挂载时
 * 直接命中上一个用例的数据与在飞去重项，一次 GET 都不发（理由同 settings.test.tsx）。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ProviderView } from '@aieval/contracts';
import {
  useCreateProvider,
  useDeleteProvider,
  useFetchProviderModels,
  useProviderModels,
  useProviders,
  useUpdateProvider,
} from './providers';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 下行形态的供应商：只有掩码，没有 apiKey */
const VIEW: ProviderView = {
  id: 'p-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyMasked: 'sk-***mnop',
  models: [{ id: 'deepseek-chat', source: 'manual' }],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

const CREATE_INPUT = {
  name: 'DeepSeek 官方',
  protocolType: 'openai' as const,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-secret',
  models: [],
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** 造一个按方法分派的 fetch 桩，并记录每一次调用 */
function stubFetch(handlers: { list?: ProviderView[]; mutation?: ProviderView } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return json(handlers.list ?? [VIEW]);
    return json(handlers.mutation ?? VIEW);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('useProviders', () => {
  it('挂载后 GET /api/providers（cache key 就是真实路由）', async () => {
    const fetchMock = stubFetch();

    const { result } = renderHook(() => useProviders(), { wrapper });

    await waitFor(() => expect(result.current.providers).toBeDefined());
    expect(result.current.providers?.[0]?.name).toBe('DeepSeek 官方');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/providers');
  });

  it('refresh 再发一次 GET', async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useProviders(), { wrapper });
    await waitFor(() => expect(result.current.providers).toBeDefined());

    result.current.refresh();

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === undefined).length)
        .toBeGreaterThanOrEqual(2),
    );
  });
});

describe('useCreateProvider', () => {
  it('create 发 POST /api/providers，体里是四个字段 + 空清单', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useCreateProvider(), { wrapper });

    const created = await result.current.create(CREATE_INPUT);

    expect(created.id).toBe('p-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(CREATE_INPUT);
  });

  // 这条是本任务的核心守卫：mutation 若不刷新列表，新建的供应商在页面上「保存成功但列表里没有」。
  // 断言可观测结果（列表内容），不是断言「mutate 被调用过」——后者对任何实现都成立。
  it('create 成功后列表里出现新建的那条', async () => {
    let list: ProviderView[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return json(list);
      list = [VIEW];
      return json(VIEW);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => ({ list: useProviders(), create: useCreateProvider() }), { wrapper });
    await waitFor(() => expect(result.current.list.providers).toEqual([]));

    await result.current.create.create(CREATE_INPUT);

    await waitFor(() => expect(result.current.list.providers?.[0]?.id).toBe('p-1'));
  });
});

describe('useUpdateProvider / useDeleteProvider', () => {
  it('update 发 PUT /api/providers/{id}：id 进 URL、补丁进体', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useUpdateProvider(), { wrapper });

    await result.current.update('p-1', { name: '改名了' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ name: '改名了' });
  });

  it('remove 发 DELETE /api/providers/{id} 并返回 void', async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useDeleteProvider(), { wrapper });

    await expect(result.current.remove('p-1')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1');
    expect(init.method).toBe('DELETE');
  });
});

describe('useFetchProviderModels', () => {
  it('fetchModels 发 POST /api/providers/{id}/models/fetch', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useFetchProviderModels(), { wrapper });

    const view = await result.current.fetchModels('p-1');

    expect(view.models).toEqual(VIEW.models);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1/models/fetch');
    expect(init.method).toBe('POST');
  });
});

describe('useProviderModels', () => {
  it('add 发 POST /api/providers/{id}/models，体里是 { id, source: manual }', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useProviderModels(), { wrapper });

    await result.current.add('p-1', 'deepseek-reasoner');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1/models');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ id: 'deepseek-reasoner', source: 'manual' });
  });

  // 模型名里带 `/` `+` `#` 是常态（`vendor/model+x`）。不 encodeURIComponent 时
  // `#` 之后会被当片段丢掉、`+` 会被服务端解成空格 —— 表现是「点了删除没反应」或删错条目。
  it('remove 把 modelId 编码进 query（/ + # 都必须转义）', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useProviderModels(), { wrapper });

    await result.current.remove('p-1', 'vendor/model+x#1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1/models?modelId=vendor%2Fmodel%2Bx%231');
    expect(init.method).toBe('DELETE');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/client test`
Expected: FAIL —— 收集阶段报 `Failed to resolve import "./providers" from "src/providers.test.tsx"`。

- [ ] **Step 3: 写实现 `packages/client/client/src/providers.ts`**

```ts
/**
 * 供应商数据层：列表 + 增删改 + 模型清单增删 + /models 拉取。
 *
 * 回写约定与 settings.ts 同源，但有一处**刻意不同**：
 *   - 这些 mutation 一律**不开 `populateCache`**。后端返回的是**单个** `ProviderView`，而 mutation 的
 *     key 指向的是**列表**；把单个对象写进列表缓存，下一次渲染 `providers.map` 直接 TypeError。
 *   - 列表刷新改为 mutation 成功后显式 `mutate(LIST_KEY)`（契约 §7「列表类在 mutation 后显式 mutate 一次刷新」）。
 *   - 显式 `revalidate: false` 关掉 useSWRMutation 默认的「成功后自动重新验证」：否则一次删除会发两次 GET，
 *     而「刷新了几次」正是本包测试要钉的东西。
 */
import useSWR, { useSWRConfig } from 'swr';
import useSWRMutation from 'swr/mutation';
import type { ProviderCreate, ProviderPatch, ProviderView } from '@aieval/contracts';
import { delJson, getJson, postJson, putJson } from './http';

const LIST_KEY = '/api/providers';

/** DELETE /api/providers/{id} 的响应体：路由回 `{ ok: true }` 而不是 204（delJson 走 res.json()，空体会抛 SyntaxError） */
interface OkBody {
  ok: boolean;
}

/**
 * 单条模型增删的 URL。
 * `modelId` 必须 encodeURIComponent：模型名里带 `+` / `#` / `&` 是常态（`vendor/model+x`），
 * 不编码时 `#` 之后会被当片段丢掉、`+` 会被服务端解成空格 —— 表现是「点了删除没反应」或删错条目。
 */
function modelsUrl(providerId: string, modelId?: string): string {
  const base = `${LIST_KEY}/${encodeURIComponent(providerId)}/models`;
  return modelId === undefined ? base : `${base}?modelId=${encodeURIComponent(modelId)}`;
}

export function useProviders(): {
  providers: ProviderView[] | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<ProviderView[]>(LIST_KEY, getJson);
  return {
    providers: data,
    error,
    isLoading,
    // 包一层而不是直接把 mutate 透出去：契约要求 refresh 是「无参、无返回」的动作
    refresh: (): void => {
      void mutate();
    },
  };
}

export function useCreateProvider(): {
  create: (input: ProviderCreate) => Promise<ProviderView>;
  isCreating: boolean;
} {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: ProviderCreate }) => postJson<ProviderView>(key, arg),
    { revalidate: false },
  );
  const create = async (input: ProviderCreate): Promise<ProviderView> => {
    const created = await trigger(input);
    await mutate(LIST_KEY);
    return created;
  };
  return { create, isCreating: isMutating };
}

export function useUpdateProvider(): {
  update: (id: string, patch: ProviderPatch) => Promise<ProviderView>;
  isUpdating: boolean;
} {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: { id: string; patch: ProviderPatch } }) =>
      putJson<ProviderView>(`${key}/${encodeURIComponent(arg.id)}`, arg.patch),
    { revalidate: false },
  );
  const update = async (id: string, patch: ProviderPatch): Promise<ProviderView> => {
    const updated = await trigger({ id, patch });
    await mutate(LIST_KEY);
    return updated;
  };
  return { update, isUpdating: isMutating };
}

export function useDeleteProvider(): { remove: (id: string) => Promise<void>; isDeleting: boolean } {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: string }) => delJson<OkBody>(`${key}/${encodeURIComponent(arg)}`),
    { revalidate: false },
  );
  const remove = async (id: string): Promise<void> => {
    await trigger(id);
    await mutate(LIST_KEY);
  };
  return { remove, isDeleting: isMutating };
}

export function useFetchProviderModels(): {
  fetchModels: (id: string) => Promise<ProviderView>;
  isFetching: boolean;
} {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: string }) =>
      postJson<ProviderView>(`${key}/${encodeURIComponent(arg)}/models/fetch`, {}),
    { revalidate: false },
  );
  const fetchModels = async (id: string): Promise<ProviderView> => {
    const view = await trigger(id);
    await mutate(LIST_KEY);
    return view;
  };
  return { fetchModels, isFetching: isMutating };
}

export function useProviderModels(): {
  add: (id: string, modelId: string) => Promise<ProviderView>;
  remove: (id: string, modelId: string) => Promise<ProviderView>;
  isMutating: boolean;
} {
  const { mutate } = useSWRConfig();
  const addMutation = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string; modelId: string } }) =>
      postJson<ProviderView>(modelsUrl(arg.id), { id: arg.modelId, source: 'manual' }),
    { revalidate: false },
  );
  const removeMutation = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string; modelId: string } }) =>
      delJson<ProviderView>(modelsUrl(arg.id, arg.modelId)),
    { revalidate: false },
  );
  const add = async (id: string, modelId: string): Promise<ProviderView> => {
    const view = await addMutation.trigger({ id, modelId });
    await mutate(LIST_KEY);
    return view;
  };
  const remove = async (id: string, modelId: string): Promise<ProviderView> => {
    const view = await removeMutation.trigger({ id, modelId });
    await mutate(LIST_KEY);
    return view;
  };
  return { add, remove, isMutating: addMutation.isMutating || removeMutation.isMutating };
}
```

- [ ] **Step 4: 追加 `src/index.ts` 的出口**

```ts
/** client 公共出口：数据获取 hooks 与 HTTP 原语。类型全部来自 contracts。 */
export { delJson, getJson, postJson, putJson } from './http';
export { useSettings } from './settings';
export {
  useCreateProvider,
  useDeleteProvider,
  useFetchProviderModels,
  useProviderModels,
  useProviders,
  useUpdateProvider,
} from './providers';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/client test`
Expected: PASS（`providers.test.tsx` 共 6 个 `describe` / 9 个 `it` 全绿；`http.test.ts` 与 `settings.test.tsx` 也仍然全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/client/client/src/providers.ts packages/client/client/src/providers.test.tsx packages/client/client/src/index.ts
git commit -m "feat(client): 供应商 hooks（mutation 后显式刷新列表 + modelId 编码进 URL）"
```

- [ ] **Step 7: 变异验证④：`modelId` 的 URL 编码**

记录哈希：`git hash-object packages/client/client/src/providers.ts`

制造变异体（去掉编码 —— 这正是「模型名带 `#` / `+` 时删错条目」那个缺陷）：

```ts
function modelsUrl(providerId: string, modelId?: string): string {
  const base = `${LIST_KEY}/${providerId}/models`;
  return modelId === undefined ? base : `${base}?modelId=${modelId}`;
}
```

Run: `pnpm --filter @aieval/client test`
Expected: FAIL，形如：

```
FAIL  src/providers.test.tsx > useProviderModels > remove 把 modelId 编码进 query（/ + # 都必须转义）
AssertionError: expected '/api/providers/p-1/models?modelId=vendor/model+x#1' to be '/api/providers/p-1/models?modelId=vendor%2Fmodel%2Bx%231'
```

还原并核对：

```bash
git hash-object packages/client/client/src/providers.ts   # 与记录值逐字符相同
pnpm --filter @aieval/client test                          # 重新全绿
```

---

## Task 4: `ui` —— `ProviderTable`

**Files:**
- Create: `packages/client/ui/src/composite/provider-table.tsx`
- Create: `packages/client/ui/src/composite/provider-table.test.tsx`
- Modify: `packages/client/ui/src/index.ts:23`（在 `demo-list-page` 那行之后追加，注意别动 p2 会删的那两行）

**Interfaces:**
- Consumes: contracts 的 `ProviderView` / `PROTOCOL_LABELS`；本包已有 `EllipsisText` / `EmptyState` / `Toolbar`。
- Produces（props 名逐字来自契约 §8）：`ProviderTable`，`ProviderTableProps = { providers: ProviderView[]; onEdit: (provider: ProviderView) => void; onDelete: (provider: ProviderView) => void; onCreate: () => void; loading?: boolean }`。

- [ ] **Step 1: 写失败测试 `provider-table.test.tsx`**

```tsx
/**
 * ProviderTable：列内容、协议中文标签、掩码、三个回调、删除的二次确认、空态引导。
 * 注意：本文件所有断言都走「用户能看到什么」，不查 antd 的类名 —— 类名会随版本静默变化，
 * 而这里要钉的是「误点一次不会把供应商删掉」这类行为。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PROTOCOL_LABELS, type ProviderView } from '@aieval/contracts';
import { ProviderTable } from './provider-table';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 没有 ResizeObserver，而 antd 的 Table 与 Typography 的 ellipsis 内部会直接 new 它
// （见 src/testing/resize-observer.ts）：不打桩，挂载即抛 ReferenceError。
beforeEach(() => {
  installResizeObserverStub();
});

const openai: ProviderView = {
  id: 'p-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyMasked: 'sk-***mnop',
  models: [
    { id: 'deepseek-chat', source: 'manual' },
    { id: 'deepseek-reasoner', source: 'fetched' },
  ],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

const anthropic: ProviderView = {
  ...openai,
  id: 'p-2',
  name: 'Anthropic 官方',
  protocolType: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKeyMasked: 'sk-***wxyz',
  models: [],
};

const noop = (): void => {};

describe('ProviderTable', () => {
  it('每行显示名称 / 协议中文标签 / 掩码 / 模型数', () => {
    render(<ProviderTable providers={[openai, anthropic]} onEdit={noop} onDelete={noop} onCreate={noop} />);

    expect(screen.getByText('DeepSeek 官方')).toBeInTheDocument();
    // 协议列用 contracts 的中文标签（不在这里抄第二份文案）
    expect(screen.getByText(PROTOCOL_LABELS.openai)).toBeInTheDocument();
    expect(screen.getByText(PROTOCOL_LABELS.anthropic)).toBeInTheDocument();
    expect(screen.getByText('sk-***mnop')).toBeInTheDocument();

    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3); // 表头 + 两条
    expect(within(rows[1] as HTMLElement).getByText('2')).toBeInTheDocument(); // openai：2 个模型
    expect(within(rows[2] as HTMLElement).getByText('0')).toBeInTheDocument(); // anthropic：0 个
  });

  it('点「编辑」把整条供应商回给调用方', () => {
    const onEdit = vi.fn();
    render(<ProviderTable providers={[openai]} onEdit={onEdit} onDelete={noop} onCreate={noop} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    expect(onEdit).toHaveBeenCalledWith(openai);
  });

  it('删除必须过一次 Popconfirm：只点「删除」不触发，点「确认删除」才触发', async () => {
    const onDelete = vi.fn();
    render(<ProviderTable providers={[openai]} onEdit={noop} onDelete={onDelete} onCreate={noop} />);

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onDelete).not.toHaveBeenCalled();

    // 浮层里的确认按钮必须显式给中文：应用没有配 antd locale，默认是 "OK" / "Cancel"
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));

    expect(onDelete).toHaveBeenCalledWith(openai);
  });

  it('空列表给引导动作，点它触发 onCreate', () => {
    const onCreate = vi.fn();
    render(<ProviderTable providers={[]} onEdit={noop} onDelete={noop} onCreate={onCreate} />);

    expect(screen.getByText('还没有供应商')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加第一个供应商' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('工具条上的「添加供应商」同样触发 onCreate', () => {
    const onCreate = vi.fn();
    render(<ProviderTable providers={[openai]} onEdit={noop} onDelete={noop} onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('button', { name: '添加供应商' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test`
Expected: FAIL —— 收集阶段报 `Failed to resolve import "./provider-table" from "src/composite/provider-table.test.tsx"`。

- [ ] **Step 3: 写实现 `packages/client/ui/src/composite/provider-table.tsx`**

```tsx
'use client';

/**
 * 供应商表格：名称 / 协议类型 / API 地址 / 密钥掩码 / 模型数 / 操作。
 * 纯展示：不调接口、不知道 hooks 的存在 —— 新增 / 编辑 / 删除三个动作全部以回调交给调用方。
 *
 * 两个必须守住的点：
 *   1. 删除走 `Popconfirm` 二次确认：误点一次会连明文密钥与手工维护的模型清单一起消失，
 *      而密钥是明文落盘的，用户未必还有第二份；
 *   2. 中文文案**全部显式给出**：应用没有配 antd 的 locale（见 apps/web-next/app/providers.tsx），
 *      antd 内置文案默认是英文，漏给一处就是中英混杂。
 */
import { Button, Card, Flex, Popconfirm, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ReactNode } from 'react';
import { PROTOCOL_LABELS, type ProviderView } from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { EmptyState } from '../base/empty-state';
import { Toolbar } from '../base/toolbar';

export interface ProviderTableProps {
  providers: ProviderView[];
  onEdit: (provider: ProviderView) => void;
  onDelete: (provider: ProviderView) => void;
  onCreate: () => void;
  loading?: boolean;
}

/** 协议 → 标签颜色：两种协议在表里必须一眼可分（它决定模型能喂给哪些智能体，F1 / F2） */
const PROTOCOL_COLORS: Record<ProviderView['protocolType'], string> = {
  openai: 'blue',
  anthropic: 'purple',
};

export function ProviderTable({
  providers,
  onEdit,
  onDelete,
  onCreate,
  loading = false,
}: ProviderTableProps): ReactNode {
  const columns: TableColumnsType<ProviderView> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: '协议类型',
      dataIndex: 'protocolType',
      key: 'protocolType',
      width: 150,
      render: (protocolType: ProviderView['protocolType']) => (
        <Tag color={PROTOCOL_COLORS[protocolType]}>{PROTOCOL_LABELS[protocolType]}</Tag>
      ),
    },
    {
      title: 'API 地址',
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      // 长地址必须省略 + Tooltip 显全量，否则会把列宽顶开
      render: (baseUrl: string) => <EllipsisText text={baseUrl} width={260} monospace />,
    },
    {
      title: '密钥掩码',
      dataIndex: 'apiKeyMasked',
      key: 'apiKeyMasked',
      width: 150,
      // 掩码也用等宽：`sk-***mnop` 混在比例字体里更难核对首尾
      render: (apiKeyMasked: string) => <Typography.Text code>{apiKeyMasked}</Typography.Text>,
    },
    {
      title: '模型数',
      key: 'modelCount',
      width: 90,
      render: (_value, provider) => provider.models.length,
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_value, provider) => (
        <Flex gap={8}>
          <Button size="small" onClick={() => onEdit(provider)}>
            编辑
          </Button>
          <Popconfirm
            title="删除这个供应商？"
            description="它的 API 密钥与模型清单会一起消失；历史评测里记的模型名仍会保留（那是快照）。"
            okText="确认删除"
            cancelText="取消"
            onConfirm={() => onDelete(provider)}
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Flex>
      ),
    },
  ];

  return (
    <Card size="small" data-testid="provider-table-card">
      <Toolbar
        title="模型供应商"
        extra={
          <Button type="primary" size="small" onClick={onCreate}>
            添加供应商
          </Button>
        }
      />
      <Table<ProviderView>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={providers}
        loading={loading}
        pagination={false}
        // 空态给引导动作而不仅是一句「暂无数据」：空列表是新用户唯一会看到的界面
        locale={{
          emptyText: (
            <EmptyState
              title="还没有供应商"
              description="添加一个供应商，才能给智能体选模型"
              action={{ label: '添加第一个供应商', onClick: onCreate }}
            />
          ),
        }}
      />
    </Card>
  );
}
```

- [ ] **Step 4: 追加 `src/index.ts` 的出口**

在 `demo-list-page` 那一行之后追加（**不要**动 `demo-list-page` 本身，它由 p2 删除）：

```ts
export { ProviderTable, type ProviderTableProps } from './composite/provider-table';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test`
Expected: PASS（`provider-table.test.tsx` 共 1 个 `describe` / 5 个 `it` 全绿；ui 包其余用例不受影响）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/client/ui/src/composite/provider-table.tsx packages/client/ui/src/composite/provider-table.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): 供应商表格（删除二次确认 + 空态引导 + 协议中文标签）"
```

---

## Task 5: `ui` —— `ProviderFormModal`

**Files:**
- Create: `packages/client/ui/src/composite/provider-form-modal.tsx`
- Create: `packages/client/ui/src/composite/provider-form-modal.test.tsx`
- Modify: `packages/client/ui/src/index.ts`（追加一行）

**Interfaces:**
- Consumes: contracts 的 `ProviderView` / `ProtocolType` / `PROTOCOL_LABELS`。
- Produces（props 名逐字来自契约 §8）：
  - `ProviderFormModal`，`ProviderFormModalProps = { open: boolean; initial: ProviderView | null; saving: boolean; fetchingModels: boolean; onSubmit: (values: ProviderFormValues) => void; onCancel: () => void; onFetchModels: () => void; onAddModel: (modelId: string) => void; onRemoveModel: (modelId: string) => void }`
  - `ProviderFormValues = { name: string; protocolType: ProtocolType; baseUrl: string; apiKey: string }`（契约未钉死这个中间形状，见「实现层修正」第 6 条）

- [ ] **Step 1: 写失败测试 `provider-form-modal.test.tsx`**

```tsx
/**
 * ProviderFormModal：新建/编辑两种形态、必填校验、留空密钥的语义、
 * 模型清单的增删与拉取按钮的禁用依据。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PROTOCOL_LABELS, type ProviderView } from '@aieval/contracts';
import { ProviderFormModal } from './provider-form-modal';
import { installResizeObserverStub } from '../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
});

const PROVIDER: ProviderView = {
  id: 'p-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyMasked: 'sk-***mnop',
  models: [
    { id: 'deepseek-chat', source: 'manual' },
    { id: 'deepseek-reasoner', source: 'fetched' },
  ],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

const noop = (): void => {};

/** 一套默认 props：每个用例只覆盖自己关心的那几个 */
function renderModal(overrides: Partial<Parameters<typeof ProviderFormModal>[0]> = {}): ReturnType<typeof render> {
  return render(
    <ProviderFormModal
      open
      initial={null}
      saving={false}
      fetchingModels={false}
      onSubmit={noop}
      onCancel={noop}
      onFetchModels={noop}
      onAddModel={noop}
      onRemoveModel={noop}
      {...overrides}
    />,
  );
}

describe('ProviderFormModal：新建态', () => {
  it('标题是「添加供应商」，模型区只提示「保存后可维护」，没有「拉取模型」按钮', () => {
    renderModal();

    expect(screen.getByText('添加供应商')).toBeInTheDocument();
    expect(screen.getByText('保存后可维护模型清单')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拉取模型' })).toBeNull();
  });

  it('必填项为空时点「保存」不提交，并给出中文错误', async () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText('请填写名称')).toBeInTheDocument();
    expect(screen.getByText('请填写 API 密钥')).toBeInTheDocument();
  });

  it('填完提交：回调收到四个字段', async () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit });

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'DeepSeek 官方' } });
    fireEvent.click(screen.getByRole('radio', { name: PROTOCOL_LABELS.anthropic }));
    fireEvent.change(screen.getByLabelText('API 地址'), {
      target: { value: 'https://api.deepseek.com/anthropic' },
    });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'DeepSeek 官方',
        protocolType: 'anthropic',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'sk-secret',
      }),
    );
  });
});

describe('ProviderFormModal：编辑态', () => {
  it('字段预填，密钥框留空且占位符回显当前掩码', () => {
    renderModal({ initial: PROVIDER });

    expect(screen.getByText('编辑供应商')).toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveValue('DeepSeek 官方');
    expect(screen.getByLabelText('API 地址')).toHaveValue('https://api.deepseek.com/v1');
    expect(screen.getByLabelText('API 密钥')).toHaveValue('');
    expect(screen.getByPlaceholderText('留空表示不修改（当前：sk-***mnop）')).toBeInTheDocument();
  });

  // 页面会把空串折成「不下发 apiKey」（Task 8）：这条钉住弹窗确实用空串表达「不修改」，
  // 而不是把掩码当密钥回填（那会把 user 的密钥覆盖成 `sk-***mnop`，此后所有调用 401）。
  it('留空密钥提交：回调收到的 apiKey 是空串', async () => {
    const onSubmit = vi.fn();
    renderModal({ initial: PROVIDER, onSubmit });

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '改名了' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: '改名了',
        protocolType: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
      }),
    );
  });

  it('模型清单带来源标签，点「移除」回传对应的模型名', () => {
    const onRemoveModel = vi.fn();
    renderModal({ initial: PROVIDER, onRemoveModel });

    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
    expect(screen.getByText('手工维护')).toBeInTheDocument();
    expect(screen.getByText('自动拉取')).toBeInTheDocument();

    const removeButtons = screen.getAllByRole('button', { name: '移除' });
    fireEvent.click(removeButtons[1] as HTMLElement);

    expect(onRemoveModel).toHaveBeenCalledWith('deepseek-reasoner');
  });

  it('手工添加：去掉首尾空白后回传，并清空输入框', async () => {
    const onAddModel = vi.fn();
    renderModal({ initial: PROVIDER, onAddModel });
    const input = screen.getByPlaceholderText('手工添加模型名，如 deepseek-chat');

    fireEvent.change(input, { target: { value: ' deepseek-coder ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(onAddModel).toHaveBeenCalledWith('deepseek-coder');
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('纯空白输入不触发添加（不让一个空模型名走一趟服务端）', () => {
    const onAddModel = vi.fn();
    renderModal({ initial: PROVIDER, onAddModel });

    fireEvent.change(screen.getByPlaceholderText('手工添加模型名，如 deepseek-chat'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(onAddModel).not.toHaveBeenCalled();
  });

  it('OpenAI 协议下「拉取模型」可用，点击回传', () => {
    const onFetchModels = vi.fn();
    renderModal({ initial: PROVIDER, onFetchModels });

    const button = screen.getByRole('button', { name: '拉取模型' });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(onFetchModels).toHaveBeenCalledTimes(1);
  });

  it('Anthropic 协议下「拉取模型」禁用，且原因直接可见（不藏在浮层里）', () => {
    renderModal({ initial: { ...PROVIDER, protocolType: 'anthropic' } });

    expect(screen.getByRole('button', { name: '拉取模型' })).toBeDisabled();
    // 原因写成可见文本而不是只挂在 Tooltip 上：触屏与键盘用户永远看不到 hover 浮层
    expect(screen.getByText('该协议无 /models 接口，请手工维护')).toBeInTheDocument();
  });

  it('禁用依据是已保存的协议，而不是表单里未保存的单选值', () => {
    renderModal({ initial: PROVIDER }); // 已保存的是 openai

    fireEvent.click(screen.getByRole('radio', { name: PROTOCOL_LABELS.anthropic }));

    // 服务端按**已保存**的协议判定（Task 2 的守卫）：按钮跟着未保存的本地改动变灰，
    // 只会让人以为「拉取坏了」，而真正能拉的那次请求根本不会发出去。
    expect(screen.getByRole('button', { name: '拉取模型' })).toBeEnabled();
  });
});

describe('ProviderFormModal：表单重灌的边界', () => {
  it('换成另一个供应商时重灌（不残留上一条的输入）', () => {
    const { rerender } = renderModal({ initial: PROVIDER });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '改了一半' } });

    rerender(
      <ProviderFormModal
        open
        initial={{ ...PROVIDER, id: 'p-2', name: 'Anthropic 官方' }}
        saving={false}
        fetchingModels={false}
        onSubmit={noop}
        onCancel={noop}
        onFetchModels={noop}
        onAddModel={noop}
        onRemoveModel={noop}
      />,
    );

    expect(screen.getByLabelText('名称')).toHaveValue('Anthropic 官方');
    expect(screen.getByLabelText('API 密钥')).toHaveValue('');
  });

  // 列表刷新（例如刚手工加了一个模型 → SWR 重新取回列表 → 传进来的 ProviderView 是新对象、
  // id 没变）**不得**重灌表单：否则用户正在敲的名字会在加模型的那一刻被清掉。
  it('同 id 的新对象（列表刷新）不重灌表单，但模型清单跟着新 props 刷新', () => {
    const { rerender } = renderModal({ initial: PROVIDER });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '编辑中的名字' } });

    rerender(
      <ProviderFormModal
        open
        initial={{ ...PROVIDER, models: [...PROVIDER.models, { id: 'brand-new', source: 'manual' as const }] }}
        saving={false}
        fetchingModels={false}
        onSubmit={noop}
        onCancel={noop}
        onFetchModels={noop}
        onAddModel={noop}
        onRemoveModel={noop}
      />,
    );

    expect(screen.getByLabelText('名称')).toHaveValue('编辑中的名字');
    expect(screen.getByText('brand-new')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test`
Expected: FAIL —— 收集阶段报 `Failed to resolve import "./provider-form-modal"`。

- [ ] **Step 3: 写实现 `packages/client/ui/src/composite/provider-form-modal.tsx`**

```tsx
'use client';

/**
 * 供应商新增 / 编辑弹窗：名称 + 协议 Radio + API 地址 + 密钥 Password + 模型清单。
 * 纯展示：不调接口，所有动作走回调；异步与错误提示留在调用方（本组件不认识 message）。
 *
 * 四个刻意的取舍（每条都对应一个真实会伤到用户的情形）：
 *   1. **模型清单只在编辑态可维护**：拉取与增删都需要一个已存在的 providerId；新建时还没有 id，
 *      只提示「保存后可维护」，不渲染一个按不动、点了报错的半残模型区；
 *   2. **编辑态密钥框留空 = 不修改**（占位符回显当前掩码）：服务端不把掩码当密钥，
 *      要求用户为了改个名字重填一遍密钥是不可接受的；
 *   3. **「拉取模型」的禁用依据是 `initial.protocolType`（已保存的协议）**，不是表单里未保存的
 *      单选值：服务端按已保存的协议判定，按钮跟着未保存的本地改动亮起来只会得到一次 400；
 *      禁用原因写成**可见文本**而不是只挂在 Tooltip 上 —— 触屏与键盘用户看不到 hover 浮层；
 *   4. **表单用 `forceRender` 常挂载 + effect 重灌初值**，且重灌只依赖 `open` 与被编辑者的 id：
 *      列表每次刷新都会给出新的 ProviderView 对象，若依赖它，用户打字中途就会被清空输入。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Flex, Form, Input, Modal, Radio, Tag, Typography } from 'antd';
import { PROTOCOL_LABELS, type ProtocolType, type ProviderView } from '@aieval/contracts';

/** 表单提交载荷：`apiKey` 为空串表示「不修改密钥」（编辑态留空），新建态由表单校验挡下空串 */
export interface ProviderFormValues {
  name: string;
  protocolType: ProtocolType;
  baseUrl: string;
  apiKey: string;
}

export interface ProviderFormModalProps {
  open: boolean;
  /** 编辑态传当前供应商（含模型清单与掩码）；新建态传 null */
  initial: ProviderView | null;
  saving: boolean;
  fetchingModels: boolean;
  onSubmit: (values: ProviderFormValues) => void;
  onCancel: () => void;
  onFetchModels: () => void;
  onAddModel: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
}

/** 新建态的空白初值：协议默认 openai（多数网关是 OpenAI 兼容） */
const EMPTY: ProviderFormValues = { name: '', protocolType: 'openai', baseUrl: '', apiKey: '' };

/** 模型来源的中文标签：拉取来的与手工补的必须一眼可分（下一次拉取只会覆盖 fetched 那一批） */
const SOURCE_LABELS: Record<ProviderView['models'][number]['source'], string> = {
  fetched: '自动拉取',
  manual: '手工维护',
};

const SOURCE_COLORS: Record<ProviderView['models'][number]['source'], string> = {
  fetched: 'blue',
  manual: 'gold',
};

export function ProviderFormModal(props: ProviderFormModalProps): ReactNode {
  const { open, initial, saving, fetchingModels, onSubmit, onCancel, onFetchModels, onAddModel, onRemoveModel } =
    props;
  const [form] = Form.useForm<ProviderFormValues>();
  const [modelInput, setModelInput] = useState('');
  const isEdit = initial !== null;
  const initialId = initial?.id ?? null;

  // 依赖里只放 open 与 id，**不放 initial 对象本身**：列表每次刷新（例如刚加了一个模型）都会给出
  // 一个新的 ProviderView 对象，把它放进依赖会让 effect 在用户打字中途重灌表单、清掉没保存的输入。
  // 模型清单不受影响 —— 它直接渲染 initial.models，跟着 props 走。
  useEffect(() => {
    if (!open) return;
    // 先 resetFields 再 setFieldsValue：只 setFieldsValue 会把上一次失败的校验红字留在界面上
    form.resetFields();
    form.setFieldsValue(
      initial === null
        ? EMPTY
        : { name: initial.name, protocolType: initial.protocolType, baseUrl: initial.baseUrl, apiKey: '' },
    );
  }, [open, initialId, form]);

  const fetchDisabled = !isEdit || initial.protocolType === 'anthropic';
  const fetchHint = !isEdit ? '保存后可维护模型清单' : '该协议无 /models 接口，请手工维护';

  const addModel = (): void => {
    const id = modelInput.trim();
    if (id === '') return;
    onAddModel(id);
    setModelInput('');
  };

  return (
    <Modal
      open={open}
      title={isEdit ? '编辑供应商' : '添加供应商'}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => form.submit()}
      onCancel={onCancel}
      width={560}
      // 表单要始终连着 useForm 实例，否则首次打开时 setFieldsValue 落空（值灌不进去）。
      // 这里刻意**不用** destroyOnHidden：与 forceRender 叠加会在「打开」这一帧留下
      // 「表单尚未挂载」的窗口，重灌初值就变成了随机成功。
      forceRender
    >
      <Form form={form} layout="vertical" size="small" initialValues={EMPTY} onFinish={(values) => onSubmit(values)}>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填写名称' }]}>
          <Input placeholder="如「DeepSeek 官方」" />
        </Form.Item>

        <Form.Item name="protocolType" label="协议类型" rules={[{ required: true }]}>
          <Radio.Group>
            <Radio value="openai">{PROTOCOL_LABELS.openai}</Radio>
            <Radio value="anthropic">{PROTOCOL_LABELS.anthropic}</Radio>
          </Radio.Group>
        </Form.Item>

        <Form.Item
          name="baseUrl"
          label="API 地址"
          rules={[{ required: true, message: '请填写 API 地址' }]}
          extra="OpenAI 兼容填到 /v1，Anthropic 兼容填到 /anthropic"
        >
          <Input placeholder="https://api.deepseek.com/v1" />
        </Form.Item>

        <Form.Item
          name="apiKey"
          label="API 密钥"
          // 编辑态不要求重填：留空表示沿用原密钥（服务端的空串语义见 api/providers.ts）
          rules={isEdit ? [] : [{ required: true, message: '请填写 API 密钥' }]}
        >
          <Input.Password
            autoComplete="off"
            placeholder={isEdit ? `留空表示不修改（当前：${initial.apiKeyMasked}）` : 'sk-…'}
          />
        </Form.Item>

        <Typography.Text strong>模型清单</Typography.Text>
        {!isEdit ? (
          <Alert
            type="info"
            showIcon
            title="保存后可维护模型清单"
            description="新建时还没有供应商 id，拉取与增删要等保存之后再做。"
          />
        ) : (
          <Flex vertical gap={8}>
            <Flex align="center" gap={8}>
              <Button size="small" loading={fetchingModels} disabled={fetchDisabled} onClick={onFetchModels}>
                拉取模型
              </Button>
              <Typography.Text type="secondary">
                {fetchDisabled ? fetchHint : '拉取只增补，不冲掉手工维护的条目'}
              </Typography.Text>
            </Flex>

            {initial.models.length === 0 ? (
              <Typography.Text type="secondary">还没有模型：拉取一次，或手工添加。</Typography.Text>
            ) : (
              <Flex vertical gap={4}>
                {initial.models.map((model) => (
                  <Flex key={model.id} align="center" justify="space-between" gap={8}>
                    <Flex align="center" gap={8}>
                      <Typography.Text code>{model.id}</Typography.Text>
                      <Tag color={SOURCE_COLORS[model.source]}>{SOURCE_LABELS[model.source]}</Tag>
                    </Flex>
                    <Button size="small" type="text" danger onClick={() => onRemoveModel(model.id)}>
                      移除
                    </Button>
                  </Flex>
                ))}
              </Flex>
            )}

            <Flex gap={8}>
              <Input
                size="small"
                value={modelInput}
                placeholder="手工添加模型名，如 deepseek-chat"
                onChange={(event) => setModelInput(event.target.value)}
                onPressEnter={addModel}
              />
              <Button size="small" onClick={addModel}>
                添加
              </Button>
            </Flex>
          </Flex>
        )}
      </Form>
    </Modal>
  );
}
```

- [ ] **Step 4: 追加 `src/index.ts` 的出口**

```ts
export {
  ProviderFormModal,
  type ProviderFormModalProps,
  type ProviderFormValues,
} from './composite/provider-form-modal';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test`
Expected: PASS（`provider-form-modal.test.tsx` 共 3 个 `describe` / 13 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/client/ui/src/composite/provider-form-modal.tsx packages/client/ui/src/composite/provider-form-modal.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): 供应商表单弹窗（留空密钥=不修改 + 模型清单增删与按协议禁用拉取）"
```

---

## Task 6: `ui` —— `JudgeSettingsCard` 与 `WorkspaceSettingsCard`

**Files:**
- Create: `packages/client/ui/src/composite/judge-settings-card.tsx`
- Create: `packages/client/ui/src/composite/judge-settings-card.test.tsx`
- Create: `packages/client/ui/src/composite/workspace-settings-card.tsx`
- Create: `packages/client/ui/src/composite/workspace-settings-card.test.tsx`
- Modify: `packages/client/ui/src/index.ts`（追加两段导出）

**Interfaces:**
- Consumes: contracts 的 `Settings` / `SettingsPatch` / `ProviderView` / `PROTOCOL_LABELS` / `DIMENSIONS` / `DIMENSION_COUNT`。
- Produces（props 名逐字来自契约 §8）：
  - `JudgeSettingsCard`，`JudgeSettingsCardProps = { settings: Settings; providers: ProviderView[]; onChange: (patch: SettingsPatch) => void; saving: boolean }`
  - `WorkspaceSettingsCard`，`WorkspaceSettingsCardProps = { settings: Settings; onValidate: (root: string) => void; saving: boolean; lastValidated: { root: string; ok: boolean; message?: string } | null }`

- [ ] **Step 1: 写失败测试 `judge-settings-card.test.tsx`**

```tsx
/**
 * JudgeSettingsCard：未配置提示、两种协议都能选、悬空默认值的显式提示、单位换算与清空语义。
 * 注意测试数据里的候选保持少量（≤ 5 条）：antd 的 Select 用虚拟列表，
 * 选项总高度超过 listHeight 时只渲染可视切片，而 jsdom 量不出高度。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DIMENSIONS, SETTINGS_DEFAULTS, type ProviderView, type Settings } from '@aieval/contracts';
import { JudgeSettingsCard } from './judge-settings-card';
import { installResizeObserverStub } from '../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
});

const openai: ProviderView = {
  id: 'p-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyMasked: 'sk-***mnop',
  models: [{ id: 'deepseek-chat', source: 'manual' }],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

const anthropic: ProviderView = {
  ...openai,
  id: 'p-2',
  name: 'Anthropic 官方',
  protocolType: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: [{ id: 'claude-sonnet-5', source: 'fetched' }],
};

const noop = (): void => {};
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...SETTINGS_DEFAULTS, ...patch });

describe('JudgeSettingsCard', () => {
  it('未配置时给出警告与去向', () => {
    render(<JudgeSettingsCard settings={settings()} providers={[]} onChange={noop} saving={false} />);

    expect(screen.getByText('未配置默认评分模型')).toBeInTheDocument();
    expect(screen.getByText(/评分步骤都不可用/)).toBeInTheDocument();
    // 一个供应商都没有时给出明确出路，而不是一个空下拉
    expect(screen.getByText('请先在「模型供应商」页添加供应商')).toBeInTheDocument();
  });

  it('两种协议的模型都能选（评分不经过智能体，不做协议过滤）', async () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard settings={settings()} providers={[openai, anthropic]} onChange={onChange} saving={false} />,
    );

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('claude-sonnet-5'));

    expect(onChange).toHaveBeenCalledWith({ defaultJudge: { providerId: 'p-2', modelId: 'claude-sonnet-5' } });
  });

  it('已选中的模型回显它的选项标签', () => {
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-1', modelId: 'deepseek-chat' } })}
        providers={[openai]}
        onChange={noop}
        saving={false}
      />,
    );

    expect(screen.queryByText('未配置默认评分模型')).toBeNull();
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
  });

  // 删供应商不级联改写 settings.defaultJudge（Task 1 的决定），所以这里必然出现悬空引用。
  // 静默显示成「未配置」会让人以为只是没选，直到跑评测才发现评分不可用。
  it('默认评分模型已失效时显式提示，且下拉不再回显那个失效的 key', () => {
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-deleted', modelId: 'ghost-model' } })}
        providers={[openai]}
        onChange={noop}
        saving={false}
      />,
    );

    expect(screen.getByText('当前的默认评分模型已失效')).toBeInTheDocument();
    expect(screen.getByText(/p-deleted::ghost-model/)).toBeInTheDocument();
    // 失效的 key 不能出现在选择框的选中项里（否则用户看到的是一个不存在的模型名）
    expect(screen.queryByText('ghost-model')).toBeNull();
  });

  it('输出契约预览列出全部 5 个维度与合成规则（文案从 contracts 派生，不在这里抄第二份）', () => {
    render(<JudgeSettingsCard settings={settings()} providers={[openai]} onChange={noop} saving={false} />);

    for (const dimension of DIMENSIONS) {
      expect(screen.getByText(new RegExp(dimension.label))).toBeInTheDocument();
    }
    expect(screen.getByText(/满分 100/)).toBeInTheDocument();
  });

  it('行超时按分钟显示与回写（毫秒 ↔ 分钟只在组件里换算）', () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard
        settings={settings({ rowTimeoutMs: 1_800_000 })}
        providers={[openai]}
        onChange={onChange}
        saving={false}
      />,
    );

    const timeout = screen.getByRole('spinbutton', { name: '单行超时（分钟）' });
    expect(timeout).toHaveValue('30');

    fireEvent.change(timeout, { target: { value: '45' } });

    expect(onChange).toHaveBeenCalledWith({ rowTimeoutMs: 2_700_000 });
  });

  it('diff 上限按 KB 显示与回写', () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard
        settings={settings({ diffBudgetBytes: 262_144 })}
        providers={[openai]}
        onChange={onChange}
        saving={false}
      />,
    );

    const budget = screen.getByRole('spinbutton', { name: 'diff 上限（KB）' });
    expect(budget).toHaveValue('256');

    fireEvent.change(budget, { target: { value: '512' } });

    expect(onChange).toHaveBeenCalledWith({ diffBudgetBytes: 524_288 });
  });

  // 清空输入框时 antd 给的是 null。契约要求 rowTimeoutMs / diffBudgetBytes 是**正整数**，
  // 把 null 当成 0 写回去会得到一次 400（服务端 zod 拒绝）或一个 0 毫秒的超时。
  it('清空输入框不触发改动（null 不得被当成 0）', () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard settings={settings()} providers={[openai]} onChange={onChange} saving={false} />,
    );

    fireEvent.change(screen.getByRole('spinbutton', { name: '单行超时（分钟）' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'diff 上限（KB）' }), { target: { value: '' } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('saving 时两个数值输入禁用（避免并发提交把后一次的值盖掉）', () => {
    render(<JudgeSettingsCard settings={settings()} providers={[openai]} onChange={noop} saving />);

    expect(screen.getByRole('spinbutton', { name: '单行超时（分钟）' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'diff 上限（KB）' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test`
Expected: FAIL —— 收集阶段报 `Failed to resolve import "./judge-settings-card"`。

- [ ] **Step 3: 写实现 `packages/client/ui/src/composite/judge-settings-card.tsx`**

```tsx
'use client';

/**
 * 评分配置卡：默认评分模型 + 输出契约只读预览 + 行超时 + diff 上限。
 * 纯展示：数据从 settings / providers 两个 props 来，改动以 patch 回调交给调用方（本组件不调接口）。
 *
 * 三处刻意的设计：
 *   1. **两种协议的模型都列**：评分走纯文本 API、不经过智能体（F3 / §6.2），
 *      按协议过滤会平白砍掉一半候选（Anthropic 协议的模型照样能评分）；
 *   2. **悬空的 defaultJudge 要显式提示**：删掉供应商后设置里仍留着它的 id（删除不级联改写设置），
 *      静默显示成「未配置」会让人以为只是没选，直到跑评测才发现评分不可用；
 *   3. **单位换算只在这里做**：配置存毫秒与字节，界面用分钟与 KB（人填的是 30 / 256）。
 */
import { Alert, Card, Flex, Form, InputNumber, Select, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  DIMENSIONS,
  DIMENSION_COUNT,
  PROTOCOL_LABELS,
  type ProviderView,
  type Settings,
  type SettingsPatch,
} from '@aieval/contracts';

export interface JudgeSettingsCardProps {
  settings: Settings;
  providers: ProviderView[];
  onChange: (patch: SettingsPatch) => void;
  saving: boolean;
}

/** 分钟 ↔ 毫秒、KB ↔ 字节：两个换算只此一处，避免输入框与配置两处各自取整 */
const MS_PER_MINUTE = 60_000;
const BYTES_PER_KB = 1024;

export function JudgeSettingsCard({ settings, providers, onChange, saving }: JudgeSettingsCardProps): ReactNode {
  // 选项的 value 是 `${providerId}::${modelId}` 拼出来的 key，但**点击时不做字符串切分**：
  // 而是回这张表里按 key 精确反查（modelId 里出现 `::` 也不会错位）。
  const optionIndex = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      key: `${provider.id}::${model.id}`,
      providerId: provider.id,
      modelId: model.id,
    })),
  );
  const groups = providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      label: `${provider.name}（${PROTOCOL_LABELS[provider.protocolType]}）`,
      options: provider.models.map((model) => ({ label: model.id, value: `${provider.id}::${model.id}` })),
    }));

  const current = settings.defaultJudge;
  const currentKey = current === null ? undefined : `${current.providerId}::${current.modelId}`;
  // 悬空：设置里写着这一对 id，但供应商或模型已经不在清单里了
  const dangling = current !== null && !optionIndex.some((option) => option.key === currentKey);

  const pick = (value: string | undefined): void => {
    if (value === undefined) {
      // 清空 = 回到「未配置」（契约里 defaultJudge 的 null 就是未配置，不是空对象）
      onChange({ defaultJudge: null });
      return;
    }
    const option = optionIndex.find((item) => item.key === value);
    // 反查不到（理论上不会发生）：宁可不改，也不要往设置里写进半个 id
    if (option === undefined) return;
    onChange({ defaultJudge: { providerId: option.providerId, modelId: option.modelId } });
  };

  return (
    <Card size="small" title="评分配置" data-testid="judge-settings-card">
      <Flex vertical gap={12}>
        {current === null && (
          <Alert
            type="warning"
            showIcon
            title="未配置默认评分模型"
            description="未配置时，用例页的「AI 生成评分提示词」与评测的评分步骤都不可用；可以在下面选一个，或在用例里单独覆盖。"
          />
        )}
        {dangling && (
          <Alert
            type="error"
            showIcon
            title="当前的默认评分模型已失效"
            description={`设置里记的是 ${currentKey}，但它已不在供应商清单里（供应商或模型被删了）。请重新选择。`}
          />
        )}

        <Form layout="vertical" size="small" component={false}>
          <Form.Item label="默认评分模型" style={{ marginBottom: 8 }}>
            <Select
              aria-label="默认评分模型"
              placeholder={providers.length === 0 ? '请先在「模型供应商」页添加供应商' : '未配置'}
              disabled={saving || providers.length === 0}
              allowClear
              // 悬空时不回显那个失效的 key：显示一个不存在的模型名比显示空更糟
              value={dangling ? undefined : currentKey}
              options={groups}
              onChange={pick}
            />
          </Form.Item>

          <Form.Item label="输出契约（只读）" style={{ marginBottom: 8 }}>
            <Flex vertical gap={4}>
              <Typography.Text type="secondary">
                评分模型只输出一个 JSON：{DIMENSIONS.map((dimension) => dimension.label).join(' / ')}{' '}
                各 1–5 分整数，等权。
              </Typography.Text>
              <Typography.Text type="secondary">
                总分 = round(sum(score) / (5 × {DIMENSION_COUNT}) × 100)，即 5 维满分 100。
              </Typography.Text>
            </Flex>
          </Form.Item>

          <Form.Item label="单行超时（分钟）" style={{ marginBottom: 8 }}>
            <InputNumber
              aria-label="单行超时（分钟）"
              min={1}
              step={1}
              precision={0}
              // 单位用 suffix 而不是 addonAfter：antd 6 已弃用 addonAfter（提示改用 Space.Compact）
              suffix="分钟"
              disabled={saving}
              value={Math.round(settings.rowTimeoutMs / MS_PER_MINUTE)}
              // 清空输入框时 antd 给的是 null：**不能**当成 0 写回去（契约要求正整数），
              // 直接忽略这次改动，用户重新填一个值即可。
              onChange={(value) => {
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return;
                onChange({ rowTimeoutMs: Math.round(value) * MS_PER_MINUTE });
              }}
            />
          </Form.Item>

          <Form.Item label="diff 上限（KB）" style={{ marginBottom: 0 }}>
            <InputNumber
              aria-label="diff 上限（KB）"
              min={1}
              step={1}
              precision={0}
              suffix="KB"
              disabled={saving}
              value={Math.round(settings.diffBudgetBytes / BYTES_PER_KB)}
              onChange={(value) => {
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return;
                onChange({ diffBudgetBytes: Math.round(value) * BYTES_PER_KB });
              }}
            />
          </Form.Item>
        </Form>
      </Flex>
    </Card>
  );
}
```

- [ ] **Step 4: 写失败测试 `workspace-settings-card.test.tsx`**

```tsx
/**
 * WorkspaceSettingsCard：初值、把输入框里的值交给回调、失败时保留输入并显示服务端原因。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SETTINGS_DEFAULTS, type Settings } from '@aieval/contracts';
import { WorkspaceSettingsCard } from './workspace-settings-card';

const noop = (): void => {};
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...SETTINGS_DEFAULTS, ...patch });
const ROOT = 'D:/aieval-runs';

describe('WorkspaceSettingsCard', () => {
  it('输入框初值是当前根目录', () => {
    render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={noop} saving={false} lastValidated={null} />,
    );

    expect(screen.getByLabelText('工作区根目录')).toHaveValue(ROOT);
    // 明确告诉用户：它同时会写盘（按钮名与这句提示必须一致）
    expect(screen.getByRole('button', { name: '校验并保存' })).toBeInTheDocument();
  });

  it('点「校验并保存」把输入框里的新值交给 onValidate（不是旧值）', () => {
    const onValidate = vi.fn();
    render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={onValidate} saving={false} lastValidated={null} />,
    );

    fireEvent.change(screen.getByLabelText('工作区根目录'), { target: { value: 'E:/runs' } });
    fireEvent.click(screen.getByRole('button', { name: '校验并保存' }));

    expect(onValidate).toHaveBeenCalledWith('E:/runs');
  });

  it('根目录为空或纯空白时按钮禁用（不让空值走一趟服务端）', () => {
    render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={noop} saving={false} lastValidated={null} />,
    );

    fireEvent.change(screen.getByLabelText('工作区根目录'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: '校验并保存' })).toBeDisabled();
  });

  it('校验成功显示可用路径', () => {
    render(
      <WorkspaceSettingsCard
        settings={settings({ workspaceRoot: ROOT })}
        onValidate={noop}
        saving={false}
        lastValidated={{ root: ROOT, ok: true }}
      />,
    );

    expect(screen.getByText(`工作区可用：${ROOT}`)).toBeInTheDocument();
  });

  // 把输入框弹回旧值会让人以为是自己填错了格式，而真正的原因（建目录失败 / 不可写）
  // 恰恰写在结果区里 —— 两者必须同时可见。
  it('校验失败显示服务端中文原因，并**保留**用户输入', () => {
    const { rerender } = render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={noop} saving={false} lastValidated={null} />,
    );
    fireEvent.change(screen.getByLabelText('工作区根目录'), { target: { value: 'Z:/nope' } });

    rerender(
      <WorkspaceSettingsCard
        settings={settings({ workspaceRoot: ROOT })}
        onValidate={noop}
        saving={false}
        lastValidated={{ root: 'Z:/nope', ok: false, message: '工作区根目录不可写：Z:/nope（EACCES）' }}
      />,
    );

    expect(screen.getByText('工作区不可用，设置未改动')).toBeInTheDocument();
    expect(screen.getByText('工作区根目录不可写：Z:/nope（EACCES）')).toBeInTheDocument();
    expect(screen.getByLabelText('工作区根目录')).toHaveValue('Z:/nope');
  });

  it('saving 时输入框与按钮都不可用', () => {
    render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={noop} saving lastValidated={null} />,
    );

    expect(screen.getByLabelText('工作区根目录')).toBeDisabled();
    expect(screen.getByRole('button', { name: '校验并保存' })).toBeDisabled();
  });
});
```

- [ ] **Step 5: 写实现 `packages/client/ui/src/composite/workspace-settings-card.tsx`**

```tsx
'use client';

/**
 * 工作区卡：根目录 Input + 「校验并保存」+ 最近一次校验结果。
 * 纯展示：输入框是本地状态，点按钮把值交给 onValidate（调用方去发 PUT /api/settings）。
 *
 * 两个刻意的取舍：
 *   1. 按钮叫「校验并保存」而不是「校验」：它确实会写盘（服务端校验通过就落盘，§6.3），
 *      名字必须说清这一点，否则用户以为只是「试试看」而不敢点，或者点了之后不知道已经生效；
 *   2. 校验失败时**保留用户输入**：把输入框弹回旧值会让人以为是自己填错了格式，
 *      而真正的原因（建目录失败 / 不可写）就写在结果区里 —— 两者必须同时可见。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Typography } from 'antd';
import type { Settings } from '@aieval/contracts';

export interface WorkspaceSettingsCardProps {
  settings: Settings;
  onValidate: (root: string) => void;
  saving: boolean;
  /** 最近一次校验结果：null = 还没校验过；ok=false 时 message 是服务端的中文原因 */
  lastValidated: { root: string; ok: boolean; message?: string } | null;
}

export function WorkspaceSettingsCard({
  settings,
  onValidate,
  saving,
  lastValidated,
}: WorkspaceSettingsCardProps): ReactNode {
  const [root, setRoot] = useState(settings.workspaceRoot);

  // 只依赖那个字符串：设置从服务端回来（或别处改了根目录）时同步输入框，
  // 而校验失败后 settings.workspaceRoot 没变、effect 不重跑，用户刚敲的路径因此不会被顶掉。
  useEffect(() => {
    setRoot(settings.workspaceRoot);
  }, [settings.workspaceRoot]);

  return (
    <Card size="small" title="工作区" data-testid="workspace-settings-card">
      <Form layout="vertical" size="small" component={false}>
        <Form.Item
          label="工作区根目录"
          extra="评测的行工作副本、事件日志与用例缓存都落在这个目录下；默认 ~/.runs"
          style={{ marginBottom: 8 }}
        >
          <Flex gap={8}>
            <Input
              aria-label="工作区根目录"
              value={root}
              placeholder="~/.runs"
              disabled={saving}
              onChange={(event) => setRoot(event.target.value)}
            />
            <Button
              type="primary"
              loading={saving}
              // 空值不必走一趟服务端：服务端也会拒（「工作区根目录不能为空」），但那是一次多余的往返
              disabled={saving || root.trim() === ''}
              onClick={() => onValidate(root)}
            >
              校验并保存
            </Button>
          </Flex>
        </Form.Item>

        {lastValidated !== null && lastValidated.ok && (
          <Alert type="success" showIcon title={`工作区可用：${lastValidated.root}`} />
        )}
        {lastValidated !== null && !lastValidated.ok && (
          <Alert type="error" showIcon title="工作区不可用，设置未改动" description={lastValidated.message} />
        )}

        <Typography.Text type="secondary">
          改动根目录不会迁移已有产物：旧评测仍留在原目录，历史评测里显示的是它当时的实际路径。
        </Typography.Text>
      </Form>
    </Card>
  );
}
```

- [ ] **Step 6: 追加 `src/index.ts` 的两段导出**

```ts
export { JudgeSettingsCard, type JudgeSettingsCardProps } from './composite/judge-settings-card';
export {
  WorkspaceSettingsCard,
  type WorkspaceSettingsCardProps,
} from './composite/workspace-settings-card';
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test`
Expected: PASS（`judge-settings-card.test.tsx` 9 个 `it`、`workspace-settings-card.test.tsx` 6 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 8: 提交**

```bash
git add packages/client/ui/src/composite/judge-settings-card.tsx packages/client/ui/src/composite/judge-settings-card.test.tsx packages/client/ui/src/composite/workspace-settings-card.tsx packages/client/ui/src/composite/workspace-settings-card.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): 评分配置卡与工作区卡（失效默认值显式提示 + 校验失败保留输入）"
```

---

## Task 7: `web-next` —— 四个 `providers` 路由 + 设置路由的注释

**Files:**
- Create: `apps/web-next/app/api/providers/route.ts`
- Create: `apps/web-next/app/api/providers/[providerId]/route.ts`
- Create: `apps/web-next/app/api/providers/[providerId]/models/route.ts`
- Create: `apps/web-next/app/api/providers/[providerId]/models/fetch/route.ts`
- Modify: `apps/web-next/app/api/settings/route.ts:1-4`（文件头注释）
- Create: `apps/web-next/src/route-providers.test.ts`

**Interfaces:**
- Consumes: Task 1 / Task 2 的 `api` 出口；contracts 的 `ProviderCreateSchema` / `ProviderPatchSchema` / `ProviderModelInputSchema` / `ServiceError`；`@/src/server-context` 的 `readJsonBody` / `handleApiError`。
- Produces: 四个路由文件（方法见契约 §9）；测试内部的 `jsonRequest` / `ctxOf` / `seedProvider` / `stubUpstream`。

- [ ] **Step 1: 写失败测试 `apps/web-next/src/route-providers.test.ts`**

```ts
// @vitest-environment node
/**
 * 路由层端到端：/api/providers 的四个文件。
 *
 * 与 route-settings.test.ts 同源：不只测「返回了 200」，每条用例都**回读磁盘上的配置**
 * （`loadConfig()`）—— 响应体是内存对象，证明不了落盘；而「服务端拒绝了就不能落盘」
 * 正是本域最要紧的那类守卫。
 *
 * 拉模型的路由会真的调 `fetch`：一律用假上游（`vi.stubGlobal`）并在 afterEach 还原，
 * 绝不打真实网关（那会把用户密钥送到真实服务，也让用例依赖外部可用性）。
 *
 * 配置目录一律指向 mkdtempSync 出来的临时目录，绝不碰真实的 ~/.aieval。
 * 本文件是 `.ts`（不是 `.tsx`）：apps/web-next 保留 jsx: preserve，该应用内不能写 JSX 测试。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maskApiKey, type Provider } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { GET as listRoute, POST as createRoute } from '@/app/api/providers/route';
import { DELETE as deleteRoute, PUT as updateRoute } from '@/app/api/providers/[providerId]/route';
import { DELETE as removeModelRoute, POST as addModelRoute } from '@/app/api/providers/[providerId]/models/route';
import { POST as fetchModelsRoute } from '@/app/api/providers/[providerId]/models/fetch/route';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-providers-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  // 顺序要紧：先复位再删目录，否则万一删目录抛错，覆盖值会漏给下一个文件
  setConfigDirForTesting(null);
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** 用真实的 Request 全局构造请求，和 Next 交给路由的入参同形 */
function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 动态段上下文：Next 15 起 params 是 Promise（本机 16.2.7 的 route.md 明确如此），await 后才拿到值 */
function ctxOf(providerId: string): { params: Promise<{ providerId: string }> } {
  return { params: Promise.resolve({ providerId }) };
}

/** 直接往配置里塞一条供应商，避免每条用例都先走一遍 POST */
function seedProvider(patch: Partial<Provider> = {}): Provider {
  const config = loadConfig();
  const provider: Provider = {
    id: 'p-1',
    name: 'DeepSeek 官方',
    protocolType: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-original-key',
    models: [{ id: 'manual-model', source: 'manual' }],
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
    ...patch,
  };
  saveConfig({ ...config, providers: [...config.providers, provider] });
  return provider;
}

/** 假上游：只认 /models；返回给定响应并记录调用参数 */
function stubUpstream(body: string | unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 按 id 取磁盘上的供应商 */
function stored(providerId: string): Provider | undefined {
  return loadConfig().providers.find((item) => item.id === providerId);
}

describe('GET /api/providers', () => {
  it('列表只回掩码；磁盘上仍是明文（明文只进不出）', async () => {
    seedProvider();

    const res = await listRoute();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].apiKeyMasked).not.toBe('sk-original-key');
    expect('apiKey' in body[0]).toBe(false);
    expect(JSON.stringify(body)).not.toContain('sk-original-key');
    expect(stored('p-1')?.apiKey).toBe('sk-original-key');
  });
});

describe('POST /api/providers', () => {
  it('合法请求返回 200、落盘、响应里没有明文密钥', async () => {
    const res = await createRoute(
      jsonRequest('/api/providers', 'POST', {
        name: 'DeepSeek 官方',
        protocolType: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-new-key',
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('DeepSeek 官方');
    expect(body.apiKeyMasked).not.toBe('sk-new-key');
    expect('apiKey' in body).toBe(false);
    expect(loadConfig().providers).toHaveLength(1);
    expect(loadConfig().providers[0]?.apiKey).toBe('sk-new-key');
    // models 是契约里的默认值（`.default([])`），请求体不带它也必须落成空数组而不是 undefined
    expect(body.models).toEqual([]);
  });

  it('缺 apiKey 返回 400 INVALID_QUERY（context 是真 zod 的 issues），且不落盘', async () => {
    const res = await createRoute(
      jsonRequest('/api/providers', 'POST', {
        name: 'DeepSeek 官方',
        protocolType: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.context[0].path).toEqual(['apiKey']);
    // 被拒的请求不得落盘：少了这条，「先调服务再 parse」的变异体会全绿
    expect(loadConfig().providers).toEqual([]);
  });

  it('语法坏掉的请求体返回 400「请求体不是合法 JSON」', async () => {
    const res = await createRoute(
      new Request('http://localhost/api/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad json',
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('请求体不是合法 JSON');
  });
});

describe('PUT /api/providers/[providerId]', () => {
  // 编辑弹窗留空密钥 → 页面不下发 apiKey（Task 8）→ 服务端保留原密钥。
  // 这条链路断了的表现是「改个名字，所有代调开始 401」。
  it('不带 apiKey 的补丁只改名字，密钥与掩码都不变', async () => {
    seedProvider();

    const res = await updateRoute(jsonRequest('/api/providers/p-1', 'PUT', { name: '改名了' }), ctxOf('p-1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('改名了');
    expect(body.apiKeyMasked).toBe(maskApiKey('sk-original-key'));
    expect(stored('p-1')?.apiKey).toBe('sk-original-key');
  });

  it('显式下发 apiKey 时替换密钥（掩码随之变化）', async () => {
    seedProvider();

    const res = await updateRoute(jsonRequest('/api/providers/p-1', 'PUT', { apiKey: 'sk-rotated' }), ctxOf('p-1'));

    expect(res.status).toBe(200);
    const after = await res.json();
    expect(stored('p-1')?.apiKey).toBe('sk-rotated');
    expect(after.apiKeyMasked).toBe(maskApiKey('sk-rotated'));
    expect(after.apiKeyMasked).not.toBe(maskApiKey('sk-original-key'));
  });

  it('不存在的 id 返回 404 NOT_FOUND', async () => {
    const res = await updateRoute(jsonRequest('/api/providers/nope', 'PUT', { name: 'x' }), ctxOf('nope'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/providers/[providerId]', () => {
  it('删除返回 { ok: true }（不是 204）并真的落盘', async () => {
    seedProvider();

    const res = await deleteRoute(jsonRequest('/api/providers/p-1', 'DELETE'), ctxOf('p-1'));

    expect(res.status).toBe(200);
    // 必须是 JSON 体：客户端 delJson 走 res.json()，204 的空体会抛 SyntaxError
    expect(await res.json()).toEqual({ ok: true });
    expect(loadConfig().providers).toEqual([]);
  });

  it('再删一次返回 404（幂等删除会掩盖前端 id 传错）', async () => {
    const res = await deleteRoute(jsonRequest('/api/providers/p-1', 'DELETE'), ctxOf('p-1'));

    expect(res.status).toBe(404);
  });
});

describe('POST /api/providers/[providerId]/models', () => {
  it('加一条模型并落成 manual', async () => {
    seedProvider();

    const res = await addModelRoute(
      jsonRequest('/api/providers/p-1/models', 'POST', { id: 'deepseek-reasoner', source: 'manual' }),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(200);
    expect(stored('p-1')?.models).toEqual([
      { id: 'manual-model', source: 'manual' },
      { id: 'deepseek-reasoner', source: 'manual' },
    ]);
  });

  // 请求体里的 source 只用来过契约校验：来源由服务端固定为 manual。
  // 允许客户端声明 fetched，用户手工填的模型就会在下一次拉取里被按「已下架」清掉。
  it('请求体声明 source: fetched 也照旧落成 manual', async () => {
    seedProvider();

    await addModelRoute(
      jsonRequest('/api/providers/p-1/models', 'POST', { id: 'sneaky', source: 'fetched' }),
      ctxOf('p-1'),
    );

    expect(stored('p-1')?.models).toContainEqual({ id: 'sneaky', source: 'manual' });
  });

  it('空 id 返回 400 且不落盘', async () => {
    seedProvider();

    const res = await addModelRoute(
      jsonRequest('/api/providers/p-1/models', 'POST', { id: '', source: 'manual' }),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(400);
    expect(stored('p-1')?.models).toEqual([{ id: 'manual-model', source: 'manual' }]);
  });
});

describe('DELETE /api/providers/[providerId]/models', () => {
  it('按 query 里的 modelId 删掉那一条', async () => {
    seedProvider({ models: [{ id: 'keep', source: 'manual' }, { id: 'drop', source: 'manual' }] });

    const res = await removeModelRoute(
      jsonRequest('/api/providers/p-1/models?modelId=drop', 'DELETE'),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(200);
    expect(stored('p-1')?.models).toEqual([{ id: 'keep', source: 'manual' }]);
  });

  // 模型名里带 `/` `+` `#` 是常态（`vendor/model+x`）。客户端按 encodeURIComponent 传参
  // （Task 3 的守卫），服务端这一侧必须解出**逐字符相同**的 id：
  // 少了这半边，`+` 会被解成空格、`#` 之后会被当片段丢掉，表现为「点了删除没反应」。
  it('编码过的 modelId（含 / + #）能精确命中那一条', async () => {
    seedProvider({
      models: [
        { id: 'vendor/model+x#1', source: 'manual' },
        { id: 'vendor model x 1', source: 'manual' },
      ],
    });

    const res = await removeModelRoute(
      jsonRequest('/api/providers/p-1/models?modelId=vendor%2Fmodel%2Bx%231', 'DELETE'),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(200);
    expect(stored('p-1')?.models).toEqual([{ id: 'vendor model x 1', source: 'manual' }]);
  });

  it('缺 modelId 返回 400 INVALID_QUERY（不能把「没给 id」当成「删掉全部」）', async () => {
    seedProvider();

    const res = await removeModelRoute(jsonRequest('/api/providers/p-1/models', 'DELETE'), ctxOf('p-1'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('缺少查询参数 modelId');
    expect(stored('p-1')?.models).toEqual([{ id: 'manual-model', source: 'manual' }]);
  });
});

describe('POST /api/providers/[providerId]/models/fetch', () => {
  it('openai 协议：按 Authorization: Bearer 发给 {baseUrl}/models，并把结果合并进清单', async () => {
    seedProvider();
    const fetchMock = stubUpstream({ data: [{ id: 'fetched-a' }, { id: 'manual-model' }] });

    const res = await fetchModelsRoute(jsonRequest('/api/providers/p-1/models/fetch', 'POST', {}), ctxOf('p-1'));

    expect(res.status).toBe(200);
    expect(stored('p-1')?.models).toEqual([
      { id: 'manual-model', source: 'manual' },
      { id: 'fetched-a', source: 'fetched' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/models');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-original-key');
  });

  // F1 / §6.1：拒绝必须在服务端，而且**一次网络都不发**。前端禁用按钮只是第二道防线，
  // 老页面缓存或直接打接口都能绕过它 —— 那一绕就会拿 404 的 HTML 当模型清单解析。
  it('anthropic 协议：返回 400 + 中文原因，且一次上游请求都没发', async () => {
    seedProvider({ protocolType: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' });
    const fetchMock = stubUpstream({ data: [{ id: '不该被读到' }] });

    const res = await fetchModelsRoute(jsonRequest('/api/providers/p-1/models/fetch', 'POST', {}), ctxOf('p-1'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toContain('没有 /models 接口');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored('p-1')?.models).toEqual([{ id: 'manual-model', source: 'manual' }]);
  });

  it('上游 401 映射 401 AUTH_FAILED（context 带 host），清单不动', async () => {
    seedProvider();
    stubUpstream({ error: 'bad key' }, 401);

    const res = await fetchModelsRoute(jsonRequest('/api/providers/p-1/models/fetch', 'POST', {}), ctxOf('p-1'));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH_FAILED');
    expect(body.error.context).toEqual({ host: 'api.deepseek.com' });
    expect(stored('p-1')?.models).toEqual([{ id: 'manual-model', source: 'manual' }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/web-next test`
Expected: FAIL —— 收集阶段报 `Cannot find package '@/app/api/providers/route'`（四个路由文件都还不存在；若报的是「找不到模块」以外的错误，先确认 `apps/web-next/vitest.config.ts` 的 `resolve.alias` 仍在）。

- [ ] **Step 3: 写四个路由文件**

`apps/web-next/app/api/providers/route.ts`：

```ts
/**
 * 供应商接口：GET 列表（只回密钥掩码）/ POST 新增。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 */
import { createProvider, listProviders } from '@aieval/api';
import { ProviderCreateSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listProviders());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const input = ProviderCreateSchema.parse(await readJsonBody(req));
    return Response.json(createProvider(input));
  } catch (error) {
    return handleApiError(error);
  }
}
```

`apps/web-next/app/api/providers/[providerId]/route.ts`：

```ts
/**
 * 单个供应商：PUT 打补丁 / DELETE 删除。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 * 注意 `params` 是 Promise（Next 15 起）：必须先 await 才能拿到 providerId。
 */
import { deleteProvider, updateProvider } from '@aieval/api';
import { ProviderPatchSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

/** 动态段上下文：本机 Next 16.2.7 的 route.md 明确 `params` 是 Promise */
interface ProviderRouteContext {
  params: Promise<{ providerId: string }>;
}

export async function PUT(req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    const patch = ProviderPatchSchema.parse(await readJsonBody(req));
    return Response.json(updateProvider(providerId, patch));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    deleteProvider(providerId);
    // 回一个 JSON 体而不是 204：客户端 delJson 走 res.json()，空体在浏览器里是 SyntaxError
    return Response.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`apps/web-next/app/api/providers/[providerId]/models/route.ts`：

```ts
/**
 * 供应商的模型清单：POST 加一条 / DELETE 删一条（模型名走 query，见契约 §9）。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 *
 * 两个口径：
 *   1. 请求体里的 `source` 只用于过契约校验，落盘来源由服务端固定为 `manual`（见 api/providers.ts）；
 *   2. 用 `new URL(req.url).searchParams` 取模型名（而不是 `req.nextUrl`）：两者在 Next 运行时等价，
 *      但前者对测试里的普通 `Request` 同样成立，测试不必构造 NextRequest。
 */
import { addProviderModel, removeProviderModel } from '@aieval/api';
import { ProviderModelInputSchema, ServiceError } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

/** 动态段上下文：params 是 Promise（Next 15 起） */
interface ProviderRouteContext {
  params: Promise<{ providerId: string }>;
}

export async function POST(req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    const { id } = ProviderModelInputSchema.parse(await readJsonBody(req));
    return Response.json(addProviderModel(providerId, id));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    // searchParams 会把 %2F / %2B / %23 解回 / + #：客户端按 encodeURIComponent 传参（Task 3）
    const modelId = new URL(req.url).searchParams.get('modelId');
    if (modelId === null || modelId === '') {
      throw new ServiceError('INVALID_QUERY', '缺少查询参数 modelId');
    }
    return Response.json(removeProviderModel(providerId, modelId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

`apps/web-next/app/api/providers/[providerId]/models/fetch/route.ts`：

```ts
/**
 * 拉取上游 /models 并合并进清单。
 * 本文件只做「调 api → 错误映射」：没有请求体要校验（providerId 来自路径）。
 * 服务端会在 Anthropic 协议下直接拒绝（该协议没有 /models 接口，F1 / §6.1）。
 */
import { fetchProviderModels } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** 动态段上下文：params 是 Promise（Next 15 起） */
interface ProviderRouteContext {
  params: Promise<{ providerId: string }>;
}

export async function POST(_req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    return Response.json(await fetchProviderModels(providerId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: 给 `apps/web-next/app/api/settings/route.ts` 的文件头注释补一句（契约 §9 要求）**

把开头那段注释换成：

```ts
/**
 * 设置接口：GET 读当前设置，PUT 应用补丁。
 * 本路由同时承担三块设置：界面主题、评分配置（defaultJudge / rowTimeoutMs / diffBudgetBytes）
 * 与工作区根目录 —— 它们同属一份 Settings、同一次原子落盘，不为其中任一块单开路由。
 * 工作区的「校验并保存」就是 PUT { workspaceRoot }：服务端 validateWorkspaceRoot 通过才落盘。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 */
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/web-next test`
Expected: PASS（`route-providers.test.ts` 共 7 个 `describe` / 18 个 `it` 全绿；`route-settings.test.ts` 与 `server-context.test.ts` 也仍然全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add apps/web-next/app/api/providers/route.ts "apps/web-next/app/api/providers/[providerId]/route.ts" "apps/web-next/app/api/providers/[providerId]/models/route.ts" "apps/web-next/app/api/providers/[providerId]/models/fetch/route.ts" apps/web-next/app/api/settings/route.ts apps/web-next/src/route-providers.test.ts
git commit -m "feat(web-next): 供应商四个路由（密钥不下行 + modelId 走 query + 拉取走假上游可测）"
```

（带方括号的路径必须加引号：PowerShell 会把 `[...]` 当通配符。）

---

## Task 8: `web-next` —— 设置页填三个 Tab

**Files:**
- Modify: `apps/web-next/app/settings/page.tsx`（整文件替换）

**Interfaces:**
- Consumes: Task 3 的六个 hooks、Task 4/5/6 的四个组件与 `ProviderFormValues`、已有的 `useSettings()`；`@/src/nav` 的 `NAV_ITEMS` / `NavKey`。
- Produces: 无对外出口（页面）。

- [ ] **Step 1: 改写 `app/settings/page.tsx`**

```tsx
'use client';

/**
 * 设置页：四个 Tab —— 界面主题 / 模型供应商 / 评分配置 / 工作区。
 *
 * 本页是全仓唯一把 client hooks 与 ui 组件接起来的地方：组件保持纯展示（不调接口、不认识 message），
 * 数据与回调在这里注入；异步与错误提示也留在这里。
 *
 * 评分配置与工作区都写同一个 `PUT /api/settings`：它们同属一份 Settings、同一次原子落盘，
 * 不为其中任一块单开路由。工作区的「校验并保存」= `PUT { workspaceRoot }`，服务端校验通过才落盘（§6.3）。
 *
 * 注意：本页**没有自动化测试** —— `apps/web-next` 保留 `jsx: preserve`，该应用内不能写 `.tsx` 测试
 * （见 AGENT.md）。因此页面逻辑必须薄到只剩「取值 → 传参 → 把 Promise 折成 message」：
 * 判断都在 ui 组件与 hooks 里，本页只负责接线。验收靠 `pnpm typecheck` + `pnpm lint` + p6 冒烟。
 */
import { useState } from 'react';
import {
  useCreateProvider,
  useDeleteProvider,
  useFetchProviderModels,
  useProviderModels,
  useProviders,
  useSettings,
  useUpdateProvider,
} from '@aieval/client';
import type { ProviderPatch, ProviderView, SettingsPatch, ThemeMode } from '@aieval/contracts';
import {
  AppTopNav,
  JudgeSettingsCard,
  PageShell,
  ProviderFormModal,
  ProviderTable,
  WorkspaceSettingsCard,
  type ProviderFormValues,
} from '@aieval/ui';
import { Card, Flex, Form, Segmented, Skeleton, Tabs, Tooltip, message } from 'antd';
import { useRouter } from 'next/navigation';
import { NAV_ITEMS, type NavKey } from '@/src/nav';

/** 最近一次工作区校验的结果：null = 还没校验过；ok=false 时 message 是服务端的中文原因 */
interface WorkspaceValidation {
  root: string;
  ok: boolean;
  message?: string;
}

export default function Page(): React.ReactNode {
  const router = useRouter();
  const { settings, update, isUpdating } = useSettings();
  const { providers, isLoading: providersLoading } = useProviders();
  const { create, isCreating } = useCreateProvider();
  // useUpdateProvider 的 update 在这里改名：settings 的 update 才是本页的主角，两个都叫 update 会撞名
  const { update: saveProvider, isUpdating: isSavingProvider } = useUpdateProvider();
  const { remove: removeProvider, isDeleting } = useDeleteProvider();
  const { fetchModels, isFetching } = useFetchProviderModels();
  // 不取 isMutating：模型清单的增删没有对应的「卡片级」加载态，弹窗里按按钮粒度给反馈即可
  const { add: addModel, remove: removeModel } = useProviderModels();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [validation, setValidation] = useState<WorkspaceValidation | null>(null);

  // 被编辑的那条从列表里现取：增删模型 / 拉取之后列表会重取，弹窗里的清单跟着一起刷新
  const editing = providers?.find((provider) => provider.id === editingId) ?? null;

  /** 统一错误出口：服务端的 message 已是可直接展示的中文，别在这里再包一层 */
  const onError = (error: unknown): void => {
    void message.error(error instanceof Error ? error.message : String(error));
  };

  const openCreate = (): void => {
    setEditingId(null);
    setModalOpen(true);
  };
  const openEdit = (provider: ProviderView): void => {
    setEditingId(provider.id);
    setModalOpen(true);
  };
  const closeModal = (): void => {
    setModalOpen(false);
    setEditingId(null);
  };

  /**
   * 保存供应商：新建走 POST，编辑走 PUT。
   * 编辑时密钥框留空 = 不修改：**空串绝不能下发**（ProviderPatchSchema 的 apiKey 是 min(1)，
   * 空串会被 zod 判成非法补丁；即便放过也会把用户的密钥抹成空）。
   */
  const submitProvider = (values: ProviderFormValues): void => {
    if (editing === null) {
      void create({
        name: values.name,
        protocolType: values.protocolType,
        baseUrl: values.baseUrl,
        apiKey: values.apiKey,
        models: [],
      }).then(closeModal, onError);
      return;
    }
    const patch: ProviderPatch = {
      name: values.name,
      protocolType: values.protocolType,
      baseUrl: values.baseUrl,
    };
    if (values.apiKey !== '') patch.apiKey = values.apiKey;
    void saveProvider(editing.id, patch).then(closeModal, onError);
  };

  const deleteProvider = (provider: ProviderView): void => {
    void removeProvider(provider.id).catch(onError);
  };

  const fetchProviderModels = (): void => {
    if (editing === null) return;
    void fetchModels(editing.id).catch(onError);
  };
  const addProviderModel = (modelId: string): void => {
    if (editing === null) return;
    void addModel(editing.id, modelId).catch(onError);
  };
  const removeProviderModel = (modelId: string): void => {
    if (editing === null) return;
    void removeModel(editing.id, modelId).catch(onError);
  };

  const changeSettings = (patch: SettingsPatch): void => {
    void update(patch).catch(onError);
  };

  /**
   * 工作区「校验并保存」：一次 `PUT { workspaceRoot }`，服务端校验通过才落盘（§6.3）。
   * 用 then 的两个参数而不是 try/catch：失败既不吞掉、也不留下未处理的 rejection，
   * 结果交给卡片展示（失败时卡片会保留用户输入）。
   */
  const validateWorkspace = (root: string): void => {
    update({ workspaceRoot: root }).then(
      (next) => setValidation({ root: next.workspaceRoot, ok: true }),
      (error: unknown) =>
        setValidation({ root, ok: false, message: error instanceof Error ? error.message : String(error) }),
    );
  };

  const activeNav: NavKey = 'settings';

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active={activeNav} onNavigate={(href) => router.push(href)} />
      <PageShell density="default" gap={16} padding={16}>
        <Tabs
          items={[
            {
              key: 'theme',
              label: '界面主题',
              children: (
                <Card title="界面主题" size="small" data-testid="theme-card">
                  {settings ? (
                    <Form layout="vertical" size="small" component={false}>
                      <Form.Item label="主题偏好" style={{ marginBottom: 0 }}>
                        <Tooltip title="跟随系统会随操作系统的明暗偏好自动切换（无需刷新）；明亮 / 暗色为显式指定">
                          <Segmented
                            data-testid="theme-segmented"
                            size="small"
                            value={settings.theme}
                            options={[
                              { label: '跟随系统', value: 'auto' },
                              { label: '明亮', value: 'light' },
                              { label: '暗色', value: 'dark' },
                            ]}
                            onChange={(value) => void update({ theme: value as ThemeMode }).catch(onError)}
                          />
                        </Tooltip>
                      </Form.Item>
                    </Form>
                  ) : (
                    <Skeleton active />
                  )}
                </Card>
              ),
            },
            {
              key: 'providers',
              label: '模型供应商',
              children: (
                <Flex vertical gap={12}>
                  <ProviderTable
                    providers={providers ?? []}
                    loading={providersLoading || isDeleting}
                    onCreate={openCreate}
                    onEdit={openEdit}
                    onDelete={deleteProvider}
                  />
                  <ProviderFormModal
                    open={modalOpen}
                    initial={editing}
                    saving={isCreating || isSavingProvider}
                    fetchingModels={isFetching}
                    onSubmit={submitProvider}
                    onCancel={closeModal}
                    onFetchModels={fetchProviderModels}
                    onAddModel={addProviderModel}
                    onRemoveModel={removeProviderModel}
                  />
                </Flex>
              ),
            },
            {
              key: 'judge',
              label: '评分配置',
              children: settings ? (
                <JudgeSettingsCard
                  settings={settings}
                  providers={providers ?? []}
                  saving={isUpdating}
                  onChange={changeSettings}
                />
              ) : (
                <Skeleton active />
              ),
            },
            {
              key: 'workspace',
              label: '工作区',
              children: settings ? (
                <WorkspaceSettingsCard
                  settings={settings}
                  saving={isUpdating}
                  lastValidated={validation}
                  onValidate={validateWorkspace}
                />
              ) : (
                <Skeleton active />
              ),
            },
          ]}
        />
      </PageShell>
    </>
  );
}
```

- [ ] **Step 2: 类型检查与 lint**

Run: `pnpm --filter @aieval/web-next typecheck`
Expected: 通过（若报 `@aieval/ui` 找不到 `ProviderFormValues`，说明 Task 5 的 `index.ts` 导出还没加上）。

Run: `pnpm --filter @aieval/web-next lint`
Expected: 通过，零错误（`unused-imports/no-unused-imports` 会抓出没用的 `message` / `Card` 这类残留导入）。

- [ ] **Step 3: 手动确认页面能编译进构建产物**

Run: `pnpm --filter @aieval/web-next build`
Expected: 构建成功，输出里能看到 `/settings` 路由。**不要**为了看效果起一个替换服务：本机的 `/settings`（:3083）由 p6 的冒烟统一验证；这一步只证明页面能被 Next 编译。

- [ ] **Step 4: 提交**

```bash
git add apps/web-next/app/settings/page.tsx
git commit -m "feat(web-next): 设置页接上供应商 / 评分配置 / 工作区三个 Tab"
```

---

## Task 9: 设置域收尾（全量门禁 + 交叉核对）

**Files:** 无新增文件（本任务只跑门禁与核对；若 `pnpm format` 产生格式变更，随本任务的提交一并提交）。

**Interfaces:**
- Consumes: Task 1–8 的全部产出。
- Produces: 一份可复核的门禁记录（贴进提交说明或评审记录里）。

- [ ] **Step 1: 全量类型检查**

Run: `pnpm typecheck`
Expected: 8 个包全部通过，零错误。

- [ ] **Step 2: 全量 lint**

Run: `pnpm lint`
Expected: 8 个包全部通过，零错误（warning 不算失败，但本计划新增的代码不应引入 warning）。

- [ ] **Step 3: 全量测试**

Run: `pnpm test`
Expected: 全绿。至少包含：`@aieval/api` 的 `providers.test.ts`（35 个 `it`）、`@aieval/client` 的 `providers.test.tsx`（9 个 `it`）、`@aieval/ui` 的四个新组件用例（33 个 `it`：表格 5 + 弹窗 13 + 评分配置卡 9 + 工作区卡 6）、`@aieval/web-next` 的 `route-providers.test.ts`（18 个 `it`），以及各包原有用例。

- [ ] **Step 4: 交叉核对①：明文密钥不出现在任何前端 / 路由侧代码里**

Run: `git grep -n "apiKey" -- apps/web-next/app/api/providers packages/client/ui/src/composite/provider-table.tsx packages/client/ui/src/composite/provider-form-modal.tsx`
Expected: 只应命中表单字段名（`values.apiKey` / `name="apiKey"`）与 `apiKeyMasked`；**不得**出现 `provider.apiKey` 这类读明文的写法。供应商列表、表格、弹窗拿到的都必须是 `ProviderView`。

- [ ] **Step 5: 交叉核对②：路由清单与契约 §9 逐条对齐**

Run: `git ls-files apps/web-next/app/api/providers`
Expected: 恰好四行 ——

```
apps/web-next/app/api/providers/[providerId]/models/fetch/route.ts
apps/web-next/app/api/providers/[providerId]/models/route.ts
apps/web-next/app/api/providers/[providerId]/route.ts
apps/web-next/app/api/providers/route.ts
```

多一个文件（例如为评分配置或工作区另开了路由）就是偏离契约 §9：本域只有这四个。

- [ ] **Step 6: 交叉核对③：四条变异验证都已还原**

Run: `git status --porcelain` 与 `git diff`
Expected: 没有与本计划相关的未提交改动（`git diff` 为空）；`git status` 里若还有别人的未跟踪文件，保持原样、不要动它。

Run: `git log --oneline -10`
Expected: 最新 **8** 行来自本计划（Task 1–8 各一个提交；Task 9 若无格式变更就不再产生提交），再往下是脚手架的 `chore: 脚手架——…` 与设计文档的 `docs: 项目设计文档——…`。中文提交信息，形如：

```
feat(web-next): 设置页接上供应商 / 评分配置 / 工作区三个 Tab
feat(web-next): 供应商四个路由（密钥不下行 + modelId 走 query + 拉取走假上游可测）
feat(ui): 评分配置卡与工作区卡（失效默认值显式提示 + 校验失败保留输入）
feat(ui): 供应商表单弹窗（留空密钥=不修改 + 模型清单增删与按协议禁用拉取）
feat(ui): 供应商表格（删除二次确认 + 空态引导 + 协议中文标签）
feat(client): 供应商 hooks（mutation 后显式刷新列表 + modelId 编码进 URL）
feat(api): 拉取上游 /models 并合并清单（手工条目不被冲掉 + Anthropic 协议服务端拒绝）
feat(api): 供应商 CRUD 与模型清单手工维护（明文密钥只进不出 + 空串密钥不覆盖）
```

- [ ] **Step 7: 若有格式变更则提交**

Run: `pnpm format`
Expected: 若上一步之后有文件被改写，按下面提交（路径逐个显式写；**没有变更就跳过本步**）：

```bash
git status --porcelain
git add packages/server/api/src/providers.ts packages/server/api/src/providers.test.ts packages/server/api/src/index.ts packages/client/client/src/providers.ts packages/client/client/src/providers.test.tsx packages/client/client/src/index.ts packages/client/ui/src/index.ts apps/web-next/app/api/settings/route.ts apps/web-next/app/settings/page.tsx
git commit -m "style: 设置域代码格式统一（pnpm format）"
```

- [ ] **Step 8: 记录冒烟归属（本域的两项，由 p6 执行）**

本计划**不做**冒烟（真实网关调用集中在 p6，见 spec §9 的成本护栏）。把下面两项写进 p6 的冒烟清单：

1. **建两个供应商各拉一次模型**：一个 openai 协议（`https://api.deepseek.com/v1`）拉取成功、手工再加一条并再拉一次（验证手工条目仍在）；一个 anthropic 协议（`https://api.deepseek.com/anthropic`）确认「拉取模型」按钮禁用、且直接 `curl -X POST http://localhost:3083/api/providers/<id>/models/fetch` 得到 400 + 中文原因。CLI 复核：`~/.aieval/config.json` 里两个供应商的 `apiKey` 段是明文（证明代码注释里的安全取舍如实落地）、HTTP 响应里只有 `apiKeyMasked`。
   > **2026-09-26 修订**：本条后半句已作废 —— anthropic 供应商的「拉取模型」不再禁用，`…/models/fetch` 也不该再期望 `400`。
   > 现行验收：anthropic 供应商地址填 `http://host`（不带 `/v1`）与 `http://host/v1`（带尾斜杠）**都要拉到清单**（前者的 404 回退那条路要被真实走到）；
   > 「400 + 没有 /models 接口」不再是预期值。真机复验记录见 `docs/superpowers/notes/2026-09-22-features-smoke.md` §11 勘误。
2. **工作区校验**：填一个正常目录 → 提示可用；填一个被同名文件占住的路径 → 提示「无法创建工作区根目录」且 `config.json` 里的 `workspaceRoot` 未变（用 CLI `git`/`type` 复核）。

---

## 变异验证清单

四条真守卫，各自在对应任务的步骤里做（改实现 → 见失败 → 还原 → 核对 `git hash-object`）。其余断言是行为断言，不逐条做变异。

| # | 守卫 | 变异体 | 期望的失败 | 位置 |
|---|---|---|---|---|
| ① | 明文密钥只进不出 | `toView` 改成 `{ ...provider, apiKeyMasked }`（保留明文键） | `expected true to be false`（`'apiKey' in created`）；序列化断言同时开火 | Task 1 Step 7 |
| ② | 拉取是合并而非覆盖 | 合并逻辑改成 `ids.map(...)` 整体替换 | `expected [ { id: 'm3', … } ] to deeply equal [ m1(manual), m2(manual), m3(fetched) ]` | Task 2 Step 7 |
| ③ | Anthropic 协议服务端拒绝拉取 | 删掉 `if (provider.protocolType === 'anthropic')` 那一段 | `expected undefined to be an instance of ServiceError`（函数没抛错）；请求同时真的发了出去 | Task 2 Step 8 |
| ④ | `modelId` URL 编码 | `modelsUrl` 去掉 `encodeURIComponent` | `expected '…?modelId=vendor/model+x#1' to be '…?modelId=vendor%2Fmodel%2Bx%231'` | Task 3 Step 7 |

---

## Review Focus 的落点对照

| # | Review Focus 条目 | 落在哪个任务的哪条用例 |
|---|---|---|
| 1 | 编辑供应商时密钥留空 | Task 1「不传或传空串的 apiKey 都保留原密钥」/ Task 5「留空密钥提交：回调收到的 apiKey 是空串」/ Task 7「不带 apiKey 的补丁只改名字，密钥与掩码都不变」 |
| 2 | `defaultJudge` 悬空 | Task 1「删除供应商不改写 settings.defaultJudge」/ Task 6「默认评分模型已失效时显式提示，且下拉不再回显那个失效的 key」 |
| 3 | 模型 id 含 URL 特殊字符 | Task 3「remove 把 modelId 编码进 query」（★变异验证④）/ Task 7「编码过的 modelId（含 / + #）能精确命中那一条」 |
| 4 | 上游 `/models` 返回非预期结构 | Task 2「data 缺失或不是数组时……不落盘」/「响应体不是合法 JSON……不落盘」/「同时容忍 data[].id 与 data 为字符串数组两种形态」 |
| 5 | 协议改成 anthropic 后再拉取 | Task 2「anthropic 协议拒绝拉取：INVALID_QUERY + 中文原因，且 fetch 未被调用」（★变异验证③）/ Task 5「禁用依据是已保存的协议」/ Task 7「anthropic 协议：返回 400 + 中文原因，且一次上游请求都没发」 |

## spec 覆盖对照

| spec 位置 | 要求 | 落在哪个任务 |
|---|---|---|
| §3 F1 | 协议类型是「模型能否驱动某智能体」的唯一判据；Anthropic 无 `/models` | Task 2（服务端拒绝）、Task 4（协议标签一眼可分）、Task 5（按钮按协议禁用） |
| §6.1 | 供应商表格六列 + 添加弹窗四字段 + 模型清单拉取与手工增删 | Task 4、Task 5 |
| §6.1 第 1 点 | 请求照 `Authorization: Bearer`；容忍 `data[].id` 与字符串数组 | Task 2（服务层）、Task 7（路由层断言请求头） |
| §6.1 第 2 点 | 拉取是合并非覆盖 | Task 2（★变异验证②） |
| §6.1 末段 | 密钥安全取舍写进代码注释 + `chmod 0600` | Task 1 文件头 JSDoc（`chmod` 由脚手架已有的 `saveConfig` 承担） |
| §6.2 | 默认评分模型（两种协议）、输出契约预览、行超时、diff 上限 | Task 6（`JudgeSettingsCard`）、Task 8（接线到 `PUT /api/settings`） |
| §6.3 | 工作区根目录 Input + 校验（真写一次再删）+ 不动已有数据 | Task 6（卡片与结果展示）、Task 8（`PUT { workspaceRoot }`）；校验实现是脚手架已有的 `validateWorkspaceRoot` |
| §6.4 | 界面主题三档 Segmented（三处同步） | Task 8 **保持不动**（只填另外三个 Tab，不改主题那段） |
| §8 路由表 | `providers/*` 四个路由文件 + 方法 | Task 7（Step 5 的 `git ls-files` 核对） |
| §8 `/settings` 数据来源 | `useSettings()` / `useProviders()` / `useProviderModels()` / 拉取 / 工作区校验 | Task 3、Task 8（拉取用契约名 `useFetchProviderModels`，工作区校验走 `useSettings().update`） |
| §8 路由只做三件事 | 「zod 校验 → 调 api → 错误映射」 | Task 7（四个文件都只有这两个函数体） |
| §10 供应商 `/models` 拉取失败 | 保留手工清单、`message.error` 呈现原因、不阻断保存 | Task 2（保留清单 + 中文原因）、Task 8（`onError` → `message.error`） |
| §10 密钥无效 / 限流 | `AUTH_FAILED`（context 带 host）/ `RATE_LIMITED` | Task 2、Task 7（401 用例断言 `context.host`） |
| §10 工作区不可写 | 设置页校验期拦截 + `NOT_WRITABLE` | Task 6（失败时展示服务端原因）、Task 8 |
| §9「拉模型合并」 | `fetched` 不冲掉 `manual` | Task 2（★变异验证②） |
| §12 工作区根目录 | 默认 `~/.runs`，设置页可配 | Task 6（placeholder 与说明）、Task 8 |
| §12 评分者 | 全局默认（设置页）+ 用例覆盖（p2） | Task 6（全局默认部分） |

## 契约冲突（供评审复核）

| # | 冲突 | 本计划的处置 |
|---|---|---|
| C1 | 契约 §6 把 `fetchProviderModels` 钉成 `fetchProviderModels(providerId: string): ProviderView`（同步返回），但它必须发一次 HTTP 请求。契约 §7 的客户端侧写的是 `fetchModels: (id: string) => Promise<ProviderView>`，两处自相矛盾 | **不改名、不改参数**，把返回值实现为 `Promise<ProviderView>`（唯一可实现的形状）。执行者不得为了迁就同步签名去写「同步 HTTP」，也不得把函数改名成 `fetchProviderModelsAsync` 之类 |
| C2 | spec §8 的 `/settings` 数据来源一行写了 `useFetchModels()` 与 `useValidateWorkspaceRoot()`；契约 §7 的 hooks 清单里只有 `useFetchProviderModels`，没有工作区校验 hook | **以契约为准**：拉取用 `useFetchProviderModels`；工作区「校验并保存」不新开 hook，直接复用 `useSettings().update({ workspaceRoot })`（对应已有的 `PUT /api/settings`） |

两条都只涉及「名字/返回形状」，不涉及行为语义：spec 与契约对行为的描述（合并而非覆盖、Anthropic 无 `/models`、工作区校验通过才落盘）完全一致。

## 自检记录（写作者跑的检查）

1. **占位符扫描**：全文没有未定项——没有待办标记、没有「后续再补」式的措辞、没有「同上文某任务」式的偷懒引用；每个代码步骤都是可直接粘贴的完整文件。
2. **名字一致性**：`fetchProviderModels` / `addProviderModel` / `removeProviderModel` / `listAllModelOptions` / `useProviders` / `useCreateProvider` / `useUpdateProvider` / `useDeleteProvider` / `useFetchProviderModels` / `useProviderModels` / `ProviderTable` / `ProviderFormModal` / `JudgeSettingsCard` / `WorkspaceSettingsCard` 与契约 §6/§7/§8 逐字一致；props 名与 §8 的关键 props 一致。唯一新增的对外名字是 `ProviderFormValues`（p1 内部，见「实现层修正」第 6 条）。
3. **跨任务引用**：Task 3 用到的 URL 形状由 Task 7 的路由承载；Task 8 的 `ProviderFormValues` 来自 Task 5；Task 7 的测试直接断言 Task 2 的中文文案（「没有 /models 接口」）与 Task 1 的掩码语义 —— 三处都指向同一个真源，没有第二份文案。
4. **Review Focus**：5 条全部落到具体任务的用例上（见对照表），没有一条只写在文档里。

