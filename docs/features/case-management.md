# 用例管理

## 定位

用例固定「同一道题」：仓库 + commit + 考题提示词 + 评分标准项，固定之后任意候选的产出可被完整复现与追溯。用例只回答「测什么」——表单里既没有评分模型（评分与生成都走设置页的全局默认），也没有评分提示词（自由文本的评分要求已由评分标准项取代）。`/cases` 页 = 列表 + 右侧栏，右栏三种内容（详情 / 创建 / 编辑）由 `?panel=detail|new|edit&id=…` 决定，同一栏位换内容、不弹层。用例**一文件一落**：`<casesRoot>/<用例 id>.json`（文件名即身份，默认 `~/.aieval-cases`）——布局、路径优先级、落盘与 git 自动同步见《数据与存储》的《用例目录》。

## 页面形态与交互

### 列表

`Table` 列 = 标题 / 仓库 / commit / 更新时间（commit 列名逐字是 `commit`）。`commitHash === null` 的格子是次要色「默认 HEAD」；非空时是 `code` 样式的 7 位短哈希 + `Tooltip` 显全量。仓库名渲染走 `displayRepoName(source)`——渲染期任何字符串都不抛错（读侧拿到的是已落盘的数据，一个坏行不该让整页白屏）；会抛错的 `parseRepoSource` / `RepoSourceStringSchema` 只在写侧校验用。右上「创建用例」，空态用 `EmptyState` 引导。

**列表排序**（用户口径：默认「标题」倒序，标题 / 仓库 / 更新时间三列可排；`commit` 列不参与）：

- 比较口径写在页面文件内的 `compareSortText` / `compareSortTime`（**刻意不抽模块**，与 `/runs` 页各持一份；改一处必须同时改另一处）：
  - 文本一律 `localeCompare('zh-Hans-CN', { numeric: true })`——默认的码点比较对中文等于乱序，`numeric` 让「测试2」排在「测试10」前面；
  - 仓库列按**显示名**排（`displayRepoName` 的末段，所见即所排），同名的再按全路径兜底；
  - 时间一律 `Date.parse` 取毫秒比（同类 ISO 串的字典序与时刻序一致，混进带时区偏移的写法就错位）；
  - **空值 / 坏值当最小值**：非字符串、纯空白、解析不出时刻的值（读路径 `parseCaseFile` 不过 schema，手改文件能造出来）升序排最前、降序排最后；
  - 同值行**不写兜底键**：服务端返回的就是 `updatedAt` 降序（`api/cases.ts` 的 `listCases`），`Array.prototype.sort` 稳定 ⇒ 比较为 0 的行永远保持那个顺序，与方向无关。
- 比较器**只写升序语义**：方向由 antd 施加（它把整个返回值取反），自己再翻一次就是翻两次。
- 表头三态是 antd 原生循环（**排序状态只在内存**，不进 URL、刷新回默认）：
  - 默认列「标题」：进入即降序 → 点 1 次升序 → 点 2 次取消（箭头消失、数据回到服务端顺序）→ 点 3 次回到降序；
  - 其余列：升序 → 降序 → 取消；
  - `defaultSortOrder` 只是**页面初始**状态——点过别的列之后 antd 会丢弃它，某列的首次点击方向回到该列 `sortDirections` 的首项。故「标题」列显式写了 `sortDirections: ['descend', 'ascend']`：默认的 `['ascend','descend']` 在「当前已是 descend」时 `indexOf + 1` 越界，第一次点击会**直接取消排序**而不是切到升序。

**列表几何**：四列 `th` 高均 **29**（有排序按钮也不折行）；`CASES_TABLE_MIN_WIDTH = 700`，左栏 740px 时 `clientWidth == scrollWidth == 740`（不横滚）。
**守卫缺口**：排序语义（空值口径、首次方向、取消态、显示名排序）**零自动化守卫**——口径刻意不抽模块、不加单测，判据只有本节的文字与真机核对；改这两张表的列时照本节逐条核对。

**坏文件告警**：`GET /api/cases` 的响应除 `cases` 还带 `warnings`（契约 `CaseList`）——文件名不合 id 形状 / 读不出 / 不是合法 JSON / 内容不是对象的文件由存储层**跳过**，列表页据此出一条 warning Alert「有 N 个用例文件被跳过，这些用例没有显示出来」+ 逐条原因（`apps/web-next/app/cases/page.tsx`）。一条坏文件不能让整页列表 500（用户要能从这一页把那个文件删掉），但也不能不说：跳过而不说，用户的症状是「我的用例不见了」却查不到原因。

### 创建与修改表单（两态同构，编辑态预填）

| 字段 | 控件与行为 |
|---|---|
| 标题 | `Input`，必填 |
| 考题提示词 | `Input.TextArea`（等宽字体），必填 |
| 代码来源 · 类型 | `Radio.Group`：远端仓库（默认）/ 本地目录。纯展示层状态，落到同一个 `repoPath` 字段；编辑态按形态回填，切到本地清空分支 |
| 代码来源 · 地址 | 远端填 URL、本地填绝对路径，服务端 `parseRepoSource` 判形态 |
| 分支（仅远端） | 留空 = 远端默认分支；本地来源填了直接 `INVALID_QUERY` |
| commit hash | `AutoComplete`：候选项 = 最近 20 条提交（`git log --format=%h%x09%s -n 20`），也可手工输入任意合法 hash（`git rev-parse --verify <hash>^{commit}` 判存在并把短哈希归一成 40 位）——纯便利功能，不能只允许从候选里选 |
| 评分标准项 | 表格编辑器（见下节） |

「校验」按钮挂在「代码仓库」格的 `suffix` 上、连同分支一起校验；「重新加载候选」挂在同一格的 `extra` 槽。远端首次点击可能触发克隆（分钟级），loading 文案分别是「正在校验并拉取远端仓库…」「正在拉取远端仓库…」，背后有 10 分钟墙钟上限。校验回显：

- 远端：`仓库：{repoName} · {默认分支|分支}：{branch} · tip {7 位短哈希} · 镜像：已就绪（更新于 YYYY-MM-DD HH:mm）`——`tip` 与镜像时间各自可缺，缺时不占位。
- 本地：`仓库：{repoName} · 当前分支：{branch}`（这句逐字不变）。
- 「默认分支 / 分支」看的是**表单里的分支输入**，不是服务端解析出的 branch——用户填了分支却看到「当前分支：main」会以为填的没生效；分支输入一改，回显立即成对失效。

`extra` 文案按来源切换，远端那句必须写明「认证使用本机 git 的 SSH key / 凭据助手，工具不保存任何凭据」。

### 远端 git 镜像：表单内的一项能力

远端不是独立入口：它只是 `repoPath` 的一种形态（不新增 `repoUrl` 字段），由服务端**自动镜像**到 `{workspaceRoot}/remotes/<slug>-<hash8>/`，做成**裸镜像**（`git clone --mirror`：没有工作树、不脏、全部分支以 `refs/heads/*` 可见），跨用例复用。

**形态判定**（唯一真源 `contracts/src/repo-source.ts`，顺序不可换）：

| 序 | 形态 | 判定 | 例 |
|---|---|---|---|
| 0 | 含控制字符（`\u0000-\u001f\u007f`）· 以 `-` 开头 | 拒绝 `INVALID_QUERY` | 粘贴带换行的 URL；`-x` |
| 1 | Windows 盘符 `^[A-Za-z]:[\\/]`、UNC `^\\\\` | local | `D:\repos\demo`、`\\host\share\repo` |
| 2 | 白名单 scheme：`ssh://` / `http://` / `https://` / `git://` / `file://` | remote | `https://host/group/repo.git`、`file:///D:/tmp/origin.git` |
| 3 | 其它 `^[A-Za-z][A-Za-z0-9+.-]*://`（scheme 大小写不敏感） | 拒绝 `INVALID_QUERY`，不回落成本地路径 | `ftp://host/x.git`、`FTP://host/x.git` |
| 4 | scp 形态 `^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]{2,}:.+$` 且「含 `@`」或「host 段含 `.`」 | remote | `git@host:group/repo.git` |
| 5 | 其余 | local | `/home/me/tool-id`、`./repo` |

- 第 4 条的附加条件是为了不把 `src:foo` 这类含冒号的本地相对路径误判成远端；`localhost:repo` 因此判 local（要指定它请写 `ssh://localhost/repo`）。
- `file://` 判 remote 是刻意的：整条远端链路（镜像、基线解析、超时、失败分类）可以用本地裸仓库全覆盖，不需要网络。
- 控制字符查**原串**（先 `trim` 就等于放行最常见的粘贴事故）；「以 `-` 开头」防 URL 被 `git clone` / `git ls-remote` 当成选项解析。
- **归一**：两侧空白 `trim`，远端仅去掉尾部 `/`，此外不做任何归一（不折叠大小写、不剥 `.git`、不把 https 改写成 ssh）——它是镜像 key 与「来源是否改变」的判据。
- 仓库名：远端取 URL 末段去 `.git`（无路径段时回落 host），本地取路径末段。用途限定：界面标签与远端来源的服务端取值；本地来源的服务端仓库名仍走 `resolveRepoInfo` 的 git 口径（`rev-parse --show-toplevel` 的目录名）。

**镜像目录与生命周期**（`core/src/mirror.ts`）：

- 目录名 = `slug` + `-` + `sha1(归一 URL).slice(0,8)`；slug 取 URL 末段去 `.git`、非 `[A-Za-z0-9._-]` 归一成 `-`、小写化、截 40 字符、为空则 `repo`。**身份判据是 hash 段**（slug 只为人眼可读）。`remotes/` 是 `workspaceRoot` 下的第三个兄弟目录；改工作区根目录后旧镜像不再被看到（会在新根下重新克隆）。
- 就绪判据 = `<dir>/HEAD` 是文件且 `<dir>/objects` 是目录——不是「目录存在」（克隆中途失败会留下没有 objects 的半成品）。未就绪则清残留、克隆到 `<dir>.tmp-<pid>`、成功后 `renameSync` 原子改名；rename 撞车（并发已建）当作成功复用。
- `ensureMirror`：已就绪直接返回 `created: false`，**不联网**。`fetchMirror`：`git fetch --prune origin`（`--mirror` 克隆的 config 里 `remote.origin.mirror=true`，普通 fetch 即全 refs 同步）→ 立刻对齐镜像 HEAD（`fetch` 自己不刷新 HEAD，这一步是「跟随远端默认分支」的承重点：调用方给了分支名就用，没给就自己 `ls-remote` 一次）→ 写镜像记录 `<dir>/aieval-mirror.json`（`{ url, fetchedAt }`，`url` 存归一形态；写失败只 WARN）。**更新不在 `ensureMirror` 里做**：候选列表要快（不联网）、校验要新鲜、评测准备必须新鲜——把 fetch 混进去会让准备路径联网两次。记录只用于诊断与回显「更新于 YYYY-MM-DD HH:mm」，**不参与就绪判据**（缺失或不可解析按「没有记录」处理、不重建）。
- `probeRemote`：`git ls-remote --symref <url> HEAD` 解析默认分支与 tip；空输出（远端没有任何 ref）→ `NOT_A_GIT_REPO`「远端仓库还没有任何提交」。
- `resolveRemoteRef`：`commitHash` 非空时**先查镜像、查到即回（不联网）**，查不到才 fetch 一次再判、仍没有 → `INVALID_REF`；分支那条路先 fetch → `branch` 非空取 `refs/heads/<branch>^{commit}`（不存在 → `INVALID_REF`）→ 否则取远端默认分支。
- **core 只见本地路径**：远端在 api / evaluator 层就被解析成「镜像路径 + 具体 commit hash」，再交给既有 `prepareRowWorkspace` / `copyWorkspace` / `checkoutRow` / `collectDiff`——远端 URL 只出现在 `mirror.ts`。
- **分支与更新规则**：分支 tip **每次评测重新解析**（跟随语义）；填了 `commitHash` 则**钉死**（优先于分支）。
- **非交互 + 墙钟超时**：`GIT_TERMINAL_PROMPT=0`、`stdio: ['ignore', 'pipe', 'pipe']`（stdin 必须断开：ssh 拿不到输入时会立即失败）、`GIT_SSH_COMMAND` 追加 `-o BatchMode=yes`（仅在进程环境里没有它时）；探活 15 秒（`REMOTE_PROBE_TIMEOUT_MS = 15_000`）/ 传输 10 分钟（`REMOTE_TRANSFER_TIMEOUT_MS = 600_000`），都可由调用方覆盖。同步 git 调用挂在请求线程上，clone / fetch 期间整个进程阻塞（已知代价，墙钟上限兜底）。
- **不做凭据管理**：认证一律用本机 git（SSH key / ssh-agent / credential helper）。

**错误分类**（`classifyRemoteFailure`，按序判；中文原因在前，git 原文另放 `context.gitMessage`）：

1. **先判超时**（`signal === 'SIGTERM'` 或 `code === 'ETIMEDOUT'`，不靠关键词——远端自己报的 timeout 原文长得很像）⇒ `REPO_UNREACHABLE`「远端仓库拉取 / 探活超时（超过 N）…已终止 git 进程」。
2. `Permission denied (publickey` / `Authentication failed` / `could not read Username` / `HTTP Basic: Access denied` / `terminal prompts disabled` → `AUTH_FAILED`（只给中文原因）。
3. `Could not resolve host` → 不可达（点名 DNS）。
4. `Connection timed out` / `Connection refused` / `Network is unreachable` / `Operation timed out` / `Could not connect to server` / `Couldn't connect to server` / `Timeout was reached` → 不可达。
5. `Host key verification failed` → 指纹未信任（同样 `REPO_UNREACHABLE`）。
6. `does not appear to be a git repository` → `NOT_A_GIT_REPO`「不是 git 仓库」。
7. `not found` / `Repository not found` → `NOT_A_GIT_REPO`「远端仓库不存在或无权访问」；其余 → 无法归因（同样 `NOT_A_GIT_REPO`，原文照带）。

**这张表匹配的是 git 的 stderr 原文，所以它是版本敏感的**：同一件事换一个 git 版本就可能换措辞——有的版本报 `Failed to connect to …: Could not connect to server`（整句里**没有** `Connection refused`），有的把 `Could not` 写成 `Couldn't`，两种都得收；漏收的后果是掉进第 7 条「无法归因」。新增 / 改动文案时先拿 `git ls-remote` 复现一次原文再往表里加，别照抄旧记录（守卫：`core/src/mirror-fetch.test.ts` 的「没人监听的端口」）。

认证失败与墙钟超时两支只给中文原因——超时那一支被墙钟杀掉时 git 原文只有 Node 的英文，写成「原因」是误导。

### 评分标准项

- **形态**：组 → 评分项的二级表格，每项三列 `ID` / `目标` / `权重`；模型对每一项做**二元判定**（达成 / 未达成），**没有部分分**。`总分 = 达成项权重之和`；`满分 = 全部项权重之和`（由表格决定，不是常量 100），满分**快照**进 `ScoreResult.maxScore` ⇒ 改了表之后历史分仍自洽。评分表**快照进轮次**（`EvalRun.rubric`），跑一行时读快照、不读用例——改了用例的表，历史记录一个字节都不变，「重新评分」用的也仍是当初那把尺子。
- `RubricSchema` **刻意不设 `.min(1)`**：空表 `{ groups: [] }` 是新建用例的真实初态，非空要求只由 `validateRubric` 在**提交时**给出。
- 项的 `id` 允许为空：空 id 的项按**位置**分配引用键 `#k`（全表顺序号，跨组连续，按 `trim()` 判空）。`validateRubric` 额外断言**生成的引用键两两不同**——两把相同的键会让模型的一次判定被同时记到两项上，分数悄悄多出一块而界面一切正常。
- `validateRubric` 是**提交用例时的唯一判据**（界面与后端共用）：至少一组、每组至少一项、组名非空、目标非空、权重正整数（上限 `MAX_ITEM_WEIGHT = 10_000`）、id 不重复、引用键不重复；返回点名哪一组、哪一项的中文原因，不是笼统的「表格不合法」。
- `renderRubricForJudge` 渲染 Markdown 二级表格，第一列是**引用键**（模型据此指认「我评的是哪一项」）；组名、引用键与目标走同一份转义——它们同为自由文本（`|` 与换行都合法），漏转义会让整行列错位，而错位之后模型读到的是一张与界面不同的表。
- **智能生成与智能识别**（`generateRubric`）：两个分支都是**一次非流式文本调用**（`callTextApi`）——不建工作区、不起 CLI、不走 `AgentJudgeInput`，只用设置页的全局默认评分模型。生成分支（`prompt` 为空）输入题面 + 仓库名 + 当前表格，输出**只新增**的组与项（禁止复用已有 ID、同名组复用原名、表格已完备时返回空 `groups` 不凑数）；识别分支（`prompt` 非空）用户原文**原样放入**、整表替换（组数项数数字一个都不许改）、`addedItems` 固定 0。`mergeRubric` 按组名归位（同名组追加到该组末尾，否则新建组追加到表尾）。两个按钮打同一个接口 `/api/cases/generate-judge-prompt`；**失败绝不改调用方状态**（弹窗不关、文本原样保留）。
- **三层职责**（各只做一件事）：

| 层 | 落点 | 不合格时 |
|---|---|---|
| 体验层 | 用例表单提交前 | `validateRubric` 的中文原因当场拒绝提交（表格上方显示同一句），**不发请求** |
| 真相层 | `api/cases.ts` 的 `assertStorable()` | 抛 `INVALID_QUERY` + 中文原因（**落一处**，两处各写一遍必然漂移） |
| 兜底层 | 编排层起一行评分之前 | 满分 ≤ 0 ⇒ 该行落**评分失败** + 中文原因，不许走到评分器 |

  兜底层会真的开火：用例文件（`<casesRoot>/<用例 id>.json`）是手可编辑的，而 `{ groups: [] }` 是一张合法的 `Rubric` ⇒ 手改的空表用例读得出来、创建评测会把空表快照进 `run.json`，开跑时兜底层把它变成一句可展示的 `CONFLICT`（文案点名「这一轮的表在创建时已快照，改用例不影响它，出路是新建一轮」）。**不要在 `createRun` 再加「空表不许建轮」的守卫**——空表是写用例过程中的合法初态。
- **旧数据**：旧用例带着评分提示词 / 用例级评分模型——读侧（`asStoredCase`）显式删这三键后照常列出（列表不该因为一条老数据白屏），真正的拦截发生在使用路径（`asUsableCase`）：缺 `rubric` 或形状不合法时抛中文 `INTERNAL`「这个用例是旧版数据（没有评分标准项），请删除它或重新创建：`<caseId>`」——**绝不给它 `.default({ groups: [] })`**（那会让旧用例看起来只是「还没配」，而它实际带着一份已无意义的旧提示词）。

### 提示词渲染

详情面板**只有考题提示词走 markdown**（`MarkdownText`，`react-markdown@10.1.0` + `remark-gfm@4.0.1`）：h1 → antd `Title` 4 级、h2–h6 → `Title` 5 级、链接新标签打开并带 `rel=noreferrer`、`pre` 保留 `white-space: pre` 并横向滚动；`code` / `strong` / `del` / `ul` / `ol` / `blockquote` / `table` 全部交给 antd 排版样式。带 `remark-gfm` 是因为题面里会出现大段 GFM 表格（不带插件那些行退化成一堆竖线文本）；不带 `rehype-raw` 是因为提示词是外部输入（模型 / 外部系统产生），默认转义成文本即可看见内容，又不引入 XSS 面。详情面板不渲染「评分维度」行与「评分提示词」卡片（契约里没有 `judgePrompt` 这个字段）——渲染一个不存在的字段等于给用户看假话。

### 删除

`Popconfirm` 确认。若该用例已被评测引用：

- **确认框不显示引用数**（契约里没有「按用例查评测数」的路由，页面传 `referencedRuns={null}`，界面走「不显示数字」那一支——把「不知道」显示成 0 会让用户以为删除没有影响）；删除**成功之后**的提示才列出数字（`{affectedRuns}` 个评测记录的冗余快照仍可查看），删除本身**不阻塞**。
- 已完成的评测记录**保留**：评测里冗余存了仓库来源、分支、commit 与**评分表快照**，不依赖用例仍存在。
- 用例级本地缓存仓库（`{workspaceRoot}/cases/{caseId}/cache`）一并删除。
- **落到磁盘的是删文件**：删掉 `<casesRoot>/<用例 id>.json`（`deleteCaseFile` 幂等——文件本来就不在也算成功），随后按设置页的「用例变更时自动提交」排一次后台同步。开着时这次删除会作为**一个只含该文件的提交**进 git（回退文案「删除用例「标题」」），关掉时删除只落在磁盘上，要到设置页点「提交」才进 git。
- **不动远端镜像**（它按 URL 命名、可能被多个用例共用，且不随用例消失）。
- 删除动作的 `onConfirm` 必须回交在途 promise：antd 的 `ActionButton` 只在 `onConfirm` 返回 thenable 时才等待——返回 `undefined` 时确认框**立刻关闭**，用户看到「点一下就没反应」，再点一次就是第二次 DELETE。

## 数据与契约

| 字段 / 契约 | 内容 |
|---|---|
| `TestCaseSchema.repoPath` | 语义是「来源」，落 `RepoSourceStringSchema`（旧值的判定结果不变）；schema 失败时把 `ServiceError` 的中文原因原样塞进 zod issue，不另写一份文案 |
| `CASE_ID_PATTERN` / `isCaseIdShapeValid` | 用例 id 的形状判据（**文件名安全**）：`/^[A-Za-z0-9_-]{1,64}$/`。id 直接当文件名用，这条判据同时是路径穿越的安全边界——写侧 `assertCaseId` 抛 `INVALID_QUERY` + 中文原因，读侧跳过并记进 `warnings` |
| `CaseList` | `{ cases, warnings }`：坏文件被跳过时把原因带出来（界面在列表页出告警条）。列表必须能渲染，否则用户连删掉那个坏文件的入口都没有 |
| `TestCaseSchema.repoBranch` / `CaseCreateSchema.repoBranch` | `z.string().min(1).nullable().default(null)`；`.default(null)` 是**载重**的：迁移前住在 `config.json` 里的旧用例没有这一列，读侧必须按 null 读 |
| `RepoInfoSchema` | `kind: 'local' \| 'remote'`、`mirrorPath`、`mirrorReady`、`mirrorFetchedAt`、`tip`（短哈希 7 位，仅远端有值）；`branch` 语义：本地 = 当前分支，远端 = 默认分支或用户填的分支 |
| `EvalRunSchema.repoBranch` | 快照口径：用例改分支 / 删除后，这一轮从哪个分支的哪个 commit 起跑仍读得出来 |
| `errors.ts` | `REPO_UNREACHABLE`（400）；认证用 `AUTH_FAILED`（`context.host`），不存在 / 不是仓库 / 无法归因用 `NOT_A_GIT_REPO`，分支与提交不存在用 `INVALID_REF` |
| `parseRepoSource` / `repoNameFromSource` / `displayRepoName` | 判定路径用前两者（非法来源响亮地抛错），渲染路径用 `displayRepoName`（任何字符串都不抛错）。放 contracts（不是 core / ui）：三层都要用（core 镜像层、api 校验与文案、ui 标签），放一处才有唯一真源 |
| rubric 契约 | `RubricItemSchema` / `RubricGroupSchema` / `RubricSchema`、`rubricMaxScore`（空表返回 0）、`rubricItemKeys`（有 id 用它，没 id 用 `#k`）、`validateRubric`、`composeTotalScore`、`renderRubricForJudge`（两条评分通路共用同一份）、`MAX_ITEM_WEIGHT = 10_000` |

## 状态机与时序

- **校验时序**（`validateRepo`，远端分支）：`probeRemote` →（镜像未就绪时）`ensureMirror` 首次克隆——**克隆本身就是这一次取回，紧接着不再 fetch**（大仓库首次校验是分钟级的）→ 镜像已存在时 `fetchMirror`（增量，通常 1–3 秒；把探活拿到的默认分支名传进去对齐镜像 HEAD）→ `resolveRemoteRef(…, { fetch: false })`（分支不存在在这里就拦下）→ 回 `kind:'remote'`、`repoName`、`branch`、`tip`（7 位）、`mirrorPath`、`mirrorReady: true`。远端校验**不 checkout、不碰工作树、不建行工作区**。
- **候选时序**（`listCommitCandidates`）：remote = `ensureMirror`（就绪则纯本地、**不联网**——来源临时改名移走后候选照常出）→ `resolveRemoteRef(…, { fetch: false })` 取该 ref 的 40 位 tip → `git -C <dir> log --format=%h%x09%s -n 20 <tip>`；复用 `resolveRemoteRef` 而不自己算 ref 名（默认分支的取名只在一处实现）。
- **保存时序**（`createCase` / `updateCase`）：形态判定走 `parseRepoSource`；本地来源 + 非 null 分支 → `INVALID_QUERY`（**按值判**，避免 UI 的全量补丁把无关保存拦下）；远端分支 / commit **先在镜像里判**，判不过时只 `fetchMirror` 一次再判，仍判不过才抛（远端刚推上来的分支不该因为镜像还没更新而被拒）；落盘时 `commitHash` 归一成 40 位、`repoBranch` trim（空串 → null）。
- **评测准备阶段**（消费这些字段的时刻，`repoPath` / `repoBranch` / `commitHash` 已快照进 `run.json`）：remote 时 `ensureMirror`（不联网更新）→ `resolveRemoteRef`（缺省 `fetch: true`，分支 tip 重新解析；**钉死的 commit 已在镜像里时一次都不抓**，否则这是本轮唯一一次 fetch）→ `prepareRowWorkspace` 传**具体 hash**（基线已解析成 40 位具体值，缓存只需从镜像取对象）→ `EvalRow.baselineCommit` = 该 hash。基线解析口径：

| 来源 | `repoBranch` | `commitHash` | 基线 |
|---|---|---|---|
| local | null | null | 缓存刷新到来源仓库当前 HEAD（既有语义） |
| local | null | hash | `assertCommit` |
| local | 非 null | 任意 | 写入口就 `INVALID_QUERY`（到不了准备阶段） |
| remote | null | null | 远端**默认分支** tip（每次评测 fetch 后重新解析） |
| remote | `feat/x` | null | `refs/heads/feat/x` 的 tip（同上） |
| remote | 任意 | hash | 该 commit（镜像里没有 → fetch 一次 → 仍没有 → `INVALID_REF`） |

  local 与 remote 的「默认分支 HEAD」**不是同一个东西**：local 取来源仓库**当前检出的 HEAD**（可能停在特性分支上），remote 取**远端默认分支**——这是两种来源的固有差异，不试图统一。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| clone / fetch 期间阻塞整个服务进程 | 取舍 | 同步 git 调用挂请求线程，只有 10 分钟墙钟兜底；阻塞时长未量化（并发请求在克隆期间的表现未测） |
| 镜像没有清理入口、也不随删用例消失 | 已登记 | 不随用例消失（按 URL 命名、可能共用）；工作区根目录一变，旧镜像就不再被看到（重新克隆） |
| `mergeRubric` 的两条代码侧口径问题 | 未修 | ① 当前表自己不过 `validateRubric` 时（如表单里刚加的空组），合并结果被 `JUDGE_PARSE_FAILED`「评分模型返回的表格不合法：…」拒——把用户自己的表说成模型违约；② 去重与判空用**未 trim** 的 `item.id`，新增项写 `' A1 '` 绕得过「复用已有 ID」检查，随后被 `validateRubric` 的 ID 重复分支接住（报「评分项 ID「A1」重复了」）。均为代码侧口径，别当成文档口径 |
| 「改用例之后重评仍读快照」没有守卫 | 守卫缺口 | 创建那一刻的快照有用例钉住，但传的表恰好与夹具缺省相同 ⇒ 分辨不出快照是从用例取来还是落了缺省值；未在改用例之后再取分 |
| 识别分支的路由取值没有用例 | 守卫缺口 | 生成侧有两条（转出同一性 + 生成分支路由断言——后者钉的是「入参里没有模型」这一形状）；识别分支如实登记 |
| 「生成路径不 import `@aieval/agents`」没有静态守卫 | 守卫缺口 | ESLint 的 api 禁用名单里也没有它——现状如此，别把「现状」读成「有人守着」。理由：一旦生成路径能起 CLI，「一次几十秒的表格补全」会变成「一次几分钟的会话」，而它按的是同一个按钮 |
| 两条评分通路共用 `finalizeScore` 收口，但没有「同一份回复喂两条通路再比对」的用例 | 守卫缺口 | 两份夹具不同，如实登记 |
| 从裸镜像克隆出的工作副本 `refs/heads` 恰好一条 | 守卫缺口 | 这是行工作区解析的前提依赖；「来源仓库变了就重克隆」的守卫落在用例缓存（`git-repo-cache.test.ts`），不在镜像层 |
| 镜像来源 URL 变更后重建目录 | 由设计覆盖 | 目录身份已由 `mirrorDir` 的 URL hash 段覆盖，未单独设守卫 |
| markdown 渲染的暗色主题未真机切换 | 未闭合 | 组件里没有任何写死的颜色 / 字号 / 内边距（样式全部来自 antd 排版 token / CSS 变量，随 `darkAlgorithm` 自动生效）；外链行为只有 jsdom 单测钉住（该题面 0 个外链，真机没有可点样本）；窄栏横向滚动未在 320px 实测 |
| 界面三处未在真机走查 | 未覆盖 | 来源切换、回显文案、候选按钮三处由服务层全链路冒烟 + ui 单测 + 读源码接线守卫覆盖，真机点检未做（3083 端口被别的 dev server 占用，起不了隔离实例）；真实远端（scp 形态、带凭据）未触网验证 |

## 相关链接

- [功能总览](/features/) —— 本域目录层：三大模块与数据模型清单
- [创建评测](/features/run-creation) —— 用例被引用进评测时的快照口径与准备阶段
- [修改、重跑与删除评测](/features/run-edit-rerun-delete) —— 评测侧换用例时的六格快照重取
- [Codex 接入](/protocols/codex)、[《Claude Code 接入》](/protocols/claude-code)、[《DeepSeek Harness 接入》](/protocols/dsh) —— 三家候选智能体
- [《设置》](/features/settings)、[《数据与存储》](/features/storage) —— 全局默认评分模型（评分标准项的生成与识别只用它）、工作区目录与镜像落点
- [故障索引](/faq/) —— 远端 git 与评分标准项相关报错的排障入口
