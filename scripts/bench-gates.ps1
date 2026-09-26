# 质量门禁耗时测量：依次跑 test / typecheck / lint（与 CI 同一条命令），打印各自墙钟时间。
#
# 用法（在仓库根）：
#   powershell -NoProfile -File scripts/bench-gates.ps1
#   powershell -NoProfile -File scripts/bench-gates.ps1 -Runs 3 -SkipTest
#
# 为什么要有这个脚本：本仓三条聚合命令的耗时**主要由进程创建决定**，而本机的
# CreateProcess 极贵（企业杀软收税，实测 cmd /c exit 0 250ms、git --version 350ms）。
# 于是「跑一次门禁」与「这台机器此刻有多少别的负载」强相关——本文件的数字只在
# 同一台机器、同一批并发负载下横向可比。跑之前先看眼任务管理器/`Get-Process node`。
param(
  [switch]$SkipTest,
  [switch]$SkipTypecheck,
  [switch]$SkipLint,
  [int]$Runs = 1
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Invoke-Gate {
  param([string]$Label, [string]$Command)
  $times = @()
  $failed = $false
  for ($i = 1; $i -le $Runs; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $out = Invoke-Expression "$Command 2>&1" | Out-String
    $code = $LASTEXITCODE
    $sw.Stop()
    $times += $sw.Elapsed.TotalSeconds
    if ($code -ne 0) { $failed = $true }
    Write-Host ("[{0}] run {1}: {2:N2}s (exit {3})" -f $Label, $i, $sw.Elapsed.TotalSeconds, $code)
    if ($code -ne 0) {
      # 失败时只贴尾部：完整输出太长，而这里要的是「红在哪」而不是全部日志
      ($out -split "`n" | Select-Object -Last 30) | ForEach-Object { Write-Host "    $_" }
    }
  }
  if ($times.Count -gt 1) {
    $min = ($times | Measure-Object -Minimum).Minimum
    $max = ($times | Measure-Object -Maximum).Maximum
    Write-Host ("[{0}] min {1:N2}s / max {2:N2}s" -f $Label, $min, $max)
  }
  if ($failed) { return 1 }
  return 0
}

$results = [ordered]@{}
if (-not $SkipTest) { $results['test'] = Invoke-Gate -Label 'test' -Command 'pnpm test' }
if (-not $SkipTypecheck) { $results['typecheck'] = Invoke-Gate -Label 'typecheck' -Command 'pnpm typecheck' }
if (-not $SkipLint) { $results['lint'] = Invoke-Gate -Label 'lint' -Command 'pnpm lint' }

Write-Host '--- summary ---'
foreach ($key in $results.Keys) { Write-Host ("{0,-10} exit={1}" -f $key, $results[$key]) }
if (($results.Values | Where-Object { $_ -ne 0 }).Count -gt 0) { exit 1 }
