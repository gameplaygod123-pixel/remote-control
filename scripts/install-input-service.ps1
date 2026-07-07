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
  # In a packaged build this is the app exe, e.g. "Personal Remote.exe".
  [Parameter(Mandatory = $true)][string]$ExePath,
  # Path to the built session-0 launcher (input-service/service.js).
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  # Task name. Kept as -ServiceName so existing callers/installer args don't break.
  [string]$ServiceName = 'PersonalRemoteInput'
)

$ErrorActionPreference = 'Stop'
$TaskName = $ServiceName

if (-not (Test-Path $ExePath))    { throw "ExePath not found: $ExePath" }
if (-not (Test-Path $ScriptPath)) { throw "ScriptPath not found: $ScriptPath" }

# --- idempotent teardown: remove any prior task AND any legacy SCM service ------
# (installs before this change registered an SCM service of the same name.)
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}
& sc.exe stop   $TaskName | Out-Null
& sc.exe delete $TaskName | Out-Null

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
Write-Host "Log: C:\Windows\Temp\input-service.log (SYSTEM's %TEMP%)."
