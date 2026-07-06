# Remove the Personal Remote elevated input service. Run ELEVATED.
# UNTESTED handoff script (docs/input-elevation-plan.md).

param([string]$ServiceName = 'PersonalRemoteInput')

$ErrorActionPreference = 'SilentlyContinue'

sc.exe stop   $ServiceName | Out-Null
Start-Sleep -Milliseconds 500
sc.exe delete $ServiceName | Out-Null
Write-Host "Removed service '$ServiceName' (if it existed)."
