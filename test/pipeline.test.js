/* Full-pipeline test of the REAL analyze() entry point.
 * Polyfills window.AudioContext.decodeAudioData to parse our 16-bit PCM WAV
 * into an AudioBuffer-shaped object, so audio-analyzer.js runs end-to-end
 * exactly as it does in the browser (decode -> onset -> tempo profile ->
 * beat tracking -> meter -> tempo-change detection). */
const fs = require('fs');
const path = require('path');

// ---- Minimal AudioBuffer + AudioContext polyfill backed by a WAV parser ----
function parseWav(buf) {
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const channels = buf.readUInt16LE(22);
  // find 'data' chunk
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') { off += 8; var dataOff = off, dataSize = size; break; }
    off += 8 + size;
  }
  const bytesPerSample = bits / 8;
  const frames = dataSize / (bytesPerSample * channels);
  const chData = [];
  for (let c = 0; c < channels; c++) chData.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = buf.readInt16LE(dataOff + (i * channels + c) * 2) / 32768;
      chData[c][i] = s;
    }
  }
  return {
    sampleRate, numberOfChannels: channels, length: frames,
    duration: frames / sampleRate,
    getChannelData: (c) => chData[c],
  };
}

class FakeAudioContext {
  decodeAudioData(arrayBuffer, onOk) {
    const buf = Buffer.from(arrayBuffer);
    const out = parseWav(buf);
    onOk(out);
  }
  close() {}
}

global.window = { AudioContext: FakeAudioContext };
let src = fs.readFileSync(path.join(__dirname, '..', 'audio-analyzer.js'), 'utf8');
eval(src);
const A = window.CountLineAnalyzer;

(async () => {
  const wav = fs.readFileSync(path.join(__dirname, 'test-tone.wav'));
  const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);

  const steps = [];
  const r = await A.analyze(ab, (p, m) => steps.push(m));

  let pass = 0, fail = 0;
  const check = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? '  [' + detail + ']' : '')); ok ? pass++ : fail++; };

  check('duration ~20s', Math.abs(r.duration - 20) < 0.5, r.duration.toFixed(1) + 's');
  check('BPM reported (90-160)', r.bpm >= 90 && r.bpm <= 160, r.bpm + ' BPM');
  check('inferred 4/4 meter', r.beatsPerBar === 4, r.beatsPerBar + '/4');
  check('default count is 8', r.defaultCount === 8, r.defaultCount + '-count');
  check('found a healthy number of beats', r.beats.length >= 30 && r.beats.length <= 60, r.beats.length + ' beats');
  check('detected the 100->140 tempo change', r.tempoChanges.length >= 1,
    r.tempoChanges.map((c) => c.fromBpm + '->' + c.toBpm + '@' + c.time.toFixed(1) + 's').join(', '));
  check('progress callback fired', steps.length >= 5, steps.length + ' steps');

  // Verify the change is located near the real boundary (10s).
  if (r.tempoChanges.length) {
    const near = r.tempoChanges.some((c) => Math.abs(c.time - 10) < 3.5);
    check('tempo change located near the 10s boundary', near,
      r.tempoChanges.map((c) => c.time.toFixed(1) + 's').join(', '));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('pipeline crashed:', e); process.exit(1); });
