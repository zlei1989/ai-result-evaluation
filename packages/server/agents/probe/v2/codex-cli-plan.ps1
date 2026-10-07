# codex 真机项①（CLI 直跑）：`update_plan` / `request_user_input` 落到哪个 `item.type`。
#
# 为什么必须用 pwsh 自己的管道而不是 node 的 execFileSync：
# 本机对「经 node 的管道捕获子进程输出」这一形态有硬边界——codex 会以
# `failed to initialize in-process app-server client: 拒绝访问。(os error 5)` 收场，
# 而 PowerShell 自己的管道不受影响。这是**探测方式**的约束，不是厂商行为。
#
# 用法：pwsh -File probe/v2/codex-cli-plan.ps1

$ErrorActionPreference = 'Continue'

$repo = 'D:\zhanglei1120\Github\ai-result-evaluation'
$codex = Join-Path $repo 'node_modules\.pnpm\@openai+codex@0.156.1-win32-x64\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
$dumps = Join-Path $repo 'packages\server\agents\probe\dumps\v2'
New-Item -ItemType Directory -Path $dumps -Force | Out-Null

$ws = Join-Path $env:TEMP ('aieval-v2-codex-cli-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $ws -Force | Out-Null
Set-Content -Path (Join-Path $ws 'notes.txt') -Value "alpha`nbeta`ngamma" -Encoding utf8
Set-Content -Path (Join-Path $ws 'app.js') -Value "function greet(name) { return 'hello ' + name; }" -Encoding utf8

$codexHome = Join-Path $ws 'codex-home'
New-Item -ItemType Directory -Path $codexHome -Force | Out-Null

$env:CODEX_HOME = $codexHome
$env:CODEX_API_KEY = $env:AIEVAL_PROBE_GATEWAY_API_KEY
if ([string]::IsNullOrWhiteSpace($env:CODEX_API_KEY)) {
  throw 'AIEVAL_PROBE_GATEWAY_API_KEY 未设置：本脚本原先硬编码了一把明文网关密钥（已进 git 历史 ⇒ 必须轮换）；现在改为从环境变量读，不再落盘密钥。'
}
$gw = 'http://likecode-llm-proxy-test.jd.com/v1'

$prompt = '这是一个多步任务：请先调用 update_plan 工具提交一份三步计划（第一步 in_progress、其余 pending），然后读取 notes.txt、统计行数、把行数写进 answer.txt，每完成一步用 update_plan 更新状态，最后汇报一句。'

$args = @(
  'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', 'GPT-5.5',
  '-c', 'model_provider=aieval',
  '-c', 'model_providers.aieval.name=aieval',
  '-c', "model_providers.aieval.base_url=$gw",
  '-c', 'model_providers.aieval.wire_api=responses',
  '-c', 'model_providers.aieval.requires_openai_auth=true',
  '-c', 'model_providers.aieval.request_max_retries=1',
  '-c', 'tools.update_plan.enabled=true',
  '-c', 'tools.experimental_request_user_input.enabled=true',
  '-c', 'features.default_mode_request_user_input=true',
  $prompt
)

$outFile = Join-Path $dumps 'codex-cli-plan.stdout.jsonl'
$errFile = Join-Path $dumps 'codex-cli-plan.stderr.txt'

Push-Location $ws
& $codex @args 1> $outFile 2> $errFile
$exit = $LASTEXITCODE
Pop-Location

Write-Output "workspace=$ws"
Write-Output "exit=$exit"
Write-Output "stdout lines=$((Get-Content $outFile -ErrorAction SilentlyContinue | Measure-Object).Count)"
Write-Output "--- stderr (前 400 字) ---"
(Get-Content $errFile -Raw -ErrorAction SilentlyContinue) -split "`n" | Select-Object -First 8
