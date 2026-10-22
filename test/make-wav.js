/* Generates a test WAV: a kick-drum-ish click track that starts at 100 BPM
 * and jumps to 140 BPM halfway, with a 4/4 accent pattern. Used for an
 * end-to-end browser test of the real decode + analysis path. */
const fs = require('fs');
const SR = 44100;
const segments = [
  { from: 0, to: 10, bpm: 100 },
  { from: 10, to: 20, bpm: 140 },
];
const dur = 20;
const N = SR * dur;
const data = new Float32Array(N);

for (const seg of segments) {
  const period = (SR * 60) / seg.bpm;
  let beatNo = 0;
  for (let t = seg.from * SR; t < seg.to * SR; t += period, beatNo++) {
    const start = Math.floor(t);
    const accent = beatNo % 4 === 0 ? 1.0 : 0.6; // downbeat accent -> 4/4
    // Short decaying low-freq thump (~90 Hz) = kick feel.
    for (let i = 0; i < 2000 && start + i < N; i++) {
      const env = Math.exp(-i / 1200);
      data[start + i] += accent * env * Math.sin((2 * Math.PI * 90 * i) / SR) * 0.8;
    }
  }
}

// Write 16-bit PCM WAV.
const numSamples = N;
const buf = Buffer.alloc(44 + numSamples * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + numSamples * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(numSamples * 2, 40);
for (let i = 0; i < numSamples; i++) {
  let s = Math.max(-1, Math.min(1, data[i]));
  buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
}
fs.writeFileSync(process.argv[2] || 'test/test-tone.wav', buf);
console.log('wrote', (44 + numSamples * 2), 'bytes');
