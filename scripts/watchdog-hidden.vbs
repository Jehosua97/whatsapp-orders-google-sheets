Option Explicit

Dim fileSystem, shell, scriptDirectory, projectDirectory
Dim quote, command, exitCode

Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
projectDirectory = fileSystem.GetParentFolderName(scriptDirectory)
quote = Chr(34)

shell.CurrentDirectory = projectDirectory
command = "powershell.exe -NoProfile -NonInteractive " & _
  "-ExecutionPolicy Bypass -WindowStyle Hidden -File " & quote & _
  scriptDirectory & "\watchdog.ps1" & quote
exitCode = shell.Run(command, 0, True)

WScript.Quit exitCode
