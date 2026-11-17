param([Parameter(Mandatory)][string]$ProjectPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'relay-health.ps1')
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$hostConfig = Get-Content -Raw -LiteralPath (Join-Path $project '.vizor/runtime-host.json') | ConvertFrom-Json
$state = Join-Path $project '.vizor'
Set-Location -LiteralPath $project
$node = $hostConfig.node
$cloudflared = $hostConfig.cloudflared
$vizor = Join-Path $hostConfig.runtime 'scripts/vizor.mjs'
$queueFile = $hostConfig.queue
$config = Get-Content -Raw -LiteralPath (Join-Path $project 'vizor.config.json') | ConvertFrom-Json
$env:Path = (Split-Path -Parent $hostConfig.gh) + ';' + (Split-Path -Parent $hostConfig.git) + ';' + $env:Path
$env:GIT_TERMINAL_PROMPT = '0'
$log = Join-Path $state 'webhook-supervisor.log'

function Write-Status([string]$message) {
    Add-Content -LiteralPath $log -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $message)
}

while ($true) {
    $tunnel = $null
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

        $stage = 'tunnel startup'
        $output = Join-Path $state 'supervised-tunnel.out.log'
        $errors = Join-Path $state 'supervised-tunnel.err.log'
        $tunnel = Start-Process -WindowStyle Hidden -FilePath $cloudflared -ArgumentList @('tunnel','--url',"http://127.0.0.1:$($config.port)") -WorkingDirectory $project -RedirectStandardOutput $output -RedirectStandardError $errors -PassThru
        $endpoint = ''
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if ($tunnel.HasExited) { throw 'Cloudflare tunnel stopped before registration.' }
            $text = Get-Content -Raw -LiteralPath $errors -ErrorAction SilentlyContinue
            $endpoint = Get-VizorTunnelEndpoint -Text $text
            if ($endpoint) { break }
            Start-Sleep -Seconds 2
        }
        if (-not $endpoint) { throw 'Cloudflare did not publish a tunnel endpoint.' }

        # The existing queue continues until a verified endpoint is available.
        $stage = 'GitHub webhook registration'
        & $node $vizor setup $endpoint >> $log 2>&1
        if ($LASTEXITCODE) { throw 'Could not register the signed GitHub webhook.' }
        $stage = 'signed connection diagnostics'
        $healthy = $false
        for ($attempt = 0; $attempt -lt 12; $attempt++) {
            & $node $vizor doctor >> $log 2>&1
            if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
            Start-Sleep -Seconds 5
        }
        if (-not $healthy) { throw 'Signed relay and tunnel diagnostics did not pass.' }

        $stage = 'scheduler handoff'
        Stop-ScheduledTask -TaskName ($hostConfig.prefix + ' Scheduler')
        $queue = Get-Content -Raw -LiteralPath $queueFile | ConvertFrom-Json
        $queue | Add-Member -NotePropertyName dispatchMode -NotePropertyValue 'webhook' -Force
        $temporary = $queueFile + '.webhook.tmp'
        [IO.File]::WriteAllText($temporary, ($queue | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporary -Destination $queueFile -Force
        Start-ScheduledTask -TaskName ($hostConfig.prefix + ' Scheduler')
        Write-Status 'Webhook mode enabled. GitHub assignment events now call the local relay.'

        while (-not $tunnel.HasExited) {
            foreach ($name in @(($hostConfig.prefix + ' Relay'), ($hostConfig.prefix + ' Scheduler'))) {
                if ((Get-ScheduledTask -TaskName $name).State -ne 'Running') {
                    Start-ScheduledTask -TaskName $name
                    Write-Status ('Restarted ' + $name)
                }
            }
            Start-Sleep -Seconds 10
        }
        Write-Status 'Tunnel exited. Restoring a new endpoint and updating GitHub.'
    } catch {
        # Avoid logging credentials or provider URLs from native-command failures.
        Write-Status ("Webhook restoration failed during " + $stage + " (" + $_.Exception.GetType().Name + ").")
        if ($stage -eq 'tunnel startup') {
            Write-Status ("Tunnel diagnostic: " + $_.Exception.Message + " at " + $_.InvocationInfo.ScriptLineNumber)
        }
    } finally {
        if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }
        Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 15
}
