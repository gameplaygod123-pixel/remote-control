# Track 1 (input elevation): auto-elevate the Personal Remote AGENT at logon.
#
# Creates a Scheduled Task that launches the agent at user logon with "highest
# privileges" (elevated) and an interactive logon token -- so it runs in the
# user's session, shows its tray, and its forked input-helper inherits HIGH
# integrity. That lets the helper's existing local SendInput reach Task Manager
# and any "run as administrator" window (Windows UIPI blocks a medium-integrity
# process from injecting into a higher-integrity one). No per-launch UAC nag:
# Task Scheduler bypasses the UAC prompt for a HIGHEST task run as the logged-on
# admin user.
#
# Run ELEVATED (registering a HIGHEST task needs admin). Idempotent.
#
# It also removes the OLD medium-integrity autostart (the app's own
# `openAtLogin` HKCU Run key, value name = the appId) so the two don't both fire
# -- the single-instance lock means whichever wins the logon race sticks, and a
# medium winner would silently drop us back to no-Task-Manager input. The app's
# updated startup code keeps that Run key off once it has run elevated once
# (userData\elevated-autostart.flag), so after a rebuild this removal is belt-
# and-suspenders; until then it keeps the machine clean.

param(
  [string]$TaskName = 'PersonalRemoteAgent',
  # The installed agent exe. Default: auto-detect from the NSIS uninstall entry
  # (DisplayIcon points at PersonalRemote.exe). Override for a custom location.
  [string]$ExePath,
  # appId / HKCU Run value name that the app sets via setLoginItemSettings.
  [string]$RunValueName = 'com.personalremote.app'
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) { throw 'Run this ELEVATED (registering a /rl HIGHEST task needs admin).' }

if (-not $ExePath) {
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($k in $keys) {
    $e = Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Personal Remote' } | Select-Object -First 1
    if ($e -and $e.DisplayIcon) { $ExePath = ($e.DisplayIcon -split ',')[0].Trim('"'); break }
  }
}
if (-not $ExePath -or -not (Test-Path $ExePath)) { throw "Agent exe not found (pass -ExePath). Got: '$ExePath'" }

$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Task    : $TaskName"
Write-Host "Exe     : $ExePath --hidden"
Write-Host "Run as  : $user (interactive, HIGHEST / elevated), trigger = AtLogOn"

# Recreate cleanly (idempotent upgrades).
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action    = New-ScheduledTaskAction -Execute $ExePath -Argument '--hidden'
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
# Let it start hidden with no time limit; don't stop it on battery (a home host).
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'Auto-start Personal Remote agent elevated at logon (input elevation Track 1).' -Force | Out-Null

# Remove the old medium-integrity autostart so the two don't race at logon.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Get-ItemProperty -Path $runKey -Name $RunValueName -ErrorAction SilentlyContinue) {
  Remove-ItemProperty -Path $runKey -Name $RunValueName -Force
  Write-Host "Removed old medium autostart Run key: $RunValueName"
} else {
  Write-Host "No medium autostart Run key '$RunValueName' present (nothing to remove)."
}

Write-Host "`nInstalled. Test now WITHOUT a reboot:  schtasks /run /tn `"$TaskName`""
Write-Host "Then check Task Manager > Details > 'Elevated' column = Yes for PersonalRemote.exe."
