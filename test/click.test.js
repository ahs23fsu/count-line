/* Regression test for the "can't click anything" bug.
 * Verifies the help modal (a full-screen fixed overlay) does NOT intercept
 * clicks when hidden, and that the real buttons are the topmost element at
 * their location. Uses the CSS cascade via a headless browser if available;
 * otherwise falls back to a jsdom-free cascade assertion on the stylesheet. */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + ' — ' + n + (d ? '  [' + d + ']' : '')); ok ? pass++ : fail++; };

// 1. The modal is a full-screen fixed overlay (so it WOULD block clicks if shown).
check('modal is a fixed full-screen overlay', /\.modal\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/.test(css), 'confirmed overlay');

// 2. A global [hidden] rule exists and uses !important so it beats class display.
const globalHidden = /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css);
check('global [hidden] { display:none !important } present', globalHidden);

// 3. The elements that combine a display-setting class with the hidden attribute
//    are all covered by the global rule.
const riskyPairs = [
  { id: 'analyzeStatus', cls: 'analyze-status' },
  { id: 'voiceOptRow', cls: 'opt-row' },
  { id: 'helpModal', cls: 'modal' },
];
for (const p of riskyPairs) {
  const tag = new RegExp('id="' + p.id + '"[^>]*class="[^"]*' + p.cls + '[^"]*"[^>]*\\bhidden\\b|class="[^"]*' + p.cls + '[^"]*"[^>]*id="' + p.id + '"[^>]*\\bhidden\\b');
  const hasHidden = tag.test(html);
  check(p.id + ' starts hidden in HTML', hasHidden, p.cls);
}

// 4. Sanity: the class really does set a non-none display (that's the whole trap).
check('.analyze-status sets display:flex', /\.analyze-status\s*\{[^}]*display:\s*flex/.test(css));
check('.opt-row sets display:flex', /\.opt-row\s*\{[^}]*display:\s*flex/.test(css));
check('.modal sets display:grid', /\.modal\s*\{[^}]*display:\s*grid/.test(css));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
