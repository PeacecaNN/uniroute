Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

projectPath = fileSystem.GetParentFolderName(WScript.ScriptFullName)
logPath = projectPath & "\uniroute-log.txt"

command = "cmd /c cd /d """ & projectPath & """ && npm.cmd run dev > """ & logPath & """ 2>&1"
shell.Run command, 0, False
WScript.Sleep 10000
shell.Run "http://localhost:3000", 1, False
