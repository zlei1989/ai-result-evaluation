# MCP 配置

## 定位

设置页**紧跟「模型供应商」之后**那个 Tab 管**配了哪些 MCP 服务器**，候选执行时把**启用的那几台**翻译成各家的形状注入到那一行自己的配置目录里，行级观测格再回答**这一行到底装上没有**。这篇是这条链路的自含说明：配置面（怎么配、怎么贴、怎么探活）→ 注入面（三家落点与逐字形状）→ 失败判据（谁在什么通道上报）→ 已知边界。

口径一句话：**设置页只回答「我配了什么」，行级观测格只回答「这一行装上了什么」**——两处说的是两件事，不互相推断。MCP 服务器是**候选能往评测里塞工具**的一个口子（与本仓注入同名时注入赢），这一点如实写明，不藏。

## 页面形态与交互

Tab 顺序是 界面主题 / 模型供应商 / **MCP** / 评分配置 / 工作区：MCP 与供应商都是「接入外部能力」，挨着放；评分配置与工作区回答的是「怎么评、评在哪」，排在后面。

- **卡片**：与供应商那张同构——五列表格（名称 / 传输 / 端点或命令 / 状态 / 操作）＋ 卡片头部两个入口（`添加`、`粘贴 JSON`）＋ 卡片内一条常显的静态说明（说清与仓库自带条目的关系）。条目落 `settings.mcpServers`（name-keyed map，值是 stdio / http 的**判别联合**）。增删改走弹窗的「确定」、**整份替换**，只有启停开关即时落盘。停用条目**不隐藏**，弱化信号**只落在名称那一格**（次级色）——「端点或命令」保持可读，那是排障时要读的字。空态摆同一组入口（`添加第一台` + `粘贴 JSON`）。
- **名称列的宽度**按「名称 + 已配置密钥小标」两样东西算：那一格里住着两者，窄了主标识会被截断。表格最小宽度是各列申报宽度之和，卡片窄于它才横向滚动，此时名称列钉左、操作列钉右，中间三列从它们下面滑过。
- **表单弹窗**：传输（stdio / http）、名字（`[A-Za-z0-9_-]{1,32}`，即时查重但**允许覆盖**）、stdio 的 `command` / `args` / `env`、http 的 `url` / `headers`、启用开关；`args` 一行一个参数；密钥类值支持 `${环境变量名}` 占位（**只在 `env` / `headers` 的值里**，`command` / `url` / `args` 不支持）。
  - **`env` / `headers` 是一行一条的 small Table**（与模型供应商弹窗里那张模型清单同档）：`size="small"`、表头隐藏（两格的含义由输入框的 `aria-label` 与占位符承担）、操作列右对齐只放一个删除图标按钮、列宽显式给（键 42%、值吃剩余、操作 44px）。行身份用 `Form.List` 的 key 而不是下标，删中间一行时值不会串行错位。
  - 尾部三块（占位说明 → 测试入口 → 「值留空 = 不修改」的提示）自成一条 12px 节奏：它们不是字段，拿不到 `Form.Item` 的字段间距，当兄弟节点摆会互相贴死。
- **贴入导入**（固定五步判别，不递归不猜）：顶层 `mcpServers` 对象 / VS Code 的 `servers` 信封（`inputs` 外壳丢掉并点名）/ 顶层自身就是一台（名字按内容猜且可改）/ 数组 ⇒ 不认 / 其余 ⇒ 不认并列出**实际看到的顶层键**。JSONC 容错（注释与尾逗号）由手写剥离器做，**字符串里的 `//` 不动**（`"url": "http://…"` 是头号误伤目标）。预览表逐行可切「覆盖 / 跳过」，确认计数与预览同源——预览与落盘用**同一份**判定，否则「预览说覆盖、实际新增」只能靠肉眼发现。
- **「测试连接」（探活）**：两个入口——表格操作列的行内按钮（测**已保存**的那份）与表单弹窗底部的按钮（测**当前表单值、不落盘**）。点下去按钮 loading、该行其它动作禁用、结果**就地在该行下方展开**，超过 1 秒的等待显示「已等待 N s」。停用条目**仍可测**，结论里写明「已停用，不会注入」。请求失败与探活失败是两种东西：前者（条目已被删 / 网络断 / 5xx）折成「测试请求失败：<中文原因>」，后者是「探活结论」。
- **改名的两个后果**（界面**不给提示**，如实写在这里）：① 注入的工具名整批变（前缀是 `mcp__<名字>__`），提示词 / 权限规则里引用旧名的会失效；② 被测仓库自带的同名条目**重新生效**——「注入顶掉仓库自带」是按名字判的，改名等于把我们那一台挪开。

## 数据与契约

- **落盘**：`settings.mcpServers`（`config.json` 的 `settings` 段，详见[《数据与存储》](/features/storage)）。形状是 name-keyed map：
  - stdio：`{ transport: 'stdio', command, args?, env?, enabled? }`；
  - http：`{ transport: 'http', url, headers?, enabled? }`。
  - `enabled` **缺省 true**；跨传输的多余字段（stdio 里写 `url`）在贴入时按「不认识」丢掉并点名，**不拒绝整条**；两边都有却没声明传输 ⇒ 不导入并点名（宁可不动，也不猜错方向）。
- **播种（预置两台）**：`context7`（http，`headers.CONTEXT7_API_KEY` 是 `${CONTEXT7_API_KEY}` 占位）与 `playwright`（stdio，`npx -y @playwright/mcp@latest --browser=chrome --isolated`）。判据是**文件里没有这个键**，不是「值为空」——所以**删光（`{}`）不复播**：键在文件里就是「配过了」的唯一证据。这条判据在 `core/src/config-store.ts` 的 `normalizeSettings` 里单独写成一句显式判断，让它有唯一落点、可被守卫钉住。
- **出口掩码**：`GET /api/settings` 里 `env` / `headers` 的**敏感键**（键名匹配 `/(key|token|secret|password|auth)/i`）走 `maskApiKey`（保前 3 后 4、长度 < 8 全掩码）；非敏感键（`NODE_ENV` 这类排障信息）原样可见。占位（`${CONTEXT7_API_KEY}`）也会被掩码——它同样是「这一格有内容」的信号。
- **「未改动」信号**：PUT 里敏感键的值是空串、或与本服务端掩码串逐字相同 ⇒ 视为未改动，保留落盘原值。这条要**端到端**成立：编辑弹窗里每一格的值都是空的（当前值只在 placeholder 上），所以留空的那一行**必须真的进 PUT**——原有条目里已经有的键交空串（服务端据此换回落盘原值），只有**新键**留空才丢掉。把空值行一律丢掉等于在补丁里删掉那个键：打开编辑弹窗、一个字不改直接保存就会抹掉原密钥（症状要到下次运行以 401 现身）。
- **手改配置文件能被读到**：`loadConfig` 故意不做 schema 校验，手写坏的值由**唯一那个消费方**（注入时的 `resolveMcpServers`）判。条目形状不对（缺 `transport` / 缺 `url` / 缺 `command` / 跨传输 / 名字不合法）时该条**不进注入集、也不进 `skipped`**，而是进 **`invalid`** 桶并落一条 WARN（点名到台与缺的那一格），行级观测格记 **`unverified`**——**不是行失败**，行照跑；整页也不会因此打不开。
- **路由**：`PUT /api/settings`（整份原子落盘）、`POST /api/settings/mcp/test`（探活，body 二选一 `{ name }` 或 `{ entry }`，**失败也回 HTTP 200**——折成 4xx/5xx 会让客户端只剩一句 message，而失败文案是两段式的）。
- **行级观测格**（`EvalRow.mcpServers`，可选格）：逐台四格 `{ name, source, judgedBy, verdict }`。
  - `source` **优先采信厂商原值**（`dynamic` = 本仓程序化注入、`project` = 被测仓库自带），厂商没给这一格时记 `unknown`——那是**我们**的如实交代，不是厂商的取值；
  - `judgedBy` 四档：`vendor-status` / `vendor-tool-table` / `vendor-startup-status` / `none`；
  - `verdict` 四档：`connected`（已连上）/ `unavailable`（未启动）/ `unverified`（未验证，**也承载「条目形状不对、压根没投送」**）/ `skipped`（已跳过，承载「`${ENV}` 未设置」与「`command` / `url` / `args` 里写了占位」两种不投送）。
  - **`null`（没投送）与 `[]`（投送了确实是空的）是两句不同的话**；旧 `run.json` 缺席这一格 = 未观测。同一份事实同时进**行事件**（`vendor-system` 的 `mcpServers` 对象数组）、**行详情 / 环境抽屉**的「本行 MCP」格与设置页卡片。
- **不压制仓库自带的 MCP**：`strictMcpConfig` **保持关闭**。同名时程序化注入赢且只留一条（替换，不并存不改名）；另两家的同名口径见「已知边界」。
- **启停或编辑会把该条挪到末尾**：落盘是 map 的插入顺序（界面顺序 = 落盘顺序），而 upsert 的语义是先删后加——位置不保证稳定。

## 状态机与时序

一次候选执行的注入链路：

1. **编排层取快照**：在候选执行那一处从 `loadConfig()` 取一份 `settings.mcpServers` 快照，填进 `AgentRunInput.mcpServers`（与 provider / route 同一份快照）。评分与用例同步两处**留空**——「只候选执行阶段注入」由**类型 + 调用点**共同保证。适配器**只认入参、不读 `loadConfig()`**。
2. **解析**（`resolveMcpServers`，纯函数，三个桶）：① **形状闸**——条目没过 `McpServerConfigSchema` ⇒ 进 `invalid` 桶，不注入、不解析；② `enabled === false` ⇒ **整条剔除**（它不是「跳过」而是「用户关了」，不进 `skipped`——混在一起用户会以为是自己漏配了环境变量）；③ **占位闸**——`command` / `url` / `args` 里出现 `${…}` ⇒ 整条进 `skipped`（这几格不支持占位）；④ `env` / `headers` 的值里 `${ENV}` 取环境里的真值，**任何一格解析不出来 ⇒ 整条跳过**并记 `skipped`（半条注入只会让厂商侧报一句离真因很远的认证失败）。解析**只发生在注入时**，密钥因此永不落盘。
3. **翻译**（`agents/src/mcp.ts`，一处实现）：同一份 canonical → 三家形状（见下节）；翻译器对拿不到必需格的条目**跳过而不抛**（上游的形状闸已拦一道，这里是第二道）。
4. **落点**：claude 走 SDK 参数 `Options.mcpServers`（**不落** `<configHome>/.claude.json`——参数是编程入口，且不落盘就不会与宿主那份混起来）；codex 走线程级 `config.mcp_servers`（随 `thread/start` 经 app-server 协议传入）；dsh 往 per-launch overlay（`<configHome>/aieval-route.patch.yml`）的 `insert` 加插件行。
5. **行内 `.npmrc`**：把宿主 npm 配置里的 **registry 那一行**写进行 `configHome`（`0600`）。原因：行的 `HOME` 一换，npm 的 `userconfig` 就从 `~/.npmrc` 变成 `<行HOME>/.npmrc`（不存在）⇒ registry 从内网镜像掉回公网，行内首次注入 playwright MCP 从 ~4 s 变成 **17.2 s / 61 MB**（等待预算 ≥20 s 就是被这件事撑起来的）。宿主没有 registry 配置 ⇒ **什么都不做**（凭空写一个公网 registry 比不写更糟）；**只写那一行**，宿主 `.npmrc` 里其余内容（含认证 token）一个字节都不进行内。

**三家的逐字形状**（同一份 canonical：`playwright` stdio 带 `args`、`context7` http 带 `headers`）：

| 厂商 | 通道 | 输出 |
|---|---|---|
| claude | `Options.mcpServers` | `{"playwright":{"type":"stdio","command":"npx","args":[…]}, "context7":{"type":"http","url":"…","headers":{…}}}`——**无 `cwd`**，可选格缺席就不写那个键 |
| codex | 线程级 `config.mcp_servers` | `{"playwright":{"command":"npx","args":[…],"startup_timeout_sec":30}, "context7":{"url":"…","http_headers":{…},"startup_timeout_sec":30}}`——snake_case、**无 `type`**（传输靠字段推断，多一个 `type` 会让整份 config 解析失败）、http 的头叫 `http_headers` |
| dsh | overlay 的 `insert` 插件行 | `- id: mcp-playwright` / `name: "@deepseek-ai/dsh-mcp-client"` / `config: { serverName, transport, command, args }`；http 那台 `transport: streamable-http`（**不是** canonical 的 `http`）、头仍叫 `headers` |

行内 `<configHome>/.npmrc` 的内容**逐字只有** registry 那一行（宿主为 `registry=http://registry.m.jd.com/` 时就是它加一个换行）、权限位 `0600`。

## 失败判据

判据**只看事件侧 / server 侧，不看模型答复**——模型会把预期结果编出来。

| 厂商 | 判据来源 | 结论 |
|---|---|---|
| claude | `system/init` 的 `mcp_servers[].status` + **工具表里的 `mcp__<name>__`** | `failed` ⇒ **行失败**；工具表里有该前缀工具 ⇒ **已连上**（比 status 更硬）；其余（`pending` / `needs-auth` / 没有这台）⇒ `unverified`，**不判失败**。不等待（init 是一次性事件） |
| codex | `mcpServer/startupStatus/updated` | `failed` ⇒ **行失败** + `error` 原文点名到台；`ready` ⇒ 已就绪（**只到「装上了」这一档**，工具能不能调是另一回事，见「已知边界」） |
| dsh | `request/header` 事件的 `data.header.tools` | 表里有 `mcp__<serverName>__*` ⇒ 已就绪；表在、里面没有它 ⇒ **行失败**——这一家起不来时工具**静默**消失、会话照常跑完、无结构化错误，这是唯一判据 |

厂商事实**逐拍长**时（codex 的启动状态、dsh 的工具表每条都交全量）统一**取最后一条**：行级观测格与环境抽屉因此对同一行给同一个结论。

失败的行归因码是 **`AGENT_MCP_UNAVAILABLE`**（文案 `MCP「<name>」未能启动：<厂商原文首行>`，厂商原文照抄以便按报错原文 grep），并且**刻意不进 `TRANSIENT_ROW_RETRY_CODES`**：配置 / 环境类失败重试没有意义，重试一次 = 再下 61 MB、再起一遍 MCP 进程。

## 探活档位与文案

- **档位**：默认 **A（纯握手）**；**http 侧再叠一次只读 `tools/call`**（`http+call`）——这是 http 侧**唯一**能验 key 的手段。**stdio 侧保持 A**：playwright MCP 没有「只读且不启浏览器」的探测工具（连 `browser_close` 都会逼出浏览器初始化）。
- **成功文案**：`连通：<server> <version>，声明 N 个工具（耗时 X s）`；**永不写「配置可用 / 配置正常」**。`command` 含 `npx` / `npm` 的条目附一行「候选执行时首次启动还要在本行环境里下载依赖」。匿名探测（`${ENV}` 未设置）时如实加一句「本次没有携带密钥，连通不代表密钥可用、也不代表有配额」。
- **失败文案两段式**：中文结论分档 + 厂商原文照抄（可折叠）。
- **超时与并发**：http 15 s / stdio 30 s（`MCP_PROBE_TIMEOUT_MS`），两者都**罩住收尾**（http 一个 AbortController 罩住整段等待；stdio 从总预算里预扣收尾预算，先关 stdin → SIGTERM → SIGKILL）。**同一时刻只允许一个探活**（服务端串行；前端按行 loading，别的行照常可用）。探活**不写盘**，也不阻塞保存。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| **codex 的 MCP 工具目前调不动**（上游按命名空间暴露 MCP 工具，而自定义 Responses 网关转发时把它拍平 ⇒ `unsupported call`） | 不硬解；写进界面与文档；判据只验 `ready`。三条出路（网关侧扁平化 / 追上游 / 退版本）留给运维层，现象原文见 [Codex FAQ](/faq/codex) |
| **弱判据不装强结论** | 不做注入前的**连通性**预检（那是探活）；拿不到判据就 `unverified`，**绝不写成「已连上」**，也不写成「没有」。**形状**校验照做（`invalid` 桶）：它判的不是「连不连得上」，而是「这一条合不合契约」——不校验的下场是把 `url: undefined` 送给厂商 |
| **行内首次注入 playwright = 17.2 s / 61 MB**（公网 registry） | registry 注入缓解到 ~4 s 级；等待预算按 ≥20 s 留（codex 那侧的 `startup_timeout_sec` 给 30 s） |
| **并行即多个浏览器实例**：N 行并行 = N 个浏览器 + 各自首次 61 MB 下载（6 行 ≈ 366 MB） | **如实接受**，不为此改编排的并行模型；代价由 registry 注入压低 |
| 每行可能留下一个浏览器进程 | 不清理（回收不可及 + 收益被 `--isolated` 消掉）；见[《进程生命周期》](/protocols/process-lifecycle)的「行结束后仍能 `pgrep` 到上一轮的浏览器」条（《故障索引》已登记） |
| `--isolated` 没有持久登录态 | 接受（评测场景下是优点） |
| 不压制仓库自带 MCP（同名时注入赢） | 如实呈现来源；**候选能往评测里塞工具**这件事记在这里，不假装没有 |
| 改名无提示 | 两条后果写在「页面形态与交互」末段 |
| **探活绿 ≠ 配置能用**：三类查不出来 | ① stdio 的浏览器通道非法（playwright MCP 没有只读且不启浏览器的探测工具）；② 少写 `mcp.` 子域（`https://context7.com/mcp`）也是合法端点；③ 探活的环境 ≠ 候选执行的环境（宿主 `HOME` / npx 缓存 / 占位从宿主环境解析，行内是私有目录且缓存为空） |
| 密钥落盘明文 | 与供应商同口径（`0600` + 出口掩码 + 未改动信号），不额外加密 |
| dsh `failOnStartupError: true` 的确切语义 | **未证实** ⇒ 判据改用工具表，不依赖它 |
| codex / dsh 的同名优先级、宿主 `~/.claude.json` 与注入同名时谁赢 | **未证实**（前两家无已知的项目级 MCP 自动发现；后者未单测）⇒ 文档里只写「推断，未实测」 |
| `streamable-http` 传输在 dsh 侧 | **未覆盖**（只验过 stdio），形状由翻译器守卫逐字钉住 |

## 相关链接

- 知识文章：[《设置》](/features/settings)（供应商 / 评分配置 / 工作区与用例目录，MCP 卡片的邻居）、[《数据与存储》](/features/storage)（`config.json` 落盘、原子写与 BOM 口径）、[《行执行与日志》](/features/row-execution)（行级观测格的消费侧）、[《事件流》](/protocols/event-stream)（`vendor-system` 的投送语义）
- 协议侧：[Claude Code 接入](/protocols/claude-code)、[Codex 接入](/protocols/codex)、[DeepSeek Harness 接入](/protocols/dsh) 各自的「MCP 接法」一节，[三家横向对比](/protocols/comparison)的 MCP 对照表
- 规约与排障：[变异验证](/guard/mutation-verification)、[冒烟测试方法论](/guard/smoke-testing)、[密钥与环境变量](/guard/secrets-and-env)、[故障索引](/faq/)
- 仓库内参考：`packages/server/contracts/src/mcp.ts`（canonical 形状与解析）、`packages/server/agents/src/mcp.ts`（三家翻译与行内 `.npmrc`）、`packages/server/evaluator/src/row-mcp.ts`（观测格结论）
