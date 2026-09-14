<#
  Start the game and expose it, as processes that outlive the shell that made them.

  `npm run serve` in a foreground terminal is the normal way to play. This script is for
  the other case: playing from a phone or another machine, where the server has to keep
  running after whatever started it has gone away. Start-Process detaches, so neither a
  closed terminal nor an agent session's cleanup takes the game down with it.

    .\scripts\play-remote.ps1            # start both, print the public URL
    .\scripts\play-remote.ps1 -Stop      # stop both
    .\scripts\play-remote.ps1 -Status    # is it up, and where

  GAME_SECRET must be set in .env. Without it the tunnel is an open door to every save on
  this machine, so this script refuses to expose a server that has no password.
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$Stop,
  [switch]$Status,
  # Skip the tunnel and serve on localhost only.
  [switch]$LocalOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root '.run'

function Get-GameProcesses {
  $node = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*serve.ts*' })
  $ngrok = @(Get-Process ngrok -ErrorAction SilentlyContinue)
  [PSCustomObject]@{ Server = $node; Tunnel = $ngrok }
}

function Stop-Game {
  $p = Get-GameProcesses
  foreach ($s in $p.Server) { Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($t in $p.Tunnel) { Stop-Process -Id $t.Id -Force -ErrorAction SilentlyContinue }
  "stopped: $($p.Server.Count) server, $($p.Tunnel.Count) tunnel"
}

# ngrok's own API is the only honest source for the public URL — the log line can be stale
# from a previous run, and there is no way to ask the tunnel itself.
$script:LastUrlError = ''
function Get-PublicUrl {
  param([int]$Seconds = 25)
  # Keep the last error rather than swallowing it: "no URL" with no reason is not a
  # diagnosis, and this is the one step with nothing else to look at when it fails.
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $raw = (Invoke-WebRequest -Uri 'http://localhost:4040/api/tunnels' -TimeoutSec 2 -UseBasicParsing).Content
      $https = ($raw | ConvertFrom-Json).tunnels |
        Where-Object { $_.public_url -like 'https://*' } | Select-Object -First 1
      if ($https) { return $https.public_url }
      $script:LastUrlError = 'ngrok is up but reports no https tunnel yet'
    } catch {
      $script:LastUrlError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }
  return $null
}

if ($Stop) { Stop-Game; return }

if ($Status) {
  $p = Get-GameProcesses
  if ($p.Server.Count -eq 0) { 'server: not running'; return }
  "server: running (pid $($p.Server[0].ProcessId)) on http://localhost:$Port"
  if ($p.Tunnel.Count -eq 0) { 'tunnel: not running' }
  else {
    $u = Get-PublicUrl
    if ($u) { "tunnel: $u" } else { 'tunnel: running, but ngrok has not reported a URL' }
  }
  return
}

$envFile = Join-Path $root '.env'
$secret = $null
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^GAME_SECRET=(.+)$' | Select-Object -First 1
  if ($line) { $secret = $line.Matches[0].Groups[1].Value.Trim() }
}
if (-not $LocalOnly -and [string]::IsNullOrWhiteSpace($secret)) {
  throw "No GAME_SECRET in .env. Add one before exposing the port, or pass -LocalOnly."
}

Stop-Game | Out-Null
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$server = Start-Process -FilePath 'node' -PassThru -WindowStyle Hidden -WorkingDirectory $root `
  -ArgumentList '--env-file-if-exists=.env', '--import', 'tsx', 'src/cli/serve.ts', '--port', "$Port" `
  -RedirectStandardOutput (Join-Path $logs 'serve.log') `
  -RedirectStandardError  (Join-Path $logs 'serve.err')

# Wait for it to actually answer rather than assuming a spawned process is a running one.
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -TimeoutSec 2 -UseBasicParsing | Out-Null
    $up = $true; break
  } catch {
    # A 401 is the server answering, and answering correctly: the secret is set.
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 401) { $up = $true; break }
  }
}
if (-not $up) {
  Get-Content (Join-Path $logs 'serve.err') -Tail 20 -ErrorAction SilentlyContinue
  throw "The server did not come up on port $Port. See .run\serve.err"
}

"server:  http://localhost:$Port  (pid $($server.Id))"
if ($LocalOnly) { return }

Start-Process -FilePath 'ngrok' -PassThru -WindowStyle Hidden -WorkingDirectory $root `
  -ArgumentList 'http', "$Port", '--log', 'stdout' `
  -RedirectStandardOutput (Join-Path $logs 'ngrok.log') `
  -RedirectStandardError  (Join-Path $logs 'ngrok.err') | Out-Null

$url = Get-PublicUrl
if (-not $url) {
  # Very likely the tunnel is fine and only its API was slow, so fall back to ngrok's own
  # log - but say which source the URL came from, because the log can hold a stale one.
  $line = Select-String -Path (Join-Path $logs 'ngrok.log') -Pattern 'url=(https://\S+)' |
    Select-Object -Last 1
  if ($line) {
    $url = $line.Matches[0].Groups[1].Value
    "  (ngrok's API did not answer: $script:LastUrlError -- URL read from its log)"
  }
}
if (-not $url) {
  "ngrok API error: $script:LastUrlError"
  Get-Content (Join-Path $logs 'ngrok.log') -Tail 20 -ErrorAction SilentlyContinue
  throw "The tunnel started but never reported a URL. See .run\ngrok.log"
}

# Never print an address without checking it answers. A stale log line and a dead tunnel
# look identical on screen, and the person reading this is about to open it on a phone.
try {
  $probe = Invoke-WebRequest -Uri $url -TimeoutSec 15 -UseBasicParsing -Headers @{ 'ngrok-skip-browser-warning' = '1' }
  if ($probe.StatusCode -ne 200) { "  (warning: $url answered $($probe.StatusCode))" }
} catch {
  "  (warning: could not reach $url from this machine: $($_.Exception.Message))"
}

""
"  play here:  $url"
"  password:   $secret"
""
"  ngrok shows a warning page on the first visit — click Visit Site."
"  stop it with:  .\scripts\play-remote.ps1 -Stop"
""
