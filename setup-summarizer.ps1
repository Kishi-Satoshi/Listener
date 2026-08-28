# =====================================================================
# Listener 要約エンジン セットアップスクリプト（議事録の自動要約用・任意）
#
# llama.cpp のWindows版バイナリ（llama-server）と、日本語対応の
# ローカルLLMモデル（GGUF形式）をダウンロードします。
# ※ このスクリプトの実行時のみインターネット接続が必要です。
#    ダウンロード完了後は完全オフラインで動作します。
#
# 実行方法（PowerShell）:
#   powershell -ExecutionPolicy Bypass -File .\setup-summarizer.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup-summarizer.ps1 -Model 7b
#
# -Model の選択肢:
#   3b (既定) … Qwen2.5-3B-Instruct  約1.9GB。CPUでも実用速度
#   7b        … Qwen2.5-7B-Instruct  約4.7GB。高品質だが要約に時間がかかる
#
# Windows PowerShell 5.1 / PowerShell 7 の両方で動作します。
# =====================================================================
param(
    [string]$Model = "3b"
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

# --- モデルURLの解決（if/elseif で 5.1 互換に） ---
$modelUrl = ""
$modelFile = ""
$minMB = 0
if ($Model -eq "3b") {
    $modelFile = "Qwen2.5-3B-Instruct-Q4_K_M.gguf"
    $modelUrl  = "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf"
    $minMB     = 1700
}
elseif ($Model -eq "7b") {
    $modelFile = "Qwen2.5-7B-Instruct-Q4_K_M.gguf"
    $modelUrl  = "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf"
    $minMB     = 4300
}
else {
    Write-Host "不明なモデル名です: $Model （指定できる値: 3b / 7b）" -ForegroundColor Red
    exit 1
}

$root = Join-Path $PSScriptRoot "local-engine"
$llmRoot = Join-Path $root "llm"
New-Item -ItemType Directory -Force -Path $llmRoot | Out-Null

# ---------------------------------------------------------------------
# 1) llama.cpp Windowsバイナリ（llama-server.exe を含む）
#    最新リリースのタグをGitHub APIで取得し、CPU版zipをダウンロード
# ---------------------------------------------------------------------
Write-Host "[1/2] llama.cpp バイナリをダウンロード中..." -ForegroundColor Cyan
# リリース情報の取得。Invoke-RestMethod が通らない環境があるので curl.exe に落とす
$api = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
$latest = $null
try {
    $latest = Invoke-RestMethod -Uri $api
}
catch {
    try { $latest = (& curl.exe -L -sS $api) | ConvertFrom-Json } catch { }
}
if (-not $latest) {
    Write-Host "llama.cpp のリリース情報を取得できませんでした。" -ForegroundColor Red
    Write-Host "  $api"
    exit 1
}
$tag = $latest.tag_name

$asset = $latest.assets | Where-Object { $_.name -like "llama-*-bin-win-cpu-x64.zip" } | Select-Object -First 1
if (-not $asset) {
    # 旧命名（avx2）へのフォールバック
    $asset = $latest.assets | Where-Object { $_.name -like "llama-*-bin-win-avx2-x64.zip" } | Select-Object -First 1
}
if (-not $asset) {
    Write-Host "Windows CPU版のバイナリが見つかりませんでした（リリース: $tag）。" -ForegroundColor Red
    Write-Host "https://github.com/ggml-org/llama.cpp/releases から手動でダウンロードしてください。"
    exit 1
}

$binZip = Join-Path $llmRoot $asset.name
# ここも再開ありで取る。数十MBあり、社内回線では途中で切れることがある
# （切れたまま展開すると壊れたzipになる）
$binOk = Get-BigFile -Url $asset.browser_download_url -Out $binZip -MinBytes ([long]$asset.size)
if (-not $binOk) {
    Write-Host "llama.cpp バイナリを取得できませんでした。" -ForegroundColor Red
    Write-Host "ブラウザで次のURLを開いて $llmRoot に置き、もう一度実行してください:"
    Write-Host ("  " + $asset.browser_download_url)
    exit 1
}

$binDir = Join-Path $llmRoot "bin"
if (Test-Path $binDir) { Remove-Item -Recurse -Force $binDir }
Expand-Archive -Path $binZip -DestinationPath $binDir -Force
Remove-Item $binZip

$server = Get-ChildItem -Path $binDir -Recurse -Include "llama-server.exe" | Select-Object -First 1
if (-not $server) {
    Write-Host "llama-server.exe が見つかりませんでした。" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------
# 2) 要約用LLMモデル（GGUF形式）
# ---------------------------------------------------------------------
$modelPath = Join-Path $llmRoot $modelFile
$minBytes  = $minMB * 1MB

if (Test-Path $modelPath) {
    $len = (Get-Item $modelPath).Length
    if ($len -lt $minBytes) {
        $lenMB = [math]::Round($len / 1MB)
        Write-Host "[2/2] 既存のモデルが不完全です（$lenMB MB / 期待 $minMB MB以上）。続きから再開します。" -ForegroundColor Yellow
    }
    else {
        Write-Host "[2/2] モデルは既に存在します: $modelFile" -ForegroundColor Yellow
    }
}

if (-not (Test-Path $modelPath) -or ((Get-Item $modelPath).Length -lt $minBytes)) {
    Write-Host "[2/2] モデルをダウンロード中: $modelFile （数GB・切断されても自動で再開します）..." -ForegroundColor Cyan
    $ok = Get-BigFile -Url $modelUrl -Out $modelPath -MinBytes $minBytes
    if (-not $ok) {
        Write-Host "再開を繰り返しても完了できませんでした。" -ForegroundColor Red
        Write-Host "ブラウザで次のURLを開いてダウンロードし、local-engine\llm フォルダに置いてください:"
        Write-Host "  $modelUrl"
        exit 1
    }
    $lenMB = [math]::Round((Get-Item $modelPath).Length / 1MB)
    Write-Host "ダウンロード完了（$lenMB MB・サイズ検証OK）" -ForegroundColor Green
}

# ---------------------------------------------------------------------
# 完了
# ---------------------------------------------------------------------
Write-Host ""
Write-Host "========================= セットアップ完了 =========================" -ForegroundColor Green
Write-Host "Listener の [設定] -> [要約エンジン（llama.cpp）] に以下を貼り付けてください。"
Write-Host ""
Write-Host ("  llama-server.exe : " + $server.FullName) -ForegroundColor White
Write-Host ("  モデルファイル   : " + $modelPath) -ForegroundColor White
Write-Host ""
Write-Host "「起動テスト」で OK が出れば、議事録の自動要約が完全オフラインで使えます。"
