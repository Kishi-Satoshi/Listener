'use strict';
// ============================================================================
//  Listener 不変条件表
//  「この製品では常にこうでなければならない」を1か所に集めたもの。
//  事故が起きるたびに個別テストを足すのではなく、この表を育てる。
//
//  各項目: { id, 表明, 由来, check(w) -> 違反の説明の配列（空なら合格） }
//  w = test/helpers/world.js が作る世界（HTMLの木 / CSSの規則 / 窓の設定 /
//      画面を実際に起動した結果）。check の中で生ソースを正規表現で見ないこと。
// ============================================================================

const H = require('./helpers/html.js');
const C = require('./helpers/css.js');

// ----------------------------------------------------------------------------
//  表1: 透過ウィンドウの地雷台帳
//  実機で1件踏んだら1行足す。行を足すだけで全ての透過窓・その HTML に効く。
// ----------------------------------------------------------------------------
const TRANSPARENT_WINDOW_MINES = [
  { key: 'backgroundThrottling', ng: (v) => v !== undefined,
    why: 'Windows の透過ウィンドウで透明が壊れ、ピルの外に不透明の矩形が出る（v0.9.7で発生 / v0.9.11で修正）' },
  { key: 'hasShadow', ng: (v) => v !== 'false',
    why: 'ネイティブの影が窓の矩形に落ち、ピルの外に灰色の四角が見える' },
  { key: 'backgroundColor', ng: (v) => v !== undefined && v !== "'#00000000'",
    why: '不透明な地色を敷くと透過が無効になる' },
  { key: 'thickFrame', ng: (v) => v === 'true', why: 'Windows で縁が描かれ矩形が見える' },
  { key: 'roundedCorners', ng: (v) => v === 'true', why: 'OS 側の角丸合成が透過と噛み合わない' },
  { key: 'vibrancy', ng: (v) => v !== undefined, why: 'macOS 専用の合成で Windows では矩形が出る' },
  { key: 'backgroundMaterial', ng: (v) => v !== undefined, why: 'Mica/Acrylic は窓の矩形いっぱいに掛かる' },
  { key: 'opacity', ng: (v) => v !== undefined, why: '窓全体の不透明度は矩形として合成される' },
];
// 透過ウィンドウが読み込む HTML の CSS で禁止する宣言
const TRANSPARENT_CSS_MINES = [
  { prop: 'box-shadow', ng: (v) => !/^\s*inset\b/.test(v) && !/^\s*none\s*$/.test(v),
    why: '外向きの影は透過ウィンドウでは窓の矩形いっぱいに落ちる（v0.10.0で発生 / v0.10.1で修正）。inset なら可' },
  { prop: 'backdrop-filter', ng: () => true, why: '背後の合成結果が矩形で出る（v0.10.0で発生 / v0.10.1で修正）' },
  { prop: '-webkit-backdrop-filter', ng: () => true, why: '同上' },
  { prop: 'filter', ng: (v) => /drop-shadow/.test(v), why: 'drop-shadow は矩形に落ちうる' },
  { prop: 'mix-blend-mode', ng: (v) => v.trim() !== 'normal', why: '透過の合成順に依存し実機で崩れる' },
];

// ----------------------------------------------------------------------------
//  表2: 木の包含（「この要素は必ずこの枠の中にいる」）
//  文字位置で切り貼りしたときに枠の外へ出る事故を、事象を知らなくても捕まえる。
// ----------------------------------------------------------------------------
const CONTAINMENT = [
  { screen: 'app', 子: (n) => H.has(n, 'card'), 親: (n) => H.has(n, 'scroll'),
    表明: 'すべての .card は .scroll（スクロール枠）の子孫であること',
    由来: 'v0.10.0 で設定カード5枚中4枚が枠の外に出て消えた（v0.10.2で修正）' },
  { screen: 'app', 子: (n) => H.has(n, 'card') || H.has(n, 'scroll'), 親: (n) => n.tag === 'section' && H.has(n, 'tab'),
    表明: 'すべての .card / .scroll はいずれかのタブ <section class="tab"> の中にいること',
    由来: '同上。タブの外へ出た要素はどのタブでも表示されない' },
  { screen: 'app', 子: (n) => H.has(n, 'save-msg') || (n.attrs.id === 'openDataBtn'),
    親: (n) => n.tag === 'section' && n.attrs.id === 'tabSettings',
    表明: '設定の footer（保存メッセージ・データ保存先を開く）は設定タブの中に残っていること',
    由来: 'v0.10.2 でこの2つが切り落とされ、初期化が例外で止まった（v0.10.3で修正）' },
  { screen: 'overlay', 子: (n) => ['canvas', 'button'].includes(n.tag) || H.has(n, 'status') || H.has(n, 'timer') || H.has(n, 'dot'),
    親: (n) => H.has(n, 'pill'),
    表明: 'ピルの中身（波形・状態・時刻・ボタン・点）はすべて .pill の中にいること',
    由来: '.pill の外に出た要素は透過ウィンドウの地の上に裸で描かれる' },
];

// ----------------------------------------------------------------------------
//  表3: 復旧・退避の経路（壊れうる層に依存してはいけない操作）
//  レンダラー（画面）が全滅しても、main.js だけで到達できる入口が要る。
// ----------------------------------------------------------------------------
const RECOVERY_PATHS = [
  { 名前: '更新を確認', 語: ['更新'], 由来: 'v0.10.3 の初期化例外で更新ボタンが死に、アプリ内更新で直せなくなった（v0.10.4で修正）' },
  { 名前: 'ノートを開く', 語: ['ノート'], 由来: '画面が出ないときに再表示する手段' },
  { 名前: '終了', 語: ['終了'], 由来: '画面が固まったときに抜ける手段' },
];

// ----------------------------------------------------------------------------
//  表4: 起動したとき必ず呼ばれる API（初期化がそこまで到達した証拠）
// ----------------------------------------------------------------------------
const BOOT_REACHED = [
  { screen: 'app', apis: ['getSettings', 'getHistory', 'pagesSearch', 'appVersion'],
    由来: 'v0.10.2 では例外で初期化が止まり、getSettings に到達しなかった（設定が消えたように見えた）' },
  { screen: 'overlay', apis: ['onStart', 'onStop', 'onCancel', 'onTick', 'onPhase'],
    由来: '要素が1つ欠けるだけで IIFE が丸ごと死に、録音が一度も始まらなくなる' },
];

// ----------------------------------------------------------------------------
//  表5: 起動後に必ずハンドラが結線されている操作
//  「文字列がソースにあるか」ではなく「実行した結果ハンドラが付いたか」で見る。
//  if (false) で包む・到達しない分岐へ移す・コメントに残す、では通らない。
// ----------------------------------------------------------------------------
const WIRED = [
  { screen: 'app', id: 'openDataBtn', types: ['click'], 由来: 'v0.10.3 で消えた復旧導線。設定フッタの中にしか無い' },
  { screen: 'app', id: 'tabSettings', types: ['change'], 由来: '設定の自動保存。切れると入力が黙って捨てられる' },
  { screen: 'app', id: 'tabBtnNotes', types: ['click'], 由来: 'タブ切り替え' },
  { screen: 'app', id: 'tabBtnDictation', types: ['click'], 由来: 'タブ切り替え' },
  { screen: 'app', id: 'tabBtnSettings', types: ['click'], 由来: 'タブ切り替え。設定画面へ入る唯一の導線' },
  { screen: 'app', id: 'searchBox', types: ['input'], 由来: '議事録の検索' },
  { screen: 'overlay', id: 'stopBtn', types: ['click'], 由来: '録音の停止。押せないと議事録が作れない' },
  { screen: 'overlay', id: 'pauseBtn', types: ['click'], 由来: '一時停止' },
  { screen: 'overlay', id: 'ngBtn', types: ['click'], 由来: 'キャンセル' },
];

// 動的に作られるため HTML に静的な定義が無い id（理由を必ず書くこと）
const DYNAMIC_IDS = [];

// ============================================================================
//  不変条件の一覧
// ============================================================================
const INVARIANTS = [

  // ---- 木の形 ------------------------------------------------------------
  { id: 'TREE-01', 分類: 'HTMLの木',
    表明: 'すべての HTML が整形式である（閉じ忘れ・相手違いの閉じタグが無い）',
    由来: 'v0.10.0 の切り貼りで </div> が別のブロックへ移動した。開閉の「総数」は合っていたので数え上げでは気づけない',
    check(w) {
      const v = [];
      for (const s of Object.values(w.screens)) for (const e of s.tree.errors) v.push(`${s.rel}: ${e}`);
      return v;
    } },

  { id: 'TREE-02', 分類: 'HTMLの木',
    表明: '表2（包含）のすべての行が成り立つ',
    由来: 'v0.10.2「設定カードが5枚中4枚消えた」の直接の不変条件',
    check(w) {
      const v = [];
      for (const r of CONTAINMENT) {
        const s = w.screens[r.screen];
        const 対象 = s.tree.nodes.filter(r.子);
        if (!対象.length) { v.push(`${s.rel}: 「${r.表明}」の対象要素が1つも無い（検査が空振りしている）`); continue; }
        for (const n of 対象) if (!H.within(n, r.親)) v.push(`${s.rel}:${n.line}行 ${H.path(n)} が枠の外にいる — ${r.表明}（${r.由来}）`);
      }
      return v;
    } },

  { id: 'TREE-03', 分類: 'HTMLの木',
    表明: '行頭から始まる兄弟要素の字下げは揃っている',
    由来: '文字位置で切り出して移動すると、閉じタグが道連れになり字下げが1段ずれる。事象を知らなくても切り貼り事故の型そのものを捕まえる',
    check(w) {
      const v = [];
      for (const s of Object.values(w.screens)) {
        const walk = (n) => {
          const cs = n.children.filter((c) => c.col >= 0);
          if (cs.length > 1) {
            const cnt = new Map();
            for (const c of cs) cnt.set(c.col, (cnt.get(c.col) || 0) + 1);
            const 多数 = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
            for (const c of cs) if (c.col !== 多数) v.push(`${s.rel}:${c.line}行 <${c.tag}${c.attrs.class ? ' class="' + c.attrs.class + '"' : ''}> の字下げが ${c.col}、兄弟は ${多数}`);
          }
          for (const c of n.children) walk(c);
        };
        // <body> 直下は <script> と外枠が混じるので対象外
        for (const n of s.tree.nodes) if (n.tag === 'body') for (const c of n.children) walk(c);
      }
      return v;
    } },

  { id: 'TREE-04', 分類: 'HTMLの木',
    表明: 'id は画面の中で一意である',
    由来: '重複した id は getElementById が先勝ちになり、後ろの要素が黙って結線されなくなる',
    check(w) {
      const v = [];
      for (const s of Object.values(w.screens)) {
        const seen = new Map();
        for (const n of s.tree.nodes) if (n.attrs.id) {
          if (seen.has(n.attrs.id)) v.push(`${s.rel}:${n.line}行 id="${n.attrs.id}" が重複（${seen.get(n.attrs.id)}行にもある）`);
          else seen.set(n.attrs.id, n.line);
        }
      }
      return v;
    } },

  // ---- 実行 --------------------------------------------------------------
  { id: 'RUN-01', 分類: '画面を実際に走らせる',
    表明: '画面のスクリプトが最後まで例外なく走る',
    由来: 'v0.10.3 / v0.10.4 の正体。$(存在しないid).onclick = ... が TypeError になり、それ以降の結線が全て死んだ。構文検査（new Function）は解析しかしないので原理的に捕まらない',
    check(w) {
      const v = [];
      for (const [k, r] of Object.entries(w.run)) {
        for (const e of r.errors) v.push(`${k}: ${e}`);
        if (!r.scripts) v.push(`${k}: <script> が1つも見つからない（検査が空振りしている）`);
      }
      return v;
    } },

  { id: 'RUN-02', 分類: '画面を実際に走らせる',
    表明: '初期化中に getElementById が null を返さない（表になければ違反）',
    由来: '代入の瞬間に落ちない要素（後で textContent を書くだけの要素など）も、初期化の時点で摘示する。$(変数) や document.getElementById 直呼びも同じ計器に掛かるので、書き方の違いで抜けない',
    check(w) {
      const v = [];
      for (const [k, r] of Object.entries(w.run)) {
        if (!r.asked.length) v.push(`${k}: getElementById が一度も呼ばれていない（検査が空振りしている）`);
        for (const id of r.missing) if (!DYNAMIC_IDS.includes(id)) v.push(`${k}: 画面が参照する id="${id}" が HTML に無い`);
      }
      return v;
    } },

  { id: 'RUN-03', 分類: '画面を実際に走らせる',
    表明: '表4のとおり、起動が最後まで到達した証拠となる API が呼ばれている',
    由来: '例外を握り潰す作りに変えても「実は何もしていない」を見抜けるようにするため。文字列の有無ではなく実行後の観測値で見る',
    check(w) {
      const v = [];
      for (const r of BOOT_REACHED) {
        const c = new Set(w.run[r.screen].calls);
        for (const a of r.apis) if (!c.has(a)) v.push(`${r.screen}: 起動しても ${a}() が呼ばれない（初期化が途中で止まっている疑い）— ${r.由来}`);
      }
      return v;
    } },

  { id: 'RUN-04', 分類: '画面を実際に走らせる',
    表明: '結線済みのハンドラを全部叩いても例外が出ない',
    由来: "$('tab'+t) のように計算で組み立てる id の破壊は、起動時には落ちず押した瞬間に落ちる。正規表現では原理的に見えない",
    check(w) {
      const v = [];
      for (const [k, r] of Object.entries(w.run)) {
        if (!r.wired.length) { v.push(`${k}: ハンドラが1つも結線されていない（検査が空振りしている）`); continue; }
        for (const e of r.fireAll()) v.push(`${k}: ${e}`);
        for (const id of r.missing) if (!DYNAMIC_IDS.includes(id)) v.push(`${k}: 操作したときに参照される id="${id}" が HTML に無い`);
      }
      return v;
    } },

  { id: 'RUN-05', 分類: '画面を実際に走らせる',
    表明: 'main から送られてくるイベントを受けても例外が出ない',
    由来: '録音の開始・停止・phase 変更は、起動直後ではなく後から来る。ここで落ちると録音が始まらない',
    check(w) {
      const v = [];
      const o = w.run.overlay;
      for (const e of o.fire('onStart', { mode: 'dictation', systemAudio: false })) v.push(`overlay: ${e}`);
      for (const p of ['recording', 'processing', 'done', 'error']) for (const e of o.fire('onPhase', { phase: p, text: 'x' })) v.push(`overlay: phase=${p} ${e}`);
      for (const e of o.fire('onTick')) v.push(`overlay: ${e}`);
      for (const e of o.fire('onStop', {})) v.push(`overlay: ${e}`);
      const a = w.run.app;
      for (const n of ['onNotice', 'onHistoryUpdated', 'onPagesUpdated', 'onMeetingUpdate', 'onUpdateAvailable']) {
        const arg = n === 'onNotice' ? 'お知らせ' : n === 'onHistoryUpdated' ? require('./helpers/replies.js').HISTORY
          : n === 'onPagesUpdated' ? [] : n === 'onUpdateAvailable' ? { version: '9.9.9', url: 'https://example.invalid/x.exe' } : { active: true, startedAt: Date.now() };
        for (const e of a.fire(n, arg)) v.push(`app: ${e}`);
      }
      return v;
    } },

  { id: 'RUN-06', 分類: '画面を実際に走らせる',
    表明: '表5の操作は、起動後に実際にハンドラが結線されている',
    由来: "テストが探す文字列は残っているのに実装が実行されない型（if (false) で包む、到達しない分岐へ移す、コメントに残す）を、実行後の観測値で止める",
    check(w) {
      const v = [];
      for (const r of WIRED) {
        const wired = w.run[r.screen].wired;
        if (!wired.length) { v.push(`${r.screen}: ハンドラが1つも結線されていない（検査が空振りしている）`); continue; }
        for (const t of r.types) if (!wired.some((x) => x.id === r.id && x.type === t)) v.push(`${r.screen}: 起動しても #${r.id} に ${t} ハンドラが付かない — ${r.由来}`);
      }
      return v;
    } },

  // ---- 色 ----------------------------------------------------------------
  { id: 'COLOR-01', 分類: '色',
    表明: '暗い地の上のインクは、すべて地より明るい（明暗の「向き」で見る）',
    由来: 'v0.10.0 でピルの地だけ暗くし、波形の fillStyle とスピナーの輪が明地向けの暗色のまま残って見えなくなった（v0.10.1で修正）。しきい値ではなく向きで見るのが肝',
    check(w) {
      const s = w.screens.overlay;
      const pill = s.css.find((r) => r.selectors.includes('.pill') && !r.at);
      if (!pill) return ['overlay.html: .pill の規則が見つからない（検査が空振りしている）'];
      const bgRaw = pill.decls.background || pill.decls['background-color'];
      const 地 = C.colorsIn(bgRaw);   // グラデーションなら全ての停止色
      if (!地.length) return [`overlay.html: .pill の地色 "${bgRaw}" が読めない（読めない色を足したなら COLOR-01 の側を直すこと）`];
      const Ls = 地.map((c) => C.lum(c));
      const Lmin = Math.min(...Ls), Lmax = Math.max(...Ls);
      const 暗い地 = Lmax < 0.18, 明るい地 = Lmin > 0.60;
      const v = [];
      const 判定 = (raw, where) => {
        const col = C.color(raw); if (!col || col.a === 0) return;   // 完全な透明は地そのもの
        // グラデーションのどの停止色の上でも地に沈むなら違反
        const 沈む = 地.every((s2) => {
          const L = C.lum(C.over(col, s2)), Ls2 = C.lum(s2);
          return 暗い地 ? L <= Ls2 : 明るい地 ? L >= Ls2 : false;
        });
        if ((暗い地 || 明るい地) && 沈む) v.push(`overlay.html: ${暗い地 ? '暗い' : '明るい'}地(${bgRaw.split('\n')[0].trim()}) の上に、地に沈む ${raw} が ${where} にある — 見えない`);
      };
      // CSS 側のインク。自分で不透明な地を敷いている要素は、その地の上で判定する
      // （地そのもの＝background の値は判定しない。同系色の地は設計判断であって欠陥ではない）
      const インク = ['color', 'border-top-color', 'border-bottom-color', 'border-color', 'border', 'outline-color', 'text-decoration-color'];
      for (const r of s.css) {
        if (r.at.startsWith('@keyframes')) continue;
        if (!r.selectors.some((x) => x.startsWith('.pill') || /\.(dot|status|timer|pbtn|sq)/.test(x))) continue;
        if (r.selectors.includes('.pill')) continue;                    // 地そのもの
        const 自前 = C.colorsIn(r.decls.background || r.decls['background-color'] || '').filter((c) => (c.a === undefined ? 1 : c.a) >= 0.5);
        if (自前.length) continue;                                       // 自分で地を持つ要素は別の地の上（範囲外）
        for (const p of インク) if (r.decls[p]) for (const c of C.colorsIn(r.decls[p])) 判定(c.raw, `${r.selectors.join(',')} { ${p} }`);
      }
      // JS が canvas に描く色（三項演算子の両側も拾う）
      for (const m of s.scriptText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1').matchAll(/(fillStyle|strokeStyle|shadowColor)\s*=\s*([^;\n]+)/g)) {
        for (const c of C.colorsIn(m[2])) 判定(c.raw, `script の ${m[1]}`);
      }
      return v;
    } },

  { id: 'COLOR-02', 分類: '色',
    表明: '定義された色トークン（CSS変数）に、参照の無いものが無い',
    由来: '配色を変えたのに一部を直し忘れた残骸は、次の配色事故の予兆。overlay.html の --ink:#1b1e25 は v0.10.1 が禁止した rgba(27,30,37) と同じ色で、綴りを変えれば同じバグが復活する',
    check(w) {
      const v = [];
      for (const s of Object.values(w.screens)) {
        const def = new Set(); const use = new Set();
        for (const r of s.css) for (const k of Object.keys(r.decls)) if (k.startsWith('--')) def.add(k);
        for (const m of s.src.matchAll(/var\(\s*(--[\w-]+)/g)) use.add(m[1]);
        for (const d of def) if (!use.has(d)) v.push(`${s.rel}: 色トークン ${d} が定義だけで使われていない（配色変更のやり残し）`);
        for (const u of use) if (!def.has(u)) v.push(`${s.rel}: var(${u}) を参照しているが定義が無い`);
      }
      return v;
    } },

  { id: 'COLOR-03', 分類: '色',
    表明: ':root の色トークンは、ダーク配色でもすべて上書きされている',
    由来: '地だけ切り替えて前景を置き忘れる事故（v0.10.1 の型）を、個別の色ではなく「対応の網羅」として止める',
    check(w) {
      const s = w.screens.app;
      // rgba(var(--srf), .55) のように変数を含む値も色として数える
      const 色 = (v) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(String(v));
      const light = new Set(), dark = new Set();
      for (const r of s.css) for (const [k, val] of Object.entries(r.decls)) {
        if (!k.startsWith('--') || !色(val)) continue;
        if (r.at.includes('prefers-color-scheme: dark') || r.selectors.some((x) => x.includes('dark'))) dark.add(k); else if (r.selectors.includes(':root')) light.add(k);
      }
      if (!light.size || !dark.size) return ['app.html: ライト／ダークの色トークンが取れない（検査が空振りしている）'];
      const v = [];
      for (const k of light) if (!dark.has(k)) v.push(`app.html: 色トークン ${k} がダーク配色で上書きされていない`);
      for (const k of dark) if (!light.has(k)) v.push(`app.html: 色トークン ${k} がダークにしか無い（ライトで var() が空になる）`);
      return v;
    } },

  { id: 'COLOR-04', 分類: '色',
    表明: 'JS が付け外しするクラスには、CSS に定義がある',
    由来: 'CSS と JS で片方だけ改名すると、見た目の切り替えが例外も出さずに黙って死ぬ（一時停止の表示など）。実機で見るまで誰も気づかない',
    check(w) {
      const v = [];
      for (const s of Object.values(w.screens)) {
        const js = s.scriptText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        const 使用 = new Set();
        for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\(\s*['"]([^'"]+)['"]/g)) 使用.add(m[1]);
        if (!使用.size) { v.push(`${s.rel}: classList の操作が1つも見つからない（検査が空振りしている）`); continue; }
        const 定義 = new Set();
        for (const r of s.css) for (const sel of r.selectors) for (const m of sel.matchAll(/\.([A-Za-z0-9_-]+)/g)) 定義.add(m[1]);
        for (const c of 使用) if (!定義.has(c)) v.push(`${s.rel}: JS が付け外しする .${c} に CSS の定義が無い（片方だけ改名した疑い）`);
      }
      return v;
    } },

  // ---- Electron の地雷 ---------------------------------------------------
  { id: 'WIN-01', 分類: 'Electron',
    表明: '透過ウィンドウは表1の地雷を1つも踏んでいない',
    由来: 'v0.9.7 の backgroundThrottling:false で透明が壊れた（v0.9.11で修正）。事象ごとではなく「禁止の集合」として持つので、別の踏み方でも止まる',
    check(w) {
      const 透過 = w.windows.filter((x) => x.opt('transparent') === 'true');
      if (!透過.length) return ['main.js: transparent:true のウィンドウが見つからない（検査が空振りしている）'];
      const v = [];
      for (const win of 透過) for (const m of TRANSPARENT_WINDOW_MINES) {
        const val = win.opt(m.key);
        if (m.ng(val)) v.push(`main.js:${win.line}行 透過ウィンドウ ${win.varName} の ${m.key}${val === undefined ? '（未指定）' : ` = ${val}`} — ${m.why}`);
      }
      return v;
    } },

  { id: 'WIN-02', 分類: 'Electron',
    表明: '透過ウィンドウが読み込む HTML の CSS が、表1（CSS側）の地雷を踏んでいない',
    由来: 'v0.10.0 で外向きの box-shadow と backdrop-filter を入れ、ピルの外に灰色の矩形が出た（v0.10.1で修正）。CSSの木を経由するのでコメント中の語には絶対に当たらない',
    check(w) {
      const v = [];
      const 透過 = w.windows.filter((x) => x.opt('transparent') === 'true');
      if (!透過.length) return ['main.js: transparent:true のウィンドウが見つからない（検査が空振りしている）'];
      for (const win of 透過) {
        const s = Object.values(w.screens).find((x) => x.rel.endsWith('/' + win.file));
        if (!s) { v.push(`main.js: 透過ウィンドウ ${win.varName} が読み込む HTML を特定できない`); continue; }
        for (const r of s.css) {
          if (r.at.startsWith('@keyframes')) continue;   // 窓の矩形には落ちない
          for (const m of TRANSPARENT_CSS_MINES) {
            const val = r.decls[m.prop];
            if (val !== undefined && m.ng(val)) v.push(`${s.rel}:${r.line}行 ${r.selectors.join(',')} { ${m.prop}: ${val} } — ${m.why}`);
          }
        }
        const 地 = s.css.filter((r) => r.selectors.some((x) => /\bhtml\b|\bbody\b/.test(x)) && !r.at);
        const bg = 地.map((r) => r.decls.background || r.decls['background-color']).filter(Boolean).pop();
        if (!bg || !/transparent|rgba\([^)]*,\s*0\s*\)/.test(bg)) v.push(`${s.rel}: html/body の background が transparent でない（${bg || '未指定'}）— 窓全体が不透明になる`);
      }
      return v;
    } },

  // ---- 復旧経路 ----------------------------------------------------------
  { id: 'RECOVER-01', 分類: '復旧経路',
    表明: '表3の操作は、レンダラーを経由しない入口（トレイ／アプリメニュー）からも到達できる',
    由来: 'v0.10.4。更新ボタンが壊れた設定画面の中にしか無く、1件目のバグが2件目を「直せないバグ」に昇格させた',
    check(w) {
      const src = w.mainSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      const labels = [...src.matchAll(/label\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|[^,}]*?\?\s*'([^']*)'\s*:\s*[^,}]*?'([^']*)'\s*:\s*'([^']*)')/g)]
        .flatMap((m) => m.slice(1).filter(Boolean));
      if (!labels.length) return ['main.js: メニュー項目の label が1つも取れない（検査が空振りしている）'];
      const v = [];
      for (const p of RECOVERY_PATHS) if (!labels.some((l) => p.語.every((k) => l.includes(k)))) v.push(`main.js: 復旧経路「${p.名前}」がトレイ／アプリメニューに無い — ${p.由来}`);
      return v;
    } },

  { id: 'RECOVER-02', 分類: '復旧経路',
    表明: '画面のスクリプトが丸ごと落ちても、復旧経路は main.js 側だけで成立する',
    由来: '同上。「二重化されている」を実際に確かめる',
    check(w) {
      const src = w.mainSrc;
      const v = [];
      // 更新の確認は ipcMain 経由ではない関数から呼べること
      if (!/click\s*:\s*checkUpdateFromTray/.test(src)) v.push('main.js: トレイの更新が checkUpdateFromTray（レンダラー非依存）に結線されていない');
      const fn = src.slice(src.indexOf('function checkUpdateFromTray'), src.indexOf('function updateTray'));
      if (fn && /mainWin\.webContents\.send\([^)]*\)\s*;?\s*$/.test(fn.trim())) v.push('main.js: checkUpdateFromTray が画面へ投げるだけで、main 側で完結していない');
      return v;
    } },

  // ---- 配布物 ------------------------------------------------------------
  { id: 'DIST-01', 分類: '配布物',
    表明: 'リポジトリ内の .ps1 は BOM 付き UTF-8 + CRLF である',
    由来: 'PowerShell 5.1 は BOM が無いと Shift-JIS と誤読して構文エラーになる',
    check(w) {
      const fs = require('fs'); const path = require('path');
      const v = [];
      const ps1 = w.trackedFiles().filter((f) => f.endsWith('.ps1'));
      if (!ps1.length) return ['.ps1 が1つも無い（検査が空振りしている）'];
      for (const f of ps1) {
        const b = fs.readFileSync(path.join(w.ROOT, f));
        if (!(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF)) v.push(`${f}: BOM が無い（PowerShell 5.1 が Shift-JIS と誤読する）`);
        const s = b.toString('utf8');
        if (/(?<!\r)\n/.test(s)) v.push(`${f}: LF だけの行がある（CRLF にすること）`);
      }
      return v;
    } },

  { id: 'DIST-02', 分類: '配布物',
    表明: '.ps1 を書き出すコードは、必ず BOM+CRLF を付ける生成器（tools/write-ps1.js）を通る',
    由来: 'その場で作って手渡した .ps1 が BOM 無しで PowerShell 5.1 が構文エラーになった。検査対象の「範囲」の問題なので、書き出し口を1本に絞って範囲の中へ引き込む以外に手が無い',
    check(w) {
      const fs = require('fs'); const path = require('path');
      const v = [];
      const gen = path.join(w.ROOT, 'tools', 'write-ps1.js');
      if (!fs.existsSync(gen)) return ['tools/write-ps1.js が無い（.ps1 の唯一の書き出し口）'];
      for (const f of w.trackedFiles()) {
        if (!/\.(js|cjs|mjs)$/.test(f) || f === 'tools/write-ps1.js') continue;
        const s = fs.readFileSync(path.join(w.ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        for (const m of s.matchAll(/writeFileSync\s*\(\s*([^,]+),/g)) if (/\.ps1/.test(m[1])) v.push(`${f}: .ps1 を writeFileSync で直接書いている（tools/write-ps1.js を通すこと）`);
      }
      return v;
    } },

  { id: 'DIST-03', 分類: '配布物',
    表明: 'リポジトリ内の .ps1 は、括弧と引用符の対応が取れている',
    由来: '手渡した .ps1 が MissingEndCurlyBrace で動かなかった。文字を切り貼りして .ps1 を直す限り、閉じ忘れは必ずまた起きる。実機に渡る前に機械で止める',
    check(w) {
      const fs = require('fs'); const path = require('path');
      const { scanPs1 } = require('../tools/lib/ps1.js');
      const v = [];
      const ps1 = w.trackedFiles().filter((f) => f.endsWith('.ps1'));
      if (!ps1.length) return ['.ps1 が1つも無い（検査が空振りしている）'];
      for (const f of ps1) {
        for (const m of scanPs1(fs.readFileSync(path.join(w.ROOT, f), 'utf8'))) v.push(`${f}: ${m}`);
      }
      return v;
    } },

  // ---- 結線 --------------------------------------------------------------
  { id: 'IPC-01', 分類: '結線',
    表明: 'preload が公開する API は、すべて main.js に受け口がある',
    由来: '片側だけ足す／消す事故を、点ではなく網羅で止める',
    check(w) {
      const src = w.preloadSrc;
      const ch = [...src.matchAll(/ipcRenderer\.(invoke|send|on)\(\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
      if (!ch.length) return ['preload.js からチャンネル名が取れない（検査が空振りしている）'];
      const main = w.mainSrc;
      const v = [];
      for (const [kind, name] of ch) {
        const need = kind === 'invoke' ? `ipcMain.handle('${name}'` : kind === 'send' ? `ipcMain.on('${name}'` : null;
        if (kind === 'on') { if (!main.includes(`'${name}'`)) v.push(`main.js: preload が受ける '${name}' を誰も送っていない`); continue; }
        if (!main.includes(need)) v.push(`main.js: preload が呼ぶ '${name}' の ${kind === 'invoke' ? 'handle' : 'on'} が無い`);
      }
      return v;
    } },

  { id: 'IPC-02', 分類: '結線',
    表明: '画面が使う preload の API は、すべて preload に存在する',
    由来: '存在しない API を呼ぶと undefined is not a function で初期化が止まる（RUN-01 と同じ故障モードの別経路）',
    check(w) {
      const v = [];
      for (const s of Object.values(w.screens)) {
        for (const ns of Object.keys(w.apis)) {
          const used = [...s.scriptText.matchAll(new RegExp(`window\\.${ns}\\.([A-Za-z_][\\w]*)`, 'g'))].map((m) => m[1]);
          for (const u of new Set(used)) if (!w.apis[ns].includes(u)) v.push(`${s.rel}: window.${ns}.${u}() が preload に無い`);
        }
      }
      return v;
    } },

  // ---- メタ（検査そのものの健全性） --------------------------------------
  { id: 'META-01', 分類: 'メタ',
    表明: '除外リスト（DYNAMIC_IDS）に、実際には静的に存在する id が残っていない',
    由来: '除外リストは腐って誤検知源・見逃し源になる。腐りを機械で検出する',
    check(w) {
      const all = new Set(Object.values(w.screens).flatMap((s) => s.ids));
      return DYNAMIC_IDS.filter((id) => all.has(id)).map((id) => `DYNAMIC_IDS の "${id}" は HTML に静的に存在する。除外から外すこと`);
    } },
];

module.exports = { INVARIANTS, WIRED, TRANSPARENT_WINDOW_MINES, TRANSPARENT_CSS_MINES, CONTAINMENT, RECOVERY_PATHS, BOOT_REACHED, DYNAMIC_IDS };
