<#
Vizor 0.12.0 Windows rehearsal (PR #33). Run in Windows PowerShell:

    powershell -ExecutionPolicy Bypass -File "$HOME\Downloads\vizor-rehearsal.ps1"

Built from scripts/windows-rehearsal.ps1 in the Vizor repository (the onboarding rehearsal for a release).

What it does, on a throwaway repo only (never Vision):
  1. Installs Vizor 0.12.0 from the zip to %LOCALAPPDATA%\Vizor (adds it to your user PATH).
  2. Creates/clones the private repo colinosbo/vizor-rehearsal and connects it with a placeholder
     worker. The queue stays empty, so no worker is ever called.
  3. Runs labels, doctor, start, dashboard, stop/start, upgrade to 0.12.1-rehearsal, rollback,
     stopped-stays-stopped and the two-runner guard, and checks each result.
  4. Writes C:\Temp\vizor-rehearsal\results.txt. Paste that file back to Claude.

Vision's tasks, queue and runtime are not touched: the rehearsal project has its own task names,
and upgrades only switch projects registered with this install (just the rehearsal project).
#>
param(
    [string]$Downloads = (Join-Path $HOME 'Downloads'),
    [string]$Repo = 'colinosbo/vizor-rehearsal',
    [string]$Work = 'C:\Temp\vizor-rehearsal'
)
$ErrorActionPreference = 'Stop'
$results = New-Object System.Collections.Generic.List[string]
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$resultFile = Join-Path $Work 'results.txt'
$logFile = Join-Path $Work 'full-log.txt'
Set-Content -LiteralPath $logFile -Value ("Vizor rehearsal " + (Get-Date -Format o))

function Log([string]$text) { Add-Content -LiteralPath $logFile -Value $text; Write-Host $text }
function Check([string]$name, [bool]$ok, [string]$detail) {
    $line = $(if ($ok) { 'PASS ' } else { 'FAIL ' }) + $name + ' - ' + $detail
    $results.Add($line); Log $line
}
# Run a native command, capture all output and the exit code.
function Run([string]$exe, [string[]]$arguments, [string]$cwd) {
    Push-Location $cwd
    try {
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $out = (& $exe @arguments 2>&1 | Out-String)
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prev
    } finally { Pop-Location }
    Log ("> " + (Split-Path -Leaf $exe) + ' ' + ($arguments -join ' ') + "`n" + $out.TrimEnd() + "`n(exit $code)")
    return [pscustomobject]@{ Out = $out; Code = $code }
}
function Health([string]$project) {
    $r = Run $script:vizor @('health') $project
    try { return ($r.Out | ConvertFrom-Json) } catch { return $null }
}

try {
    # ---- Preflight ----------------------------------------------------------
    $zip1 = Join-Path $Downloads 'vizor-0.12.0.zip'
    $zip2 = Join-Path $Downloads 'vizor-0.12.1-rehearsal.zip'
    foreach ($z in @($zip1, $zip2)) { if (-not (Test-Path -LiteralPath $z)) { throw "Missing $z. Download both zips from the chat into $Downloads (or pass -Downloads)." } }
    $nodeVersion = (& node --version)
    Check 'Node.js 24' ($nodeVersion -match '^v24\.') $nodeVersion
    $gh = (Get-Command gh.exe -ErrorAction SilentlyContinue).Source
    if (-not $gh) {
        $visionHost = 'C:\Users\Colin\Projects\Vision\.vizor\runtime-host.json'
        if (Test-Path -LiteralPath $visionHost) { $gh = (Get-Content -Raw -LiteralPath $visionHost | ConvertFrom-Json).gh }
    }
    if (-not $gh -or -not (Test-Path -LiteralPath $gh)) { throw 'GitHub CLI not found. Install it: winget install --id GitHub.cli' }
    $env:Path = (Split-Path -Parent $gh) + ';' + $env:Path
    # Same credential the runner uses (Git credential manager), for this window only.
    $cred = "protocol=https`nhost=github.com`n`n" | git credential fill
    $env:GH_TOKEN = ($cred | Where-Object { $_ -like 'password=*' } | Select-Object -First 1).Substring(9)
    $login = (& $gh api user --jq .login).Trim()
    Check 'GitHub sign-in' ([bool]$login) "signed in as $login"

    # ---- 1. Install 0.12.0 from the zip, then delete the extracted folder ----
    $pkg1 = Join-Path $Work 'pkg-0.12.0'
    Remove-Item -Recurse -Force -LiteralPath $pkg1 -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $zip1 -DestinationPath $pkg1
    $r = Run 'node' @((Join-Path $pkg1 'vizor-0.12.0\setup.mjs')) $Work
    Check 'Install 0.12.0' ($r.Code -eq 0 -and $r.Out -match 'Vizor 0\.12\.0') ($r.Out.Trim() -split "`n")[0]
    Remove-Item -Recurse -Force -LiteralPath $pkg1
    $home2 = Join-Path $env:LOCALAPPDATA 'Vizor'
    $script:vizor = Join-Path $home2 'bin\vizor.cmd'
    Check 'Runs without the package or a source checkout' ((Test-Path $script:vizor) -and -not (Test-Path $pkg1)) $script:vizor
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    Check 'vizor added to user PATH' (($userPath -split ';') -contains (Join-Path $home2 'bin')) (Join-Path $home2 'bin')

    # ---- 2. Throwaway repo and connect ----------------------------------------
    $exists = $true
    try { & $gh api "repos/$Repo" --jq .full_name 2>$null | Out-Null; if ($LASTEXITCODE) { $exists = $false } } catch { $exists = $false }
    if (-not $exists) { Run $gh @('repo', 'create', $Repo, '--private', '--add-readme', '--description', 'Vizor rehearsal (safe to delete)') $Work | Out-Null }
    $project = Join-Path $Work 'project'
    if (-not (Test-Path (Join-Path $project '.git'))) { Run 'git' @('clone', "https://github.com/$Repo.git", $project) $Work | Out-Null }
    if (-not (Test-Path (Join-Path $project 'vizor.config.json'))) {
        $r = Run $script:vizor @('connect', '--repo', $Repo, '--manager', $login, '--worker', 'builder=Builder', '--port', '4490') $project
        Check 'vizor connect' ($r.Code -eq 0) 'config, queue and secrets template written'
    }
    # Placeholder worker credentials in the valid format. The queue is empty, so nothing is ever fired.
    $secretsFile = Join-Path $project '.vizor\secrets.json'
    $secrets = Get-Content -Raw -LiteralPath $secretsFile | ConvertFrom-Json
    $secrets.agents.builder = [pscustomobject]@{ fireUrl = 'https://api.anthropic.com/v1/claude_code/routines/trig_rehearsal_placeholder/fire'; token = 'rehearsal-placeholder' }
    [IO.File]::WriteAllText($secretsFile, ($secrets | ConvertTo-Json -Depth 5))
    $r = Run $script:vizor @('labels') $project
    Check 'vizor labels' ($r.Code -eq 0) $r.Out.Trim()
    $r = Run $script:vizor @('doctor') $project
    Check 'vizor doctor' ($r.Code -eq 0 -and $r.Out -notmatch 'FAIL') (($r.Out.Trim() -split "`n")[-1])

    # ---- 3. Start, dashboard, close the tab -------------------------------------
    $r = Run $script:vizor @('start') $project
    Check 'vizor start' ($r.Code -eq 0 -and $r.Out -match 'Runner is up') (($r.Out.Trim() -split "`n")[-1])
    $page = $null; try { $page = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4491/' -TimeoutSec 10 } catch { }
    Check 'Dashboard serves' ($page -and $page.StatusCode -eq 200 -and $page.Content -match 'Vizor') 'http://127.0.0.1:4491/'
    Log 'Waiting 60 seconds with no dashboard open...'
    Start-Sleep -Seconds 60
    $h = Health $project
    Check 'Runner keeps working with no dashboard' ($h -and $h.healthy) ($h.summary + ', pid ' + $h.snapshot.pid)
    $firstPid = $h.snapshot.pid

    # ---- 4. Two-runner guard -------------------------------------------------------
    $r = Run $script:vizor @('schedule', '--once') $project
    Check 'Second runner refused' ($r.Code -ne 0 -and $r.Out -match 'Another Vizor runner owns') ('exit ' + $r.Code + '; ' + ((($r.Out -split "`n") | Select-String 'Another Vizor runner owns' | Select-Object -First 1)))

    # ---- 5. Stop and start ---------------------------------------------------------------
    $r = Run $script:vizor @('stop') $project
    Start-Sleep -Seconds 3
    $tasks = @(Get-ScheduledTask | Where-Object { $_.Actions.Arguments -like "*$project*" })
    $disabled = @($tasks | Where-Object { $_.State -eq 'Disabled' }).Count
    $h = Health $project
    Check 'vizor stop' ($r.Code -eq 0 -and $tasks.Count -ge 3 -and $disabled -eq $tasks.Count -and -not $h.processAlive) ("$disabled of " + $tasks.Count + ' tasks disabled; ' + $h.summary)
    $r = Run $script:vizor @('start') $project
    Check 'vizor start after stop' ($r.Code -eq 0 -and $r.Out -match 'Runner is up') (($r.Out.Trim() -split "`n")[-1])

    # ---- 6. Upgrade to 0.12.1-rehearsal ----------------------------------------------
    $pkg2 = Join-Path $Work 'pkg-0.12.1'
    Remove-Item -Recurse -Force -LiteralPath $pkg2 -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $zip2 -DestinationPath $pkg2
    $r = Run 'node' @((Join-Path $pkg2 'vizor-0.12.1-rehearsal\setup.mjs'), '--no-path') $Work
    Check 'Upgrade 0.12.0 -> 0.12.1-rehearsal' ($r.Code -eq 0 -and $r.Out -match 'Upgraded Vizor 0\.12\.0 -> 0\.12\.1-rehearsal') (($r.Out.Trim() -split "`n") | Select-String 'Upgraded|failed' | Select-Object -First 1)
    $h = Health $project
    Check 'Runner on the new version' ($h.healthy -and $h.snapshot.executable -match '0\.12\.1-rehearsal') ($h.snapshot.executable + ', pid ' + $h.snapshot.pid)

    # ---- 7. Rollback ------------------------------------------------------------------------
    $r = Run $script:vizor @('rollback') $Work
    Check 'vizor rollback' ($r.Code -eq 0 -and $r.Out -match 'Rolled back 0\.12\.1-rehearsal -> 0\.12\.0') (($r.Out.Trim() -split "`n")[-1])
    $h = Health $project
    Check 'Runner back on 0.12.0' ($h.healthy -and $h.snapshot.executable -match '\\0\.12\.0\\') ($h.snapshot.executable + ', pid ' + $h.snapshot.pid)

    # ---- 8. A stopped project stays stopped through an upgrade ------------------------
    Run $script:vizor @('stop') $project | Out-Null
    $r = Run 'node' @((Join-Path $pkg2 'vizor-0.12.1-rehearsal\setup.mjs'), '--no-path') $Work
    Start-Sleep -Seconds 5
    $tasks = @(Get-ScheduledTask | Where-Object { $_.Actions.Arguments -like "*$project*" })
    $running = @($tasks | Where-Object { $_.State -eq 'Running' }).Count
    Check 'Stopped project stays stopped on upgrade' ($r.Code -eq 0 -and $r.Out -match 'stays stopped' -and $running -eq 0) ("$running running tasks; " + ((($r.Out.Trim() -split "`n") | Select-String 'stopped' | Select-Object -First 1)))
    $r = Run $script:vizor @('start') $project
    $h = Health $project
    Check 'Start again on 0.12.1-rehearsal' ($r.Code -eq 0 -and $h.healthy -and $h.snapshot.executable -match '0\.12\.1-rehearsal') ($h.summary)
    Remove-Item -Recurse -Force -LiteralPath $pkg2

    $r = Run $script:vizor @('versions') $project
    Log $r.Out
} catch {
    $results.Add('FAIL Script stopped - ' + $_.Exception.Message)
    Log ('FAIL Script stopped - ' + $_.Exception.Message)
} finally {
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    $summary = @(
        'Vizor 0.12.0 Windows rehearsal - ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'),
        ('Passed ' + @($results | Where-Object { $_ -like 'PASS*' }).Count + ' of ' + $results.Count),
        ''
    ) + $results + @(
        '',
        'Still manual: sign out and back in (or reboot), then in a new terminal run:',
        "  cd $Work\project; vizor health    -> expect `"healthy`": true within 2 minutes",
        "Full log: $logFile",
        '',
        "Cleanup when done (optional): cd $Work\project; vizor stop",
        '  then delete the rehearsal repo on GitHub (Settings > Delete) and the rehearsal folder.'
    )
    Set-Content -LiteralPath $resultFile -Value $summary
    Write-Host ''
    $summary | ForEach-Object { Write-Host $_ }
    Write-Host ''
    Write-Host "Paste the contents of $resultFile back to Claude." -ForegroundColor Cyan
}
