' Run this once to (re)create Desktop shortcuts with the app's real icon.
' Windows .bat/.vbs files can't have a custom icon themselves, but a
' shortcut (.lnk) pointing at one can -- this replaces whatever
' generic-icon shortcuts were made by hand earlier (Send to > Desktop).
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
iconPath = folder & "\apps\desktop\build\icon.ico"

Set shell = CreateObject("WScript.Shell")
desktopPath = shell.SpecialFolders("Desktop")

Set agentShortcut = shell.CreateShortcut(desktopPath & "\Personal Remote Agent.lnk")
agentShortcut.TargetPath = folder & "\start-agent-silent.vbs"
agentShortcut.WorkingDirectory = folder
agentShortcut.IconLocation = iconPath
agentShortcut.Description = "Personal Remote Agent"
agentShortcut.Save

Set updateShortcut = shell.CreateShortcut(desktopPath & "\Update Personal Remote.lnk")
updateShortcut.TargetPath = folder & "\update-agent.bat"
updateShortcut.WorkingDirectory = folder
updateShortcut.IconLocation = iconPath
updateShortcut.Description = "Update Personal Remote Agent"
updateShortcut.Save

MsgBox "สร้าง Shortcut บน Desktop เรียบร้อยแล้ว:" & vbCrLf & vbCrLf & _
  "- Personal Remote Agent" & vbCrLf & _
  "- Update Personal Remote" & vbCrLf & vbCrLf & _
  "ลบ Shortcut อันเก่าที่ไอคอนไม่ตรงออกได้เลยครับ", 64, "เสร็จแล้ว"
