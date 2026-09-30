# Stop the disk-sim server previously started by start.ps1 (this project only).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "tmp\server.pid"
if (-not (Test-Path $pidFile)) { Write-Host "no pid file; server not running"; exit 0 }
$serverPid = [int](Get-Content $pidFile)
$proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id $serverPid -Force
  Write-Host "stopped pid $serverPid"
} else {
  Write-Host "pid $serverPid not alive"
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $root "tmp\server.url") -Force -ErrorAction SilentlyContinue
