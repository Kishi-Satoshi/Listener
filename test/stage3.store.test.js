/*
 * stage3.store.test.js — 第3段（v0.11.0）の保存層の直しを実データで固定する
 *
 *   #44 索引: 要約の本文（searchText）とメモ（memoText）を分けて持ち、長い会議の
 *        要約後半とメモが検索から落ちない。古い索引は起動時に作り直す。
 *   #43 全文検索: 全ページを走査し、打ち切ったことを戻り値で伝える。
 *   #45 アクション: 1回の走査で行・担当者・件数を返し、未完了の無いページは読まない。
 *   #29 データ保存先: init の第2引数で保存先を差し替え、root() で今の場所を返す。
 *
 * store.test.js と同じく、隔離した一時フォルダに本物のファイルを書いて読み戻す。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');

const dirs = [];
function fresh() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-stage3-'));
  dirs.push(d);
  store.init(d);
  return d;
}
test.after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* noop */ } } });

const blk = (id, type, text, more) => ({ id, type, text, cites: [], ...(more || {}) });
const ifile = (d) => path.join(d, 'data', 'index.json');
const readIndex = (d) => JSON.parse(fs.readFileSync(ifile(d), 'utf8'));
const row = (id) => store.listPages().find((p) => p.id === id);

// ---------------------------------------------------------------- #44 索引（要約の後半とメモ）
// 要約ブロックの連結 + メモを 4000 字で切っていたので、長い会議では要約の後半と
// メモが索引から落ちていた。メモは他に検索経路が無い（全文検索は文字起こしだけ）。
const LONG_BLOCKS = (n) => {
  const out = [blk('h', 'heading', '議題')];
  for (let i = 0; i < n; i++) out.push(blk(`b${i}`, 'bullet', `第${i}項の要点として述べられた内容の要旨をここに百文字前後の長さで書き留めておく。`.padEnd(100, '本文')));
  return out;
};

test('#44 searchIndex: 4000 字を超える要約の末尾ブロックとメモに当たる', () => {
  fresh();
  const blocks = LONG_BLOCKS(50);   // 約 5000 字
  blocks.push(blk('last', 'bullet', '来期の予算配分を再検討する'));
  const p = store.createPage({ title: '長い定例', segments: [], blocks, memo: '展示会の出展判断は保留にする' });
  let hits = store.searchIndex('予算配分を再検討');
  assert.deepStrictEqual(hits.map((h) => h.id), [p.id], '要約の末尾ブロックが検索に出ない');
  assert.ok(hits[0].snippet.includes('予算配分を再検討'), `抜粋が当たりを含まない: ${hits[0].snippet}`);
  hits = store.searchIndex('出展判断');
  assert.deepStrictEqual(hits.map((h) => h.id), [p.id], 'メモが検索に出ない');
  assert.ok(hits[0].snippet.includes('出展判断'), `抜粋がメモの原文でない: ${hits[0].snippet}`);
});

test('#44 summarize: searchText は要約ブロックの本文だけ（上限 20000）、memoText はメモ（上限 2000）', () => {
  fresh();
  const blocks = LONG_BLOCKS(250);   // 約 25000 字
  const memo = 'メモ'.repeat(1500);     // 3000 字
  const p = store.createPage({ title: 't', segments: [], blocks, memo });
  const r = row(p.id);
  assert.strictEqual(r.searchText.length, 20000);
  assert.strictEqual(r.searchText, blocks.map((b) => b.text).join(' ').slice(0, 20000), 'ブロックの本文を空白で連結した形でない');
  assert.strictEqual(r.memoText.length, 2000);
  assert.strictEqual(r.memoText, memo.slice(0, 2000));
  assert.ok(!r.searchText.includes('メモメモ'), 'searchText にメモが混ざっている');
  // 空の要約・メモでも文字列（古い世代との区別に使う）
  const e = store.createPage({ title: 'e', segments: [] });
  assert.strictEqual(row(e.id).searchText, '');
  assert.strictEqual(row(e.id).memoText, '');
});

test('#44 searchIndex: 抜粋は当たった方（メモ）の原文から作る（句読点が残る）', () => {
  fresh();
  const memo = '前置きが二十文字以上ある、長いメモです。ここから本題で、では、予算案の、作成を進めます。そのあとも本文が続き、四十文字を超える長さの締めの文章がここに置かれている。';
  const p = store.createPage({ title: 't', segments: [], blocks: [blk('b1', 'bullet', '要約側には当たりが無い行')], memo });
  const hits = store.searchIndex('予算案の作成');
  assert.deepStrictEqual(hits.map((h) => h.id), [p.id]);
  const at = memo.indexOf('予算案の、作成');
  assert.strictEqual(hits[0].snippet, `…${memo.slice(at - 20, at + '予算案の、作成'.length + 40)}`);
  // 要約とメモの両方に当たるときは要約側の抜粋
  const p2 = store.createPage({ title: 't2', segments: [], blocks: [blk('b1', 'bullet', '要約側の、予算案の作成')], memo: 'メモ側の予算案の作成' });
  const h2 = store.searchIndex('予算案の作成').find((h) => h.id === p2.id);
  assert.ok(h2.snippet.includes('要約側の'), `要約側の抜粋でない: ${h2.snippet}`);
});

test('#44 init: 古い世代の索引（memoText が無い行）は page.json から作り直す', () => {
  const d = fresh();
  const p = store.createPage({ title: 't', segments: [], blocks: [blk('b1', 'bullet', '要点')], memo: '出展判断は保留' });
  // 旧世代の形: searchText に本文+メモを連結し、memoText は無い
  const idx = readIndex(d);
  for (const r of idx.pages) { r.searchText = `${r.searchText} ${r.memoText}`.slice(0, 4000); delete r.memoText; }
  fs.writeFileSync(ifile(d), JSON.stringify(idx), 'utf8');
  store.init(d);
  assert.strictEqual(row(p.id).memoText, '出展判断は保留', '起動時に作り直されていない');
  assert.strictEqual(row(p.id).searchText, '要点');
  assert.strictEqual(readIndex(d).pages.find((r) => r.id === p.id).memoText, '出展判断は保留', 'ディスクの索引に書かれていない');
  assert.deepStrictEqual(store.searchIndex('出展判断').map((h) => h.id), [p.id]);
  // 作り直した後は食い違いが無いので、次の起動で書き直さない
  const raw = fs.readFileSync(ifile(d), 'utf8');
  store.init(d);
  assert.strictEqual(fs.readFileSync(ifile(d), 'utf8'), raw);
});

// ---------------------------------------------------------------- #43 全文検索の打ち切り
// ヒットが limit 件たまった時点で走査を止め、打ち切ったことが戻り値にも画面にも
// 出なかった（「全件見た」と誤解させる）。全ページを走査して total と truncated を返す。
const seg = (id, text) => ({ id, atMs: 0, text });
// createdAt を i の降順にして、索引の並び（新しい順）を決め打ちにする
const mkFull = (n, text) => {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(store.createPage({ title: `p${i}`, createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`, segments: [seg('s1', text), seg('s2', text)] }).id);
  }
  return ids.reverse();   // 索引の並び（新しい順）
};

test('#43 searchFullText: limit を超える件数では hits を limit 件に切り、total と truncated で伝える', () => {
  fresh();
  const ids = mkFull(5, 'では、予算案の、作成を進めます。');
  store.createPage({ title: 'x', segments: [seg('s1', '無関係な発言')] });
  const r = store.searchFullText('予算案の作成', 3);
  assert.strictEqual(r.total, 5, '当たったページ数が total でない');
  assert.strictEqual(r.hits.length, 3, 'hits が limit 件でない');
  assert.strictEqual(r.truncated, true);
  assert.deepStrictEqual(r.hits.map((h) => h.id), ids.slice(0, 3), '先頭（新しい順）の limit 件でない');
  // hit の形は今までと同じ（索引の行 + segmentHits + snippet）
  assert.strictEqual(r.hits[0].segmentHits, 2);
  assert.strictEqual(r.hits[0].snippet, 'では、予算案の、作成を進めます。');
  assert.strictEqual(r.hits[0].title, 'p4');
});

test('#43 searchFullText: limit 未満なら truncated=false、query が空なら空の結果', () => {
  fresh();
  mkFull(5, '予算案の作成');
  let r = store.searchFullText('予算案の作成', 10);
  assert.deepStrictEqual({ n: r.hits.length, total: r.total, truncated: r.truncated }, { n: 5, total: 5, truncated: false });
  r = store.searchFullText('予算案の作成', 5);
  assert.deepStrictEqual({ n: r.hits.length, total: r.total, truncated: r.truncated }, { n: 5, total: 5, truncated: false }, 'ちょうど limit 件は打ち切りでない');
  assert.deepStrictEqual(store.searchFullText('クラウド移行', 10), { hits: [], total: 0, truncated: false });
  assert.deepStrictEqual(store.searchFullText('', 10), { hits: [], total: 0, truncated: false });
  assert.deepStrictEqual(store.searchFullText('、。', 10), { hits: [], total: 0, truncated: false }, '記号だけの検索は空の検索と同じ');
});

test('#43 searchFullText: limit の既定は 60（61 件目から打ち切り）', () => {
  fresh();
  mkFull(62, '予算案の作成');
  const r = store.searchFullText('予算案の作成');
  assert.strictEqual(r.hits.length, 60);
  assert.strictEqual(r.total, 62);
  assert.strictEqual(r.truncated, true);
});

// ---------------------------------------------------------------- #45 アクションの1走査
// アクションタブは1打鍵ごとに openActions()（全ページを読む）+ assigneeList() の
// IPC 2本を呼んでいた。actionView は1回の走査で行・担当者・件数を返し、索引の
// openActionCount が 0 のページは読まない。
const todo = (id, text, more) => blk(id, 'todo', text, { checked: false, ...(more || {}) });
// 4 ページ。A・B に未完了、C は完了のみ（actionCount 2 / openActionCount 0）、D は todo 無し
function mkActions() {
  const A = store.createPage({ title: '週次定例', date: '2026-09-08', createdAt: '2026-09-08T00:00:00.000Z', segments: [], blocks: [
    blk('h', 'heading', 'アクション'),
    todo('a1', 'ＡＩ資料を送る', { assignee: '山田', due: '2026-09-10', dueRaw: '9/10' }),
    todo('a2', '見積を作る', { assignee: '佐藤' }),
    todo('a3', '完了済みの作業', { checked: true, assignee: '佐藤' }),
    todo('a4', '', { assignee: '佐藤' }),   // 本文の無い todo は行にしない（openActions と同じ）
  ] });
  const B = store.createPage({ title: 'キックオフ', date: '2026-09-01', createdAt: '2026-09-01T00:00:00.000Z', segments: [], blocks: [
    todo('b1', '会場を、予約する', { assignee: '山田', due: '2026-09-01', dueRaw: '来週', dueApprox: true }),
    todo('b2', '済んだ作業', { checked: true }),
  ] });
  const C = store.createPage({ title: '振り返り', date: '2026-08-20', createdAt: '2026-08-20T00:00:00.000Z', segments: [], blocks: [
    todo('c1', '済んだ作業1', { checked: true, assignee: '田中' }),
    todo('c2', '済んだ作業2', { checked: true }),
  ] });
  const D = store.createPage({ title: '雑談', date: '2026-08-10', createdAt: '2026-08-10T00:00:00.000Z', segments: [], blocks: [blk('d1', 'bullet', '要点')] });
  return { A, B, C, D };
}
// pages/ の下の読み取りをページ id で記録しながら fn を実行する
function readingPages(fn) {
  const orig = fs.readFileSync;
  const read = [];
  fs.readFileSync = function (file, ...rest) {
    const f = String(file);
    if (f.includes(`${path.sep}pages${path.sep}`)) read.push(path.basename(f, '.json'));
    return orig.call(fs, file, ...rest);
  };
  try { return { result: fn(), read }; } finally { fs.readFileSync = orig; }
}

test('#45 actionView: 索引の openActionCount が 0 のページは読まない', () => {
  fresh();
  const { A, B, C, D } = mkActions();
  assert.strictEqual(row(C.id).actionCount, 2, '前提: C は todo を持つ');
  assert.strictEqual(row(C.id).openActionCount, 0, '前提: C の todo は全部完了');
  const { result, read } = readingPages(() => store.actionView({}));
  assert.deepStrictEqual(new Set(read), new Set([A.id, B.id]), `読んだページ: ${read.join(',')}`);
  assert.ok(!read.includes(C.id), '完了だけのページを読んでいる');
  assert.ok(!read.includes(D.id), 'todo の無いページを読んでいる');
  assert.strictEqual(result.total, 3);
});

test('#45 actionView: 行の形と並びは openActions と同じ（期限が近い順、期限なしは末尾）', () => {
  fresh();
  const { A, B } = mkActions();
  const { actions, people, total } = store.actionView({});
  assert.deepStrictEqual(actions, [
    { pageId: B.id, blockId: 'b1', pageTitle: 'キックオフ', date: '2026-09-01', text: '会場を、予約する', assignee: '山田', due: '2026-09-01', dueRaw: '来週', dueApprox: true },
    { pageId: A.id, blockId: 'a1', pageTitle: '週次定例', date: '2026-09-08', text: 'ＡＩ資料を送る', assignee: '山田', due: '2026-09-10', dueRaw: '9/10', dueApprox: false },
    { pageId: A.id, blockId: 'a2', pageTitle: '週次定例', date: '2026-09-08', text: '見積を作る', assignee: '佐藤', due: '', dueRaw: '', dueApprox: false },
  ]);
  assert.deepStrictEqual(people, [{ name: '山田', count: 2 }, { name: '佐藤', count: 1 }], '未完了件数の降順でない');
  assert.strictEqual(total, 3);
  // 既存の openActions / assigneeList は残り、同じ中身を返す
  assert.deepStrictEqual(store.openActions(), actions);
  assert.deepStrictEqual(store.assigneeList(), people);
  // 引数なしでも同じ
  assert.deepStrictEqual(store.actionView(), { actions, people, total });
});

test('#45 actionView: q は畳み込みで本文・議事録名・担当に当て、people と total は絞る前の値', () => {
  fresh();
  const { A, B } = mkActions();
  const ids = (r) => r.actions.map((x) => `${x.pageId}/${x.blockId}`);
  let r = store.actionView({ q: 'ai資料' });   // 全角・大文字の違いを越える
  assert.deepStrictEqual(ids(r), [`${A.id}/a1`]);
  assert.deepStrictEqual(r.people, [{ name: '山田', count: 2 }, { name: '佐藤', count: 1 }], '絞ったら people が変わった');
  assert.strictEqual(r.total, 3, '絞ったら total が変わった');
  r = store.actionView({ q: '会場を予約' });    // 読点をまたぐ
  assert.deepStrictEqual(ids(r), [`${B.id}/b1`]);
  r = store.actionView({ q: 'キックオフ' });   // 議事録名
  assert.deepStrictEqual(ids(r), [`${B.id}/b1`]);
  r = store.actionView({ q: '山田' });         // 担当
  assert.deepStrictEqual(ids(r), [`${B.id}/b1`, `${A.id}/a1`]);
  r = store.actionView({ q: '存在しない語' });
  assert.deepStrictEqual(ids(r), []);
  assert.strictEqual(r.total, 3);
  r = store.actionView({ q: '、。' });          // 記号だけは絞らない
  assert.strictEqual(r.actions.length, 3);
});

test('#45 actionView: assignee は完全一致で絞り、q と重ねられる', () => {
  fresh();
  const { A, B } = mkActions();
  const ids = (r) => r.actions.map((x) => `${x.pageId}/${x.blockId}`);
  let r = store.actionView({ assignee: '佐藤' });
  assert.deepStrictEqual(ids(r), [`${A.id}/a2`]);
  assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(r.people, [{ name: '山田', count: 2 }, { name: '佐藤', count: 1 }]);
  r = store.actionView({ assignee: '山' });   // 部分一致では絞らない
  assert.deepStrictEqual(ids(r), []);
  r = store.actionView({ assignee: '山田', q: '会場' });
  assert.deepStrictEqual(ids(r), [`${B.id}/b1`]);
  r = store.actionView({ assignee: '佐藤', q: '会場' });
  assert.deepStrictEqual(ids(r), []);
  r = store.actionView({ assignee: '' });   // 空は「全員」
  assert.strictEqual(r.actions.length, 3);
});

test('#45 actionView: 未完了が無ければ空（ページは1つも読まない）', () => {
  fresh();
  store.createPage({ title: 't', segments: [], blocks: [todo('c1', '済んだ作業', { checked: true })] });
  const { result, read } = readingPages(() => store.actionView({ q: 'x' }));
  assert.deepStrictEqual(result, { actions: [], people: [], total: 0 });
  assert.deepStrictEqual(read, []);
});
