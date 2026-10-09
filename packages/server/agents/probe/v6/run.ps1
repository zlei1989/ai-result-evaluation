# v6 探针的运行外壳：把 DeepSeek 密钥从凭据库注入**子进程环境**，再跑探针脚本。
#
# 为什么要有这一层：
#   · 密钥绝不写进仓库文件、也不打印 ⇒ 只在 PowerShell 变量与子进程环境里流转；
#   · `codex app-server` 的 provider 用 `env_key = 'OPENAI_API_KEY'` 取 Bearer
#     ⇒ 探针把它放进 app-server 子进程环境（不落盘）；
#   · `$CODEX_HOME` 与 scratch 都落在工作区内（%TEMP% 下 codex 会以 os error 5 失败）。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File packages\server\agents\probe\v6\run.ps1 [only=wire|only=live]
# 两条环境事实（2026-10-07 实测，都会让这个脚本"看起来是脚本本身坏了"）：
#   1. 本机是 **Windows PowerShell 5.1**（没有 pwsh 7）：它读**无 BOM** 的脚本时按 ANSI(GBK) 解码，
#      本文件的中文注释会变乱码 ⇒ 解析器直接报 `The string is missing the terminator: ".`
#      与 `Missing closing ')' in expression.`。故本文件**必须存成 UTF-8 with BOM**；
#   2. 直接 `& .\run.ps1` 会被执行策略拦下（`因为在此系统上禁止运行脚本`）⇒ 调用要带
#      `-ExecutionPolicy Bypass -File`。
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..\..\..')).ProviderPath
$probeFile = Join-Path $PSScriptRoot 'codex-chat-wire-appserver.mjs'

if ([string]::IsNullOrWhiteSpace($env:AIEVAL_PROBE_DEEPSEEK_API_KEY)) {
  $credFile = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
  if (-not (Test-Path -LiteralPath $credFile)) { throw "拿不到 DeepSeek 凭据：设 AIEVAL_PROBE_DEEPSEEK_API_KEY，或提供 $credFile" }
  # 凭据文件里是 YAML 缩进映射：`  DEEPSEEK_API_KEY: sk-…`
  $hit = Select-String -LiteralPath $credFile -Pattern '^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$' | Select-Object -First 1
  if ($null -eq $hit) { throw "$credFile 里没有 DEEPSEEK_API_KEY" }
  $env:AIEVAL_PROBE_DEEPSEEK_API_KEY = $hit.Matches[0].Groups[1].Value
}
# 只报长度与来源，**不打印密钥本身**
Write-Host ("[v6] 密钥已注入子进程环境（长度 {0}，内容不打印）" -f $env:AIEVAL_PROBE_DEEPSEEK_API_KEY.Length)

$scratchHome = Join-Path $PSScriptRoot '..\dumps\v6\tmp\runner-home'
New-Item -ItemType Directory -Force -Path $scratchHome | Out-Null
$env:CODEX_HOME = (Resolve-Path -LiteralPath $scratchHome).ProviderPath
$env:HOME = $env:CODEX_HOME
$env:USERPROFILE = $env:CODEX_HOME

Push-Location $repoRoot
try {
  if ($args.Count -gt 0) { node $probeFile @args } else { node $probeFile }
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
