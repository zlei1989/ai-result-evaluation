# 测试墙钟的机器侧瓶颈：DLP/EDR 白名单申请

> 2026-09-28 实测。本文只描述**机器环境**这一侧的事实与请求，不改任何代码。
> 代码侧的优化记录见 `docs/superpowers/specs/2026-09-28-test-speedup-design.md` 与
> `docs/superpowers/plans/2026-09-28-test-speedup.md` 的执行记录。

## 1. 事实：本机的「进程创建」被收税

同一台机器、同一天、暖态多次取均值（`Measure-Command`）：

| 命令 | 单次耗时 | 说明 |
|---|---|---|
| `cmd /c exit 0` | **162ms** | 进程创建的地板价（不加载任何额外 DLL） |
| `git --version` | **566ms** | 比地板价多 ~400ms |
| `node --version` | **530ms** | 同上 |
| `pnpm --version` | ~0.9s | node + pnpm 两级 |

**Windows Defender 的实时防护是关的**（`(Get-MpComputerStatus).RealTimeProtectionEnabled = False`），
所以这不是 Defender 在扫描；机器上常驻的是企业侧 DLP/EDR：
`CGEControl.exe` / `CGEData.exe` / `DataWatch`（CGE DLP）、`Sangfor aTrust`、`UniAccessAgent`、
`hostsafe`、`JDAppCrashMonitor` —— 它们都在**每个新进程的创建路径**上挂钩。
现有 `ExclusionProcess` / `ExclusionPath` 名单里**没有** `git.exe`、`node.exe`、
本仓路径（`D:\zhanglei1120\Github\ai-result-evaluation`）与 `%TEMP%`。

## 2. 为什么它直接决定测试墙钟

本仓的测试按 spec §9 **只用真实 git 进程**（禁 mock），一条用例动辄十几个进程：

| 动作 | 进程数 | 实测耗时 |
|---|---|---|
| `initFixtureRepo`（init / config×2 / add / commit / rev-parse） | 7 | 1612ms |
| 本地 `git clone`（用例缓存首建） | 1 | 1053ms |
| `git status --porcelain -z` | 1 | ~250ms |
| `collectDiff`（早先 6 个进程，现已合并到 4 个） | 4–6 | 1.0–1.5s |

一次全量测试（116 个文件 / 1519 条用例）里，进程创建的**总次数在万级**。
按 566ms 与 162ms 的差额估算，仅「git/node 比地板价多出来的那 ~400ms」一项，
就占到全量墙钟的一大半。

## 3. 请求

请把下列对象加入 DLP/EDR（CGE DLP / Sangfor aTrust / UniAccessAgent）的**进程与路径白名单**：

| 类型 | 对象 | 理由 |
|---|---|---|
| 进程 | `git.exe`（`D:\zhanglei1120\AppData\Local\Programs\Git\**\git.exe`） | 测试与产品都靠它，单次 566ms → 期望回到 ~160ms |
| 进程 | `node.exe`（`D:\.nvm4w\nodejs\node.exe`） | 测试与开发服务器 |
| 路径 | `D:\zhanglei1120\Github\ai-result-evaluation`（含 `node_modules`） | 全量测试的工作目录 |
| 路径 | `%TEMP%`（`C:\Users\zhanglei1120\AppData\Local\Temp`） | 每个用例的临时仓库与工作区都建在这里 |

## 4. 预期效果与验证方式

- **预期**：每次 git/node 调用从 ~550ms 降到接近 `cmd` 的 ~160ms，全量测试墙钟按同比例下降
  （粗估 3 倍量级）。
- **验证**：白名单生效后重跑同一条命令，比较墙钟与
  `Measure-Command { git --version }`（应显著低于 566ms）。

## 5. 与代码侧优化的关系

代码侧已经把「一次全量要付多少次进程创建」压下来了（拆长杆文件、夹具模板化、用例缓存预热、
`collectDiff` 6→4、`assertCommit` 2→1），但**每次进程创建本身的价格**只能由这条白名单改变。
两者是乘法关系，不互相替代。
