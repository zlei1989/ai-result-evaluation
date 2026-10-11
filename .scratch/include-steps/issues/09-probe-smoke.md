# 09 网关附件探针与冒烟（含守卫判定）

Status: resolved
Blocked by: 04, 06

## 任务

1. **网关附件探针（先做，是上线硬守卫）**：对实际配置的评分网关（`loadConfig().settings.defaultJudge` 对应的 provider，两种协议都要覆盖到实际使用的那种）发最小附件请求：anthropic 协议带一个 document(PlainTextSource) 块、openai 协议带一个 file content part，验证网关没有静默忽略附件内容（判据：返回内容或行为能证明附件被读到；不通过 = 评分附件形态不得启用）。探针代码落 `.scratch/include-steps/probe/`，密钥只从环境变量/既有配置读，不落盘明文。
2. **冒烟**：真实服务（web-next :3083）按真实用户路径：新建用例开「包含步骤」→ 跑一次 run（文本评分 + 智能体评分各覆盖一次）→ 页面与磁盘互证（events.jsonl 内容进入评分上下文；智能体评委读得到工作区外文件）。若本机无可用评分网关/供应商配置，把「未覆盖项」如实记录。
3. 冒烟记录落 `.scratch/include-steps/smoke.md`（四要素：范围清单 ✅/❌/跳过+理由、操作路径、证据浏览器+CLI 互证、未覆盖项与后续计划）。
4. 出现厂商智能体运行期问题按 AGENTS.md 追加 FAQ（含根因与解决方案）。

## 验收

- 探针结果（通过/失败原因）与冒烟记录完整；探针不通过时明确报告「附件形态未启用」，绝不静默降级。

## Comments

先读 `docs/guard/playwright-mcp.md`（filename 路径规则与几何断言口径）再动浏览器。本票是最后一张，做完跑一次 `pnpm typecheck` → `pnpm lint` 全量确认。
