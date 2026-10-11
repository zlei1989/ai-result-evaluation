# is-09 冒烟记录（2026-10-11）

范围：用例「包含步骤」——新建用例开关、run 快照、文本评分通路、智能体评分通路、页面与磁盘互证；前置硬守卫：网关附件探针。

## 一、范围清单

| 项 | 结果 | 说明 |
|----|------|------|
| 网关附件探针（anthropic，defaultJudge） | ❌ FAIL（静默丢弃） | 200 但模型自述「消息里没有附件」；见 `probe/REPORT.md` |
| 网关附件探针（openai） | ❌ FAIL（404 + 显式 400） | 配置 baseUrl 缺 `/v1` → 生产路由 404；补打网关真实路由 → `content.type 取值范围 ['text'] (code: 1210)` |
| 附件形态启用判定 | ❌ 不得启用 | spec 硬守卫口径：探针不通过 = 评分附件形态不得启用。未做任何静默降级 |
| 3083 旧服务识别 | ✅ | 新建用例表单**无**「包含步骤」开关（旧代码、并行会话服务）；未杀、未动 |
| 3084 新实例（本 worktree 新代码） | ✅ | `pnpm --filter @aieval/web-next exec next dev -p 3084`（dev 脚本硬编码 3083，直接调 next） |
| 新建用例表单「包含步骤」开关 | ✅ | 位于评分标准项与来源类型之间，带 extra 说明，可开可关 |
| 用例创建 + includeSteps 落盘 | ✅ | `smoke-area/cases/52980873…json` 的 `includeSteps: true` |
| run #1 文本评分（useAgentJudge=false） | ✅ 跑通 | 执行（claude-code + GLM-5.3-Flash-A，1m37s）+ 文本评分（DeepSeek-V4.1-Flash-a，high）done |
| run #2 智能体评分（useAgentJudge=true） | ✅ 跑通 | 执行 + dsh 评委（DeepSeek Harness，2m09s）done |
| events.jsonl 内容进入**文本**评分上下文 | ❌ 真机不成立（网关侧） | 探针已证网关静默丢弃 document 附件；评委输入仅 400 tok（意图文本量级），diff 与 events.jsonl 都没被读到。评分结果看起来正常（100 分）但证据从未到达模型——正是探针要拦的「评分证据静默丢失」 |
| events.jsonl 进入**智能体**评委上下文 | ✅ 证据确凿 | 提示词含 events.jsonl 绝对路径；评委 Read 工具结果里是文件原文；R3 理由引用具体操作（Write 创建 poem.txt、git add/commit/status）；评委输入 21359 tok |
| 智能体评委读**工作区外**文件 | ✅ | events.jsonl 在行目录（cwd 的父目录），read-only 权限 + extraReadPaths 放行后评委 Read 成功 |
| 页面与磁盘互证 | ✅ | 两轮「已完成」、评分详情两套（文本 API / DeepSeek Harness）与 run.json 逐项一致 |
| 厂商智能体运行期问题 | 无 | 两轮执行与 dsh 评委均正常，无 FAQ 条目 |

## 二、操作路径

1. **读真实配置**：`loadConfig()`（`~/.aieval/config.json`）——defaultJudge=likecode-anthropic（anthropic 协议，DeepSeek-V4.1-Flash-a，effort=high）；另有 deepseek 供应商（openai 协议，GLM-5.3）。
2. **探针**：`node .scratch/include-steps/probe/attachment-gateway.mjs`——jiti 加载生产代码 `text-api.ts` 的 `callTextApiConversation`（附件块走生产 `wireContent` 翻译）+ `core` 的 `loadConfig()`，对两个协议各发一次最小附件请求（意图 text 块 + 附件块，附件里埋随机哨兵词），判据=模型复述哨兵词。结果 2/2 FAIL，退出码 1。
3. **环境适配（沙箱）**：本会话只允许写会话工作区，3084 直接读真实配置时写 `~/Workspaces/tmp/aieval-cases` 报 `EPERM`（用例保存 500）。因此起 3084 时用 `AIEVAL_CONFIG_DIR=.scratch/include-steps/smoke-config`：providers / defaultJudge / diffBudgetBytes **与真实配置一致**，仅 workspaceRoot / casesRoot 收进 `.scratch/include-steps/smoke-area/` 且 casesAutoCommit=false（冒烟区无远端）。该 config.json 含真实 apiKey（mode 0600，.scratch 被 gitignore），冒烟结束后已删除（见文末清理）。
4. **浏览器（3084）**：用例 → 创建用例 → 标题「is-09 冒烟：包含步骤」、题面「在仓库根目录创建一个 poem.txt 文件，写一首四行小诗《春》，然后把改动提交到 git。」、两组评分项（一、完成度：R1=poem.txt 四行小诗 40 分，R2=git 提交 30 分；二、过程证据：R3=events.jsonl 里有写文件或 git 操作 30 分）→ 开「包含步骤」→ 来源类型=无 → 确定。
5. **run #1**：评测 → 创建评测 → 选该用例、串行、候选 Claude Code + GLM-5.3-Flash-A、智能体评分**关** → 开始（弹窗确认）→ 等待 done。
6. **run #2**：同用例新建一轮，智能体评分**开**（评委=设置页默认的 DeepSeek Harness/dsh）→ 开始 → 等待 done。
7. **CLI 复核**：run.json、events.jsonl、judge-events.jsonl、judge-messages.jsonl、工作区 git log 与 poem.txt。

## 三、证据（浏览器 + CLI 互证）

- **探针**：`probe/REPORT.md`；探针 stdout：anthropic 项 FAIL（生产错误「响应里没有 type=text 的内容块」+ 原始响应里模型自述 `Current message has no attachment content… I only see user text, no file contents`）；openai 项 FAIL（生产 404 `Not found, POST /chat/completions` + 网关真实路由 400 `messages.content.type 参数非法，取值范围 ['text'] (code: 1210)`）。
- **用例磁盘**：`smoke-area/cases/52980873-edf9-4133-8be0-8a092cdc3200.json`：`"includeSteps": true`，rubric 三组项与表单一致。
- **run #1 磁盘**（`smoke-area/runs/f6e0dcfd-…/run.json`）：`status: done`，`includeSteps: true`，`useAgentJudge: false`；行 judged，score 100/100，judgeModelId=DeepSeek-V4.1-Flash-a，**judgeTokens.input=400**；`rows/…/events.jsonl` 48 行（status/vendor-system/log/usage/diff-summary/score/end）；workspace git log 两条提交、poem.txt 四行诗。
- **run #1 页面**：评测列表「已完成」；评分详情「评分智能体=文本 API、评分模型=DeepSeek-V4.1-Flash-a」，R3 达成，理由「events.jsonl 中记录到了创建文件与 git 提交等写文件和 git 操作。」——**注意**：探针已证该评委拿不到 events.jsonl（附件被网关丢弃、输入仅 400 tok），此理由系模型据题面推断，不构成「读到过程记录」的证据。这正是静默丢失的现场：分数满分、理由貌似有据，证据却从未到达模型。
- **run #2 磁盘**（`smoke-area/runs/79a844e6-…/run.json`）：`status: done`，`includeSteps: true`，`useAgentJudge: true`；行 judged，score 100/100，judgeAgentKind=dsh，judgeTokens.input=21359。
- **run #2 评委读取证据**：
  - `judge-events.jsonl` 的 inbox/spliced 提示词含段落「`…/rows/88665b86…/events.jsonl`：执行过程记录（events 账本：候选每一步的动作与工具调用）」+ 读取指引；
  - `judge-events.jsonl` 有 role=tool 的 Read 结果（callId `call_01_KEmpqPtMSfNxEnq2qtzr0446`），正文是 `<path>…/events.jsonl</path><type>file</type><content>1: {"seq":1,"at":…` ——**文件原文被读入**；
  - events.jsonl 位于行目录，在工作区 cwd（`…/workspace`）之外；评委工具清单含 `read`；read-only 权限 + extraReadPaths 放行生效；
  - R3 理由引用具体操作「events.jsonl 中记录了 Write 创建 poem.txt 以及多次 git add/commit/status 操作」。
- **run #2 页面**：评分详情「评分智能体=DeepSeek Harness」，R3 达成，理由与磁盘一致；总评与磁盘 verdict 一致。

## 四、未覆盖项与后续计划

1. **文本通路的「events.jsonl 进入评分上下文」真机端到端未达成（网关侧）**：当前网关（likecode-llm-proxy，两台：`-test` 与生产台都实测）不读 anthropic `document` 块、不接 openai `file` 块。按 spec 硬守卫：**评分附件形态不得启用**（未静默降级）。后续：网关侧支持附件块后重跑 `probe/attachment-gateway.mjs`，两协议 PASS 再启用；openai 侧另需把供应商 baseUrl 补 `/v1`（或网关在根路由兼容）。
2. **codex 候选双附件（messages.jsonl）未冒烟**：本票候选是 claude-code（只产 events.jsonl）。codex 候选的 messages.jsonl 附件块在文本通路有单测钉住，真机路径未覆盖。
3. **开关关闭的负例未冒烟**（includeSteps=false 时请求无证据块）：单测已覆盖（`judge.ts` / `text-api.ts`），真机未跑第三轮。
4. **冒烟区与真实配置的差异**：workspaceRoot / casesRoot 收进 `.scratch/include-steps/smoke-area/`（会话沙箱只允许写工作区）、casesAutoCommit=false；providers / defaultJudge / diffBudgetBytes 与真实配置一致。**3083 上的并行会话服务全程未动**。
5. **真机条件缺口**：无可用「读附件」的评分网关（见 1）——这是本票最大的真机缺口；执行与智能体评分两侧真机条件齐备（claude-code 候选、dsh 评委、likecode 网关纯文本调用均可用）。
6. **后续计划**：网关支持附件块后重跑探针（判据不变：哨兵词复述）→ 重跑本冒烟（重点补第 1 项的文本通路证据链）→ 补 codex 候选冒烟。

## 清理

- 冒烟结束后：`smoke-config/`（真实 config 的副本，含 apiKey）已删除——不留第二份明文密钥；`smoke-area/`（runs 与 cases，不含凭据）保留在 `.scratch` 下作为证据链，不提交。
- 3084 冒烟实例已停止；3083 未动。

---

# is-12 冒烟记录（2026-10-11）

范围：文本评分通路的「events.jsonl 证据真的到达评委」终态真机验证——开关开 / 关对照两轮 + 探针重跑（协议附件 wire 形状直打）。

## 一、范围清单

| 项 | 结果 | 说明 |
|----|------|------|
| 3084 新实例（本 worktree 终态代码） | ✅ | `AIEVAL_CONFIG_DIR=.scratch/include-steps/smoke-config pnpm --filter @aieval/web-next exec next dev -p 3084`；3083 并行会话服务未动 |
| 网关附件探针（改后：直打协议附件 wire 形状） | ✅ 工具可用，3/3 FAIL | anthropic×2 静默丢弃、openai 显式 400（code 1210）——与 REPORT/DIAGNOSIS 结论一致，复验工具成立 |
| 用例 A「包含步骤开」+ 用例 B「包含步骤关」 | ✅ | 落盘 includeSteps true / false，其余逐字相同（题面含哨兵 EVID-MARKER-8f3a29c1e04b，要求控制台输出） |
| run #1 文本评分（开关开） | ✅ | done；judgeTokens.input = **9593** tok；R3 达成，理由引用 events.jsonl 具体行（seq13 Write、seq18/21 git add/commit、seq24 提交输出、seq31/33 标记输出） |
| run #2 文本评分（开关关，对照） | ✅ | done；judgeTokens.input = **323** tok；R3 **未达成**，理由明说「本次提供的材料只有 candidate-diff.txt，未给出 events.jsonl 记录内容……故不能判定达成」 |
| 判据成立：开关开的输入显著大于对照 | ✅ | 9593 vs 323（约 30×）；且评委输出与证据内容对上（seq 级引用 + 哨兵原样）——文本通路证据块真的到达评委 |
| 页面与磁盘互证 | ✅ | 两轮「已完成」、评分详情 R3 达成/未达成与理由、run.json 逐项一致；workspace git log 与 poem.txt 落盘 |
| 厂商智能体运行期问题 | 无 | claude-code 候选与文本评委均正常，无 FAQ 条目 |

## 二、操作路径

1. **配置**：读真实 `~/.aieval/config.json`（defaultJudge=likecode-anthropic · DeepSeek-V4.1-Flash-a · effort=high；claude-code 候选用 GLM-5.3-Flash-A），复制到 `.scratch/include-steps/smoke-config/`（mode 0600，`.scratch` 被 gitignore），仅把 workspaceRoot / casesRoot 收进 `.scratch/include-steps/smoke-area/`、casesAutoCommit=false——providers / defaultJudge 与真实配置逐字一致。
2. **探针重跑**：`node .scratch/include-steps/probe/attachment-gateway.mjs`（本票已改为直打协议附件 wire 形状，不再经生产 wireContent）——3/3 FAIL、退出码 1，判据=哨兵词复述。
3. **浏览器（3084）**：创建用例 A（开开关）与用例 B（关开关，其余逐字相同）→ 各开一轮串行、候选 Claude Code + GLM-5.3-Flash-A、智能体评分**关**（文本评分）→ 开始（弹窗确认）→ 等待 done。
4. **CLI 复核**：run.json（judgeTokens / includeSteps / judgments）、两行 events.jsonl（各 39 / 52 行，哨兵各命中 4 次）、workspace git log 与 poem.txt。

## 三、证据（浏览器 + CLI 互证）

- **探针**：stdout 三条 FAIL——defaultJudge（anthropic/DeepSeek-V4.1-Flash-a）静默丢弃（模型自述 `But no attachment provided`）、deepseek（openai/GLM-5.3）显式 400（`messages.content.type 参数非法，取值范围 ['text'] (code: 1210)`）、官方 deepseek（anthropic/deepseek-flash）静默丢弃。
- **run #1（开）**：`smoke-area/runs/e7b4b1ca-…/run.json`：`status: done`、`includeSteps: true`、`useAgentJudge: false`；score 100/100，judgeModelId=DeepSeek-V4.1-Flash-a，**judgeTokens.input=9593**；R3 理由「events.jsonl 中 seq13 记录了 Write 工具创建 poem.txt、seq18/21 记录了 git add 与 git commit 命令及 seq24 的提交成功输出，seq31/33 的控制台输出中包含题面要求的标记『完成标记：EVID-MARKER-8f3a29c1e04b』」——seq 编号与哨兵都只能来自证据正文。页面评分详情与磁盘逐字一致。
- **run #2（关）**：`smoke-area/runs/15ff2904-…/run.json`：`includeSteps: false`；score 70/100，**judgeTokens.input=323**；R3 理由「本次提供的材料只有 candidate-diff.txt，未给出 events.jsonl 记录内容，无法引用其中……控制台输出 EVID-MARKER-8f3a29c1e04b 的具体记录，故不能判定达成」——对照轮的 events.jsonl 里哨兵其实命中 4 次（候选确实输出了），评委拒绝判定恰恰证明证据没到。页面评分详情与磁盘逐字一致。
- **对照成立**：9593 vs 323 tok（约 30×），同一题面、同一评委、仅开关不同——输入增量即 events.jsonl 文本块本身。

## 四、未覆盖项与后续计划

1. **codex 候选双附件（messages.jsonl）真机未覆盖**：本票候选是 claude-code（只产 events.jsonl）；codex 的 messages 第二块有单测钉住（`judge.test.ts` / `process-evidence.test.ts`），真机路径未跑。
2. **智能体通路未重跑**：is-09 已证智能体评委读磁盘原文（输入 21359 tok、Read 工具原文）；本票改动只动注释与标签表（提示词逐字不变，judge-agent 单测全绿），不重跑真机。
3. **截断日志（DEBUG）未做真机验证**：小预算截断场景单测钉住（`orchestrator-process-evidence.test.ts` 预算 300 字节用例），冒烟轮预算 262144 未触发截断；DEBUG 默认关闭，如需验真开 `AIEVAL_DEBUG=1`。
4. **后续计划**：网关支持协议附件块后，先重跑 `probe/attachment-gateway.mjs`（判据不变：哨兵复述，openai 侧另需 baseUrl 带 `/v1`），两协议 PASS 再考虑把 wireContent 的 text 块降级换回协议附件形态；届时补 codex 候选真机冒烟。

## 清理

- `smoke-config/`（真实 config 副本，含 apiKey）已删除——不留第二份明文密钥；`smoke-area/`（runs 与 cases，不含凭据）保留在 `.scratch` 下作为证据链，不提交。
- 3084 冒烟实例已停止；3083 未动。
