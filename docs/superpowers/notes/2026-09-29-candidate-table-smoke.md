# 候选行表格化 + 操作列图标按钮（删除 / 上移 / 下移）—— 冒烟与关账记录（2026-09-29，真机）

> 用户口径（2026-09-29，逐字）：
>   一稿：`[DOM39] 改成 smail table 组件`、`[删除][DOM40] 改成图标按钮 button link 节省空间，在列中右对齐`
>   二稿：`操作列删除"操作"列名标签保持空白。增加上移/下移按钮。顺序是上移/下移/删除`
> 改动：`packages/client/ui/src/composite/run-create-panel.tsx`（候选行 `Flex` 布局 → small `Table`；
>      操作列 → 无标题、右对齐、上移 / 下移 / 删除 三个图标 link 按钮）
> 设计同步：`docs/superpowers/specs/2026-09-28-agent-context-window-design.md` §7 第 6 条
> 测试：`packages/client/ui/src/composite/run-create-panel.test.tsx`（5 条形态/行为守卫，逐条做过变异验证）

## ① 范围清单

| # | 验收项（用户口径） | 状态 | 证据 |
|---|---|---|---|
| 1 | 候选行改成 small table | ✅ | 真机几何（一稿两个候选时）：表头 `智能体 ｜ 模型 ｜ 思考强度 ｜ 操作`，列宽 **130 / 362 / 120 / 48**；`.ant-table-small`；无横向溢出（`scrollWidth == clientWidth`）；守卫 `C-TABLE` |
| 2 | 删除改成图标按钮（button link） | ✅ | 真机：`<button aria-label="删除" class="ant-btn-color-dangerous ant-btn-variant-link ant-btn-icon-only ant-btn-sm">`，`textContent === ''`，21×21px；悬停出 `ant-tooltip` 文案「删除」；守卫 `C-DELETE-ICON` |
| 3 | 在列中右对齐 | ✅ | 真机：操作列 th/td 计算样式 `text-align: right`（antd 的列级 `align` 落到单元格内联样式上），删除按钮右边距单元格右边 **4px**；且它确在**最后一列** |
| 4 | 省空间 | ✅ | 同一轮**两个候选**这一块的高度：改前 **164.27px**（元素快照 DOM39 的 `boundingRect`）→ 改后 **91px**（thead 29 + tbody 62），**-44%**；行高 30-31px、单个图标按钮 21px |
| 5 | 图标按钮与下拉同一水平线 | ✅ | 真机：`btnCenterY == firstSelectCenterY`（一稿两行 311/311、342/342；二稿 310/310）——不再需要「空标签 Form.Item 撑标签行」那套对齐补丁 |
| 6 | 删除删的是**点的那一行** | ✅ | 真机：点第二行 → 只剩第一行（`jd/GLM-5.3`，`JoyAI-Code-1.6` 消失）；守卫 `C-ROW-REMOVE`（变异 M3 已验） |
| 7 | 删光最后一行不出现英文空态 | ✅ | 真机：占位文案「还没有候选：点下面的「添加候选」加一行」，`form.innerText.includes('No data') === false` |
| 8 | 「添加候选」仍然加一行空白候选 | ✅ | 真机：新行 = `Claude Code` + 占位「选择模型」+「默认」，操作列 3 个按钮 |
| 9 | 表格化没有弄坏三个下拉 | ✅ | 真机：模型下拉开出 **10 个选项**（带来源/窗口 Tag），下拉宽 = 单元格宽减内边距；选 `jd/GLM-5.3` 后强度下拉列出 **low / high（推荐）/ max**（服务端交集原样可用）；`aria-label` 在真机 a11y 树里就是 `combobox "模型"`，且带 `aria-required="true"` |
| 10 | 三绿 | ✅ | `pnpm typecheck` exit 0、`pnpm lint` exit 0；`ui` 包 **394 用例 / 34 文件全绿**（一稿时点）；本文件 **45 用例全绿**（二稿） |
| 11 | 每条新守卫都做过变异验证 | ✅ | 见 §③ 表：M1 / M2 / M3 / M5 / M6 / M7 / M8 / M9 / M10 / M11 / M12 / M13 都让对应守卫**失败**；**M4 反而全绿** ⇒ 那条断言没有区分力，已删除并写进用例注释 |
| 12 | **二稿**：操作列列名留空 | ✅ | 真机：`thead th` 第四个 `textContent === ''`，宽 80、`text-align: right`；守卫 `C-TABLE`（列头断言）+ `C-ROW-ACTIONS`；变异 M8 |
| 13 | **二稿**：上移 / 下移 按钮，顺序 上移 / 下移 / 删除 | ✅ | 真机：一行里三个 `ant-btn-icon-only`，`aria-label` 依次 `上移 / 下移 / 删除`（各自 21×21、`textContent === ''`，上移下移是 default link、删除是 danger link）；守卫 `C-ROW-ACTIONS`；变异 M9（顺序）与 M12（文字） |
| 14 | **二稿**：换位真的换顺序（且是提交出去的顺序） | ✅ | 真机：第一行选 `jd/glm-5.2` → 点它的下移 → 该模型落到第二行、第一行变回占位符；再点第二行上移 → 换回来。组件层另钉**提交载荷**的行序（守卫 `C-ROW-MOVE`；变异 M10 方向、M13 提交时反转） |
| 15 | **二稿**：边界置灰 | ✅ | 真机：单行时上移与下移都 disabled；两行时第一行 `上移(disabled)`、第二行 `下移(disabled)`，换位后置灰跟着行序走；守卫 `C-ROW-MOVE`；变异 M11 |


## ② 操作路径（真机 :3083，Playwright）

1. 直开编辑面板 `http://localhost:3083/runs?panel=edit&id=3d690aa3-…`（该轮两个候选：`jd/GLM-5.3`、`JoyAI-Code-1.6`），量表格/按钮几何。
2. 点**第二行**的删除图标 → 复核只剩第一行（未点「确定」，不动真数据）。
3. 再删掉剩下那一行 → 复核中文空态。
4. 点「添加候选」→ 复核新行是空白候选（`Claude Code` + 「选择模型」）。
5. 悬停删除图标 → 复核 Tooltip「删除」。
6. 冒烟中途那一轮被**别处删掉**（`GET /api/runs/3d690aa3-…` 返回 404），于是改用「创建评测」按钮打开 `?panel=new` 复核下拉链路：开模型下拉 → 选 `jd/GLM-5.3` → 开强度下拉（交集三档）。
7. **二稿（同一面板，`?panel=new`）**：量操作列几何（表头第四个 `textContent`、三按钮 `aria-label` 顺序、尺寸、与下拉的中心线）→ 点「添加候选」造第二行 → 复核边界置灰 → 第一行选 `jd/glm-5.2` → 点它的**下移** → 复核模型落到第二行 → 点第二行的**上移** → 复核换回来（两次都没点「确定」，不产生真数据）。

## ③ 证据（原始输出片段）

```text
# 几何（编辑面板，两个候选；改前同一元素由元素快照给出）
改前：DOM39 boundingRect.height = 164.27   （Flex 竖排：每行「标签行 + 控件行」）
改后：tableWrapperHeight = 91 = thead 29 + tbody 62；行高 31
表头：智能体 130 / 模型 362 / 思考强度 120 / 操作 48(right)     ← 一稿（列名「操作」）
单元格：130 / 362 / 120 / 48；下拉宽 122 / 354 / 112；横向溢出 0
删除按钮：textContent ""、aria-label "删除"、类 ant-btn-color-dangerous ant-btn-variant-link ant-btn-icon-only
         尺寸 21×21；单元格右边缘 - 按钮右边缘 = 4px；与两个下拉的中心线一致（311/311、342/342）
悬停：button.ant-tooltip-open + .ant-tooltip「删除」
空态：.ant-table-placeholder = 「还没有候选：点下面的「添加候选」加一行」
新建态：模型下拉 10 个选项；强度下拉 ['low','high（推荐）','max']
a11y：combobox "模型"（input#rows_0_modelKey[aria-label=模型][aria-required=true]）

# 二稿：操作列（?panel=new，单行 → 两行）
表头：[智能体 130, 模型 330, 思考强度 120, "" 80(right)]      ← 第四列列名是空串
单元格：[130, 330, 120, 80]；operation cell text-align: right
三按钮（同一行、右对齐、中心线 310 == 第一个下拉的 310）：
  上移  textContent ""  disabled=true   21×21  ant-btn-color-default ant-btn-variant-link ant-btn-icon-only
  下移  textContent ""  disabled=true   21×21  ant-btn-color-default ant-btn-variant-link ant-btn-icon-only
  删除  textContent ""  disabled=false  21×21  ant-btn-color-dangerous ant-btn-variant-link ant-btn-icon-only
  右边缘距单元格右边：删除 4px、下移 27px、上移 50px（= 21 + 间距 2）
两行时的置灰：row0 [上移(disabled), 下移, 删除]；row1 [上移, 下移(disabled), 删除]
换位：row0 选 jd/glm-5.2 → 点 row0 下移 → modelCells = ["选择模型", "jd/glm-5.2自动拉取1.05M"]，置灰跟着走
      → 点 row1 上移 → modelCells = ["jd/glm-5.2自动拉取1.05M", "选择模型"]

# 变异验证（把缺陷人为造回去 ⇒ 守卫必须失败；还原后用 SHA256 核对文件未变）
一稿：
M1 列级 align: right -> left      ⇒ FAIL  AssertionError: expected 'left' to be 'right'
M2 图标按钮改回文字按钮「删除」    ⇒ FAIL  AssertionError: expected '删除' to be ''
M3 remove(row.field.name) -> remove(0) ⇒ FAIL  expected 'p-anthropic::claude-haiku' to contain 'claude-opus-4-6'
M4 表格 size="small" 去掉          ⇒ PASS（**没拦住**：紧凑密度由外层 <Form size="small"> 经 size context 传下来）
                                      ⇒ 该断言无区分力，已换成「表格内不许有 .ant-form-item-label」
M5 模型下拉 aria-label 去掉        ⇒ FAIL  Unable to find a label with the text of: 模型
M6 模型格退回带 label 的写法       ⇒ FAIL  expected <div><label></label></div> to have a length of 0
M7 列头「操作」改名               ⇒ FAIL  expected ['智能体','模型','思考强度','删除'] to deeply equal [...]
二稿：
M8 操作列列名写回「操作」          ⇒ FAIL  expected ['智能体','模型','思考强度','操作'] to deeply equal [..., '']
M9 删除按钮排到下移之前            ⇒ FAIL  expected ['上移','删除','下移'] to deeply equal ['上移','下移','删除']
M10 下移写成 move(name, name - 1)  ⇒ FAIL  expected 'claude-opus-4-6手工维护未知' to contain 'claude-haiku'
M11 上移不再在首行置灰             ⇒ FAIL  expect(element).toBeDisabled() / Received element is not disabled
M12 上移按钮里塞回文字             ⇒ FAIL  expected ['上移','',''] to deeply equal ['','','']
M13 提交时把行序反转               ⇒ FAIL  expected ['claude-opus-4-6','claude-haiku'] to deeply equal ['claude-haiku','claude-opus-4-6']
restore check: before == after（一稿 SHA256 7DB53107…D5A00；二稿 44825252…C9AE33）same=True

# 三绿
pnpm typecheck → exit 0（无输出）
pnpm lint      → exit 0（无输出）
pnpm vitest run packages/client/ui → Test Files 34 passed (34) / Tests 394 passed (394)   ← 一稿时点
pnpm vitest run …/run-create-panel.test.tsx → 二稿 Test Files 1 passed (1) / Tests 45 passed (45)
```

## ④ 未覆盖项与后续

1. **保存（PUT）没有在真机上点过**：冒烟只到「改表单」这一步，没有点「确定」——那些轮次是真实数据，其中一轮还中途被别处删除（404）。
   载荷形状（`id` / `effort` 原样回传、全量替换、**换位后的行序**）由 `run-create-panel.test.tsx` 的编辑模式用例
   （`C-ROW-MOVE` 直接断言 `onSubmit` 收到的行序）与 `apps/web-next` 的路由测试覆盖。
2. **换位不重置任何行**：行 id 与「智能体 / 供应商 / 模型 / 强度」都没变，故 `invalidatedRows` 判它「什么都不作废」、
   保存前不弹确认框——这是刻意的（换位没让任何一行变成另一件事）。真机上只验到「确认框不弹」这一步没走（没点确定），
   组件层由 `C-ROW-MOVE` 的提交断言与编辑模式的既有用例覆盖。
3. **深色主题没有单独看一眼**：新表格用的都是 antd 组件与语义色（`variant="link"`、default 与 danger 两色），没有手写颜色；
   但「暗色下三个图标与置灰态的对比度」没有实测截图。
4. **窄栏（拖分隔条到很窄）没有实测**：表格是 `table-layout: auto`、模型列不给宽度，理论上会先压模型列；
   默认宽度（676px 右栏）下无横向溢出，操作列 80px 已按三个按钮量过。若将来出现撑破，
   处置同「模型清单」那套（显式列宽 + `ellipsis`）。
5. **全量 `pnpm test` 没跑**（分钟级门禁，本仓已知有环境类红）：本次只跑了 `ui` 包全量（一稿时点 394 用例）
   + 本文件全量（二稿 45 用例）+ 仓库级 `typecheck` / `lint`。
