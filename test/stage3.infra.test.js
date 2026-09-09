'use strict';
/*
 * stage3.infra.test.js — 第3段（v0.11.0）で入れた「検査の仕組み」そのものを固定する。
 *   #38 ゲートの射程の但し書きと、pre-commit がゲートの後に npm test を走らせること
 *   #39 画面の非同期の初期化死（unhandledRejection）に画面と何本目のスクリプトかの印が付くこと
 *   #40 透過ウィンドウの地雷台帳が tools/lib/mines.js の1本であること
 * 仕組みは静かに空振りしはじめるので、「壊したら赤になる」を機械で確かめ続ける。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const hasGit = (() => { try { cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; } })();
const hasSh = process.platform !== 'win32' && (() => { try { cp.execFileSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// ---------------------------------------------------------------------------
//  #38 ゲートの射程
// ---------------------------------------------------------------------------
const R = require('../tools/risk.js');

test('#38 ゲートの射程は、見る範囲と見ていないファイルを名指しで持つ', () => {
  assert.ok(R.SCOPE.sees.length >= 5, '見る範囲が少なすぎる（検査が空振りしている）');
  for (const f of ['src/cite.js', 'src/store.js', 'src/minutes.js', 'src/actions.js']) {
    assert.ok(R.SCOPE.blind.includes(f), `射程外に ${f} が無い`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `射程外に挙げた ${f} が存在しない（表が腐っている）`);
  }
  const note = R.scopeNote(new Set());
  assert.match(note, /このゲートが見る範囲/, '見る範囲の但し書きが無い');
  assert.match(note, /見ていないもの: src\/cite\.js/, '見ていないものの但し書きが無い');
  assert.match(note, /npm test が守る/, '射程外を誰が守るかが書かれていない');
  assert.ok(!/※/.test(note), '射程外のファイルを触っていないのに名指しの行が出る');
  const hit = R.scopeNote(new Set(['src/cite.js', 'src/renderer/app.html']));
  assert.match(hit, /※ この変更には src\/cite\.js が含まれる/, '射程外のファイルを触ったのに名指ししない');
  assert.ok(!/app\.html が含まれる/.test(hit), '射程内のファイルまで射程外と言っている');
});

test('#38 「危険な変更は見つからなかった」の直後に、射程の但し書きが出る', { skip: !hasGit && 'git が無い' }, () => {
  const out = cp.execFileSync(process.execPath, ['tools/risk.js', '--base', 'HEAD', '--head', 'HEAD'], { cwd: ROOT }).toString();
  assert.match(out, /危険な変更は見つからなかった（このゲートが見る範囲では）。\n  このゲートが見る範囲: /, '但し書きが「見つからなかった」の直後に無い');
  assert.match(out, /見ていないもの: src\/cite\.js \/ src\/store\.js \/ src\/minutes\.js \/ src\/actions\.js のロジック — これらは npm test が守る/);
});

test('#38 src/cite.js を触ったコミットでは、射程外だと名指しで出る', { skip: !hasGit && 'git が無い' }, () => {
  const h = cp.execFileSync('git', ['log', '--format=%h', '-1', '--', 'src/cite.js'], { cwd: ROOT }).toString().trim();
  assert.ok(h, 'src/cite.js を触ったコミットが見つからない（検査が空振りしている）');
  let parent;
  try { parent = cp.execFileSync('git', ['rev-parse', '--short', h + '^'], { cwd: ROOT }).toString().trim(); } catch { return; }   // 最初のコミット
  const r = cp.spawnSync(process.execPath, ['tools/risk.js', '--base', parent, '--head', h], { cwd: ROOT });
  const out = r.stdout.toString();
  assert.match(out, /※ この変更には src\/cite\.js が含まれる。ここはこのゲートの射程外 — npm test を通すこと/, `名指しが無い:\n${out}`);
});

test('#38 チェックリストにも、ゲートが見ていないものが書かれる', { skip: !hasGit && 'git が無い' }, () => {
  const out = path.join(os.tmpdir(), `listener-checklist-${process.pid}.md`);
  try {
    cp.execFileSync(process.execPath, ['tools/risk.js', '--base', 'HEAD', '--head', 'HEAD', '--checklist', out], { cwd: ROOT });
    const md = fs.readFileSync(out, 'utf8');
    assert.match(md, /このゲートが見ていないもの: src\/cite\.js/, 'チェックリストに射程外が無い');
    assert.match(md, /npm test が守る/);
  } finally { try { fs.unlinkSync(out); } catch { /* 無ければよい */ } }
});

// ---------------------------------------------------------------------------
//  #38 pre-commit: ゲート → npm test の順で、落ちたら止まる
// ---------------------------------------------------------------------------
const { HOOK } = require('../tools/install-hook.js');

test('#38 pre-commit はゲートの後に npm test --silent を走らせ、LISTENER_SKIP_TESTS で飛ばせる', () => {
  assert.ok(HOOK.startsWith('#!/bin/sh\n'), 'sh のスクリプトでない');
  const gate = HOOK.indexOf('tools/risk.js" --staged');
  const tests = HOOK.indexOf('npm test --silent');
  assert.ok(gate >= 0, 'ゲート（tools/risk.js --staged）を呼んでいない');
  assert.ok(tests >= 0, 'npm test --silent を呼んでいない');
  assert.ok(gate < tests, 'npm test がゲートより先に走る');
  assert.ok(HOOK.includes('LISTENER_SKIP_TESTS'), 'テストを飛ばす合図（LISTENER_SKIP_TESTS）が無い');
  assert.ok(HOOK.includes('LISTENER_GATE_OVERRIDE'), 'ゲートを越える合図（LISTENER_GATE_OVERRIDE）が無い');
  assert.match(HOOK, /目安 15 秒/, '実行時間の目安が書かれていない');
  assert.match(HOOK, /src\/cite\.js/, 'なぜテストを走らせるか（ゲートの射程外）が書かれていない');
  // 設置する側のコメントにも同じことが書いてある（据えた人が読むのはこちら）
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'install-hook.js'), 'utf8');
  assert.match(src, /目安は 15 秒/, 'install-hook.js のコメントに実行時間の目安が無い');
});

/**
 * フックを実際に sh で走らせる。node / npm / git を PATH の先頭の偽物に差し替え、
 * 呼ばれた順と終了コードを見る（本物の npm test を 5 回走らせると 1 分かかる）。
 */
function runHook(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-hook-'));
  const logFile = path.join(dir, 'calls.log');
  const shim = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "$SHIM_LOG"\n${body}\n`, { mode: 0o755 }); };
  shim('node', 'case "$*" in *risk.js*) exit ${FAKE_GATE:-0};; esac\nexit 0');
  shim('npm', 'exit ${FAKE_TEST:-0}');
  shim('git', `echo "${dir}"`);
  const hook = path.join(dir, 'pre-commit');
  fs.writeFileSync(hook, HOOK, { mode: 0o755 });
  const r = cp.spawnSync('sh', [hook], { cwd: dir, env: Object.assign({}, process.env, { PATH: `${dir}:${process.env.PATH}`, SHIM_LOG: logFile, LISTENER_GATE_OVERRIDE: '', LISTENER_SKIP_TESTS: '' }, env) });
  const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]).filter((n) => n !== 'git') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout.toString() + r.stderr.toString(), calls };
}

test('#38 pre-commit を実際に走らせる: ゲート→テストの順、落ちたら止まる、合図で飛ばせる', { skip: !hasSh && 'sh が無い' }, () => {
  const ok = runHook({});
  assert.strictEqual(ok.status, 0, `ゲートもテストも通ったのに commit が止まる:\n${ok.out}`);
  assert.deepStrictEqual(ok.calls, ['node', 'npm'], 'ゲート → npm test の順に 1 回ずつ呼ばれていない');

  const gateNg = runHook({ FAKE_GATE: '1' });
  assert.strictEqual(gateNg.status, 1, 'ゲートが落ちたのに commit が止まらない');
  assert.deepStrictEqual(gateNg.calls, ['node'], 'ゲートが落ちたのに npm test まで走っている');
  assert.match(gateNg.out, /危険な変更のため commit を止めた/);

  const override = runHook({ FAKE_GATE: '1', LISTENER_GATE_OVERRIDE: '理由' });
  assert.strictEqual(override.status, 0, '理由付きで越えたのに commit が止まる');
  assert.deepStrictEqual(override.calls, ['node', 'npm'], 'ゲートを越えてもテストは走る');
  assert.match(override.out, /ゲートを越えて commit する。理由: 理由/);

  const testNg = runHook({ FAKE_TEST: '1' });
  assert.strictEqual(testNg.status, 1, 'npm test が落ちたのに commit が止まらない');
  assert.match(testNg.out, /npm test が落ちたため commit を止めた/);
  assert.match(testNg.out, /LISTENER_SKIP_TESTS=1/, '飛ばし方が案内されていない');

  const skip = runHook({ FAKE_TEST: '1', LISTENER_SKIP_TESTS: '1' });
  assert.strictEqual(skip.status, 0, 'LISTENER_SKIP_TESTS=1 なのに止まる');
  assert.deepStrictEqual(skip.calls, ['node'], 'LISTENER_SKIP_TESTS=1 なのに npm test が走っている');
  assert.match(skip.out, /npm test を飛ばして commit する/);
});
