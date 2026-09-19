// §7's "Skip a stage", and the design work that needs no research.
//
//   node --test test/skip.test.mjs
//
// Some design tasks need no research at all. The design agent is built for it —
// it works from the description, the BCC and the design bible and records the
// absence of research as an assumption — but the board could not say so, and a
// card sat in Backlog for ever, because absence means "not yet" and nothing
// else (§12). "Not going to happen" has to be written down.
//
// The trap this has to avoid is §11's: "'Run Design' on a card drawn in
// Backlog — the button and the column read different sources". Offering design
// on a Backlog card without recording anything recreates exactly that. So
// pressing it IS the decision, and the decision is written where §1 says it
// belongs — a Linear label, visible to everyone, which §3 reads back as
// `skipped`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  freshDb, env, call, readLinear, issue, stubLinear, one, wire, session,
} from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const board = vm.createContext({ Date, Math, isNaN, String });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), board);
const { actionsFor, actionFor, stageOf, isSkipped, stageLabel } = board;

const card = (labels = []) => ({ id: 'RYV-84', linear_id: 'RYV-84',
                                 labels: JSON.stringify(labels) });

async function onBoard(labels = []) {
  const db = freshDb();
  const e = env(db);
  stubLinear([issue({ identifier: 'RYV-84', labels: labels.map((name) => ({ name })) })]);
  await readLinear(e);
  return { db, e };
}

const skip = (e, stage, method = 'POST') =>
  call(e, method, '/api/agent/session/RYV-84/skip', { stage });

// ──────────────────────────────────────────────────────────────────────
// What the card offers
// ──────────────────────────────────────────────────────────────────────

describe('a Backlog card offers a way past research', () => {
  test('it offers research first, and a skip second', () => {
    const acts = actionsFor(card([]));
    assert.equal(acts.length, 2);
    assert.equal(acts[0].label, 'Run Research', 'research stopped being the primary');
    assert.equal(acts[1].skips, 'research');
    assert.equal(acts[1].stage, 'design');
  });

  test('the second action says what it does to the record', () => {
    // A button that writes a Linear label must not be mistakable for one that
    // merely runs something.
    const skipAction = actionsFor(card([]))[1];
    assert.match(skipAction.label, /Skip/);
    assert.match(skipAction.title, /research skipped/i);
  });

  test('once past research there is only one action again', () => {
    for (const labels of [['AI-research done'], ['no-research']]) {
      assert.equal(actionsFor(card(labels)).map((a) => a.label).join(), 'Run Design',
        `a card at ${labels} offered more than the one stage left`);
    }
  });

  test('a designed card offers nothing, as before', () => {
    assert.equal(actionsFor(card(['AI-design done'])).length, 0);
  });

  test('the primary is still exactly what actionFor says', () => {
    // §5: the button and the column come from one derivation. Two functions
    // that could disagree about the primary would be the same bug in a new
    // place, so the second is built from the first.
    for (const labels of [[], ['AI-research done'], ['no-research'], ['AI-design done']]) {
      const acts = actionsFor(card(labels));
      const one = actionFor(card(labels));
      if (!one) assert.equal(acts.length, 0);
      else assert.equal(acts[0].label, one.label);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// What pressing it does
// ──────────────────────────────────────────────────────────────────────

describe('skipping a stage writes it down', () => {
  test('it applies the label in Linear, not only in the Hub', async () => {
    const db = freshDb();
    const e = env(db);
    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84' })], mutations);
    await readLinear(e);
    mutations.length = 0;

    const res = await skip(e, 'research');
    assert.equal(res.status, 200);
    assert.ok(mutations.some((m) => /issueAddLabel/.test(m)),
      'nothing was written to Linear — the skip is invisible to everyone else');
  });

  test('and records it locally, so the card moves now rather than on Wednesday', async () => {
    const { db, e } = await onBoard();
    await skip(e, 'research');
    assert.deepEqual(JSON.parse(one(db, 'RYV-84').labels), ['no-research']);
  });

  test('the card then reads as skipped, not as researched', async () => {
    // §3: skipped renders differently from done and from not started. That
    // distinction is the reason it was given a label at all.
    const { db, e } = await onBoard();
    await skip(e, 'research');
    const r = wire(db, 'RYV-84');
    assert.equal(stageOf(r), 'researched', 'the card did not advance');
    assert.equal(isSkipped(r), true, 'it claimed research had been done');
    assert.match(stageLabel(r), /skipped/i);
  });

  test('and now offers design, from the same derivation the column used', async () => {
    const { db, e } = await onBoard();
    await skip(e, 'research');
    assert.equal(actionsFor(wire(db, 'RYV-84')).map((a) => a.label).join(), 'Run Design');
  });

  test('undoing it takes the label off in Linear too', async () => {
    const { db, e } = await onBoard();
    await skip(e, 'research');

    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84' })], mutations);
    const res = await skip(e, 'research', 'DELETE');

    assert.equal(res.status, 200);
    assert.ok(mutations.some((m) => /issueRemoveLabel/.test(m)));
    assert.deepEqual(JSON.parse(one(db, 'RYV-84').labels), []);
    assert.equal(stageOf(wire(db, 'RYV-84')), 'backlog', 'the card did not come back');
  });

  test('skipping twice is not two labels', async () => {
    const { db, e } = await onBoard();
    await skip(e, 'research');
    await skip(e, 'research');
    assert.deepEqual(JSON.parse(one(db, 'RYV-84').labels), ['no-research']);
  });

  test('it refuses a stage the Hub does not run', async () => {
    const { e } = await onBoard();
    const res = await skip(e, 'qa');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /research, design/);
  });

  test('it refuses a card with no Linear issue behind it', async () => {
    const db = freshDb();
    const e = env(db);
    db.prepare(`INSERT INTO cards (issue_key) VALUES ('ZZTEST-1')`).run();
    const res = await call(e, 'POST', '/api/agent/session/ZZTEST-1/skip', { stage: 'research' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no linked Linear issue/);
  });

  test('a Linear failure leaves the local copy alone', async () => {
    // The dismiss route's ordering, for the same reason: a card moved here but
    // not there is put back by the next reconciliation, and flickers.
    const { db, e } = await onBoard();
    stubLinear([issue({ identifier: 'RYV-84' })], null, { mutationError: true });
    const res = await skip(e, 'research');

    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(one(db, 'RYV-84').labels), [],
      'the Hub recorded a skip that Linear refused');
  });

  test('a workspace with no such label is refused rather than half-done', async () => {
    const { db, e } = await onBoard();
    stubLinear([issue({ identifier: 'RYV-84' })], null, { noLabel: true });
    const res = await skip(e, 'research');
    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(one(db, 'RYV-84').labels), []);
  });
});

describe('skipping is a decision, so nothing automatic may make it', () => {
  // §3: "Drift and Unverified are surfaced on the card, never auto-corrected.
  // Writing a missing label on the Manager's own initiative would make it the
  // author of a fact it does not own." A skip is the same shape — it is only
  // ever a human pressing something.
  test('a cron read never writes a skip label', async () => {
    const db = freshDb();
    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84' })], mutations);
    await readLinear(env(db));
    await readLinear(env(db));
    assert.deepEqual(mutations.filter((m) => /issueAddLabel/.test(m)), []);
  });

  test('an agent post never writes one either', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);

    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84' })], mutations);
    await call(e, 'POST', '/api/agent/session',
      { session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'done' },
      { 'X-Agent-Secret': 's' });
    assert.deepEqual(mutations.filter((m) => /issueAddLabel/.test(m)), [],
      'an agent skipped a stage on its own initiative');
  });
});

// ──────────────────────────────────────────────────────────────────────
// The handler, end to end
// ──────────────────────────────────────────────────────────────────────

describe('the Skip to Design button', () => {
  // Mounted the same way handlers.test.mjs does: the real index.html script
  // block, a stub DOM and a recording fetch.
  async function mount({ failSkip = false, failRun = false } = {}) {
    const html = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');
    const logic = fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8');
    const inline = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    const calls = [];
    const toasts = [];
    const nodes = {};
    const el = () => ({ innerHTML: '', textContent: '', disabled: false, value: '',
      classList: { add() {}, remove() {}, toggle() {} }, style: {},
      querySelectorAll: () => [], addEventListener() {}, focus() {} });

    globalThis.document = { getElementById: (id) => (nodes[id] = nodes[id] || el()),
                            addEventListener() {}, hidden: false };
    globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {},
                          scrollTo() {}, innerWidth: 1400 };
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.fetch = async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
      if (url.includes('/skip') && failSkip) {
        return { ok: false, status: 502, json: async () => ({ error: 'Linear said no' }) };
      }
      if (url.includes('/trigger') && failRun) {
        return { ok: false, status: 409, json: async () => ({ error: 'already queued' }) };
      }
      const body = url.endsWith('/brands') ? [{ id: 'conduit', name: 'C', color: '#000' }]
        : url.endsWith('/reader/teams') ? { selected: [], available: [], all: true }
        : url.endsWith('/runner') ? { url: 'https://gh' }
        : url.endsWith('/agent/heartbeat') ? []
        : url.endsWith('/agent/sessions') ? []
        : { ok: true };
      return { ok: true, status: 200, json: async () => body };
    };

    const run = new Function(logic + '\n' + inline + '\n;return { loadBoard, skipToStage };');
    const b = run();
    const toastNode = nodes['toast'] = nodes['toast'] || el();
    Object.defineProperty(toastNode, 'textContent',
      { get: () => '', set: (v) => { if (v) toasts.push(v); }, configurable: true });
    await b.loadBoard();
    calls.length = 0; toasts.length = 0;
    return { b, calls, toasts,
             sent: (frag, m) => calls.find((c) => c.url.includes(frag) && (!m || c.method === m)) };
  }

  test('it skips first, then runs — in that order', async () => {
    const h = await mount();
    await h.b.skipToStage('RYV-84', 'research', 'design', null);

    const skipAt = h.calls.findIndex((c) => c.url.includes('/skip'));
    const runAt = h.calls.findIndex((c) => c.url.includes('/trigger'));
    assert.ok(skipAt >= 0 && runAt >= 0, 'both calls did not happen');
    assert.ok(skipAt < runAt, 'the run was queued before the skip was recorded');
    assert.deepEqual(h.sent('/skip').body, { stage: 'research' });
    assert.deepEqual(h.sent('/trigger').body, { stage: 'design' });
  });

  test('a failed skip does not queue the run', async () => {
    // Queuing design on a card the board still shows in Backlog is exactly the
    // disagreement §11 lists. Better to have done nothing than half of it.
    const h = await mount({ failSkip: true });
    await h.b.skipToStage('RYV-84', 'research', 'design', null);

    assert.equal(h.sent('/trigger'), undefined,
      'design was queued on a card whose research was never marked skipped');
    assert.match(h.toasts.join(' '), /Could not skip research/);
  });

  test('a skip that stuck with a run that did not says both', async () => {
    const h = await mount({ failRun: true });
    await h.b.skipToStage('RYV-84', 'research', 'design', null);
    assert.match(h.toasts.join(' '), /skipped, but could not start design/);
  });

  test('it says plainly what happened on success', async () => {
    const h = await mount();
    await h.b.skipToStage('RYV-84', 'research', 'design', null);
    assert.match(h.toasts.join(' '), /research skipped/);
  });
});
