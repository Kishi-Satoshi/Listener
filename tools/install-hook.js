#!/usr/bin/env node
'use strict';
// 変更危険度ゲートを git の pre-commit に据える。これが「仕組みで止まる」実体。
//   node tools/install-hook.js
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
const dir = cp.execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root }).toString().trim();
const abs = path.resolve(root, dir);
fs.mkdirSync(abs, { recursive: true });
const hook = `#!/bin/sh
# Listener 変更危険度ゲート（tools/install-hook.js が設置）
node "$(git rev-parse --show-toplevel)/tools/risk.js" --staged || {
  if [ -n "$LISTENER_GATE_OVERRIDE" ]; then
    echo ""
    echo "ゲートを越えて commit する。理由: $LISTENER_GATE_OVERRIDE"
    exit 0
  fi
  echo ""
  echo "危険な変更のため commit を止めた。"
  echo "  直す      : 上の → の手順に従う（HTML の並べ替えは tools/hedit.js を使う）"
  echo "  意図的なら: LISTENER_GATE_OVERRIDE='理由' git commit ... で越えられる（理由は端末に残る）"
  exit 1
}
`;
fs.writeFileSync(path.join(abs, 'pre-commit'), hook, { mode: 0o755 });
console.log('据えた: ' + path.join(abs, 'pre-commit'));
