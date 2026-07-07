# Track-2 STEP C end-to-end proof (Default desktop). Run this in a normal
# interactive PowerShell -- it self-elevates (approve the UAC prompt), installs the
# SYSTEM launcher task, then runs the live helper<->injector chain and reports
# PASS/FAIL by reading GetCursorPos back.
#
#   scripts\track2-e2e.ps1            # install task + run the Default-desktop proof
#   scripts\track2-e2e.ps1 -Secure    # install task + Phase-3 secure-desktop test:
#                                      #   forwards a heartbeat forever so you can
#                                      #   LOCK the screen and watch the injector
#                                      #   follow to Winlogon in the log
#   scripts\track2-e2e.ps1 -Uninstall # remove the task when you're done
#
# WHY interactive + elevated: SendInput only moves the VISIBLE cursor from a thread
# on the active input desktop (WinSta0\Default). The SYSTEM injector is spawned
# there by the task; this harness's GetCursorPos must run on that same interactive
# desktop, so it has to run in YOUR terminal (not an automation/Claude shell) and
# elevated so it can install the task in the same window.
#
# NOTE: the definitive STEP C test is still the REAL agent (launched with
# PR_INPUT_SERVICE=1 so its forked helper hosts the pipe at MEDIUM integrity) +
# controlling Task Manager from the Mac. This harness is the fast local pre-check
# that the Fix A pipe + schtasks SYSTEM injector land input on the visible desktop.

param([switch]$Uninstall, [switch]$Secure)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

$root    = Resolve-Path (Join-Path $PSScriptRoot '..')
$desktop = Join-Path $root 'apps\desktop'

# Self-elevate into a NEW window that stays open so the result is visible.
if (-not (Test-Admin)) {
  Write-Host "Needs admin to install the SYSTEM task. Relaunching elevated - approve the UAC prompt..." -ForegroundColor Yellow
  $argList = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($Uninstall) { $argList += '-Uninstall' }
  if ($Secure)    { $argList += '-Secure' }
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  return
}

$installPs   = Join-Path $PSScriptRoot 'install-input-service.ps1'
$uninstallPs = Join-Path $PSScriptRoot 'uninstall-input-service.ps1'

if ($Uninstall) {
  & $uninstallPs
  return
}

# Resolve the electron.exe host + the built launcher entry.
$electron = (Get-ChildItem (Join-Path $root 'node_modules\.pnpm') -Filter 'electron.exe' -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\electron@[0-9.]+\\node_modules\\electron\\dist\\electron.exe' } |
  Select-Object -First 1).FullName
$serviceScript = Join-Path $desktop 'out\main\input-service.js'
$injectorScript = Join-Path $desktop 'out\main\input-injector.js'
$tsx = Join-Path $root 'node_modules\.pnpm\tsx@4.22.4\node_modules\tsx\dist\cli.mjs'
$node = (Get-Command node).Source

if (-not $electron)                    { throw "electron.exe not found under node_modules\.pnpm" }
if (-not (Test-Path $serviceScript))   { throw "missing $serviceScript -- run 'npm run build' in apps\desktop first" }
if (-not (Test-Path $injectorScript))  { throw "missing $injectorScript -- run 'npm run build' in apps\desktop first" }

Write-Host "electron : $electron"
Write-Host "launcher : $serviceScript"

# 1) install + start the SYSTEM launcher task (it spawns the injector into session 1).
& $installPs -ExePath $electron -ScriptPath $serviceScript

# 2) give the launcher a few polls to CreateProcessAsUser the injector.
Write-Host "waiting for the launcher to spawn the SYSTEM injector..."
Start-Sleep -Seconds 6

# 3) run the harness as the pipe HOST.
#    default  -> phase2e2e-live: 3 moves + GetCursorPos check, exits PASS/FAIL.
#    -Secure  -> phase3-secure: forwards a heartbeat forever so YOU can LOCK the
#               screen mid-loop; the injector follows to Winlogon and logs it.
$harness = if ($Secure) { 'src/input-service/dev/phase3-secure.ts' } else { 'src/input-service/dev/phase2e2e-live.ts' }
if ($Secure) {
  Write-Host "`n=== SECURE-DESKTOP (Phase 3) mode ===" -ForegroundColor Cyan
  Write-Host "When it says 'connected', press the PHYSICAL Win+L to lock (use the real" -ForegroundColor Cyan
  Write-Host "keyboard, not the mouse). Wait ~4s, press any key to return, then Ctrl+C" -ForegroundColor Cyan
  Write-Host "and read the log for:  input desktop -> 'Winlogon'" -ForegroundColor Cyan
}
Push-Location $desktop
try {
  $env:PR_INPUT_SERVICE = '1'
  & $node $tsx $harness
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

Write-Host "`n===== harness exit: $code (0 = PASS) ====="
$log = 'C:\Users\Public\personal-remote-input-service.log'
Write-Host "===== SYSTEM injector log ($log) ====="
if (Test-Path $log) { Get-Content $log -Tail 20 } else { Write-Host '(no log -- did the task start? check: schtasks /query /tn PersonalRemoteInput /v)' }
Write-Host "`nDone. Remove the task with:  scripts\track2-e2e.ps1 -Uninstall"
