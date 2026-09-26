# 用例页（/cases）10 项交互冒烟记录

- 任务：p2 Task 8（用例页重写 —— 列表 + 右栏详情/创建/编辑三态，URL 驱动）
- 分支 / 基线提交：`feat/features` @ `37274f7`（Task 7 的用例域路由）
- 日期：2026-09-25
- 运行环境：Next 16.2.7（Turbopack dev）+ React 19.2.7 + antd 6.6.5 + SWR 2.5.1；浏览器 = Playwright 驱动的 Chrome，视口 **1440×900**
- 地址：**http://localhost:3083/cases**（按文档约定用 `localhost`，不用 `127.0.0.1`）
- 截图目录：`D:\zhanglei1120\Github\deepseek-harness\`（Playwright MCP 的输出目录，文件名见各项）

> **后续变更注记（p2 收口后追加，读本记录前先看这一段）**
>
> 本记录是 `bc24057` 时刻的**历史快照**。之后发生了两件事，与下面若干条目不一致，以本注记为准：
>
> 1. **§6 记的那条 `[antd: Input] addonAfter is deprecated` 已被 `b6100eb` 修掉**（改用 `Input` 的 `suffix`，
>    与该告警的官方替代 `Space.Compact` 之所以不可用，见 `case-form-panel.tsx` 的注释）。
>    不要再按 §6 去找这条告警——它现在只可能出现在**变异体**里；它在真实浏览器里的复核转入
>    p6 计划 Task 4 的 Step 8a（`/cases?panel=new` 打开后控制台无 antd 弃用告警）。
> 2. **变异体编号在三份文档里是三套**：本记录 §4 引用的「M5」实际是 `task-7-8-9-report.md` 里的 **M7 / M7b**，
>    而修复波 `b6100eb` 的报告又用了一套 M1–M4。交叉引用请以任务报告的编号为准；本记录不改写历史结论，只做这一处指引。
> 3. §8 的 11 张 `task8-*.png` 截图在**仓库外**（上列目录，2026/9/25 10:27–10:40 实测存在），不随仓库入档 ⇒
>    只凭本仓库无法复核像素级结论；需要复核时按 §8 的文件名到该目录取图。
> 4. `b6100eb` 之后新增的三项界面结论（stale 分支不丢输入、`matchesCommitsKey` 真触发重取、控制台无弃用告警）
>    同样转入 p6 计划 Task 4 的 Step 8a–8c。

## 1. 范围清单

覆盖：空态引导与右栏换入、空表单中文必填、仓库校验回显（与 `git branch` 互证）、**候选之外的合法 hash 手工提交**（守卫 ①）、刷新后 URL 与栏宽保持、详情↔编辑换栏（不叠加/不弹层）、**未配置评分模型时「AI 生成」禁用（R30 真机验证）**、**生成失败不清空已有提示词**（守卫 ③）、**删除只删该删的 + 确认框等待在途请求**（守卫 ②）、手改 URL 的两个分支。
不覆盖（见 §5）：真实模型供应商的成功生成、维度预览「随生成结果变化」、`affectedRuns > 0` 的提示文案、窗口自适应与分隔条几何、键盘/触摸、主题三档、`/runs` 与 `/settings` 的行为。

## 2. 服务与进程

| 项 | 值 |
|---|---|
| 启动命令（后台 job） | `$env:AIEVAL_CONFIG_DIR="$env:TEMP\dsh-task789\aieval-config"; pnpm dev`（`apps/web-next`，端口 3083） |
| job | `pwsh-492`（dev）；`pwsh-491`（**假模型上游**，`node stub-upstream.cjs`，只监听 `127.0.0.1:3099`，OpenAI 兼容 `/v1/chat/completions`） |
| 就绪 | `GET /api/settings` → 200，body 里的 `workspaceRoot` 指向临时目录（证明配置隔离生效） |
| 收尾 | 两个 job 均已 `job_kill`；`Get-NetTCPConnection -LocalPort 3083 -State Listen` → **0 个监听** |
| 真实配置目录 | 全程**未被写**：`C:\Users\zhanglei1120\.aieval\config.json` 冒烟前后同为 `LastWrite 2026-09-24T17:39:36` / `219 B` / `SHA256 750BBF15…F191D` |
| 冒烟用的隔离配置 | `%TEMP%\dsh-task789\aieval-config\config.json`（预置 1 个供应商 `p-stub` → `http://127.0.0.1:3099/v1`，`defaultJudge = p-stub/stub-model`，`workspaceRoot = %TEMP%\dsh-task789\runs`） |

## 3. 操作路径与证据

### 第 1 项 空列表 → 点「创建用例」→ 右栏出现表单（不弹层、不叠加）

- 操作：全新加载 `/cases`（隔离配置下 cases 为空）→ 点空态里的「创建用例」。
- 证据（`browser_evaluate` 实测）：`[data-pane-key]` 宿主 **2** 个（list 1020px / detail 420px）、分隔条 **1** 个；`.ant-modal / .ant-drawer` **0** 个（不是弹层）；右栏卡片标题 = **创建用例**；URL 由 `/cases` 变为 **`/cases?panel=new`**。
- 截图：`task8-item1-empty-state-1440x900.png`、`task8-item1-panel-new-1440x900.png`。
- 判定：**通过**。

### 第 2 项 什么都不填点「创建」

- 操作：点表单底部「创建」。
- 证据：URL **不变**（没有提交）；4 条中文必填提示：`请填写标题` / `请填写考题提示词` / `请填写评分提示词` / `请填写代码仓库的本地绝对路径`；列表仍为空（`table` 未渲染）。
- 判定：**通过**。

### 第 3 项 填表 + 校验仓库 → 绿色回显

- 操作：填标题 / 考题提示词 / 评分提示词，仓库填本仓库绝对路径，点「校验」。
- 证据：`[data-testid="case-repo-info"]` 文案 **`仓库：ai-result-evaluation · 当前分支：feat/features`**，类名含 `ant-alert-success`；与 `git -C D:\zhanglei1120\Github\ai-result-evaluation branch --show-current` 的输出 `feat/features` 互证。
- 截图：`task8-item3-repo-validated.png`。
- 判定：**通过**。

### 第 4 项 候选之外的合法 hash 手工提交（守卫 ①，必须留证）

- 前置实测（证明「不在候选里」这件事真的成立）：`POST /api/cases/commits` → `{count: 20}`，含 `37274f7`（HEAD）与 `af05fdf`（HEAD~1），**不含** `b71ec9b`（`git rev-parse HEAD~25` = `b71ec9be6a048928f44773b1a4b07871075c683d`）。下拉里点开也能看到同样的候选（antd 虚拟滚动只挂可见项，DOM 里 11 项）。
  - **偏离 brief**：brief 让用 `git rev-parse HEAD~1` 的结果，但本仓库 HEAD~1 **在**候选里，那个输入验不出「候选不是白名单」。改用 `HEAD~25`（合法提交、但不在最近 20 条候选里）。
- 操作：在 commit 输入框里手工键入完整 `b71ec9b…683d`（下拉显示中文 `暂无候选提交，可手工输入完整 hash`，不选中任何候选）→ 点「创建」。
- 证据：创建成功，URL 变为 `?panel=detail&id=eaa011f3-9f4d-4214-bc6a-3bf5bc3204da`；详情栏 `commit` 字段 = **完整 40 位** `b71ec9be6a048928f44773b1a4b07871075c683d`；列表行显示短哈希 `b71ec9b` + 仓库名 `ai-result-evaluation`；磁盘 `config.json` 里该用例的 `commitHash` 也是完整 40 位。
- 截图：`task8-item4-created-detail-fullhash.png`。
- 判定：**通过**。

### 第 5 项 刷新后仍在详情栏（右栏宽度也保持）

- 操作：先把右栏从 420 拖到 **500**（`localStorage['cases-detail-width'] = "500"`）→ 再做一次**硬导航**（`page.goto` 同一 URL）→ 重新渲染。
- 证据：URL 仍为 `?panel=detail&id=eaa011f3…`；两栏 **940 / 500**（与刷新前逐像素一致）；详情卡标题 `为网关补齐转换回归`；选中行底色 `rgb(230, 244, 255)`（= `--app-selected` 的明亮值）；`commit` 仍是完整 hash。
- 截图：`task8-item5-reload-persisted.png`。
- 判定：**通过**。

### 第 6 项 点「编辑」→ 右栏**换成**表单（不叠加、栏宽不变）

- 操作：详情卡右上点「编辑」。
- 证据：URL → `?panel=edit&id=…`；`[data-pane-key]` 仍是 **2** 个、`.ant-modal/.ant-drawer` 仍是 **0** 个（详情卡被**替换**成表单，不是叠一层）；两栏 **940 / 500** 与点击前完全一致；列表行仍在；表单字段全部预填（标题 / 考题提示词 / 评分提示词 / 仓库路径 / 完整 commit hash）。
- 截图：`task8-item6-edit-swapped-panel.png`。
- 判定：**通过**。

### 第 7 项 清掉默认评分模型后「AI 生成」禁用（**R30 真机验证**，必须留证）

- 操作：在设置页「模型供应商」Tab 删掉唯一的供应商（确认框文案含「它的 API 密钥与模型清单会一起消失…」）→ 回到 `/cases?panel=edit&id=…`。
- 前置实测（这正是 R30 的悬空引用：删供应商**不会**清 `defaultJudge`）：磁盘 `config.json` → `providers: []` 而 `settings.defaultJudge = {providerId: "p-stub", modelId: "stub-model"}`。
- 证据：`[data-testid="case-generate-judge"]`.disabled = **true**，且它被包在 `[data-testid="case-generate-wrapper"]` 里；`browser_hover` 到该 span 后 `[role="tooltip"]` 文案 = **请先到设置里配置默认评分模型**。
  - 反证（同一构建、同一页面的正向路径）：删供应商**之前**，同一个按钮 `disabled = false`、没有 wrapper（第 8 项成功那次的点击就是证据）。
  - 只有「对着 `providers` 解析 defaultJudge 的那一对 id」的实现才会在悬空引用下返回 false；只判 `defaultJudge !== null` 的实现这里会是 true（对应单元测试 `judge-gate.test.ts` 的变异体 M3，见报告）。
- 截图：`task8-item7-generate-disabled-tooltip.png`。
- 判定：**通过**。

### 第 8 项 「AI 生成」成功回填 / 失败不清空（守卫 ③，必须留证）

- 成功半：假上游在线时点「AI 生成」。
  - 证据：`case-judge-prompt` 的值由手写的 `手写内容：生成前占位` 变为假上游返回的 **`【冒烟】只依据 diff 判断改动是否满足考题；看不到 diff 的改动不要臆测。`**；维度预览仍 5 行（`correctness/requirement/quality/robustness/maintainability`）；无错误 toast。
  - 截图：`task8-item8-generate-filled.png`。
- 失败半：`job_kill pwsh-491` 停掉假上游（`Invoke-WebRequest 127.0.0.1:3099` → 连接被拒），把文本框改成 `手写内容：失败前占位（这段必须一个字符都不变）`，再点「AI 生成」。
  - 证据：POST `/api/cases/generate-judge-prompt` → **500**；文本框值**逐字不变**（`unchanged: true`）；红色 toast 文案 **`调用文本 API 失败（127.0.0.1:3099）：fetch failed`**（截图左上角可见）。
  - 截图：`task8-item8-generate-failed-keeps-text.png`。
- 说明：第一次探针用 `.ant-message-notice-content`（antd 5 的类名）取样，得到「没有提示」的**错误**结论；antd 6.6.5 的容器类是 **`.ant-message`**（其下没有 `-notice-content`）。改用 `.ant-message` 后提示正常可见，且截图早已把提示拍进去了。记在这里避免下一个人重踩。
- 判定：**通过**（成功回填 + 失败提示 + 失败不清空）。

### 第 9 项 删除用例（守卫 ②「只删该删的」+ 确认框等待在途请求）

- 操作：先在 `{workspaceRoot}\cases\{caseId}\cache` 里造一个 `marker.txt`（删除前 `Test-Path` = **True**）→ 详情栏点「删除」→ 确认框 → 点「确认删除」。
- 证据 A（确认框文案）：`删除这个用例？已完成的评测记录会保留（用例标题 / 仓库路径 / commit 已作为快照存在评测里）；用例级缓存仓库会一并删除。` + 中文 `取消` / `确认删除`。
- 证据 B（**在途 promise 已交回**）：点「确认删除」后以 20ms 采样——确认框在 **396ms 与 458ms 之间连续 4 个采样点**上仍打开，且「确认删除」按钮带 `ant-btn-loading`（DELETE 在途）；确认框在 **521ms** 才关闭、右栏在 **678ms** 关闭。对照组（把 `handleDelete` 变异成 `(): void => { void remove(id)… }`，见 §4）采样里 loading **一次都没出现**。
- 证据 C（只删该删的）：toast **`用例已删除`**；列表行数 2 → 1；`{workspaceRoot}\cases\{caseId}\cache` 删除后 `Test-Path` = **False**（父目录 `cases\{caseId}` 保留——`caseCacheDir` 的定义就是 `{root}\cases\{caseId}\cache`，删的是缓存仓库本体，不是用例目录壳）；磁盘 `config.json` 里该用例已消失、另一个用例仍在。
- 截图：`task8-item9-delete-confirm.png`。
- 判定：**通过**。

### 第 10 项 手改 URL

- `?panel=bogus&id=does-not-exist`：证据 = `[data-pane-key]` **0** 个、分隔条 **0** 个（右栏整体不渲染、列表单栏占满）、列表行仍在、工具栏「创建用例」仍在、无任何浮层 → **不白屏、列表照常可用**。截图：`task8-item10-bogus-panel-list-usable.png`。
- `?panel=detail&id=does-not-exist`（用例不存在）：右栏渲染中文空态 **`用例不存在` / `它可能已经被删除；也可以直接用右上「创建用例」新建一个`** + 「创建用例」引导按钮；列表仍在（1 行）→ 不是空白右栏。
- 判定：**通过**。

## 4. 附加验证（真机变异对照）

| 守卫 | 变异体（只改实现） | 真机可观测差异 | 结论 |
|---|---|---|---|
| `CaseDetailPanel.onDelete` 必须返回在途 promise（Task 8 的硬性义务） | `handleDelete` 由 `(): Promise<void> \| undefined => remove(id).then(...)` 改为 brief 原文的 `(): void => { void remove(id).then(...) }` | 正确实现：确认框保持打开且「确认删除」进入 loading（396–458ms 四个采样点）；变异体：**loading 一次都没出现**（0 个采样点） | **KILLED**（详见报告的 M5；关闭时刻这一路探针分辨率不够，见 §5-6） |
| 变异体是否真的生效（避免「改了没生效还以为杀死了」） | 把 `handleDelete` 改成只弹 `message.error('MUTANT-ACTIVE：删除未执行')` 并 `return` | 点确认后 toast = `MUTANT-ACTIVE：删除未执行`、用例仍在（列表 1 行）、URL 不变 | 变异链路**已被证明生效** |
| R30 的悬空引用 | 真机：删掉供应商但 `defaultJudge` 仍指向它 | 「AI 生成」禁用 + 中文 Tooltip（第 7 项） | 与 `judge-gate.test.ts` 的变异体一致 |

## 5. 未覆盖项与理由

1. **真实模型供应商的成功生成**：本机没有可用的真实凭据，也不该为一次冒烟把密钥与额度打出去。用 `127.0.0.1:3099` 的假上游替代，走的是**同一条**真实链路（页面 → `POST /api/cases/generate-judge-prompt` → `api` 的 `generateJudgePrompt` → `resolveJudgeRoute` → `callTextApi` → 解析 → 回填）。真实上游的 401/429/超时分支由 `packages/server/evaluator/src/text-api.test.ts` 与 `api/src/judge.test.ts` 覆盖。
2. **维度预览「随生成结果变化」**：本期维度是契约固定的 5 维，且 `judge.ts` 要求模型**必须**覆盖全部 5 维（少了就 `JUDGE_PARSE_FAILED`），所以预览永远只可能是这 5 行——「变化」在这个契约下不可观测。缺维度/自造维度由 `judge.test.ts` 覆盖。
3. **`affectedRuns > 0` 的删除提示文案**：需要在 `{workspaceRoot}` 下先有一份真实 `run.json` 快照，那是评测域（p5）的产物；本次只走了 0 的分支（提示「用例已删除」）。`deleteCase` 的计数逻辑由 `api/src/cases.test.ts` 覆盖（含保存 run 快照后的计数）。
4. **窗口宽度自适应 / 分隔条几何 / 双击复位**：`ListDetailLayout` 自身的行为已在脚手架冒烟（`2026-09-22-scaffold-smoke.md`，含当时记录的 3 处待裁决）里量过；本任务只验证「切面板不改变栏宽」与「宽度偏好刷新后保持」。
5. **键盘 / 触摸操作分隔条、主题三档、`/runs` 与 `/settings` 的页面行为**：不属本任务范围（主题三档与设置页在 p1 的冒烟里覆盖）。
6. **确认框关闭时刻的精确时序**：`browser_evaluate` 里 `setTimeout(10/20ms)` 的实际采样间隔被页面重渲染拉到 ~80ms，无法分辨「立即关闭」与「请求返回后关闭」这 ~100ms 的窗口。因此第 9 项 / §4 的判据用的是**按钮 loading 状态**（正确实现必现、变异体必不现），而不是关闭时刻。若要精确测时序，应改用 Playwright 的 `page.on('request')` + 时间戳埋点。
7. **`/cases` 页本身没有自动化测试**（`apps/web-next` 保留 `jsx: preserve`、不能写 `.tsx` 测试）：页面的非平凡决策已抽成带 `.test.ts` 的纯助手（`src/repo-name.ts`、`src/judge-gate.ts`），其余靠这份冒烟 + 路由测试 + 面板测试三层兜住。

## 6. 控制台与 dev 日志卫生

- 干净加载 `/cases`（右栏关闭）：**0 条 error**（2 条：React DevTools 提示、`[HMR] connected`）。
- 干净加载 `/cases?panel=new`（右栏表单挂载）：**1 条 error** ——
  `Warning: [antd: Input] addonAfter is deprecated. Please use Space.Compact instead.`
  来自 `CaseFormPanel` 里「校验」按钮的 `addonAfter` 写法（p2 Task 5 的文件，已评审）。与脚手架冒烟里那条 `Alert.message is deprecated` 同类：**本任务不改已评审组件的实现**（T8 的义务是「不动物化组件的 props/实现，页面侧适配」），记在这里交给后续修复轮或 p6。
- 没有 hydration mismatch、没有 `act(...)` 警告、没有未捕获异常、没有 React 报错浮层（截图中左下角的 “1 Issue” 是 Next 16 dev 工具的角标，展开即上面那条 antd 弃用告警）。
- `/favicon.ico`：本次干净加载里浏览器**没有**请求它（脚手架冒烟记录的 404 仍存在，但与本任务无关）。
