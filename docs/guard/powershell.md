# PowerShell

跑 PowerShell 前先读本文件。规则是硬约束，不是建议。

## 文件删除安全（最高优先级）

**只允许删除「本次会话由我创建」的临时文件/目录。** 用户文件、他人产物、来路不明的文件，一律**报告，不删除**。

- 本次创建 = 本次会话里由我的命令 `mkdtempSync` / `New-TemporaryFile` / 显式 `New-Item` 建出来的路径。判断不了来源就不删。
- `Assert-Deletable` 通过**不代表可以删**：它只证明路径在允许根之下，不证明这个文件该删。两者都满足才动手。
- 禁止 `Remove-Item -Recurse` 配通配符或目录遍历式批量删除；禁止以「清理」为名删除不认识的产物（如误落到仓库根的图片、日志、构建产物）——**列出来交给用户**。
- 用户也没让你删的，不要因为「顺手」「看起来是垃圾」就删；拿不准就先问。

> 背景（一句话）：`$home = '...'` 赋值在某些 PowerShell 版本下不生效，紧随其后的 `Remove-Item $home -Recurse -Force` 会删到用户目录。这是本规则存在的原因。

## 环境

| 项 | 值 |
|----|-----|
| 工具实际调用 | **Windows PowerShell 5.1**（`powershell.exe`，`PSEdition=Desktop`） |
| `pwsh`（PowerShell 7） | 本机未安装 |
| 含义 | 按 5.1 语义写脚本；5.1 与 7 行为**可能相反**（见下） |

写脚本时不得假定 PowerShell 7 语义。唯一的安全判据是「**我有没有给自动变量赋值**」，不是「上次跑没报错」。

## 禁止覆盖自动变量与环境变量

不得对 `$home`、`$HOME`、`$profile`、`$env:USERPROFILE`、`$env:APPDATA`、`$env:LOCALAPPDATA` 赋值、改写、覆盖：

- `$home` 是只读自动变量：5.1 下赋值报错（`无法覆盖变量 HOME…`），**PowerShell 7 下静默成功**，之后任何 `Remove-Item $home …` 都会删到用户目录。
- `$env:*` 是真实环境变量，改写会污染本次及其后**所有**命令。

临时值先取专属名再赋值：`$repoRoot`、`$tmpDir`、`$outPath`、`$dshHome`、`$cfgPath`。要这些目录的值就读进专属变量后全程只用它，例如 `$dshHome = $env:DSH_HOME`。

## 递归删除：先断言、再打印、后执行

优先不手写递归删除：JS 用 `mkdtempSync(join(tmpdir(), prefix))`，PS 用 `New-TemporaryFile` 或 `[System.IO.Path]::GetTempFileName()`。

确需递归删除时，三件事按序做：**断言 → 打印目标 → 执行**。

```powershell
function Assert-Deletable {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]   $Path,
    [Parameter(Mandatory)][string[]] $AllowedRoot
  )
  # 先规范化：折叠 ..、统一大小写与 8.3 短名写法
  $full = [System.IO.Path]::GetFullPath($Path)
  $ok = $null
  foreach ($root in $AllowedRoot) {
    $realRoot = $root
    if (Test-Path -LiteralPath $root) {
      $resolved = Resolve-Path -LiteralPath $root -ErrorAction SilentlyContinue
      if ($resolved) { $realRoot = $resolved.ProviderPath }
    }
    $realRoot = [System.IO.Path]::GetFullPath($realRoot).TrimEnd('\')
    # 硬拒：盘根、系统目录、用户目录一律不许当删除目标
    $drive = [System.IO.Path]::GetPathRoot($realRoot).TrimEnd('\')
    foreach ($bad in @($drive, $env:SystemRoot, 'C:\Users')) {
      if ($full.TrimEnd('\') -ieq $bad) { throw "拒绝删除：目标是受保护目录 $full" }
    }
    # 末尾的 '\' 不能少：少了它，'…\Tem' 会被 '…\Temp' 认成子目录
    if ($full.StartsWith($realRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { $ok = $realRoot }
  }
  if (-not $ok) { throw "拒绝删除：$full 不在允许根之下（$($AllowedRoot -join ', ')）" }
  return $full
}

$target = Assert-Deletable -Path $tmpDir -AllowedRoot @($env:TEMP)
Write-Host "即将删除：$target"
Remove-Item -LiteralPath $target -Recurse -Force
```

写死这几条，别改：

| 约束 | 原因 |
|------|------|
| 判据用 `GetFullPath()` + `StartsWith($realRoot + '\')`，**不用 `-like`** | `-like` 右侧是通配符模式，路径含 `[` `]` 时被当成字符类，合法目标被误判为「不在根下」 |
| `+ '\'` 不能省 | 少了它，`…\Tem` 会被 `…\Temp` 认成子目录 |
| 盘根、`$env:SystemRoot`、`C:\Users` 硬拒 | 删错即毁机 |
| 不额外做字符串级 `..` 检测 | `GetFullPath` 已折叠 `..` 与 8.3 短名，穿越写法会被受保护目录那条拦住 |
| 它不放行允许根本身 | `StartsWith` 对根自己为 False；要清空临时目录就删其子目录 |
| 删除语句不带 `-ErrorAction SilentlyContinue` | 静默会隐藏失败原因 |

## 读写文件与编码

- 读文件用 read 工具，或 `-Encoding UTF8`。5.1 的 `Get-Content` 读无 BOM 的 UTF-8 会按 ANSI 解码：中文变乱码（`# 鏍囬`），且多字节序列吞掉 `\n`，**行号少算**（实测 5 行的文件读成 4 行）。
- 算行号用 `[System.IO.File]::ReadAllText()` 再数 `\n`；不要用 `Get-Content` 的下标。
- 自己落盘不产 BOM：`Set-Content` / `ConvertTo-Json` 默认带 BOM，而 `JSON.parse` 遇到 BOM 直接抛。落 JSON 用 `[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))`。
- 读别人写的配置必须容忍 BOM。
- `Get-ChildItem -Include *.ps1` 在 5.1 下不过滤，返回目录全部条目；用 `-Filter` 或 `Where-Object { $_.Extension -in '.ps1','.psm1' }`。

## 执行 `.ps1` 的两条约束

本仓的 PS 脚本（`scripts/bench-gates.ps1`、两个 probe 外壳）改动靠人工审，所以这两条会直接影响"能不能跑起来"：

| 约束 | 现象原文 | 正确做法 |
|---|---|---|
| 执行策略禁止直接执行 | `无法加载文件 …\run.ps1，因为在此系统上禁止运行脚本`（`UnauthorizedAccess`） | 用 `powershell -NoProfile -ExecutionPolicy Bypass -File <路径>`；**不要** `& .\run.ps1` |
| 5.1 按 ANSI 解析**无 BOM** 的脚本 | `The string is missing the terminator: ".` / `Missing closing ')' in expression.` | 含中文的 `.ps1` 存成 **UTF-8 with BOM** |

第二条与「`Get-Content` 读文件」是同一个病：5.1 读**脚本文件本身**也按 ANSI 解码，中文注释变乱码后解析器崩在引号上——
**看起来像脚本语法写错了，实际是编码**。判据（只解析、不执行）：

```powershell
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors) | Out-Null
$errors.Count   # 0 = 可解析；非 0 就把 message 打出来
```

加 BOM 而不用手改内容：`[System.IO.File]::WriteAllText($p, [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8), (New-Object System.Text.UTF8Encoding($true)))`。

⚠️ 与「自己落盘不产 BOM」**不矛盾**：那条针对 **JSON 配置**（`JSON.parse` 遇 BOM 直接抛）；`.ps1` 是要被 5.1 自己读的，**要** BOM。

## 变异验证的备份：文件名必须带**来源前缀**

「人为把缺陷造回去 ⇒ 确认守卫红 ⇒ 还原并核哈希」这条流程里，备份名若只取 basename，
**同名文件会互相覆盖**——本仓三家适配器各有一份 `events.ts`，循环里写
`Copy-Item $f "$backup\$(Split-Path $f -Leaf).orig"` 就会让后一份盖掉前一份，
还原时会把**另一家的内容**写进目标文件（三家各有一份 `events.ts`，`providers/codex/events.ts` 会被 dsh 那份盖掉）。

规矩：

- 备份名带上**唯一前缀**（`codex.bak` / `dsh.bak` / `claude.bak`，或把相对路径压成文件名）；
- 备份后先打印 `Get-FileHash`，还原后再核一次**同一个值**——哈希对不上就是踩了这个坑；
- 真踩了不要慌：`git checkout -- <文件>` 回到 HEAD，再重放本次改动（未提交的改动会丢，
  所以**每完成一处改动就核一次哈希**比事后补救便宜）。
- **还原基准必须是「已提交」内容**：`git checkout -- <文件>` 只回到 HEAD。若变异是加在**未提交**的改动上，
  还原会把那份改动**一起抹掉**（症状是脚本以「还原后哈希不一致」中止）。
  ⇒ **先提交，再跑变异矩阵**；或用**反向 edit** 还原（不依赖 git 状态，更安全）。

## 判成败：别被 stderr 与管道骗了

两条都会让**全绿的命令报失败**：

| 写法 | 现象 | 为什么 |
|---|---|---|
| `pnpm.cmd … 2>&1 \| …` | 命令报 `[exit code: 1]`，即使 vitest 全绿 | 5.1 把子进程写到 **stderr** 的正常输出包成 `NativeCommandError` |
| `… \| Select-Object -First N` | node 以非 0 退出，像测试失败 | 管道提前关闭 ⇒ node 收到 EPIPE |

规矩：

- **判成败只认 `$LASTEXITCODE`**：在命令后**立即**读它，中间不要插别的语句；不要用"有没有红色报错文本"判断。
- 要看输出就 `cmd /c "pnpm.cmd … > out.txt 2>&1"`，再读文件——**不要**用管道截断 stdout。
- 多包混跑时若出现"用例全绿但 exit 1"，**先怀疑这一条**，不要当回归。

## 不要靠静态门禁

`PSScriptAnalyzer` 未安装且装不上。不要把它写成门禁或依赖它检错，用上面的运行时断言。

## 每次调用都是新进程

变量、函数、`Set-Location` 都不跨调用保留。每段脚本自包含；需要跨调用就落盘再读回。

## `Invoke-Expression` 的调用约束

`scripts/bench-gates.ps1:28` 用 `Invoke-Expression "$Command 2>&1"` 执行命令串。**调用方只能传字面量**，不得把外部输入（变量、参数、文件内容）拼进 `$Command`。
