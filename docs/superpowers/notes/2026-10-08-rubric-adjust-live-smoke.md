# 冒烟记录：「智能调整」全链路（2026-10-08）

> 目标页：`http://localhost:3083/cases`（编辑态 `?panel=edit&id=…`、新建态 `?panel=new`）
> 用户口径（2026-10-08，逐字）：「智能识别：增加对现有评分修改的功能，通过提示词微调现有的标准」；
> 四轮拍板补充口径：增/改/删都行**但先给改动清单确认**、**新加第三个按钮**、**模型回整表 + 服务端算差分**、
> **三段式配对**；收尾两轮拍板：授权停 dev 修依赖 + 跑真实调用（先后批了 **2 次**文本调用额度）。
> **只记实测值**；读不出来的写「未覆盖 + 原因」，不写「看起来正常」。

## 1. 本轮改了什么（已提交 `fd5f129`，额度修复 `98cf582`）

| # | 改动 | 落点 |
|---|---|---|
| 1 | 契约：`mode` 必填三值（generate / recognize / adjust），`GenerateRubricResult` 收进 contracts，新增 `changes?: RubricChange[]` | `packages/server/contracts/src/{case,rubric,index}.ts` |
| 2 | `diffRubric(before, after)` 纯函数：七类改动 + 三段式配对（① 有 id 按 id ② goal 逐字相同 ③ 按组内位置）；组配对三轮（同位置同名 → 按名字一对一 → 按位置） | `packages/server/contracts/src/rubric.ts` |
| 3 | api：adjust 分支在**调模型之前**校验空表 / 空指令（不花额度）；`parseGenerated` 空表判据扩到三支 | `packages/server/api/src/judge.ts` |
| 4 | ui：第三个按钮「智能调整」+ 弹窗 `RubricAdjustModal`（输入 → 预览清单 → **点应用才回写**） | `packages/client/ui/src/composite/rubric-adjust-modal.tsx`、`case-form-panel.tsx` |
| 5 | 文本调用输出上限 4096 → 16384（真实调用实测被截断，见 §3 的 C1） | `packages/server/evaluator/src/text-api.ts` |

## 2. 范围清单

| 项 | 判定 | 关键实测值 |
|---|---|---|
| 三个按钮都在（编辑态） | ✅ | `智能生成 / 智能识别 / 智能调整`，`disabled: false`（14 项的真实标准表在场） |
| 空要求时「生成改动」禁用 | ✅ | `submitDisabledWhenEmpty: true`；写入「把 A1 的权重提到 30」后 `disabled: false` |
| 取消 = 弹窗关、表格未动 | ✅ | `dialogClosedAfterCancel: true`，无任何写回 |
| **B 段：空表点调整 → 服务端当场拒、不花额度** | ✅ | dev 日志 `POST …/generate-judge-prompt 400 in 4ms`；body = `{"error":{"code":"INVALID_QUERY","message":"当前评分标准项是空的，没有可以调整的内容：请先用「智能生成」起草一份，或改用「智能识别」粘贴一份标准"，…}}` **逐字命中** |
| B 段：拒绝后弹窗不关、文本保留、无清单 | ✅ | `dialogOpen: true`、`textPreserved: "把 A1 的权重提到 30"`、`noChangesList: true`；错误提示渲染在 antd 6 的 `.ant-message-notice-error .ant-message-notice-title`（见 §4 的探针教训） |
| **C 段（第 1 次真实调用）：模型照办但被 4096 截断** | ⚠️→已修 | dev 日志：`POST … 500 in 8.3s`，`JUDGE_PARSE_FAILED`；错误原文里模型回显的 `html-doc` 权重**已经是 25**（照办了），JSON 在「cdn-vue3」一项中途断掉 → `98cf582` 把 `MAX_TOKENS` 4096 → 16384 |
| **C 段（第 2 次真实调用）：happy path 全通** | ✅ | dev 日志 `POST … 200 in 19.9s`；清单**恰好一条**：`改权重 · 一、HTML 基础结构 · html-doc · 产出完整、独立的 HTML 文档：… · 权重 7 → 25`；**应用前**表格仍 `7`（`weightStillOldBeforeApply: "7"`，真机版「不点应用不回写」）；点应用 → 弹窗关闭（关闭动作只在 `handleAdjustApply` 里发生，同一函数先 `setFieldValue('rubric', 新表)` ⇒ 表单已写入 25） |
| 全程不落盘 | ✅ | 两轮冒烟都没点「保存」；`GET /api/cases` 复读：该用例 rubric 的 `html-doc` 权重仍是 7（第 1 项 `editRubricItemGoals: 14` 与盘上一致） |
| 门禁 | ✅ | 全链 tsc 0（改动面内）、eslint 0（单文件核）；`text-api` 46 条、`rubric-diff` 14 条、`judge-adjust` 8 条、`rubric-adjust-modal` 10 条、契约 mode 守卫 1 条全绿 |

## 3. 守卫与变异验证

新增 32 条测试（+ mode 必填守卫）。**跨三层八个变异**逐个做、逐个还原，各自红在**对应**断言上：

| 变异（把缺陷做回去） | 层 | 红在哪条 |
|---|---|---|
| ① 预览即回写（拿到结果就 `onApply`） | ui | 「`onApply` 一次都不许被调用」等 3 条（头号守卫：它防的是「用户看清单时表格已被换掉」） |
| ② 去掉在途取消的代次门 | ui | 「在途取消 ⇒ 回来的结果作废」 |
| ③ 空要求放行 | ui | 「空要求禁用（一次调用是真的钱）」 |
| ④ 拿掉空表门 | api | 「空表 ⇒ 当场拒绝且一次模型调用都不花」 |
| ⑤ 拿掉空指令门 | api | 同上的指令姊妹条 |
| ⑥ 空表只在识别分支被拒 | api | 「模型把标准删空 ⇒ JUDGE_PARSE_FAILED」 |
| ⑦ 去掉「按目标文字」配对段 | contracts | 「中间插一项不产生位移假象」 |
| ⑧ 去掉「按名字一对一」组配对轮 | contracts | 「顺序对调 ⇒ 空清单」 |

还原后三个文件 SHA256 与基线**逐字节相同**；`pnpm test` 全量 3062 passed。

## 4. 过程里的三个环境事实（其中两个坑过我，值得留档）

1. **antd 6 的 message 类名变了**：错误文本渲染在 `.ant-message-notice-title`（外层 `.ant-message-notice-error`），
   antd 5 的 `.ant-message-notice-content` 不存在。我的探针拿旧类名去等 → 等 30 秒空手而归，一度把「提示其实已逐字命中」
   误判成「前端没提示」。凡要断言 message 的脚本先 dump `[class*="message"]` 再定探针。
2. **本机 node_modules 曾落后于已提交的 lockfile**：`agents/node_modules/@anthropic-ai/` 链接缺失 ⇒ dev 编译
   `/api/cases/generate-judge-prompt` 直接 500（`Can't resolve '@anthropic-ai/claude-agent-sdk'`）——这是 C 段第一轮
   「看起来全没反应」的真因之一。授权后停 dev → `pnpm install --frozen-lockfile`（4m0s）→ 三家厂商 SDK 链接齐全。
   install 顺带把另一处旧账带出来：tsc 多了 3 条错，**全部落在并行开发的 run-events / run-signals 新文件里**，
   与本功能无关（stash 到 HEAD 干净态复跑确认）。
3. **dev server 必须能写工作区根之外**：我在受限沙箱里重启过 dev，导致 `/runs` 的「重试 / 重评分」全 500
   （`EPERM` 写不了 `/Users/zhanglei1120/Workspaces/tmp/aieval/.runs/...`）。放开权限重启后 `POST rescore ⇒ 200` 复通。
   以后替用户重启 dev 一律用完整权限（评测落盘全在工作区根外）。

## 5. 未覆盖项与后续

- **「应用之后点保存」没走**：两轮真实调用都刻意不点保存（改动只活在表单内存）。保存链路是既有功能，
  由 `case-form-panel` 的提交守卫与路由测试背着，本轮没有理由再花一次额度去碰它。
- **删项 / 增项 / 改组名 / 空指令在真机上未复现**：清单只实测了「改权重」一类；其余类的服务端行为由
  `rubric-diff`（14 条）与 `judge-adjust`（8 条）钉着，UI 侧由弹窗组件测试钉着。要真机看全得再花调用，未批。
- **「模型认为不需要修改」的空清单路径**：`changes === []` ⇒ 显示说明、`应用改动` 禁用——jsdom 已钉，
  真机未走到（两次真实调用都产生了改动）。
- **`D:/tmp/rows/row-1/.agenthome` 落在仓库根**：跑全量测试时某用例把 Windows 路径当相对路径建出来的
  （`D:\tmp\rows\row-1` 是夹具里的 workspaceRoot）。按仓库口径**没有删**，留给用户处置；值得给那个用例补一条
  「测试里路径必须落在临时目录」的守卫，属另一件事。
