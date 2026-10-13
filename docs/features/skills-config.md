# 技能配置

## 定位

设置页**第 4 个 Tab**（排在 MCP 之后）管**本机启用了哪几条 skill**。一条 skill = 一个目录 + 里面的 `SKILL.md`，住在 `<配置目录>/skills/`；候选执行时把本行要装的那几条**整目录复制**进**该行自己的配置目录**，行级观测格再回答「这一行的厂商到底认了没有」。这篇是这条链路的自含说明：配置面（目录文法与准入、启停、落盘形状）→ 装入面（四家同形的落点与时序）→ 失败判据（三态与两个归因来源）→ 已知边界。

口径一句话：**设置页只回答「本机装了哪几条」，行级观测格只回答「这一行厂商认了哪几条」**——两处说的是两件事，不互相推断。还有一条同样要说在前面：**落盘（L1）不是结论**——「文件在盘上」证明不了模型会用它，所以行级的 `installed` 一定要带厂商证据，`unverified` 不许写成「已装上」也不许写成「没有」。

## 页面形态与交互

Tab 顺序是 基础（模型供应商 / 界面主题 / 存储目录）/ 评分 / MCP / **技能**：前三者各自独立，「技能」紧跟在 MCP 之后——两者都是「往智能体里装外部东西」的配置，配一次就很少再进来。顺序即导航路径，守卫只钉**相对位置**（在 `mcp` 之后）。

- **卡片** = 工具条（技能目录的**绝对路径** + 计数 + 「重新扫描」）+ 三列表格（名称 / 描述 / 启用）。**没有来源路径列、没有操作列**：路径常显在工具条上、完整原文在抽屉里，读原文就是点那一行。计数只说两件事——「共 N 条」或「共 N 条，其中 M 条不可用」；逐条状态在行上，不在计数里重复。
- **名称列固左、启用列固右**，卡片窄于表格最小宽度（220 + 320 + 90 = 630）时才横向滚动，中间描述列从两侧固定列下面滑过。名称那一格住着**两样东西**（名字 + 「不可用」红标），列宽是按两者一起算的：窄了主标识会被截断成 `tang-…`，而描述列还空着大半。
- **不可用只用标签表达，不占一列**：一条 skill 上可能同时有两个维度的状态（准入可用性 + 本机启停），给它们各一列会互相打架。红标悬停给中文原因（缺 `SKILL.md` / 名称不合法 / 目录名与 frontmatter 不一致 / 缺 description / description 超长）。
- **不可用的条目照旧入列、开关照常可切**：「不可用」说的是**装不上**（厂商侧会拒或静默丢弃），不是「不能停用」。目录修好后不需要额外动作，「启用 = 缺省」这条规则本来就是按名字查名单。
- **启停即时落盘**（`PUT /api/settings` 的逐条合并），**不做乐观翻转**：写失败 ⇒ 开关保持原值 + 一条中文提示，落盘成功才重取清单。补丁**只带被点的那一条**——服务端是逐条合并，其余停用条目（含目录已删的残条目）不受影响。
- **预览抽屉**：`SKILL.md` 的 frontmatter **逐字**等宽展示（含两条 `---` 围栏，不做字段重排——界面上摆一份解析结果、文件里写着另一份就是第二真相）+ 正文按 markdown 渲染；**没有「看原文」切换**（原文就是那一格）；正文里的原始 HTML 被转义，不执行。
- **失败态与空态是四句话，不许互相顶替**：还没读到 → 骨架屏；读失败 → 带服务端中文原因的说明（**每一轮都要说**：SWR 在重新验证失败时保留上一份数据，「有数据」不等于「这次读到了」，否则用户会把一次读失败当成扫描成功）；技能根不存在 → 一条根级 warning「技能目录还不存在」；目录存在但为空 →「这个目录里还没有技能」。
- **页面层一条 Alert 说清与被测仓库自带的 skill 的关系**：这里只决定本机启用项；被测仓库自带的 skill 四家都会自动发现、不压制；同名时谁赢四家不同（Claude Code 以本机为准 / DeepSeek Harness 与 Pi Coding Agent 以仓库为准 / Codex 两条都会进清单）。**刻意不写「同名以设置页为准」**——那是 MCP 那一趟的结论，在 skills 上四家各不相同，给一个统一结论就是假话。

## 数据与契约

- **识别单位与准入**（`contracts/src/skill.ts`，扫描器与界面共用同一把尺）：一条 skill = `<技能根>/<名称>/SKILL.md`，**只扫第一层、不递归**（目录树里任何一层都可能是另一条 skill 的附属文件，递归会把 `references/` 当成技能列出来）。名字按最严规则 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` 且 ≤64，必须是**目录名与 frontmatter 的 `name` 逐字相同**；`description` 必填、非空（纯空白按没写）、≤1024。判据是「四家都装得上」——名字不合法时 claude 启动前抛错、dsh 把整条静默丢弃，description 缺了在 dsh 与 codex 的清单里都进不去。
- **技能根 = `<配置目录>/skills`**（`getSkillsRoot()`）：**不设 `settings.skillsRoot` 键**，改根就是改配置目录，一个杠杆；副作用是测试的 `setConfigDirForTesting()` 自动把技能根一起搬走。
- **出口形状 `SkillList`**（`GET /api/skills`）：`root`（绝对路径，工具条要显示它，且空列表时界面无从反推）+ `skills` + `skillWarnings`。两个数组**必填**：`[]` 永远表示「扫过且没有」，不是「未观测」。
  - 列表里的一条：`name`（**目录名**，走宽松字符串——目录名不合法正是要被展示出来的那类坏条目）/ `dir`（绝对路径）/ `description` / `ok` / `reason`（`ok:false` 必给）/ `disabled`（**恒给布尔**，服务端算好「缺省 = 开启」，界面不做这个推理）/ `sizeBytes`（**best-effort**：整目录字节数，不跟随符号链接，算不出就**缺席**——半个和是个错数字，`null ≠ 0` 同纪律）。
  - 根级异常**只有「目录不存在 / 读不到」这类没有条目可挂的事**：缺目录 ⇒ 空列表 + 一条 warning（不是错误，首次使用就是这一态）；读失败（权限 / 类型故障）⇒ 抛含路径的中文 `INTERNAL`，**不许冒充「还没有技能」**。
- **落盘 `settings.skills.entries`**：name-keyed map，值里**永远只有 `{ disabled: true }`**——「启用」不落盘，**启用 = 删键**。`strict()` 拒绝多余字段（`{disabled:true, enabled:false}` 自相矛盾的输入宁可 400 说出来）。详见[《数据与存储》](/features/storage)的《技能停用名单的落盘》。
- **写侧是另一个形状**（`SkillsPatchSchema`）：补丁收的是**期望状态** `{ disabled: boolean }`，与落盘那条刻意不同形——放宽落盘那条会让「配置里只出现停用」没人守，让补丁复用落盘那条会让「再打开」在 API 门口就被判 400。语义是**逐条合并**：只动补丁里出现的名字，补丁里没有的条目一字不动（目录已删的残条目因此**结构性**保住，而不是靠界面每次都记得回传）。
- **⚠️ 三处同名不同义**（`grep skills` 前先读这三行）：`SkillsSettingsSchema` = 设置页的**停用名单**；`VendorSkillSchema` = **厂商当时说它手里有哪几条**；`RowSkillInstallSchema` = **这一行实际装上了哪几条、我们凭什么这么说**。
- **行级观测格 `EvalRow.skillInstall`**（可选格，逐条四格）：`name` / `source`（**厂商原值照抄**，没给记 `unknown`，那是我们的如实交代）/ `judgedBy`（`vendor-skill-list` / `vendor-prompt-listing` / `local-materialized`）/ `verdict`（`installed` / `missing` / `unverified`，**没有 `skipped`**：落盘失败 = 该行失败，不存在「我们主动跳过一条」）。**配对规则**由契约的 `isValidSkillPairing` 单向蕴含：`installed` 必须带厂商证据、`missing` 只在 `vendor-skill-list` 下成立、`unverified` 配 `local-materialized`。
  - 三句中文由两张标签表拼出（`ROW_SKILL_VERDICT_LABELS` + `ROW_SKILL_BASIS_LABELS`）：`已装上 · 判据 厂商清单` / `缺失 · 判据 厂商清单` / `未验证 · 判据 仅落盘`。
  - `vendor-prompt-listing` 这一档**当前不产出**（本仓没有读「厂商入站请求」那一层），留在值域里是为了将来接上那条通道时不必再改契约。
- **厂商那一格 `vendor-system.skills`**（可选格）：逐条 `{ name, source, path, origin }`。`source` / `path` 是厂商原值照抄（claude 没有落点、codex 有），`origin` 由采集它的适配器按 `classifySkillOrigin` 归一成四档——**判据只有「厂商原值」与「落点」两样**，顺序是先落点、后原值（落在 `<行配置目录>/skills/.system/` 之下 ⇒ 厂商内置，必须排在「落在行配置目录之下」之前）；厂商给不出这一格就落 `unverified`「来源未证实」，**不许猜**。
  - ⚠️ **落点比较走真实路径**：厂商报的落点是**它自己看到的路径**，而我们手里的行配置目录 / 工作目录来自配置，两者常常只是**同一个目录的两种写法**（macOS 上 `/tmp` 与 `os.tmpdir()` 都给软链形态，真实路径是 `/private/tmp/…`）⇒ 两侧都要按真实路径（`realpath`，解析不到就回落原样）比过再判前缀，否则「落点优先」这一整档在软链形态下**静默失效**、只剩原值兜底（codex 的原值 `user` 给不出结论，那两条会显示成「来源未证实」）。合成路径与已经被删掉的落点同样要有判据，所以**原样形态与真实形态并列比**，不是二选一。

## 状态机与时序

一次候选执行的装入链路：

1. **编排层取一次快照**：`installableSkills(settings.skills?.entries)` 扫技能根 → 只留**准入合格**的条目 → 剔掉停用名单里的名字 → 顺序沿用扫描输出的**码位升序**（`compareSkillNames` 用 `<` / `>` 而不是 `localeCompare`：名字域是 `[a-z0-9-]`，码位序不随 locale / ICU 变，而界面**不再排**，顺序就是这里的输出）。清单为空 ⇒ **不给这一格**（`undefined` 不是 `[]`）：空数组会被物化成「建了目录、零条」。
2. **填进 `AgentRunInput.skills`**（`{ name, sourceDir }[]`）：**全仓只有候选执行那一个调用点**填它；评分与用例同步两处不传——「只有候选执行阶段装入」由类型 + 调用点共同保证（静态断言钉住填点恰好一处）。适配器**只认入参、不读 `loadConfig()`**。
3. **物化**（`materializeSkills`，本体在 `core`）：无条件 `mkdirSync` 行配置目录，然后逐条把源目录**整目录复制**到 `<configHome>/skills/<名称>/`。四条口径：① 整目录（`scripts/`、`references/` 一起走），**不设体积上限**（上限会造出「装了一半」的第三种状态）；② **清单内逐条覆盖、清单外一个名字都不碰**——`skills/` 这一层还住着厂商内置的 `.system/`，本模块**不删任何东西**，覆盖靠 `cpSync` 的同名覆盖，「清单外不碰」因此是结构性的；③ 源目录读不到 / 落不下去 ⇒ **抛 `SkillMaterializeError` 并点名哪一条**（那一行的环境是残缺的，照跑只会产出一个「看起来正常」的分数）；④ 名字过两道门——最严的名字规则 + 拼出的落点必须真的在 `skills/` 之下（路径穿越的纵深防御，两道各自独立成立）。
4. **四家落点同形、时序各不相同**：落点一律是 `<行配置目录>/skills/<名称>/SKILL.md`（与源侧同一个 `skillsDirOf`，两处各写一个字符串字面量迟早漂成两个落点）；claude 无时序要求（文件在 `query()` 之前落盘即可）、codex 必须在 `hooks.createClient`（spawn app-server）**之前**、dsh 必须在 `new DeepSeekHarness(...)`（boot 点）**之前**、pi 必须在 `createAgentSession()` **之前**——写晚了这一行照样「跑完」，但**没有任何 skill、也没有任何报错**，所以时序判据必须在**装配时刻**取快照，而不是等 `run()` 结束后看盘。
5. **采集**（L3，四家各一条通道）：claude `getContextUsage().skills.skillFrontmatter`（在流循环里 `system/init` 之后采一次并缓存，收尾同步交出）、codex `skills/list`（用 `startCodex` 的本地 `client` 发，不需要给会话开洞）、dsh `user/message` 且 `source.kind === 'skill-catalog'`（显式分流；认不出的 `user/message` 照旧落原始 JSON）、pi 出站请求 payload 的技能段（`before_provider_request` 观察者取证，按两条 wire 各读一次）。**采不到 = 不发那一格 + 一条点名的 WARN**，绝不写成 `[]` 或 `0`；判据**一个字都不读模型答复**（模型会说「我按技能做了」）。
6. **结论与行失败**：`installed`（清单里有它）/ `missing`（清单采到了、里面没有它 ⇒ **该行失败**，文案 `技能「<name>」未出现在 <家> 的技能清单里（厂商清单共 N 条，没有它）`）/ `unverified`（清单采不到 ⇒ 行照跑，如实记「未验证 · 仅落盘」）。

**停用 = 文件级「不放」**，四家统一——没有任何一家有「按名字关」的配置键（claude 的 `Options.skills` 是筛选不是注入、dsh 根本没有按名关的键），所以停用的那几条**根本不进清单**，也就不会出现在行配置目录里。

**两个来源共用一个归因码**：物化落盘失败与厂商没认（`missing`）都归 `AGENT_SKILLS_UNAVAILABLE`，**两者都刻意不进 `TRANSIENT_ROW_RETRY_CODES`**——它们是本次配置的直接后果，不是瞬时故障；重试只会把同一个失败延后，真正要重跑的那一步是「回设置页把源目录修好」。落盘失败那一档由适配器归因，`missing` 那一档由编排层判定。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| **同名冲突四家解法不同** | dsh 项目级（rank 100/200）**压过**我们的 rank 400；pi 的项目自动发现同样压过我们的 `configHome`、个人档被我们过滤掉；claude 是**本机赢**（`user` > `project`）；codex **同名不去重**（两条都进清单）⇒ 设置页那条 Alert 承认分歧，不给统一结论 |
| **设置页结构上无法点名同名冲突** | 「仓库自带的 skill」只存在于**行工作区**（`<行>/workspace`）⇒ 设置页只写原则，点名归**行详情**的「本行技能」格 |
| **厂商内置（bundled / system）不压** | 跨家可比性买不到（claude 仍有 20 项工具、dsh 仍有 24 项），压掉还要分别动四家开关、将来厂商新增内置时行为与默认分叉 ⇒ 如实呈现，代价登记为「厂商能力面本就不同」 |
| **不设 skill 目录体积上限** | 上限会造出「装了一半」的第三种状态；缓解手段是界面上显示 `sizeBytes` |
| **落盘失败 = 该行失败** | 不采用 MCP 的「单条跳过 + WARN」收窄（那条针对外部环境，这里是本次配置的直接后果） |
| **`sizeBytes` 是 best-effort** | 算不出就缺席（`null ≠ 0` 同纪律）；不跟随符号链接，也不把技能目录之外的文件算进来 |
| **一个 patch 里两种合并语义** | `skills` 逐条合并 / `mcpServers` 整份替换 ⇒ 靠纯函数 + 注释 + 守卫钉住，别照抄邻居 |
| **停用名单是「缺省 = 开启」** | 判据是 `entries[name]?.disabled === true` 而不是「键在不在」：`loadConfig` 不做 schema 校验，把「键在」（值可能是手改坏的别的东西）当成「关着」会**静默关掉**用户的技能 |
| **`missing` 的语义边界** | 它说的是「厂商清单里没有它」，不是「模型不会用」；codex 的 `enabled:false` 条目被丢弃（不在可用技能面里的条目算成「厂商认了」就是假绿），这一档实际不可达 |
| **行为门槛只用于冒烟，不是行内自动判据** | 行内 L3「尽力而为」、采不到记 `unverified`、不阻塞行；**冒烟**那一次才要求「模型真按 skill 走了一次」（codex 认它真读了 `SKILL.md`、dsh 认真发了 `skill` 工具调用） |
| **落点分档的守卫必须在真文件系统上造不对称** | 合成路径（`/runs/…` 这类字面量）只走「原样形态」那一支，对**同一个目录的两种写法**没有区分力；判它要 `mkdtempSync` + `symlinkSync` 造出软链 ↔ 真实这一对，再让两侧交叉给 |
| **claude 在本机网关下拿不到行为证据** | 技能面确证在（`getContextUsage().skills.skillFrontmatter` 里出现、来源 `userSettings`），但**模型收不到那份清单**：CC 把整份 `<system-reminder>` 放在 `messages[]` 里一条 `role: "system"` 的消息上，而网关转换器（`proxyGateway` 的 `anthropicToOpenAI`）对非直连目标把它整条 `continue` 掉（判据：同一请求体只改这一格，`role` 为 `user` 时两个模型都发出 `Skill` 调用；原样时上游 usage 与「整条删掉」逐字相同）⇒ 行级结论只到「厂商确证技能面里有它」。**网关侧已改为就地降级为 user 并留诊断，待部署**，见 [Claude Code FAQ](/faq/claude-code) |
| **扁平形态不被准入** | 只认 `<根>/<名称>/SKILL.md`；用户丢一个扁平 `<根>/<名称>.md` 会得到「缺 SKILL.md」，而 dsh 本来能吃扁平形态——是否在扫描侧也认它或至少在原因里点明「扁平 `.md` 请改成目录」**未裁决** |
| **frontmatter 的权限字段未接** | claude 的 `allowed-tools` 与三档权限的交互、dsh 的 `disable-model-invocation` / `user-invocable` 与「单条停用」的关系（已证：两个都写才全关，只写前者仍可被 `/<name>` 注入）都未使用 |
| **并发装入未测** | 多行同时从同一源目录装入有没有竞态**未证实**；缓解是物化只读源目录、只写本行配置目录 |
| **codex 侧的未证实项** | core 加载器的 frontmatter 精确允许集、同名 skill 的模型侧选择、spawn 后落盘能否被同 turn 看到、`SKILL.json` 用法、按 `name` 禁用会被 `path` 条目压制（推测）、`skills/extraRoots/set` 未测、`skills/changed` 通知未捕获 |
| **dsh 侧的未证实项** | rank 200 与 watch 热更新未跑；`DSH_AGENTS_HOME` / `DSH_BUNDLED_SKILL_DIR` / `DSH_PRIMARY_RUNTIME` 的宿主泄漏只在本机（三个都未设置）核过 |

## 相关链接

- 知识文章：[《设置》](/features/settings)（四个 Tab 的全貌、「技能」的邻居）、[《MCP 配置》](/features/mcp-config)（同为「往智能体里装东西」的配置面，两处的合并语义刻意不同）、[《数据与存储》](/features/storage)（`config.json` 的落盘与原子写口径）、[《评测详情与候选行》](/features/run-detail)（环境抽屉里「已下发的技能」与「本行技能」两格）、[《行执行与日志》](/features/row-execution)、[《事件流》](/protocols/event-stream)（`vendor-system` 的投送语义）、[《Provider 抽象与 run 入口》](/protocols/provider-run)（`run` 入参与 `skillInstall` 观测格）
- 协议侧：[Claude Code 接入](/protocols/cc)、[Codex 接入](/protocols/codex)、[DeepSeek Harness 接入](/protocols/dsh)、[Pi Coding Agent 接入](/protocols/pi) 各自的「skills 接法」，[四家横向对比](/protocols/comparison)的 skill 对照表
- 规约与排障：[变异验证](/guard/mutation-verification)、[冒烟测试方法论](/guard/smoke-testing)、[故障索引](/faq/)（claude 行为证据缺失那条按现象可搜）
- 仓库内参考：`packages/server/contracts/src/skill.ts`（准入规则、落盘 / 补丁两种形状、来源分档）、`packages/server/core/src/skill-store.ts`（扫描与停用名单的唯一读法）、`packages/server/core/src/skill-materialize.ts`（整目录复制与路径穿越的两道门）、`packages/server/evaluator/src/row-skill.ts`（三态结论与 `missing` 文案）
