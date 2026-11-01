' YouTube Downloader launcher (VBScript)
' Double-click this file to start. It runs node server.js directly,
' bypassing cmd.exe and any .bat parsing issues.

Option Explicit

Dim fso, shell, root, nodeExe, serverJs, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Script's own folder
root = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe  = root & "\runtime\node\node.exe"
serverJs = root & "\server.js"

If Not fso.FileExists(serverJs) Then
  MsgBox "server.js not found in:" & vbCrLf & root, 16, "YouTube Downloader"
  WScript.Quit 1
End If

If Not fso.FileExists(nodeExe) Then
  nodeExe = root & "\bin\node.exe"
  If Not fso.FileExists(nodeExe) Then
    MsgBox "node.exe not found." & vbCrLf & _
           "Expected at: " & root & "\runtime\node\node.exe", 16, "YouTube Downloader"
    WScript.Quit 1
  End If
End If

shell.CurrentDirectory = root

' NOTE: no separate PO Token service is started here.
'   The app generates PO tokens locally by forking the bundled script
'   (youtubepot-bgutilscript), which needs no background HTTP service.
'   Starting one only added startup delay. If that script is ever missing,
'   server.js starts the service by itself with a hidden window.

' Start the downloader service in a visible window.
' server.js opens the browser by itself once it is actually listening,
' so opening it here as well would just race the port and show an error page.
cmd = """" & nodeExe & """ """ & serverJs & """"
shell.Run cmd, 1, False
