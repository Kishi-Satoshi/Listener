# =====================================================================
# get-installer.ps1 — Listener のインストーラーを確実に取得する
#
# 社内回線は大容量ダウンロードを途中で切ることがある（115〜122MB付近で
# 切断する実績あり）。ブラウザで落とすと止まったまま進まないため、
# curl.exe の -C - で「続きから」を繰り返す。setup-*.ps1 の Get-BigFile と同じ方式。
#
# 落とし終わったらサイズと SHA256 を突き合わせて、壊れていないか確かめる。
#
# 実行方法（PowerShell）:
#   powershell -ExecutionPolicy Bypass -File .\get-installer.ps1
#   powershell -ExecutionPolicy Bypass -File .\get-installer.ps1 -Version 0.9.0
#
# Windows PowerShell 5.1 / PowerShell 7 の両方で動作します。
# =====================================================================
param(
    [string]$Version = "",
    [string]$OutDir = "."
)

$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$repo = "Kishi-Satoshi/Listener"
if ($Version -eq "") {
    $api = "https://api.github.com/repos/$repo/releases/latest"
}
else {
    $api = "https://api.github.com/repos/$repo/releases/tags/v$Version"
}

# --- リリース情報の取得 ---
# Invoke-RestMethod は Windows のプロキシ設定を使う。それが通らない環境も
# あるので、駄目なら curl.exe に切り替える。
Write-Host "リリース情報を取得中..." -ForegroundColor Cyan
$rel = $null
try {
    $rel = Invoke-RestMethod -Uri $api -UseBasicParsing
}
catch {
    try {
        $json = & curl.exe -L -sS $api
        $rel = $json | ConvertFrom-Json
    }
    catch {
        Write-Host "リリース情報を取得できませんでした。ネットワーク設定を確認してください。" -ForegroundColor Red
        Write-Host "  $api"
        exit 1
    }
}

$asset = $rel.assets | Where-Object { $_.name -like "*-setup.exe" } | Select-Object -First 1
if (-not $asset) {
    Write-Host "インストーラーがリリースに添付されていません（$($rel.tag_name)）。" -ForegroundColor Red
    exit 1
}

$expected = [long]$asset.size
$out = Join-Path $OutDir $asset.name
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host ("  " + $rel.tag_name + " / " + $asset.name + " / " + [math]::Round($expected / 1MB) + " MB")

# --- 既にあるファイルの扱い ---
if (Test-Path $out) {
    $len = (Get-Item $out).Length
    if ($len -gt $expected) {
        Write-Host "既存ファイルが期待より大きいため、取り直します。" -ForegroundColor Yellow
        Remove-Item $out -Force
    }
    elseif ($len -lt $expected) {
        Write-Host ("途中まで取得済み（" + [math]::Round($len / 1MB) + " MB）。続きから再開します。") -ForegroundColor Yellow
    }
}

# --- 続きから繰り返し取得 ---
$maxTry = 40
for ($i = 1; $i -le $maxTry; $i++) {
    if ((Test-Path $out) -and ((Get-Item $out).Length -eq $expected)) { break }

    # -C - : 部分ファイルの続きから再開 / -L : リダイレクト追従
    & curl.exe -L -sS --retry 3 --retry-delay 2 -C - -o $out $asset.browser_download_url

    $len = 0
    if (Test-Path $out) { $len = (Get-Item $out).Length }
    if ($len -eq $expected) { break }

    $pct = 0
    if ($expected -gt 0) { $pct = [math]::Round(100 * $len / $expected) }
    Write-Host ("  切断を検出（" + [math]::Round($len / 1MB) + " / " + [math]::Round($expected / 1MB) + " MB・" + $pct + "%）。続きから再開します… 試行 " + $i + "/" + $maxTry) -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}

# --- 検証 ---
if (-not (Test-Path $out)) {
    Write-Host "ダウンロードできませんでした。" -ForegroundColor Red
    exit 1
}
$len = (Get-Item $out).Length
if ($len -ne $expected) {
    Write-Host ("再開を繰り返しても完了できませんでした（" + $len + " / " + $expected + " バイト）。") -ForegroundColor Red
    Write-Host "もう一度このスクリプトを実行すると、続きから再開します。"
    exit 1
}

# GitHub が公開しているハッシュと突き合わせる（あれば）
$digest = ""
try { $digest = [string]$asset.digest } catch { }
if ($digest -like "sha256:*") {
    $want = $digest.Substring(7).ToLower()
    $got = (Get-FileHash -Path $out -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) {
        Write-Host "SHA256 が一致しません。ファイルが壊れています。" -ForegroundColor Red
        Write-Host ("  期待: " + $want)
        Write-Host ("  実際: " + $got)
        Write-Host "このファイルを削除して、もう一度実行してください。"
        exit 1
    }
    Write-Host "SHA256 検証 OK" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================= 取得完了 =========================" -ForegroundColor Green
Write-Host ("  " + (Resolve-Path $out))
Write-Host ""
Write-Host "このファイルを実行するとインストールされます（管理者権限は不要です）。"
Write-Host "インストール後の更新は数百KBの差分だけを取得するので、"
Write-Host "この大きなファイルを落とすのは初回だけです。"
