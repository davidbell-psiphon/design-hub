// The design tokens, checked rather than eyeballed.
//
//   node --test test/a11y.test.mjs
//
// Every number here came out of README-UX-AUDIT.md, which measured the
// stylesheet and found three things wrong: no keyboard focus anywhere, two
// text colours below AA contrast, and five run states painted in three
// colours.
//
// They are tests rather than a fixed commit because all three are the kind of
// fault that comes back. A colour gets nudged to look nicer, a new control
// forgets its focus ring, a state gets added and reuses a neighbour's colour —
// and none of that shows up in a behavioural test, because the board still
// works. It is just unusable for somebody on a keyboard, or unreadable.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');

// WCAG relative luminance and contrast ratio.
const channels = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const linear = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const luminance = (h) => {
  const [r, g, b] = channels(h);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

function token(name) {
  const m = css.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})'));
  assert.ok(m, `the token --${name} is gone, or is no longer a plain hex colour`);
  return m[1];
}

describe('text is readable on the background it sits on', () => {
  const bg = () => token('bg');

  // 4.5:1 is AA for body text. None of these are large text: the board's
  // biggest use of --text-muted is a 12px button label, and --text-dim is an
  // 11px count.
  for (const name of ['text', 'text-muted', 'text-dim']) {
    test(`--${name} clears AA`, () => {
      const c = token(name);
      const r = contrast(c, bg());
      assert.ok(r >= 4.5,
        `--${name} is ${c}, which is ${r.toFixed(2)}:1 on ${bg()} — AA needs 4.5. ` +
        `This was 1.96:1 once and the text was effectively invisible.`);
    });
  }

  test('the run-state colours are readable too', () => {
    // They are text on the pill, not just decoration.
    for (const name of ['run-error', 'run-stalled', 'run-working', 'run-waiting', 'run-done']) {
      const c = token(name);
      const r = contrast(c, bg());
      assert.ok(r >= 4.5, `--${name} is ${r.toFixed(2)}:1, under AA`);
    }
  });
});

describe('every run state has its own colour', () => {
  // runState() distinguishes five. The board painted them in three: error was
  // the same value as stalled, working the same as waiting. The pill text said
  // which, but across sixty cards colour is the channel doing the scanning,
  // and it was answering a coarser question than the code had asked.
  const STATES = ['run-error', 'run-stalled', 'run-working', 'run-waiting', 'run-done'];

  test('five states, five colours', () => {
    const used = STATES.map(token);
    const distinct = new Set(used);
    assert.equal(distinct.size, STATES.length,
      'two run states share a colour again: ' +
      STATES.map((s, i) => s + '=' + used[i]).join(', '));
  });

  test('and the ones that mean different things look different', () => {
    // Not just unequal strings — far enough apart to tell apart. Stalled and
    // error are the pair most worth separating: one means nothing is coming,
    // the other means it tried and broke.
    const apart = (a, b) => {
      const [x, y] = [channels(token(a)), channels(token(b))];
      return Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]);
    };
    assert.ok(apart('run-error', 'run-stalled') > 60,
      'error and stalled are nearly the same colour');
    assert.ok(apart('run-working', 'run-waiting') > 60,
      'working and needs-you are nearly the same colour');
  });

  test('every state board-logic can return has a colour', () => {
    // If runState() grows a state, this fails until the stylesheet catches up
    // rather than falling back to whatever CSS inherits.
    const logic = fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8');
    const listed = logic.match(/var RUN_STATE_RANK = \[([^\]]+)\]/);
    assert.ok(listed, 'RUN_STATE_RANK is gone, so this check cannot run');
    const states = listed[1].split(',').map((s) => s.trim().replace(/['"]/g, ''))
      .filter((s) => s && s !== 'idle');   // idle is deliberately unpainted
    for (const s of states) {
      assert.ok(new RegExp('--run-' + s + ':').test(css),
        `runState can return "${s}" and there is no --run-${s} colour for it`);
    }
  });
});

describe('the board can be used from a keyboard', () => {
  test('focus is visible', () => {
    // There were zero of these. Every control is a real <button>, so the board
    // was fully reachable by keyboard and completely unusable that way.
    // Not merely that the selector exists. A rule setting only outline-color
    // paints nothing without a width and a style, so a real `outline:`
    // shorthand has to appear inside a :focus-visible block — otherwise the
    // ring can be deleted and the selectors left behind, which looks fine in
    // a diff and shows nothing on screen.
    const blocks = [...css.matchAll(/:focus-visible[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(blocks.length, 'nothing shows keyboard focus at all — WCAG 2.4.7');
    assert.ok(blocks.some((b) => /outline:\s*\d/.test(b)),
      'every focus rule sets only a colour, which draws no ring — and Dismiss, ' +
      'No design and Mark done sit in one row where two write to Linear');
  });

  test('the ring is not hidden by outline: none anywhere', () => {
    const suppressed = [...css.matchAll(/outline:\s*(none|0)\b/g)];
    assert.equal(suppressed.length, 0,
      'something suppresses the focus outline, which is how this fault returns');
  });

  test('the destructive controls carry their own ring colour', () => {
    // They are the ones worth being certain about before pressing.
    assert.match(css, /\.btn-done:focus-visible/);
    assert.match(css, /\.btn-reset:focus-visible/);
  });
});

describe('motion and target size', () => {
  test('reduced motion is honoured', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/,
      'the board animates without asking whether that is wanted');
  });

  test('controls are big enough to hit', () => {
    // WCAG 2.5.8 asks 24px. Material asks 48px, which would cost this board
    // the density it needs for sixty cards. 32px is the compromise the audit
    // settled on, and the row of six card actions is the phone case.
    const m = css.match(/\.btn \{[^}]*min-height:\s*(\d+)px/);
    assert.ok(m, '.btn has no min-height, so it is back to about 26px tall');
    assert.ok(Number(m[1]) >= 24, `.btn is ${m[1]}px, under the WCAG 2.5.8 floor`);
  });

  test('motion has named curves rather than ad-hoc ones', () => {
    // The nine border-radius values happened because nothing was named. This
    // is the same failure, caught earlier.
    assert.match(css, /--ease-standard:/);
    assert.match(css, /--ease-emphasized:/);
    assert.match(css, /--dur-short:/);
  });
});
