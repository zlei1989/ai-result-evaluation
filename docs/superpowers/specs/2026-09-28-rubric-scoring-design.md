# AI 生成代码评测工具 — 评分体系重构（评分标准项表格）设计

日期：2026-09-28
状态：待评审
前置：`docs/superpowers/specs/2026-09-22-features-design.md`（功能设计：用例 / 评测 / 设置）、`docs/superpowers/specs/2026-09-28-structured-judge-output-design.md`（结构化输出，**已落地**；本设计要**同批替换**它落下的两份契约投影，见 §4.4）
性质：本文**替换**评分口径的整条链路——把「固定 5 维、等权、每维 1–5 分」换成「**组 → 评分项（ID / 目标 / 权重）**的二级表格，每项二元判定（达成 / 未达成），总分 = 达成项权重之和」。与前置文档冲突时**以本文为准**：features-design §3 F4（固定 5 维）、§5.7（总分算式）、§7.3（1–5 分）三条作废。**不做任何兼容**：旧 `judgePrompt` 文本、旧 `ScoreResult.dimensions`、旧评分记录一律不再支持（§10）。

---

## 1. 要解决的问题

现状（已实现的事实）：

1. **评分口径写死**：`contracts/score.ts` 里 `DIMENSIONS` 是 5 个常量、`DIMENSION_COUNT = 5`、`ScoreResult.dimensions` 是 `{ key, label, score(1–5), reason }[]`，总分 `round(sum / 25 * 100)`。用例上只有一段自由文本 `judgePrompt`，它对分数**没有任何约束力**——真正决定分数的是那 5 个常量；
2. 后果：**「这一分是怎么来的」在界面上讲不清**。想评「`agent` 字段进了对外契约」（18 分）这种具体条目，只能写进 `judgePrompt` 求模型照办，而模型回的是 5 维分数，两者的对应关系没有任何地方能校验；
3. `docs/superpowers/specs/…` 里 5 维的存在理由是「本期固定」，而实际使用中评测者关心的是**逐条交付项**（某个字段加没加、某条测试建没建、某个报文键名守没守住），不是「可维护性打几分」；
4. 生成侧（`api/judge.ts`）已经能把「题面 + 仓库名」变成一份 `judgePrompt` + 维度清单，但它产出的是**散文**，落库后无法核对；`case-form-panel` 的「评分维度（只读预览）」又是一张与 `judgePrompt` 毫无关系的常量表。

需求（用户口径，2026-09-28）：

- 评分标准改成**动态二级表格**：`组 + 评分项（ID / 目标 / 权重）`；「评分项 / 目标」两列合为一列 `目标`——它是自足的判据描述（既说清改哪里，也说清怎样算达成）；
- 表格**可编辑**（增 / 删 / 改组与项）；
- 两个按钮：**「智能生成」**——AI 对**已有表格**做补充；**「智能识别」**——弹对话框，框内**只有文本域**，识别提示词后**回填**表格；
- 评分项二元判定：**达成得该项全部权重，未达成 0 分**；总分 = 达成项权重之和；
- **不强制权重和为 100**：100 / 120 / 300 都由表格配置决定，权重之和就是满分；
- **组不带权重**，只有项带权重；
- 评分项短 ID（`A1` / `D5`）由 AI 生成，**允许为空**；
- 评分表**跟着一轮评测快照进 `run.json`**；
- 不写清理脚本（旧数据由用户自行清除）。

成功标准：

1. 在用例表单上能直接看到并编辑「评分标准项」二级表格，表尾实时显示「满分 N 分 · 共 M 项」；
2. 「智能识别」把用户粘贴的一段 Markdown 评分要求（用户示例：两组共 11 项、权重 18/4/20/3/3/14/10/5/4/13/6）**原样**变成表格：组名不改、权重数字不改、不合并不拆分；
3. 「智能生成」只**新增**条目，已存在的行一个字不动；同名组的新项插到该组末尾，新主题才建新组；表格已完备时可以什么都不加；
4. 一次评测跑完后，评分详情页能逐项看到「达成 / 未达成 + 理由」，总分恰好等于达成项权重之和，满分恰好等于快照权重之和；
5. 改了用例的评分表之后，**历史记录与「重新评分」仍按当时快照那把尺子**；
6. 旧数据（旧 `judgePrompt`、旧 5 维评分记录）**不兼容也不静默伪装**：删掉即可，代码里不留任何兼容分支。

---

## 2. 本阶段范围

| 做 | 不做 |
|---|---|
| `Rubric` / `RubricGroup` / `RubricItem` 契约 + 校验 + 总分与满分公式 + 评测渲染 | 评分表的版本历史 / 多套模板库 / 跨用例复制 |
| 用例表单的「评分标准项」可编辑表格（增删改） | 表格单元格的富文本 / 拖拽排序 / 权重可视化 |
| 「智能生成」（补充）与「智能识别」（回填）两个接口与按钮 | 流式生成（沿用非流式文本调用） |
| `run.json` 的 `rubric` 快照 + 评分读快照 | 评分表变更对历史记录的**追溯改写** |
| 两条评分通路（文本 / 智能体）的提示词与解析改写 | 两条通路的合并 |
| 评分详情 / 用例详情的二级表格渲染 | 列表页展示逐项明细（列表继续只显示总分一个数） |
| 旧常量、旧字段、旧组件的删除；旧用例在读侧的显式拒绝（§10） | 旧数据迁移脚本（用户自行清除） |

---

## 3. 关键决策与理由

| # | 决策 | 理由 | 被否掉的替代 |
|---|---|---|---|
| D1 | **评分表是结构化数据，提示词是它的渲染**；用户输入的提示词只是一次性的**生成输入**，不落盘 | 「界面显示的表格」与「模型看到的表格」必须同一份数据；存文本再解析，就多出一条「文本改了、数据没跟上」的漂移路径，而它的症状是分数与界面不一致 | 存 Markdown 文本、界面解析出来（解析器要容忍任意写法；表坏了界面无法解释）；两者都存（两套真相，必然不一致） |
| D1b | 表格**三列**：`ID` / `目标` / `权重`——用户示例里的「评分项」与「目标」两列**合成一列** | 「评分项」（改哪里）与「目标」（怎样算达成）是同一件事的两半，拆成两列会让 AI 生成与手工编辑都多一格，而模型判定时两列必须一起读；合成一列后它是**自足的判据描述** | 四列逐列对齐示例（多一格要填、AI 更容易只填一半） |
| D2 | 组**不带权重**，只有项带权重；满分 = 全部项权重之和 | 组权重是冗余信息（组内项之和），多一层就多一处算错的机会；用户可直接写 120 分 / 300 分的表 | 组也带权重并校验「组内项之和 == 组权重」（AI 生成时更容易出错，要校验的规则多一倍） |
| D3 | **不强制权重和等于 100** | 满分由表格决定是用户明确口径；强制 100 会逼着 AI 生成时反复凑数，或逼我们静默改数字 | 归一化到 100（权重数字与用户写的不一致）；拒绝非 100 的表（多一次烧钱的往返） |
| D4 | 每项**二元判定**：达成得全部权重，未达成 0 | 总分 = 权重之和，是确定性的算术；「部分分」会让「目标到底达没达成」变模糊 | 每项 1–5 分加权（取整漂移，例子全 5 分可能得 97）；每项 0–权重 打分（同样模糊） |
| D5 | 模型**不给总分**，只给逐项 `achieved` + 理由 | 「模型算错总分」这一类问题从根上消失（旧口径要专门防御「不采信模型自报的 totalScore」） | 让模型自报总分（多一个要防御的输入） |
| D6 | 评分表**快照进 `run.json`** | 与 `caseTitle` / `repoPath` / `repoBranch` 同一套冗余快照口径；改了表之后历史分数仍自洽，「重新评分」用的仍是当时那把尺子 | 只存用例上（改表后历史记录显示的就不是当时那张表；同一轮里两行可能来自两张不同的表） |
| D7 | 评分项 ID **允许为空**；空 ID 的项在**渲染提示词时**分配引用键 `#k`（全表顺序号，跨组连续） | 模型要指认「我评的是哪一项」。按**位置**引用是确定性的（`#4` 只可能对上全表第 4 项），不需要字符串匹配；而**不改动落盘的 rubric**——界面表格里不该出现用户没写过的 ID | 禁止空 ID（要多一条校验、手写时也要编 ID）；按 `goal` 文本匹配（用户改一个字就全断） |
| D8 | 「智能生成」**只增不改**，同名组归位，新主题建新组；**允许零新增** | 用户的表格是他自己分好的组，不能被 AI 拆散或重排；凑数式补充会让表越补越水 | 全部追加到表尾（「测试」可能出现两次）；让 AI 决定插入位置（结果不可预测，每次都要重新核对） |
| D9 | **服务端做合并**，两个接口都返回**完整表格** | 合并规则（同名组归位）与「新项 ID 不得与已有 ID 冲突」这两条校验必须与落库用的是同一份判据；放客户端等于同一套规则写两遍 | 返回「仅新增行」让客户端合并（界面上的表与存下去的表可能不是一张） |
| D10 | 「智能识别」**不碰仓库**：`repoPath` 在识别分支是可选 | 这段提示词里已经有全部信息，不需要仓库；「填了提示词却因为仓库路径没填而识别不了」是最容易被骂的组合 | 复用生成侧的「先校验仓库」三步顺序（为一个字符串去克隆远端 / 去读本地盘，是拿用户等待换我们省事） |
| D11 | **缺一项判定即整行失败**（先回问修复 2 轮） | 模型没判定那一项就不知道它过没过；当成「未达成」会让「模型漏答」与「确实没做」在分数上完全同形，而当「送分」更糟——**白送一整项权重，分数看起来完全正常** | 缺项算未达成（静默把漏答变成 0 分）；缺项不参与求和（等于送分） |
| D12 | 界面**只显示总分一个数**（不显示「36 / 100」），满分放在旁边一行文字里 | 用户口径；`totalScore` 这一格不变，列表页 / 卡片 / `metric-line` 三处引用**原样不动** | 显示「得分 / 满分」（每处调用点都要改，且列表页会被迫跟着改） |
| D13 | **不做兼容**，旧字段直接删 | 用户口径「代码必须最干净整洁」；两套口径长期共存，合并时会很痛 | 保留「无评分表 = 旧 5 维」分支（死代码长期挂着）；`.default()` 兜底（静默把旧数据当成空表） |
| D14 | 「智能生成」与「智能识别」**只用设置页的全局默认评分模型**（纯文本 API，`resolveJudgeRoute()`），**绝不用智能体**；入参里不出现任何模型 id | 用户口径（2026-09-28）。代码级保证已经存在且更强：`resolveJudgeRoute()` 是**无参**的（`judge-route.ts` 文件头：留一个参数就等于留一条绕过设置页的旁路），用例上的模型覆盖已被删除。故入参里再出现 `judgeProviderId` / `judgeModelId` 就是**新开一条旁路** | 让用例级覆盖参与生成（历史行为，已随覆盖字段一起删除）；为生成单独做一套模型选择 UI（多一处配置，用户无从预期） |

---

## 4. 契约变更（`packages/server/contracts`）

### 4.1 `rubric.ts`（新增）

```ts
export const RubricItemSchema = z.object({
  /** 短 ID（A1 / D5 这种）。允许为空：空 ID 的项在渲染提示词时按位置分配引用键 `#k`（D7） */
  id: z.string().default(''),
  /** 目标：这一项要达成什么。**自足的判据描述**（既说清改哪里，也说清怎样算达成，D1b）。空目标没有意义，故 min(1) */
  goal: z.string().min(1),
  /** 权重：达成即得这么多分。0 分的项没有意义、负权重是错的，故正整数 */
  weight: z.number().int().positive().max(MAX_ITEM_WEIGHT),
});
export type RubricItem = z.infer<typeof RubricItemSchema>;

/**
 * 单项权重上限。它防的不是「用户想给多少分」，而是三件事：
 *   ① `totalScore` / `maxScore` 的 safe-integer 边界（几十项 × 每项 1e9 就会越过）；
 *   ② 「满分」这个数在界面上还有没有意义（1e9 的满分没有）；
 *   ③ 手滑多打几个 0 时**当场被拒**，而不是静默产出一张荒谬的表。
 * 10000 对日常配置宽得离谱（300 分 / 1000 分的表离它还很远），只拦真错的那个量级。
 */
export const MAX_ITEM_WEIGHT = 10_000;

export const RubricGroupSchema = z.object({
  name: z.string().min(1),
  /** `.min(1)` 只在**提交用例**与**落盘读回**时要求（见 `validateRubric`）：表单上刚点「添加分组」的空组是合法的中间态，
   *  否则「先建组、再往里加项」这个最自然的操作顺序会被 schema 直接拒掉 */
  items: z.array(RubricItemSchema),
});
export type RubricGroup = z.infer<typeof RubricGroupSchema>;

export const RubricSchema = z.object({
  /** 空数组 = 表是空的（新建用例的初值、刚删完所有组）。
   *  **不设 `.min(1)`**：它会让「空表」根本无法表示——而空表是一个真实存在的界面状态，
   *  强行要求至少一组就等于把「新建用例」这个动作本身判为非法。非空要求由 `validateRubric` 在提交时给出 */
  groups: z.array(RubricGroupSchema),
});
export type Rubric = z.infer<typeof RubricSchema>;
```

### 4.2 派生量：满分、引用键、校验、总分

```ts
/** 满分 = 全部项权重之和。不是常量：100 / 120 / 300 都由表格决定（D3）。空表返回 0 */
export function rubricMaxScore(rubric: Rubric): number;

/** 项的引用键：有 id 用它，没 id 用 `#k`（k = 全表顺序号，从 1 开始、跨组连续） */
export function rubricItemKeys(rubric: Rubric): string[];

/**
 * 校验（**提交用例时**的唯一判据，界面与后端共用同一份）：
 * 至少一组、每组至少一项、组名非空、目标非空、权重正整数、**有值的 id 不重复**（空 id 可以重复）。
 * 前两条「至少」不写进 schema（那会让空表无法表示，见 §4.1），只在这里判。
 */
export function validateRubric(rubric: Rubric): { ok: true } | { ok: false; message: string };

/** 总分 = 达成项权重之和。判定里认不出的引用键与重复引用键都不参与（解析侧已保证齐全，D11） */
export function composeTotalScore(rubric: Rubric, judgments: readonly RubricJudgment[]): number;

/** 送进评分模型的评分表渲染（两条评分通路共用同一份，D1 的「单一真源」） */
export function renderRubricForJudge(rubric: Rubric): string;
```

`renderRubricForJudge` 的输出形态（组名 + 三列表格 + 表尾汇总）：

```
一、生产代码
| 引用键 | 目标 | 权重 |
| --- | --- | --- |
| A1 | `FileChangeLogItemDTO` 追加 `agent` 字段，让 `agent` 进入对外契约 | 18 |
...
以上共 11 项，满分 100 分。
```

引用键就是第一列：有 id 的项显示它的 id（`A1`），没有 id 的项显示 `#k`（全表顺序号）。**用户界面上的表格也是这三列**（`ID` / `目标` / `权重`，D1）——两处列数与列义必须一致，否则「用户看到的」与「模型看到的」就不是同一张表。

### 4.3 `score.ts`（重写）

删掉 `DimensionKeySchema` / `DimensionKey` / `DIMENSIONS` / `DIMENSION_COUNT` / `DimensionScoreSchema` / `DimensionScore` / `composeTotalScore(number[])` / `JUDGE_OUTPUT_CONTRACT`。

```ts
export const RubricJudgmentSchema = z.object({
  /** 评分表里那一项的引用键（有 id 用 id，没 id 用 `#k`），原样照抄 */
  id: z.string().min(1),
  /** 达成 = 拿到该项全部权重；未达成 = 0。二元判定，没有部分分（D4） */
  achieved: z.boolean(),
  reason: z.string(),
});
export type RubricJudgment = z.infer<typeof RubricJudgmentSchema>;

export const ScoreResultSchema = z.object({
  /** 逐项判定。**必须与快照评分表逐项对齐**：少一项即整行失败（D11） */
  judgments: z.array(RubricJudgmentSchema),
  /** 达成项权重之和 */
  totalScore: z.number().int().min(0),
  /** 满分快照 = 生成这一分时评分表的权重之和（改了表之后这一分仍自洽，D6） */
  maxScore: z.number().int().positive(),
  verdict: z.string(),
  raw: z.string(),
  judgeProviderId: z.string(),
  judgeModelId: z.string(),
  judgeAgentKind: AgentKindSchema.nullable().default(null),
  judgedAt: z.string(),
});
```

`judgedAt` / `judgeAgentKind` / `structuredOutput` 三条口径与当前实现逐字相同：

- `judgeAgentKind.nullable().default(null)`：null ⇔ 走纯文本 API（本设计的两条评分通路都不变）；
- **`structuredOutput: z.boolean().default(false)` 已由 `2026-09-28-structured-judge-output-design.md` 落地**（「这一分是不是在 schema 约束下拿到的」），本设计**一个字都不动它**。

`totalScore` 的上限从 `.max(100)` 放开：满分由评分表决定（120 / 300 分的表都合法），改成 `.min(0)`。

### 4.4 `JUDGE_OUTPUT_JSON_SCHEMA` 必须同批替换（承重）

当前 `contracts/src/score.ts` 里有**两份**契约投影，且文件头第 4 条明写「两者必须**同批修改**」：

| 投影 | 用途 | 谁在读 |
|---|---|---|
| `JUDGE_OUTPUT_CONTRACT`（文本） | 写进 system 提示词 | 文本通路 `judgeRow` 的 system；智能体通路的提示词尾部 |
| `JUDGE_OUTPUT_JSON_SCHEMA`（JSON Schema 字面量） | 给 claude-code 的 `outputFormat` / codex 的 `outputSchema` | 编排层按 `capability.structuredOutput` 决定传不传 |

**必须同批换成新形状**，否则就是 structured-judge-output spec §9 第 4 条登记的那类漂移：

```ts
/** 评分输出的 JSON Schema（与 JUDGE_OUTPUT_CONTRACT 同形；改一份必须同批改另一份） */
export const JUDGE_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['judgments', 'verdict'],
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'achieved', 'reason'],
        properties: {
          id: { type: 'string' },        // 引用键（评分表里的 id 或 #k）
          achieved: { type: 'boolean' }, // 二元判定
          reason: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string' },
  },
} as const);
```

三条与旧 schema 的**有意差异**（都必须写进注释，否则后人会「顺手补回来」）：

1. **`judgments` 不设 `minItems` / `maxItems`**：项数由每个用例的评分表决定，而 schema 是**编译期字面量**——它无法表达「恰好等于这张表的项数」。旧 schema 能写 `minItems: DIMENSION_COUNT` 是因为 5 维是常量；新体系下这个约束**只能由结构检查判**（D11：缺一项即失败）。schema 在这里只保证「是个数组、每项形状合法」；
2. **去掉 `totalScore`**：模型不再给总分（D5）。这一格是可有可无的——留着它，schema 与契约文本就不再同形；
3. **`achieved: { type: 'boolean' }` 不写成 `enum: [true, false]`**：后者在可移植子集上等价但更绕；布尔是两家 CLI 都稳的一格。

**已知风险（照实登记）**：`achieved` 用 `boolean` 时，模型若回 `"true"`（字符串）会被请求侧 schema 拒掉，而解析侧的宽容读本来能接住。这是 **schema 在请求侧阻止**与**解析侧兜底**的分工——与 structured-judge-output spec D7（`score: 6` 被 schema 拒、被解析器夹紧）**同一形状的登记项**，处置也一致：schema 严、解析侧宽，差异用一条用例钉住并写进 §9。若真机上 `boolean` 导致频繁重试，退路是把它放宽成 `{ type: ['boolean', 'string'] }`（可移植子集之内），但不预先放宽——「能在上游阻止就不该先让它生成」。

### 4.5 `case.ts`

```ts
export const TestCaseSchema = z.object({
  ...
  // judgePrompt 删除（D1：文本只是生成输入，不落盘）
  rubric: RubricSchema,          // 必填
  ...
});

/** 生成评分表入参（替换 GenerateJudgePromptInput）：两支共用 */
export const GenerateRubricSchema = z.object({
  /** 「智能生成」分支：**当前表格**。空表就是 `{ groups: [] }`（§4.1 不设 `.min(1)`，故不需要 nullable） */
  rubric: RubricSchema,
  /** 题面（生成分支用；识别分支可空，但填了会作为识别上下文） */
  taskPrompt: z.string().default(''),
  /** 识别分支：用户粘贴的评分要求。非空 ⇒ 走识别，**不碰仓库**（D10） */
  prompt: z.string().default(''),
  /** 生成分支：仓库来源。识别分支可空（D10） */
  repoPath: z.string().default(''),
});
```

**注意这里没有 `judgeProviderId` / `judgeModelId`**（D14）：用例上早已不持有评分模型
（`case.ts` 文件头第 11-14 行：那两列已被删除，`api/cases.ts` 读侧把历史残留归一丢掉），
故入参里也不该出现——**两个按钮一律走设置页的全局默认评分模型**。

### 4.6 `run.ts`

```ts
export const EvalRunSchema = z.object({
  ...
  /** 冗余快照：这一轮用的评分表（D6）。与 caseTitle / repoPath / repoBranch 同一条口径 */
  rubric: RubricSchema,
  ...
});
```

`EvalRow.score` 的类型随 `ScoreResultSchema` 自动变（`judgments` 取代 `dimensions`）。

---

## 5. 服务端：生成与识别（`packages/server/api/judge.ts` 重写）

### 5.1 两个分支

| 分支 | 触发 | 输入 | 输出 |
|---|---|---|---|
| **智能生成** | `prompt` 为空 | 题面 + 仓库名 + **当前表格** | 合并后的完整表格 + `addedItems` |
| **智能识别** | `prompt` 非空 | `prompt`（+ 可选题面）+ **不含仓库** | 识别出的完整表格（整表替换） |

两分支共同的三条顺序纪律（沿用现有 `generateJudgePrompt` 的骨架）：

1. **先解析评分模型路由**（`resolveJudgeRoute()`，**无参**：恒取设置页「评分配置」的全局默认评分模型；未配置时抛 CONFLICT、message 指向设置页）；
2. **生成分支**才做「仓库名解析」，且仍然刻意**不联网**：本地来源取 `resolveRepoInfo` 回显，远端来源只从 URL 末段取名字（D10 的姊妹条目，原注释里那两条理由一字不改）；
3. **最后才调用模型**——前两步失败时一次模型调用都不该花掉（限额是真的钱）。

### 5.1.1 绝不用智能体（D14，用户口径）

两个按钮都是**一次非流式文本调用**（`callTextApi`），**不建工作区、不起 CLI、不走 `AgentJudgeInput`**：

- 入口 `generateRubric` 的调用链里**没有** `requireJudgeAgent` / `getProvider(kind)` / `provider.run(...)`；
- 入参（§4.5）与 UI 上都没有模型选择：模型恒为设置页那一个；
- 反过来，**评分阶段**是否用智能体**不受本设计影响**：`useAgentJudge` 为 true 的轮次仍走
  `judgeRowByAgent`（D14 只管「生成 / 识别」这两个动作，不管「评分」）。

判据落在一处即可：`api/src/judge.ts` 的模块头注写明「本模块只有文本调用一条路」，
并用一条守卫钉住（§9 的测试策略里那条「生成不引入智能体依赖」）。

### 5.2 生成分支的提示词

- 系统提示词：资深代码评审专家，**只输出 JSON**，不要解释、不要代码围栏；
- 用户提示词分段（便于测试逐项断言）：
  - 仓库名、题面；
  - **当前评分表**（`renderRubricForJudge`）+ **已有项 ID 清单**；
  - 输出契约（只输出**新增**组与项）；
  - 任务说明，三条硬约束：
    1. **只新增**：已存在的项一条都不许重复、不许改写、不许删除；
    2. **禁止复用已有 ID**（在提示词里把已有 ID 列成清单）；
    3. **同名组要复用原名**（「测试」的补充项写进 `name: "测试"` 的组），新主题才用新组名；
    4. 表格已经完备时，`groups` 返回空数组——**不要为了凑数硬加**。

### 5.3 识别分支的提示词

- 用户提示词分段：用户粘贴的原文（原样放入，不做任何改写）+ 可选题面 + 输出契约；
- 任务说明的三条硬约束：
  1. **原样抽取**：用户写了几组就几组、几个项就几项，**数字一个都不许改**、不合并不拆分、不改写措辞；
  2. 忽略与项无关的内容（标题里的「满分 100 分」、组名里的「48 分」都不进权重——组不带权重，D2）；
  3. 用户没给 ID 时 `id` 留空串，**不要自己编号**。

### 5.4 合并算法（生成分支，纯函数、可单测）

```ts
/**
 * 按组名归位：`added`（模型产出的**新增**组）里的每个组，若 `current` 已有同名组则把它的项
 * **追加到该组末尾**；否则按 `added` 给的顺序**新建组并追加到表尾**。
 * `added.groups` 为空 ⇒ 原表原样返回、`addedItems: 0`。
 * 新增项的 id 若与 `current` 已有 id 冲突 ⇒ 抛 JUDGE_PARSE_FAILED（模型违约，不是我们的形状漂移）。
 */
export function mergeRubric(current: Rubric, added: Rubric): { rubric: Rubric; addedItems: number };
```

### 5.5 返回值

```ts
export interface GenerateRubricResult {
  rubric: Rubric;
  /** 界面文案用：已新增 N 项 / 未新增条目 */
  addedItems: number;
  /** 只在需要解释时出现（如「表格已覆盖本题，未新增条目」） */
  note?: string;
}
```

两个分支都返回**完整表格**（D9）。识别分支 `addedItems` 无意义，固定 0。

### 5.6 错误面

- 模型回复不合法 JSON / 顶层不是对象 / 缺少 `groups` → `JUDGE_PARSE_FAILED`，message 可直接展示；
- 解析出的表格过不了 `validateRubric` → 同上，message 点明是哪一条（哪一组空、哪一项权重非正、哪个 id 重复）；
- 生成分支新增项 ID 与已有 ID 冲突 → 同上（模型违约）；
- **失败绝不改调用方状态**：识别失败时弹窗里的文本原样保留（§7.3）。

### 5.7 HTTP 路由

- 路由路径沿用 `/api/cases/generate-judge-prompt`（两个按钮打同一个接口，由 `prompt` 是否为空分派）——**避免新增一条路由带来的 client 双份代码**；本阶段同时把它的中文名在注释里写成「生成评分标准项」；
- 请求体按 `GenerateRubricSchema` 校验；
- 响应 `{ rubric, addedItems, note? }`。

---

## 6. 服务端：两条评分通路

### 6.1 共同的尺子（`evaluator/judge.ts`）

**解析（`collectJudgeJudgments`，`validateJudgeResponse` 的新实现）**：

1. **围栏剥离**不变（只剥「整段以 ``` 开头」的；中间夹散文故意不救）；
2. 顶层必须是对象，`judgments` 必须是数组，否则不合格；
3. **按快照的引用键逐个找判定，缺一项即不合格**（D11）——报错文案点名「缺少对第 N 项（引用键 X，目标 Y）的判定」；
4. **多余的判定忽略**；**重复引用键取第一条**（与旧口径「以第一条为准」逐字对齐）；
5. `achieved` 宽容读：接受 `true` / `false`、`"true"` / `"false"`、`"是"` / `"否"`；认不出就不合格；
6. `reason` 缺失给占位文案（`（模型未给出理由）`），不让界面出现空白；
7. 越界概念消失（没有 1–5 分了）。

**收口（`finalizeScore`）**：`totalScore = composeTotalScore(快照, 判定)`；`maxScore = rubricMaxScore(快照)`；`ScoreResultSchema` 自检失败仍抛中文 `INTERNAL`（本包形状漂移，本该不可能）。入参新增 `rubric`（快照）。

**回问修复**（`JUDGE_REPAIR_ROUNDS = 2`）保留；`buildJudgeFeedback` 的字段清单从「5 个维度 key」换成「**评分表引用键 + 目标 + 权重**清单」+ 新输出契约。这条机制在新体系下更承重：漏一项 = 白送那一项的权重。

### 6.2 文本通路（`judgeRow`）

`buildJudgePrompt` 的段序不变（题面 → **评分表** → 待评改动），第三段由「本用例的评分提示词」换成「评分标准项（表格）」。system 用新的输出契约文本。

### 6.3 智能体通路（`judgeRowByAgent`）

`buildAgentJudgePrompt` 里「## 评分维度（各 1–5 分，等权）」一节换成 `renderRubricForJudge` 的输出；「## 本用例的评分提示词」一节**整段删除**（它已经不存在了）。其余五条口径（只读要求、失败面两类、`finalText === null` 与空答复的区分、`ok` 判定先于读答复）**一字不改**。

### 6.4 编排层（`orchestrator.ts`）

- `runJudgeStage` 的两处 `judgePrompt: ctx.testCase.judgePrompt, dimensions: DIMENSIONS` 换成 `rubric: run.rubric`（**读快照，不读用例**，D6）；
- `startRun` 在生成 `run.json` 时写入 `rubric: testCase.rubric`；
- 用例被删之后不能重评这条守卫**不动**（题面仍然没有快照进 run.json）；评分表改了不影响重评（快照里有）。

### 6.5 输出契约文本（`contracts`，替换 `JUDGE_OUTPUT_CONTRACT`）

```
输出要求（务必严格遵守）：
1. 只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，不要使用 markdown 代码围栏；
2. 字段结构固定为：
   {
     "judgments": [
       { "id": "<评分表里的引用键，原样照抄>", "achieved": true, "reason": "一句中文说明" }
     ],
     "verdict": "一句话中文总评"
   }
3. 评分表里的**每一项**都必须恰好给出一条判定：不许多、不许少、不许合并、不许改 id；
4. `achieved` 只允许 true / false 两个值：目标达成给 true，未达成给 false；
5. 你的回复里**不要**给总分——总分由系统按「达成项的权重之和」计算。
```

---

## 7. 界面变更（`packages/client`）

### 7.1 用例表单（`case-form-panel.tsx`）

「评分提示词」字段**整个删除**（含隐藏的 `judgePrompt` 字段与 `Input.TextArea`），原地换成一张卡片：

```
评分标准项                                    [智能生成] [智能识别]
┌──────────────────────────────────────────────────────────────┐
│ 一、生产代码                                          [删除组] │
│  ID │ 目标                                          │ 权重     │
│ ┌───┬────────────────────────────────────────────┬──────┐   │
│ │A1 │ （可编辑文本：既说清改哪里，也说清怎样算达成）│（数字）│   │ [删除项]
│ └───┴────────────────────────────────────────────┴──────┘   │
│ [+ 添加评分项]                                                │
├──────────────────────────────────────────────────────────────┤
│ … 更多组 …                                                    │
└──────────────────────────────────────────────────────────────┘
[+ 添加分组]                    满分 100 分 · 共 11 项 · 权重合计 100
```

- 卡片标题从「评分维度（只读预览）」改成「评分标准项」，`data-testid` 从 `case-dimensions` 改成 `case-rubric`；
- 两个按钮的可用性判据与现在同一个（`isJudgeConfigured`，未配置时禁用 + Tooltip 说明去向，Tooltip 仍挂在外层 `span` 上——禁用按钮不触发鼠标事件这条坑不变）。**表单上一格模型选择都不加**（D14）：判据只取设置页的全局默认评分模型，两个按钮都用它；
- 表单校验规则（与后端 `validateRubric` 同一份判据）：**表非空**（至少一组、每组至少一项）、组名非空、目标非空、权重正整数且 > 0、有值的 id 不重复；
- **表单里可以是空表**（新建用例的初值），但**提交时会被上面第一条拦下**——空表能存在、不能保存。这条区分很重要：新建用例的用户第一件事是点「智能生成」，不该先被一句「请填写评分提示词」拦住；但一张空表跑评测会得到 0 分总分，那必须拦在提交之前。

### 7.2 新组件 `rubric-table.tsx`（可编辑二级表格）

- 纯展示 + 受控回调（`value: Rubric` / `onChange: (next: Rubric) => void`），不 import client 包；
- 单元格用受控 `Input` / `InputNumber`；增删按钮各自带 `data-testid`（`rubric-add-group` / `rubric-add-item-{groupIndex}` / `rubric-remove-group-{groupIndex}` / `rubric-remove-item-{groupIndex}-{itemIndex}`）；
- 表尾实时汇总「满分 N 分 · 共 M 项 · 权重合计 N」——它同时是用户自查权重的手段（D3 不强制 100，用户得能看见自己配了多少分）。

### 7.3 新组件 `rubric-recognize-modal.tsx`（智能识别弹窗）

- **框内只有一个多行文本域** + 取消 / 识别两个按钮（用户口径）；
- 识别成功 → 回填表格 + 关闭弹窗；
- 识别失败 → **弹窗不关、文本原样保留**，弹窗内出现错误提示（反例是「先清空再请求」：一次抖动就清掉用户刚粘进来的长文）；
- 关闭弹窗不写回表单（`onCancel` 只关窗）。

### 7.4 用例详情（`case-detail-panel.tsx`）

- `Descriptions` 里的「评分维度」一行（`DIMENSIONS.map(...).join(' · ')`）**删除**——一条 Descriptions 行塞不下二级表格；
- 新增一张独立的「评分标准项」`Card`：只读表格（复用 `rubric-table` 的只读形态或抽一个 `RubricPreview`）+ 表尾「满分 N 分 · 共 M 项」。

### 7.5 评分详情（`score-detail-view.tsx`）

```
36
满分 100 · 11 项达成 8 项

一、生产代码
┌────┬────────────────────────────────────────────┬──────┬──────────────────────────┐
│ A1 │ …                                          │ 18   │ 已达成：…                 │
│ D2 │ …                                          │ 10   │ 未达成：…                 │
└────┴────────────────────────────────────────────┴──────┴──────────────────────────┘
…
总评 …
评分模型：… · 评分时间：…
模型原始返回（可折叠）
```

- 判定与评分表的对应**按引用键**取（`judgment.id` 匹配 `rubricItemKeys`）。渲染时**不做「找不到就跳过」的兜底**：找不到说明数据不一致，那种「看起来正常」的表格比报错危险得多；
- 未达成的项**用颜色区分**（不是隐藏）——它才是使用者要看的重点；
- 「模型原始返回」保留（排障唯一线索）；
- `ScoreBars` 组件整体删除（唯一的调用方在这里）。

### 7.6 不动的地方

`metric-line.tsx` / `run-detail-panel.tsx` / `eval-row-card.tsx` 三处只读 `score.totalScore`，而这一格没变（D12）——**一行都不用改**。

### 7.7 设置页（`judge-settings-card.tsx`）

「输出契约（只读）」那两行 5 维文案换成：

> 评分模型只输出一个 JSON：对评分表里**每一项**给出「达成 / 未达成 + 一句理由」，不给总分。
> 总分 = 达成项的权重之和；满分 = 全部项权重之和（由每个用例的评分标准项决定）。

### 7.8 client 数据层（`packages/client/client/src/cases.ts`）

`generate` 的返回类型从 `{ prompt, dimensions }` 换成 `{ rubric, addedItems, note? }`；`TestCase` 类型随 contracts 自动带上 `rubric`。请求键 `/api/cases/generate-judge-prompt` 不变。

---

## 8. 快照与重评

| 场景 | 行为 |
|---|---|
| 建轮（`startRun`） | `run.rubric = testCase.rubric` |
| 跑一行（`runJudgeStage`） | 读 `run.rubric`，**不读** `testCase.rubric` |
| 「重新评分」 | 同上；评分表改了也仍用当轮快照 |
| 改了用例的评分表 | 历史记录（含分数、详情页）**一个字节都不变** |
| 用例被删除 | 「重新评分」仍不可用（题面没有快照，与现状一致） |

---

## 9. 测试策略

**contracts**
- `rubricMaxScore` / `rubricItemKeys` / `validateRubric` / `composeTotalScore` 的边界：空表（`{ groups: [] }` 必须合法且 `rubricMaxScore` 返回 0）、空组（schema 合法、`validateRubric` 拒绝）、单组单项、跨组顺序号连续、空 ID 重复合法、有值 ID 重复不合法、权重 0 / 负数 / 小数 / **超过 `MAX_ITEM_WEIGHT`** 不合法；
- `renderRubricForJudge`：含组名、每条引用键、权重、表尾满分；
- `ScoreResultSchema`：`maxScore` 必须正数、`totalScore` 可以是 0，且**可以大于 100**（300 分表）；
- **两份契约投影的同形守卫**（§4.4）：`JUDGE_OUTPUT_JSON_SCHEMA` 的字段名与 `JUDGE_OUTPUT_CONTRACT` 文本**逐项对齐**（`judgments` / `id` / `achieved` / `reason` / `verdict`），且**两份里都不出现 `totalScore`**——这是 structured-judge-output spec §4.3 那条守卫的翻版，必须同批改；
- `JUDGE_OUTPUT_JSON_SCHEMA` **不含 `minItems` / `maxItems`**（项数由每张评分表决定，schema 表达不了）：断言这两格不存在，否则后人会「顺手补回来」；
- 修掉所有引用旧常量的测试（`agent-event.test.ts` 的 score 事件夹具、`run.test.ts`、`index.test.ts` 的导出清单、`structured-judge-output` 落下的 `score.test.ts` 那五条守卫——它们全部按 5 维形状写，必须同批重写）；
- `api/cases.ts` 的读侧守卫：`rubric` 缺失的旧用例**抛中文 INTERNAL**，而不是被补成空表（§10）。

**api（生成/识别）**
- 识别分支：喂用户示例那段提示词（mock 模型返回对应 JSON），断言**不调用仓库解析**、`repoPath` 为空也能成功、数字与组名逐字保留；
- 生成分支：喂「已有表格 + 模型返回补充组」，断言同名组合并、新组追加、`addedItems` 计数；模型返回空 groups 时原表不变 + `note`；
- 模型违约（新增项 ID 与已有冲突 / 权重 0 / 空组）→ `JUDGE_PARSE_FAILED` 且 message 点明哪一条；
- **两个按钮都只用默认评分模型**（D14）：断言 `callTextApi` 收到的路由等于 `resolveJudgeRoute()` 的返回值，且**模块依赖里没有 agents 包**（生成路径不 import `@aieval/agents` 的 provider 入口）；
- **只读守卫**：生成两个分支都不写任何落盘内容（沿用现有那条守卫的形状）。

**evaluator（两条通路共用的尺子）**
- 缺一项即失败，且报错点名是哪一项；
- 多余判定忽略、重复引用键取第一条；
- `achieved` 的 `"true"` / `"是"` 宽容读、认不出的值不合格；
- 总分 = 达成项权重之和（含「一项都没达成 = 0」「全达成 = 满分」两个端点）；
- `maxScore` 来自快照而非当前用例（改了用例的表，测量出的 `maxScore` 不变）；
- 两条通路（文本 / 智能体）对**同一份模型回复**给出**同一个 `ScoreResult`**（这是「同一把尺子」的守卫）。

**ui**
- 「评分标准项」表格：增删改、表尾汇总、校验拦截（权重 0、ID 重复）；
- 「智能识别」弹窗：失败时文本不清空、弹窗不关；
- 评分详情：逐项渲染、未达成有区分、总分与「满分」文案来自 `maxScore`。

**端到端冒烟**（写进 `docs/superpowers/notes/`）
1. 新建用例 → 「智能识别」粘贴用户示例提示词 → 表格回填出「一、生产代码 / 二、测试」两组共 11 项、权重 18/4/20/3/3/14/10/5/4/13/6，满分 100；
2. 「智能生成」补充 → 新增项落在同名组末尾；
3. 跑一轮 → 评分详情逐项达成/未达成，总分 = 达成项权重之和；
4. 改用例评分表 → 历史记录不变；「重新评分」仍按快照。

---

## 10. 兼容性说明（不做兼容）

旧数据形态与处置：

| 旧数据 | 处置 |
|---|---|
| `config.json` 里用例的 `judgePrompt` 文本 | **忽略**：`TestCaseSchema` 不再有这一格，多出来的字段被 zod 丢掉 |
| 用例没有 `rubric` | **这是本次升级唯一一条「读侧必须显式处置」的路径**：`loadConfig` 只做 JSON 解析 + 顶层字段归一（不逐条 `safeParse`），`asStoredCase` 也只补 `repoBranch` ⇒ 旧用例读回来 `rubric === undefined`，而 `TestCase.rubric` 在类型上是必填。**处置：`asStoredCase` 里显式判一次**——`rubric` 不是合法表（含 `undefined`）时抛中文 `ServiceError('INTERNAL')`，message 明写「这个用例是旧版数据，请删除它或重新创建：<caseId>」。**绝不给它 `.default({ groups: [] })`**：那会让旧用例在界面上看起来只是「还没配评分标准项」，而它实际带着一份已经无意义的 `judgePrompt`，用户会以为「重新生成一下就好了」——而他要做的是重建用例 |
| `run.json` 里带 `dimensions` 的评分记录 | `EvalRunSchema` 现在要求 `rubric`（必填）⇒ 旧快照 `safeParse` 失败 ⇒ `listRuns` 跳过。**这正是必须让用户清掉的原因**：跳过就意味着「评测记录凭空少了几轮」。跳过**不再无声**：`readSnapshot` 留 per-file WARN，`listRuns` 在同一趟扫描的最后再记一条**汇总 WARN**（条数 =「读得出 JSON、但过不了契约」的快照数，见下）；迁移提示（这条 WARN + README 的「升级到「评分标准项」口径之前的旧数据不做兼容」一节）已随终审修复轮落地 |
| 旧的事件日志 `events.jsonl` 里的 `score` 事件 | 同 `run.json`：`AgentEventSchema` 收紧后旧事件 `safeParse` 失败 ⇒ 读侧跳过并 WARN（现有形态即如此） |

> **实施计划必须解决的一处**：`run.json` 快照不合契约时 `listRuns` 会跳过（`readSnapshot` 用 `safeParse`，另记一句 per-file WARN）。旧记录数量少，但「静默消失」与「报错」之间必须选一个明确的行为——**落点已定**：不做兼容分支，只在扫描点上记一条**汇总 WARN**（「有运行快照因评分口径升级不再兼容，已从列表跳过（列表显示的轮次会比磁盘上的少）」+ 条数），这样它是可见的。
>
> **终审修复轮补记落点为什么在 `listRuns`（扫描）而不是启动钩子**：`recoverInterruptedRuns()`（启动钩子唯一的入口）拿到的已经是 `listRuns()` 过滤后的结果，被跳过的旧轮次在那一步根本不存在——它想数就只能再扫一遍盘。`listRuns` 的同一趟扫描是**唯一**同时看得见「读出来的」与「被跳过的」的地方；而启动钩子的第一步就是 `listRuns()`，所以启动时照样会打出这一条。计数**只含「读得出 JSON、但过不了契约」的快照**：JSON 都坏掉的文件另有带路径的 per-file WARN（处置是修文件），混进这个数会让「因评分口径升级不再兼容」这句话说假话。

---

## 11. 已决项（由本次评审确定，不留待决）

1. **表格三列**（`ID` / `目标` / `权重`）：用户示例里的「评分项」与「目标」合成一列，理由见 §3 D1b；
2. **接口路径沿用 `/api/cases/generate-judge-prompt`**：两个按钮打同一个接口，由 `prompt` 是否为空分派；改注释不改路径（省掉 client / 路由 / 测试的三处连带改动）；
3. **「智能生成」把当前表格回显进提示词**：AI 必须知道已有什么才能只增不改；11 项约 1KB，代价可接受（§5.2）；
4. **不允许空表用例**：提交时校验「至少一组、每组至少一项」（§7.1）。`CaseCreateSchema` 刻意**不**用 `.min(1)` 拦（§4.1）——但**契约放行不等于写得进去**：`createCase` / `updateCase` 都过 `assertStorable` 的 `validateRubric`，空表（以及有组无项、ID 重复的表）在用例的 HTTP 写入路径上被拒（`INVALID_QUERY` +「评分标准项不能为空：至少需要一组」，`cases-update.test.ts` 两种路径各钉一遍）。空表的 `rubricMaxScore` 是 **0**，`ScoreResultSchema.maxScore` 要求正数 ⇒ 若走到 `finalizeScore` 会抛 `INTERNAL`（一条本不该发生的形状漂移）。**三层职责，各自只做一件事**：

   | 层 | 落点 | 不合格时 |
   |---|---|---|
   | ① 体验层 | 用例表单提交前（`case-form-panel` 的 `handleFinish`） | `message.error(validateRubric 给的中文原因)`，**不发请求**（用户不必等一次往返才知道表格是空的） |
   | ② 真相层 | `api/cases.ts` **已有的** `assertStorable()`（`createCase` / `updateCase` 都过它） | 抛 `INVALID_QUERY`（400）+ 中文原因。**落一处而不是两个调用点**：两处各写一遍必然漂移，而漂移的症状是「创建时拦得住、编辑时拦不住」 |
   | ③ 兜底层 | `orchestrator.ts` 起一行评分之前 | 满分 ≤ 0 ⇒ 该行落**评分失败** + 中文原因（「这个用例的评分标准项是空的，无法评分」），**不许走到 `finalizeScore`** |

   ②是权威判据（界面与它同一份 `validateRubric`）。③**不在写入路径上，但不是死代码**：`config.json` 是手可编辑的（与 §10 的同一个前提），而 **`{ groups: [] }` 是一张合法的 `Rubric`**——契约刻意不设 `.min(1)`（空表是新建用例的真实初态），所以读侧的 `assertUsableRubric` 只拒**过不了 schema** 的形状，**不拒「合法但为空」的表**；这样一条用例 `getCase` 读得出来（详情 / 建评测都放行），`POST /api/runs` 把它的 `rubric` 原样快照进 `run.json`（`api/runs.ts` 的 `rubric: testCase.rubric`），于是这一轮开跑时 ③ 真的开火：它把这次形状漂移变成一句可展示的 `CONFLICT`（「这一轮用的评分标准项是空的，无法评分：这一轮的评分表在创建时就已快照…」，`orchestrator.ts` 的 `runJudgeStage`），而不是让下游 `finalizeScore` 抛那句「本不该发生」的 `INTERNAL`。**不要在 `createRun` 再加一道「空表不许建轮」的守卫**（已评估并否决）：空表是写用例过程中的合法初态，在那里拒要么挡住正当流程、要么把「空即不可用」这第二份判断塞进一个不拥有它的层——③ 才是它的落点。与 `permission.ts` / dsh 的 `outputSchema` 守卫同一形状。
   （**终审修复轮修正**：原句写「③在生产路径上不可达」，与同一节前文「API 直调仍能写入一张空表」互相矛盾，且两句都不准：空表**写不进**用例（②拦得住），而 ③ **确实会开火**——路径是手改的 `config.json` → `getCase` → 轮次快照。此处按代码与实测重写。）

---

## 12. 关键文件清单

**新增**：`packages/server/contracts/src/rubric.ts`（+ 测试）、`packages/client/ui/src/composite/rubric-table.tsx`（+ 测试）、`rubric-recognize-modal.tsx`（+ 测试）

**重写**：`packages/server/contracts/src/score.ts`（**含 `JUDGE_OUTPUT_JSON_SCHEMA`，与 `JUDGE_OUTPUT_CONTRACT` 同批**，§4.4）+ `score.test.ts`（structured-judge-output 落下的五条守卫全部按新形状重写）、`packages/server/api/src/judge.ts`（+ 测试）、`packages/server/evaluator/src/judge.ts`（+ 测试）、`packages/client/ui/src/composite/score-detail-view.tsx`（+ 测试）

**改动**：`contracts/src/case.ts` / `run.ts` / `index.ts`、`evaluator/src/judge-agent.ts` / `orchestrator.ts`、`api/src/cases.ts`（含读侧对旧用例的显式拒绝，§10）/ `runs.ts`、`client/client/src/cases.ts`、`client/ui/src/composite/case-form-panel.tsx` / `case-detail-panel.tsx` / `judge-settings-card.tsx`、`apps/web-next/app/cases/page.tsx` / `app/api/cases/generate-judge-prompt/route.ts`

**删除**：`packages/client/ui/src/base/score-bars.tsx`（+ 测试）、`DIMENSIONS` / `DIMENSION_COUNT` / `DimensionKey` / `DimensionScore` / `DimensionScoreSchema` / `MIN_SCORE_PER_DIMENSION` / `MAX_SCORE_PER_DIMENSION` / `composeTotalScore(number[])` / `JUDGE_OUTPUT_CONTRACT`（旧文本）、`TestCase.judgePrompt`、`GenerateJudgePromptInput` / `GenerateJudgePromptResult.prompt`

**不动**：`ScoreResult.structuredOutput`（structured-judge-output 已落地的那一格）、`agents` 包全部、`permission.ts`、`judge-route.ts`（`resolveJudgeRoute()` 的**无参**形状正是 D14 要的保证）、候选阶段全部
