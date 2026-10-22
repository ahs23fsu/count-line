/* ============================================================
 * CountLine — App Controller
 * Wires analysis results to playback, the synced count display,
 * the song-map timeline, transport, options, and export.
 * ============================================================ */
(function () {
  'use strict';

  // ---------- State ----------
  const S = {
    audio: new Audio(),
    objectUrl: null,
    result: null,          // AnalysisResult from the analyzer
    countLen: 8,           // active count length (8/6/4/2)
    beatStep: 1,           // 1 = normal, 2 = half-time (count every other beat)
    autoMode: true,        // whether count length follows the time signature
    phrases: [],           // [{start, beats:[t,...]}] grouped by count length
    raf: 0,
    fileName: 'Your song',
    flash: true,
    voice: false,          // speak counts out loud
    voiceStyle: 'every',   // 'every' | 'one' | 'downbeats'
    voiceReady: false,     // speech unlocked by a user gesture (mobile)
    lastSpokenBeat: -1,    // guard so we never speak the same beat twice
  };

  // ---------- Elements ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    uploadScreen: $('uploadScreen'), counterScreen: $('counterScreen'),
    dropZone: $('dropZone'), fileInput: $('fileInput'),
    selectedFile: $('selectedFile'),
    analyzeStatus: $('analyzeStatus'), analyzeStatusText: $('analyzeStatusText'),
    uploadError: $('uploadError'),
    songTitle: $('songTitle'), chipBpm: $('chipBpm'), chipSig: $('chipSig'), chipCount: $('chipCount'),
    newSongBtn: $('newSongBtn'),
    countStage: $('countStage'), phraseLabel: $('phraseLabel'), bigCount: $('bigCount'),
    countDots: $('countDots'), tempoFlag: $('tempoFlag'),
    timeline: $('timeline'), phraseCountLabel: $('phraseCountLabel'),
    curTime: $('curTime'), totTime: $('totTime'),
    back8Btn: $('back8Btn'), playBtn: $('playBtn'), fwd8Btn: $('fwd8Btn'),
    countModeSel: $('countModeSel'), feelSel: $('feelSel'), speedSel: $('speedSel'), flashToggle: $('flashToggle'),
    voiceToggle: $('voiceToggle'), voiceOptRow: $('voiceOptRow'), voiceStyleSel: $('voiceStyleSel'),
    exportBtn: $('exportBtn'),
    helpBtn: $('helpBtn'), helpModal: $('helpModal'), closeHelp: $('closeHelp'),
  };

  // ============================================================
  // Upload + analysis
  // ============================================================
  // The drop zone is a plain button that opens the (separate) file input. The
  // input is NOT wrapped in a label, so there is no double-trigger — a past
  // bug where the picker fired twice and cancelled the selection on mobile.
  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); } });
  el.fileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
    // Reset so picking the SAME file again still fires 'change'.
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => el.dropZone.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => el.dropZone.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.remove('drag'); }));
  el.dropZone.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });

  async function handleFile(file) {
    el.uploadError.hidden = true;

    // Immediate on-screen confirmation that the file was received — so there's
    // never a "nothing happened" moment after picking from the library.
    el.selectedFile.textContent = '♪ ' + file.name;
    el.selectedFile.hidden = false;

    // Accept by MIME *or* extension, but also accept anything the browser
    // couldn't classify (mobile pickers often report an empty type / generic
    // name). We only hard-reject files that clearly declare a non-audio type.
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    const looksAudio = /audio|mpeg|mp3|wav|m4a|aac|ogg|oga|flac|x-/i.test(type) ||
      /\.(mp3|wav|m4a|aac|ogg|oga|flac|aiff?|caf)$/i.test(name);
    const clearlyNotAudio = /^(image|video|text|application)\//.test(type) && !/ogg|mpeg/.test(type);
    if (!looksAudio && clearlyNotAudio) {
      return showError('That looks like a ' + type.split('/')[0] + ' file, not audio. Pick an MP3, M4A, or WAV.');
    }

    el.analyzeStatus.hidden = false;
    el.analyzeStatusText.textContent = 'Reading file…';
    el.dropZone.style.opacity = '.5';
    el.dropZone.style.pointerEvents = 'none';
    S.fileName = file.name.replace(/\.[^.]+$/, '') || 'Your song';

    try {
      const buf = await file.arrayBuffer();
      if (!buf || buf.byteLength === 0) {
        throw new Error('That file came through empty. Try downloading it to your device first, then upload.');
      }
      // Hard overall timeout so a stuck analysis surfaces as a message instead
      // of a frozen, actionless screen.
      const analysis = CountLineAnalyzer.analyze(buf, (p, msg) => {
        el.analyzeStatusText.textContent = msg + ' ' + Math.round(p * 100) + '%';
      });
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Analysis timed out. Try a shorter clip or a different file.')), 60000));
      const result = await Promise.race([analysis, timeout]);
      if (!result.beats || result.beats.length < 4) throw new Error('Couldn\u2019t find a steady beat in this track.');

      S.result = result;
      if (S.objectUrl) URL.revokeObjectURL(S.objectUrl);
      S.objectUrl = URL.createObjectURL(file);
      S.audio.src = S.objectUrl;

      setupSong();
      showCounter();
    } catch (err) {
      console.error(err);
      showError((err && err.message) || 'Something went wrong analyzing that file.');
    } finally {
      el.analyzeStatus.hidden = true;
      el.dropZone.style.opacity = '';
      el.dropZone.style.pointerEvents = '';
    }
  }

  function showError(msg) {
    el.uploadError.textContent = msg;
    el.uploadError.hidden = false;
    el.selectedFile.hidden = true;
    // Make sure the drop zone is usable again after a failure.
    el.dropZone.style.opacity = '';
    el.dropZone.style.pointerEvents = '';
    el.analyzeStatus.hidden = true;
  }

  // ============================================================
  // Song setup
  // ============================================================
  function setupSong() {
    const r = S.result;
    S.autoMode = el.countModeSel.value === 'auto';
    S.countLen = S.autoMode ? r.defaultCount : parseInt(el.countModeSel.value, 10);
    S.beatStep = parseInt(el.feelSel.value, 10) || 1;   // honour the chosen feel

    el.songTitle.textContent = S.fileName;
    el.chipSig.textContent = r.beatsPerBar === 3 ? '3/4' : '4/4';
    el.totTime.textContent = fmt(r.duration);
    el.speedSel.value = '1';
    S.audio.playbackRate = 1;

    buildPhrases();
    el.chipBpm.textContent = S.beatStep > 1
      ? r.bpm + ' BPM · count ' + Math.round(r.bpm / S.beatStep)
      : r.bpm + ' BPM';
    el.chipCount.textContent = S.countLen + '-count' + (S.beatStep > 1 ? ' (½-time)' : '');
    buildTimeline();
    render(0);
  }

  // The beats we actually COUNT on. In half-time (beatStep = 2) we count on
  // every other musical beat, so a count "1" lands on beats 1, 3, 5… — the
  // standard way to count a fast song at a marchable, half-speed pace while
  // still phrasing it in 8s. All counting (display, phrases, timeline, voice,
  // export) derives from this one list, so half-time stays consistent.
  function countBeats() {
    const all = S.result.beats;
    if (S.beatStep <= 1) return all;
    const out = [];
    for (let i = 0; i < all.length; i += S.beatStep) out.push(all[i]);
    return out;
  }

  // Group the active count-beats into phrases of the active count length.
  function buildPhrases() {
    const beats = countBeats();
    S.phrases = [];
    for (let i = 0; i < beats.length; i += S.countLen) {
      const slice = beats.slice(i, i + S.countLen);
      if (slice.length) S.phrases.push({ start: slice[0], beats: slice });
    }
    const htLabel = S.beatStep > 1 ? ' · half-time' : '';
    el.phraseCountLabel.textContent = S.phrases.length + ' \u00d7 ' + S.countLen + '-counts' + htLabel;
  }

  // ============================================================
  // Timeline (song map)
  // ============================================================
  function buildTimeline() {
    const r = S.result;
    const dur = r.duration;
    el.timeline.innerHTML = '';

    // Phrase blocks (alternating shade) with every 4th phrase numbered.
    S.phrases.forEach((ph, i) => {
      const next = S.phrases[i + 1] ? S.phrases[i + 1].start : dur;
      const left = (ph.start / dur) * 100;
      const width = ((next - ph.start) / dur) * 100;
      const block = document.createElement('div');
      block.className = 'tl-phrase' + (i % 2 ? ' alt' : '');
      block.style.left = left + '%';
      block.style.width = width + '%';
      el.timeline.appendChild(block);
      if (i % 4 === 0) {
        const num = document.createElement('div');
        num.className = 'tl-num';
        num.style.left = left + '%';
        num.textContent = i + 1;
        el.timeline.appendChild(num);
      }
    });

    // Tempo-change markers.
    r.tempoChanges.forEach((tc) => {
      const m = document.createElement('div');
      m.className = 'tl-tempo';
      m.style.left = (tc.time / dur) * 100 + '%';
      m.title = `Tempo change: ${tc.fromBpm} \u2192 ${tc.toBpm} BPM`;
      el.timeline.appendChild(m);
    });

    // Progress + playhead.
    const prog = document.createElement('div'); prog.className = 'tl-progress'; prog.id = 'tlProgress';
    const head = document.createElement('div'); head.className = 'tl-playhead'; head.id = 'tlPlayhead';
    el.timeline.appendChild(prog); el.timeline.appendChild(head);
  }

  el.timeline.addEventListener('click', (e) => {
    const rect = el.timeline.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    S.audio.currentTime = Math.max(0, Math.min(1, pct)) * S.result.duration;
    S.lastSpokenBeat = -1;          // re-sync voice after a seek
    render(S.audio.currentTime);
  });

  // ============================================================
  // Voice counts (Web Speech API)
  // ------------------------------------------------------------
  // Built-in browser TTS — no audio files, works offline, so the app stays a
  // single shareable link. We schedule each count slightly AHEAD of its beat
  // and cancel-then-speak so the number lands on the beat instead of lagging
  // behind the synth's startup latency.
  // ============================================================
  const Voice = (function () {
    const supported = 'speechSynthesis' in window;
    const synth = supported ? window.speechSynthesis : null;
    let preferredVoice = null;

    // Spoken slightly before the beat to offset TTS startup latency (seconds
    // of *song* time; scaled by playback rate when scheduling).
    const LEAD = 0.14;

    function pickVoice() {
      if (!supported) return;
      const voices = synth.getVoices();
      if (!voices.length) return;
      // Prefer a clear English voice; fall back to the first available.
      preferredVoice =
        voices.find((v) => /en[-_]US/i.test(v.lang) && /female|samantha|zira|google/i.test(v.name)) ||
        voices.find((v) => /^en/i.test(v.lang)) ||
        voices[0];
    }
    if (supported) {
      pickVoice();
      // Voice list loads async on some browsers.
      synth.addEventListener && synth.addEventListener('voiceschanged', pickVoice);
    }

    // Unlock speech on a user gesture (required on iOS/Safari & mobile Chrome).
    function unlock() {
      if (!supported || S.voiceReady) return;
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0; // silent primer
        synth.speak(u);
        S.voiceReady = true;
      } catch (_) { /* ignore */ }
    }

    function say(text) {
      if (!supported) return;
      const u = new SpeechSynthesisUtterance(text);
      if (preferredVoice) u.voice = preferredVoice;
      u.rate = 1.35;   // brisk so the number fits inside one beat
      u.pitch = 1.0;
      u.volume = 1.0;
      // Don't let a backlog build up if beats come fast.
      if (synth.speaking || synth.pending) synth.cancel();
      synth.speak(u);
    }

    // Decide whether a given count should be spoken for the current style.
    function shouldSpeak(countInPhrase, countLen) {
      switch (S.voiceStyle) {
        case 'one': return countInPhrase === 1;
        case 'downbeats':
          // "1 and 5" for 8-counts; the 1 and the midpoint for others.
          return countInPhrase === 1 || countInPhrase === Math.floor(countLen / 2) + 1;
        case 'every':
        default: return true;
      }
    }

    function stop() { if (supported) synth.cancel(); }

    return { supported, unlock, say, shouldSpeak, stop, get lead() { return LEAD; } };
  })();

  // ============================================================
  // Playback + render loop
  // ============================================================
  el.playBtn.addEventListener('click', togglePlay);
  function togglePlay() {
    if (S.audio.paused) {
      Voice.unlock();                       // must happen inside the tap gesture
      S.lastSpokenBeat = -1;
      S.audio.play(); el.playBtn.textContent = '❚❚'; loop();
    } else {
      S.audio.pause(); el.playBtn.textContent = '▶'; cancelAnimationFrame(S.raf); Voice.stop();
    }
  }
  S.audio.addEventListener('ended', () => { el.playBtn.textContent = '▶'; cancelAnimationFrame(S.raf); Voice.stop(); });

  function loop() { render(S.audio.currentTime); S.raf = requestAnimationFrame(loop); }

  let lastBeatIdx = -1;
  function render(t) {
    const r = S.result; if (!r) return;

    // Which count-beat are we on? (honours half-time)
    const beats = countBeats();
    let bi = 0;
    while (bi < beats.length - 1 && beats[bi + 1] <= t) bi++;
    if (t < beats[0]) bi = -1;

    // Position within the current phrase.
    const phraseIdx = bi < 0 ? 0 : Math.floor(bi / S.countLen);
    const countInPhrase = bi < 0 ? 0 : (bi % S.countLen) + 1;

    el.bigCount.textContent = bi < 0 ? '–' : countInPhrase;
    el.phraseLabel.textContent = S.countLen + '-count ' + (phraseIdx + 1);

    // Dots.
    renderDots(countInPhrase);

    // Beat-change effects (flash on count 1).
    if (bi !== lastBeatIdx) {
      lastBeatIdx = bi;
      const onOne = countInPhrase === 1 && bi >= 0;
      el.countStage.classList.toggle('on-one', onOne);
      if (S.flash && onOne) {
        el.countStage.classList.add('flash');
        setTimeout(() => el.countStage.classList.remove('flash'), 120);
      }
    }

    // Voice counts: look slightly ahead and speak the NEXT beat so the number
    // lands on the beat rather than after it.
    if (S.voice && Voice.supported && !S.audio.paused) scheduleVoice(t, beats);

    // Tempo-change flag when near a change point.
    const nearTempo = r.tempoChanges.some((tc) => Math.abs(tc.time - t) < 1.2);
    el.tempoFlag.hidden = !nearTempo;

    // Timeline progress.
    const pct = (t / r.duration) * 100;
    const prog = $('tlProgress'), head = $('tlPlayhead');
    if (prog) prog.style.width = pct + '%';
    if (head) head.style.left = pct + '%';
    el.curTime.textContent = fmt(t);
  }

  function renderDots(active) {
    if (el.countDots.children.length !== S.countLen) {
      el.countDots.innerHTML = '';
      for (let i = 0; i < S.countLen; i++) {
        const d = document.createElement('div');
        d.className = 'dot' + (i === 0 ? ' one' : '');
        el.countDots.appendChild(d);
      }
    }
    [...el.countDots.children].forEach((d, i) => d.classList.toggle('on', i + 1 === active));
  }

  // Speak the upcoming count when we're within the lead window of its beat.
  // Guarded by lastSpokenBeat so each beat is spoken at most once.
  function scheduleVoice(t, beats) {
    // Find the next beat at or after the current time.
    let next = 0;
    while (next < beats.length && beats[next] <= t) next++;
    if (next >= beats.length) return;

    // Scale the lead by playback rate (slower playback => more song-time lead
    // is fine; the perceived gap stays constant).
    const lead = Voice.lead * (S.audio.playbackRate || 1);
    const due = beats[next] - t <= lead;
    if (!due || next === S.lastSpokenBeat) return;

    S.lastSpokenBeat = next;
    const countInPhrase = (next % S.countLen) + 1;
    if (Voice.shouldSpeak(countInPhrase, S.countLen)) {
      Voice.say(String(countInPhrase));
    }
  }

  // ---------- Transport jumps (one phrase) ----------
  el.fwd8Btn.addEventListener('click', () => jumpPhrase(1));
  el.back8Btn.addEventListener('click', () => jumpPhrase(-1));
  function jumpPhrase(dir) {
    const t = S.audio.currentTime;
    let idx = S.phrases.findIndex((p, i) => {
      const next = S.phrases[i + 1] ? S.phrases[i + 1].start : Infinity;
      return t >= p.start && t < next;
    });
    if (idx < 0) idx = 0;
    const target = Math.max(0, Math.min(S.phrases.length - 1, idx + dir));
    S.audio.currentTime = S.phrases[target].start;
    S.lastSpokenBeat = -1;          // re-sync voice after a jump
    render(S.audio.currentTime);
  }

  // Keep count labels on the transport buttons in sync with count length.
  function syncTransportLabels() {
    el.back8Btn.textContent = '⟲ ' + S.countLen;
    el.fwd8Btn.textContent = S.countLen + ' ⟳';
  }

  // ============================================================
  // Options
  // ============================================================
  // Rebuild everything that depends on the active count beats (count length
  // and half-time), then re-render at the current position.
  function rebuildCounts() {
    el.chipCount.textContent = S.countLen + '-count' + (S.beatStep > 1 ? ' (½-time)' : '');
    // Show the count tempo too: half-time counts at half the song's BPM.
    const countBpm = Math.round(S.result.bpm / S.beatStep);
    el.chipBpm.textContent = S.beatStep > 1
      ? S.result.bpm + ' BPM · count ' + countBpm
      : S.result.bpm + ' BPM';
    buildPhrases();
    buildTimeline();
    syncTransportLabels();
    lastBeatIdx = -1;
    S.lastSpokenBeat = -1;          // counting changed → re-evaluate voice
    render(S.audio.currentTime);
  }

  el.countModeSel.addEventListener('change', () => {
    const v = el.countModeSel.value;
    S.autoMode = v === 'auto';
    S.countLen = S.autoMode ? S.result.defaultCount : parseInt(v, 10);
    rebuildCounts();
  });

  el.feelSel.addEventListener('change', () => {
    S.beatStep = parseInt(el.feelSel.value, 10) || 1;
    rebuildCounts();
  });

  el.speedSel.addEventListener('change', () => { S.audio.playbackRate = parseFloat(el.speedSel.value); });
  el.flashToggle.addEventListener('change', () => { S.flash = el.flashToggle.checked; });

  // Voice toggle + style.
  el.voiceToggle.addEventListener('change', () => {
    if (el.voiceToggle.checked && !Voice.supported) {
      el.voiceToggle.checked = false;
      alert('Sorry — this browser doesn\u2019t support spoken counts. Try Chrome or Safari.');
      return;
    }
    S.voice = el.voiceToggle.checked;
    el.voiceOptRow.hidden = !S.voice;
    S.lastSpokenBeat = -1;
    if (S.voice) Voice.unlock();      // the checkbox tap is a valid gesture to unlock
    else Voice.stop();
  });
  el.voiceStyleSel.addEventListener('change', () => { S.voiceStyle = el.voiceStyleSel.value; S.lastSpokenBeat = -1; });

  // ============================================================
  // Export count sheet
  // ============================================================
  el.exportBtn.addEventListener('click', exportSheet);
  function exportSheet() {
    const r = S.result;
    const lines = [];
    lines.push('CountLine — Count Sheet');
    lines.push('Song: ' + S.fileName);
    const feel = S.beatStep > 1 ? '   Feel: HALF-TIME (count ' + Math.round(r.bpm / S.beatStep) + ' BPM)' : '';
    lines.push(`Tempo: ${r.bpm} BPM   Time: ${r.beatsPerBar === 3 ? '3/4' : '4/4'}   Counting in ${S.countLen}s${feel}`);
    lines.push(`Length: ${fmt(r.duration)}   Phrases: ${S.phrases.length}`);
    lines.push(''.padEnd(48, '='));
    lines.push('');

    S.phrases.forEach((ph, i) => {
      // Flag a phrase that contains a tempo change. tempoChanges use raw beat
      // indices, so scale phrase bounds back to raw beats by beatStep.
      const loRaw = i * S.countLen * S.beatStep;
      const hiRaw = (i + 1) * S.countLen * S.beatStep;
      const tc = r.tempoChanges.find((c) => c.beatIndex >= loRaw && c.beatIndex < hiRaw);
      let line = String(i + 1).padStart(3, ' ') + '.  ' + fmt(ph.start) + '   ' +
        ph.beats.map((_, k) => k + 1).join(' ');
      if (tc) line += `   <<< TEMPO CHANGE: ${tc.fromBpm} -> ${tc.toBpm} BPM`;
      lines.push(line);
    });

    if (r.tempoChanges.length) {
      lines.push('');
      lines.push('Tempo changes:');
      r.tempoChanges.forEach((tc) => lines.push(`  ${fmt(tc.time)}  phrase ${Math.floor(tc.beatIndex / S.countLen) + 1}: ${tc.fromBpm} -> ${tc.toBpm} BPM`));
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = S.fileName + ' — count sheet.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ============================================================
  // Screen + modal control
  // ============================================================
  function showCounter() {
    el.uploadScreen.classList.remove('active');
    el.counterScreen.classList.add('active');
    syncTransportLabels();
    window.scrollTo(0, 0);
  }
  el.newSongBtn.addEventListener('click', () => {
    S.audio.pause(); cancelAnimationFrame(S.raf); el.playBtn.textContent = '▶';
    Voice.stop(); S.lastSpokenBeat = -1;
    el.counterScreen.classList.remove('active');
    el.uploadScreen.classList.add('active');
    el.fileInput.value = '';
  });

  el.helpBtn.addEventListener('click', () => { el.helpModal.hidden = false; });
  el.closeHelp.addEventListener('click', () => { el.helpModal.hidden = true; });
  el.helpModal.addEventListener('click', (e) => { if (e.target === el.helpModal) el.helpModal.hidden = true; });

  // ---------- Util ----------
  function fmt(sec) { sec = Math.max(0, sec || 0); const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return m + ':' + String(s).padStart(2, '0'); }
})();
