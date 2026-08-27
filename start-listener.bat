@echo off
rem 日本語メッセージのため、コンソールをUTF-8にする（このファイルはBOM無しUTF-8）
chcp 65001 >nul
rem =====================================================
rem Listener 起動（コンソールウィンドウを残しません）
rem このbatが置かれたフォルダをアプリ本体とみなします。
rem =====================================================
set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

if not exist "%APPDIR%\node_modules\electron\dist\electron.exe" (
  echo electron.exe が見つかりません。先に npm install を実行してください。
  pause
  exit /b 1
)

start "" "%APPDIR%\node_modules\electron\dist\electron.exe" "%APPDIR%"
exit /b 0
