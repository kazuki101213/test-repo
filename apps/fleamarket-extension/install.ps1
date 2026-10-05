param([string]$ProfileDirectory='Default')
$ErrorActionPreference='Stop'
if($ProfileDirectory -notmatch '^(Default|Profile [0-9]+)$'){throw 'Chromeプロファイル名を確認してください'}
$taskChromePaths=@(
  (Join-Path $env:ProgramFiles 'Google/Chrome/Application/chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google/Chrome/Application/chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google/Chrome/Application/chrome.exe')
)
$taskChrome=$taskChromePaths|Where-Object {Test-Path -LiteralPath $_}|Select-Object -First 1
if(!$taskChrome){throw 'Chromeが見つかりません'}
Set-Clipboard -Value $PSScriptRoot
Start-Process -FilePath $taskChrome -ArgumentList @("--profile-directory=`"$ProfileDirectory`"",'chrome://extensions/') -WindowStyle Normal
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.MessageBox]::Show("Chromeの右上で「デベロッパーモード」をオンにし、`n「パッケージ化されていない拡張機能を読み込む」を押してください。`n`nフォルダー選択で次のパスを貼り付けます（コピー済み）：`n$PSScriptRoot`n`n追加したら拡張機能のアイコンから「管理アプリと連携」を押します。`n詳細は同じフォルダーの README.md にあります。",'フリマ拡張機能の初回追加')|Out-Null
