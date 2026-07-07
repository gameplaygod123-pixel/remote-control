# Install the Personal Remote elevated input LAUNCHER as a SYSTEM Scheduled Task.
# Run ELEVATED (the NSIS installer runs elevated; for manual testing use an admin
# PowerShell).
#
# Why a Scheduled Task, not an SCM service (Phase 2 e2e finding): service.ts is a
# plain-Node entry (electron.exe + ELECTRON_RUN_AS_NODE) with no
# StartServiceCtrlDispatcher, so `sc start` times out with error 1053 and SCM
# kills it (orphaning the injector). A task `/ru SYSTEM /rl HIGHEST` runs the same
# launcher in session 0 with SYSTEM rights -- no dispatcher needed -- and it still
# uses the working CreateProcessAsUserW primitive to spawn the injector into the
# interactive session. Do NOT hand-roll the SCM dispatcher in koffi
# (callback-from-native segfault risk).
#
# Task Scheduler can't set process env, so the action is a cmd wrapper that sets
# ELECTRON_RUN_AS_NODE=1 (electron.exe then boots as pure Node) before the launcher.

param(
  # Path to the app's electron/exe host (supports ELECTRON_RUN_AS_NODE).
  # In a packaged build this is the app exe, e.g. "PersonalRemote.exe".
  # OPTIONAL: if omitted, auto-resolved to the NSIS install (see below).
  [string]$ExePath,
  # Path to the built session-0 launcher (input-service/input-service.js).
  # OPTIONAL: if omitted, auto-resolved to the NSIS install (see below).
  [string]$ScriptPath,
  # Task name. Kept as -ServiceName so existing callers/installer args don't break.
  [string]$ServiceName = 'PersonalRemoteInput'
)

$ErrorActionPreference = 'Stop'
$TaskName = $ServiceName

# --- auto-resolve the INSTALLED app paths when not passed explicitly ------------
# The permanent (post-NSIS) install points the SYSTEM task at the app under
# %LOCALAPPDATA%\Programs\desktop, NOT the dev repo out/main. The electron app exe
# (PersonalRemote.exe) doubles as the ELECTRON_RUN_AS_NODE host, and the launcher
# is out/main/input-service.js next to the injector. Callers that pass -ExePath /
# -ScriptPath (e.g. the dev harness track2-e2e.ps1) still win.
if (-not $ExePath -or -not $ScriptPath) {
  $installDir = Join-Path $env:LOCALAPPDATA 'Programs\desktop'
  if (-not $ExePath)    { $ExePath    = Join-Path $installDir 'PersonalRemote.exe' }
  if (-not $ScriptPath) { $ScriptPath = Join-Path $installDir 'resources\app\out\main\input-service.js' }
  Write-Host "auto-resolved install paths:"
  Write-Host "  ExePath    = $ExePath"
  Write-Host "  ScriptPath = $ScriptPath"
}

if (-not (Test-Path $ExePath))    { throw "ExePath not found: $ExePath" }
if (-not (Test-Path $ScriptPath)) { throw "ScriptPath not found: $ScriptPath" }

# --- idempotent teardown: remove any prior task AND any legacy SCM service ------
# (installs before this change registered an SCM service of the same name.)
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}
& sc.exe stop   $TaskName | Out-Null
& sc.exe delete $TaskName | Out-Null

# Kill any STRAY injector processes orphaned by a previous run. Unregistering the
# task does NOT stop an already-spawned injector-in-session, so repeated
# installs otherwise pile up multiple injectors all fighting for the one pipe
# (each logging ENOENT). Match only the injector entry so the agent / other
# electron apps are untouched.
try {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -like '*input-injector.js*' } |
    ForEach-Object {
      Write-Host "  killing stray injector pid $($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}

# --- action: cmd sets ELECTRON_RUN_AS_NODE=1 then runs the launcher -------------
# `set "VAR=1"` (quoted form) strips trailing spaces; && runs the launcher with it
# inherited. Both paths quoted for "Program Files" spaces.
$inner  = 'set "ELECTRON_RUN_AS_NODE=1" && "{0}" "{1}"' -f $ExePath, $ScriptPath
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ' + $inner)

# Session-0 SYSTEM launcher, highest integrity, starts at boot regardless of who
# is logged on. ExecutionTimeLimit 0 = no time limit (it's a long-running
# supervisor loop); restart it if it ever exits.
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

# Start it now so install doesn't require a reboot to take effect.
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed + started scheduled task '$TaskName' (SYSTEM, HIGHEST, session-0 launcher)."
Write-Host "Log: C:\Users\Public\personal-remote-input-service.log (world-readable - no elevation to tail)."
