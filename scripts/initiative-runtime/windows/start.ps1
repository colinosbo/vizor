param([Parameter(Mandatory)][string]$ProjectPath)
# Enable and start this project's installed runtime roles. The scheduler's queue
# lease still guarantees a single dispatcher if one is already running.
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$hostData = Get-Content -Raw -LiteralPath (Join-Path $project '.vizor/runtime-host.json') | ConvertFrom-Json
if ([IO.Path]::GetFullPath($hostData.project) -ine $project) { throw 'Installed project mismatch.' }
$roles = @('Relay', 'Scheduler', 'Dashboard')
if ($hostData.mode -eq 'webhook') { $roles += 'Webhooks' }
foreach ($role in $roles) {
    $name = $hostData.prefix + ' ' + $role
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { throw ('Task missing: ' + $name + '. Reinstall with vizor start --reinstall.') }
    Enable-ScheduledTask -TaskName $name | Out-Null
    if ((Get-ScheduledTask -TaskName $name).State -ne 'Running') { Start-ScheduledTask -TaskName $name }
}
Remove-Item -LiteralPath (Join-Path $project '.vizor/stopped') -ErrorAction SilentlyContinue
Write-Output ('Started ' + ($roles -join ', ') + '.')
