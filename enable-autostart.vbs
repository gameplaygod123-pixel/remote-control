' Run this once to make Personal Remote Agent start automatically (hidden
' in the system tray) every time Windows logs in -- adds a shortcut to
' start-agent-background.vbs in the current user's Startup folder.
' To undo: delete "Personal Remote Agent.lnk" from that same folder
' (Win+R -> shell:startup).
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
iconPath = folder & "\apps\desktop\build\icon.ico"

Set shell = CreateObject("WScript.Shell")
startupPath = shell.SpecialFolders("Startup")

Set shortcut = shell.CreateShortcut(startupPath & "\Personal Remote Agent.lnk")
shortcut.TargetPath = folder & "\start-agent-background.vbs"
shortcut.WorkingDirectory = folder
shortcut.IconLocation = iconPath
shortcut.Description = "Personal Remote Agent (starts hidden in the tray)"
shortcut.Save

MsgBox "ตั้งค่าให้ Personal Remote Agent เปิดอัตโนมัติตอนเข้า Windows เรียบร้อยแล้วครับ" & vbCrLf & vbCrLf & _
  "จะเปิดแบบซ่อนไว้ในถาดระบบ (system tray) มุมขวาล่าง ไม่มีหน้าต่างโผล่มา" & vbCrLf & vbCrLf & _
  "ถ้าอยากยกเลิก: กด Win+R พิมพ์ shell:startup แล้วลบไฟล์ ""Personal Remote Agent""", 64, "เสร็จแล้ว"
