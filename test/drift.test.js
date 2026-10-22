/* Drift regression test — the "gets more behind as the song goes on" bug.
 * Builds a LONG steady click track and checks that tracked beats stay aligned
 * with the true beat grid at the END of the song, not just the start. Also
 * verifies sub-frame tempo precision removed the frame-quantization bias. */
global.window = {};
const fs = require('fs');
const path = require('path');
let src = fs.readFileSync(path.join(__dirname, '..', 'audio-analyzer.js'), 'utf8');
src = src.replace('global.CountLineAnalyzer = { analyze };',
  'global.CountLineAnalyzer = { analyze, _est: estimateTempo, _env: onsetEnvelope, _track: trackBeats, _profile: tempoProfileOf };');
eval(src);
const A = window.CountLineAnalyzer;
const SR = 22050;

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + ' — ' + n + (d ? '  [' + d + ']' : '')); ok ? pass++ : fail++; };

// A clean, LONG click track: 128 BPM for 90 seconds (~192 beats).
function clickTrack(bpm, durSec) {
  const samples = new Float32Array(SR * durSec);
  const period = (SR * 60) / bpm;
  for (let t = 0; t < samples.length; t += period) {
    const start = Math.floor(t);
    for (let i = 0; i < 400 && start + i < samples.length; i++) samples[start + i] = Math.exp(-i / 50) * (Math.random() * 2 - 1);
  }
  return samples;
}

(async () => {
  const bpm = 128, dur = 90;
  const sig = clickTrack(bpm, dur);
  const { envelope, envSr } = await A._env(sig, SR);
  const est = A._est(envelope, envSr);
  check('tempo estimate accurate to <1 BPM', Math.abs(est - bpm) < 1.0, 'est=' + est.toFixed(2));

  const beats = await A._track(envelope, envSr, est, await A._profile(envelope, envSr));
  check('tracked a long run of beats', beats.length > 150, beats.length + ' beats');

  // True beat times (the click grid). Measure alignment of tracked beats to
  // the nearest true beat, early vs late in the song.
  const truePeriod = 60 / bpm;
  const alignError = (t) => { const k = Math.round(t / truePeriod); return Math.abs(t - k * truePeriod); };

  const early = beats.filter((b) => b < 15);
  const late = beats.filter((b) => b > dur - 15);
  const avg = (arr) => arr.reduce((s, b) => s + alignError(b), 0) / arr.length;
  const earlyErr = avg(early) * 1000; // ms
  const lateErr = avg(late) * 1000;   // ms

  check('early beats well-aligned (<25ms)', earlyErr < 25, earlyErr.toFixed(1) + 'ms');
  // The core assertion: late beats are NOT progressively worse than early ones.
  check('late beats do NOT drift (within ~15ms of early)', (lateErr - earlyErr) < 15, 'early=' + earlyErr.toFixed(1) + 'ms late=' + lateErr.toFixed(1) + 'ms');
  check('late beats still well-aligned (<35ms)', lateErr < 35, lateErr.toFixed(1) + 'ms');

  // Cumulative drift: the last tracked beat should land near a true grid line,
  // not seconds off.
  const lastBeat = beats[beats.length - 1];
  check('final beat within one frame of the grid', alignError(lastBeat) < 0.03, (alignError(lastBeat) * 1000).toFixed(1) + 'ms off');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
