param([Parameter(Mandatory)][string]$ProjectPath, [switch]$Disable)
# Stop this project's runtime roles and their exact processes, from any installed
# version. Other projects, workers and unrelated PowerShell/Node are untouched.
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$hostFile = Join-Path $project '.vizor/runtime-host.json'
if (-not (Test-Path -LiteralPath $hostFile)) { Write-Output 'Not installed for this project; nothing to stop.'; exit 0 }
$hostData = Get-Content -Raw -LiteralPath $hostFile | ConvertFrom-Json
if ([IO.Path]::GetFullPath($hostData.project) -ine $project) { throw 'Installed project mismatch.' }
foreach ($role in @('Webhooks', 'Scheduler', 'Dashboard', 'Relay')) {
    $task = Get-ScheduledTask -TaskName ($hostData.prefix + ' ' + $role) -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $task.TaskName
        if ($Disable) { Disable-ScheduledTask -TaskName $task.TaskName | Out-Null }
    }
}
function Tokens($text) { @([regex]::Matches([string]$text, '"([^"]*)"|(\S+)') | ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } }) }
# Hidden supervisors: powershell.exe -File <any runtime>\windows\run.ps1 -ProjectPath <this project> -Role <role>
$parents = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $parts = Tokens $_.CommandLine
    $i = [Array]::IndexOf($parts, '-File'); $p = [Array]::IndexOf($parts, '-ProjectPath')
    $i -ge 0 -and $p -ge 0 -and (Split-Path -Leaf $parts[$i+1]) -ieq 'run.ps1' -and (Split-Path -Leaf (Split-Path -Parent $parts[$i+1])) -ieq 'windows' -and [IO.Path]::GetFullPath($parts[$p+1]) -ieq $project
})
$parentIds = @($parents | ForEach-Object { $_.ProcessId })
$children = @(Get-CimInstance Win32_Process | Where-Object { $parentIds -contains $_.ParentProcessId -and $_.Name -ieq 'node.exe' })
# The scheduler recorded in the heartbeat, if it is a vizor.mjs node process.
$recorded = @()
try {
    $snap = Get-Content -Raw -LiteralPath ($hostData.queue + '.snapshot.json') | ConvertFrom-Json
    $recorded = @(Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$snap.pid) | Where-Object { $_.Name -ieq 'node.exe' -and $_.CommandLine -match 'vizor\.mjs"?\s+schedule' })
} catch { }
# Parents first so they cannot respawn a child we are about to stop.
foreach ($proc in $parents) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
$targets = @($children + $recorded)
foreach ($proc in $targets) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
# Poll for exit (up to 15 seconds); termination is asynchronous on Windows.
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
    $left = @(@($parents + $targets) | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    if ($left.Count) { Start-Sleep -Milliseconds 250 }
} while ($left.Count -and [DateTime]::UtcNow -lt $deadline)
if ($left.Count) { throw ('Runtime processes still running: ' + (($left | ForEach-Object { $_.ProcessId }) -join ',')) }
# Remember the stop so upgrades and rollbacks keep this project stopped.
if ($Disable) { [IO.File]::WriteAllText((Join-Path $project '.vizor/stopped'), [DateTime]::UtcNow.ToString('o')) }
Write-Output ('Stopped ' + $parents.Count + ' supervisor(s) and ' + $targets.Count + ' runtime process(es)' + $(if ($Disable) { '; tasks disabled until vizor start.' } else { '.' }))
