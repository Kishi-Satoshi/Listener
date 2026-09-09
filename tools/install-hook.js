#!/usr/bin/env node
'use strict';
// 変更危険度ゲートとテストを git の pre-commit に据える。これが「仕組みで止まる」実体。
//   node tools/install-hook.js
//
// 順番は ゲート（tools/risk.js --staged）→ npm test --silent。ゲートは透過ウィンドウ・
// HTML の木・.ps1・復旧の導線しか見ないので、出典照合や保存のロジック（src/cite.js /
// src/store.js / src/minutes.js / src/actions.js）はテストで守る（監査 #38）。
// npm test の実行時間の目安は 15 秒。急ぐときは LISTENER_SKIP_TESTS=1 で飛ばせる
// （リリース時の npm test は飛ばせない）。テストは作業ツリーに対して走る（index ではない）。
const fs = require('fs'), path = require('path'), cp = require('child_process');

const HOOK = `#!/bin/sh
# Listener 変更危険度ゲート + テスト（tools/install-hook.js が設置）
ROOT="$(git rev-parse --show-toplevel)"
node "$ROOT/tools/risk.js" --staged || {
  if [ -n "$LISTENER_GATE_OVERRIDE" ]; then
    echo ""
    echo "ゲートを越えて commit する。理由: $LISTENER_GATE_OVERRIDE"
  else
    echo ""
    echo "危険な変更のため commit を止めた。"
    echo "  直す      : 上の → の手順に従う（HTML の並べ替えは tools/hedit.js を使う）"
    echo "  意図的なら: LISTENER_GATE_OVERRIDE='理由' git commit ... で越えられる（理由は端末に残る）"
    exit 1
  fi
}
# ゲートの射程外（src/cite.js / src/store.js / src/minutes.js / src/actions.js のロジック）は
# npm test が守る。目安 15 秒。急ぐときは LISTENER_SKIP_TESTS=1 で飛ばせる
# （リリース時の npm test は飛ばせない）。
if [ -n "$LISTENER_SKIP_TESTS" ]; then
  echo "npm test を飛ばして commit する（LISTENER_SKIP_TESTS）"
  exit 0
fi
echo "npm test を実行中（目安 15 秒）…"
OUT="$(cd "$ROOT" && npm test --silent 2>&1)" || {
  echo "$OUT" | grep "^not ok"
  echo "$OUT" | tail -n 12
  echo ""
  echo "npm test が落ちたため commit を止めた。"
  echo "  直す      : 落ちたテストを直してから commit する（詳しくは npm test を実行）"
  echo "  急ぐなら  : LISTENER_SKIP_TESTS=1 git commit ... で飛ばせる（リリース時の npm test は飛ばせない）"
  exit 1
}
echo "npm test: 通った"
`;

function install() {
  const root = path.resolve(__dirname, '..');
  const dir = cp.execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root }).toString().trim();
  const abs = path.resolve(root, dir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'pre-commit'), HOOK, { mode: 0o755 });
  console.log('据えた: ' + path.join(abs, 'pre-commit'));
}

if (require.main === module) install();
module.exports = { HOOK, install };
