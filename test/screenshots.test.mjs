// Screenshot cards — flagged, styled, and offered the screenshot agent.
//
//   node --test test/screenshots.test.mjs
//
// Store-listing screenshot work spans the app teams and goes to its own agent
// in the sibling design-ai repo. Dave asked for the card to be flagged by
// either of two signals — the `store-screenshots` label, or the word in the
// title — and for the flagged card to offer that agent. Nothing here triggers
// anything: the flag styles the card and renames its buttons, and the press is
// still the only thing that queues work.
//
// Three levels, because the fact is derived at one and read at two: the
// function in lib/derive.mjs (vendored into design-ai, so the runner flags the
// same issues), the `kind` the projection serves, and what the board draws.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isScreenshotWork, isScreenshotIssue, SCREENSHOT_LABEL } from '../lib/derive.mjs';
import { toWire } from '../lib/card.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ──────────────────────────────────────────────────────────────────────
// The function both systems share
// ──────────────────────────────────────────────────────────────────────

describe('isScreenshotWork — the label, or the word in the title', () => {
  test('the label alone is enough', () => {
    assert.equal(isScreenshotWork(JSON.stringify([SCREENSHOT_LABEL]), 'Refresh the listing'), true);
  });

  test('the word in the title alone is enough, in any case and number', () => {
    assert.equal(isScreenshotWork('[]', 'Refresh the App Store Screenshots'), true);
    assert.equal(isScreenshotWork('[]', 'new play store screenshot for v3'), true);
    assert.equal(isScreenshotWork('[]', 'Screen shots — localize'), true);
  });

  test('the word inside another word is not the word', () => {
    // "screenshotting" would match \bscreenshot — but is that this kind of
    // work? It is. The case that must NOT match is a different word entirely.
    assert.equal(isScreenshotWork('[]', 'Onboarding screens'), false);
    assert.equal(isScreenshotWork('[]', 'Shot list for the launch video'), false);
  });

  test('neither signal, no flag', () => {
    assert.equal(isScreenshotWork(JSON.stringify(['AI-research done', 'Bug']), 'Wallet empty state'), false);
    assert.equal(isScreenshotWork(null, null), false);
    assert.equal(isScreenshotWork(undefined, ''), false);
  });

  test('a similar label is not the label', () => {
    assert.equal(isScreenshotWork(JSON.stringify(['Store Screenshots']), 'x'), false);
    assert.equal(isScreenshotWork(JSON.stringify(['store-screenshots-old']), 'x'), false);
  });

  test('labels may arrive already parsed, as names or as objects', () => {
    assert.equal(isScreenshotWork([SCREENSHOT_LABEL], 'x'), true);
    assert.equal(isScreenshotWork([{ name: SCREENSHOT_LABEL }], 'x'), true);
  });

  test('malformed labels JSON does not throw, and the title still counts', () => {
    assert.equal(isScreenshotWork('{not json', 'x'), false);
    assert.equal(isScreenshotWork('{not json', 'Screenshots'), true);
  });
});

describe('isScreenshotIssue — the same call on a Linear issue', () => {
  test('reads labels.nodes and title', () => {
    assert.equal(isScreenshotIssue({ title: 'x', labels: { nodes: [{ name: SCREENSHOT_LABEL }] } }), true);
    assert.equal(isScreenshotIssue({ title: 'Play Store screenshots', labels: { nodes: [] } }), true);
    assert.equal(isScreenshotIssue({ title: 'x', labels: { nodes: [{ name: 'Bug' }] } }), false);
  });

  test('tolerates a bare issue', () => {
    assert.equal(isScreenshotIssue({}), false);
    assert.equal(isScreenshotIssue(null), false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// The projection: derived, never stored
// ──────────────────────────────────────────────────────────────────────

const card = (o = {}) => ({
  issue_key: 'PSI2-40', linear_uuid: 'uuid', title: 'A card', url: 'https://linear.app/x',
  team: 'Psiphon App', linear_state: 'unstarted', labels: '[]', linear_project: null,
  linear_read_at: null, brand: 'psiphon', track: 'app', figma_url: null,
  dismissed_at: null, set_aside_at: null, description: null,
  updated_at: '2026-09-20 12:00:00', created_at: '2026-09-20 12:00:00', ...o,
});

describe('the wire carries kind', () => {
  test('a labelled card is kind screenshots', () => {
    assert.equal(toWire(card({ labels: JSON.stringify([SCREENSHOT_LABEL]) })).kind, 'screenshots');
  });

  test('a card with the word in its title is kind screenshots', () => {
    assert.equal(toWire(card({ title: 'Refresh the App Store screenshots' })).kind, 'screenshots');
  });

  test('every other card is kind null — present, not absent', () => {
    const w = toWire(card());
    assert.ok('kind' in w, 'kind is missing from the wire');
    assert.equal(w.kind, null);
  });

  test('there is no kind column to store — it is computed from labels and title', () => {
    // The whole point of lib/card.mjs. A stored kind would be a third copy of
    // two Linear-owned facts, and could disagree with them after a reader pass.
    for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!/\bkind\s+TEXT/i.test(sql) || f.includes('piece12'),
        `${f} declares a kind column — the card's kind must stay derived`);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// board-logic.js, in a bare context
// ──────────────────────────────────────────────────────────────────────

const logicCtx = vm.createContext({ Date, Math, isNaN, String });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), logicCtx);
const { isScreenshots, actionFor, actionsFor, stageLabel } = logicCtx;

const row = (o = {}) => ({
  labels: JSON.stringify(o.labels || []), kind: o.kind === undefined ? null : o.kind,
  linear_state: o.linear_state || 'unstarted', requested_stage: null, ...o,
});

// Objects made inside the vm context have another realm's prototypes, so
// deepEqual sees "same structure, not reference-equal". Compare the values.
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

describe('the buttons speak in the screenshot agent\'s words', () => {
  test('an ordinary card offers Run Research, exactly as before', () => {
    same(actionFor(row()), { stage: 'research', label: 'Run Research' });
    assert.equal(actionsFor(row())[1].label, 'Skip to Design');
  });

  test('a screenshot card offers Analyze screenshots — on the research stage', () => {
    same(actionFor(row({ kind: 'screenshots' })), { stage: 'research', label: 'Analyze screenshots' });
  });

  test('once analyzed, it offers Make screenshots — on the design stage', () => {
    same(actionFor(row({ kind: 'screenshots', labels: ['AI-research done'] })),
         { stage: 'design', label: 'Make screenshots' });
  });

  test('the Backlog skip is the same skip, renamed', () => {
    const [primary, skip] = actionsFor(row({ kind: 'screenshots' }));
    assert.equal(primary.label, 'Analyze screenshots');
    assert.equal(skip.label, 'Skip to Make');
    assert.equal(skip.skips, 'research');
    assert.equal(skip.stage, 'design');
  });

  test('the pill says what the stages were', () => {
    assert.equal(stageLabel(row({ kind: 'screenshots', labels: ['AI-research done'] })), 'Analyzed');
    assert.equal(stageLabel(row({ kind: 'screenshots', labels: ['AI-design done'] })), 'Screenshots made');
    assert.equal(stageLabel(row({ kind: 'screenshots', labels: ['no-research'] })), 'Analysis skipped');
    assert.equal(stageLabel(row({ labels: ['AI-research done'] })), 'Researched');
  });

  test('the flag is read from the wire, not re-derived in the browser', () => {
    // One implementation, in lib/derive.mjs. A second one here would be the
    // drift the vendored copy in design-ai exists to prevent.
    assert.equal(isScreenshots(row({ labels: [SCREENSHOT_LABEL] })), false);
    assert.equal(isScreenshots(row({ kind: 'screenshots' })), true);
    // Comments may name the label to explain the flag; code may not test for it.
    const code = fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.ok(!/store-screenshots/.test(code), 'board-logic.js tests for the label by name — it should read kind');
  });
});

// ──────────────────────────────────────────────────────────────────────
// What the board draws
// ──────────────────────────────────────────────────────────────────────

const brandRows = [{ id: 'psiphon', name: 'Psiphon', color: '#5FA8D3' }];
const ALL_TEAMS = { selected: [], available: ['Psiphon App'], source: 'linear', all: true };

const wireRow = (o) => ({
  id: o.linear_id, linear_id: o.linear_id, system: 'design-ai',
  project: 'psiphon', track: 'app', phase: null, status: null,
  title: o.title || o.linear_id, updated_at: null, requested_at: null, prompt: null,
  team: 'Psiphon App', linear_project: null, set_aside_at: null, options: null,
  linear_state: 'unstarted', labels: JSON.stringify(o.labels || []),
  kind: o.kind === undefined ? null : o.kind,
  requested_stage: null, dismissed_at: null,
  linear_uuid: 'uuid-' + o.linear_id, url: 'https://linear.app/x', stages: {},
});

function stubEl() {
  return {
    innerHTML: '', textContent: '', title: '', disabled: false, style: {}, scrollTop: 0,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f;
                     on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); },
    },
  };
}

async function mount(rows) {
  const html = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');
  const logic = fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8');
  const inline = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const nodes = {};
  globalThis.document = { getElementById: id => (nodes[id] = nodes[id] || stubEl()) };
  globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener: () => {}, scrollTo: () => {} };
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => {
      if (url.endsWith('/brands')) return brandRows;
      if (url.endsWith('/reader/teams')) return ALL_TEAMS;
      if (url.endsWith('/runner')) return { repo: 'x/design-ai', workflow: 'design-ai.yml', url: 'https://github.com/x' };
      if (url.endsWith('/agent/heartbeat')) return [];
      return rows;
    },
  });
  const run = new Function(logic + '\n' + inline + '\n;return { loadBoard, sessionCard };');
  const api = run();
  await api.loadBoard();
  return { board: nodes['board'].innerHTML, sessionCard: api.sessionCard };
}

const cardOf = (board, id) => {
  const at = board.indexOf(`<span class="session-id">${id}</span>`);
  assert.ok(at >= 0, `${id} is not on the board`);
  const start = board.lastIndexOf('<div class="session-card', at);
  return board.slice(start, board.indexOf('<div class="session-card', at + 1) === -1
    ? undefined : board.indexOf('<div class="session-card', at + 1));
};

describe('a screenshot card looks and reads like one', () => {
  let board;
  before(async () => {
    ({ board } = await mount([
      wireRow({ linear_id: 'PSI2-40', title: 'Refresh the App Store set', kind: 'screenshots', labels: [SCREENSHOT_LABEL] }),
      wireRow({ linear_id: 'PSI2-41', title: 'Play Store screenshots for v4', kind: 'screenshots' }),
      wireRow({ linear_id: 'PSI2-42', title: 'Onboarding empty state' }),
      wireRow({ linear_id: 'PSI2-43', title: 'Localize screenshots', kind: 'screenshots', labels: ['AI-research done'] }),
    ]));
  });

  test('it carries the kind class and the Screenshots chip', () => {
    const c = cardOf(board, 'PSI2-40');
    assert.match(c, /session-card state-\w+ kind-screenshots/);
    assert.match(c, /<span class="kind-pill"[^>]*>Screenshots<\/span>/);
  });

  test('flagged by title alone, it is the same card', () => {
    const c = cardOf(board, 'PSI2-41');
    assert.match(c, /kind-screenshots/);
    assert.match(c, />Screenshots<\/span>/);
  });

  test('its button offers the screenshot agent, on the research stage', () => {
    const c = cardOf(board, 'PSI2-40');
    assert.match(c, /triggerSession\('PSI2-40', 'research', this\)"\s*>Analyze screenshots</);
    assert.doesNotMatch(c, /Run Research/);
    assert.match(c, />Skip to Make</);
  });

  test('an analyzed one offers Make screenshots, on the design stage', () => {
    const c = cardOf(board, 'PSI2-43');
    assert.match(c, /triggerSession\('PSI2-43', 'design', this\)"\s*>Make screenshots</);
    assert.match(c, /<span class="stage-pill">Analyzed<\/span>/);
  });

  test('an ordinary card is untouched', () => {
    const c = cardOf(board, 'PSI2-42');
    assert.doesNotMatch(c, /kind-screenshots/);
    assert.doesNotMatch(c, /kind-pill/);
    assert.match(c, />Run Research</);
    assert.match(c, />Skip to Design</);
  });

  test('the chip says what flagged it, and that it triggers nothing', () => {
    const c = cardOf(board, 'PSI2-40');
    assert.match(c, /flagged by the store-screenshots label, or by the word in the title/);
  });
});

describe('the styling is a token, not a retyped colour', () => {
  const css = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');

  test('the kind has its own token, distinct from every run state', () => {
    const m = css.match(/--kind-screenshots:\s*(#[0-9a-f]{6})/i);
    assert.ok(m, 'no --kind-screenshots token');
    for (const run of ['error', 'stalled', 'working', 'waiting', 'done']) {
      const r = css.match(new RegExp(`--run-${run}:\\s*(#[0-9a-f]{6})`, 'i'))[1];
      assert.notEqual(m[1].toLowerCase(), r.toLowerCase(), `the kind colour is the same as --run-${run}`);
    }
  });

  test('the chip and the card edge both read the token', () => {
    assert.match(css, /\.kind-pill\s*\{[^}]*var\(--kind-screenshots\)/);
    assert.match(css, /\.session-card\.kind-screenshots\s*\{[^}]*var\(--kind-screenshots\)/);
  });

  test('the chip is a pill', () => {
    assert.match(css, /\.kind-pill\s*\{[^}]*var\(--shape-full\)/);
  });
});
