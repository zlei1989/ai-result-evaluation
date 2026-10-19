# ai-result-evaluation 知识库

AI 生成代码评测平台的知识库：面向人与 AI 的唯一知识真源。五域地图如下；四家厂商 FAQ 与 PowerShell / Playwright MCP 是持续追加的活文档，其余文章按主题域组织、只写终态。写作与关账口径见[《知识库口径》](/guard/knowledge-base)。

## 协议规范

智能体适配层的一切事实：Provider 抽象与 run 入口、消息规范、事件流、进程生命周期、新增 SDK 接入流程，以及四家厂商各自的技术细节与横向对比。

- [Provider 抽象与 run 入口](/protocols/provider-run)
- [消息规范](/protocols/message-spec)
- [事件流](/protocols/event-stream)
- [进程生命周期](/protocols/process-lifecycle)
- [新增 SDK 接入流程](/protocols/sdk-onboarding)
- [Claude Code 接入](/protocols/cc)、[Codex 接入](/protocols/codex)、[DeepSeek Harness 接入](/protocols/dsh)、[Pi Coding Agent 接入](/protocols/pi)
- [四家横向对比](/protocols/comparison)

## 功能说明

平台按功能模块拆解的现时行为；目录层是[《功能总览》](/features/)。

- [功能总览](/features/)
- [用例管理](/features/case-management)
- [创建评测](/features/run-creation)
- [修改、重跑与删除评测](/features/run-edit-rerun-delete)
- [评测详情与候选行](/features/run-detail)
- [行执行与日志](/features/row-execution)
- [提问与应答](/features/ask-user-answer)
- [评分](/features/judging)
- [设置](/features/settings)
- [MCP 配置](/features/mcp-config)
- [技能配置](/features/skills-config)
- [数据与存储](/features/storage)

## 架构设计

仓库与分包结构、依赖方向、契约体系、界面原语与主题、工具链与命令聚合。

- [仓库分层与依赖方向](/architecture/layering)
- [契约体系](/architecture/contracts)
- [界面原语与主题](/architecture/ui-primitives-and-theme)
- [工具链与命令聚合](/architecture/toolchain)

## FAQ

四家厂商适配的运行期问题台账——现象标题照抄报错原文，拿报错一搜即命中。目录层[《故障索引》](/faq/)收录全部现象条目；格式与维护规矩见该页「维护口径」。

- [故障索引](/faq/)
- [Codex FAQ](/faq/codex) —— `@openai/codex` / `codex app-server`
- [Claude Code FAQ](/faq/claude-code) —— `@anthropic-ai/claude-agent-sdk`
- [DeepSeek Harness FAQ](/faq/deepseek-harness) —— `@deepseek-ai/dsh-sdk-client`
- [Pi Coding Agent FAQ](/faq/pi) —— `@earendil-works/pi-coding-agent`

## 规约守卫

操作现场的硬规则与验证方法论：

- [PowerShell](/guard/powershell) —— 自动变量禁令、递归删除守卫、编码坑
- [Playwright MCP](/guard/playwright-mcp) —— `filename` 路径规则与几何断言
- [冒烟测试方法论](/guard/smoke-testing) —— 真机验证、四要素记录、红绿判据
- [变异验证](/guard/mutation-verification) —— 守卫必须见过失败才算守卫
- [密钥与环境变量](/guard/secrets-and-env) —— 密钥流向、测试隔离、注入铁则
- [测试策略与提速](/guard/test-strategy) —— 分层跑法、进程创建预算、负载假红
- [注释与日志](/guard/code-conventions) —— 注释写什么、日志级别与必打点位
- [知识库口径](/guard/knowledge-base) —— 五域分工、终态写作、关账回写
