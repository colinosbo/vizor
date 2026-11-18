param([Parameter(Mandatory)][string]$ProjectPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'relay-health.ps1')
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$hostConfig = Get-Content -Raw -LiteralPath (Join-Path $project '.vizor/runtime-host.json') | ConvertFrom-Json
$state = Join-Path $project '.vizor'
Set-Location -LiteralPath $project
$node = $hostConfig.node
$endpoint = $hostConfig.webhookUrl
$vizor = Join-Path $hostConfig.runtime 'scripts/vizor.mjs'
$queueFile = $hostConfig.queue
$config = Get-Content -Raw -LiteralPath (Join-Path $project 'vizor.config.json') | ConvertFrom-Json
$env:Path = (Split-Path -Parent $hostConfig.gh) + ';' + (Split-Path -Parent $hostConfig.git) + ';' + $env:Path
$env:GIT_TERMINAL_PROMPT = '0'
$log = Join-Path $state 'webhook-supervisor.log'

function Write-Status([string]$message) {
    Add-Content -LiteralPath $log -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $message)
}

function Invoke-VizorDoctor {
    & $node $vizor doctor >> $log 2>&1
    return $LASTEXITCODE -eq 0
}

if (-not $endpoint) {
    Write-Status 'Webhook mode has no public URL. Reinstall with -WebhookUrl or use -Mode local.'
    exit 1
}

# Vizor does not start a tunnel. The operator's public HTTPS URL must forward
# to the local relay; this supervisor registers it, verifies a signed ping end
# to end, and only then hands the scheduler over to webhook dispatch.
while ($true) {
    $stage = 'GitHub sign-in'
    try {
        $credential = "protocol=https`nhost=github.com`n`n" | git.exe credential fill 2>$null
        $password = $credential | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
        if (-not $password) { throw 'GitHub sign-in is unavailable for this Windows account.' }
        $env:GH_TOKEN = $password.Substring(9)

        $stage = 'local relay health'
        $relay = Get-ScheduledTask -TaskName ($hostConfig.prefix + ' Relay')
        if ($relay.State -ne 'Running') { Start-ScheduledTask -TaskName $relay.TaskName }
        $relayReady = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $relayReady = Test-VizorRelay -Port $config.port
            if ($relayReady) { break }
            Start-Sleep -Seconds 2
        }
        if (-not $relayReady) { throw 'Local relay did not become ready.' }

        # The existing queue continues in its current mode until the endpoint verifies.
        $stage = 'GitHub webhook registration'
        & $node $vizor setup $endpoint >> $log 2>&1
        if ($LASTEXITCODE) { throw 'Could not register the signed GitHub webhook.' }
        $stage = 'signed connection diagnostics'
        $healthy = $false
        for ($attempt = 0; $attempt -lt 12; $attempt++) {
            if (Invoke-VizorDoctor) { $healthy = $true; break }
            Start-Sleep -Seconds 5
        }
        if (-not $healthy) { throw 'Signed relay and public endpoint diagnostics did not pass.' }

        $stage = 'scheduler handoff'
        $queue = Get-Content -Raw -LiteralPath $queueFile | ConvertFrom-Json
        if ($queue.dispatchMode -ne 'webhook') {
            Stop-ScheduledTask -TaskName ($hostConfig.prefix + ' Scheduler')
            $queue | Add-Member -NotePropertyName dispatchMode -NotePropertyValue 'webhook' -Force
            $temporary = $queueFile + '.webhook.tmp'
            [IO.File]::WriteAllText($temporary, ($queue | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
            Move-Item -LiteralPath $temporary -Destination $queueFile -Force
            Start-ScheduledTask -TaskName ($hostConfig.prefix + ' Scheduler')
        }
        Write-Status 'Webhook mode enabled. GitHub assignment events now call the local relay.'

        # Keep the relay and scheduler running, and re-verify the public path.
        # A failed check re-enters registration; the scheduler already holds
        # dispatch while the endpoint is unreachable.
        $stage = 'endpoint monitoring'
        $checks = 0
        while ($true) {
            foreach ($name in @(($hostConfig.prefix + ' Relay'), ($hostConfig.prefix + ' Scheduler'))) {
                if ((Get-ScheduledTask -TaskName $name).State -ne 'Running') {
                    Start-ScheduledTask -TaskName $name
                    Write-Status ('Restarted ' + $name)
                }
            }
            Start-Sleep -Seconds 10
            $checks++
            if ($checks -ge 30) {
                $checks = 0
                if (-not (Invoke-VizorDoctor)) { throw 'Public endpoint check failed.' }
            }
        }
    } catch {
        # Avoid logging credentials or provider URLs from native-command failures.
        Write-Status ("Webhook restoration failed during " + $stage + " (" + $_.Exception.GetType().Name + ").")
    } finally {
        Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 15
}
