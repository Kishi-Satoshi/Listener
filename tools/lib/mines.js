'use strict';
// 実機で踏んだ地雷の台帳。人の注意力ではなくデータとして残す。
// 「実機で1件踏んだら1行足す」だけで、全ウィンドウ・全HTMLに一斉に効く。
module.exports = {
  // transparent:true のウィンドウで踏んではいけない BrowserWindow オプション
  windowOpts: [
    { key: 'backgroundThrottling', bad: (v) => true, why: 'Windows の透過ウィンドウでは透明が壊れ、ピルの外に不透明の矩形が出る', seen: 'v0.9.7 → v0.9.11 で撤去' },
    { key: 'transparent', bad: (v) => v === 'false', why: '透過をやめると、ピルの角の外に地色の矩形が出る', seen: '設計上の前提' },
    { key: 'hasShadow', bad: (v) => v !== 'false', why: 'OS 側の影が窓の矩形に落ち、ピルの外に出る', seen: 'v0.9.x' },
    { key: 'backgroundColor', bad: (v) => !/^'?#?[0-9a-f]{8}'?$/i.test(v.replace(/['"]/g, '')) || !/00'?$/i.test(v.replace(/['"]/g, '')), why: '不透明の地色を置くと透過が死ぬ', seen: 'Electron の既知事項' },
    { key: 'roundedCorners', bad: () => true, why: 'Windows では透過と噛み合わず矩形が出ることがある', seen: 'Electron の既知事項' },
    { key: 'thickFrame', bad: (v) => v !== 'false', why: 'Windows で窓の縁が描かれる', seen: 'Electron の既知事項' },
    { key: 'vibrancy', bad: () => true, why: '透過ウィンドウの合成と衝突する', seen: 'Electron の既知事項' },
    { key: 'backgroundMaterial', bad: () => true, why: 'Windows の Mica/Acrylic は透過を上書きする', seen: 'Electron の既知事項' },
  ],
  // transparent:true の窓が読み込む HTML の CSS で踏んではいけない宣言
  // （@keyframes の中は窓の矩形に落ちないので対象外）
  css: [
    { prop: 'box-shadow', bad: (v) => !/^\s*(inset|none)/.test(v), why: '外向きの影が窓の矩形いっぱいに落ち、ピルの外に灰色の矩形が出る', seen: 'v0.10.0 → v0.10.1 で撤去' },
    { prop: 'backdrop-filter', bad: () => true, why: '背後の合成結果が取れず、ピルの外に矩形が出る', seen: 'v0.10.0 → v0.10.1 で撤去' },
    { prop: '-webkit-backdrop-filter', bad: () => true, why: '同上', seen: 'v0.10.0 → v0.10.1 で撤去' },
    { prop: 'filter', bad: (v) => /blur|drop-shadow/.test(v), why: '窓の矩形を単位に合成される', seen: 'Electron の既知事項' },
    { prop: 'mix-blend-mode', bad: (v) => v.trim() !== 'normal', why: '透過ウィンドウでは背後と混ざらない', seen: 'Electron の既知事項' },
  ],
  // 復旧・退避の導線。壊れうる層（レンダラー）の外に必ず入口が要る。
  recovery: [
    { name: '更新の確認', mainPattern: /label:\s*'[^']*更新[^']*'/ },
    { name: 'アプリの終了', mainPattern: /label:\s*'[^']*終了[^']*'/ },
  ],
};
