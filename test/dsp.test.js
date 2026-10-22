/* Node test harness for the CountLine analyzer DSP.
 * Loads the browser module by stubbing `window`, then exercises the
 * internal functions on synthetic click tracks with known tempos. */
global.window = {};
const fs = require('fs');
const path = require('path');
let src = fs.readFileSync(path.join(__dirname, '..', 'audio-analyzer.js'), 'utf8');
src = src.replace(
  'global.CountLineAnalyzer = { analyze };',
  'global.CountLineAnalyzer = { analyze, _fft: fft, _est: estimateTempo, _env: onsetEnvelope, _track: trackBeats, _local: localTempi, _changes: detectTempoChanges, _meter: inferMeter, _profile: tempoProfileOf };'
);
eval(src);
const A = window.CountLineAnalyzer;
const SR = 22050;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? '  [' + detail + ']' : ''));
  ok ? pass++ : fail++;
}

/* Build a click track with optional per-segment tempo. */
function clickTrack(segments) { // segments: [{from,to,bpm}]
  const dur = Math.max(...segments.map((s) => s.to));
  const samples = new Float32Array(SR * dur);
  for (const seg of segments) {
    const period = (SR * 60) / seg.bpm;
    for (let t = seg.from * SR; t < seg.to * SR; t += period) {
      const start = Math.floor(t);
      for (let i = 0; i < 400 && start + i < samples.length; i++) {
        samples[start + i] = Math.exp(-i / 50) * (Math.random() * 2 - 1);
      }
    }
  }
  return samples;
}

// --- FFT ---
(() => {
  const N = 1024, bin = 64;
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / N);
  A._fft(re, im);
  let peak = 0, mag = -1;
  for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > mag) { mag = m; peak = k; } }
  check('FFT peaks at correct bin', peak === bin, 'bin=' + peak);
})();

// --- Steady tempos ---
for (const bpm of [90, 120, 150]) {
  const s = clickTrack([{ from: 0, to: 14, bpm }]);
  const { envelope, envSr } = A._env(s, SR);
  const est = A._est(envelope, envSr);
  const beats = A._track(envelope, envSr, est, A._profile(envelope, envSr));
  const expected = 14 * (bpm / 60);
  check('tempo est @' + bpm, Math.abs(est - bpm) < 8, 'est=' + est.toFixed(1));
  check('beat count @' + bpm, Math.abs(beats.length - expected) <= 5, beats.length + '/' + Math.round(expected));
}

// --- Tempo change (speed up) ---
(() => {
  const s = clickTrack([{ from: 0, to: 11, bpm: 100 }, { from: 11, to: 22, bpm: 140 }]);
  const { envelope, envSr } = A._env(s, SR);
  const est = A._est(envelope, envSr);
  const beats = A._track(envelope, envSr, est, A._profile(envelope, envSr));
  const local = A._local(beats);
  const changes = A._changes(beats, local);
  // Measure local BPM in each half directly from tracked beats.
  const half = beats[Math.floor(beats.length / 2)];
  const firstHalf = beats.filter((b) => b < 9);
  const secondHalf = beats.filter((b) => b > 13);
  const bpmOf = (arr) => { let s = 0, c = 0; for (let i = 1; i < arr.length; i++) { s += arr[i] - arr[i - 1]; c++; } return 60 / (s / c); };
  const b1 = bpmOf(firstHalf), b2 = bpmOf(secondHalf);
  check('tracks slower first half (~100)', Math.abs(b1 - 100) < 15, b1.toFixed(0));
  check('tracks faster second half (~140)', Math.abs(b2 - 140) < 18, b2.toFixed(0));
  check('detects >=1 tempo change', changes.length >= 1, changes.map((c) => c.fromBpm + '->' + c.toBpm).join(','));
})();

// --- Meter inference: accented downbeat every 4 beats = 4/4 ---
(() => {
  const bpm = 120, dur = 16;
  const samples = new Float32Array(SR * dur);
  const period = (SR * 60) / bpm;
  let beatNo = 0;
  for (let t = 0; t < dur * SR; t += period) {
    const start = Math.floor(t);
    const accent = beatNo % 4 === 0 ? 3 : 1; // louder downbeat
    for (let i = 0; i < 400 && start + i < samples.length; i++) samples[start + i] = accent * Math.exp(-i / 50) * (Math.random() * 2 - 1);
    beatNo++;
  }
  const { envelope, envSr } = A._env(samples, SR);
  const est = A._est(envelope, envSr);
  const beats = A._track(envelope, envSr, est, A._profile(envelope, envSr));
  const { beatsPerBar, defaultCount } = A._meter(est, beats, envelope, envSr);
  check('infers 4/4 from accented downbeats', beatsPerBar === 4 && defaultCount === 8, beatsPerBar + '/4, ' + defaultCount + '-count');
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
