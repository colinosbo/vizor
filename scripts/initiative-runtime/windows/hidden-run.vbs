Option Explicit
Dim shell, filesystem, launcher, project, role, command
If WScript.Arguments.Count <> 2 Then WScript.Quit 2
project = WScript.Arguments(0)
role = WScript.Arguments(1)
If InStr(project, Chr(34)) > 0 Then WScript.Quit 2
If role <> "Relay" And role <> "Scheduler" And role <> "Dashboard" And role <> "Webhooks" Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")
launcher = filesystem.BuildPath(filesystem.GetParentFolderName(WScript.ScriptFullName), "run.ps1")
command = Quote(shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe") & _
  " -NoProfile -NonInteractive -WindowStyle Hidden -File " & Quote(launcher) & _
  " -ProjectPath " & Quote(project) & " -Role " & Quote(role)
' WScript has no console. Hide PowerShell from process creation, then propagate
' its exit code so Task Scheduler can preserve existing restart/logon semantics.
WScript.Quit shell.Run(command, 0, True)

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
