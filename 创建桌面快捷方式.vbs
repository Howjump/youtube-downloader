' ============================================================
'  Create a desktop shortcut for "YouTube Downloader".
'  Just double-click this file.
'
'  NOTE: this script is intentionally ASCII-only.
'        Windows Script Host reads .vbs as ANSI, so any non-ASCII
'        literal here would be garbled on a different code page.
'        The Chinese file name is therefore built from character
'        codes at runtime instead of being written literally.
' ============================================================
Option Explicit

Dim fso, shell, root, batPath, iconPath, desktop, lnk, logo
Dim name, desc

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' --- Build the Chinese strings from Unicode code points (code-page safe)
'     "Start Downloader.bat" in Chinese:  \u542f\u52a8\u4e0b\u8f7d\u5668.bat
name = ChrW(&H542F) & ChrW(&H52A8) & ChrW(&H4E0B) & ChrW(&H8F7D) & ChrW(&H5668)
desc = name & " - local YouTube video downloader (all resolutions)"

root = fso.GetParentFolderName(WScript.ScriptFullName)

batPath  = root & "\" & name & ".bat"
iconPath = root & "\app-icon.ico"

If Not fso.FileExists(batPath) Then
  MsgBox "Cannot find the launcher script:" & vbCrLf & vbCrLf & _
         batPath & vbCrLf & vbCrLf & _
         "Please keep this file in the same folder as the app.", _
         16, "Shortcut creation failed"
  WScript.Quit 1
End If

' --- Desktop folder (read registry first; OneDrive may redirect it)
desktop = ""
On Error Resume Next
desktop = shell.RegRead("HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders\Desktop")
On Error GoTo 0
If desktop = "" Or Not fso.FolderExists(desktop) Then
  desktop = shell.SpecialFolders("Desktop")
End If
If desktop = "" Or Not fso.FolderExists(desktop) Then
  MsgBox "Cannot locate the Desktop folder.", 16, "Shortcut creation failed"
  WScript.Quit 1
End If

' --- Create the desktop shortcut
lnk = desktop & "\" & name & ".lnk"
Set logo = shell.CreateShortcut(lnk)
logo.TargetPath       = batPath
logo.WorkingDirectory = root
logo.Description      = desc
logo.WindowStyle      = 1
If fso.FileExists(iconPath) Then logo.IconLocation = iconPath & ",0"
logo.Save

' --- Also drop one into the Start Menu so Win-key search finds it
Dim progDir, lnk2
progDir = shell.SpecialFolders("Programs")
If progDir <> "" Then
  On Error Resume Next
  If Not fso.FolderExists(progDir & "\" & name) Then fso.CreateFolder(progDir & "\" & name)
  lnk2 = progDir & "\" & name & "\" & name & ".lnk"
  Set logo = shell.CreateShortcut(lnk2)
  logo.TargetPath       = batPath
  logo.WorkingDirectory = root
  logo.Description      = desc
  logo.WindowStyle      = 1
  If fso.FileExists(iconPath) Then logo.IconLocation = iconPath & ",0"
  logo.Save
  On Error GoTo 0
End If

MsgBox "Shortcut created on your Desktop:" & vbCrLf & vbCrLf & _
       lnk & vbCrLf & vbCrLf & _
       "A copy was also added to the Start Menu.", 64, "Done"
