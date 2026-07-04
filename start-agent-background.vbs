' Auto-start-at-boot target: launches start-agent-background.bat with no
' visible console window, and the Agent itself starts hidden in the
' system tray (START_HIDDEN=1, set in the .bat) instead of popping up a
' window every time Windows logs in -- click the tray icon to open it.
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)

Set shell = CreateObject("WScript.Shell")
shell.Run """" & folder & "\start-agent-background.bat""", 0, False
