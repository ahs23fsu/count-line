/* ============================================================
 * CountLine — Audio Analyzer
 * Pure in-browser beat + tempo analysis using the Web Audio API.
 *
 * Pipeline:
 *   1. Decode audio -> mono samples
 *   2. Onset envelope via short-time energy flux (low-frequency biased
 *      so it locks to the kick/snare pulse dancers feel)
 *   3. Global tempo estimate + a windowed tempo PROFILE (autocorrelation)
 *   4. Greedy, tempo-adaptive beat tracking whose period band follows the
 *      profile, so it stays locked through accelerandos / ritardandos
 *   5. Group beats into bars, infer time signature, derive counts
 *   6. Detect tempo-change regions (where local BPM shifts)
 * ============================================================ */
(function (global) {
  'use strict';

  const HOP = 512;          // analysis hop size in samples
  const FRAME = 1024;       // analysis frame size
  const TARGET_SR = 22050;  // downsample target for speed

  // Yield to the event loop so the browser can repaint the progress UI and
  // stay responsive. Without this the whole analysis blocks the main thread
  // and a phone shows a frozen screen (or kills the tab).
  const nextTick = () => new Promise((r) => setTimeout(r, 0));

  /** Public entry point. Returns a Promise<AnalysisResult>. */
  async function analyze(arrayBuffer, onProgress) {
    const report = async (p, msg) => { if (onProgress) onProgress(p, msg); await nextTick(); };

    await report(0.05, 'Decoding audio…');
    const audioBuf = await decode(arrayBuffer);
    const sr = audioBuf.sampleRate;

    await report(0.25, 'Preparing signal…');
    const mono = toMono(audioBuf);
    const { data: sig, sr: dsr } = downsample(mono, sr, TARGET_SR);

    await report(0.4, 'Finding onsets…');
    const { envelope, envSr } = await onsetEnvelope(sig, dsr, onProgress);

    await report(0.6, 'Estimating tempo…');
    const bpm = estimateTempo(envelope, envSr);
    // A tempo PROFILE (BPM estimated in overlapping windows) so the tracker's
    // allowed period follows songs that speed up or slow down.
    const tempoProfile = await tempoProfileOf(envelope, envSr);

    await report(0.75, 'Tracking beats…');
    const beats = trackBeats(envelope, envSr, bpm, tempoProfile);

    await report(0.9, 'Mapping the song…');
    const localBpms = localTempi(beats);
    const tempoChanges = detectTempoChanges(beats, localBpms);
    const { beatsPerBar, defaultCount } = inferMeter(bpm, beats, envelope, envSr);

    await report(1, 'Done');
    return {
      duration: audioBuf.duration,
      bpm: Math.round(bpm),
      beats,              // array of beat times (seconds)
      localBpms,          // per-beat local BPM
      tempoChanges,       // [{time, fromBpm, toBpm, beatIndex}]
      beatsPerBar,        // inferred (4 for 4/4, 3 for 3/4, etc.)
      defaultCount,       // 8, 6, or 4 — the natural count length
    };
  }

  /* ---------- 1. Decode ----------
   * Mobile-hardened: resume a possibly-suspended context (iOS/Safari starts
   * suspended), support both the promise and callback forms of
   * decodeAudioData, and time out so a stuck decode can never hang the app
   * silently.
   */
  function decode(arrayBuffer) {
    const Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return Promise.reject(new Error('This browser has no Web Audio support.'));
    const ctx = new Ctx();
    const done = (fn) => { try { ctx.close && ctx.close(); } catch (_) {} fn(); };

    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (buf) => { if (settled) return; settled = true; done(() => resolve(buf)); };
      const fail = (err) => { if (settled) return; settled = true; done(() => reject(err || new Error('Could not decode this audio file.'))); };

      // Safety net: never hang forever.
      const timer = setTimeout(() => fail(new Error('Decoding took too long — the file may be corrupt or in an unsupported format.')), 25000);
      const clear = (f) => (x) => { clearTimeout(timer); f(x); };

      // Resume first (no-op where unsupported / already running).
      Promise.resolve(ctx.resume && ctx.resume()).catch(() => {}).then(() => {
        let ret;
        try {
          ret = ctx.decodeAudioData(arrayBuffer.slice(0), clear(ok), clear(fail));
        } catch (e) { return clear(fail)(e); }
        // Promise-based form (modern browsers) resolves here too.
        if (ret && typeof ret.then === 'function') ret.then(clear(ok), clear(fail));
      });
    });
  }

  /* ---------- 2. Mono + downsample ---------- */
  function toMono(buf) {
    const ch = buf.numberOfChannels;
    const n = buf.length;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  function downsample(data, srIn, srOut) {
    if (srOut >= srIn) return { data, sr: srIn };
    const ratio = srIn / srOut;
    const n = Math.floor(data.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.floor((i + 1) * ratio);
      let s = 0, c = 0;
      for (let j = start; j < end && j < data.length; j++) { s += data[j]; c++; }
      out[i] = c ? s / c : 0;
    }
    return { data: out, sr: srOut };
  }

  /* ---------- 3. Onset envelope (spectral flux, low-freq biased) ----------
   * This is the heaviest stage (an FFT per hop over the whole song), so it is
   * async and yields to the event loop every few thousand frames to keep the
   * UI responsive and the progress bar moving on mobile.
   */
  async function onsetEnvelope(sig, sr, onProgress) {
    const nFrames = Math.max(1, Math.floor((sig.length - FRAME) / HOP));
    const env = new Float32Array(nFrames);
    const window = hann(FRAME);
    const half = FRAME / 2;
    let prevMag = new Float32Array(half);
    const re = new Float32Array(FRAME);
    const im = new Float32Array(FRAME);
    const CHUNK = 2000; // frames between yields

    for (let f = 0; f < nFrames; f++) {
      const off = f * HOP;
      im.fill(0);
      for (let i = 0; i < FRAME; i++) re[i] = (sig[off + i] || 0) * window[i];
      fft(re, im);

      let flux = 0;
      for (let k = 1; k < half; k++) {
        const mag = Math.hypot(re[k], im[k]);
        // Weight lower frequencies more — the "pulse" dancers march to.
        const w = 1 + 2 * Math.max(0, 1 - k / (half * 0.35));
        const diff = mag - prevMag[k];
        if (diff > 0) flux += diff * w;
        prevMag[k] = mag;
      }
      env[f] = flux;

      if (f % CHUNK === CHUNK - 1) {
        if (onProgress) onProgress(0.4 + 0.18 * (f / nFrames), 'Finding onsets…');
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Normalize + light smoothing.
    normalize(env);
    const smoothed = movingAvg(env, 3);
    return { envelope: smoothed, envSr: sr / HOP };
  }

  /* ---------- 4a. Windowed tempo profile ----------
   * Estimate tempo in overlapping ~5s windows so the beat tracker can follow
   * sectional tempo changes instead of being pinned to one global average.
   * Returns { at(timeSec) -> bpm }.
   */
  async function tempoProfileOf(env, envSr) {
    const winSec = 5, hopSec = 1.5;
    const winN = Math.round(winSec * envSr);
    const hopN = Math.round(hopSec * envSr);
    const points = []; // {t, bpm}
    let w = 0;
    for (let start = 0; start + winN <= env.length || points.length === 0; start += hopN) {
      const seg = env.subarray(start, Math.min(env.length, start + winN));
      if (seg.length < envSr * 1.5) break;
      const bpm = estimateTempo(seg, envSr);
      points.push({ t: (start + winN / 2) / envSr, bpm });
      if (++w % 20 === 0) await new Promise((r) => setTimeout(r, 0)); // yield periodically
      if (start + winN >= env.length) break;
    }
    if (!points.length) points.push({ t: 0, bpm: estimateTempo(env, envSr) });
    // Light median smoothing to kill single-window outliers.
    const sm = points.map((p, i) => {
      const a = Math.max(0, i - 1), b = Math.min(points.length - 1, i + 1);
      const vals = points.slice(a, b + 1).map((x) => x.bpm).sort((x, y) => x - y);
      return { t: p.t, bpm: vals[Math.floor(vals.length / 2)] };
    });
    return {
      points: sm,
      at(timeSec) {
        if (sm.length === 1) return sm[0].bpm;
        if (timeSec <= sm[0].t) return sm[0].bpm;
        if (timeSec >= sm[sm.length - 1].t) return sm[sm.length - 1].bpm;
        for (let i = 1; i < sm.length; i++) {
          if (timeSec <= sm[i].t) {
            const a = sm[i - 1], b = sm[i];
            const f = (timeSec - a.t) / (b.t - a.t);
            return a.bpm + f * (b.bpm - a.bpm);
          }
        }
        return sm[sm.length - 1].bpm;
      },
    };
  }

  /* ---------- 4. Global tempo via autocorrelation ---------- */
  function estimateTempo(env, envSr, minBpm = 60, maxBpm = 200) {
    const minLag = Math.floor((60 / maxBpm) * envSr);
    const maxLag = Math.floor((60 / minBpm) * envSr);
    let best = minLag, bestScore = -Infinity;
    const scores = [];

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < env.length - lag; i++) sum += env[i] * env[i + lag];
      // Slight preference toward the center of the dance-tempo range.
      const bpmAtLag = 60 / (lag / envSr);
      const pref = 1 - 0.15 * Math.abs(Math.log2(bpmAtLag / 120));
      const score = sum * pref;
      scores.push({ lag, score });
      if (score > bestScore) { bestScore = score; best = lag; }
    }

    let bpm = 60 / (best / envSr);
    // Octave correction: fold into a comfortable dance range.
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    return bpm;
  }

  /* ---------- 5. Beat tracking (greedy + tempo-adaptive) ----------
   * The global BPM is only a STARTING hint. From each beat we predict the
   * next beat one local-period ahead and snap to the strongest onset inside
   * a tolerance window. The local period then eases toward the observed
   * interval, so the tracker FOLLOWS accelerandos / ritardandos instead of
   * forcing everything onto one rigid grid. That is what lets us surface the
   * tempo changes dancers struggle with.
   */
  function trackBeats(env, envSr, bpm, tempoProfile) {
    const n = env.length;
    if (n < 4) return [];
    const e = env;
    const globalP = (60 / bpm) * envSr;           // frames per beat at global tempo

    // Allowed period at a given frame is a tight band around the LOCAL tempo
    // from the profile, so the tracker follows sectional tempo changes while
    // never collapsing to half/double time.
    const localPeriodAt = (frame) => {
      const t = frame / envSr;
      const lbpm = tempoProfile ? tempoProfile.at(t) : bpm;
      return (60 / lbpm) * envSr;
    };
    const clampAt = (frame, p) => {
      const lp = localPeriodAt(frame);
      return Math.max(lp * 0.85, Math.min(lp * 1.15, p));
    };

    const step = (startF, dir) => {
      // dir = +1 forward, -1 backward. Returns array of beat frames (excl. start).
      const out = [];
      let last = startF;
      let locP = clampAt(startF, localPeriodAt(startF));
      while (true) {
        const predicted = last + dir * locP;
        if (predicted <= 0 || predicted >= n) break;
        const tol = Math.max(2, Math.round(locP * 0.16)); // tight window prevents double-tracking
        const lo = Math.max(1, Math.round(predicted - tol));
        const hi = Math.min(n - 1, Math.round(predicted + tol));
        let bestF = Math.round(predicted), bestScore = -Infinity;
        for (let f = lo; f <= hi; f++) {
          const dist = (f - predicted) / tol;
          const bias = 1 - 0.4 * dist * dist;     // prefer the predicted location
          const s = (e[f] || 0) * bias;
          if (s > bestScore) { bestScore = s; bestF = f; }
        }
        out.push(bestF);
        const observed = Math.abs(bestF - last);
        // Ease toward observed, then re-clamp to the band at the new position
        // so the period can migrate as the song's local tempo migrates.
        locP = clampAt(bestF, locP * 0.78 + observed * 0.22);
        last = bestF;
      }
      return out;
    };

    const anchor = firstStrongOnset(e, globalP);
    const fwd = step(anchor, +1);
    const back = step(anchor, -1).reverse();

    const all = back.concat([anchor], fwd);
    return all.map((f) => f / envSr);
  }

  function firstStrongOnset(e, period) {
    // Anchor on the strongest onset within the first ~2 beats.
    const limit = Math.min(e.length - 1, Math.round(period * 2));
    let bestF = Math.round(period), best = -Infinity;
    for (let f = 0; f <= limit; f++) if (e[f] > best) { best = e[f]; bestF = f; }
    return bestF;
  }

  /* ---------- 6. Local tempi + tempo-change detection ---------- */
  function localTempi(beats) {
    const bpms = [];
    for (let i = 0; i < beats.length; i++) {
      // Use a small window of inter-beat intervals for a stable local BPM.
      const a = Math.max(0, i - 2);
      const b = Math.min(beats.length - 1, i + 2);
      let sum = 0, c = 0;
      for (let k = a; k < b; k++) { const d = beats[k + 1] - beats[k]; if (d > 0.1 && d < 2) { sum += d; c++; } }
      bpms.push(c ? Math.round(60 / (sum / c)) : null);
    }
    return bpms;
  }

  function detectTempoChanges(beats, localBpms) {
    const changes = [];
    const THRESH = 8; // BPM jump that counts as a real tempo change
    let lastStable = firstValid(localBpms);
    for (let i = 4; i < localBpms.length - 2; i++) {
      const cur = localBpms[i];
      if (cur == null || lastStable == null) continue;
      if (Math.abs(cur - lastStable) >= THRESH) {
        // Confirm it's sustained, not a one-beat glitch.
        const ahead = localBpms.slice(i, i + 4).filter((x) => x != null);
        const avgAhead = ahead.reduce((s, x) => s + x, 0) / (ahead.length || 1);
        if (Math.abs(avgAhead - lastStable) >= THRESH) {
          changes.push({ time: beats[i], fromBpm: lastStable, toBpm: Math.round(avgAhead), beatIndex: i });
          lastStable = Math.round(avgAhead);
          i += 3;
        }
      }
    }
    return changes;
  }

  function firstValid(arr) { for (const x of arr) if (x != null) return x; return null; }

  /* ---------- 7. Meter / time-signature inference ---------- */
  function inferMeter(bpm, beats, env, envSr) {
    // Score how strongly beat positions group into bars of 3 vs 4.
    // We test which grouping puts the strongest onset energy on the downbeat.
    const strengthAt = (t) => {
      const f = Math.round(t * envSr);
      return (env[f] || 0) + (env[f - 1] || 0) + (env[f + 1] || 0);
    };
    function groupScore(per) {
      let best = -Infinity;
      for (let phase = 0; phase < per; phase++) {
        let downs = 0, others = 0, dc = 0, oc = 0;
        for (let i = 0; i < beats.length; i++) {
          const s = strengthAt(beats[i]);
          if ((i - phase) % per === 0) { downs += s; dc++; } else { others += s; oc++; }
        }
        const contrast = (dc ? downs / dc : 0) - (oc ? others / oc : 0);
        if (contrast > best) best = contrast;
      }
      return best;
    }
    const s4 = groupScore(4);
    const s3 = groupScore(3);
    // Pick 3/4 only when its downbeat contrast clearly beats 4/4 (strong bias
    // toward 4/4, since the overwhelming majority of majorette/dance music is
    // in 4 and a false 3/4 would mis-group every count).
    const beatsPerBar = s3 > s4 * 1.25 ? 3 : 4;
    const defaultCount = beatsPerBar === 3 ? 6 : 8; // 3/4 -> 6-count, 4/4 -> 8-count
    return { beatsPerBar, defaultCount };
  }

  /* ---------- DSP helpers ---------- */
  function hann(n) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))); return w; }
  function normalize(a) { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; if (m > 0) for (let i = 0; i < a.length; i++) a[i] /= m; }
  function movingAvg(a, r) { const out = new Float32Array(a.length); for (let i = 0; i < a.length; i++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < a.length) { s += a[j]; c++; } } out[i] = s / c; } return out; }

  /* In-place iterative radix-2 FFT (expects power-of-two length). */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = i + k + len / 2;
          const tr = re[b] * cwr - im[b] * cwi;
          const ti = re[b] * cwi + im[b] * cwr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr; cwr = ncwr;
        }
      }
    }
  }

  global.CountLineAnalyzer = { analyze };
})(window);
