# v11 探针报告

> 本文件由**多张探针票共用**（`probe/v11/` 目录同此）。各票**只追加自己那一节**、不整份覆盖：
> 每节以票号开头，节与节之间没有依赖，按追加顺序拼接即可。

## AU-08：dsh 的应答面注册形状

票：**AU-08**（dsh 应答面探针）。本仓的票与 spec 落在取材目录里，clone 读不到，故这里不复述路径——**每节自含**：读这一节就能知道它回答什么问题、判据是什么、原文在哪。
回答 spec 第 6 节《未证实项》第 3 条：**进程内提问服务的应答者注册 API 与「认领并回答」通道的确切用法**。
交付物是**原文**，不是结论——每一格都带包名 / 文件 / 行号。

被测安装态：`@deepseek-ai/dsh-user-questions@0.2.0-rc.2`、`@deepseek-ai/dsh-tool-ask-user@0.2.0-rc.2`、
`@deepseek-ai/dsh-base@0.2.0-rc.2`、`@deepseek-ai/dsh-sdk-app@0.2.0-rc.2`、`@deepseek-ai/dsh-scope@0.2.0-rc.2`。

### 1. 速览

| 问题 | 答案 | 判据 |
|---|---|---|
| 应答者怎么注册 | **不是服务上的方法**，是 Cordis waterfall 监听器 `ctx.on('user-questions/request', …)` | 第 2 节签名原文 |
| 怎么认领 | 监听器 **return** 一份 `AskUserQuestionAnswer`；调 `next()` 即委派 | 同上 |
| 无人应答的确切收场 | 阻塞档 = **报错** `NO_PROVIDER`，**不是**缺省答复；有限 `timed` 档 = 到点返回 `pending`，**不报错** | 第 4 节 |
| 两档输出形状差异 | 配置键 `config.mode` / `config.timeout`；`timed` 多一支 `{pending:true,callId,message}` | 第 5 节 |
| 答案要不要跨进程 | 要（`--patch` overlay 里的插件跑在 dsh 子进程；`signal`/`agent`/`next` 都过不去） | 第 3 节 |
| `attachWait` 是谁用的 | 应答**界面**用（认领倒计时）；本探针的应答者**不认领**，好让 Host 自己产生到点收场 | 第 2 节 |

### 2. 应答者注册 API 的签名原文

包 `@deepseek-ai/dsh-user-questions`，四个动作分属两个面：

#### 2.1 注册（应答者面）：Cordis waterfall 事件

`lib/types/types.d.ts:136-147`：

```ts
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Ask composed answerers for structured user input. Return an answer to
         * claim the request or call `next()` to delegate. Scope-filtered dispatch
         * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
         * @param request - pending user-question request.
         * @mode waterfall
         */
        'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>;
    }
}
```

注册写法（本票探针 `probe/v11/answerer-plugin.mjs` 用的就是它）：

```js
export default function aievalAskAnswerer(ctx) {
  ctx.on('user-questions/request', async (request, next) => {
    // return { answers } ⇒ 认领；return next() ⇒ 委派给下一个应答者
  });
}
```

三个形状细节，都从源码读出来：

1. **waterfall 语义**（`@deepseek-ai/cordis/lib/types/events.d.ts:165-173`）：*"The last dispatch argument is
   treated as the innermost `next`. Listeners run outermost-first; a listener that does not call `next()`
   vetoes the rest of the chain, including the built-in behavior."* ⇒ return 一份答案即认领，**不需要**先
   `next()` 再截胡。
2. **scope 过滤放行无 scope 的监听器**：`ask()` 用 `scopeTarget(agent, agent)` 派发
   （`dsh-user-questions/lib/index.js:681-684`），而过滤实现是
   `dsh-scope/lib/index.js:327-338` —— `const tag = scopeOf(ctx); if (tag === void 0) return true;`。
   挂在 profile 顶层的插件**没有 scope 标签** ⇒ 收得到。另一条等价写法是 `{ global: true }`
   （`Context.on(name, listener, options)`，`events.d.ts` 的 `EventOptions.global`：*"Receive the event
   regardless of context filter checks"*）。
3. **服务一定在场**：`dsh-base/cordis.patch.yml:71-72` 无条件挂
   `- id: user-questions / name: '@deepseek-ai/dsh-user-questions'`。而 `dsh-sdk-app/cordis.patch.yml`
   **不挂** `tool-ask-user`（全仓 `grep tool-ask-user *.yml` 只命中 `dsh-web-app/presets/{standard,ptc}.patch.yml`）
   ⇒ 在 `sdk` profile 上，**模型能看见 `ask_user_question` 是我们 overlay 插进去的结果**
   （`packages/server/agents/src/providers/dsh/index.ts` 的 `buildDshRoutePatch` 里那三条 `insert`）。

#### 2.2 请求与答复的数据形状

`lib/types/types.d.ts:31-61`（问）与 `:49-61`（答）：

```ts
export interface AskUserQuestionItem {
    id: string; question: string; detail?: string; header?: string;
    options?: AskUserQuestionOption[]; multiSelect?: boolean; intent?: AskUserQuestionIntent;
}
export interface AskUserQuestionAnswerItem { id: string; selected: string[]; custom?: string; }
export interface AskUserQuestionAnswer { answers: AskUserQuestionAnswerItem[]; }
```

派发时交到监听器手里的信封，`lib/types/types.d.ts:117-135`：

```ts
export interface AskUserQuestionRequestEvent {
    questions: AskUserQuestionItem[];
    agent?: Agent;
    signal?: AbortSignal;
    wait?: {
        callId: ToolCallId;
        /** True for a foreground wait that requires a Client claim; absent for indefinite waits. */
        timed?: boolean;
    };
}
```

⚠️ **`wait` 的三态**（`dsh-tool-ask-user/lib/index.js`，三个调用点逐字）：

| 调用形状 | `wait` | 出处 |
|---|---|---|
| legacy 工具 | **完全没有这一格** | `:305-314` |
| timed 工具 + `timeout: -1` | `{ callId }`（无 `timed`） | `:195-198` |
| timed 工具 + 有限 timeout | `{ callId, timed: true }` | `:186-189`（经 `askTimed` 的 `:626-629`） |

#### 2.3 工具面（消费方）

包 `@deepseek-ai/dsh-user-questions`，`lib/types/index.d.ts`：

```ts
/** Timed ask result returned when the foreground answer window closes. */
export type TimedUserQuestionResult = AskUserQuestionAnswer | {
    pending: true;
    callId: ToolCallId;
};                                                        // :25-29

export declare class UserQuestionError extends HarnessError {   // :30-33
    constructor(message: string, code: string, options?: ErrorOptions);
}

answer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswer): boolean;   // :56
attachWait(agent: Agent, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>;  // :64-66
askTimed(request: AskUserQuestionRequest & { agent: Agent }, callId: ToolCallId, timeoutMs: number): Promise<TimedUserQuestionResult>;  // :79-81
ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>;              // :98
```

四个动作**各归谁**（JSDoc 原文照抄，这是本票最容易搞混的一格）：

| 方法 | 归谁 | JSDoc 原文（节选） |
|---|---|---|
| `ask` | **工具 / 权限流程**（消费者） | *"Ask the scoped answerer waterfall and wait for the user's answer."* |
| `askTimed` | **工具**（消费者） | *"Foreground wait whose first settlement the Client decides: the Client rejects with `ASK_TIMED_OUT` when its countdown ends, and this method maps that code to the pending result."* |
| `attachWait` | **应答界面** | *"Let one answer UI hold a live timed wait. Closing the stream releases its claim."* |
| `answer` | **应答界面**，且**只在已 continued 之后** | *"Answer a continued question. The reply is steered into the agent as a user message whose source names the call; that message is also the record that closes the question in the projection."* |
| `user-questions/request` | **应答者**（注册面） | 见 2.1 |

`answer` 走的是与前台完全不同的第二条投递方式（`lib/index.js:561-586`）：它造一条
`source.kind === 'user-question-reply'`、`content[0].text = JSON.stringify({ kind: 'answer_to_pending_question',
tool: 'ask_user_question', callId, questions, answers })` 的用户消息，再 `agent.steer(message)` —— 即
**原来的那次 tool call 永远拿不到答案**，答案是以「新的一轮用户消息」进模型的。

`attachWait` 会**停掉 Host 自己的定时器**（`lib/index.js:329-336` 的 `schedule()`：`if (this.signal.aborted || this.claims.size > 0) return;`）
⇒ 认领倒计时意味着「到点收场由你产生」。产品若要「到点落超时」，**别认领**。

#### 2.4 投影（副产品，但对 13 号票有用）

`lib/types/types.d.ts:62-93` 与 `lib/index.js:92-96`：session 投影 `userQuestions` 只跟踪 **timed** 调用
（`isTimedAskUserQuestionSchema` 读 request header 里**记录的 tool schema**，不读调用实参），
legacy 调用 *"appears in neither half"*。所以 `mode` 一改，这一行会多出一个 `{ active, settled }`
的可观测面（`stateVersion: 2`）。

### 3. 一次问答的完整时序

进程只有两个（本票不涉及浏览器）：

- **父**＝我们的 Next/Node 进程（跑 SDK 客户端 `DeepseekHarness`）；
- **子**＝dsh runtime 进程（跑被测智能体、厂商插件，以及我们 `insert` 进去的插件）。

| # | 在哪 | 发生什么 |
|---|---|---|
| 1 | 子 | 模型发 `ask_user_question` 调用；dsh-tools 分派到 `tool-ask-user` 的 `execute(args, exec)`。`exec` 带 `agent`（活 Agent）、`signal`（本轮取消信号）、`callId` |
| 2 | 子 | 工具按 `mode` 分叉：`legacy` ⇒ `ask({ questions, agent, signal })`；`timed` 且 `timeout !== -1` ⇒ `askTimed({ …request, agent }, exec.callId, timeout*1000)`；`timed` 且 `timeout === -1` ⇒ **回落 `ask()`** |
| 3 | 子 | `UserQuestionService.ask()` 先校验：空问题 ⇒ `EMPTY_QUESTIONS`；带 agent ⇒ `assertLiveRoot()`；带 `intent` 的问题两条断言 ⇒ `BAD_INTENT`。然后 `ctx.waterfall(...)` 派发 `user-questions/request`，最内层 `next` 是内置 `noAnswerer` |
| 4 | 子 | **我们的应答者插件**收到 `AskUserQuestionRequestEvent`（`questions` / `agent` / `signal` / `wait?`） |
| 5 | 子→父 | 插件把请求写进 sidecar（如 `<DSH_HOME>/aieval-ask-answerer.jsonl`），父进程 tail 它 |
| 6 | 父→子 | 父进程把答案写进另一个文件（如 `<DSH_HOME>/aieval-ask-answer.json`），插件轮询取回 |
| 7 | 子 | 插件 **return** `{ answers }` ⇒ waterfall 认领 ⇒ `ask()` resolve |
| 8 | 子 | 工具 `render`：`(_args, value) => [{ type: 'text', text: JSON.stringify(value) }]` ⇒ 模型下一步看到 `{"answers":[{"id":"…","selected":["…"]}]}`；同一份值落厂商会话日志的 `tool/result` |
| 9 | 子→父 | SDK 订阅收到 `session.event` 的 `tool/call` 与 `tool/result`。**没有为提问单开任何通知或请求** |

**哪些数据必须跨进程**：`questions`（`id` / `question` / `header` / `options[{label,description}]` /
`multiSelect`）、`callId`、`agent.id` / `agent.session.id`、`wait.timed`。
**跨不过去的**：`signal`（`AbortSignal` 不可序列化 —— 所以「取消」这一支只能由子进程侧的
`wait.signal` / 插件自己的超时来表达）、`agent`（活对象）、`next`（函数）。

**第 9 步为什么只能是 sidecar**：dsh 的 JSON-RPC 面是封闭的 ——
通知四个（`session.event` / `session.status` / `subagent.started` / `subagent.finished`）、
请求三个（`initialize` / `session/prompt` / `shutdown`，见 `docs/protocols/dsh.md:39`），
**没有任何一条是「服务端问客户端」**。所以答案回灌**必须**走进程内插件（+ 我们自己的通道），
不能走协议。

### 4. 「无人应答」的确切收场

`lib/index.js:679`（逐字）：

```js
const noAnswerer = () => Promise.reject(new UserQuestionError("no user-questions answerer accepted the request", "NO_PROVIDER"));
```

- **阻塞档（legacy）**：`ask()` 直接以 `NO_PROVIDER` 拒绝，`tool-ask-user` 的 legacy 分支**没有 catch**
  ⇒ `execute` 抛出 ⇒ 模型拿到的是**报错**，不是缺省答复。厂商文档侧同口径
  （`README.md` 的 Model Experience）：`Error: no user-questions answerer accepted the request`。
  ⇒ 本仓今天挂的就是这一档（overlay 的 `insert` 行没有 `config`），所以「模型一问就拿到错误」**成立**。
- **有限 `timed` 档**：`askTimed` 捕获 `NO_PROVIDER` ⇒ `await wait.done` ⇒ 抛 `wait.signal.reason`
  （`ASK_TIMED_OUT`）⇒ 外层 `catch` 映射成 `{ pending: true, callId }`（`lib/index.js:631-645`）
  ⇒ 工具补 `message` 后正常返回。**不报错**。
- **`timed` + `timeout: -1`**：`if (timeout !== -1)` 不成立 ⇒ 走 `ask()` ⇒ **与 legacy 同样报错**。

其余错误码（都会以 `Error: <message>` 形态进模型）：`CALLER_NOT_LIVE`、`DELEGATED_CALLER`
（子智能体提问必落这一支，原文见 `lib/index.js:531-535`）、`ASK_ABORTED`、`EMPTY_QUESTIONS`、
`BAD_INTENT`、`BAD_TIMEOUT`、`DUPLICATE_WAIT`、`BAD_ANSWER`、`REPLY_QUEUED`。

### 5. 【优先项】`tool-ask-user` 两档的输出形状差异

包 `@deepseek-ai/dsh-tool-ask-user`，配置键在 `lib/index.js:211-214`（逐字）：

```js
const Config = z.object({
	mode: z.union(["legacy", "timed"]).default("legacy"),
	timeout: z.union([-1, z.number().step(1).min(1).max(2147483)]).default(120)
});
```

类型面 `lib/types/index.d.ts:11-17`：

```ts
export interface Config {
    /** Tool definition selected by this Cordis row. Defaults to the blocking legacy tool. */
    mode?: 'legacy' | 'timed';
    /** Foreground wait before automatic continuation. Defaults to 120 seconds. */
    timeout?: number;
}
```

**这是 Cordis 插件行的 `config`，不是顶层 patch 键**（`README.md` 逐字：*"This is a plugin row, not a
top-level `--patch` entry."*）：

```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: 120
```

两档的模型可见参数**不同**：`legacy` 只有 `questions`；`timed` 多一个整数参数
`timeout`（常量 `TIMED_WAIT_PARAMETER = "timeout"`，`lib/index.js:118-121`，描述逐字：
`Wait seconds for the entire batch (default ${defaultTimeout}); omit unless the user specifies a duration.
Use -1 only when an answer is required before proceeding.`）。这个参数在 **request header 里出现与否**，
是投影判定「本 session 的提问是 timed 档」的**唯一**判据。

两档的 `description` 也不同（`lib/index.js:217` vs `:19`）：legacy 是
`Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding.`；
timed 是 `Ask brief, direct, self-contained questions about missing information, preferences, or decisions. …`。

**输出形状（`output.schema`）**：

| 档 | 支数 | 形状 |
|---|---|---|
| `legacy` | **1** | `{ answers: [{ id, selected: string[], custom? }] }`，`additionalProperties: false`。**永不返回 pending** |
| `timed` | **2**（`oneOf`） | ① pending 支 ② answers 支（同上，逐字同形） |

pending 支的三个字段（`lib/index.js:124-144`，逐字）：

```js
pending: { type: "boolean", enum: [true], required: true,
  description: "True when the foreground wait expired before the user submitted an answer batch. The questions remain answerable; this is not a skipped answer." },
callId:  { type: "string", required: true,
  description: "Tool call whose unanswered questions remain pending." },
message: { type: "string", required: true,
  description: "How to continue while the questions stay answerable." }
```

`callId` **只在 pending 支里**；answers 支只有 `answers` 一格。

`message` 那句提示文案是运行时逐字填的常量（`lib/index.js:20-27` 的 `pendingNotice`，`:190-193` 把它
`{ ...result, message: pendingNotice }` 拼进去）：

> `No answer batch arrived before the timeout. This is pending, not a skipped answer. Continue useful independent work. The user can still answer; their reply will be a user message identified as answer_to_pending_question with this callId and the original questions. Do not treat this as permission.`

**对 13 号票的可执行结论**：想止血（模型不再拿错误）就把行改成
`config: { mode: timed, timeout: <正整数> }`；**`timeout: -1` 不算止血**（回落阻塞档）。
代价是 prompt 前缀会变（`description` 与参数表都换了一套），并且这一行的提问会开始进入
`userQuestions` 投影（见 2.4）。

### 6. 探针文件与运行方法

| 文件 | 干什么 | 花不花钱 |
|---|---|---|
| `answerer-plugin.mjs` | **被测对象**：最小应答者插件（`canned` / `file` 两种回答方式 + 自写 sidecar） | — |
| `answerer-arms.mjs` | 四臂的**共用定义**（profile 行 / 落盘 / 提示词 / 判读） | — |
| `dsh-answerer-config-dump.mjs` | **离线判据**：用 `dsh --dump-config` 干跑组装四臂的行并断言（不连网关、不挂插件） | 不花钱 |
| `dsh-answerer-roundtrip.mjs` | **真机四臂**：跑一次问答，抓工具结果、sidecar、最终答复的原文 | 每臂 1–2 次模型往返 |

四臂（同一份提示词，只改 profile 的两行）：

| 臂 | `tool-ask-user` 行 | 应答者 | 要拿的原文 |
|---|---|---|---|
| A | 缺省（= `legacy`） | 有（canned，选 label 以 `-B` 结尾的项） | `{"answers":[…]}` |
| B | 缺省（= `legacy`） | 无 | **报错**原文 |
| C | `config: { mode: timed, timeout: 8 }` | 无 | `{"pending":true,…}` |
| D | `config: { mode: timed, timeout: 60 }` | 有（file：父进程看到请求后写文件） | `{"answers":[…]}`（答案确实跨了进程） |

前置条件：

- 宿主 `~/.dsh/.credentials.yaml` 里有 `DEEPSEEK_API_KEY`（v2 的 dsh 外壳读它；dsh 走自己的
  `deepseek-official` 路由，**不用网关 key**）；
- 依赖已装（`pnpm install --frozen-lockfile`）。

```bash
# ① 免费：行形状与插件落点的静态判据（退出码 1 = 有断言不过）
node packages/server/agents/probe/v11/dsh-answerer-config-dump.mjs

# ② 真机：四臂（约 4–8 次模型往返）
node packages/server/agents/probe/v11/dsh-answerer-roundtrip.mjs
node packages/server/agents/probe/v11/dsh-answerer-roundtrip.mjs --arms=A,C
node packages/server/agents/probe/v11/dsh-answerer-roundtrip.mjs --serve-delay=3000
```

产物：`probe/dumps/v11/dsh-answerer-roundtrip.json`（四臂的逐格原文）+
`probe/dumps/v2/dsh-v11-*.jsonl`（每臂的原始通知流；前缀 `v2/` 来自复用的外壳，`dumps/` 整个已 gitignore）。

### 7. 离线读数（已跑，2026-10-13）

`dsh-answerer-config-dump.mjs` 四臂全绿。两条从原文里读出来的事实：

**① 相对名的解析基准按层不同。** `profiles/sdk/cordis.patch.yml` 这一层把
`name: "./aieval-ask-answerer.mjs"` 解析成

```
file:///<DSH_HOME>/profiles/sdk/aieval-ask-answerer.mjs
```

即**按 profile 目录**；而适配器的 stream-tap 走 `--patch` overlay 那一层，实证的基准是
`<DSH_HOME>` 根（见 `docs/faq/deepseek-harness.md` 那条「插件从未加载」）。
两处注释各说对了一半：`providers/dsh/index.ts` 的「相对名按 profile 目录解析」对 profile patch 成立、
对 overlay 不成立；`stream-tap.ts` 的「必须落在 configHome 根下」对 overlay 成立、对 profile patch 不成立。
⇒ **产品落点用 overlay**，插件按 stream-tap 的规则写在 `<configHome>` 根；本探针落在 profile patch 层，
所以两份都写，靠插件自报的 `import.meta.url` 把「实际加载了哪一份」变成读数。

**② 两档的 `config` 逐字进了合成树**（`--dump-config` 原文）：

```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: 8
```

**变异验证（仓规）**：把 `plantPlugin` 改成只写 `<configHome>` 根那一份（即把「按 profile 目录解析」
这个真实缺陷制造回去）⇒ A、D 两臂的「应答者行解析到真实文件」报红、退出码 1；还原后
`sha256 = d9ca1863855bf5b374ffd0c305fff9d6cdad2544eceb40f4d93d097bd4d25719` 逐字相符、复跑转绿。

### 8. 真机读数（**待人工回填**）

> 本节的每一格都留空**等原文**。静态结论（第 2–5 节）不依赖它；真机只做两件事：
> 确认「照签名写的插件真能认领并交回答案」，以及把两档收场的报错/提示**原文**抄回来。
> **不要在没跑之前把推断填进来。**

| 臂 | 工具结果原文（`result.isError` / `result.text`） | 应答者 sidecar | 最终答复 | 跑了吗 |
|---|---|---|---|---|
| A 有应答者（legacy） | _待填_ | _待填_ | _待填_ | ☐ |
| B 无应答者（legacy） | _待填_ | — | _待填_ | ☐ |
| C 无应答者（timed 8s） | _待填_ | — | _待填_ | ☐ |
| D 有应答者（timed 60s + 文件通道） | _待填_ | _待填_ | _待填_ | ☐ |

要特别抄回来的三格：

1. **B 臂**：报错是不是 `Error: no user-questions answerer accepted the request`（含 `Error: ` 前缀与否）；
2. **C 臂**：`message` 是不是第 5 节那段 `pendingNotice` 逐字；`callId` 是不是工具调用的 id；
3. **A / D 臂**：`answers[].selected` 里是不是探针约定的 `PROBE-<nonce>-B`（是则答案真的从应答者
   流回了模型，而不是模型自己编的）。

### 9. 已知边界与未证实项

- **本票只读**：没有改任何产品代码、没有改 overlay、没有改契约。改动只落在 `probe/`。
- **真机未跑**：第 8 节全空。判据与脚本已就位，缺的是凭据与一次执行。
- **`askUserChannel` 的取值要裁定**（给 10/12 号票）：`sdk` profile 上模型看到的提问工具是**厂商的包**
  （`@deepseek-ai/dsh-tool-ask-user`，提示词与 schema 都归厂商），但**挂载动作是我们 overlay 做的**
  （`dsh-base` / `dsh-sdk-app` 都不挂它）。按「模型看到的工具是谁提供的」应落 `vendor-tool`，
  按「这条通道是不是我们造的」应落 `host-tool`。spec 的 dsh 那一行写的是 `host-tool` —— 本票只把
  两边的事实摆出来，不替它改判。
- **`attachWait` 只做了静态判读**：源码与 JSDoc 一致（认领即停 Host 定时器），真机未验。
- **未验证「父进程在等待期间被终止」**：`wait.signal` 由插件侧持有，父进程死掉时插件没有义务知道；
  这一格留给 dsh 落地票。

---

## AU-06：cc 的提问通道与应答面

> **运行状态：三张脚本的默认臂已跑（2026-10-13，本机 SDK 自带 CLI 2.1.281，
> 脚本式本机假上游、零成本、不需要网关 key）。** 三条问题的结论见下面《读数》一节；
> 未跑的部分见《未跑的部分与已知边界》（`--arm=live` 与任何真网关档都没跑）。
> 《静态证据》一节仍是源码/二进制原文，**不是**运行读数，两边分开写。

### 探针

| 文件 | 回答什么 | 花不花钱 | 要真凭据吗 |
|---|---|---|---|
| `cc-ask-channel.mjs` | Q1：提问经哪条控制请求（`can_use_tool` / `request_user_dialog`）；两个都不挂时是**当场拒**还是**挂住**；挂住的边界在哪 | 不调真模型（本机假上游） | 否（`--arm=live` 才要） |
| `cc-ask-answer.mjs` | Q2：答案能不能随「允许并改写入参」递回去；工具结果原文是什么；改写入参过不过入参校验；**晚点才答**走不走得通 | 同上 | 否 |
| `cc-ask-subagent.mjs` | Q3：子智能体发起的提问里那两格身份在不在；显式声明「没有批准面」时回调会不会被调用 | 同上 | 否 |
| `lib/cc-ask.mjs` | 假上游（canned SSE）、SDK 跑一次、读数抽取、落盘与 redact | — | — |
| `lib/cc-ask-tee.mjs` | 透明转发 CLI，stdin/stdout 各落一份 NDJSON ⇒ **线级控制帧原文** | — | — |

「不调真模型」是怎么做到的：把 `ANTHROPIC_BASE_URL` 指向本机一个假 `/v1/messages`，
它主动回一帧 `AskUserQuestion` 的 `tool_use`（与 v9 `multi-turn-reminder-shape.mjs` 同一手法）。
于是被问的机制本身是确定性的，而且**我们就是上游** ⇒ 后续请求体里那份 `tool_result`
就是「模型最终看到了什么」的逐字原文，不经过本仓任何投影。

### 读数（2026-10-13，脚本自带假上游，`--tee` 有线级帧）

环境：`@anthropic-ai/claude-agent-sdk@0.3.281` 自带 CLI **2.1.281 (Claude Code)**（sha256 `a922981f…f626`）。
读数落 `probe/dumps/v11/`（gitignore）。**下表每一行都是实跑读数**，原文逐字抄。

#### Q1 走哪条控制请求（12 次运行 = 6 臂 × 2 权限档，全部 tee 有线级帧）

| 臂 | 回调 | 模型工具表里有 `AskUserQuestion` | 线级控制帧 | 收场 |
|---|---|---|---|---|
| `both`（两档） | `canUseTool` **1** 次 / `onUserDialog` **0** 次 | **有**（30 项） | `can_use_tool`（`requires_user_interaction: true`） | 当场返回，工具结果含我们递的答案 |
| `none`（两档） | 0 / 0 | **没有** | 无 | **工具被禁用**（不是当场拒、也不是挂住） |
| `null`（两档） | 1 / 0 | 有 | `can_use_tool` | **挂住**：45000 ms 预算内既无工具结果也无后续请求 |
| `hold`（两档） | 1 / 0 | 有 | `can_use_tool` | **挂住**（同上，45 s） |
| `auq-timeout`（两档，永不 resolve + `askUserQuestionTimeout: '60s'`） | 1 / 0 | 有 | `can_use_tool` | **仍然挂住**：100 s 预算内没有工具结果 ⇒ 厂商那条空闲续跑**不救**没人答的提问 |
| `shadow-ab`（两档，先 `Read` 后提问） | 1 / 0（**只有 `AskUserQuestion`**） | 有 | `can_use_tool` | `Read` 正常执行但不回调；提问拿到答案 |

三条原文：

```
（none 臂）<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.</tool_use_error>

（both 臂的线级帧，CLI → 宿主，逐字）
{"type":"control_request","request_id":"e258bc9b-…","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{…"questions":[…]},"tool_use_id":"toolu_probe_ask_1","requires_user_interaction":true}}

（both 臂里宿主的应答，宿主 → CLI，逐字）
{"type":"control_response","response":{"subtype":"success","request_id":"e258bc9b-…","response":{"behavior":"allow","updatedInput":{…,"answers":{"Which approach should the probe take?":"Alpha","Which paths may I touch?":["workspace"]}},"toolUseID":"toolu_probe_ask_1"}}}
```

`both` 臂回调收到的选项字段（**全部字段名**，逐字）：
`["signal","suggestions","blockedPath","decisionReason","title","displayName","description","defaultToNo","suppressAlwaysAllowRule","toolUseID","agentID","requestId","requiresUserInteraction"]`；
主线程上 `agentID` **缺值**、`toolUseID = "toolu_probe_ask_1"`、`requestId` 是那一帧的 `request_id`、`requiresUserInteraction: true`。

**结论（Q1）**：**走 `can_use_tool`（权限通道）**——回调与线级帧两条独立证据一致，全程没有一帧 `request_user_dialog`；
且「两个都不挂」既不是当场拒、也不是挂住，而是**工具压根不提供给模型**（`isEnabled()` 那道理：headless 下没有批准面就不提供）。
权限档不影响通道：`bypassPermissions` 与 `default` 两档读数逐字相同。

#### Q2 答案能不能递回去（7 臂，`--mode=default`）

| 臂 | 我们返回的权限结果 | 模型最终看到的工具结果（逐字） |
|---|---|---|
| `plain`（对照） | `{behavior:'allow'}` | `The user did not answer the questions.` |
| `answers` | `allow` + `updatedInput.answers`（单选串 / 多选数组） | `Your questions have been answered: "Which approach should the probe take?"="Alpha", "Which paths may I touch?"="workspace". You can now continue with these answers in mind.` |
| `multi-csv` | 多选给逗号串 `workspace,system` | `The user answered: "Which approach should the probe take?"="Alpha", "Which paths may I touch?"="workspace,system". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.` |
| `notes` | `answers` + `annotations[q].notes` | `The user answered: "Which approach should the probe take?"="Alpha", "Which paths may I touch?"="workspace" notes: 探针补记：只动工作区，别碰系统文件。. Read the answers carefully — …` |
| `response` | `answers` + `response`（自由输入） | `The user responded: 探针自由输入：先按 Alpha 走。`（**`response` 取代**了选项答案的渲染） |
| `invalid` | `updatedInput.questions` 故意给字符串 | `<tool_use_error>The permission handler returned updatedInput for AskUserQuestion that failed schema validation: AskUserQuestion failed due to the following issue:\nThe parameter \`questions\` type is expected as \`array\` but provided as \`unknown\`\nThis is a configuration issue in your canUseTool callback, PermissionRequest hook, or permission-prompt tool — updatedInput must satisfy the tool's input schema. The tool input from the model was valid.</tool_use_error>` |
| `late`（挂 3 s 再答） | 同 `answers`，只是晚 3 s | 与 `answers` 臂**逐字相同** |

两条来源（下一条入站请求体 / SDK 消息流）在 7 臂上**逐字一致**，没有中间投影。

**结论（Q2）**：**能**。答案经 `updatedInput.answers`（键是**题目文本**；单选给选项标签串、多选给数组或逗号串均可）
递回去，渲染进工具结果、模型看得到；`annotations[q].notes` 会以 `notes: …` 追加在同一行；
`response` 会**取代**选项答案的渲染；**`updatedInput` 会被厂商按该工具的入参 schema 校验**
（多带一个 `answers` 键没问题，改坏 `questions` 会被拒并让工具不执行）；**晚点再答同样成立**。

#### Q3 子智能体身份与「没有批准面」（2 臂）

| 臂 | 请求轨迹 | 回调 | 工具结果（逐字） |
|---|---|---|---|
| `subagent`（用工具表里真实存在的 `Agent` 起子智能体，让**子会话**提问） | 父会话 30 项工具 → 子会话 **25** 项 → 子会话提问 → 子会话续跑 → 父会话收尾 | **0** | `<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is not available inside subagents. Complete the task with the tools provided and return findings to the orchestrator.</tool_use_error>` |
| `no-surface`（`permissionPrompts: 'none'`，主会话提问） | 工具表 **27** 项（比挂了回调的 30 项少 3 项） | **0** | `<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.</tool_use_error>` |

两臂的控制帧都是 **0 条**（不是「我们没挂对回调」：线级帧上根本没有 `can_use_tool` 下发）。

**结论（Q3）**：**子智能体发起的提问到不了宿主**——厂商自己就拒了，且文案是给模型的一句明确指引
（`not available inside subagents`）；因此「回调里有没有子智能体身份那两格」这一问在实践中**用不上**：
主线程提问时选项里有 `agentID` 字段但**缺值**，线级帧里干脆**没有** `agent_id` 这一格（`fieldNames` 逐字见 Q1）。
**显式声明「没有批准面」**（`permissionPrompts: 'none'`）时回调**一次都没被调用**，且工具被禁用
（与 `none` 臂同一句话，只是工具表项目数不同）⇒ 这一档如实落「无人应答」，**不需要**额外写代码（默认即不声明）。

### 判据

#### Q1 走哪条控制请求（`cc-ask-channel.mjs`）

```bash
node packages/server/agents/probe/v11/cc-ask-channel.mjs
```

| 看到的 | 结论 |
|---|---|
| `callbacksFired.canUseTool > 0`，或 `frames-out.ndjson` 里有 `"subtype":"can_use_tool"` | **权限通道**（α 的地基） |
| `callbacksFired.onUserDialog > 0`，或帧里有 `"subtype":"request_user_dialog"` | **对话框通道**（按本期裁定不实现 ⇒ 如实落「无人应答」） |
| 两者都是 0，且 `toolResults` 为空、`timedOut: true` | **挂住**：没人应答时工具不返回；「挂住的边界」= 这个 `--timeout-ms`（厂商侧没有 park deadline，见静态证据） |
| 两者都是 0，但 `toolResults` 里有内容 | **当场被拒**：把那条工具结果原文抄回来（模型看到的拒绝话术） |
| `--arm=auq-timeout` 下约 60 s 后 `toolResults` 出现 | 厂商侧的「空闲自动续跑」边界生效（`askUserQuestionTimeout: '60s'`） |
| `inboundFirstMain.hasAskUserQuestion === false` | 这个工具**根本没提供给模型**（此时脚本式调用仍可能被执行，但真实模型不会自发调用它）——这一格直接决定本家的最终声明 |

权限档的代价同样是读数：`bypass`（本仓适配器今天的全权档）与 `default` 两行一对照，
就能看出「开应答面要不要放弃全权绕过批准」；两行不一致时，不一致本身就是结论。

#### Q2 答案能不能递回去（`cc-ask-answer.mjs`）

```bash
node packages/server/agents/probe/v11/cc-ask-answer.mjs
```

| 看到的 | 结论 |
|---|---|
| `answers` 臂的工具结果里**逐字**含我们给的答案串（`markers` 全 `true`） | ✅ 递得回去 ⇒ 10 号票走 **α**；把命中用的那个字段写法（`answers` / `multi-csv` / `notes` / `response` 哪一臂命中）抄进票里 |
| `plain` 对照臂有结果，而 `answers` 臂的结果与它**逐字相同** | ❌ 改写入参没被当成答案 ⇒ 走 β |
| `answers` 臂 `toolResults` 为空且 `timedOut: true` | 改写入参把这一轮挂住了（不是「没答」）⇒ 抄 `sdkError` / `stderrTail` 原文 |
| `invalid` 臂：非法 `updatedInput` 被原样收下（`invalidMarkerSeen: true`） | 厂商**不校验**改写入参 ⇒ 我们可以往入参里加格 |
| `invalid` 臂：出现 schema 报错原文 | 厂商会校验 ⇒ 只能复用该工具 schema 里已有的格 |
| `late` 臂（挂 3 s 再答）与 `answers` 臂读数一致 | 「人在几十秒后才点完成」这条真机路径成立（本仓的等待语义才有意义） |

判据以**两条来源互证**：`toolResults`（下一条入站请求体）与 `toolResultsFromMessages`（SDK 消息流）；
两者不一致就说明中间还有一层投影，那一轮的读数不可用。

#### Q3 子智能体身份与「没有批准面」（`cc-ask-subagent.mjs`）

```bash
node packages/server/agents/probe/v11/cc-ask-subagent.mjs
```

| 看到的 | 结论 |
|---|---|
| 回调选项里 `agentID` 非空，或提问帧里 `agent_id` 非空 | 本仓能据此判「子智能体不能向用户提问」（判据用这一格） |
| 两格都为空 | 子智能体身份**不在**回调面/帧上 ⇒ 那条收场判定得另找判据（如实记未闭合） |
| `spawnToolMissing: true` | 入站工具表里既没有 `Agent` 也没有 `Task` ⇒ 这一格**没测到**（不是「测到没有」） |
| `no-surface` 臂：`callbackCount === 0` 且工具结果是一条明确的拒绝原文 | 没有批准面这一档如实落「无人应答」，且**不需要**额外写代码（默认即不声明） |
| `no-surface` 臂：`callbackCount > 0` | 与文档不符 ⇒ 抄原文进票，重新裁定那一档 |

### 静态证据（**不是运行结论**；只用来把探针的臂与判据设计对）

工具版本：`@anthropic-ai/claude-agent-sdk@0.3.281`，它自带的 CLI 二进制
`…/claude-agent-sdk-darwin-arm64/claude` = **2.1.281 (Claude Code)**，
sha256 `a922981f6f3b55a251ef9f9dbaa0621a5f99cbcb5ca67f8a797476ccfc83f626`（与包内 `manifest.json` 声明的校验和一致）。
本机全局还装了另一份 2.1.170——所以探针**只认 SDK 自带的那份**（`resolveClaudeBinary()`），
否则版本不同会让读数对不上。

#### ① 提问工具的桥接落在**权限**通道

CLI 里每个「自带交互面的工具」都注册一张权限桥（`so({kind, payload, result, default})`），
提问工具那张是：

```js
var kle = so({
  kind: "permission_ask_user_question",
  payload: f(() => Og((e) => typeof e === "object" && e !== null
    && ("requestId" in e) && ("toolName" in e) && ("permissionResult" in e) && ("questions" in e))),
  result: f(() => Og((e) => typeof e === "object" && e !== null && ("behavior" in e))),
  default: { behavior: "cancelled" },
});
```

它被挂进那张注册表时用的是 `{matches: e => e === gV, dialog: kle, build: go}`——`gV` 就是提问工具本身
（`var Fs = "AskUserQuestion"`，工具对象里 `requiresUserInteraction(){ return !0 }`）。
「result 的形状是带 `behavior` 的权限结果」= 这是**权限面**的桥，不是对话框面。

宿主（SDK）那一侧同一件事的第二份证据：CLI 在权限 ask 路径上发出的控制帧是

```js
e.request({ subtype: "can_use_tool", tool_name: n.name, input: _, …,
  requires_user_interaction: n.requiresUserInteraction?.() || g.localDisplayOnly || void 0,
  tool_use_id: m, agent_id: p.agentId, … }, D.signal, k)
```

⇒ 静态指向 **`can_use_tool`**，且提问那一帧会带 `requires_user_interaction: true`。
UI 侧同一结论的第三份证据：组件表里 `AskUserQuestion: "AskUserQuestionPermissionDialog"`。

#### ② 对话框通道的 kind 只有两个，都与提问无关

客户端侧按 `dialog_kind` 分派的处理器表只有两项：`refusal_fallback_prompt` 与
`auto_mode_server_fallback`。SDK 的 `Options.supportedDialogKinds` JSDoc 原文：
「The CLI fails closed on absence: a dialog kind not declared here is never emitted to this session…
Omitting the option entirely means no dialogs are emitted, even with `onUserDialog` wired.」
⇒ 探针把这两个 kind 都声明上（`cc-ask-channel.mjs` 的 `both` 臂），这样「dialog 回调没被调用」
才**可证伪**；同时用线级帧兜底。

#### ③ 两条 deadline 是两回事（别混成一句）

| 键 | 原文 | 谁受影响 |
|---|---|---|
| `askUserQuestionTimeout` | `z(["60s","5m","10m","never"]).optional().catch(void 0).describe("Idle time before Claude's questions auto-continue with any answers selected so far. Defaults to never — auto-continue only runs when explicitly set to 60s/5m/10m.")` | 提问工具自己的空闲续跑；默认 **never** ⇒ 超时只能由我们的预算产生 |
| `dialogExpiry` | `"Max time a permission/user dialog forwarded to a remote client stays parked awaiting an answer… Defaults to 5m… \"never\" disables the deadline. Local-only permission prompts (no remote client) are unaffected. The CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS env var, when set, overrides this."` | 转发给**远端**客户端的对话框；本机本地权限提示**不受影响** |

SDK 的 `CanUseTool` JSDoc 原文（决定「挂起无上限」这条读数）：
「Return `null` ONLY after the consumer has already sent the control_response out-of-band…
Fail-closed: an accidental null means no control_response is sent and **the tool stays blocked
indefinitely — permission prompts have no park deadline**.」

而「完全没挂回调」是**另一条**路径，CLI 里有现成话术：
`"no approval surface in this session; permission request denied automatically"`；
SDK 的 `permissionPrompts: 'none'` JSDoc 也写明「anything that would otherwise prompt is denied
immediately with a message telling Claude the session has no approval surface; **canUseTool is never called**」。
⇒ 探针因此分成「不挂回调」与「挂了但返回 `null` / 不 resolve」两臂，否则会把两种行为混成一句话。

#### ④ 无人应答时是**挂起（park）**，且这一档在真机上会被流关闭打断

CLI 的权限 ask 路径里有这么一条遥测与日志：

```js
i("tengu_auq_park_interrupted_at_stream_close", { stream_closed: E instanceof Qa }),
t(`Interrupting parked AskUserQuestion toolUseID=${m} at stream close (deny skipped; turn aborts as shutdown)`)
```

⇒ 措辞是「parked AskUserQuestion」；无人应答时工具停在原地，直到流关闭/整轮被收掉。

#### ⑤ 答案的**唯一**入口是改写入参（`updatedInput`）

提问工具自己的两段实现（同一处，逐字）：

```js
async checkPermissions(e){
  return { behavior: "ask", message: "Answer questions?",
    updatedInput: { ...("title" in e && e.title && { title: e.title }),
                    questions: zae() ? e.questions.map(t => ({ ...t, kind: "kind" in t && t.kind ? t.kind : "choice" })) : e.questions,
                    ...(e.metadata && { metadata: e.metadata }) } };
}
async call(e){
  let { answers: t = {}, annotations: n } = e,          // ← 答案从**入参**读
      s = e.questions.map(u => Array.isArray(u.options) ? u : { ...u, options: [] }),
      { response: a, afkTimeoutMs: p, followUp: l } = e;
  …
}
```

权限应答的类型面（SDK）：`{behavior:'allow', updatedInput?, updatedPermissions?} | {behavior:'deny', message}`
——**没有结果字段**。所以「答案怎么递回去」在类型面上只有一条路：把 `answers` 并入
`updatedInput`，让工具 `call()` 收到的那份入参里带上它。探针就是照这一条设计的（外加
`annotations` / `response` / 多选数组 / 逗号串几种写法各一臂）。

#### ⑥ 工具结果是被**渲染**过的文本（所以判据看「逐字含我们的答案串」）

同处 `mapToolResultToToolResultBlockParam` 的分支原文：

- `Your questions have been answered: ${l}. You can now continue with these answers in mind.`
- `The user answered: ${l}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`
- `The user did not answer the questions.`
- `The user responded: ${n}`（自由输入 `response` 优先于选项答案）
- 空闲续跑：`No response after ${Math.round(e/1000)}s — the user may be away from keyboard. Proceed using your best judgment based on the context so far; you can re-ask this question later if it's still relevant.`

⇒ 模型看到的**不是**我们递回去的那份对象，而是把它渲染进一句话的文本。故票里「逐字等于我们给的那份」
这条判据按**答案串逐字出现**来取（`markers`），并把渲染后的整句原文抄回来。

#### ⑦ 工具在什么条件下才被提供（工具表那一格）

提问工具的 `isEnabled()` 是：

```js
function k5(){ if (ph().length > 0 && Ae()) return !1; if (Ae() && !ORn(wF())) return !1; return !0 }
// Ae() = !isInteractive()（headless）；wF() = permissionPromptToolName()；ORn(e) = e !== undefined && e !== "none"
// 另有 g5t({permissionPromptTool, sdkUrl}) { return sdkUrl ? "stdio" : permissionPromptTool }
```

⇒ headless 下是否提供，取决于「有没有一个批准面」（SDK 走 stdio 时那一格解析成 `stdio`）。
这与 v4 探针留下的假设（「需要存在 `canUseTool` 回调才被提供」）方向一致，但**它是静态证据**：
探针每一轮都会把**入站请求体的 `tools[]`** 抄下来（`inboundFirstMain`），那一格才是运行读数。

### 未跑的部分与已知边界

- **没跑的**：`--arm=live`（要 `AIEVAL_PROBE_GATEWAY_API_KEY` 与 `AIEVAL_PROBE_GATEWAY_BASE_URL`
  两个真凭据）——它只回答「真模型看不看得见、会不会自发问」，与本节三条结论无关；
  真机（本仓产品路径、真实网关）也没跑。本节所有读数都出自**脚本式本机假上游**，
  它证明的是**机制**（谁问、怎么答、答到哪去），不是「模型愿不愿意问」。
- 探针**不需要网关 key**（脚本式上游）；`--arm=live` 才要那两个环境变量，且只从环境变量读，
  源码里没有任何明文 key。
- 假上游能不能驱动一个「模型工具表里没有」的工具，本身有前提：`none` / `auq-timeout` /
  `no-surface` 三档里工具**不在表内**，脚本式 `tool_use` 于是拿到
  `<tool_use_error>… No such tool available …</tool_use_error>`——这正是那三档的读数本身
  （「工具没提供给模型」），不会被误读成「通道不存在」。
- `--tee` 的包装脚本先跑 `--version` 预检（真的经包装拉起了 2.1.281 并回出版本号）；
  预检失败会自动退回不带帧的模式并把原因写进产物。`--no-tee` 是显式逃生口。
- 子智能体那一臂的派发工具名**从入站工具表里取**（`Agent` / `Task` 都认）：本仓跨 CLI 版本跑，
  写死名字会把「工具改名」读成「探测失败」。表里两个都没有时，这一格记「没测到」而不是「没有」。
- **写探针时踩过的一个坑（留给下一个改这份脚本的人）**：`extraOptions` 里若带 `env`，
  它会与凭据 env **合并**（`claudeOptions` 现在这么写）。早先的写法是整格替换，
  于是 tee 那三个 `PROBE_*` 变量把 `ANTHROPIC_*` 一起顶掉 ⇒ CLI 以 `apiKeySource: "none"` 起、
  第一次 API 调用就报 `Not logged in · Please run /login`，看起来像「厂商没下发请求」——
  **假绿的一种**：空读数的成因在自己的装配里，不在厂商。
- `dumps/` 整个目录已 gitignore；本轮读数（帧、请求体、SDK 消息流）都不入库。
- 每轮运行会**覆盖**同一个 label 的 `.jsonl` 与两份帧文件（不再追加）：同一个臂重跑时，
  上一轮的帧混进来会让「控制帧 N 条」这类计数被读成厂商发了几帧。
## AU-07：codex 提问的管道 stdin 门禁

**要回答的问题**：厂商二进制里有一句 `request_user_input requires an interactive stdin terminal`。本仓拉起 codex 服务端时 fd 0 一律是**管道**（JSON-RPC 要双向读写）⇒ 这句话到底拦不拦？

**探针**：`codex-ask-user-stdin.mjs`（配 `lib/appserver.mjs` 的共享装配与 `lib/pty-stdin-bridge.py` 的 PTY 桥）。

**为什么带一个 PTY 臂**：那句门禁有两种可能的解释——「stdin 必须可读」（管道已满足）与「必须是真 TTY」（管道不满足）——只有把同一件事在**管道**与**真 TTY** 下各跑一次才分得开。PTY 桥用 Python 的 `pty` / `tty` 给子进程一个真终端；`python3` 缺 `pty` 时该臂**如实标成跳过**，不静默降级成管道臂。

**四条判据**（全部落在产物里，不靠眼睛）：

1. **请求到不到**：`serverRequests` 里 `method === 'item/tool/requestUserInput'` 的条数 ⇒ 到了就是「管道 stdin 不拦」，这是本票的主判据。
2. **到了**：该请求的 `params` **逐字**落盘——`isBlocking` / `autoResolutionMs` 与问题项、选项的确切字段名都在里面，09 号票照它写映射。
3. **没到**：必须分开两种，处置不同——「工具没被提供给模型」（模型请求体 `tools[]` 里没有它）与「提供了但调用被拒」（`tools[]` 里有它、条目流里出现带 error 的调用条目）。
4. **回了空答案之后**：本行的 `turnStatus`、探针工作区里的 `result.txt`、最终 `agentMessage` 原文，三个读数一起看——它决定「没人答」时能不能用厂商原生的「无答案」语义收场。

**运行**（人工步骤）：需要 `AIEVAL_PROBE_GATEWAY_API_KEY` 与 `AIEVAL_PROBE_BASE_URL`（只从环境变量读，缺哪个打印哪个并退出，源码里没有明文凭据）；模型名缺省取 `AIEVAL_PROBE_MODEL`，再缺省 `GLM-5.3`。命令与全部开关见脚本头部与同目录 `README.md`。

**状态**：**本轮没跑**——需要网关凭据，属人工步骤。读数待回填，四条判据的结论也待回填。

### 静态证据（**不是运行结论**；只用来把臂与判据设计对、并给 09 号票抄字段名）

出处：`@openai/codex@0.156.1` 的 darwin-arm64 平台包
（`node_modules/.pnpm/@openai+codex@0.156.1-darwin-arm64/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex`）。
下面每一条都是 `strings` 摘出来的**原文**，不是转述。

#### ① 那句门禁的**出处**在客户端，不在服务端

```
…app-server-test-client/src/lib.rs…codex app-server stdin closed…
request_user_input requires an interactive stdin terminalThis request is non-blocking.
```

同一段二进制里紧挨着的是 `codex-toy-app-server` / `Codex Toy App Server` / `app_server_test_client.command`
——即这句话属于 codex **自带的参照客户端**（`app-server-test-client`），是**它**在自己 stdin 不是终端时
拒绝作答的文案。⇒ 静态上它管的是「**谁来回这一帧**」，不是「服务端发不发这一帧」。
这条静态判断必须由运行读数落地：管道臂里请求**到了**，就证明它拦不住下发；这也是本票主判据的由来。

#### ② 另外三条门禁原文（都是**调用被拒**那一侧，不是下发那一侧）

```
request_user_input can only be used by the root thread
request_user_input requires the root thread. Ask the paren…
request_user_input is unavailable in <模式名> mode      （模板串：`request_user_input is unavailable in ` + ` mode`）
request_user_input is not supported in exec mode for thread `<threadId>`
request_user_input requires non-empty options for every question
```

⇒ 「工具没被提供」与「提供了但调用被拒」在厂商侧是**两套不同的文案**，探针的判据 ③ 就是照这个分的。

#### ③ 配置键的确切形状

`ToolsToml` 的成员只有三个：`web_search` / `experimental_request_user_input` / `update_plan`
⇒ 本票那两格写全了是 `tools.experimental_request_user_input.enabled`；另一格在特性表里叫
`features.default_mode_request_user_input`（同一张表里还有 `send_async_messages` /
`terminal_visualization_instructions` 等）。
⚠️ **这两格改的不是「工具注不注册」**：0.156.1 不开它们也把 `request_user_input` 列进工具表，
且模型看到的系统提示逐字不变（见下面 ⑥ 的离线读数）⇒ 它们若有效，作用点在**运行期**。

#### ④ 「回空答案之后怎么办」——厂商提示词里有这句话，但**它没到我们这条链路**

厂商二进制里有一段 `## request_user_input availability`，逐字：

```
Use the `request_user_input` tool only when it is listed in the available tools for this turn.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions.

Use the `request_user_input` tool only for optional questions where the answer would materially improve the quality of the work.

If `request_user_input` returns no answers, continue with best judgment instead of asking again or treating the turn as blocked.

Never use the `request_user_input` tool for permission requests or permission-related escalations.

If explicit user input is required for another reason before progress can safely continue, do not use the `request_user_input` tool. Ask the user directly with one concise plain-text question instead. Never write a multiple choice question as a textual assistant message.
```

⚠️ **但这段话不在发给模型的请求里**（下面 ⑥ 的离线读数：`off` / `tools-only` / `on` 三臂的
`instructions` 长度**完全一致**，而且**都不含** `request_user_input` 这个子串）。
⇒ 它属于厂商别处的提示词（Plan 模式，或别的产品面），**不能**拿它当判据 ④ 的依据：
「回空答案 ⇒ 继续按最佳判断干活」这条期望**只能靠真机跑出来**，本票不预置结论。
它的价值只剩一条：排查时知道厂商**有**这个意图 —— 真机若出现「判成被阻塞」，那就不是
「厂商没写过这句话」那么简单，而要去看模型实际拿到的是哪一份提示词。

#### ⑤ 协议字段名（vendor 生成，可复现，零模型调用）

```bash
codex app-server generate-json-schema --experimental --out /tmp/codex-schema
```

`ToolRequestUserInputParams`（`required: isBlocking / itemId / questions / threadId / turnId`）：

```json
{
  "autoResolutionMs": { "default": null, "description": "@deprecated Use `isBlocking` to decide whether the request should block.", "format": "uint64", "minimum": 0.0, "type": ["integer", "null"] },
  "isBlocking": { "type": "boolean" },
  "itemId": { "type": "string" },
  "questions": { "items": { "$ref": "#/definitions/ToolRequestUserInputQuestion" }, "type": "array" },
  "threadId": { "type": "string" },
  "turnId": { "type": "string" }
}
```

```json
{
  "ToolRequestUserInputOption": { "properties": { "description": { "type": "string" }, "label": { "type": "string" } }, "required": ["description", "label"], "type": "object" },
  "ToolRequestUserInputQuestion": {
    "properties": {
      "header": { "type": "string" }, "id": { "type": "string" }, "question": { "type": "string" },
      "isOther": { "default": false, "type": "boolean" }, "isSecret": { "default": false, "type": "boolean" },
      "options": { "items": { "$ref": "#/definitions/ToolRequestUserInputOption" }, "type": ["array", "null"] }
    },
    "required": ["header", "id", "question"], "type": "object"
  }
}
```

`ToolRequestUserInputResponse`（应答帧的形状，`required: answers`）：

```json
{ "answers": { "additionalProperties": { "properties": { "answers": { "items": { "type": "string" }, "type": "array" } }, "required": ["answers"], "type": "object" } } }
```

⇒ 三处对 09 号票要紧的**逐字**事实：
- 请求方法名是 **`item/tool/requestUserInput`**（`ServerRequest` 的 11 个 oneOf 之一）；
- 收场通知是 **`serverRequest/resolved`**，params = `{requestId, threadId}`；
- 「答案」是一张**按 `question.id` 索引**的表，每格是 `{answers: string[]}`；
  问题项比本仓契约多出的是 **`id`**、**`isOther`**、**`isSecret`** 三格（后两者对应契约的 `allowFreeInput` / `sensitive`）；
- `autoResolutionMs` 在 0.156.1 已标 **`@deprecated`**（「改用 `isBlocking` 决定这一帧要不要阻塞」）
  ⇒ spec 里「`autoResolutionMs` 到点厂商自己收场」这条要按 `noreply` 臂的实测复核。

#### ⑥ 离线装配自检读数（假网关、**零模型调用**，任何人可复现）

```bash
AIEVAL_PROBE_GATEWAY_API_KEY=dummy AIEVAL_PROBE_BASE_URL=http://127.0.0.1:9/v1 \
  node packages/server/agents/probe/v11/codex-ask-user-stdin.mjs --arms=off,tools-only,on --turn-timeout-ms=30000
```

三臂发出去的第一条模型请求（`off` = **与适配器逐字一致**的那份线程级 config；
`tools-only` = 再加 `tools.experimental_request_user_input.enabled`；
`on` = 再把 `features.default_mode_request_user_input` 也打开）：

| 臂 | `tools[]` 里有 `request_user_input`？ | `instructions` 字符数 | `instructions` 里提到 `request_user_input`？ |
|---|---|---|---|
| `off`（适配器现状） | **有** | 20751 | 否 |
| `tools-only` | **有** | 20751 | 否 |
| `on`（两格都开） | **有** | 20751 | 否 |

`tools[]` 的名字表（三臂一致，14 个）：

```
exec_command, write_stdin, update_plan, request_user_input, view_image,
multi_agent_v1, close_agent, resume_agent, send_input, spawn_agent, wait_agent,
get_goal, create_goal, update_goal
```

⇒ 两条**已经落地**的事实（都与模型无关，所以离线即可复现）：

1. **0.156.1 默认就把 `request_user_input` 列进工具表**（连 `tools.experimental_request_user_input`
   都不必开）。⇒ 09 号票「开提问工具开关」这个动作，**不能**按「不开模型就看不见工具」来理解，
   `off` 臂的语义也不是「工具没被提供给模型」。判据 ③ 的两种成因**必须**靠
   `toolTable` + `itemSummary[].error` 一起读，不能拿臂的配置当结论。
2. **两格开关都不改模型看到的东西**：`instructions` 长度逐臂相等、工具表逐臂相同。
   ⇒ 它们若真有用，作用点在**运行期**（例如「调用被接受还是被 `request_user_input is unavailable in
   … mode` 弹回」），这一格**只有真机跑得出来**，正是 `off` 与 `on` 两臂要对比的读数。

未证实项（**不要**当成结论）：这两格键名**是否被这一版识别**没有独立的静态判据——
`codex --strict-config` 对 `-c` 覆盖**零区分力**（实测：连 `tools.definitely_not_a_key=true`
这种明显假键也不报错，退出码 0）⇒ 「配置没变化」**不能**反推「键被静默忽略」。

### AU-07 已知边界（**未闭合**）

- **PTY 臂在受限环境里跑不了**：`pty.openpty()` 需要 `/dev/ptmx`，容器 / 受限沙箱下直接
  `OSError: [Errno 1] Operation not permitted`（`script -q /dev/null …` 也报同一个 `openpty: Operation not permitted`）。
  探针为此加了**启动自检**（拿哑子进程验 `os.isatty(0) == True`），自检不过就把 `pty` 臂**标成跳过**并打印原因
  ——绝不静默降级成又一条管道臂（那会让两支一致被误读成「TTY 不是自变量」）。
  ⚠️ 因此 `pty` 臂的桥**在没有 pty 权限的机器上从未被真跑过**：它的正确性只到「自检通过」这一步。
- **`codex app-server --listen unix://<path>` 这条路没走通（未定位）**：换成 socket 是为了「JSON-RPC 走 socket、
  fd 0 留给真终端」。实测：socket 文件建出来了、`net.connect` 也连上了，但**写进去的一行 JSON-RPC 一个字节都没回**
  （试过 `\n` 与 LSP 式 `Content-Length` 两种分帧，各等 4 s 无任何字节）。下一步：`codex app-server proxy`
  的用法说明，或抓 `codex app-server daemon` 的控制通道握手；本票改用 pty 桥绕过它。
- **读数是空的**：本票的**运行**是人工步骤（要网关凭据）。四条判据的结论、`paramsRaw` 原文与
  `askUserInstructionExcerpt` 的逐臂对比都待回填；**回填完本票才该转 `resolved`**。
