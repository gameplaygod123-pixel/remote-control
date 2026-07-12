# Remove the Track 1 auto-elevate scheduled task and restore the app's default
# medium-integrity autostart. Run ELEVATED. Idempotent.
#
# NOTE: the app also gates its own Run key on userData\elevated-autostart.flag
# once it has run elevated. To fully return to medium autostart, delete that flag
# too (this script does, best-effort, for the agent-mode userData).

param(
  [string]$TaskName = 'PersonalRemoteAgent',
  [string]$RunValueName = 'com.personalremote.app',
  [string]$ExePath
)

$ErrorActionPreference = 'Continue'

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed scheduled task '$TaskName' (if it existed)."

# Clear the elevated-autostart flag so the app resumes managing its Run key.
$flag = Join-Path $env:APPDATA 'desktop\agent\elevated-autostart.flag'
if (Test-Path $flag) { Remove-Item $flag -Force -ErrorAction SilentlyContinue; Write-Host "Cleared flag: $flag" }

# Restore the medium openAtLogin Run key so an unattended reboot still starts the
# agent (medium integrity) even before the app next runs to re-add it itself.
if (-not $ExePath) {
  foreach ($k in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                   'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                   'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    $e = Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Personal Remote' } | Select-Object -First 1
    if ($e -and $e.DisplayIcon) { $ExePath = ($e.DisplayIcon -split ',')[0].Trim('"'); break }
  }
}
if ($ExePath -and (Test-Path $ExePath)) {
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $RunValueName -Value "`"$ExePath`" --hidden"
  Write-Host "Restored medium autostart Run key '$RunValueName'."
} else {
  Write-Host "Agent exe not found; skipped restoring Run key (the app re-adds it on next medium launch)."
}
