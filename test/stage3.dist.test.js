/*
 * stage3.dist.test.js — 第3段（v0.11.0）配布まわりの固定
 *
 *  #33 公開の順序: exe が付く前に latest にしない（draft で作り、installer が公開する）
 *
 * GitHub Actions は手元で回せないので、YAML を文字列として読み、
 * 「どのジョブに・どの順で・どの旗が付いているか」を固定する。
 * YAML パーサは入れない（追加の npm 依存を増やさない）。
 * ジョブは 2 桁インデントのキー、ステップは 6 桁インデントの "- " で切る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const YML = '.github/workflows/release.yml';
const yml = read(YML);

/** jobs: 配下を { 名前: 本文 } に切る */
function jobs() {
  const i = yml.indexOf('\njobs:\n');
  assert.ok(i >= 0, `${YML} に jobs: が無い`);
  const body = yml.slice(i + '\njobs:\n'.length);
  const out = {};
  const re = /^  ([\w-]+):[ \t]*\n/gm;
  const hits = [...body.matchAll(re)];
  hits.forEach((m, k) => {
    const from = m.index + m[0].length;
    const to = k + 1 < hits.length ? hits[k + 1].index : body.length;
    out[m[1]] = body.slice(from, to);
  });
  return out;
}

/** ジョブ本文を steps の配列（各ステップの生テキスト）に切る。行頭コメントは落とす */
function steps(job) {
  const i = job.indexOf('\n    steps:\n');
  assert.ok(i >= 0, 'steps: が無い');
  return job.slice(i + '\n    steps:\n'.length)
    .replace(/^[ \t]*#[^\n]*\n/gm, '')
    .split(/^      - /m).filter((s) => s.trim());
}
const nameOf = (s) => (s.match(/^\s*name:\s*(.+)$/m) || [])[1] || (s.match(/^uses:\s*(.+)$/m) || [])[1] || '';
const ifOf = (s) => (s.match(/^\s*if:\s*(.+)$/m) || [])[1] || '';
/** `gh release <sub>` のコマンド行を取り出す（"\" の継続行は 1 行に繋ぐ） */
function ghCommand(text, sub) {
  const joined = text.replace(/\\\n[ \t]*/g, ' ');
  return joined.match(new RegExp(`gh release ${sub}[^\\n]*`, 'g')) || [];
}

test('release.yml が簡易に読める（タブ無し・ジョブは release と installer・各ステップに名前）', () => {
  assert.ok(!/\t/.test(yml), 'YAML にタブがある');
  const j = jobs();
  assert.deepStrictEqual(Object.keys(j), ['release', 'installer']);
  for (const [name, body] of Object.entries(j)) {
    const names = steps(body).map((s) => nameOf(s));
    names.forEach((n, k) => assert.ok(n, `${name} ジョブに名前の無いステップがある（${k + 1} 番目）`));
    assert.strictEqual(new Set(names).size, names.length, `${name} ジョブに同じ名前のステップが 2 つある（貼り間違い）: ${names.join(' / ')}`);
  }
  assert.match(j.installer, /^    needs:\s*release$/m, 'installer は release の後に走る');
});

test('#33 release ジョブは draft で作り、latest にしない', () => {
  const j = jobs();
  const creates = ghCommand(j.release, 'create');
  assert.strictEqual(creates.length, 1, 'release ジョブの gh release create は 1 箇所');
  assert.ok(/--draft(\s|$)/.test(creates[0]), 'gh release create に --draft が無い（exe が付く前に見えてしまう）');
  assert.ok(!/--latest/.test(creates[0]), 'gh release create に --latest がある（exe 無しで latest になる）');

  const edits = ghCommand(j.release, 'edit');
  assert.ok(edits.length >= 1, '既存リリースを更新する経路（gh release edit）が無い');
  for (const e of edits) {
    assert.ok(!/--latest/.test(e), '作り直しの経路で --latest を付けている');
    assert.ok(/--draft(\s|$)/.test(e), '作り直しの経路で draft に戻していない（zip だけ差し替わった状態が見える）');
  }
  // 公開（draft 解除）は release ジョブでは行わない
  assert.ok(!/--draft=false/.test(j.release), 'release ジョブで draft を解除している');
  // 一時ブランチの削除は release ジョブには無い（公開できた後に installer で消す）
  assert.ok(!/git push origin --delete/.test(j.release), 'release ジョブで一時ブランチを消している（公開前に消える）');
  // installer に渡すために cleanup を出力する
  assert.match(j.release, /^\s+cleanup:\s*\$\{\{\s*steps\.ver\.outputs\.cleanup\s*\}\}/m, 'release ジョブが cleanup を outputs に出していない');
  assert.ok(/echo "cleanup=\$CLEANUP" >> "\$GITHUB_OUTPUT"/.test(j.release), 'cleanup を GITHUB_OUTPUT に書いていない');
});

test('#33 installer ジョブは exe を添付した後に --draft=false --latest で公開する（既に exe がある経路でも）', () => {
  const j = jobs();
  assert.match(j.installer, /^    permissions:\n(?:      [^\n]*\n)*?      contents:\s*write/m,
    'installer ジョブに contents: write が無い（公開と一時ブランチの削除に要る）');
  const st = steps(j.installer);
  const iUpload = st.findIndex((s) => /gh release upload[^\n]*-setup\.exe/.test(s));
  assert.ok(iUpload >= 0, 'exe を添付するステップが無い');
  const iPublish = st.findIndex((s) => ghCommand(s, 'edit').some((c) => /--draft=false/.test(c) && /--latest/.test(c)));
  assert.ok(iPublish >= 0, '--draft=false --latest で公開するステップが無い');
  assert.ok(iPublish > iUpload, '公開が exe の添付より前にある');
  const pub = st[iPublish];
  assert.ok(!/skip\s*==\s*'false'/.test(ifOf(pub)), '既に exe が添付されている経路（skip=true）で公開が走らない');
  assert.ok(!/failure\(\)|always\(\)/.test(ifOf(pub)), '失敗しても公開してしまう');
  assert.ok(/\$\{\{\s*needs\.release\.outputs\.tag\s*\}\}/.test(pub), '公開ステップが TAG を受け取っていない');
  // exe を作るステップは skip=false のときだけ（作り直さない）— 既存の性質を壊していないこと
  const build = st.find((s) => /dist:installer/.test(s));
  assert.ok(build && /skip\s*==\s*'false'/.test(ifOf(build)), 'exe を毎回作り直している');
});

test('#33 一時ブランチ release/v* の削除は公開できた後（installer ジョブの最後・success()）', () => {
  const j = jobs();
  const st = steps(j.installer);
  const iPublish = st.findIndex((s) => /--draft=false/.test(s));
  const iDel = st.findIndex((s) => /git push origin --delete/.test(s));
  assert.ok(iDel >= 0, 'installer ジョブに一時ブランチの削除が無い');
  assert.ok(iDel > iPublish, '公開の前にブランチを消している');
  const cond = ifOf(st[iDel]);
  assert.ok(/success\(\)/.test(cond), `削除の条件に success() が無い: ${cond}`);
  assert.ok(/needs\.release\.outputs\.cleanup/.test(cond), `削除の条件が release ジョブの cleanup を見ていない: ${cond}`);
  assert.ok(/needs\.release\.outputs\.cleanup/.test(st[iDel]), '消すブランチ名を release ジョブから受け取っていない');
  // 削除以外に履歴は要らないので、installer の checkout は浅いまま（fetch-depth: 0 にしない）
  const co = st.find((s) => /actions\/checkout@/.test(s));
  assert.ok(co && !/fetch-depth:\s*0/.test(co), 'installer の checkout が履歴ごと取っている');
  // 後ろに続くステップが失敗しても、ブランチ削除は最後なので公開済みの状態は変わらない
  assert.strictEqual(iDel, st.length - 1, '一時ブランチの削除は installer ジョブの最後に置く');
});

test('#33 installer が失敗したら draft のまま残し、要約に赤い見出しを出す', () => {
  const j = jobs();
  const st = steps(j.installer);
  const fail = st.find((s) => /^\s*if:\s*failure\(\)\s*$/m.test(s));
  assert.ok(fail, 'if: failure() のステップが無い');
  assert.ok(/::error::/.test(fail), '失敗の要約に ::error:: が無い（Actions の一覧で赤くならない）');
  assert.ok(/## ❌ 公開されていません（draft のまま）/.test(fail), '失敗の要約に見出し「## ❌ 公開されていません（draft のまま）」が無い');
  assert.ok(/GITHUB_STEP_SUMMARY/.test(fail), '失敗の要約を $GITHUB_STEP_SUMMARY に書いていない');
  // draft を消す・公開するといった後始末を failure() の経路でやらない
  assert.ok(!/gh release (delete|edit)/.test(fail), '失敗時に release を消したり公開したりしている');
  // draft の間はアプリの更新確認に前の版が出続ける、という注意が YAML に書いてある
  assert.ok(/releases\/latest/.test(yml) && /前の版/.test(yml), 'draft の間は前の版が latest のまま、という注意が無い');
});

// ---------------------------------------------------------------- #34 互換ゲート
test('#34 package.json の engines.electron が devDependencies.electron と揃い、updater が読める形である', () => {
  const pkg = JSON.parse(read('package.json'));
  const range = pkg.engines && pkg.engines.electron;
  assert.ok(range, 'package.json に engines.electron が無い（更新 zip が必要とする Electron を誰も見ない）');
  const m = String(range).match(/^>=(\d+\.\d+\.\d+)$/);
  assert.ok(m, `engines.electron は ">=x.y.z" の形にする（updater.satisfiesRange が読める形）: ${range}`);
  const dev = String(pkg.devDependencies.electron).replace(/^\^/, '');
  assert.strictEqual(m[1], dev, 'engines.electron と devDependencies.electron の版が揃っていない');
  const { satisfiesRange } = require('../src/updater');
  assert.strictEqual(satisfiesRange(dev, range), true, '同梱している Electron 自身が engines を満たさない');
});
