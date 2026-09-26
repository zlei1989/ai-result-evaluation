# 冒烟记录：模型清单独立成对话框（2026-09-30）

> 范围：把「模型清单」从「编辑供应商」弹窗里提成独立对话框，并在供应商列表每行的操作列加一个「模型」按钮
> （排在「编辑」之前）。改动落在 `provider-table.tsx` / `provider-form-modal.tsx` / **新增** `provider-models-modal.tsx`
> 与 `apps/web-next/app/settings/page.tsx` 的接线上。
> 环境：`pnpm dev`（:3083，Next dev 直接编译包源码，改动热生效）、真实网关 `https://api.deepseek.com`、
> 浏览器自动化走 Playwright MCP（几何一律读 `getBoundingClientRect()`，不靠截图）。

## ① 范围清单

| # | 断言 | 结果 | 证据 |
|---|---|---|---|
| 1 | 列表操作列有三颗按钮，顺序 **模型 → 编辑 → 删除** | ✅ | 浏览器读 DOM：三颗按钮文本依次为 `模型`/`编辑`/`删除`；两个供应商行都是 43.6×24，可访问名逐字等于文案（`autoInsertSpace={false}` 生效） |
| 2 | 操作列装得下三颗按钮（不换行、不溢出） | ✅ | 单元格 **200px**、内容 184px、三颗按钮 43.6×3 + 间距 8×2 = 146.8px ⇒ `scrollWidth === clientWidth`（**无溢出**），余量 37px |
| 3 | 点「模型」打开清单对话框：标题带供应商名、宽度 720、页脚只有「关闭」 | ✅ | 实测 `模型清单：deepseek-anthropic` / 宽 **720** / 页脚按钮 `["关闭"]` / 表内 2 行模型、来源列 `自动拉取`、两格输入 = `1048576`、`393216`；`colgroup` 宽度 = `["", "88px", "116px", "116px", "72px"]`（与常量一致） |
| 4 | 对话框里的「拉取模型」真的打到上游 | ✅ | 点按钮后无 `message.error`；`GET /api/providers` 的 `updatedAt` 从 `11:09:50Z` 变成 **`11:29:24Z`**（= 点击那一刻），模型仍是 2 条（合并语义） |
| 5 | 「编辑」弹窗里**没有**模型清单，但有可见去向 | ✅ | 实测该弹窗：宽 **560**、字段只有 名称/协议类型/API 地址/API 密钥、`.ant-table` 计数 **0**、`[aria-label="拉取模型"]` 计数 **0**；Alert 文案 `模型清单在列表的「模型」按钮里维护` + `拉取模型、手工增删、窗口与输出上限都在那个对话框里；这里只改名称、协议类型、API 地址与密钥。` |
| 6 | 关掉对话框后页面无残留浮层 | ✅ | 点「关闭」后 `Escape`：可见的 `.ant-modal-wrap` 计数 **0**，列表仍是 2 行 |
| 7 | 控制台无新增报错 | ✅ | 唯一一条 error 是 `GET /favicon.ico` **404**（既有，与本次改动无关） |

## ② 操作路径

1. `browser_navigate` → `http://localhost:3083/settings`；点 Tab **模型供应商**。
2. `browser_evaluate` 读两行操作列：每颗按钮的 `getBoundingClientRect()` 与单元格的 `scrollWidth/clientWidth`（第 1、2 项）。
3. 点第 2 行（`deepseek-anthropic`）的 **模型** → 读对话框标题、宽度、页脚按钮、表格行与 `colgroup` 宽度（第 3 项）。
4. 点对话框里的 **拉取模型** → 读 `message` 区域（空 = 无报错），再用 `curl /api/providers` 复核 `updatedAt` 变化（第 4 项）。
5. 点 **关闭**；点同一行的 **编辑** → 读弹窗宽度、字段标签、是否存在表格与拉取按钮、Alert 文案（第 5 项）。
6. 点 **取消**（编辑弹窗）+ `Escape` → 复核无可见浮层（第 6 项）。

## ③ 证据（浏览器 + CLI 互证）

- 浏览器侧：上面每一项的实测值都写在 ① 的「证据」列（几何是 `getBoundingClientRect()` 的原始读数）。
- CLI 侧（上游真往返的独立证据）：

```text
$ curl.exe -s http://localhost:3083/api/providers
… "name":"deepseek-anthropic","protocolType":"anthropic","baseUrl":"https://api.deepseek.com/anthropic",
   "updatedAt":"2026-09-30T11:29:24.218Z" …   # 点击前是 11:09:50.067Z ⇒ 对话框里的「拉取模型」确实打了上游
```

- 单测侧（同一条口径的四组守卫，均做过变异验证）：`provider-table.test.tsx`（按钮回调 + DOM 顺序）、
  `provider-models-modal.test.tsx`（21 条：外框 / 目标消失 / 草稿重置 / 列宽 / 表格语义）、
  `provider-form-modal.test.tsx`（清单不在这里 + 两态去向文案 + 宽度 560）。
  变异记录：去掉「模型」按钮 → 表 2 红；去掉编辑态指路 Alert → 表单 1 红；去掉草稿重置与目标消失分支 → 对话框 2 红；三次还原后文件哈希逐字节一致。

## ④ 未覆盖项与后续

1. **手工添加 / 移除 / 逐条保存窗口**这次没有在浏览器里点（避免动用户配置）：它们由
   `provider-models-modal.test.tsx` 的 21 条用例覆盖（含 `null`=清空 与「没碰过」两种语义）。要补真机往返的话，
   造一个临时供应商再删掉即可，不需要动现有两条。
2. **「模型」与「编辑」两个对话框的互斥**在**鼠标路径上不可达**：一个弹窗开着时遮罩会挡住列表里的另一颗按钮
   （实测点击超时，报 `ant-modal-wrap intercepts pointer events`）。`openModels` 里那句「关掉编辑弹窗」因此是
   防御性的，本轮的证据只到「代码里写了、鼠标下不触发」；键盘 / 触屏路径同样没走到。
3. **暗色主题**下的新对话框未单独验：它没有任何硬写颜色（Tag 用 antd 预设色、Alert 用语义类型），
   风险低，但按「适配 light / dark」的口径登记为未覆盖。
4. **窄屏**（< 900px）下 200px 的操作列与 720px 的对话框没有量过；本仓的布局是弹性卡片，
   真要收窄得再量一次几何。
