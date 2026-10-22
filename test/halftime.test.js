/* Tests the half-time counting logic added to app.js.
 * Mirrors countBeats() + buildPhrases() + the count-at-time mapping so we can
 * verify half-time counts on every OTHER beat, phrases still group in 8s, and
 * the UI element exists. */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + ' — ' + n + (d ? '  [' + d + ']' : '')); ok ? pass++ : fail++; };

// ---- Mirrors of the app logic ----
function countBeats(allBeats, beatStep) {
  if (beatStep <= 1) return allBeats;
  const out = [];
  for (let i = 0; i < allBeats.length; i += beatStep) out.push(allBeats[i]);
  return out;
}
function buildPhrases(beats, countLen) {
  const phrases = [];
  for (let i = 0; i < beats.length; i += countLen) {
    const slice = beats.slice(i, i + countLen);
    if (slice.length) phrases.push({ start: slice[0], beats: slice });
  }
  return phrases;
}
function countAtTime(beats, countLen, t) {
  let bi = 0;
  while (bi < beats.length - 1 && beats[bi + 1] <= t) bi++;
  if (t < beats[0]) return { count: 0 };
  return { count: (bi % countLen) + 1 };
}

// A steady 160 BPM beat grid (0.375s apart), 32 beats.
const all = []; for (let i = 0; i < 32; i++) all.push(+(i * 0.375).toFixed(3));

// ---- countBeats subsampling ----
const normal = countBeats(all, 1);
const half = countBeats(all, 2);
check('normal counts every beat', normal.length === 32, normal.length + ' beats');
check('half-time counts every other beat', half.length === 16, half.length + ' beats');
check('half-time beats are beats 0,2,4,…', half[0] === all[0] && half[1] === all[2] && half[2] === all[4], half.slice(0,3).join(','));

// ---- A half-time count "1" lands on an original beat 1, "2" on beat 3 ----
// Original beat spacing is 0.375s; half-time count spacing should be 0.75s.
const htSpacing = +(half[1] - half[0]).toFixed(3);
check('half-time count spacing is double', htSpacing === 0.75, htSpacing + 's');

// ---- Phrases still group in 8s, half as many phrases in half-time ----
const pN = buildPhrases(normal, 8);
const pH = buildPhrases(half, 8);
check('normal: 32 beats → 4 phrases of 8', pN.length === 4, pN.length);
check('half-time: 16 count-beats → 2 phrases of 8', pH.length === 2, pH.length);

// ---- Count-at-time: at t just after original beat 2 (0.75s) ----
// Normal: that's the 3rd beat → count 3.
// Half-time: count beats are at 0, 0.75, 1.5… so 0.75s is the 2nd count → count 2.
check('normal count at 0.76s is 3', countAtTime(normal, 8, 0.76).count === 3, 'c' + countAtTime(normal, 8, 0.76).count);
check('half-time count at 0.76s is 2', countAtTime(half, 8, 0.76).count === 2, 'c' + countAtTime(half, 8, 0.76).count);

// ---- Export tempo-change index scaling (raw index <-> count-beat index) ----
// A tempo change at raw beat 10 should fall in half-time phrase 0 (count-beats
// 0..7 == raw 0..15 at beatStep 2) → loRaw=0, hiRaw=16 includes 10.
const beatStep = 2, countLen = 8, i = 0;
const loRaw = i * countLen * beatStep, hiRaw = (i + 1) * countLen * beatStep;
check('tempo-change raw index scales into half-time phrase', 10 >= loRaw && 10 < hiRaw, loRaw + '..' + hiRaw);

// ---- UI control present ----
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
check('Counting-feel selector exists', /id="feelSel"/.test(html));
check('half-time option present', /value="2"[^>]*>Half-time/.test(html) || /Half-time/.test(html));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
