# Install the Personal Remote elevated input service (LocalSystem, session 0).
# UNTESTED handoff script (docs/input-elevation-plan.md). Run ELEVATED (the NSIS
# installer runs elevated; for manual testing use an admin PowerShell).
#
# The service runs the app's electron.exe as plain Node (ELECTRON_RUN_AS_NODE=1)
# pointing at the built service.js. Because sc.exe can't set process env, we
# write ELECTRON_RUN_AS_NODE into the service's own Environment registry value.

param(
  # Path to the app's electron/exe host (supports ELECTRON_RUN_AS_NODE).
  # In a packaged build this is the app exe, e.g. "Personal Remote.exe".
  [Parameter(Mandatory = $true)][string]$ExePath,
  # Path to the built session-0 launcher (input-service/service.js).
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  [string]$ServiceName = 'PersonalRemoteInput'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ExePath))    { throw "ExePath not found: $ExePath" }
if (-not (Test-Path $ScriptPath)) { throw "ScriptPath not found: $ScriptPath" }

# Remove any prior instance first (idempotent installs / upgrades).
sc.exe stop   $ServiceName | Out-Null
sc.exe delete $ServiceName | Out-Null
Start-Sleep -Milliseconds 500

# binPath must quote both the exe and the script (spaces in "Program Files").
$binPath = "`"$ExePath`" `"$ScriptPath`""
sc.exe create $ServiceName binPath= "$binPath" start= auto obj= LocalSystem `
  DisplayName= "Personal Remote Input Service" | Out-Null
sc.exe description $ServiceName "Injects remote input into elevated windows and the secure desktop for Personal Remote." | Out-Null

# ELECTRON_RUN_AS_NODE=1 so electron.exe boots as pure Node (no Chromium).
# Services read env from this REG_MULTI_SZ under their own key.
$svcKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
New-ItemProperty -Path $svcKey -Name 'Environment' `
  -Value @('ELECTRON_RUN_AS_NODE=1') -PropertyType MultiString -Force | Out-Null

# Recover on crash (Windows SCM restarts it): 5s, 5s, then every 60s.
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null

sc.exe start $ServiceName | Out-Null
Write-Host "Installed + started service '$ServiceName'."
Write-Host "Log: %TEMP%\input-service.log (NOTE: the SYSTEM service's %TEMP% is C:\Windows\Temp)."
