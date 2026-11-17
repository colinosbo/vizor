param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [Parameter(Mandatory)][ValidateSet('Relay','Scheduler','Dashboard','Webhooks')][string]$Role
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
Set-Location -LiteralPath $project
$hostConfig = Get-Content -Raw -LiteralPath (Join-Path $project '.vizor/runtime-host.json') | ConvertFrom-Json
$env:Path = (Split-Path -Parent $hostConfig.gh) + ';' + (Split-Path -Parent $hostConfig.git) + ';' + $env:Path
$env:GIT_TERMINAL_PROMPT = '0'
$vizor = Join-Path $hostConfig.runtime 'scripts/vizor.mjs'
$log = Join-Path $project ('.vizor/host-' + $Role.ToLowerInvariant() + '.log')
try {
    if ($Role -ne 'Relay') {
        $credential = "protocol=https`nhost=github.com`n`n" | & $hostConfig.git credential fill 2>$null
        $password = $credential | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
        if (-not $password) { throw 'No GitHub Git credential is available for this Windows identity.' }
        $env:GH_TOKEN = $password.Substring(9)
    }
    # Native stderr is a log stream. The process exit code determines failure.
    $ErrorActionPreference = 'Continue'
    switch ($Role) {
        'Relay' { & $hostConfig.node $vizor serve >> $log 2>&1; exit $LASTEXITCODE }
        'Scheduler' { & $hostConfig.node $vizor schedule $hostConfig.queue >> $log 2>&1; exit $LASTEXITCODE }
        'Dashboard' { & $hostConfig.node $vizor dashboard $hostConfig.queue >> $log 2>&1; exit $LASTEXITCODE }
        'Webhooks' { & (Join-Path $PSScriptRoot 'supervise-webhooks.ps1') -ProjectPath $project; exit $LASTEXITCODE }
    }
} catch {
    Add-Content -LiteralPath $log -Value ((Get-Date).ToUniversalTime().ToString('o') + ' Runtime startup failed (' + $_.Exception.GetType().Name + '). Check setup and credential availability.')
    exit 1
} finally {
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
}
