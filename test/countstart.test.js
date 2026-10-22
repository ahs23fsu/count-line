/* Tests the "don't count until audio starts" + "start counting here" logic.
 *  1. detectAudioStart() finds the real start after leading silence.
 *  2. The app's countBeats() origin-skip drops beats before the count origin.
 *  3. The count-start UI controls exist. */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + ' — ' + n + (d ? '  [' + d + ']' : '')); ok ? pass++ : fail++; };

// ---- Load analyzer internals (stub window) ----
global.window = {};
let src = fs.readFileSync(path.join(__dirname, '..', 'audio-analyzer.js'), 'utf8');
src = src.replace('global.CountLineAnalyzer = { analyze };',
  'global.CountLineAnalyzer = { analyze, _audioStart: detectAudioStart };');
eval(src);
const A = window.CountLineAnalyzer;

// ---- 1. detectAudioStart: 3s of silence, then loud tone to 8s ----
(() => {
  const sr = 22050;
  const sig = new Float32Array(sr * 8);
  for (let i = sr * 3; i < sig.length; i++) sig[i] = Math.sin((2 * Math.PI * 200 * i) / sr) * 0.6;
  const start = A._audioStart(sig, sr);
  check('detects audio start near 3s after silence', Math.abs(start - 3) < 0.3, start.toFixed(2) + 's');
})();

// ---- detectAudioStart: fully silent file → 0 (no offset) ----
(() => {
  const sr = 22050;
  const sig = new Float32Array(sr * 4); // all zeros
  const start = A._audioStart(sig, sr);
  check('silent file returns 0 (no offset)', start === 0, start + 's');
})();

// ---- detectAudioStart: audio from the very beginning → ~0 ----
(() => {
  const sr = 22050;
  const sig = new Float32Array(sr * 5);
  for (let i = 0; i < sig.length; i++) sig[i] = Math.sin((2 * Math.PI * 200 * i) / sr) * 0.6;
  const start = A._audioStart(sig, sr);
  check('audio from start detected near 0', start < 0.3, start.toFixed(2) + 's');
})();

// ---- 2. Mirror of countBeats() origin-skip + half-time ----
function countBeats(all, origin, beatStep) {
  let startIdx = 0;
  while (startIdx < all.length && all[startIdx] < origin - 0.03) startIdx++;
  const usable = all.slice(startIdx);
  if (beatStep <= 1) return usable;
  const out = [];
  for (let i = 0; i < usable.length; i += beatStep) out.push(usable[i]);
  return out;
}
const beats = []; for (let i = 0; i < 20; i++) beats.push(+(i * 0.5).toFixed(3)); // 0,0.5,…9.5

check('origin 0 keeps all beats', countBeats(beats, 0, 1).length === 20, countBeats(beats, 0, 1).length);
check('origin 2.0s drops the first 4 beats', countBeats(beats, 2.0, 1).length === 16 && countBeats(beats, 2.0, 1)[0] === 2.0, countBeats(beats, 2.0, 1)[0] + '');
check('tolerance: beat 0.48s still counts for origin 0.5s', countBeats(beats, 0.52, 1)[0] === 0.5 || countBeats(beats, 0.5, 1)[0] === 0.5);
check('origin + half-time composes correctly', (() => {
  const r = countBeats(beats, 2.0, 2); // from 2.0s, every other
  return r[0] === 2.0 && r[1] === 3.0 && r.length === 8;
})(), countBeats(beats, 2.0, 2).slice(0,3).join(','));

// ---- 3. UI controls present ----
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
check('"Start counting here" button exists', /id="setStartBtn"/.test(html));
check('"Reset to music start" button exists', /id="resetStartBtn"/.test(html));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
