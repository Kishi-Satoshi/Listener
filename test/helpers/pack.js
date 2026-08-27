/*
 * pack.js — テスト用に配布zipを作る
 *
 * make-release.ps1 と同じ中身（zip直下に src/ と package.json）を、
 * 各OSの標準ツールで固める。Windows では make-release.ps1 と同じ
 * Compress-Archive を使うので、実際に配る形式そのものを検証できる。
 * どちらも無い環境ではテスト側でスキップする。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function packerAvailable() {
  if (process.platform === 'win32') return true;
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); return true; } catch (_) { return false; }
}

/**
 * stageDir の中身を zipPath に固める（中身がzip直下に来る）。
 */
function packDir(stageDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${path.join(stageDir, '*')}' -DestinationPath '${zipPath}'`,
    ], { windowsHide: true, stdio: 'ignore' });
  } else {
    execFileSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: stageDir, stdio: 'ignore' });
  }
  return zipPath;
}

/** 配布物と同じ構成（src/ + package.json）を組み立てて固める */
function packRelease(repoRoot, workDir, version) {
  const stage = path.join(workDir, '_stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'src'), path.join(stage, 'src'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  pkg.version = version;
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  return packDir(stage, path.join(workDir, `listener-src-${version}.zip`));
}

module.exports = { packerAvailable, packDir, packRelease };
