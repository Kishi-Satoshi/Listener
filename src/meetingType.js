/*
 * meetingType.js — 会議の種類ごとに要約の構成を変える
 *
 * 同じテンプレートを全会議に当てるのは筋が悪い。
 * 採用面接に「決定事項」を求めても空振りするし、
 * 1on1 に「決定事項」という言葉を当てると硬すぎる（実態は「合意」）。
 * 会議の性質に沿った見出しを与えた方が、同じモデルでも要約の質が上がる。
 *
 * 各テンプレートは必ず1つ「- [ ]」形式のアクション節を含む。
 * これがチェックボックス化と担当・期限の抽出の起点になる。
 */
'use strict';

const ACTION_RULE = '（「- [ ] 内容（担当: ○○ / 期限: ○○）」の形式。'
  + '担当や期限が発言に無ければその項目は書かず、内容だけを記す）';

const TYPES = {
  standup: {
    label: '定例・進捗報告',
    hint: '朝会・週次定例など、各担当の報告が中心の会議',
    keywords: ['朝会', '定例', '週次', 'デイリー', '日次', 'スタンドアップ', '進捗確認', '状況共有', 'レビュー会議'],
    format: `## 概要
（会議全体を3〜5行で要約）

## 報告事項
（担当・案件ごとに整理。数値は必ず残す）

## 決定事項
（箇条書き。なければ「特になし」）

## アクションアイテム
${ACTION_RULE}

## 課題・持ち越し事項
（箇条書き。なければ「特になし」）`,
  },

  review: {
    label: '部会・報告会',
    hint: '月次部会や事業報告など、数値報告と方針決定を含む会議',
    keywords: ['部会', '報告会', '月次', '事業本部', '管理職会議', '経営', '本部報告'],
    format: `## 概要
（会議全体を3〜5行で要約）

## 報告事項
（売上・要員・採用などの数値を項目別に。数値は必ず残す）

## 決定事項
（箇条書き。なければ「特になし」）

## 課題・リスク
（指摘された懸念や未達の要因）

## アクションアイテム
${ACTION_RULE}

## 次回への持ち越し
（箇条書き。なければ「特になし」）`,
  },

  oneonone: {
    label: '1on1・面談',
    hint: 'メンバーとの個別面談、キャリア相談、処遇の打診など',
    // 同じ語を二度書くとその語だけ二重に加点され、他タイプの正当な一致に競り勝ってしまう。
    // 全角で入力されることがあるため「１ｏｎ１」も見る。
    keywords: ['1on1', '１ｏｎ１', '面談', 'キャリア', '打診', '個別', 'メンタリング', '評価面談', '就業状況'],
    format: `## 概要
（面談の趣旨と流れを3〜5行で要約）

## 本人の状況・所感
（本人が語った現状、業務の手応え、コンディション）

## 相談・課題
（本人から出た困りごと、希望、懸念）

## 合意した方針・支援
（本人と合意した内容。決定と呼べるものがなければ「特になし」）

## 次回までのアクション
${ACTION_RULE}`,
  },

  sales: {
    label: '商談・協業検討',
    hint: '顧客・パートナーとの商談、協業や契約の検討',
    keywords: ['商談', '協業', '提案', '見積', '契約', '再販', '価格', 'ベンダー選定', '紹介', 'ビジネス'],
    format: `## 概要
（商談の目的と結論を3〜5行で要約）

## 先方の状況・ニーズ
（相手の課題、体制、予算感、時期）

## 提示・説明した内容
（こちらから伝えた提案、条件、価格）

## 先方の反応・懸念
（好感触な点と、指摘された懸念やリスク）

## 決定事項
（合意した内容。なければ「特になし」）

## ネクストアクション
${ACTION_RULE}`,
  },

  interview: {
    label: '採用面接・顔合わせ',
    hint: '候補者の面接、入社前の顔合わせ、オンボーディング面談',
    keywords: ['面接', '顔合わせ', 'オンボーディング', '候補者', '選考', '入社', '採用面談', 'スキル確認'],
    format: `## 概要
（面接の対象と全体の印象を3〜5行で要約）

## 経歴・スキル
（本人が語った経験、技術、担当領域）

## 志向・希望条件
（キャリアの方向性、勤務条件、待遇の希望）

## 確認された懸念点
（スキルギャップ、条件面のズレなど。なければ「特になし」）

## 申し送り・次のステップ
${ACTION_RULE}`,
  },

  brainstorm: {
    label: 'ブレスト・意見交換',
    hint: 'アイデア出し、方針の議論、結論を急がない会議',
    keywords: ['ブレスト', '意見交換', 'アイデア', '検討会', 'ディスカッション', '壁打ち', '構想'],
    format: `## 概要
（何について議論したかを3〜5行で要約）

## 出たアイデア・意見
（発言者の立場が分かる場合は添える。取捨せず幅広く残す）

## 有望とされた方向性
（前向きな評価が集まった案）

## 論点・未整理の点
（結論が出ていない対立軸や不明点）

## 次に検討すること
${ACTION_RULE}`,
  },

  general: {
    label: '一般・その他',
    hint: '上記に当てはまらない会議',
    keywords: [],
    format: `## 概要
（会議全体を3〜5行で要約）

## 決定事項
（箇条書き。なければ「特になし」）

## アクションアイテム
${ACTION_RULE}

## 主なトピックと論点
（トピックごとに要点を整理）

## 未解決・持ち越し事項
（箇条書き。なければ「特になし」）`,
  },
};

const ORDER = ['standup', 'review', 'oneonone', 'sales', 'interview', 'brainstorm', 'general'];

/**
 * タイトルと本文の冒頭から会議タイプを推定する。
 * タイトルは人が付けた明示的なラベルなので重く、本文は補助として軽く見る。
 */
const BODY_ONLY_MIN = 5;

function detectType(title, transcriptHead) {
  const t = String(title || '');
  const body = String(transcriptHead || '').slice(0, 1200);
  const scores = [];

  for (const key of ORDER) {
    if (key === 'general') continue;
    let total = 0; let title_ = 0; let longest = 0;
    for (const kw of TYPES[key].keywords) {
      if (t.includes(kw)) {
        total += 3;                        // タイトル一致は強い根拠
        title_ += 3;
        longest = Math.max(longest, kw.length);
      }
      if (body.includes(kw)) total += 1;   // 本文一致は補助
    }
    if (total > 0) scores.push({ key, total, title: title_, longest });
  }
  if (scores.length === 0) return 'general';

  scores.sort((a, b) => (b.total - a.total)
    // 同点なら、より長い（＝具体的な）語で当たった方を採る。
    // 「採用面談」は interview の『採用面談』と oneonone の『面談』の両方に当たるが、
    // 長い方が書き手の意図に近い。
    || (b.longest - a.longest));

  const best = scores[0];
  // タイトルに手がかりがあればそれを信じる。
  // 本文だけの一致は「提案」「価格」のような一般語でも起きるため、
  // よほど数が揃わない限り型を決める根拠にはしない（誤った型を当てない）。
  if (best.title > 0) return best.key;
  if (best.total >= BODY_ONLY_MIN) return best.key;
  return 'general';
}

function getFormat(type) {
  return (TYPES[type] || TYPES.general).format;
}
function getLabel(type) {
  return (TYPES[type] || TYPES.general).label;
}
function listTypes() {
  return ORDER.map((k) => ({ key: k, label: TYPES[k].label, hint: TYPES[k].hint }));
}

module.exports = { TYPES, ORDER, detectType, getFormat, getLabel, listTypes };
