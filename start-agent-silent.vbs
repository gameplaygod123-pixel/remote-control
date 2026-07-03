' Launches start-agent.bat with no visible console window, so the app
' behaves like a normal double-click-to-open program instead of popping up
' a terminal alongside the Agent window.
' If the Agent window never appears after double-clicking this, something
' failed before it could be shown -- run start-agent.bat directly instead
' to see the actual error output.
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)

Set shell = CreateObject("WScript.Shell")
shell.Run """" & folder & "\start-agent.bat""", 0, False
