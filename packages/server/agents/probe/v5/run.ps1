# v5 探针的运行外壳：把 DeepSeek 密钥从凭据库注入**子进程环境**，再跑探针脚本。
#
# 为什么要这一层：
#   · 密钥绝不能写进仓库任何文件、也不能打印 ⇒ 只在 PowerShell 变量与子进程环境里流转；
#   · `codex app-server` 的 provider 用 `env_key = 'OPENAI_API_KEY'` 取 Bearer
#     ⇒ 探针会把它放进 app-server 子进程环境（值不落盘）；
#   · 顺带给探针设一个**明确的** `CODEX_HOME`（探针内部还会逐 case 覆盖成工作区内的 scratch）。
#
# 用法：powershell -NoProfile -File packages\server\agents\probe\v5\run.ps1
# （本机没有 pwsh 7，只有 Windows PowerShell 5.1 ⇒ 脚本只用 5.1 有的语法）
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..\..\..')).ProviderPath
$probeFile = Join-Path $PSScriptRoot 'codex-appserver-reasoning.mjs'

if ([string]::IsNullOrWhiteSpace($env:AIEVAL_PROBE_DEEPSEEK_API_KEY)) {
  $credFile = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
  if (-not (Test-Path -LiteralPath $credFile)) { throw "拿不到 DeepSeek 凭据：设 AIEVAL_PROBE_DEEPSEEK_API_KEY，或提供 $credFile" }
  # 凭据文件里是 YAML 缩进映射：`  DEEPSEEK_API_KEY: sk-…`
  $hit = Select-String -LiteralPath $credFile -Pattern '^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$' | Select-Object -First 1
  if ($null -eq $hit) { throw "$credFile 里没有 DEEPSEEK_API_KEY" }
  $env:AIEVAL_PROBE_DEEPSEEK_API_KEY = $hit.Matches[0].Groups[1].Value
}
# 只报长度与来源，**不打印密钥本身**
Write-Host ("[v5] 密钥已注入子进程环境（长度 {0}，内容不打印）" -f $env:AIEVAL_PROBE_DEEPSEEK_API_KEY.Length)

# `$CODEX_HOME` 与 scratch 都在工作区内（%TEMP% 会以 os error 5 失败）
$scratchHome = Join-Path $PSScriptRoot '..\dumps\v5\tmp\runner-home'
New-Item -ItemType Directory -Force -Path $scratchHome | Out-Null
$env:CODEX_HOME = (Resolve-Path -LiteralPath $scratchHome).ProviderPath
$env:HOME = $env:CODEX_HOME
$env:USERPROFILE = $env:CODEX_HOME

Push-Location $repoRoot
try {
  node $probeFile
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
