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

describe('state colours are read from their tokens, never retyped', () => {
  // The split into five colours changed nothing visible at first, because the
  // pills, the card rings, the sidebar badge and the gate all carried the old
  // values as literal rgba(). A token nothing reads is a comment.
  const STATE_RGBA = [
    ['rgba(224,120,100', 'the old error/stalled red'],
    ['rgba(240,184,74',  'the old working/waiting amber'],
    ['rgba(239,159,39',  'the old amber, second spelling'],
    ['rgba(111,191,139', 'the old done green'],
  ];

  for (const [literal, what] of STATE_RGBA) {
    test(`${what} is not hardcoded anywhere`, () => {
      assert.ok(!css.includes(literal),
        `${literal}…) is written literally in the stylesheet. Change the token ` +
        `and this will not follow it — which is exactly how five run-state ` +
        `colours produced a board that still showed three.`);
    });
  }

  test('the things that show a run state all derive from a token', () => {
    // Each of these is a place the state is visible. If one stops mentioning
    // its token it has been given a literal again.
    for (const [selector, token] of [
      ['.status-pill.status-waiting', 'run-waiting'],
      ['.status-pill.status-stalled', 'run-stalled'],
      ['.status-pill.status-error', 'run-error'],
      ['.session-card.state-stalled', 'run-stalled'],
      ['.session-card.state-waiting', 'run-waiting'],
      ['.card-note.note-stalled', 'run-stalled'],
      ['.sb-badge.waiting', 'run-waiting'],
    ]) {
      // Sliced rather than matched with a built regex: a selector full of
      // dots needs escaping, and getting that wrong makes a test that looks
      // strict pass on nothing at all.
      const at = css.indexOf(selector + ' {');
      assert.ok(at >= 0, `${selector} is gone`);
      const rule = css.slice(at, css.indexOf('}', at));
      assert.ok(rule.includes('--' + token),
        `${selector} no longer reads --${token}, so it cannot follow it`);
    }
  });
});

describe('the shape and type scales are used, not just declared', () => {
  // Nine ad-hoc radii and eight ad-hoc font sizes were the finding. Declaring
  // scales and then not using them would be the same problem with more tokens.
  test('buttons and pills are fully round', () => {
    const btn = css.match(/\.btn \{([^}]*)\}/);
    assert.match(btn[1], /--shape-full/, 'the button lost its Expressive shape');
    const pill = css.match(/\.status-pill \{([^}]*)\}/);
    assert.match(pill[1], /--shape-full/);
  });

  test('the card uses the shape scale', () => {
    const card = css.match(/\.session-card \{([^}]*)\}/);
    assert.match(card[1], /--shape-md/, 'the card went back to an ad-hoc radius');
  });

  test('titles and headers use type roles', () => {
    assert.match(css.match(/\.session-title \{([^}]*)\}/)[1], /--type-title/);
    assert.match(css.match(/\.brand-name \{([^}]*)\}/)[1], /--type-display/);
    assert.match(css.match(/\.btn \{([^}]*)\}/)[1], /--type-label/);
  });

  test('a brand header is clearly bigger than a card title', () => {
    // 15px against 14px was one step — not enough for the eye to read them as
    // different kinds of thing.
    const size = (role) => {
      const at = css.indexOf('--type-' + role + ':');
      assert.ok(at >= 0, `--type-${role} is gone`);
      const decl = css.slice(at, css.indexOf(';', at));
      return Number(decl.split('px')[0].trim().split(/\s+/).pop());
    };
    assert.ok(size('display') - size('title') >= 4,
      `display is ${size('display')}px and title is ${size('title')}px — too close to read as a different level`);
  });
});

describe('controls behave like Material controls', () => {
  test('there is a state layer, not a swapped background', () => {
    assert.match(css, /\.btn::before/,
      'the state layer is gone, so hover and press are ad-hoc again');
    assert.match(css.match(/\.btn::before \{([^}]*)\}/)[1], /currentColor/,
      'the state layer is a fixed colour, so a coloured button gets the wrong overlay');
  });

  test('press is distinct from hover', () => {
    assert.match(css, /--state-hover:/);
    assert.match(css, /--state-press:/);
    assert.match(css, /\.btn:active/);
  });

  test('the primary action follows the brand it sits in', () => {
    const at = css.indexOf('.btn-primary {');
    assert.ok(at >= 0, '.btn-primary is gone');
    const rule = css.slice(at, css.indexOf('}', at));
    // The FILL specifically, not merely a mention of --brand somewhere in the
    // rule — a border that still reads the brand while the background has been
    // hardcoded back to a grey is exactly the half-change worth catching.
    const bg = rule.split('background:')[1];
    assert.ok(bg, '.btn-primary has no background, so it is not a filled button');
    assert.match(bg.split(';')[0], /--brand/,
      'the primary button fill stopped taking its colour from the brand section');
  });
});
