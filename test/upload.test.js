/* Regression tests for the file-upload entry point.
 * Covers the two bugs behind "pick a file, bounce back to home with nothing":
 *   1. The <input> must NOT be wrapped in the drop-zone <label> (that caused a
 *      double file-picker trigger that cancelled the selection on mobile).
 *   2. The accept/reject decision must allow real mobile files (empty MIME,
 *      odd names) and only hard-reject clearly non-audio types. */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + ' — ' + n + (d ? '  [' + d + ']' : '')); ok ? pass++ : fail++; };

// ---- 1. Structural: input is not inside the drop-zone label ----
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
check('drop zone is a div, not a label', /<div id="dropZone"[^>]*class="drop-zone"/.test(html), 'div#dropZone');
check('drop zone is NOT a <label>', !/<label id="dropZone"/.test(html));
// The file input should exist as a sibling, not nested inside #dropZone.
const dropBlock = html.slice(html.indexOf('id="dropZone"'), html.indexOf('id="fileInput"'));
check('file input is outside the drop zone element', !/<input id="fileInput"/.test(dropBlock));
check('selected-file confirmation element exists', /id="selectedFile"/.test(html));

// ---- 2. Behavioral: mirror of the accept/reject decision in app.js ----
function accepts(fileName, fileType) {
  const name = (fileName || '').toLowerCase();
  const type = (fileType || '').toLowerCase();
  const looksAudio = /audio|mpeg|mp3|wav|m4a|aac|ogg|oga|flac|x-/i.test(type) ||
    /\.(mp3|wav|m4a|aac|ogg|oga|flac|aiff?|caf)$/i.test(name);
  const clearlyNotAudio = /^(image|video|text|application)\//.test(type) && !/ogg|mpeg/.test(type);
  return !(!looksAudio && clearlyNotAudio);
}

// Should accept — normal and awkward mobile cases.
check('accepts standard mp3', accepts('song.mp3', 'audio/mpeg'));
check('accepts m4a (Apple)', accepts('track.m4a', 'audio/x-m4a'));
check('accepts wav', accepts('clip.wav', 'audio/wav'));
check('accepts empty MIME with audio extension', accepts('routine.m4a', ''));
check('accepts empty MIME AND odd name (iOS reference)', accepts('audio', ''));
check('accepts aac', accepts('beat.aac', 'audio/aac'));
check('accepts flac', accepts('hifi.flac', ''));

// Should reject — clearly the wrong kind of file.
check('rejects a JPEG image', !accepts('photo.jpg', 'image/jpeg'));
check('rejects an MP4 video', !accepts('clip.mp4', 'video/mp4'));
check('rejects a PDF', !accepts('sheet.pdf', 'application/pdf'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
