# ai-result-evaluation 知识库

AI 生成代码评测平台的知识库：面向人与 AI 的唯一知识真源。五域导航见下方地图；三家厂商 FAQ 与 PowerShell / Playwright MCP 是持续追加的活文档，其余文章为按主题域组织的知识文章。

## 协议规范

智能体适配层的一切事实：Provider 抽象与 run 入口、消息规范、事件流、进程生命周期、新增 SDK 接入流程，以及 Claude Code / Codex / DSH 三家厂商各自的技术细节与横向对比。

*文章落地中——先见 FAQ 域的厂商台账。*

## 功能说明

平台按功能模块拆解的现时行为：用例管理（增删改查）、评测的创建与修改、评测详情与候选行、行执行与日志、评分、设置、数据与存储。

*文章落地中——《功能总览》目录层随后到位。*

## 架构设计

仓库与分包结构、依赖方向、分层规则、契约体系、界面原语与主题、工具链与命令聚合。

*文章落地中。*

## FAQ

三家厂商适配的运行期问题台账——现象标题照抄报错原文，拿报错一搜即命中：

- [Codex FAQ](/faq/codex) —— `@openai/codex` / `codex app-server`
- [Claude Code FAQ](/faq/claude-code) —— `@anthropic-ai/claude-agent-sdk`
- [DeepSeek Harness FAQ](/faq/deepseek-harness) —— `@deepseek-ai/dsh-sdk-client`

## 规约守卫

操作现场的硬规则与验证方法论：

- [PowerShell 安全](/guard/powershell) —— 自动变量禁令、递归删除守卫、编码坑
- [Playwright MCP](/guard/playwright-mcp) —— filename 路径规则与冒烟口径

*其余文章（冒烟测试方法论、变异验证、密钥与环境变量、测试策略与提速）落地中。*
