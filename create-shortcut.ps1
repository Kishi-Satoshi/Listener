# =====================================================================
# Listener ショートカット作成スクリプト
# デスクトップとスタートメニューに Listener.lnk を作成します。
# スタートメニューに入るため、Windowsキー →「koetype」で検索・起動できる
# 標準的なアプリと同じ起動導線になります（コンソールは一切出ません）。
#
# 実行方法（アプリのフォルダ内で実行してください）:
#   powershell -ExecutionPolicy Bypass -File .\create-shortcut.ps1
# =====================================================================
$ErrorActionPreference = "Stop"

$app      = $PSScriptRoot
$electron = Join-Path $app "node_modules\electron\dist\electron.exe"
$icon     = Join-Path $app "assets\icon.ico"

if (-not (Test-Path $electron)) {
    Write-Host "electron.exe が見つかりません: $electron" -ForegroundColor Red
    Write-Host "先に npm install を実行してください。"
    exit 1
}

$desktop   = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @($desktop, $startMenu)) {
    $lnkPath = Join-Path $dir "Listener.lnk"
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $electron
    $lnk.Arguments        = '"' + $app + '"'
    $lnk.WorkingDirectory = $app
    if (Test-Path $icon) { $lnk.IconLocation = $icon }
    $lnk.Description      = "Listener - 声で、書く。（完全オフライン音声入力・議事録）"
    $lnk.Save()
    Write-Host ("作成: " + $lnkPath) -ForegroundColor Green
}

Write-Host ""
Write-Host "完了しました。デスクトップのアイコン、または Windowsキー →「koetype」で起動できます。" -ForegroundColor Cyan
