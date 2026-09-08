/*
 * store.test.js — 保存層を実際に実行して検査する
 *
 * これまで store.js は repo.test.js からソース文字列として見られているだけで、
 * 一度も実行されていなかった。文字起こしの編集（updateSegment）を入れるにあたり、
 * 一時ディレクトリに本物のファイルを書いて読み戻す形で固定する。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');
const { STANDUP_SEGMENTS } = require('./fixtures');

let dir;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-store-'));
  store.init(dir);
});
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ } });

const clone = (x) => JSON.parse(JSON.stringify(x));
const mkPage = () => store.createPage({ title: 'テスト', segments: clone(STANDUP_SEGMENTS) });
const tfile = (id) => path.join(dir, 'data', 'transcripts', `${id}.json`);

test('updateSegment: 本文が変わり、getTranscript で読み戻せる', () => {
  const p = mkPage();
  const r = store.updateSegment(p.id, 's3', { text: '直した文' });
  assert.ok(Array.isArray(r));
  assert.strictEqual(store.getTranscript(p.id).find((s) => s.id === 's3').text, '直した文');
});

test('updateSegment: id・atMs・順序・他の区間は変わらない', () => {
  const p = mkPage();
  const before = store.getTranscript(p.id);
  store.updateSegment(p.id, 's3', { text: '直した文' });
  const after = store.getTranscript(p.id);
  assert.deepStrictEqual(after.map((s) => s.id), before.map((s) => s.id), '順序か id が変わった');
  assert.deepStrictEqual(after.map((s) => s.atMs), before.map((s) => s.atMs), 'atMs が変わった');
  for (const s of before) if (s.id !== 's3') assert.deepStrictEqual(after.find((x) => x.id === s.id), s, `${s.id} に触っている`);
});

test('updateSegment: 存在しない区間なら null を返し、ファイルに触らない', () => {
  const p = mkPage();
  const raw = fs.readFileSync(tfile(p.id), 'utf8');
  assert.strictEqual(store.updateSegment(p.id, 's999', { text: 'x' }), null);
  assert.strictEqual(fs.readFileSync(tfile(p.id), 'utf8'), raw);
});

test('updateSegment: 存在しないページなら null', () => {
  assert.strictEqual(store.updateSegment('p_nothing', 's1', { text: 'x' }), null);
});

test('updateSegment: text 以外の patch は無視する（id / atMs は書き換えられない）', () => {
  const p = mkPage();
  store.updateSegment(p.id, 's3', { text: '直した文', id: 'zz', atMs: 1, evil: 1 });
  const s = store.getTranscript(p.id).find((x) => x.id === 's3');
  assert.ok(s, 'id が書き換わった');
  assert.strictEqual(s.atMs, STANDUP_SEGMENTS[2].atMs);
  assert.strictEqual(s.evil, undefined);
  assert.strictEqual(s.text, '直した文');
});

test('updateSegment: text が文字列でなければ何も変えない', () => {
  const p = mkPage();
  store.updateSegment(p.id, 's3', { text: 123 });
  assert.strictEqual(store.getTranscript(p.id).find((x) => x.id === 's3').text, STANDUP_SEGMENTS[2].text);
});

test('updateSegment: 「認識に失敗」の区間を書き直すと failed が外れる', () => {
  const segs = clone(STANDUP_SEGMENTS);
  segs[4] = { id: 's5', atMs: segs[4].atMs, text: '（この区間の認識に失敗: timeout）', failed: true };
  const p = store.createPage({ title: 't', segments: segs });
  store.updateSegment(p.id, 's5', { text: '分かりました。実行計画を確認します。' });
  const s = store.getTranscript(p.id).find((x) => x.id === 's5');
  assert.strictEqual(s.failed, undefined, 'failed が残っている（要約から除外され続ける）');
});

test('updateSegment: 一時ファイルが残らず、書いた JSON は parse できる', () => {
  const p = mkPage();
  store.updateSegment(p.id, 's1', { text: '' });
  assert.ok(!fs.existsSync(tfile(p.id) + '.tmp'), '.tmp が残っている');
  const j = JSON.parse(fs.readFileSync(tfile(p.id), 'utf8'));
  assert.strictEqual(j.id, p.id);
  assert.strictEqual(j.segments.find((x) => x.id === 's1').text, '');
});

test('updateSegment: ページ本体（updatedAt）には触らない — ページ保存は main 側が1回だけ行う', () => {
  const p = mkPage();
  const before = store.getPage(p.id).updatedAt;
  store.updateSegment(p.id, 's2', { text: '直した文' });
  assert.strictEqual(store.getPage(p.id).updatedAt, before);
});

// ---------------------------------------------------------------- 索引の自己修復（#6 / #9）
// 索引が壊れても pages/ が残っていれば議事録は消えていない。起動時に索引を作り直す。
const extra = [];
function fresh() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-store-x-'));
  extra.push(d);
  store.init(d);
  return d;
}
test.after(() => { for (const d of extra) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* noop */ } } });
// 隔離 dir を使った試験のあとは、共有 dir に戻す（前半の試験が tfile(dir) を見るため）
test.afterEach(() => { if (dir) store.init(dir); });

const ifile = (d) => path.join(d, 'data', 'index.json');
const pfile = (d, id) => path.join(d, 'data', 'pages', `${id}.json`);
const brokenFiles = (d) => fs.readdirSync(path.join(d, 'data')).filter((f) => f.startsWith('index.json.broken-'));
const make3 = () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(store.createPage({ title: `p${i}`, segments: [], createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }).id);
  return ids;
};

test('init: 途中で切れた index.json は退避して、pages/ から索引を作り直す', () => {
  const d = fresh();
  const ids = make3();
  const raw = fs.readFileSync(ifile(d), 'utf8');
  fs.writeFileSync(ifile(d), raw.slice(0, Math.floor(raw.length / 2)), 'utf8');
  store.init(d);
  const list = store.listPages();
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(new Set(list.map((p) => p.id)), new Set(ids));
  // createdAt 降順
  assert.deepStrictEqual(list.map((p) => p.createdAt), [...list.map((p) => p.createdAt)].sort().reverse());
  assert.strictEqual(brokenFiles(d).length, 1, '.broken-* に退避されていない');
  assert.strictEqual(JSON.parse(fs.readFileSync(ifile(d), 'utf8')).pages.length, 3, '作り直した索引が書かれていない');
});

test('init: 空文字の index.json も壊れている扱い（退避 + 再構築）', () => {
  const d = fresh();
  make3();
  fs.writeFileSync(ifile(d), '', 'utf8');
  store.init(d);
  assert.strictEqual(store.listPages().length, 3);
  assert.strictEqual(brokenFiles(d).length, 1);
});

test('init: index.json が無いだけなら退避ファイルは作らない（pages/ があれば再構築する）', () => {
  const d = fresh();
  make3();
  fs.unlinkSync(ifile(d));
  store.init(d);
  assert.strictEqual(store.listPages().length, 3);
  assert.strictEqual(brokenFiles(d).length, 0);
});

test('init reconcile (a): 索引から消えた行は page.json から復帰する', () => {
  const d = fresh();
  const ids = make3();
  const idx = JSON.parse(fs.readFileSync(ifile(d), 'utf8'));
  idx.pages = idx.pages.filter((p) => p.id !== ids[1]);
  fs.writeFileSync(ifile(d), JSON.stringify(idx), 'utf8');
  store.init(d);
  assert.ok(store.listPages().some((p) => p.id === ids[1]), '索引に戻っていない');
  assert.strictEqual(store.listPages().length, 3);
  assert.ok(JSON.parse(fs.readFileSync(ifile(d), 'utf8')).pages.some((p) => p.id === ids[1]), 'ディスクの索引に書かれていない');
});

test('init reconcile (b): page.json が無い行は索引から消える', () => {
  const d = fresh();
  const ids = make3();
  fs.unlinkSync(pfile(d, ids[0]));
  store.init(d);
  assert.ok(!store.listPages().some((p) => p.id === ids[0]), '幽霊行が残っている');
  assert.strictEqual(store.listPages().length, 2);
  assert.ok(!JSON.parse(fs.readFileSync(ifile(d), 'utf8')).pages.some((p) => p.id === ids[0]));
});

test('init reconcile: 食い違いが無ければ index.json を書き直さない', () => {
  const d = fresh();
  make3();
  const before = fs.statSync(ifile(d)).mtimeMs;
  const raw = fs.readFileSync(ifile(d), 'utf8');
  store.init(d);
  assert.strictEqual(fs.readFileSync(ifile(d), 'utf8'), raw);
  assert.strictEqual(fs.statSync(ifile(d)).mtimeMs, before);
});

test('deletePage: 索引を先に書く（unlink で落ちても幽霊行が残らない）', () => {
  const d = fresh();
  const ids = make3();
  const orig = fs.unlinkSync;
  let indexAtUnlink = null;
  fs.unlinkSync = () => { indexAtUnlink = JSON.parse(fs.readFileSync(ifile(d), 'utf8')); throw new Error('EBUSY (擬似)'); };
  try {
    store.deletePage(ids[0]);
  } finally { fs.unlinkSync = orig; }
  assert.ok(indexAtUnlink, 'unlink が呼ばれていない');
  assert.ok(!indexAtUnlink.pages.some((p) => p.id === ids[0]), 'unlink の前に索引が書かれていない');
  assert.ok(!store.listPages().some((p) => p.id === ids[0]));
  assert.ok(fs.existsSync(pfile(d, ids[0])), '（擬似的に）消せなかったファイルは残る');
});

test('deletePage: 通常は索引・page・transcript が全部消え、再起動しても戻らない', () => {
  const d = fresh();
  const ids = make3();
  store.deletePage(ids[1]);
  assert.ok(!store.listPages().some((p) => p.id === ids[1]));
  assert.ok(!fs.existsSync(pfile(d, ids[1])));
  assert.ok(!fs.existsSync(path.join(d, 'data', 'transcripts', `${ids[1]}.json`)));
  store.init(d);
  assert.strictEqual(store.listPages().length, 2);
});

// ---------------------------------------------------------------- 出典の状態（#17 / #5）
// 人が足した行は出典の対象外（manual）、人が書き換えた行は出典が古い（stale）。
// citeSkip（短すぎて対象外）は cite.js が付ける。store は数えるだけ。
const blk = (id, type, text, cites, more) => ({ id, type, text, cites: cites || [], ...(more || {}) });

test('insertBlock: 新しいブロックは citeState=manual', () => {
  fresh();
  const p = store.createPage({ title: 't', segments: [], blocks: [blk('b1', 'bullet', '既存', ['s1'])] });
  const { page, blockId } = store.insertBlock(p.id, 'b1', 'bullet');
  const b = page.blocks.find((x) => x.id === blockId);
  assert.strictEqual(b.citeState, 'manual');
  assert.deepStrictEqual(b.cites, []);
  assert.strictEqual(store.getPage(p.id).blocks.find((x) => x.id === blockId).citeState, 'manual');
});

test('updateBlock: text が変わると stale（cites は残す）、同じ text なら変わらない', () => {
  fresh();
  const p = store.createPage({ title: 't', segments: [], blocks: [blk('b1', 'bullet', '既存の要点', ['s1', 's2'])] });
  let page = store.updateBlock(p.id, 'b1', { text: '既存の要点' });
  assert.strictEqual(page.blocks[0].citeState, undefined, '同じ text で stale になった');
  page = store.updateBlock(p.id, 'b1', { checked: true });
  assert.strictEqual(page.blocks[0].citeState, undefined, 'text 以外の patch で stale になった');
  page = store.updateBlock(p.id, 'b1', { text: '書き換えた要点' });
  assert.strictEqual(page.blocks[0].citeState, 'stale');
  assert.deepStrictEqual(page.blocks[0].cites, ['s1', 's2'], 'cites が消えた');
});

test('updateBlock: manual の行は text を変えても manual のまま', () => {
  fresh();
  const p = store.createPage({ title: 't', segments: [], blocks: [blk('b1', 'bullet', '既存', ['s1'])] });
  const { blockId } = store.insertBlock(p.id, 'b1', 'todo');
  const page = store.updateBlock(p.id, blockId, { text: '人が書いた' });
  assert.strictEqual(page.blocks.find((x) => x.id === blockId).citeState, 'manual');
});

test('savePage: citeStat を再計算する（manual/citeSkip は分母から外し、stale は分子から外す）', () => {
  fresh();
  const p = store.createPage({ title: 't', segments: [], blocks: [
    blk('h', 'heading', '議題', []),
    // 本文は照合対象になる長さ（正規化後6文字以上）にする。短い行は citeSkip と同じく対象外
    blk('b1', 'bullet', '出典がある要点を書いた行', ['s1']),                       // total, linked
    blk('b2', 'bullet', '出典が無い要点を書いた行', []),                            // total
    blk('b3', 'todo', '古い出典が残る要点の行', ['s2'], { citeState: 'stale' }),  // total（linked ではない）
    blk('b4', 'bullet', '人が足した要点を書いた行', [], { citeState: 'manual' }), // 対象外
    blk('b5', 'todo', '短い', ['s3'], { citeSkip: true }),                        // 対象外
    blk('b6', 'todo', '出典がある二つ目の要点の行', ['s4']),                         // total, linked
  ] });
  const page = store.getPage(p.id);
  page.citeStat = { linked: 99, total: 99, extra: 'keep' };
  const saved = store.savePage(page);
  assert.deepStrictEqual(saved.citeStat, { linked: 2, total: 4, extra: 'keep' });
  assert.deepStrictEqual(store.getPage(p.id).citeStat, { linked: 2, total: 4, extra: 'keep' });
});

test('savePage: citeStat が無いページでも作られ、updateBlock 後に数が追随する', () => {
  fresh();
  const p = store.createPage({ title: 't', segments: [], blocks: [blk('b1', 'bullet', '出典がある要点を書いた行', ['s1'])] });
  const saved = store.savePage(store.getPage(p.id));
  assert.deepStrictEqual(saved.citeStat, { linked: 1, total: 1 });
  const after = store.updateBlock(p.id, 'b1', { text: '書き換えた要点を書いた行' });
  assert.deepStrictEqual(after.citeStat, { linked: 0, total: 1 });
});

// ---------------------------------------------------------------- 旧版のページとの互換
test('getPage: v0.10.8 より前のページの短い要点に citeSkip を補い、分母に数えない', () => {
  const p = mkPage();
  // 旧版が書いた形（citeSkip も citeState も無い）を直接ディスクに作る
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'pages', `${p.id}.json`), 'utf8'));
  raw.blocks = [
    { id: 'b1', type: 'bullet', text: '承認済み', cites: [] },                                  // 正規化後4文字。旧版は照合せず分母にも入れなかった
    { id: 'b2', type: 'bullet', text: '受注管理システムの改修は結合テストが完了した', cites: ['s2'] },
  ];
  raw.citeStat = { linked: 1, total: 1 };
  fs.writeFileSync(path.join(dir, 'data', 'pages', `${p.id}.json`), JSON.stringify(raw), 'utf8');
  const got = store.getPage(p.id);
  assert.strictEqual(got.blocks[0].citeSkip, true, '短い行に citeSkip が補われない（画面に「根拠なし」が出る）');
  assert.strictEqual(got.blocks[1].citeSkip, undefined);
  const saved = store.savePage(got);
  assert.deepStrictEqual({ linked: saved.citeStat.linked, total: saved.citeStat.total }, { linked: 1, total: 1 }, '短い行が分母に入って 1/2 になった');
});

test('updateBlock: 本文を長くしたら照合対象に戻り、短くしたら対象外になる', () => {
  const p = mkPage();
  const r = store.insertBlock(p.id, null, 'bullet');
  // 手書きの行は manual のまま（対象外）。別に自動生成相当の行で見る
  const page = store.getPage(p.id);
  page.blocks.push({ id: 'auto1', type: 'bullet', text: '承認済み', cites: [] });
  store.savePage(page);
  assert.strictEqual(store.getPage(p.id).blocks.find((b) => b.id === 'auto1').citeSkip, true);
  store.updateBlock(p.id, 'auto1', { text: '承認済み。来週の定例で正式に共有する' });
  assert.strictEqual(store.getPage(p.id).blocks.find((b) => b.id === 'auto1').citeSkip, undefined, '長くしたのに対象外のまま');
  store.updateBlock(p.id, 'auto1', { text: '了承' });
  assert.strictEqual(store.getPage(p.id).blocks.find((b) => b.id === 'auto1').citeSkip, true, '短くしたのに対象のまま');
  assert.ok(r.blockId);
});

// ---------------------------------------------------------------- 検索の畳み込み（#53）
// 文字起こしは「では、予算案の、作成を」のように読点が挟まり、要約は「ＡＩ」と「AI」が
// 混ざる。原文どうしの includes では言ったはずの語が見つからないので、畳み込んだ
// 文字列で当てる。抜粋は元の本文から切る（畳んだ文字列を見せない）。
test('searchIndex: 読点をまたいで当たり、抜粋は元の本文のまま（句読点が残る）', () => {
  fresh();
  const p = store.createPage({ title: '定例', segments: [], blocks: [
    blk('b1', 'bullet', '前置きが二十文字以上ある長い行です。ここから本題で、では、予算案の、作成を進めます。以上', []),
  ] });
  const hits = store.searchIndex('予算案の作成');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].id, p.id);
  assert.ok(hits[0].snippet.includes('では、予算案の、作成を進めます。'), `抜粋が元の本文でない: ${hits[0].snippet}`);
  assert.ok(hits[0].snippet.startsWith('…'), `当たりの手前が省略されていない: ${hits[0].snippet}`);
  assert.ok(!hits[0].snippet.includes('前置き'), `抜粋の窓が当たりの位置に無い: ${hits[0].snippet}`);
});

test('searchIndex: タイトルは全角・半角・大文字小文字の違いを越えて当たる', () => {
  fresh();
  const p = store.createPage({ title: 'AI戦略ミーティング', segments: [] });
  for (const q of ['ai戦略', 'ＡＩ戦略', 'AI 戦略']) {
    const hits = store.searchIndex(q);
    assert.deepStrictEqual(hits.map((h) => h.id), [p.id], `「${q}」が当たらない`);
    assert.strictEqual(hits[0].snippet, undefined, 'タイトル一致に抜粋は付けない');
  }
  assert.deepStrictEqual(store.searchIndex('クラウド移行'), [], '無関係な語が当たった');
  assert.strictEqual(store.searchIndex('、。').length, 1, '記号だけの検索は空の検索と同じ（全件）');
});

test('searchFullText: 文字起こしも畳み込みで当て、抜粋は区間の原文そのもの', () => {
  fresh();
  const p = store.createPage({ title: 't', segments: [
    { id: 's1', atMs: 0, text: 'では、予算案の、作成を進めます。' },
    { id: 's2', atMs: 1000, text: 'ＡＩ推進室の件は次回に回します。' },
    { id: 's3', atMs: 2000, text: 'ﾃﾞｰﾀ移行の手順を確認します。' },
  ] });
  let hits = store.searchFullText('予算案の作成');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].id, p.id);
  assert.strictEqual(hits[0].segmentHits, 1);
  assert.strictEqual(hits[0].snippet, 'では、予算案の、作成を進めます。');
  hits = store.searchFullText('ai推進室');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].snippet, 'ＡＩ推進室の件は次回に回します。');
  // 半角カナの濁点は結合して比べる（「ﾃﾞｰﾀ」＝「データ」）
  assert.strictEqual(store.searchFullText('データ移行').length, 1);
  assert.strictEqual(store.searchFullText('ﾃﾞｰﾀ移行').length, 1);
  assert.deepStrictEqual(store.searchFullText('クラウド移行'), []);
  assert.deepStrictEqual(store.searchFullText('、'), []);
});

test('searchIndex: 半角カナ（結合記号あり）の本文でも抜粋の位置が元の本文に対応する', () => {
  fresh();
  store.createPage({ title: 't', segments: [], blocks: [
    blk('b1', 'bullet', 'これは二十文字を超える長い前置きの文章であって、ﾃﾞｰﾀ移行の手順を確認する。', []),
  ] });
  const hits = store.searchIndex('データ移行');
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].snippet.includes('ﾃﾞｰﾀ移行の手順'), `抜粋が当たりを含まない: ${hits[0].snippet}`);
  assert.ok(hits[0].snippet.startsWith('…'));
});

// ---------------------------------------------------------------- 既定の日付はローカルの暦日
// toISOString() は UTC。日本では朝 9 時前に始めた会議が前日の日付で保存される。
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('createPage: date を渡さなければローカルの暦日（UTC の日付ではない）', () => {
  fresh();
  // UTC と暦日が必ずずれる時間帯へ一時的に移す（UTC 11 時以降は +14、それより前は -11）
  const tz = process.env.TZ;
  process.env.TZ = new Date().getUTCHours() >= 11 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
  try {
    const before = new Date();
    const p = store.createPage({ title: 't', segments: [] });
    const after = new Date();
    assert.ok([ymd(before), ymd(after)].includes(p.date), `${p.date} がローカルの暦日でない`);
    assert.notStrictEqual(p.date, before.toISOString().slice(0, 10), 'UTC の日付が入っている');
    assert.strictEqual(store.getPage(p.id).date, p.date);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

test('createPage: date を渡せばそのまま使う', () => {
  fresh();
  const p = store.createPage({ title: 't', segments: [], date: '2020-02-29' });
  assert.strictEqual(p.date, '2020-02-29');
});
