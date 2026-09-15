# Configure only this process and its children; Windows settings are not changed.
$taskSystemProxy = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
if ($taskSystemProxy.ProxyEnable -eq 1 -and $taskSystemProxy.ProxyServer) {
    $taskProxySpec = [string]$taskSystemProxy.ProxyServer
    $taskProxyEndpoint = $null
    if ($taskProxySpec -match '=') {
        $taskProxyParts = @{}
        foreach ($taskProxyPart in ($taskProxySpec -split ';')) {
            $taskProxyPair = $taskProxyPart -split '=', 2
            if ($taskProxyPair.Count -eq 2) { $taskProxyParts[$taskProxyPair[0].Trim().ToLowerInvariant()] = $taskProxyPair[1].Trim() }
        }
        if ($taskProxyParts.ContainsKey('https')) { $taskProxyEndpoint = $taskProxyParts['https'] }
        elseif ($taskProxyParts.ContainsKey('http')) { $taskProxyEndpoint = $taskProxyParts['http'] }
    } else { $taskProxyEndpoint = $taskProxySpec.Trim() }
    if ($taskProxyEndpoint) {
        if ($taskProxyEndpoint -notmatch '^\w+://') { $taskProxyEndpoint = 'http://' + $taskProxyEndpoint }
        $taskProxyUri = [Uri]$taskProxyEndpoint
        if ($taskProxyUri.Scheme -in @('http','https')) {
            $env:HTTPS_PROXY = $taskProxyEndpoint
            $env:HTTP_PROXY = $taskProxyEndpoint
            Write-Host ('Windows proxy: {0}:{1}' -f $taskProxyUri.Host, $taskProxyUri.Port)
        } else { Write-Host 'This proxy protocol is not supported. Use an HTTP proxy or VPN tunnel mode.' }
    } else { Write-Host 'Windows has no HTTP proxy endpoint. A SOCKS-only proxy needs HTTP mode or VPN tunnel mode.' }
} elseif ($taskSystemProxy.AutoConfigURL) {
    Write-Host 'Automatic proxy scripts (PAC) are not supported. Set HTTPS_PROXY to an HTTP proxy or use VPN tunnel mode.'
}
