# v7 探针报告：codex 的插件同步与进程/目录残留（2026-10-07）

## 要回答的问题

一条真机报错（点「重新执行」时 `INTERNAL：清理上一轮的行产物失败…（EPERM, Permission denied: …\.judgehome）`，
同一行连着 7 次尝试逐字重复）追到最后一层：**上一轮的厂商进程没有被整棵回收**。三条要逐格确认的事实：

- A. codex 的 `thread/start` 会不会联网同步插件目录、会不会在 `$CODEX_HOME` 下落残骸？
- B. 这个同步能不能关掉？线程级 config / 盘上 config.toml / 进程级 `-c` 三个闸门逐格对照。
- C. `EPERM` 的成因到底是不是「活着的孙进程」？只杀直接子进程 vs 杀整棵树的 A/B。

## 跑法

```powershell
node packages\server\agents\probe\v7\codex-plugins-sync.mjs
```

不需要网关凭据（全程不调 `turn/start`，只有 `initialize` + `thread/start`）。原始结果落
`probe/dumps/v7/codex-plugins-sync.json`（dumps 已 gitignore，跑一次即可重建）。

## 结果矩阵（四个 case 各起一次真 codex，采样窗口 5s）

| case | 线程级 config | argv | 盘上 config.toml | 孙进程 | `$CODEX_HOME` 残骸 | 只杀直接子进程后能删目录 |
|---|---|---|---|---|---|---|
| baseline | `features.multi_agent=true` | — | — | 4~5 个 `git` | `plugins-clone-*/` + `plugins.sync.lock` | ❌ `EPERM` |
| plugins-off | `+ features.plugins=false` | — | — | 4 个 `git` | 同上 | ❌ `EPERM` |
| config-toml-plugins-off | `features.multi_agent=true` | — | `[features] plugins = false` | **0** | 无 | ✅ |
| argv-plugins-off | `features.multi_agent=true` | `-c features.plugins=false` | — | **0** | 无 | ✅ |

四个 case 的 `thread/start` 都正常返回线程 id（关掉插件同步不影响起手）。

进程树逐字（baseline，`tasklist` 视角）：

```text
codex.exe app-server
 └─ "C:\Program Files\Git\cmd\git.exe" -c safe.bareRepository=explicit ls-remote https://github.com/openai/plugins.git HEAD
     └─ git.exe -c safe.bareRepository=explicit ls-remote https://github.com/openai/plugins.git HEAD
         └─ git remote-https https://github.com/openai/plugins.git https://github.com/openai/plugins.git
             └─ git-remote-https.exe https://github.com/openai/plugins.git https://github.com/openai/plugins.git
```

（另一个时点采到的是 `fetch --depth 1 --no-tags … +5fd93af4…:refs/codex/curated-sync`，且带
`-C <home>\.tmp\plugins-clone-<rand>` —— 与二进制字面量 `core-plugins/src/startup_sync.rs` 对得上。）

## A/B：EPERM 的成因（同一探针内）

| 动作 | 结果 |
|---|---|
| 只杀直接子进程（今天 `client.close()` 的旧口径） | 4 个 `git` 孙进程**存活**；`rmSync($CODEX_HOME)` 在 50ms / 250ms / 2s / **10s** 四个时点全部 `EPERM` |
| 按收场前记下的 pid 清掉后代 | **立刻删成功**（四个 case 全部如此） |
| 独立探针：`taskkill /PID <codex> /T /F` | 连带 5 个 pid 全部 terminated；`rmSync` **立刻成功** |

报错原文与界面逐字同形：

```
EPERM, Permission denied: \\?\…\baseline-t9rvAV '\\?\…\baseline-t9rvAV'
```

## 结论

1. codex 0.156.1 的 `thread/start` **必然**去同步 `https://github.com/openai/plugins.git`，落点
   `$CODEX_HOME/.tmp/plugins-clone-<rand>/`，并在 `$CODEX_HOME` 留下 `plugins.sync.lock`。
2. 孙进程**继承父进程的句柄**——它们的命令行里没有 `CODEX_HOME`，所以「按路径扫进程再杀」不可行；
   必须在父进程还活着的时候按**进程树**杀（`taskkill /T`）。
3. 锁**不会自愈**（10s 仍红），而 `fs.rmSync` 在本机没有可用的重试 ⇒ 一次占用就把整行判死，
   锁消失之前每次重跑都失败。
4. 关掉插件同步的两个有效闸门是**盘上的 `config.toml`** 与**进程级 `-c`**；线程级 `config` 管不到
   startup sync（产品今天走的正是线程级那一条）。
