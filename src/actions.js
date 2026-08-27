/*
 * actions.js — アクションアイテムから担当者と期限を取り出す
 *
 * LLM は指示した書式（担当: ○○ / 期限: ○○）に必ずしも従わない。
 * 「山田さん - 来週金曜まで」のような自然な書き方に崩れることが多いので、
 * 複数の表記を受け止められるようにしている。
 *
 * 期限は「来週金曜」のような相対表現のまま持っていても絞り込みに使えないため、
 * 会議日を基準に実日付へ正規化する。解釈できないものは raw のまま残し、
 * 推測で誤った日付を入れることはしない。
 */
'use strict';

const HONORIFICS = /(?:さん|サン|様|さま|氏|くん|君|ちゃん|部長|課長|次長|係長|主任|社長|専務|常務|取締役|マネージャー|リーダー)$/;
const WEEKDAYS = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

function pad(n) { return String(n).padStart(2, '0'); }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

function cleanName(name) {
  let n = String(name || '').trim().replace(/^[@＠]/, '');
  // 「山田さん」→「山田」。役職付きは役職ごと落として姓だけ残す
  let prev;
  do { prev = n; n = n.replace(HONORIFICS, ''); } while (n !== prev && n.length > 0);
  return n.trim();
}

/**
 * 日本語の期限表現を実日付へ。
 * @param {string} raw 「来週金曜」「8/30」「今月末」など
 * @param {Date}   base 会議の日付
 * @returns {{date:string, approx:boolean}} date は 'YYYY-MM-DD'、解釈不能なら ''
 */
function parseDue(raw, base) {
  const s = String(raw || '').trim();
  if (!s) return { date: '', approx: false };
  if (/(未定|なし|特になし|TBD|未設定|随時)/i.test(s)) return { date: '', approx: false };
  const b = base instanceof Date ? new Date(base) : new Date();
  b.setHours(0, 0, 0, 0);

  let m;

  // --- 絶対日付 ---
  // 2026年8月30日 / 2026/8/30
  if ((m = s.match(/(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/))) {
    return { date: toISO(new Date(+m[1], +m[2] - 1, +m[3])), approx: false };
  }
  // 8月30日 / 8/30 （年が無い＝基準日以降で最も近い年）
  if ((m = s.match(/(\d{1,2})\s*[月/\-]\s*(\d{1,2})\s*日?/))) {
    const mo = +m[1]; const da = +m[2];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      let d = new Date(b.getFullYear(), mo - 1, da);
      if (d < b) d = new Date(b.getFullYear() + 1, mo - 1, da);
      return { date: toISO(d), approx: false };
    }
  }
  // 30日（今月または来月）※「3日後」を月内日付と誤読しないよう除外
  if ((m = s.match(/^(\d{1,2})\s*日(?!後|間)/))) {
    const da = +m[1];
    let d = new Date(b.getFullYear(), b.getMonth(), da);
    if (d < b) d = new Date(b.getFullYear(), b.getMonth() + 1, da);
    return { date: toISO(d), approx: false };
  }

  // --- 相対（日数・週数） ---
  if ((m = s.match(/(\d+)\s*(?:日後|営業日)/))) return { date: toISO(addDays(b, +m[1])), approx: false };
  if ((m = s.match(/(\d+)\s*週間?後/))) return { date: toISO(addDays(b, +m[1] * 7)), approx: false };
  if ((m = s.match(/(\d+)\s*(?:ヶ月|カ月|か月|ケ月)後/))) {
    const d = new Date(b); d.setMonth(d.getMonth() + +m[1]);
    return { date: toISO(d), approx: false };
  }

  if (/本日|今日/.test(s)) return { date: toISO(b), approx: false };
  if (/明日/.test(s)) return { date: toISO(addDays(b, 1)), approx: false };
  if (/明後日/.test(s)) return { date: toISO(addDays(b, 2)), approx: false };

  // --- 曜日指定 ---
  const wd = s.match(/([日月火水木金土])\s*曜/);
  if (wd) {
    const target = WEEKDAYS[wd[1]];
    const cur = b.getDay();
    if (/来週|翌週/.test(s)) {
      // 翌週の該当曜日（週の起点は月曜）
      const toNextMonday = ((8 - cur) % 7) || 7;
      const nextMon = addDays(b, toNextMonday);
      const offset = (target === 0 ? 6 : target - 1);
      return { date: toISO(addDays(nextMon, offset)), approx: false };
    }
    // 今週／指定なし: 基準日以降で最も近いその曜日
    let diff = (target - cur + 7) % 7;
    if (diff === 0) diff = 7; // 同じ曜日なら次の週
    return { date: toISO(addDays(b, diff)), approx: false };
  }

  // --- 期間の終わり ---
  if (/(今週中|週内|今週末|週末まで)/.test(s)) {
    const diff = (5 - b.getDay() + 7) % 7; // 直近の金曜
    return { date: toISO(addDays(b, diff === 0 ? 0 : diff)), approx: false };
  }
  if (/来週末/.test(s)) {
    const diff = (5 - b.getDay() + 7) % 7;
    return { date: toISO(addDays(b, (diff === 0 ? 0 : diff) + 7)), approx: false };
  }
  if (/(来月末|翌月末)/.test(s)) {
    return { date: toISO(endOfMonth(new Date(b.getFullYear(), b.getMonth() + 1, 1))), approx: false };
  }
  if (/(今月末|月末)/.test(s)) return { date: toISO(endOfMonth(b)), approx: false };
  if (/(月初|来月初)/.test(s)) return { date: toISO(new Date(b.getFullYear(), b.getMonth() + 1, 1)), approx: true };

  // 「上旬・中旬・下旬」は幅のある表現なので実日付にしない。
  // 下の「来月」「来週」より先に判定すること。順序を逆にすると
  // 「来月中旬」が『来月の同じ日』という無関係な日付になる。
  if (/(上旬|中旬|下旬)/.test(s)) return { date: '', approx: true };

  if (/来月/.test(s)) { const d = new Date(b); d.setMonth(d.getMonth() + 1); return { date: toISO(d), approx: true }; }
  if (/来週/.test(s)) return { date: toISO(addDays(b, 7)), approx: true };
  if (/今週/.test(s)) {
    const diff = (5 - b.getDay() + 7) % 7;
    return { date: toISO(addDays(b, diff === 0 ? 0 : diff)), approx: true };
  }

  return { date: '', approx: false };
}

/**
 * アクションアイテム1行から担当・期限・本文を切り出す。
 * @param {string} text
 * @param {Date} base 会議の日付（相対期限の基準）
 */
function parseAction(text, base) {
  let body = String(text || '').trim();
  let assignee = '';
  let dueRaw = '';
  let m;

  // (1) 括弧つきの定型: （担当: 山田 / 期限: 来週金曜）
  //     値は「次のキーの直前」までとする。こうしないと「8/30」がスラッシュで切れる。
  const KEY = '(?:担当者?|期限|締切|〆切|assignee|due)';
  const paren = body.match(/[（(]([^）)]*(?:担当|期限|担当者|締切|〆切)[^）)]*)[）)]\s*$/);
  if (paren) {
    const inner = paren[1];
    const grab = (keys) => {
      const re = new RegExp(`(?:${keys})\\s*[:：]\\s*(.+?)(?=\\s*[/｜|,、]?\\s*${KEY}\\s*[:：]|$)`, 'i');
      const g = inner.match(re);
      return g ? g[1].replace(/[\s/｜|,、]+$/, '').trim() : '';
    };
    assignee = grab('担当者?|assignee');
    dueRaw = grab('期限|締切|〆切|due');
    if (assignee || dueRaw) body = body.slice(0, paren.index).trim();
  }

  // (2) 括弧なしの定型: 担当: 山田 期限: 8/30
  if (!assignee && (m = body.match(/(?:担当者?)\s*[:：]\s*([^\s/,、|]+)/))) {
    assignee = m[1].trim(); body = body.replace(m[0], ' ').trim();
  }
  if (!dueRaw && (m = body.match(/(?:期限|締切|〆切)\s*[:：]\s*([^\s,、|]+)/))) {
    dueRaw = m[1].trim(); body = body.replace(m[0], ' ').trim();
  }

  // (3) @メンション形式
  if (!assignee && (m = body.match(/[@＠]\s*([^\s、,/|]+)/))) {
    assignee = m[1].trim(); body = body.replace(m[0], ' ').trim();
  }

  // (4) 自然文からの推定: 「山田さんが〜」「山田さんは〜」「山田さんに依頼」
  if (!assignee && (m = body.match(/([一-龥ぁ-んァ-ヶA-Za-z]{1,8}(?:さん|氏|様|部長|課長|主任))\s*(?:が|は|に|へ)/))) {
    assignee = m[1];
  }

  // (5) 自然文からの期限推定: 「来週金曜までに」「8/30まで」
  if (!dueRaw && (m = body.match(/((?:今日|本日|明日|明後日|今週|来週|再来週|今月|来月|\d{1,2}\s*[月/]\s*\d{1,2}日?|\d{1,2}日|\d+\s*(?:日|週間?|ヶ月)後)(?:末|中)?(?:[日月火水木金土]曜日?)?)\s*(?:まで|迄)/))) {
    dueRaw = m[1].trim();
  }
  if (!dueRaw && (m = body.match(/((?:今|来)?[週月]末|週内)\s*(?:まで|迄)?/))) {
    dueRaw = m[1].trim();
  }

  body = body.replace(/\s{2,}/g, ' ').replace(/^[-–—・\s]+/, '').trim();
  const parsed = parseDue(dueRaw, base);

  return {
    text: body,
    assignee: cleanName(assignee),
    dueRaw,
    due: parsed.date,
    dueApprox: parsed.approx,
  };
}

/**
 * ブロック配列の todo に担当・期限を付与する（破壊的）。
 */
function enrichActionBlocks(blocks, base) {
  let withAssignee = 0; let withDue = 0; let total = 0;
  for (const b of blocks) {
    if (b.type !== 'todo' || !b.text) continue;
    total++;
    const p = parseAction(b.text, base);
    b.text = p.text || b.text;
    b.assignee = p.assignee;
    b.dueRaw = p.dueRaw;
    b.due = p.due;
    b.dueApprox = p.dueApprox;
    if (p.assignee) withAssignee++;
    if (p.due) withDue++;
  }
  return { total, withAssignee, withDue };
}

module.exports = { parseAction, parseDue, cleanName, enrichActionBlocks };
