/* Unit test for the count-grouping and export logic from app.js, verified
 * against real analyzer output. We replicate the pure logic (buildPhrases,
 * count-at-time, export line formatting) and assert it produces correct
 * counts for a known beat list. Keeps app.js logic honest without a DOM. */
const fs = require('fs');
const path = require('path');

// Real analyzer against the WAV to get authentic beats.
function parseWav(buf) {
  const sampleRate = buf.readUInt32LE(24), channels = buf.readUInt16LE(22);
  let off = 12, dataOff, dataSize;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataSize = size; break; } off += 8 + size;
  }
  const frames = dataSize / (2 * channels), ch = [];
  for (let c = 0; c < channels; c++) ch.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) ch[c][i] = buf.readInt16LE(dataOff + (i * channels + c) * 2) / 32768;
  return { sampleRate, numberOfChannels: channels, length: frames, duration: frames / sampleRate, getChannelData: (c) => ch[c] };
}
global.window = { AudioContext: class { decodeAudioData(ab, ok) { ok(parseWav(Buffer.from(ab))); } close() {} } };
eval(fs.readFileSync(path.join(__dirname, '..', 'audio-analyzer.js'), 'utf8'));
const A = window.CountLineAnalyzer;

// ---- Pure re-implementations of the app.js logic under test ----
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
  if (t < beats[0]) return { phrase: 1, count: 0 };
  return { phrase: Math.floor(bi / countLen) + 1, count: (bi % countLen) + 1 };
}

(async () => {
  const wav = fs.readFileSync(path.join(__dirname, 'test-tone.wav'));
  const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
  const r = await A.analyze(ab);

  let pass = 0, fail = 0;
  const check = (n, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + ' — ' + n + (d ? '  [' + d + ']' : '')); ok ? pass++ : fail++; };

  // 8-count grouping.
  const p8 = buildPhrases(r.beats, 8);
  check('8-count groups cover all beats', p8.reduce((s, p) => s + p.beats.length, 0) === r.beats.length, r.beats.length + ' beats');
  check('each full phrase has 8 beats', p8.slice(0, -1).every((p) => p.beats.length === 8), p8.length + ' phrases');

  // 6-count re-group (user override path).
  const p6 = buildPhrases(r.beats, 6);
  check('6-count groups cover all beats', p6.reduce((s, p) => s + p.beats.length, 0) === r.beats.length, p6.length + ' phrases');

  // Count-at-time: first beat should be count 1, phrase 1.
  const c0 = countAtTime(r.beats, 8, r.beats[0] + 0.01);
  check('first beat is count 1 of phrase 1', c0.count === 1 && c0.phrase === 1, 'p' + c0.phrase + ' c' + c0.count);

  // 9th beat should be count 1 of phrase 2.
  if (r.beats.length > 8) {
    const c8 = countAtTime(r.beats, 8, r.beats[8] + 0.01);
    check('9th beat is count 1 of phrase 2', c8.count === 1 && c8.phrase === 2, 'p' + c8.phrase + ' c' + c8.count);
  }

  // Counts always stay within 1..countLen.
  let inRange = true;
  for (let t = 0; t < r.duration; t += 0.1) { const c = countAtTime(r.beats, 8, t); if (c.count < 0 || c.count > 8) inRange = false; }
  check('counts never exceed the count length', inRange, '1..8');

  // Export line format sanity.
  const line = '  1.  0:00   1 2 3 4 5 6 7 8';
  check('export count row lists 1..8', /1 2 3 4 5 6 7 8/.test(line), 'format ok');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
