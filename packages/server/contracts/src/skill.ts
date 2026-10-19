/**
 * 技能（skill）契约：名字准入、落盘形状、列表 / 目录树 / 单个文件的出口形状，
 * 以及 `SKILL.md` 的 frontmatter 切分。
 *
 * 三块职责各自的理由：
 *   1. **名字与 description 的准入是最严的那一条**（小写字母数字 + 单连字符、≤64；description 必填
 *      非空、≤1024）。依据不是「规范这么写」，而是「三家都装得上」是**能被启用**的前提：
 *      名字不合法时 claude 会在启动前抛错、dsh 会把整条**静默丢弃**，而 description 缺了在 dsh 与
 *      codex 的清单里都进不去。判据放在契约层，扫描器与界面共用同一把尺。
 *   2. **落盘只存停用**：`settings.skills.entries` 的值里永远只有 `disabled: true`——「启用」这件事
 *      不落盘，启用 = **删键**。开着的那条在文件里根本不存在，只留一个「被关掉过」的名单。
 *   3. **frontmatter 切分是纯函数**：`SKILL.md` 是外部输入（可能随被测仓库克隆进来），
 *      抽屉要「逐字可核的 frontmatter + 原样的正文」，扫描器要能读出 `name` / `description`
 *      判准入——两处必须是同一份切分，否则界面上看到的字段和判定用的字段会各说各话。
 */
import { z } from 'zod';

/** 技能目录里的入口文件名：一条 skill = 一个目录 + 它（只认这一层，不递归） */
export const SKILL_FILE_NAME = 'SKILL.md';

/**
 * 名字的字面规则：小写字母数字，单个连字符分隔，不许首尾连字符、不许连续连字符。
 * 与 Agent Skills 规范层同形，也是 dsh 侧真正会校验的那条（写错整条被静默丢弃）。
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 名字长度上限（规范层数字） */
export const SKILL_NAME_MAX_LENGTH = 64;

/** description 长度上限（规范层数字） */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * 目录树的递归深度上限。一条真实技能是「一个 `SKILL.md` + 几个附属目录」，两级就够；
 * 给到 6 是留足余量，又不至于让一次误放的深目录树把整份响应撑爆。
 * 到达上限时树头带 `truncated` 置真——**不静默截断**，界面上要能说出「没列全」。
 */
export const SKILL_TREE_MAX_DEPTH = 6;

/** 一棵树列出的节点总数上限（同上，超限即停并置 `truncated`） */
export const SKILL_TREE_MAX_NODES = 2000;

/** 技能内部相对路径的字符长度上限 */
export const SKILL_FILE_PATH_MAX_LENGTH = 512;

/**
 * 单个文件的预览上限：超过它就**不给正文**，只给一句「N MB，超过预览上限」。
 * 依据是「文本到这个体量已经极长」——256 KB 的 markdown 约十万汉字，再大浏览器渲染会明显卡，
 * 而技能正文的用途是**看**、不是下载。
 * 这一格与「装入是整目录复制、不设体积上限」不是一回事，别混成一句话：
 * 那条管的是**装得上**，这条管的是**看得见**。
 */
export const SKILL_PREVIEW_MAX_BYTES = 256 * 1024;

/**
 * 技能内部的相对路径（`SKILL.md`、`reference/API.md`）。
 *
 * 它是**路径穿越的第一道门**（第二道在 core 的 `realpath` 复核）：绝对路径、空段、`.`、`..`
 * 一律在契约层就拒掉——「拼绝对路径」是 core 的事，调用方只许给相对路径。
 * 只在「读技能里某个文件」这一条路上用；列表与目录树都用不着调用方给路径。
 */
export const SkillFilePathSchema = z
  .string()
  .min(1)
  .max(SKILL_FILE_PATH_MAX_LENGTH)
  .refine((value) => !value.startsWith('/'), '技能内路径必须是相对路径（不许以 / 开头）')
  .refine(
    (value) => value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    '技能内路径不许出现空段、`.` 或 `..`（那是往技能目录外走）',
  )
  .refine(
    (value) => value.split('/').length <= SKILL_TREE_MAX_DEPTH,
    `技能内路径的层数上限是 ${SKILL_TREE_MAX_DEPTH}`,
  );
export type SkillFilePath = z.infer<typeof SkillFilePathSchema>;

/**
 * 名字是否满足准入。
 * 只判形状与长度，**不做任何兜底改写**：把 `Tang Poem` 规整成 `tang-poem` 会让界面上的名字与目录名、
 * 与厂商清单里的名字三方不一致，而用户明明写错了一处却看不到任何提示。
 */
export function isValidSkillName(name: string): boolean {
  return name.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name);
}

/**
 * description 是否满足准入：**必填、非空、≤1024**。
 * 纯空白按「没写」处置——dsh 的 required 字段拿到一串空格与拿到空串是同一个结果（整条被丢弃），
 * 放行它只会把「这条装不上」推迟到运行期。
 */
export function isValidSkillDescription(description: string): boolean {
  return description.trim() !== '' && description.length <= SKILL_DESCRIPTION_MAX_LENGTH;
}

/**
 * 写侧的名字（补丁的键）：非法名从 API 进不来（400）。
 * 读侧**不用它**：手改 `config.json` 写进去的非法键保留但不显示——它永远匹配不上扫描结果。
 */
export const SkillNameSchema = z
  .string()
  .max(SKILL_NAME_MAX_LENGTH)
  .regex(SKILL_NAME_PATTERN, '技能名只允许小写字母、数字与单个连字符');
export type SkillName = z.infer<typeof SkillNameSchema>;

/**
 * 落盘条目：值里**只允许** `disabled: true`。
 * `strict()` 不是洁癖：`{ disabled: true, enabled: false }` 这种自相矛盾的输入被静默 strip 之后，
 * 落盘的是一个「看起来对」的值，而调用方的意图（打开它）被无声丢掉。宁可 400 说出来。
 */
export const SkillDisabledSchema = z.object({ disabled: z.literal(true) }).strict();

/**
 * `settings.skills`：name-keyed map 的停用名单。
 *
 * ⚠️ **命名撞车（三处同名不同义）**：这一格回答「**本机配置里关了哪几条**」；
 * `VendorSkillSchema`（本文件）回答「**厂商当时说它手里有哪几条**」；
 * `RowSkillInstallSchema`（`run.ts`）回答「**这一行实际装上了哪几条、我们凭什么这么说**」。
 * 三处都以 skills 命名，`grep skills` 时先读这三行。
 *
 * 与 MCP 的 `mcpServers` 两处刻意不同：① **没有预置项**（默认就是空 map），
 * 故 MCP 那套「键在不在文件里 = 播过没播过」的播种判据在这里无事可做；
 * ② 它是**逐条合并**的（只动补丁里出现的名字），而 MCP 是整份替换。
 */
export const SkillsSettingsSchema = z.object({
  entries: z.record(SkillNameSchema, SkillDisabledSchema),
});
export type SkillsSettings = z.infer<typeof SkillsSettingsSchema>;

/**
 * 补丁条目：这里收的是**期望状态**（`disabled: boolean`），与落盘那条（只许字面量 `true`）刻意不同形。
 * 两条并成一条的两种改法各坏一半：放宽落盘那条 ⇒「配置里只出现停用」这条不变量没人守；
 * 让补丁复用落盘那条 ⇒「再打开」（`{disabled:false}` ⇒ 删键）在 API 门口就被判 400。
 * 多余字段同样拒绝：`{disabled:true, enabled:false}` 是自相矛盾的输入，宁可 400 说出来。
 */
export const SkillDisabledPatchSchema = z.object({ disabled: z.boolean() }).strict();

/**
 * `settings.skills` 的**补丁**形状。
 * `entries` 这一层不能省：补丁的 partial 只让顶层键（`skills`）可选，`{ skills: {} }` 说的是
 * 「没说改哪一条」，与「一条都不改」不是同一句话——那种输入该在门口 400，而不是静默当成无改动。
 */
export const SkillsPatchSchema = z.object({
  entries: z.record(SkillNameSchema, SkillDisabledPatchSchema),
});
export type SkillsPatch = z.infer<typeof SkillsPatchSchema>;

/**
 * 列表里的一条。**坏条目也在列表里**（`ok:false` + 中文 `reason`）——它要被显示成一行，
 * 那就必须在列表里；丢进 `skillWarnings` 的话界面没有行可挂，用户只会觉得「我放的 skill 不见了」。
 *
 * `name` 走宽松的字符串而**不是** `SkillNameSchema`：这一格是**目录名**，而目录名不合法正是
 * 要被展示出来的那类坏条目（走了最严规则的话它们连列表都进不来，等于静默丢弃）。
 *
 * **没有体积这一格**，这是刻意的：整目录字节数要递归遍历 + 逐文件 `stat`，而列表是每次进设置页
 * 都要扫一遍的热路径；一个没人读的派生量不值得挂在每一行上。真要看占用就 `du -sh`——
 * 那也不经过契约，没有第二个真源。
 * **也不留一个恒缺席的可选字段**：算不出来时它只能缺席，于是「没采集」与「真的是 0」分不开。
 */
export const SkillEntrySchema = z.object({
  /** = 目录名 = 装入落点的目录名（与 frontmatter 的 `name` 不一致时该条 `ok:false`） */
  name: z.string().min(1),
  /** 绝对路径（与 `workspaceRoot` / `casesRoot` 明文下行同口径） */
  dir: z.string().min(1),
  /** frontmatter 的 description；读不出 / 缺这一格时是空串 */
  description: z.string(),
  /** 准入是否通过；false 时 `reason` 必给 */
  ok: z.boolean(),
  /** ok:false 的中文原因（可直接展示） */
  reason: z.string().min(1).optional(),
  /** 恒给布尔：服务端算好「缺省 = 开启」，界面不做「缺省 = 开启」的推理 */
  disabled: z.boolean(),
});
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

/** 根级异常（目录不存在 / 不可读）：没有条目可挂，故与 `skills` 并列而不是塞进某一行 */
export const SkillWarningSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});
export type SkillWarning = z.infer<typeof SkillWarningSchema>;

/**
 * `GET /api/skills` 的出口形状。
 *
 * `root` 是技能根的绝对路径：卡片工具条要显示它，而它**不能由界面从条目路径反推**——
 * 空列表（目录不存在、或刚清空）时没有任何条目可推，那正是最需要把路径显示出来的两态。
 *
 * 两个数组都**必填**：`skills: []` 永远表示「扫过且没有」，不是「未观测」——
 * 缺席与空数组在界面上是两句不同的话，让它们可分是这一格存在的理由。
 */
export const SkillListSchema = z.object({
  root: z.string().min(1),
  skills: z.array(SkillEntrySchema),
  skillWarnings: z.array(SkillWarningSchema),
});
export type SkillList = z.infer<typeof SkillListSchema>;

/**
 * 目录树上的一个节点（左树那一栏）。
 *
 * `path` 是**叶子名**（`SKILL.md`、`reference`、`API.md`），全路径由组件遍历拼出——
 * 这与 AI Elements 的 File Tree pattern（Collapsible + Button 递归）同形，
 * 界面上不出现第二套路径表达。
 *
 * `sizeBytes` 是**单个文件的字节数**；目录为 `null`（目录体积要递归求和，那是另一件事，
 * 而且列树时不该做）。读不出大小（权限 / 坏链）同样是 `null`——
 * `null ≠ 0` 同纪律，不拿 0 顶替。
 *
 * `children` **恒为数组**：叶子是 `[]` 而不是 `undefined`，这样界面判「是不是目录」只看
 * `isDirectory` 一个字段，不必同时判 `children` 在不在。
 */
export interface SkillTreeNode {
  title: string;
  path: string;
  isDirectory: boolean;
  children: SkillTreeNode[];
  sizeBytes: number | null;
}

/** 递归 schema；显式标注 `ZodType<SkillTreeNode>` 是让 TS 接受自引用 */
export const SkillTreeNodeSchema: z.ZodType<SkillTreeNode> = z.lazy(() =>
  z.object({
    title: z.string().min(1),
    path: z.string().min(1),
    isDirectory: z.boolean(),
    children: z.array(SkillTreeNodeSchema),
    sizeBytes: z.number().int().nonnegative().nullable(),
  }),
);

/**
 * `GET /api/skills/<name>/tree` 的出口形状：一条技能的目录树。
 *
 * `name` / `dir` 与列表里那条同义（`dir` 是绝对路径，抽屉顶部要显示它）。
 * `truncated` 是**如实交代**：深度或节点数到达上限时为真，界面据此说「没列全」——
 * 静默少列几行会让人把「树里没有」当成「磁盘上没有」。
 */
export const SkillTreeSchema = z.object({
  name: z.string().min(1),
  dir: z.string().min(1),
  root: SkillTreeNodeSchema,
  truncated: z.boolean(),
});
export type SkillTree = z.infer<typeof SkillTreeSchema>;

/**
 * 一条 skill **从哪来**（本机启用项 / 厂商内置 / 被测仓库自带 / 来源未证实）。
 *
 * ⚠️ **命名撞车（三处同名不同义，先看这一行再 grep）**：
 *   · `SkillsSettingsSchema`（本文件）＝ 设置页的**停用名单**：本机配置里关了哪几条；
 *   · `VendorSkillSchema`（本文件）＝ **厂商当时说它手里有哪几条**（含内置与被测仓库自带的）；
 *   · `RowSkillInstallSchema`（`run.ts`）＝ **这一行实际装上了哪几条、我们凭什么这么说**。
 */
export const VENDOR_SKILL_ORIGINS = ['local-enabled', 'vendor-builtin', 'repo-provided', 'unverified'] as const;

export const VendorSkillOriginSchema = z.enum(VENDOR_SKILL_ORIGINS);
export type VendorSkillOrigin = z.infer<typeof VendorSkillOriginSchema>;

/**
 * 四档来源的中文文案。**放契约里**（与 `ROW_MCP_VERDICT_LABELS` 同一条理由）：
 * 界面、行卡片与服务端说的是同一件事，各抄一份必然漂移。
 * `unverified` 的文案是「**来源未证实**」：厂商给不出这一格就照实说，**不许猜**。
 */
export const VENDOR_SKILL_ORIGIN_LABELS: Record<VendorSkillOrigin, string> = {
  'local-enabled': '本机启用项',
  'vendor-builtin': '厂商内置',
  'repo-provided': '被测仓库自带',
  unverified: '来源未证实',
};

/**
 * 判来源时用得到的三样证据：厂商原值（claude 的 `source` / codex 的 `scope`）、
 * 厂商给的落点（codex 有、claude 没有）、以及**本行的两个目录**。
 *
 * 为什么本行的目录要传进来而不是「按厂商名查一张静态表」：同一个 `scope: "user"`
 * 在这台机器上可能指行配置目录、也可能指厂商自己的目录，只有与本行的目录比对才是证据
 * （与 `row-mcp.ts` 那条「通道决定读法、别按厂商名查表」同一条纪律）。
 */
export interface SkillOriginEvidence {
  /** 厂商原值照抄（不认识就落 `unverified`，不翻译、不猜） */
  source: string | null;
  /** 厂商给的落点绝对路径；厂商没给 ⇒ `null`（那就只能靠 `source`） */
  path: string | null;
  /** 本行的配置目录（`AgentRunInput.configHome`） */
  configHome: string;
  /** 本行的工作目录（被测仓库根） */
  cwd: string;
  /**
   * 真实路径解析器（跟随软链）。**只由 Node 侧的采集方注入**（适配器传 `realpathSync`）。
   *
   * 为什么不在这里直接 `import 'node:fs'`：契约是**同构**包——界面也要读它的标签表，
   * 顶层引 `node:*` 会让浏览器那侧的打包直接失败（报 `does not support external modules`），
   * 而 `tsc` / `eslint` / 单测**都看不见**这一层（守卫在 `isomorphic.test.ts`）。默认恒等。
   */
  resolveRealPath?: (value: string) => string;
}

/** 路径归一：统一正斜杠、去尾斜杠（**不折叠大小写**——厂商原值照抄，比较只是前缀判断） */
function normalizeDir(value: string): string {
  const slashed = value.replace(/\\/g, '/');
  return slashed.endsWith('/') ? slashed.slice(0, -1) : slashed;
}

/**
 * 真实路径（跟随软链）；解析不到就回落到原值。
 * 回落的两种情形都要保留判据：路径已经被删掉（厂商报了个历史落点）与合成路径
 * （守卫里的 `/runs/…` 这类字面量）。判据问的是「这个落点像不像在那个目录之下」，
 * 不是「它现在还在不在」。
 */
function realDir(value: string, resolveRealPath: ((value: string) => string) | undefined): string {
  if (resolveRealPath === undefined) return value;
  try {
    return resolveRealPath(value);
  } catch {
    return value;
  }
}

/**
 * 一个路径的两种可比形态：原样 + 真实路径（两者相同时只留一份）。
 *
 * 为什么必须两种都比：同一个目录在**厂商报的落点**与**我们手里的目录**之间常常只是写法不同
 * ——macOS 上 `/tmp` 与 `os.tmpdir()` 都是软链形态、真实路径是 `/private/tmp/…`，
 * 只比原样会让**落点这一条分支整体失效**（剩下的原值兜底给不出结论）；而只比真实路径
 * 又会让合成路径与已删除的落点失去判据。两种形态各自成立，故并列。
 */
function comparableForms(value: string, resolveRealPath: ((value: string) => string) | undefined): string[] {
  const raw = normalizeDir(value);
  const real = normalizeDir(realDir(value, resolveRealPath));
  return raw === real ? [raw] : [raw, real];
}

/** `child` 是不是 `parent` 之下（**严格**：`parent` 自己不算），两侧都按可比形态逐一比 */
function isUnder(child: string, parent: string, resolveRealPath: ((value: string) => string) | undefined): boolean {
  const bases = comparableForms(parent, resolveRealPath).filter((base) => base !== '');
  if (bases.length === 0) return false;
  return comparableForms(child, resolveRealPath).some((form) => bases.some((base) => form.startsWith(`${base}/`)));
}

/** codex 内置 skill 的落点目录名：app-server 启动时自己落盘的 6 条住在这里 */
const VENDOR_BUILTIN_DIR = '.system';

/**
 * 给一条厂商下发的 skill 判来源。**判据只有「厂商原值」与「落点」两样**，拿不到就 `unverified`。
 *
 * 顺序是有意的（先落点、后原值；落点比原值细）：
 *   1. 落在 `<行配置目录>/skills/.system/` 之下 ⇒ `vendor-builtin`（codex 自己的内置目录，
 *      它在**同一个** `skills/` 下，所以这一条必须排在下一档之前）；
 *   2. 落在行配置目录之下 ⇒ `local-enabled`（`~` 在行内就是这里 ⇒ codex 的 `scope: "user"` 同档）；
 *   3. 落在工作目录之下 ⇒ `repo-provided`（被测仓库自带的 `.claude/skills/` 那一类，
 *      行内 `settingSources` 全开时会被自动发现，是跨家的静默差异）；
 *   4. 厂商原值里的三档已知取值：claude 的 `userSettings` ⇒ 本机启用项、`projectSettings` ⇒ 被测仓库自带、
 *      `built-in` ⇒ 厂商内置；codex 的 `system` ⇒ 厂商内置；
 *   5. 其余一律 `unverified`——**不拿「厂商没给这一格」推一个来源出来**。
 *
 * ⚠️ 第 4 档的值域是**逐字实测**得来的（claude `getContextUsage().skills.skillFrontmatter[].source`：
 * `userSettings` / `projectSettings` / `built-in`；codex `skills/list` 的 `scope`：`user` / `system`）。
 * 新增取值时先量到真值再加进这张表，别按命名推测——猜错的表现是「来源」那一格说了一句假话，
 * 而它在界面上与真话长得一模一样。
 */
export function classifySkillOrigin(evidence: SkillOriginEvidence): VendorSkillOrigin {
  const { path, source, configHome, cwd, resolveRealPath } = evidence;
  if (path !== null) {
    if (isUnder(path, `${normalizeDir(configHome)}/skills/${VENDOR_BUILTIN_DIR}`, resolveRealPath)) return 'vendor-builtin';
    if (isUnder(path, configHome, resolveRealPath)) return 'local-enabled';
    if (isUnder(path, cwd, resolveRealPath)) return 'repo-provided';
  }
  if (source === 'userSettings') return 'local-enabled';
  if (source === 'projectSettings') return 'repo-provided';
  if (source === 'built-in' || source === 'system') return 'vendor-builtin';
  return 'unverified';
}

/**
 * 厂商下发的技能清单里的**一条**（`vendor-system.skills` 的元素）。
 *
 * 与 `RowSkillInstallSchema` 的分工（照 MCP 那两格）：这一格回答「**厂商当时说了什么**」，
 * 行级那一格回答「**这一行实际装上了哪几条、我们凭什么这么说**」。
 */
export const VendorSkillSchema = z.object({
  /** 厂商报的技能名（本仓装入的那几条名 = 目录名，两边可直接配对） */
  name: z.string().min(1),
  /**
   * 这一条**从哪来**的厂商原值：claude 的 `skillFrontmatter[].source`、codex 的 `scope`。
   * 自由字符串、**照抄不翻译**（与 `RowMcpServerSchema.source` 同一条理由：翻译就是第二个真源）。
   * 厂商没投这一格 ⇒ `null`。
   */
  source: z.string().nullable(),
  /** 厂商给的落点绝对路径（codex 有、claude 没有）；没给 ⇒ `null` */
  path: z.string().nullable(),
  /**
   * 归一后的来源分档，**由采集它的适配器按 `classifySkillOrigin` 判**（那一层同时知道
   * 行配置目录与工作目录）。界面只按 `VENDOR_SKILL_ORIGIN_LABELS` 渲染，不再自己推。
   */
  origin: VendorSkillOriginSchema,
});
export type VendorSkill = z.infer<typeof VendorSkillSchema>;

/**
 * 造一条**只有名字**的厂商技能条目：厂商（或我们读到的那个通道）只给了名字，来源一格拿不到。
 *
 * 为什么单独给一个构造器而不是让每家各拼一个对象字面量：`origin` 那一格必须落成
 * `unverified`（「来源未证实」），而三处各写一遍时总有一处会顺手填一个看起来合理的来源
 * ——那正是「不许猜」要防的事。真身是 dsh 的 `skill-catalog`（它的清单只有名字）。
 */
export function namedVendorSkill(name: string): VendorSkill {
  // 判据与 `classifySkillOrigin` 同源（无来源、无落点 ⇒ 未证实），这里只是把它固定下来
  return { name, source: null, path: null, origin: classifySkillOrigin({ source: null, path: null, configHome: '', cwd: '' }) };
}

/**
 * 读到的**一个**技能文件：技能内相对路径 + **原文**。
 *
 * 只给原文、不给「frontmatter / body 两半」：树上的预览是**整份文件按 markdown 渲染**
 * （`SKILL.md` 的 frontmatter 段由界面先包成 yaml 围栏代码块——不收这一层的话，收尾那条 `---`
 * 会按 CommonMark 的 setext 规则把 `name:` / `description:` 吃成一个标题），切分只发生在服务端的
 * 准入判定里（`splitSkillMarkdown` 仍在 `core` 服务扫描器）。界面上摆一份解析结果、文件里写着
 * 另一份，就是第二真相；要看字段就整个文件一起看。
 *
 * `path` 原样回传请求里那一格，调用方据此确认「拿到的是我点的那一个」（异步取数会乱序）。
 */
export const SkillFileTextSchema = z.object({
  path: SkillFilePathSchema,
  text: z.string(),
});
export type SkillFileText = z.infer<typeof SkillFileTextSchema>;

/** frontmatter 的切分结果：逐字原文 + 正文原文 + 顶层字段（判准入用） */
export interface SkillMarkdown {
  /** 含首尾围栏的逐字原文（供界面「原文可核」地展示）；没有 frontmatter 时为 null */
  frontmatter: string | null;
  /** 围栏之后的**原文**（不减不改：空白与缩进是 markdown 语法的一部分） */
  body: string;
  /** frontmatter 的顶层标量字段；嵌套结构不进这里 */
  fields: Record<string, string>;
}

/** frontmatter 的围栏行 */
const FENCE = '---';

/** 块标量指示符：`>` / `|` 及其 chomping 修饰（`>-` / `|+` 这类） */
const BLOCK_INDICATOR = /^[>|][+-]?$/;

/** 顶层字段行：`key: value`（键只认字母数字、下划线、连字符） */
const FIELD_LINE = /^([A-Za-z0-9_-]+):(.*)$/;

/** 去掉行尾的 `\r`：CRLF 文件里每一行都带着它，不剥掉会连字段名与围栏一起对不上 */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * 剥掉值两侧成对的引号。**不做转义还原**：frontmatter 里能出现的转义（`\"` / `\\`）在技能名与
 * 描述这两个字段上都不是真实需求，而半吊子还原会把 `C:\path` 这类值改坏。
 */
function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')));
  return quoted ? value.slice(1, -1) : value;
}

/**
 * 折叠块（`>`）拼接：同一段内的行用空格连，段与段之间（中间夹空行）用换行连。
 * 字面块（`|`）不折叠，按行原样 join——这是 YAML 两种块标量的差异，也是唯一不能省的一处。
 */
function joinBlock(lines: readonly string[], folded: boolean): string {
  if (!folded) return lines.join('\n');
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line === '') {
      paragraphs.push([]);
      continue;
    }
    paragraphs[paragraphs.length - 1]?.push(line);
  }
  return paragraphs
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => paragraph.join(' '))
    .join('\n');
}

/**
 * 解析 frontmatter 的顶层标量字段。
 * 三条已知边界（都是**刻意**的，不是漏掉）：① 嵌套映射 / 数组不进 `fields`（技能只用得到
 * name 与 description 两个平铺标量）；② `#` 行按注释跳过，行尾的 ` #` 不当注释切（值里带 `#` 更常见）；
 * ③ 值里的转义不还原（见 `unquote`）。
 */
function parseFields(lines: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripCr(lines[index] ?? '');
    // 空行与整行注释跳过；**缩进行是嵌套结构**（或已被块标量吃掉的续行），顶层字段只认顶格的键
    if (line.trim() === '' || line.trim().startsWith('#') || /^[ \t]/.test(line)) continue;
    const matched = FIELD_LINE.exec(line);
    if (matched === null) continue;
    const key = matched[1];
    const rest = (matched[2] ?? '').trim();
    if (key === undefined) continue;

    // 块标量：`key: >` / `key: |` 之后那些更缩进的行属于这个键
    if (BLOCK_INDICATOR.test(rest)) {
      const collected: string[] = [];
      while (index + 1 < lines.length) {
        const next = stripCr(lines[index + 1] ?? '');
        // 回到顶格的下一行即块结束；空行留在块内（它可能是分段）
        if (next.trim() !== '' && !/^[ \t]/.test(next)) break;
        index += 1;
        collected.push(next.trim() === '' ? '' : next.replace(/^[ \t]+/, ''));
      }
      while (collected[collected.length - 1] === '') collected.pop();
      fields[key] = joinBlock(collected, rest.startsWith('>'));
      continue;
    }
    fields[key] = unquote(rest);
  }
  return fields;
}

/**
 * 切一份 `SKILL.md`：frontmatter 逐字一段、正文一段、顶层字段一份。
 *
 * 识别规则：**第一行**必须是 `---`（容忍 BOM 与 CRLF），再找到下一条 `---` 收尾；
 * 只有开围栏没有闭合时按「没有 frontmatter」处置——那是半个块，认它会把整份正文当成字段表。
 * 找不到 frontmatter 时 `frontmatter` 为 null、`body` 是**整份原文**（一字不动）。
 */
export function splitSkillMarkdown(raw: string): SkillMarkdown {
  const lines = raw.split('\n');
  const first = stripCr(lines[0] ?? '').replace(/^\uFEFF/, '');
  if (first !== FENCE) return { frontmatter: null, body: raw, fields: {} };

  const closing = lines.findIndex((line, index) => index > 0 && stripCr(line) === FENCE);
  if (closing < 0) return { frontmatter: null, body: raw, fields: {} };

  return {
    frontmatter: lines.slice(0, closing + 1).join('\n'),
    body: lines.slice(closing + 1).join('\n'),
    fields: parseFields(lines.slice(1, closing)),
  };
}
