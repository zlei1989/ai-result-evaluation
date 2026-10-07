# 三家智能体内置工具清单（实测采集）

采集方式与证据来源，逐家说明。**这是工具对齐映射表的事实基础。**

## 采集方法

| 家 | 来源 | 权威性 |
|---|---|---|
| claude-code | 探测 dump 的 `system/init` 事件里的 `tools[]` 数组（`probe/dumps/claude-code.json`） | **运行时报文**，最高 |
| dsh | 探测 dump 的 `request/header` 事件里的 `tools[]`（`probe/dumps/dsh.json`） | **运行时报文**，最高 |
| codex | 自建最小 Responses 服务捕获入站请求体的 `tools[]`（本机复现，见下） | **wire 报文**，最高 |

### codex 的采集脚本（可复现）

起一个最小 HTTP 服务监听 7998，把入站 `POST /v1/responses` 的 `tools[]` 落盘后回 400：

```js
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c);
  req.on('end', () => {
    const tools = JSON.parse(body).tools || [];
    writeFileSync('probe-codex-tools.txt', tools.map(t =>
      t.type === 'namespace'
        ? `[namespace ${t.name}] -> ${(t.tools||[]).map(c=>c.name).join(', ')}`
        : `${t.type} ${t.name}`).join('\n'));
    res.writeHead(400, {'content-type':'application/json'});
    res.end(JSON.stringify({error:{message:'probe',type:'invalid_request_error'}}));
  });
});
srv.listen(7998, '127.0.0.1');
```

然后把 codex 指过去（`-c model_provider=p -c model_providers.p.base_url=http://127.0.0.1:7998/v1`
`-c model_providers.p.wire_api=responses -c features.multi_agent=true -m GPT-5.5 "hi"`）。

## codex 的 wire 工具表（实测原文）

```
function exec_command
function write_stdin
function request_user_input
function view_image
[namespace multi_agent_v1] -> close_agent, resume_agent, send_input, spawn_agent, wait_agent
function get_goal
function create_goal
function update_goal
web_search
```

注意：**没有 `apply_patch`、没有 `update_plan`**——当前模型预设的 `tool_mode` 是 `code_mode_only`，
文件改动与计划通过 code 执行，不作为独立工具暴露。这一点随模型预设变化，规范不硬编码。

## claude-code（27 项，`system/init` 原文顺序）

```
Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree,
ExitWorktree, Glob, Grep, ListAgents, NotebookEdit, Read, ReportFindings,
ScheduleWakeup, SendMessage, Skill, TaskCreate, TaskGet, TaskList, TaskStop,
TaskUpdate, WebFetch, WebSearch, Workflow, Write
```

## dsh（24 项，`request/header` 原文顺序）

```
create_goal, edit, exit_plan_mode, get_goal, glob, grep, interrupt_agent,
job_kill, job_list, job_output, list_agents, pwsh, read, read_image,
send_message, skill, subagent, subagent_fork, todo_write, update_goal,
web_fetch, web_search, workflow, write
```

## 交集结果（实测）

| 交集 | 结果 |
|---|---|
| claude ∩ dsh（精确同名） | **空** |
| claude ∩ codex（精确同名） | **空** |
| dsh ∩ codex（精确同名） | `create_goal` / `get_goal` / `update_goal` / `web_search` |
| 三家同在（忽略大小写） | **空** |

**⇒ 命名不是可用的对齐键**：claude 的 `Read` 与 dsh 的 `read` 因大小写不同都算两个名字，
而 codex 的 `exec_command` 与 dsh 的 `pwsh` 是**异名同义**。
对齐必须在**语义类别**层做，见消息规范设计 §7.6。
