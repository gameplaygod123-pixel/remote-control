# Make Track 2 (SYSTEM input-elevation) PERMANENT from the INSTALLED app.
# Run this ONCE after installing the prerelease; approve the single UAC prompt.
# Everything here needs admin (machine env + a SYSTEM /rl HIGHEST task), so the
# script self-elevates into a new window that stays open for the result.
#
# What it does (all idempotent):
#   2a. PR_INPUT_SERVICE=1 as a MACHINE env var  -> every launch path of the agent
#       (task, run-key-handoff bounce) inherits it, so the forked input-helper
#       enables + hosts the pipe. Survives app reinstalls (unlike a task-action
#       tweak that install-agent-autostart.ps1 would overwrite).
#   2b. Register the SYSTEM launcher task PersonalRemoteInput pointing at the
#       INSTALLED app (install-input-service.ps1 auto-resolves the NSIS path), so
#       the SYSTEM injector runs from the shipped bundle, not the dev repo.
#   +   Remove any stale HKCU Run key (belt-and-suspenders; the new bundle already
#       stops re-adding it, but clear a pre-existing one so logon is clean).
#
# After this: REBOOT, then do the remote test (Task Manager = Track 1 High,
# Win+L / UAC = Track 2 SYSTEM injector).

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Self-elevate into a NEW window that stays open so the result is visible.
if (-not (Test-Admin)) {
  Write-Host "Needs admin (machine env + SYSTEM task). Relaunching elevated - approve UAC..." -ForegroundColor Yellow
  $argList = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($Uninstall) { $argList += '-Uninstall' }
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  return
}

$installDir  = Join-Path $env:LOCALAPPDATA 'Programs\desktop'
$installPs   = Join-Path $PSScriptRoot 'install-input-service.ps1'
$uninstallPs = Join-Path $PSScriptRoot 'uninstall-input-service.ps1'

if ($Uninstall) {
  Write-Host "=== UNINSTALL Track 2 permanent setup ===" -ForegroundColor Cyan
  [Environment]::SetEnvironmentVariable('PR_INPUT_SERVICE', $null, 'Machine')
  Write-Host "  cleared machine env PR_INPUT_SERVICE"
  & $uninstallPs
  Write-Host "Done. (Agent Track 1 task PersonalRemoteAgent left intact.)"
  return
}

# Transcript to a world-readable path so the outcome (incl. any error) can be read
# from a non-elevated shell without staring at the elevated window.
$transcript = 'C:\Users\Public\track2-setup.log'
try { Start-Transcript -Path $transcript -Force | Out-Null } catch {}
trap { Write-Host "SETUP FAILED: $($_.Exception.Message)" -ForegroundColor Red; try { Stop-Transcript | Out-Null } catch {}; break }

Write-Host "=== Track 2 permanent setup (elevated) ===" -ForegroundColor Cyan

# --- 2a. machine env: PR_INPUT_SERVICE=1 ---------------------------------------
[Environment]::SetEnvironmentVariable('PR_INPUT_SERVICE', '1', 'Machine')
$check = [Environment]::GetEnvironmentVariable('PR_INPUT_SERVICE', 'Machine')
Write-Host "2a. machine env PR_INPUT_SERVICE = $check"

# --- clear any stale HKCU Run key so logon autostart is only the elevated task --
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
foreach ($name in 'com.personalremote.app', 'desktop', 'Personal Remote') {
  if (Get-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
    Write-Host "    removed stale HKCU Run key '$name'"
  }
}

# --- 2b. register the SYSTEM launcher task at the INSTALL path ------------------
Write-Host "2b. registering SYSTEM launcher task (install-input-service.ps1, auto-resolve)..."
& $installPs   # no -ExePath/-ScriptPath -> auto-resolves the NSIS install

# --- verify --------------------------------------------------------------------
Write-Host "`n=== verify ===" -ForegroundColor Cyan
$agent = Get-ScheduledTask -TaskName PersonalRemoteAgent -ErrorAction SilentlyContinue
if ($agent) {
  Write-Host "  Track 1 PersonalRemoteAgent : RunLevel=$($agent.Principal.RunLevel) User=$($agent.Principal.UserId) State=$($agent.State)"
} else {
  Write-Host "  WARNING: Track 1 task PersonalRemoteAgent MISSING (reinstall the app or run install-agent-autostart.ps1)" -ForegroundColor Yellow
}
$svc = Get-ScheduledTask -TaskName PersonalRemoteInput -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "  Track 2 PersonalRemoteInput  : RunLevel=$($svc.Principal.RunLevel) User=$($svc.Principal.UserId) State=$($svc.State)"
} else {
  Write-Host "  ERROR: Track 2 task PersonalRemoteInput was NOT registered" -ForegroundColor Red
}
Write-Host "  install ExePath exists : $(Test-Path (Join-Path $installDir 'PersonalRemote.exe'))"
Write-Host "  install launcher exists: $(Test-Path (Join-Path $installDir 'resources\app\out\main\input-service.js'))"

Write-Host "`nNEXT: REBOOT, sign in, then control from the Mac:" -ForegroundColor Green
Write-Host "  - open Task Manager  (Track 1 High-integrity click must land)"
Write-Host "  - press Win+L / trigger a UAC prompt (Track 2 SYSTEM injector must land input; video freezes = expected)"
Write-Host "  - log to read: C:\Users\Public\personal-remote-input-service.log"
try { Stop-Transcript | Out-Null } catch {}
