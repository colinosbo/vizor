param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [Parameter(Mandatory)][ValidateSet('Relay','Scheduler','Dashboard','Webhooks')][string]$Role
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
Set-Location -LiteralPath $project
$log = Join-Path $project ('.vizor/host-' + $Role.ToLowerInvariant() + '.log')
# Preserve historical Windows PowerShell UTF-16 logs verbatim before UTF-8 append.
if (Test-Path -LiteralPath $log) {
  $bytes = [IO.File]::ReadAllBytes($log)
  if ($bytes.Length -ge 2 -and (($bytes[0] -eq 255 -and $bytes[1] -eq 254) -or ($bytes[0] -eq 254 -and $bytes[1] -eq 255))) {
    Move-Item -LiteralPath $log -Destination ($log + '.utf16-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffff') + '.log')
  }
}
function Write-VizorLog($line) {
  $text = [string]$line
  if ($env:GH_TOKEN) { $text = $text.Replace($env:GH_TOKEN, '[redacted]') }
  $text = [regex]::Replace($text, '(?i)(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+)', '[redacted]')
  if ($text -notmatch '^\d{4}-\d{2}-\d{2}T') { $text = [DateTime]::UtcNow.ToString('o') + ' ' + $text }
  [IO.File]::AppendAllText($log, $text + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}
$basePath = $env:Path
$retrySeconds = 2
# Keep supervision inside the hidden parent. Task Scheduler's restart setting
# does not reliably restart a child that exits with a nonzero process code.
while ($true) {
  $startedAt = [DateTime]::UtcNow
  try {
    $ErrorActionPreference = 'Stop'
    $hostConfig = Get-Content -Raw -LiteralPath (Join-Path $project '.vizor/runtime-host.json') | ConvertFrom-Json
    if ($Role -eq 'Webhooks' -and $hostConfig.mode -ne 'webhook') { exit 0 }
    $env:Path = (Split-Path -Parent $hostConfig.gh) + ';' + (Split-Path -Parent $hostConfig.git) + ';' + $basePath
    $env:GIT_TERMINAL_PROMPT = '0'
    $vizor = Join-Path $hostConfig.runtime 'scripts/vizor.mjs'
    if ($Role -ne 'Relay') {
        $credential = "protocol=https`nhost=github.com`n`n" | & $hostConfig.git credential fill 2>$null
        $password = $credential | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
        if (-not $password) { throw 'No GitHub Git credential is available for this Windows identity.' }
        $env:GH_TOKEN = $password.Substring(9)
    }
    # Native stderr is a log stream. The process exit code determines failure.
    $ErrorActionPreference = 'Continue'
    switch ($Role) {
        'Relay' { & $hostConfig.node $vizor serve 2>&1 | ForEach-Object { Write-VizorLog $_ } }
        'Scheduler' { & $hostConfig.node $vizor schedule $hostConfig.queue 2>&1 | ForEach-Object { Write-VizorLog $_ } }
        'Dashboard' { & $hostConfig.node $vizor dashboard $hostConfig.queue 2>&1 | ForEach-Object { Write-VizorLog $_ } }
        'Webhooks' { & (Join-Path $PSScriptRoot 'supervise-webhooks.ps1') -ProjectPath $project }
    }
  } catch {
    Write-VizorLog ((Get-Date).ToUniversalTime().ToString('o') + ' Runtime startup failed (' + $_.Exception.GetType().Name + '). Check setup and credential availability.')
  } finally {
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  }
  if (([DateTime]::UtcNow - $startedAt).TotalSeconds -ge 60) { $retrySeconds = 2 }
  Add-Content -LiteralPath $log -Value ((Get-Date).ToUniversalTime().ToString('o') + ' Runtime process stopped; retrying in ' + $retrySeconds + ' seconds.')
  Start-Sleep -Seconds $retrySeconds
  $retrySeconds = [Math]::Min(60, $retrySeconds * 2)
}
