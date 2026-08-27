/*
 * updater.js — GitHub Releases から更新を取得して適用する
 *
 * 方針:
 *  - 配布するのは src/ だけを固めた軽量zip（約150KB）。
 *    インストーラー丸ごと（80MB超）だと、大容量ダウンロードを切断する
 *    ネットワーク環境で更新のたびに失敗しかねないため。
 *  - 適用前に必ず現行の src/ をバックアップする。
 *    展開途中で落ちるとアプリが起動しなくなるので、戻せる状態を残す。
 *  - オフライン運用が前提なので、繋がらない時は静かに諦める。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 更新の配布元。fork した場合はここだけ書き換えれば動く。
const REPO = 'Kishi-Satoshi/Listener';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_PATTERN = /^listener-src-.*\.zip$/i;

/*
 * 通信は Electron の net 経由で行う。
 *
 * Node のグローバル fetch は、Windowsのプロキシ設定も証明書ストアも見ない。
 * 社内プロキシ（特にSSL検査あり）の環境では、それだけで
 * 「ネットワークに接続できません」になる。
 * Electron の net は Chromium のネットワークスタックを使うため、
 * システムのプロキシ設定・PAC・資格情報・証明書ストアがそのまま効く。
 *
 * Electron の外（テスト）では net が無いので、Node の fetch に落とす。
 */
function httpFetch(url, opts) {
  try {
    // eslint-disable-next-line global-require
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch(url, opts);
  } catch (_) { /* Electron 外 */ }
  return fetch(url, opts);
}

function log(userDataPath, line) {
  try {
    fs.appendFileSync(path.join(userDataPath, 'update.log'),
      `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (_) { /* noop */ }
}

/** '1.2.3' 同士を比較。a が新しければ 1 */
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 最新リリースを問い合わせる。
 * @returns {{ok:boolean, update?:boolean, version?:string, notes?:string, url?:string, size?:number, error?:string}}
 */
async function check(currentVersion, userDataPath) {
  try {
    const res = await httpFetch(API_LATEST, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Listener' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return { ok: false, error: 'リリースが見つかりません（まだ公開されていない可能性があります）' };
    if (!res.ok) return { ok: false, error: `更新情報を取得できません (${res.status})` };
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/, '');
    if (!latest) return { ok: false, error: 'リリースにバージョン情報がありません' };

    const asset = (data.assets || []).find((a) => ASSET_PATTERN.test(a.name));
    if (!asset) return { ok: false, error: '更新ファイル（listener-src-*.zip）がリリースに添付されていません' };

    const newer = cmpVersion(latest, currentVersion) > 0;
    log(userDataPath, `check: current=${currentVersion} latest=${latest} newer=${newer}`);
    return {
      ok: true,
      update: newer,
      version: latest,
      notes: String(data.body || '').slice(0, 4000),
      url: asset.browser_download_url,
      size: asset.size || 0,
      publishedAt: data.published_at || '',
    };
  } catch (e) {
    // 実際の失敗理由は update.log に残す。
    // 「ネットワークに接続できません」だけでは、切断なのか
    // プロキシなのか証明書なのかが切り分けられない。
    log(userDataPath, `check failed: ${e.message}`);
    const offline = /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|abort|ERR_/i.test(e.message || '');
    return {
      ok: false,
      offline,
      error: offline
        ? 'ネットワークに接続できません（データ保存先の update.log に詳細が残ります）'
        : e.message,
    };
  }
}

/** 再試行つきダウンロード。細切れでも落とし切る */
async function download(url, dest, onProgress) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpFetch(url, {
        headers: { 'User-Agent': 'Listener' },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error('ダウンロードが不完全です');
      fs.writeFileSync(dest, buf);
      if (onProgress) onProgress(buf.length);
      return buf.length;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error('ダウンロードに失敗しました');
}

/**
 * zip を展開して src/ を差し替える。
 * PowerShell の Expand-Archive を使う（追加依存を増やさないため）。
 */
function expandZip(zipPath, destDir) {
  const { execFileSync } = require('child_process');
  // 展開ツールは軽微な警告でも非0を返すことがある（unzip の "extra bytes" 等）。
  // 終了コードで判断せず、この後の実ファイル検査で成否を決める。
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ], { windowsHide: true, timeout: 120000, stdio: 'ignore' });
    } else {
      execFileSync('unzip', ['-o', zipPath, '-d', destDir], { timeout: 120000, stdio: 'ignore' });
    }
  } catch (e) {
    if (!fs.existsSync(destDir) || fs.readdirSync(destDir).length === 0) {
      throw new Error(`更新ファイルを展開できませんでした: ${e.message.split('\n')[0]}`);
    }
  }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

/**
 * 更新を適用する。appRoot は package.json のあるフォルダ。
 * 失敗時はバックアップから自動で復旧する。
 */
async function apply(url, appRoot, userDataPath, onProgress) {
  // 一時フォルダの作成も try の中で行う。ここで投げると呼び出し側は
  // { ok:false } ではなく例外を受け取り、画面のボタンが押せないまま残る。
  let work = '';
  const srcDir = path.join(appRoot, 'src');
  const backup = path.join(appRoot, `src.backup-${Date.now()}`);

  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-up-'));
    const zip = path.join(work, 'update.zip');
    const ext = path.join(work, 'extracted');

    if (onProgress) onProgress('更新をダウンロードしています…');
    const bytes = await download(url, zip);
    log(userDataPath, `downloaded ${bytes} bytes`);

    if (onProgress) onProgress('展開しています…');
    fs.mkdirSync(ext, { recursive: true });
    expandZip(zip, ext);

    // zip の中身は src/ 直下、または <任意のフォルダ>/src/ のどちらでも受け入れる
    let newSrc = path.join(ext, 'src');
    if (!fs.existsSync(newSrc)) {
      const sub = fs.readdirSync(ext).map((d) => path.join(ext, d, 'src')).find((p) => fs.existsSync(p));
      if (sub) newSrc = sub;
    }
    if (!fs.existsSync(newSrc)) throw new Error('更新ファイルに src フォルダが含まれていません');
    // 最低限の健全性確認（壊れたzipで上書きしないため）
    for (const must of ['main.js', 'preload.js', path.join('renderer', 'app.html')]) {
      if (!fs.existsSync(path.join(newSrc, must))) throw new Error(`更新ファイルが不完全です（${must} がありません）`);
    }

    if (onProgress) onProgress('適用しています…');
    if (fs.existsSync(srcDir)) fs.renameSync(srcDir, backup);
    try {
      fs.cpSync(newSrc, srcDir, { recursive: true });
    } catch (e) {
      // 失敗したら元に戻す。ここでの復旧に失敗すると src/ が無いまま残り、
      // アプリが起動しなくなる。復旧処理自体も必ず最後までやり切る。
      try {
        if (fs.existsSync(srcDir)) fs.renameSync(srcDir, `${srcDir}.failed-${Date.now()}`);
      } catch (_) { rmrf(srcDir); }
      try {
        if (!fs.existsSync(srcDir) && fs.existsSync(backup)) fs.renameSync(backup, srcDir);
      } catch (e2) {
        log(userDataPath, `rollback failed: ${e2.message}`);
        throw new Error(`更新に失敗し、元に戻すこともできませんでした。${path.basename(backup)} を src にリネームしてください。`);
      }
      throw e;
    }

    // package.json の version も更新（あれば）
    const newPkg = path.join(path.dirname(newSrc), 'package.json');
    if (fs.existsSync(newPkg)) {
      try {
        // Windows PowerShell 5.1 の Set-Content -Encoding UTF8 は BOM を付ける。
        // BOM が残ったままだと JSON.parse が投げ、version が永久に上がらない。
        const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
        const cur = readJson(path.join(appRoot, 'package.json'));
        const nxt = readJson(newPkg);
        if (nxt.version) {
          cur.version = nxt.version;
          fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify(cur, null, 2), 'utf8');
        }
      } catch (e) {
        // version の更新は必須ではないが、黙って落とすと「更新しても版が上がらない」
        // という分かりにくい状態になるため記録は残す
        log(userDataPath, `package.json version update skipped: ${e.message}`);
      }
    }

    // 直近1つだけバックアップを残し、古いものは掃除する
    for (const d of fs.readdirSync(appRoot)) {
      if (d.startsWith('src.backup-') && path.join(appRoot, d) !== backup) rmrf(path.join(appRoot, d));
    }

    log(userDataPath, `applied. backup=${path.basename(backup)}`);
    if (work) rmrf(work);
    return { ok: true, backup: path.basename(backup) };
  } catch (e) {
    log(userDataPath, `apply failed: ${e.message}`);
    if (work) rmrf(work);
    return { ok: false, error: e.message };
  }
}

module.exports = { check, apply, cmpVersion, REPO };
