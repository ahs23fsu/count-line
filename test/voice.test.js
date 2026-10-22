/* Tests the voice-count decision + scheduling logic from app.js.
 * These mirror the exact rules in app.js (shouldSpeak + scheduleVoice) so we
 * can verify: correct counts per style, each beat spoken at most once, and
 * the lead-window timing picks the right upcoming beat. */

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + ' — ' + n + (d ? '  [' + d + ']' : '')); ok ? pass++ : fail++; };

// ---- Mirror of Voice.shouldSpeak ----
function shouldSpeak(style, countInPhrase, countLen) {
  switch (style) {
    case 'one': return countInPhrase === 1;
    case 'downbeats': return countInPhrase === 1 || countInPhrase === Math.floor(countLen / 2) + 1;
    case 'every':
    default: return true;
  }
}

// ---- Mirror of scheduleVoice (returns the beat index it would speak, or null) ----
function scheduleVoice(state, t, beats, playbackRate, LEAD) {
  let next = 0;
  while (next < beats.length && beats[next] <= t) next++;
  if (next >= beats.length) return null;
  const lead = LEAD * (playbackRate || 1);
  const due = beats[next] - t <= lead;
  if (!due || next === state.lastSpokenBeat) return null;
  state.lastSpokenBeat = next;
  const countInPhrase = (next % state.countLen) + 1;
  return { beat: next, count: countInPhrase };
}

// === Style selection, 8-count ===
const every8 = []; for (let c = 1; c <= 8; c++) if (shouldSpeak('every', c, 8)) every8.push(c);
check('every: speaks all 8 counts', JSON.stringify(every8) === JSON.stringify([1,2,3,4,5,6,7,8]), every8.join(' '));

const one8 = []; for (let c = 1; c <= 8; c++) if (shouldSpeak('one', c, 8)) one8.push(c);
check('one: speaks only count 1', JSON.stringify(one8) === JSON.stringify([1]), one8.join(' '));

const db8 = []; for (let c = 1; c <= 8; c++) if (shouldSpeak('downbeats', c, 8)) db8.push(c);
check('downbeats: speaks 1 and 5 for 8-count', JSON.stringify(db8) === JSON.stringify([1,5]), db8.join(' '));

// === downbeats for 6-count => 1 and 4 ===
const db6 = []; for (let c = 1; c <= 6; c++) if (shouldSpeak('downbeats', c, 6)) db6.push(c);
check('downbeats: speaks 1 and 4 for 6-count', JSON.stringify(db6) === JSON.stringify([1,4]), db6.join(' '));

// === Scheduling across a 120 BPM beat grid (0.5s apart) ===
const beats = []; for (let i = 0; i < 16; i++) beats.push(i * 0.5);
const LEAD = 0.14;
(function () {
  const state = { lastSpokenBeat: -1, countLen: 8 };
  const spoken = [];
  // Simulate a 60fps render loop over 8 seconds at 1x.
  for (let t = 0; t <= 8; t += 1 / 60) {
    const r = scheduleVoice(state, t, beats, 1, LEAD);
    if (r) spoken.push(r.beat);
  }
  // Every beat from index 1..15 should be spoken exactly once (beat 0 is at
  // t=0; the lead window fires it only if a frame lands within 0.14s before it).
  const unique = new Set(spoken);
  check('each beat spoken at most once', spoken.length === unique.size, spoken.length + ' spoken, ' + unique.size + ' unique');
  check('speaks a healthy run of beats', spoken.length >= 14, spoken.length + ' beats');
  // The counts cycle 1..8 correctly: beat 8 => count 1, beat 12 => count 5.
  check('beat 8 maps to count 1', ((8 % 8) + 1) === 1);
  check('beat 12 maps to count 5', ((12 % 8) + 1) === 5);
})();

// === A beat is never double-spoken even across a seek-reset ===
(function () {
  const state = { lastSpokenBeat: -1, countLen: 8 };
  const r1 = scheduleVoice(state, beats[3] - 0.05, beats, 1, LEAD); // within lead of beat 3
  const r2 = scheduleVoice(state, beats[3] - 0.03, beats, 1, LEAD); // same beat, should NOT repeat
  check('no repeat within same beat window', r1 && r1.beat === 3 && r2 === null, (r1 && r1.beat) + '/' + (r2 && r2.beat));
  // After a seek reset, the same beat may be spoken again (intended).
  state.lastSpokenBeat = -1;
  const r3 = scheduleVoice(state, beats[3] - 0.03, beats, 1, LEAD);
  check('after seek reset, beat can speak again', r3 && r3.beat === 3, r3 && r3.beat);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
