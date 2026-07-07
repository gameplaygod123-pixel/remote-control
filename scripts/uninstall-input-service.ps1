# Remove the Personal Remote elevated input launcher (Scheduled Task). Run
# ELEVATED. Also cleans up any legacy SCM service of the same name from installs
# predating the schtasks switch.

param([string]$ServiceName = 'PersonalRemoteInput')

$ErrorActionPreference = 'SilentlyContinue'
$TaskName = $ServiceName

# Stop + remove the scheduled task (this also tree-kills the running launcher).
try { Stop-ScheduledTask -TaskName $TaskName } catch {}
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false } catch {}

# Legacy SCM service cleanup (pre-schtasks installs).
& sc.exe stop   $TaskName | Out-Null
& sc.exe delete $TaskName | Out-Null

Write-Host "Removed scheduled task '$TaskName' (and any legacy service)."
