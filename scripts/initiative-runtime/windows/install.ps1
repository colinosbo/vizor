param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [Parameter(Mandatory)][string]$QueuePath,
    [ValidateSet('webhook', 'local')][string]$Mode = 'webhook',
    [string]$TaskPrefix
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$runtime = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -LiteralPath (Join-Path $project 'vizor.config.json') | ConvertFrom-Json
$queue = if ([IO.Path]::IsPathRooted($QueuePath)) { (Resolve-Path -LiteralPath $QueuePath).Path } else { (Resolve-Path -LiteralPath (Join-Path $project $QueuePath)).Path }
if (-not $config.repository -or $config.port -lt 1024 -or $config.port -gt 65534) { throw 'Configure a valid repository and local port before installation.' }
$null = Get-Content -Raw -LiteralPath $queue | ConvertFrom-Json
$node = (Get-Command node.exe -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
$gh = Get-Command gh.exe -ErrorAction SilentlyContinue
if (-not $gh) {
    $bundled = Join-Path $env:LOCALAPPDATA 'Programs/vizor-desktop/resources/vizor/terminal-host/github-cli/gh.exe'
    if (-not (Test-Path -LiteralPath $bundled)) { throw 'Install GitHub CLI or put gh.exe on PATH.' }
    $ghPath = $bundled
} else { $ghPath = $gh.Source }
$tunnel = $null
if ($Mode -eq 'webhook') { $tunnel = (Get-Command cloudflared.exe -ErrorAction Stop).Source }
if (-not $TaskPrefix) {
    $digest = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($project.ToLowerInvariant()))).Replace('-', '').Substring(0, 12) }
    finally { $digest.Dispose() }
    $TaskPrefix = 'Vizor ' + $key
}
if ($TaskPrefix -match '[\\/:*?"<>|]') { throw 'TaskPrefix must be a plain task name.' }
$state = Join-Path $project '.vizor'
$null = New-Item -ItemType Directory -Path $state -Force
$settingsFile = Join-Path $state 'runtime-host.json'
$settingsData = @{
    project = $project; queue = $queue; runtime = $runtime
    node = $node; git = $git; gh = $ghPath; cloudflared = $tunnel
    mode = $Mode; prefix = $TaskPrefix
}
$settingsData | ConvertTo-Json | Set-Content -LiteralPath $settingsFile -Encoding utf8
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 100 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$shell = (Get-Command powershell.exe).Source
$launcher = Join-Path $PSScriptRoot 'run.ps1'
$roles = @('Relay', 'Scheduler', 'Dashboard')
if ($Mode -eq 'webhook') { $roles += 'Webhooks' }
# Stop only this installation's tasks before replacing their launchers.
foreach ($role in @('Relay', 'Scheduler', 'Dashboard', 'Webhooks')) {
    $name = $TaskPrefix + ' ' + $role
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ScheduledTask -TaskName $name
        if ($role -eq 'Webhooks' -and $Mode -eq 'local') { Disable-ScheduledTask -TaskName $name | Out-Null }
    }
}
foreach ($role in $roles) {
    $action = New-ScheduledTaskAction -Execute $shell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$launcher`" -ProjectPath `"$project`" -Role $role" -WorkingDirectory $project
    Register-ScheduledTask -TaskName ($TaskPrefix + ' ' + $role) -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}
if ($Mode -eq 'local') {
    $data = Get-Content -Raw -LiteralPath $queue | ConvertFrom-Json
    $data | Add-Member -NotePropertyName dispatchMode -NotePropertyValue 'local' -Force
    $data | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $queue -Encoding utf8
}
foreach ($role in $roles) { Start-ScheduledTask -TaskName ($TaskPrefix + ' ' + $role) }
Write-Output ('Installed ' + $config.repository + ' runtime. Tasks restart after Windows sign-in.')
Write-Output ('Logs are in ' + $state + '. Webhook mode activates after signed diagnostics succeed.')
