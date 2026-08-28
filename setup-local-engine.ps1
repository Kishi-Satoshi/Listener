# =====================================================================
# Listener ローカルエンジン セットアップスクリプト
#
# whisper.cpp のWindows版バイナリと音声認識モデルをダウンロードします。
# ※ このスクリプトの実行時のみインターネット接続が必要です。
#    ダウンロード完了後、Listenerは完全オフラインで動作します。
#
# 実行方法（PowerShell）:
#   powershell -ExecutionPolicy Bypass -File .\setup-local-engine.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup-local-engine.ps1 -Model kotoba
#
# -Model の選択肢:
#   kotoba (推奨・高速)       … kotoba-whisper v2.0。日本語特化のdistil-large-v3。
#                               large-v3系の日本語精度のまま数倍高速。約577MB。日本語専用
#   large-v3-turbo-q5         … 多言語対応の従来モデル。約574MB
#   small / medium-q5         … さらに軽量（精度は落ちる）
#
# Windows PowerShell 5.1 / PowerShell 7 の両方で動作します。
# =====================================================================
param(
    [string]$Model = "kotoba",
    [switch]$ForceBinary
)

$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# --- 大容量ファイル用: 切断されても続きから再開するダウンロード ---
function Get-BigFile {
    param([string]$Url, [string]$Out, [long]$MinBytes)
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    $maxTry = 12
    for ($i = 1; $i -le $maxTry; $i++) {
        if ($curl) {
            # -C - : 部分ファイルの続きから再開 / -L : リダイレクト追従（Windowsの証明書ストアを使用）
            & curl.exe -L -sS --retry 3 --retry-delay 2 -C - -o $Out $Url
        }
        else {
            Invoke-WebRequest -Uri $Url -OutFile $Out
        }
        if ((Test-Path $Out) -and ((Get-Item $Out).Length -ge $MinBytes)) { return $true }
        $lenMB = 0
        if (Test-Path $Out) { $lenMB = [math]::Round((Get-Item $Out).Length / 1MB) }
        Write-Host ("  切断を検出（現在 " + $lenMB + " MB）。続きから再開します… 試行 " + $i + "/" + $maxTry) -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
    return $false
}

# --- モデル名の解決（switch式を使わず 5.1 互換に） ---
$modelFile = ""
$modelUrl  = ""
$minMB     = 0
if ($Model -eq "kotoba") {
    $modelFile = "ggml-kotoba-whisper-v2.0-q5_0.bin"
    $modelUrl  = "https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/main/ggml-kotoba-whisper-v2.0-q5_0.bin"
    $minMB     = 450
}
elseif ($Model -eq "large-v3-turbo-q5") {
    $modelFile = "ggml-large-v3-turbo-q5_0.bin"
    $modelUrl  = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
    $minMB     = 500
}
elseif ($Model -eq "small") {
    $modelFile = "ggml-small.bin"
    $modelUrl  = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
    $minMB     = 400
}
elseif ($Model -eq "medium-q5") {
    $modelFile = "ggml-medium-q5_0.bin"
    $modelUrl  = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin"
    $minMB     = 450
}
else {
    Write-Host "不明なモデル名です: $Model" -ForegroundColor Red
    Write-Host "指定できる値: kotoba / large-v3-turbo-q5 / small / medium-q5"
    exit 1
}

$root = Join-Path $PSScriptRoot "local-engine"
New-Item -ItemType Directory -Force -Path $root | Out-Null

# ---------------------------------------------------------------------
# 1) whisper.cpp Windowsバイナリ（whisper-server.exe を含む）
#    既に導入済みならスキップ（モデルだけ追加できる）。再取得は -ForceBinary
# ---------------------------------------------------------------------
$binDir = Join-Path $root "bin"
$server = $null
if (Test-Path $binDir) {
    $server = Get-ChildItem -Path $binDir -Recurse -Include "whisper-server.exe","server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
}

if ($server -and (-not $ForceBinary)) {
    Write-Host "[1/2] whisper.cpp バイナリは導入済みのためスキップします" -ForegroundColor Yellow
    Write-Host ("      " + $server.FullName)
    Write-Host "      （再ダウンロードしたい場合は -ForceBinary を付けて実行）"
}
else {
    # 使用中だと上書きできないため、Listenerが起動したエンジンを停止（DLLロック対策）
    Get-Process -Name "whisper-server","llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800

    Write-Host "[1/2] whisper.cpp バイナリをダウンロード中..." -ForegroundColor Cyan
    $binZip = Join-Path $root "whisper-bin-x64.zip"
    $binUrl = "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip"
    # 再開ありで取る。社内回線は大容量ダウンロードを途中で切ることがある
    $binOk = Get-BigFile -Url $binUrl -Out $binZip -MinBytes 5MB
    if (-not $binOk) {
        Write-Host "whisper.cpp バイナリを取得できませんでした。" -ForegroundColor Red
        Write-Host "ブラウザで次のURLを開いて $root に置き、もう一度実行してください:"
        Write-Host ("  " + $binUrl)
        exit 1
    }

    if (Test-Path $binDir) { Remove-Item -Recurse -Force $binDir }
    Expand-Archive -Path $binZip -DestinationPath $binDir -Force
    Remove-Item $binZip

    $server = Get-ChildItem -Path $binDir -Recurse -Include "whisper-server.exe","server.exe" | Select-Object -First 1
    if (-not $server) {
        Write-Host "whisper-server.exe が見つかりませんでした。zipの内容が変わった可能性があります。" -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------------
# 2) 音声認識モデル（ggml形式）
# ---------------------------------------------------------------------
$modelPath = Join-Path $root $modelFile
$minBytes  = $minMB * 1MB

# 既存ファイルのサイズ検証（途中で切れたダウンロードを検出）
if (Test-Path $modelPath) {
    $len = (Get-Item $modelPath).Length
    if ($len -lt $minBytes) {
        $lenMB = [math]::Round($len / 1MB)
        # ここで消すと curl.exe -C - の再開元が無くなり、毎回先頭から落とし直しになる。
        # 社内回線は115〜122MB付近で切れる実績があるため、消さずに続きから取る。
        Write-Host "[2/2] 既存のモデルが不完全です（$lenMB MB / 期待 $minMB MB以上）。続きから再開します。" -ForegroundColor Yellow
    }
    else {
        Write-Host "[2/2] モデルは既に存在します: $modelFile" -ForegroundColor Yellow
    }
}

if (-not (Test-Path $modelPath) -or ((Get-Item $modelPath).Length -lt $minBytes)) {
    Write-Host "[2/2] モデルをダウンロード中: $modelFile （数百MB・切断されても自動で再開します）..." -ForegroundColor Cyan
    $ok = Get-BigFile -Url $modelUrl -Out $modelPath -MinBytes $minBytes
    if (-not $ok) {
        Write-Host "再開を繰り返しても完了できませんでした。" -ForegroundColor Red
        Write-Host "ブラウザで次のURLを開いてダウンロードし、local-engine フォルダに置いてください:"
        Write-Host "  $modelUrl"
        exit 1
    }
    $lenMB = [math]::Round((Get-Item $modelPath).Length / 1MB)
    Write-Host "ダウンロード完了（$lenMB MB・サイズ検証OK）" -ForegroundColor Green
}


# ---------------------------------------------------------------------
# 3) VADモデル（Silero・約0.9MB）
#    無音区間をスキップして文字起こしを高速化し、繰り返し誤認識も減らします
# ---------------------------------------------------------------------
$vadFile = "ggml-silero-v6.2.0.bin"
$vadPath = Join-Path $root $vadFile
$vadUrl  = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin"

if ((Test-Path $vadPath) -and ((Get-Item $vadPath).Length -gt 500KB)) {
    Write-Host "[3/3] VADモデルは既に存在します: $vadFile" -ForegroundColor Yellow
}
else {
    Write-Host "[3/3] VADモデルをダウンロード中: $vadFile （約0.9MB）..." -ForegroundColor Cyan
    if (Test-Path $vadPath) { Remove-Item $vadPath -Force }
    $vadOk = Get-BigFile -Url $vadUrl -Out $vadPath -MinBytes 500KB
    if ($vadOk) {
        Write-Host "VADモデルの取得完了" -ForegroundColor Green
    }
    else {
        Write-Host "VADモデルの取得に失敗しました（VADなしでも動作します）" -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------
# 完了
# ---------------------------------------------------------------------
Write-Host ""
Write-Host "========================= セットアップ完了 =========================" -ForegroundColor Green
Write-Host "Listener の [設定] -> [文字起こしエンジン（whisper.cpp・オフライン）] に以下を貼り付けてください。"
Write-Host ""
Write-Host ("  whisper-server.exe : " + $server.FullName) -ForegroundColor White
Write-Host ("  モデルファイル     : " + $modelPath) -ForegroundColor White
if (Test-Path $vadPath) {
    Write-Host ("  VADモデル          : " + $vadPath) -ForegroundColor DarkGray
    Write-Host "  （VADモデルは自動検出されるため、設定画面への入力は不要です）" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "「起動テスト」で OK が出れば、以後は完全オフラインで使えます。"
Write-Host "※ 起動時にエラーが出る場合は Microsoft Visual C++ 再頒布可能パッケージ"
Write-Host "   (https://aka.ms/vs/17/release/vc_redist.x64.exe) をインストールしてください。"
