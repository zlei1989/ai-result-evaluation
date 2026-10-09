# 设置

## 定位

设置页承载平台级的全部配置：模型供应商、评分配置、工作区、界面主题。onChange 自动保存、无保存按钮；配置落盘位置与原子写口径见《数据与存储》。

## 页面形态与交互

- **模型供应商**：每家供应商一行（名称 / 协议类型 / API 地址 / 模型数 / 操作）。协议类型（`openai` / `anthropic`）决定该供应商能被哪些智能体消费——判据是 `acceptsProtocol(metadata, protocolType)` 集合判定（协议是供应商的属性、集合是智能体的能力，两者不混）。「模型清单」独立成对话框查看与刷新该供应商的模型列表。供应商表格窄卡片时**名称列左悬浮 / 操作列右悬浮**。新增 / 编辑供应商时协议不兼容的智能体项 `disabled`。
- **评分配置**：默认评分模型（跨协议候选，按当前评分智能体过滤）、思考强度（`allowClear`，清空 = 未指定；候选域 = 当前模型与当前评分智能体两个档位域的交集，后端 `intersectEfforts` 同一把尺）、默认评分智能体、输出契约（只读两段文案——提示词契约与 schema 契约的投影）、diff 上限（KB 计，配置存字节，默认 256）。
- **工作区**：评测落盘的根目录，默认 `~/.aieval-runs`（可改）。
- **界面主题**：`light` / `dark` / `auto` 三档。

## 数据与契约

- 配置文件：`AIEVAL_CONFIG_DIR` > `~/.aieval`（详见《数据与存储》的原子写与 BOM 口径）。
- 档位域真机（`GET /api/runs/model-options` 的 `efforts`）：claude `["off","low","medium","high","xhigh","max"]`、codex `["off","minimal","low","medium","high","xhigh","max","ultra","persistent"]`、dsh `["off","low","high","max"]`。上游未声明时给「该家完整域 + 关闭档恒含且排第一」。关闭档文案「`off（要求不思考）`」——是「要求」不是断言（codex 选 off 并不会真的停止思考）。
- `judgeEffort` 落盘语义：记「我们要求的」档位，不是「实际生效的」。
- 供应商的 `protocolType` 是单值（协议是供应商的属性）；智能体的 `protocolTypes` 是集合（能力）。

## 状态机与时序

评分配置的消费点：`resolveJudgeRoute()`（评分路由）+ `resolveJudgeEffort()`（档位交集）在评分阶段取**同一份 config 快照**（几次读之间无 `await`）；协议不匹配的拒绝文案是共用的 `protocolMismatchMessage()`（列出该家接受的集合）。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| `loadConfig` 不做 zod 校验、不 strip 未知字段 | 手改 `config.json` 写坏 kind 时由调用方判 `AGENT_KINDS` 枚举兜住（`getProvider` 抛裸 Error 无 HTTP 语义） |
| 三个评分生成动作（智能生成 / 识别 / 调整）只用设置页全局默认、不带模型 id 入参 | 未配置默认评分模型 ⇒ 三个按钮禁用 + Tooltip |
| effort 档位强度的效力未证实（同档抖动不小于档间差） | 界面只展示「我们要求的档位」，不给「高档=更准」暗示 |

## 相关链接

- 知识文章：[《评分》](/features/judging)（评分配置格的消费侧）、《数据与存储》（配置落盘）、《功能总览》（目录层）
- 仓库内参考：AGENTS.md「持久化」节（原子写与 BOM 口径的真源）
