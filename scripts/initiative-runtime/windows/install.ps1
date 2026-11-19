param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [Parameter(Mandatory)][string]$QueuePath,
    [ValidateSet('webhook', 'local')][string]$Mode = 'local',
    # Webhook mode only: the public HTTPS URL that forwards to this relay
    # (a reverse proxy or a tunnel you operate). Vizor does not start one.
    [string]$WebhookUrl,
    [string]$TaskPrefix,
    # Register (or re-register on upgrade) but leave the tasks disabled and not
    # running, for a project the user stopped with `vizor stop`.
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$runtime = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -LiteralPath (Join-Path $project 'vizor.config.json') | ConvertFrom-Json
$queue = if ([IO.Path]::IsPathRooted($QueuePath)) { (Resolve-Path -LiteralPath $QueuePath).Path } else { (Resolve-Path -LiteralPath (Join-Path $project $QueuePath)).Path }
if (-not $config.repository -or $config.port -lt 1024 -or $config.port -gt 65534) { throw 'Configure a valid repository and local port before installation.' }
$null = Get-Content -Raw -LiteralPath $queue | ConvertFrom-Json
$node = (Get-Command node.exe -ErrorAction Stop).Source
if ((& $node --version) -notmatch '^v24\.') { throw 'Vizor runtime requires Node.js 24.' }
$git = (Get-Command git.exe -ErrorAction Stop).Source
$gh = Get-Command gh.exe -ErrorAction SilentlyContinue
$previousHost = Join-Path $project '.vizor/runtime-host.json'
if ($gh) { $ghPath = $gh.Source }
elseif ((Test-Path -LiteralPath $previousHost) -and ($recorded = (Get-Content -Raw -LiteralPath $previousHost | ConvertFrom-Json).gh) -and (Test-Path -LiteralPath $recorded)) {
    # Keep the GitHub CLI this project already runs with (for example one bundled by an earlier install).
    $ghPath = $recorded
} else { throw 'GitHub CLI not found. Install it with: winget install --id GitHub.cli  (then open a new terminal).' }
if ($Mode -eq 'webhook') {
    if (-not $WebhookUrl) { throw 'Webhook mode needs -WebhookUrl with the public HTTPS URL that forwards to the relay. Use -Mode local otherwise.' }
    $parsed = $null
    if (-not [Uri]::TryCreate($WebhookUrl, [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -ne 'https' -or $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment -or $parsed.IsLoopback) {
        throw 'WebhookUrl must be a public HTTPS URL without credentials, query or loopback host.'
    }
} else { $WebhookUrl = $null }
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
    node = $node; git = $git; gh = $ghPath; webhookUrl = $WebhookUrl
    mode = $Mode; prefix = $TaskPrefix
}
[IO.File]::WriteAllText($settingsFile, ($settingsData | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 100 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$shell = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher = Join-Path $PSScriptRoot 'hidden-run.vbs'
$roles = @('Relay', 'Scheduler', 'Dashboard')
if ($Mode -eq 'webhook') { $roles += 'Webhooks' }
# Updating launch actions must not interrupt running instances or orphan their
# child processes. The new hidden launcher applies on the next start/sign-in.
foreach ($role in @('Relay', 'Scheduler', 'Dashboard', 'Webhooks')) {
    $name = $TaskPrefix + ' ' + $role
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
        if ($role -eq 'Webhooks' -and $Mode -eq 'local') {
            Stop-ScheduledTask -TaskName $name
            Disable-ScheduledTask -TaskName $name | Out-Null
        }
    }
}
foreach ($role in $roles) {
    $action = New-ScheduledTaskAction -Execute $shell -Argument "//B //Nologo `"$launcher`" `"$project`" `"$role`"" -WorkingDirectory $project
    Register-ScheduledTask -TaskName ($TaskPrefix + ' ' + $role) -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}
if ($Mode -eq 'local') {
    $data = Get-Content -Raw -LiteralPath $queue | ConvertFrom-Json
    $data | Add-Member -NotePropertyName dispatchMode -NotePropertyValue 'local' -Force
    [IO.File]::WriteAllText($queue, ($data | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
}
foreach ($role in $roles) {
    $name = $TaskPrefix + ' ' + $role
    if ($NoStart) { Disable-ScheduledTask -TaskName $name | Out-Null }
    elseif ((Get-ScheduledTask -TaskName $name).State -ne 'Running') { Start-ScheduledTask -TaskName $name }
}
if ($NoStart) {
    Write-Output ('Installed ' + $config.repository + ' runtime, left stopped. Run vizor start to start it.')
    exit 0
}
Write-Output ('Installed ' + $config.repository + ' runtime. Tasks restart after Windows sign-in.')
if ($Mode -eq 'local') {
    Write-Output ('Logs are in ' + $state + '. Local dispatch calls workers directly; no public endpoint is required.')
} else {
    Write-Output ('Logs are in ' + $state + '. Webhook mode activates after signed diagnostics succeed.')
}
