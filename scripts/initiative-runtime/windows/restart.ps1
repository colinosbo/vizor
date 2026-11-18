param([Parameter(Mandatory)][string]$ProjectPath, [Parameter(Mandatory)][string]$ExpectedExecutable)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$digest = [Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($project.ToLowerInvariant()))).Replace('-', '') } finally { $digest.Dispose() }
$mutex = New-Object Threading.Mutex($false, ('Local\VizorRestart-' + $key))
# Capture the prior generation before waiting for the lock. Clock changes and
# millisecond timestamp rounding must never mistake an old process for a restart.
$initialGeneration = $null
try {
  $beforeHost = Get-Content -Raw -LiteralPath (Join-Path $project '.vizor/runtime-host.json') | ConvertFrom-Json
  if ([IO.Path]::IsPathRooted($beforeHost.queue) -and ([IO.Path]::GetFullPath($beforeHost.queue)).StartsWith($project + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    $initialGeneration = (Get-Content -Raw -LiteralPath ($beforeHost.queue + '.snapshot.json') | ConvertFrom-Json).startId
  }
} catch { }
$owned = $false
try {
  try { $owned = $mutex.WaitOne(90000) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { throw 'Another restart still holds this project lock.' }
  $hostData = Get-Content -Raw -LiteralPath (Join-Path $project '.vizor/runtime-host.json') | ConvertFrom-Json
  if ([IO.Path]::GetFullPath($hostData.project) -ine $project) { throw 'Installed project mismatch.' }
  if (-not [IO.Path]::IsPathRooted($hostData.queue)) { throw 'Installed queue must be absolute; reinstall this host.' }
  $queue = [IO.Path]::GetFullPath($hostData.queue)
  if (-not $queue.StartsWith($project + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed queue is outside this project.' }
  $script = [IO.Path]::GetFullPath((Join-Path $hostData.runtime 'scripts/vizor.mjs'))
  if ($script -ine [IO.Path]::GetFullPath($ExpectedExecutable)) { throw 'Installed runtime executable mismatch.' }
  $launcher = Join-Path $hostData.runtime 'windows/hidden-run.vbs'
  $run = Join-Path $hostData.runtime 'windows/run.ps1'
  $taskName = $hostData.prefix + ' Scheduler'
  $task = Get-ScheduledTask -TaskName $taskName
  $expectedArgs = '//B //Nologo "' + $launcher + '" "' + $project + '" "Scheduler"'
  if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32\wscript.exe') -or $task.Actions[0].Arguments -ine $expectedArgs -or $task.Actions[0].WorkingDirectory -ine $project) { throw 'Installed scheduler action does not exactly match this project/runtime.' }
  function Tokens($text) { @([regex]::Matches($text, '"([^"]*)"|(\S+)') | ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } }) }
  function Schedulers {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $parts = Tokens $_.CommandLine
      $_.ExecutablePath -ieq $hostData.node -and $parts.Count -eq 4 -and $parts[1] -ieq $script -and $parts[2] -eq 'schedule' -and [IO.Path]::IsPathRooted($parts[3]) -and [IO.Path]::GetFullPath($parts[3]) -ieq $queue
    })
  }
  $prior = @(Schedulers)
  Write-Output ('Matching schedulers before restart: ' + ((@($prior | ForEach-Object { $_.ProcessId })) -join ',') + '; prior generation ' + $initialGeneration)
  $snapshotFile = $queue + '.snapshot.json'
  # Without a generation captured before waiting, never infer that another caller restarted.
  if ($null -ne $initialGeneration -and $prior.Count -eq 1 -and (Test-Path -LiteralPath $snapshotFile)) {
    try {
      $previous = Get-Content -Raw -LiteralPath $snapshotFile | ConvertFrom-Json
      if ($previous.pid -eq $prior[0].ProcessId -and $previous.startId -and $previous.startId -ne $initialGeneration) {
        Write-Output ('Concurrent restart already completed: PID ' + $previous.pid); exit 0
      }
    } catch { }
  }
  Stop-ScheduledTask -TaskName $taskName
  # Stop only exact hidden supervisors before children, so the old parent cannot
  # respawn its node between killing it and starting the replacement.
  foreach ($proc in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'")) {
    $parts = Tokens $proc.CommandLine
    $i = [Array]::IndexOf($parts, '-File'); $p = [Array]::IndexOf($parts, '-ProjectPath'); $r = [Array]::IndexOf($parts, '-Role')
    if ($i -ge 0 -and $p -ge 0 -and $r -ge 0 -and $parts[$i+1] -ieq $run -and $parts[$p+1] -ieq $project -and $parts[$r+1] -eq 'Scheduler') { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  foreach ($proc in @(Schedulers)) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($old in $prior) { try { Wait-Process -Id $old.ProcessId -Timeout 15 -ErrorAction Stop } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { } }
  if (@($prior | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count -ne 0 -or @(Schedulers).Count -ne 0) { throw 'Old scheduler still present; replacement was not started.' }
  Start-ScheduledTask -TaskName $taskName
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 300
    $nodes = @(Schedulers)
    if ($nodes.Count -gt 1) { throw 'Multiple matching scheduler processes; investigate before retrying.' }
    if ($nodes.Count -eq 1) {
      $snapshotFile = $queue + '.snapshot.json'
      if (Test-Path -LiteralPath $snapshotFile) {
        try { $snapshot = Get-Content -Raw -LiteralPath $snapshotFile | ConvertFrom-Json; if ($snapshot.pid -eq $nodes[0].ProcessId -and $snapshot.startId) { Write-Output ('Scheduler restarted: PID ' + $snapshot.pid); exit 0 } } catch { }
      }
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Replacement scheduler did not publish its own heartbeat within 45 seconds.'
} catch { Write-Output $_.Exception.Message; exit 1 }
finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
