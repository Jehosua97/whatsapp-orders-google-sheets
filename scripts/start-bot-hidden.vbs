Option Explicit

Dim fileSystem, shell, scriptDirectory, projectDirectory
Dim quote, command, exitCode

Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
projectDirectory = fileSystem.GetParentFolderName(scriptDirectory)
quote = Chr(34)

shell.CurrentDirectory = projectDirectory
command = "cmd.exe /d /s /c " & quote & quote & _
  scriptDirectory & "\start-bot.cmd" & quote & quote
exitCode = shell.Run(command, 0, True)

WScript.Quit exitCode
