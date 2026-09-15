param([switch]$ResetToken, [switch]$CheckConnection)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$env:NODE_NO_WARNINGS = '1'
$taskData = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskTokenFile = Join-Path $taskData 'telegram-token.xml'
$taskAvitoIdFile = Join-Path $taskData 'avito-client-id.txt'
$taskAvitoSecretFile = Join-Path $taskData 'avito-client-secret.xml'
$taskNode = Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $taskNode) {
    $taskBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $taskBundledNode) { $taskNode = $taskBundledNode }
}
if (-not $taskNode) { throw 'Node.js 24+ is required. https://nodejs.org/' }
$taskVersion = & $taskNode -p 'parseInt(process.versions.node)'
if ([int]$taskVersion -lt 24) { throw 'Node.js 24+ is required.' }
. (Join-Path $PSScriptRoot 'network.ps1')
if ($ResetToken -or -not (Test-Path -LiteralPath $taskTokenFile)) {
    Write-Host 'Paste the Telegram bot token from @BotFather. Input is hidden.'
    Write-Host 'The token is encrypted for your Windows user on this computer.'
    $taskSecret = Read-Host 'Bot token' -AsSecureString
    if ($taskSecret.Length -eq 0) { throw 'Token is empty.' }
    $taskSecret | Export-Clixml -LiteralPath $taskTokenFile
}
if (-not (Test-Path -LiteralPath $taskAvitoIdFile) -or -not (Test-Path -LiteralPath $taskAvitoSecretFile)) {
    Write-Host 'Avito API (optional now; required for auto-import). Leave blank to skip.'
    $taskAvitoId = Read-Host 'Avito client_id'
    if ($taskAvitoId) {
        $taskAvitoSecret = Read-Host 'Avito client_secret' -AsSecureString
        $taskAvitoId | Set-Content -LiteralPath $taskAvitoIdFile -NoNewline
        $taskAvitoSecret | Export-Clixml -LiteralPath $taskAvitoSecretFile
    }
}
$taskSecret = Import-Clixml -LiteralPath $taskTokenFile
$taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
try { $env:TELEGRAM_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
try {
    if (Test-Path -LiteralPath $taskAvitoIdFile) { $env:AVITO_CLIENT_ID = Get-Content -LiteralPath $taskAvitoIdFile -Raw; $env:AVITO_CLIENT_ID=$env:AVITO_CLIENT_ID.Trim() }
    if (Test-Path -LiteralPath $taskAvitoSecretFile) {
        $taskAvitoSecure = Import-Clixml -LiteralPath $taskAvitoSecretFile
        $taskAvitoPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskAvitoSecure)
        try { $env:AVITO_CLIENT_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskAvitoPointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskAvitoPointer) }
    }
    $taskEntry = if ($CheckConnection) { 'check-connection.mjs' } else { 'bot.mjs' }
    # Node watches source files and restarts the bot after each code update.
    $taskArgs = @('--use-env-proxy')
    if (-not $CheckConnection) { $taskArgs += '--watch' }
    $taskArgs += (Join-Path $PSScriptRoot $taskEntry)
    & $taskNode @taskArgs
    $taskExitCode = $LASTEXITCODE
} finally {
    Remove-Item Env:\TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\AVITO_CLIENT_ID,Env:\AVITO_CLIENT_SECRET -ErrorAction SilentlyContinue
}
exit $taskExitCode
