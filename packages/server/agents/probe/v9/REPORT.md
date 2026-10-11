# v9 探针报告：claude-code 的 skill 清单**到底有没有到模型**（2026-10-11）

**一句话结论**：**装入链与 `settingSources` 都是对的，清单也确实进了请求体；它在下一跳被整条丢掉。**
CC 2.1.281 把整份 `<system-reminder>`（技能清单在内）放在 `messages[]` 里一条 **`role: "system"`** 的消息上，
而 Anthropic Messages API 只定义 `user` / `assistant` —— 网关那一跳不认这个角色，**整条消息**没进上游上下文。
把同一个请求体的这一个字段改成 `user`（其余逐字节相同），两个模型都会立刻发出 `tool_use(name='Skill')`。

## 要回答的问题

真机现象「技能面确证在（`getContextUsage().skills.skillFrontmatter` 里有它）、模型一次 `Skill` 都不发」，
两种解释分不开：

1. **装入链 / 挂载方式**有缺陷（`settingSources` 传错、落点不对、时序不对）⇒ 清单根本没进模型上下文；
2. 清单进了上下文，**模型不照做**。

两条都要在 **CLI 那一侧的可见边界**上回答，故本探针不依赖上游会答题：CLI 在收到任何网关响应**之前**
就把 system prompt、`<system-reminder>` 与 `tools[]` 组装完并发出去 ⇒ 用一个**本地捕获网关**收下第一轮请求体即可。

## 跑法

```bash
# ① 抓包：本地捕获网关 + 真 CLI + 真适配器 options，按 settingSources 四档各抓一次主请求体
node packages/server/agents/probe/v9/claude-skill-mount-capture.mjs

# ② 差分复放：把 ① 抓到的请求体打给真网关，只改「清单那条消息的 role」
node packages/server/agents/probe/v9/replay-role-differential.mjs [--runs=3] [--model=GLM-5.3]
```

- 供应商与模型读**宿主** `~/.aieval/config.json` 里第一条 `anthropic`（与其余真机探针同源）；
  **密钥只在环境/请求头里走，不写进任何产物**（捕获探针落盘的请求体不含密钥）。
- 抓包落 `probe/dumps/v9/*.json`（整个 `probe/dumps/` 已 gitignore，跑一次即可重建）。

## 判定表一：`settingSources` 四档（只动这一格，其余 options 逐字相同）

主请求体里「可用技能清单」那一段（`The following skills are available for use with the Skill tool:`）的条数：

| `settingSources` | 清单条数 | 我们物化的 `tang-poem-meal` | 仓库自带的 `repo-owned-probe` | `Skill` 工具 |
|---|---|---|---|---|
| `['user','project','local']`（现网） | 14 | **✓** | ✓ | ✓ |
| `[]` | 12 | ✗ | ✗ | ✓ |
| `['user']` | 13 | **✓** | ✗ | ✓ |
| `['project','local']`（剔掉 `user`） | 13 | **✗** | ✓ | ✓ |

⇒ **`settingSources` 是起作用且传对了的那一格**：剔掉 `'user'`，我们物化到 `<configHome>/skills/` 的那条
就从请求体里消失。清单里那 12 条与档位无关的是厂商内置（`built-in`）。
`<configHome>/.claude/skills/`（另一候选用户级落点）**四档都没被发现** ⇒ 用户级落点就是 `<configHome>/skills/`。

## 判定表二：只改 `role` 一个字段的差分复放

请求体 = 判定表一里 `['user','project','local']` 那一份（53866 字节，`messages[0].role='user'` 题面 +
`messages[1].role='system'` 7694 字符 reminder，`tools[]` 20 项含 `Skill`）。

| 臂 | 请求体差异 | `Skill` 调用（`DeepSeek-V4.1-Flash-a` / `GLM-5.3`） | 上游 `input_tokens` / `cache_read` | 模型自述 |
|---|---|---|---|---|
| 原样 | `role: "system"` | **0/3 / 0/3** | 158 / 11392（多次运行同值） | 「系统并没有向我提供任何技能（skill）清单」 |
| 只改 role | `role: "user"` | **3/3 / 3/3**，入参 `{"skill":"tang-poem-meal"}` | 216～1880 / 11520～13184（随提示缓存浮动） | — |
| 删掉该条 | 无清单（对照） | 0/3 / 0/3 | 158 / 11392（与原样逐字相同） | — |
| 原样 + 条末拼令牌再追问 | `role: "system"` | 0/3 / 0/3 | 192 / 11392 | 「关于令牌：没看到」 |
| 同上，role 改成 `user` | `role: "user"` | 3/3（一条回了 2 次）/ 2/3 | — | 逐行列出 14 条名字（含 `tang-poem-meal`） |

两条读法：

- **行为面**：原样 0/3、只改 role 3/3 —— 唯一的变量是 `role` 这一个字符串。
- **token 账**：该条为 `role:"system"` 时上游 usage 与「整条删掉」**逐字相同** ⇒ 内容**根本没进上游上下文**，
  不是「进去了模型不理」。模型自述与 token 账两头对上。

## 结论与边界

- **`settingSources` 不是原因**（判定表一）；**装入链也没有缺陷**——文件在盘、清单进了请求体、`Skill` 工具在 `tools[]` 里。
- **根因**：CLI 之后、模型之前那一跳，把 `messages[]` 里 `role` 不是 `user`/`assistant` 的条目整条丢掉。
- **根因（已定位到具体代码行）**：网关 `proxyGateway` 的 `lib/convert/anthropic.js` 的 `anthropicToOpenAI` 里
  `if (role === "system") continue;` —— 对非直连目标（chat / responses / gemini）**整条丢弃**中途 system。
  同仓的 `anthropic → anthropic` 直连路由走 `convertSystemToUser`（**就地转 user**），两条路由两种处置；
  该丢弃处**零诊断**（违反 `lib/diagnostics.js` 的「绝不静默」），且被 `test/system-prefix.test.js` 以
  「保住 prompt cache 前缀」为由钉住。**修复已在网关侧落地并本机端到端验证**（就地降级为 user +
  `mid_sequence_system_downgraded_to_user` 诊断），**远端部署前本仓现象照旧**。

## 未闭合

- 网关侧修复**待部署**到 `likecode-llm-proxy.jd.com`；部署前 `A1-原样(system)` 臂仍是 0。
- 本仓这一侧的兜底（候选执行的任务提示里显式注入技能清单）**未实施**，且在网关修好后不再是必需：
  它只补技能一项，补不了被同一条消息一起丢弃的环境块 / agent 类型表 / 日期 / token 预算。
- 本探针**不进单测**：它要真 CLI + 真网关，且「A1 臂为 0」是**当前厂商行为的读数**而非我们的缺陷——
  写成断言会在网关修好那一天假红。真机守卫仍由 `providers/claude-code/live-skills-context.test.ts`
  与离线的 `skills-config-prereq.test.ts` 承担。
