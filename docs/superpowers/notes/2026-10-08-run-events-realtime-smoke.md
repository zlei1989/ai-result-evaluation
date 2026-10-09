# 评测页实时状态改造——真机冒烟记录（2026-10-08）

对应改动：`3591d69 feat(runs): 评测页状态改为信号驱动重验，删除 3 秒快轮询`
（服务端三层在 `ba71754` 已先行进入，apps 侧四处被 reset 抹掉后由 `3591d69` 补齐）。

## 范围清单

- ✅ `GET /api/runs/events` 返回 SSE 全套响应头（`text/event-stream` + `no-cache` +
  `X-Accel-Buffering: no`），打开即有 `: ready` 首字节
- ✅ **信号链路端到端**：另开一条 SSE 连接的情况下，`PUT /api/runs/{id}`（原样快照、
  内容零改动）落盘成功后，流里**立刻**收到 `event: run-updated` +
  `data: {"runId":"…"}` 帧（毫秒级，无需等待任何轮询周期）
- ✅ `GET /runs` 页面 200 正常渲染（新客户端代码随 turbopack 热编译进页面）
- ✅ 四包全量测试 1018 用例绿；typecheck / lint 干净
- 跳过：**浏览器 Network 面板的肉眼复核**——本次会话没有浏览器自动化工具，
  客户端「信号到达即重验、3 秒内零快轮询」由 `runs.test.tsx` / `run-events.test.tsx`
  共 38 条 jsdom 用例钉住（含 FakeEventSource 具名事件语义替身）。
- 跳过：**跑一轮真实评测**观察执行中的连续翻转——周期长且与信号链路无关
  （信号发射点在 `saveRun`，单笔验证已覆盖；执行中的翻转只是同一链路的多次重复）。

## 操作路径

```bash
# 1) 开一条 SSE 流（后台持有 12s）
curl -sN --max-time 12 http://localhost:3083/api/runs/events
# 2) 对同一轮 PUT 一次「原样快照」（内容零改动，只触发一次 saveRun）
curl -s -X PUT -H "content-type: application/json" \
  -d @/tmp/run-put-body.json \
  http://localhost:3083/api/runs/34859f23-ccc7-4ea2-bd35-b0e44888ba3a
```

## 证据（CLI 双向互证）

- SSE 侧收到（`/tmp/run-events-smoke4.txt`）：

  ```
  : ready

  event: run-updated
  data: {"runId":"34859f23-ccc7-4ea2-bd35-b0e44888ba3a"}
  ```

- HTTP 侧：`PUT → 200 in 0.48s`；dev server 日志同步出现
  `[INFO] [runs] 评测已修改 { runId: '34859f23…' }`——同一动作在两条通道都留痕，
  页面与磁盘互证成立。

## 环境事实（排障时踩到，与本次改动无关但值得留档）

1. **`pnpm install` 会打僵在跑的 dev server**：install 重建 node_modules 的符号链接
   后，运行中的 `next dev`（turbopack）在监听但**完全不响应**（连 `/` 都 000）。
   处置：kill 占用 3083 的进程再启动（AGENTS.md「pnpm dev 端口被占用」规矩）。
2. **agent 会话沙箱写不了评测产物目录**：`workspaceRoot` 配在
   `/Users/zhanglei1120/Workspaces/tmp/aieval`（会话工作区之外），沙箱内起的
   dev server 所有写盘（`run.json.tmp`、`events.jsonl`）一律 EPERM、接口 500。
   处置：以提权方式重启 dev server（症状与「评分/编辑功能全 500」一模一样，
   排障时先想沙箱/权限，再想代码）。
3. **镜像源缺 `@anthropic-ai/claude-agent-sdk-win32-arm64@0.3.281`**：lockfile 完整钉着
   该版本，`--frozen-lockfile` 纯按 lockfile 安装即可绕开重新解析（macOS 本来也不会
   拉 win32 包）；不做 frozen 安装才会去镜像解析版本列表并失败。

## 未覆盖项与后续计划

- 浏览器端 Network 面板复核（等使用者刷新 `/runs` 页面后自然完成）：期望看到
  `/api/runs/events` 一条长连接、`/api/runs` 与 `/api/runs/{id}` **只在**状态翻转时
  被调用；有活在跑时每 60 秒至多一次慢兜底。
- 多标签页下的「A 删除评测、B 收到通知」不在本通道职责内（删除不落盘、无信号点），
  需要时另行加。
