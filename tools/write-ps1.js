'use strict';
// .ps1 を書き出す唯一の口。
// PowerShell 5.1 は BOM の無い UTF-8 を Shift-JIS と誤読して構文エラーになる。
// その場で作って手渡す配布物も必ずここを通すこと（通せば既存の DIST-01 検査が効く）。
const fs = require('fs');

function toPs1(text) {
  const body = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]);
}
function writePs1(file, text) {
  if (!/\.ps1$/i.test(file)) throw new Error('writePs1 は .ps1 にのみ使う: ' + file);
  fs.writeFileSync(file, toPs1(text));
  return file;
}
module.exports = { writePs1, toPs1 };

if (require.main === module) {
  const [, , out] = process.argv;
  if (!out) { console.error('usage: node tools/write-ps1.js <out.ps1>  (本文は標準入力)'); process.exit(2); }
  writePs1(out, fs.readFileSync(0, 'utf8'));
}
