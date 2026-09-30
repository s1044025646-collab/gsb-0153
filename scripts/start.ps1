# Start the disk-sim API bound to loopback on an automatic port.
# Manages ONLY this project's server process; PID and base URL go under ./tmp.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $root "tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$pidFile = Join-Path $tmp "server.pid"
$outFile = Join-Path $tmp "server.out.log"

if (Test-Path $pidFile) {
  $oldPid = [int](Get-Content $pidFile)
  $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Host "server already running (pid $oldPid)"; exit 0
  }
  Remove-Item $pidFile -Force
}

Push-Location $root
try {
  & (Join-Path $root "node_modules\.bin\tsc.CMD") -p (Join-Path $root "tsconfig.json") *> (Join-Path $tmp "build.log")
  if ($LASTEXITCODE -ne 0) { Get-Content (Join-Path $tmp "build.log"); exit 1 }
  $env:DISK_SIM_DB = Join-Path $root "data\disk-sim.sqlite"
  $env:DISK_SIM_PORT = "0"
  $urlFile = Join-Path $tmp "server.url"
  $env:DISK_SIM_PORT_FILE = $urlFile
  $p = Start-Process -FilePath "node" `
    -ArgumentList "--experimental-sqlite","dist/src/server.js" `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outFile -RedirectStandardError (Join-Path $tmp "server.err.log")
  Set-Content -Path $pidFile -Value $p.Id
  $base = $null
  for ($i = 0; $i -lt 100 -and -not $base; $i++) {
    Start-Sleep -Milliseconds 100
    if (Test-Path $urlFile) { $base = (Get-Content $urlFile -Raw).Trim() }
    if (-not $base -and $p.HasExited) { Write-Host "server exited; see $tmp\server.err.log"; exit 1 }
  }
  if (-not $base) { Write-Host "server did not publish its port; see $tmp\server.err.log"; exit 1 }
  Write-Host "started pid $($p.Id) at $base"
} finally {
  Pop-Location
}
exit 0
