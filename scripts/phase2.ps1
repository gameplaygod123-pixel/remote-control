# Phase 2 SYSTEM-spawn harness launcher. Usage:
#   scripts\phase2.ps1 layout|session|probe|injector
#
# layout/session run as the current user (no privileged calls). probe/injector
# need SYSTEM from session 0 (the real service's context), so they run via a
# one-shot SYSTEM scheduled task; output is captured to C:\Windows\Temp\
# phase2-harness.log and printed here.
param([Parameter(Mandatory = $true)][ValidateSet('layout', 'session', 'probe', 'injector')][string]$Stage)
$ErrorActionPreference = 'Stop'

# probe/injector spawn as SYSTEM (schtasks /ru SYSTEM), which needs an elevated
# shell. If we're not elevated, relaunch this script elevated in a NEW window
# that stays open (-NoExit) so the output is visible. Approve the UAC prompt
# (it appears on the secure desktop — may need a touch on the Windows box).
function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}
if ($Stage -in @('probe', 'injector') -and -not (Test-Admin)) {
  Write-Host "Stage '$Stage' needs SYSTEM (admin). Relaunching elevated - approve the UAC prompt..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @(
    '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", $Stage)
  return
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$desktop = Join-Path $root 'apps\desktop'
$tsx = Join-Path $root 'node_modules\.pnpm\tsx@4.22.4\node_modules\tsx\dist\cli.mjs'
$harness = 'src/input-service/dev/phase2-spawn.ts'
$node = (Get-Command node).Source
$injector = Join-Path $desktop 'out\main\input-injector.js'
$electron = (Get-ChildItem (Join-Path $root 'node_modules\.pnpm') -Filter 'electron.exe' -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\electron@[0-9.]+\\node_modules\\electron\\dist\\electron.exe' } | Select-Object -First 1).FullName
$log = 'C:\Windows\Temp\phase2-harness.log'

if ($Stage -in @('layout', 'session')) {
  Push-Location $desktop
  try {
    $env:PHASE2_INJECTOR = $injector
    $env:PHASE2_ELECTRON = $electron
    & $node $tsx $harness $Stage
  } finally { Pop-Location }
  return
}

# --- privileged stages: run as SYSTEM via a scheduled task ---
Write-Host "electron: $electron"
Write-Host "injector: $injector"
Remove-Item $log -ErrorAction SilentlyContinue

$cmd = 'C:\Windows\Temp\phase2-run.cmd'
@"
@echo off
cd /d "$desktop"
set PHASE2_INJECTOR=$injector
set PHASE2_ELECTRON=$electron
"$node" "$tsx" "$harness" $Stage > "$log" 2>&1
"@ | Set-Content -Path $cmd -Encoding ascii

$taskName = 'PR_Phase2'
schtasks /create /tn $taskName /ru SYSTEM /rl HIGHEST /sc once /st 23:59 /tr "$cmd" /f | Out-Null
schtasks /run /tn $taskName | Out-Null

# wait for the harness to finish (it writes a completion marker), max ~30s
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'stage complete' -Quiet)) { break }
}
schtasks /delete /tn $taskName /f | Out-Null

Write-Host "`n===== phase2-harness.log ====="
if (Test-Path $log) { Get-Content $log } else { Write-Host '(no log produced — task may have failed to start node as SYSTEM)' }
if (Test-Path 'C:\Windows\Temp\phase2-child.json') {
  Write-Host "`n===== phase2-child.json ====="
  Get-Content 'C:\Windows\Temp\phase2-child.json'
}
