# CountLine 🥁

**Count the music together.** A mobile-first web app that listens to your song and shows your dance team the counts — 8s, 6s, or 4s — and flags every tempo change so nobody falls off the beat.

Built for majorette lines and dance teams who rehearse to recordings with speed changes.

## What it does

- **Upload any song** (MP3 / WAV / M4A / OGG). Everything runs **in your browser** — nothing is uploaded to a server, so you can just share the link.
- **Finds the beat across the whole track**, not just one average BPM. It follows songs that speed up or slow down.
- **Auto-picks the count length from the time signature** — 4/4 → 8-count, 3/4 → 6-count — or you can override it (8 / 6 / 4 / 2).
- **Big synced count display** with dots showing where you are in the phrase, plus an optional flash on count 1.
- **Song map timeline** showing every phrase, with ⚡ markers wherever the tempo changes — your team's trouble spots at a glance.
- **Optional voice counts:** turn on 🔊 to hear the numbers called out over the music — rehearse without watching the screen. Choose **every count**, **just 1**, or **1 & 5**. Off by default; toggle any time.
- **Rehearsal controls:** jump back/forward one full count, and slow playback to 0.5× / 0.75× without losing the counts.
- **Export a printable count sheet** (`.txt`) to hand out to the whole line.

## How to use

1. Open `index.html` (or host the folder anywhere static — GitHub Pages, Netlify, etc.) and share the link.
2. Tap **Upload your song** and pick an MP3.
3. Wait a few seconds while it analyzes, then press **▶**. Count along!

## Hosting / sharing with your team

This is a plain static site (`index.html`, `styles.css`, `app.js`, `audio-analyzer.js`). Host it anywhere that serves static files and send your team the link. No login, no backend, no install.

## How the counting works (the technical bit)

The engine (`audio-analyzer.js`) uses only the Web Audio API — no libraries:

1. **Decode** the file and mix to mono, downsampled for speed.
2. **Onset envelope** via short-time spectral flux, weighted toward low frequencies so it locks onto the kick/snare pulse dancers actually feel.
3. **Tempo estimate** via autocorrelation, plus a **windowed tempo profile** (BPM measured in overlapping ~5s windows).
4. **Beat tracking** predicts each next beat and snaps to the strongest nearby onset, with its period band tied to the local tempo profile — so it follows tempo changes instead of forcing one rigid grid.
5. **Meter inference** groups beats into bars (strong downbeat test) to choose 8- vs 6-count.
6. **Tempo-change detection** flags sections where the local BPM shifts.

## Tests

Run the suite with Node (no browser needed):

```bash
node test/dsp.test.js        # DSP unit tests (FFT, tempo, beat tracking, meter)
node test/make-wav.js test/test-tone.wav   # regenerate the test fixture
node test/pipeline.test.js   # full analyze() pipeline against a real WAV
node test/logic.test.js      # count-grouping / phrasing logic
node test/voice.test.js      # voice-count style + scheduling logic
```

All suites pass (36 checks), including detection of a synthetic 100→140 BPM tempo change.

## Notes & limits

- Beat detection is strongest on music with a clear, steady pulse (most majorette/dance tracks). Very rubato or beatless intros may need a second to lock on.
- Count 1 is placed on the strongest downbeat the analyzer finds; if your choreography starts on a different beat, use **⟲ / ⟳** to nudge to your phrase start.
