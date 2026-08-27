# =====================================================================
# make-release.ps1 — 配布用の更新パッケージを作る
#
# アプリ本体（src と package.json）だけを固めた軽量zipを生成します。
# 数百KBなので、大容量ダウンロードが切断される回線でも確実に届きます。
#
# 使い方:
#   powershell -ExecutionPolicy Bypass -File .\make-release.ps1 -Version 0.7.0
#
# 生成物: release\listener-src-<Version>.zip
# これを GitHub の Releases 画面にドラッグして公開すれば、
# 各PCのListenerが「更新を確認」で検出します。
# =====================================================================
param(
    [Parameter(Mandatory=$true)][string]$Version
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "バージョンは 0.7.0 の形式で指定してください。" -ForegroundColor Red
    exit 1
}

# package.json のバージョンを更新
$pkgPath = Join-Path $root "package.json"
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$pkg.version = $Version
$pkg | ConvertTo-Json -Depth 20 | Set-Content $pkgPath -Encoding UTF8
Write-Host ("package.json を " + $Version + " に更新しました") -ForegroundColor Green

# 配布用zipを作成
$rel = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $rel | Out-Null
$stage = Join-Path $rel "_stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item (Join-Path $root "src") (Join-Path $stage "src") -Recurse
Copy-Item $pkgPath (Join-Path $stage "package.json")

$zip = Join-Path $rel ("listener-src-" + $Version + ".zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Remove-Item -Recurse -Force $stage

$sizeKB = [math]::Round((Get-Item $zip).Length / 1KB)
Write-Host ""
Write-Host "========================= 作成完了 =========================" -ForegroundColor Green
Write-Host ("  " + $zip + "  (" + $sizeKB + " KB)")
Write-Host ""
Write-Host "次の手順:"
Write-Host "  1. GitHub のリポジトリ画面で Releases -> Draft a new release"
Write-Host ("  2. Tag に v" + $Version + " を入力（Create new tag を選ぶ）")
Write-Host "  3. 変更点を本文に書く（アプリの更新画面にそのまま表示されます）"
Write-Host "  4. 上記のzipをドラッグして添付"
Write-Host "  5. Publish release"
Write-Host ""
Write-Host "各PCのListenerが起動時、または「更新を確認」で検出します。"
