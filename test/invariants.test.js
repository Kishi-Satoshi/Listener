'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { world } = require('./helpers/world.js');
const { INVARIANTS } = require('./invariants.js');

const w = world();
for (const inv of INVARIANTS) {
  test(`[${inv.id}] ${inv.表明}`, () => {
    let v;
    try { v = inv.check(w); } catch (e) { assert.fail(`[${inv.id}] 検査そのものが失敗: ${e && e.stack}`); }
    assert.deepStrictEqual(v, [], `\n【${inv.id}】${inv.表明}\n由来: ${inv.由来}\n違反 ${v.length} 件:\n` + v.map((x) => '  - ' + x).join('\n') + '\n');
  });
}
