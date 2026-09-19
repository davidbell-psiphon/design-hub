// §14.5 — the board's own handlers.
//
//   node --test test/handlers.test.mjs
//
// The architecture names this as the known gap, in as many words: "The board's
// client-side handlers are untested — the API wiring, toasts, button enabling.
// Current tests cover the markup those handlers produce, not the handlers.
// This is where several of today's bugs actually lived."
//
// render.test.mjs mounts the board and asserts what it DREW. This mounts it and
// asserts what it DOES: which request went out, with what body, what it said
// afterwards, what it left the button in when the call failed, and — for the
// machine handlers — what it wrote to browser storage.
//
// Everything here runs the real `frontend/index.html` script block against a
// stub DOM, so it exercises the source that ships rather than a paraphrase.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const BRANDS = [{ id: 'conduit', name: 'Conduit', color: '#7E67A4' }];
const TEAMS = { selected: [], available: ['Conduit App'], source: 'linear', all: true };

const card = (o = {}) => ({
  id: 'RYV-84', linear_id: 'RYV-84', title: 'A card', project: 'conduit', track: 'app',
  team: 'Conduit App', linear_state: 'backlog', labels: '[]', status: null, phase: null,
  prompt: null, detail: null, options: null, requested_stage: null, requested_at: null,
  updated_at: '2026-09-19 02:00:00', dismissed_at: null, set_aside_at: null,
  linear_project: null, figma_url: null, stages: {}, ...o,
});

const machine = (o = {}) => ({
  machine: 'DaveBellJrII', kind: 'local', capabilities: ['research', 'design'],
  last_seen: new Date().toISOString().replace('T', ' ').slice(0, 19),
  selected_at: null, ...o,
});

function stubEl() {
  const el = {
    innerHTML: '', textContent: '', disabled: false, value: '', dataset: {},
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [], parentElement: null,
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, removeEventListener() {}, focus() {}, scrollIntoView() {},
    appendChild() {}, removeChild() {}, setAttribute() {}, getAttribute: () => null,
    closest: () => null, remove() {},
  };
  return el;
}

// Mount the board, and hand back both the handlers and a record of what they
// did. `store` starts as whatever a browser would already have; `throwOnStore`
// is private browsing, where every access raises.
async function mount({
  rows = [card()], machines = [], store = {}, throwOnStore = false, responses = {},
} = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');
  const logic = fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8');
  const inline = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

  const calls = [];
  const toasts = [];
  const nodes = {};
  const listeners = {};

  globalThis.document = {
    getElementById: (id) => (nodes[id] = nodes[id] || stubEl()),
    addEventListener: (n, f) => { listeners[n] = f; },
    hidden: false,
    body: stubEl(),
    createElement: () => stubEl(),
  };
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    addEventListener: (n, f) => { listeners[n] = f; },
    scrollTo() {}, innerWidth: 1400,
  };
  globalThis.localStorage = {
    getItem(k) { if (throwOnStore) throw new Error('storage blocked'); return k in store ? store[k] : null; },
    setItem(k, v) { if (throwOnStore) throw new Error('storage blocked'); store[k] = String(v); },
    removeItem(k) { if (throwOnStore) throw new Error('storage blocked'); delete store[k]; },
  };

  globalThis.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });

    // A route the test wants to fail or shape.
    for (const [frag, val] of Object.entries(responses)) {
      if (url.includes(frag)) {
        if (val && val.status && val.status >= 400) {
          return { ok: false, status: val.status,
                   json: async () => ({ error: val.error || 'nope' }) };
        }
        return { ok: true, status: 200, json: async () => val };
      }
    }
    if (url.endsWith('/brands')) return ok(BRANDS);
    if (url.endsWith('/reader/teams')) return ok(TEAMS);
    if (url.endsWith('/runner')) return ok({ repo: 'x/y', workflow: 'w.yml', url: 'https://gh' });
    if (url.endsWith('/agent/heartbeat')) return ok(machines);
    if (url.endsWith('/agent/sessions')) return ok(rows);
    return ok({ ok: true });
  };
  const ok = (v) => ({ ok: true, status: 200, json: async () => v });

  const exported = [
    'loadBoard', 'assertMachine', 'chooseMachine', 'rememberedMachine', 'rememberMachine',
    'triggerSession', 'resetSession', 'dismissSession', 'undismissSession', 'completeSession',
    'setAside', 'unsetAside', 'answerGate', 'chooseOwn', 'rejectAll', 'reopenGate',
    'reassignSession', 'localAgentLine', 'machinePicker', 'toast', 'key',
    'openFigmaPaths', 'closeFigmaPaths', 'renderFigmaPaths', 'refreshFigmaPaths',
    'saveFigmaDefault', 'addFigmaDefault', 'removeFigmaDefault',
    'saveFigmaOverride', 'addFigmaOverride', 'clearFigmaOverride', 'renderSidebar',
  ];
  const run = new Function(
    logic + '\n' + inline + '\n;return {' + exported.join(',') + '};');
  const board = run();

  // Capture toasts by replacing the DOM node the real one writes into.
  const toastNode = nodes['toast'] = nodes['toast'] || stubEl();
  Object.defineProperty(toastNode, 'textContent', {
    get: () => toasts[toasts.length - 1] || '',
    set: (v) => { if (v) toasts.push(v); },
    configurable: true,
  });

  await board.loadBoard();
  calls.length = 0;          // the initial load is setup, not the thing under test
  toasts.length = 0;

  return { board, calls, toasts, store, nodes, listeners,
           sent: (frag, method) => calls.find(
             (c) => c.url.includes(frag) && (!method || c.method === method)) };
}

const btn = () => {
  const b = stubEl();
  b.textContent = 'Run Research';
  return b;
};

// ──────────────────────────────────────────────────────────────────────
// Which machine this browser is on — the thing that kept disconnecting
// ──────────────────────────────────────────────────────────────────────

describe('a browser asserts its machine on load', () => {
  const KEY = 'design-hub:working-from';

  test('it points work at the machine it remembers', async () => {
    const h = await mount({
      machines: [machine(), machine({ machine: 'dave-bell-jr', selected_at: '2026-09-19 01:00:00' })],
      store: { [KEY]: 'DaveBellJrII' },
    });
    await h.board.assertMachine();

    const put = h.sent('/agent/working-from', 'PUT');
    assert.ok(put, 'the board never told the Hub which machine it is on');
    assert.equal(put.body.machine, 'DaveBellJrII');
  });

  test('it says nothing when the Hub already agrees', async () => {
    // Asserting here is what would turn every page load into a loop.
    const h = await mount({
      machines: [machine({ selected_at: '2026-09-19 01:00:00' })],
      store: { [KEY]: 'DaveBellJrII' },
    });
    await h.board.assertMachine();
    assert.equal(h.sent('/agent/working-from'), undefined,
      'the board re-asserted a machine that was already chosen');
  });

  test('it says nothing when this browser has never been told', async () => {
    const h = await mount({ machines: [machine()], store: {} });
    await h.board.assertMachine();
    assert.equal(h.sent('/agent/working-from'), undefined);
  });

  test('it refuses to point work at a machine that never checked in', async () => {
    const h = await mount({ machines: [machine()], store: { [KEY]: 'a-laptop-elsewhere' } });
    await h.board.assertMachine();
    assert.equal(h.sent('/agent/working-from'), undefined,
      'work was pointed at a machine the Hub has never heard from');
  });

  test('loading the board asserts without being asked', async () => {
    // The automatic half: open the page on a computer and it says so.
    const h = await mount({
      machines: [machine(), machine({ machine: 'dave-bell-jr', selected_at: '2026-09-19 01:00:00' })],
      store: { [KEY]: 'DaveBellJrII' },
    });
    await h.board.loadBoard();
    assert.ok(h.sent('/agent/working-from', 'PUT'),
      'opening the board did not point work at this machine');
  });

  test('a failure is said out loud rather than swallowed', async () => {
    // The alternative is work quietly going to the other machine.
    const h = await mount({
      machines: [machine(), machine({ machine: 'dave-bell-jr', selected_at: '2026-09-19 01:00:00' })],
      store: { [KEY]: 'DaveBellJrII' },
      responses: { '/agent/working-from': { status: 503, error: 'not migrated' } },
    });
    await h.board.assertMachine();
    assert.match(h.toasts.join(' '), /Could not point work at DaveBellJrII/);
  });
});

describe('choosing a machine by hand', () => {
  const KEY = 'design-hub:working-from';

  test('it tells the Hub and remembers for next time', async () => {
    const h = await mount({ machines: [machine()], store: {} });
    await h.board.chooseMachine('DaveBellJrII');

    assert.equal(h.sent('/agent/working-from', 'PUT').body.machine, 'DaveBellJrII');
    assert.equal(h.store[KEY], 'DaveBellJrII',
      'the choice was not remembered, so the next page load forgets it');
  });

  test('pressing the chosen one again clears it, and forgets', async () => {
    const h = await mount({
      machines: [machine({ selected_at: '2026-09-19 01:00:00' })],
      store: { [KEY]: 'DaveBellJrII' },
    });
    await h.board.chooseMachine('DaveBellJrII');

    assert.equal(h.sent('/agent/working-from', 'PUT').body.machine, null);
    assert.ok(!(KEY in h.store), 'it kept remembering a machine it just cleared');
  });

  test('a refusal is reported and nothing is remembered', async () => {
    const h = await mount({
      machines: [machine()], store: {},
      responses: { '/agent/working-from': { status: 404, error: 'no such machine' } },
    });
    await h.board.chooseMachine('ghost');
    assert.match(h.toasts.join(' '), /Could not set the machine/);
    assert.ok(!(KEY in h.store), 'a failed choice was remembered anyway');
  });

  test('private browsing does not break the board', async () => {
    // Storage throws in private mode and in some embedded views. A board that
    // will not work because it could not save a preference is a far worse
    // failure than one that forgets which machine it is.
    const h = await mount({ machines: [machine()], throwOnStore: true });
    await h.board.chooseMachine('DaveBellJrII');
    assert.equal(h.sent('/agent/working-from', 'PUT').body.machine, 'DaveBellJrII',
      'the choice never reached the Hub');
    assert.equal(h.board.rememberedMachine(), null);
  });
});

describe('the machine picker', () => {
  test('one machine and nothing chosen renders no picker at all', async () => {
    // The board that was there before this feature.
    const h = await mount({ machines: [machine()] });
    assert.ok(!h.board.localAgentLine().includes('cn-machines'),
      'a picker appeared where there is nothing to pick');
  });

  test('two machines get a picker, with the chosen one marked', async () => {
    const h = await mount({
      machines: [machine({ selected_at: '2026-09-19 01:00:00' }),
                 machine({ machine: 'dave-bell-jr' })],
    });
    const out = h.board.localAgentLine();
    assert.match(out, /cn-machines/);
    assert.match(out, /cn-machine-on/, 'nothing showed which machine work goes to');
    assert.match(out, /DaveBellJrII/);
    assert.match(out, /dave-bell-jr/);
  });

  test('a CI runner is never offered as somewhere you sit', async () => {
    const h = await mount({
      machines: [machine(), machine({ machine: 'gh-runner-7', kind: 'ci' })],
    });
    assert.ok(!h.board.localAgentLine().includes('gh-runner-7'),
      'the board offered a GitHub runner as a machine to sit at');
  });

  test('it says where work will actually go', async () => {
    const h = await mount({
      machines: [machine({ selected_at: '2026-09-19 01:00:00' }),
                 machine({ machine: 'dave-bell-jr' })],
    });
    assert.match(h.board.localAgentLine(), /work goes to DaveBellJrII/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// The controls — what they send, and what they say
// ──────────────────────────────────────────────────────────────────────

describe('the stage button', () => {
  test('it asks for the stage it names', async () => {
    const h = await mount();
    await h.board.triggerSession('RYV-84', 'research', btn());
    const c = h.sent('/trigger', 'POST');
    assert.equal(c.body.stage, 'research');
    assert.match(c.url, /RYV-84/);
  });

  test('a queued-but-not-started run says so, rather than claiming it began', async () => {
    const h = await mount({
      responses: { '/trigger': { ok: true, started: false, detail: 'no GITHUB_TOKEN set' } },
    });
    await h.board.triggerSession('RYV-84', 'research', btn());
    assert.match(h.toasts.join(' '), /did not start/);
    assert.match(h.toasts.join(' '), /no GITHUB_TOKEN set/);
  });

  test('a started run says that instead', async () => {
    const h = await mount({ responses: { '/trigger': { ok: true, started: true } } });
    await h.board.triggerSession('RYV-84', 'research', btn());
    assert.match(h.toasts.join(' '), /run started/);
  });

  test('a failure re-enables the button, so the press can be repeated', async () => {
    const b = btn();
    const h = await mount({ responses: { '/trigger': { status: 409, error: 'already queued' } } });
    await h.board.triggerSession('RYV-84', 'research', b);
    assert.equal(b.disabled, false, 'the button stayed dead after a failure');
    assert.equal(b.textContent, 'Run Research', 'the button kept saying Working');
    assert.match(h.toasts.join(' '), /Could not request/);
  });
});

describe('stop and reset', () => {
  test('it takes the request out of the queue', async () => {
    const h = await mount();
    await h.board.resetSession('RYV-84', btn(), 'Reset');
    assert.equal(h.sent('/trigger', 'DELETE').method, 'DELETE');
  });

  test('Stop does not promise more than it can do', async () => {
    const h = await mount();
    await h.board.resetSession('RYV-84', btn(), 'Stop');
    assert.match(h.toasts.join(' '), /already working this issue finishes it/);
  });

  test('Reset names the stage it cleared', async () => {
    const h = await mount({ responses: { '/trigger': { ok: true, cleared: 'design' } } });
    await h.board.resetSession('RYV-84', btn(), 'Reset');
    assert.match(h.toasts.join(' '), /the queued design run was cleared/);
  });
});

describe('answering a gate', () => {
  test('it sends the option id and nothing else', async () => {
    const h = await mount();
    await h.board.answerGate('RYV-84', 'd2', btn());
    const c = h.sent('/respond', 'PATCH');
    assert.deepEqual(c.body, { response_option_id: 'd2' },
      'a gate answer carried something other than the option that was chosen');
  });

  test('it reports the decision in words, not as an id', async () => {
    const h = await mount({ responses: { '/respond': { ok: true, response_label: 'Split header' } } });
    await h.board.answerGate('RYV-84', 'd2', btn());
    assert.match(h.toasts.join(' '), /Decided — Split header/);
  });

  test('a refusal re-enables the options so another can be picked', async () => {
    const b = btn();
    const siblings = [btn(), btn()];
    b.parentElement = { querySelectorAll: () => siblings };
    const h = await mount({ responses: { '/respond': { status: 400, error: 'unknown option' } } });
    await h.board.answerGate('RYV-84', 'd9', b);
    assert.ok(siblings.every((s) => s.disabled === false),
      'a rejected answer left every option dead');
    assert.match(h.toasts.join(' '), /Could not answer/);
  });

  test('your own design is sent under its own field, never as a note', async () => {
    // §8: a note that decides a gate is the "Yes" bug whatever it says.
    // The section name comes from the card's own input, and the element id is
    // hashed from the card id — so ask the board what it calls its own input
    // rather than guessing at the hash.
    const h = await mount();
    const input = h.nodes['own-' + h.board.key('RYV-84')] = stubEl();
    input.value = 'Wallet v4 — Dave';
    await h.board.chooseOwn('RYV-84');
    const c = h.sent('/respond', 'PATCH');
    assert.ok(c, 'nothing was sent');
    assert.equal(c.body.response_section, 'Wallet v4 — Dave');
    assert.ok(!('response_option_id' in c.body),
      'an option id was invented for a design that was never on the list');
  });
});

describe('the destructive-ish controls', () => {
  test('dismiss posts, undismiss deletes, and both name the card', async () => {
    const h = await mount();
    await h.board.dismissSession('RYV-84', btn());
    assert.equal(h.sent('/dismiss', 'POST').method, 'POST');

    const h2 = await mount();
    await h2.board.undismissSession('RYV-84', btn());
    assert.equal(h2.sent('/dismiss', 'DELETE').method, 'DELETE');
  });

  test('set aside and its undo are the same pair', async () => {
    const h = await mount();
    await h.board.setAside('RYV-84', btn());
    assert.equal(h.sent('/setaside', 'POST').method, 'POST');

    const h2 = await mount();
    await h2.board.unsetAside('RYV-84', btn());
    assert.equal(h2.sent('/setaside', 'DELETE').method, 'DELETE');
  });

  test('complete says which state it moved the issue to', async () => {
    const h = await mount({ responses: { '/complete': { ok: true, state: 'Design Done' } } });
    await h.board.completeSession('RYV-84', btn());
    assert.equal(h.sent('/complete', 'POST').method, 'POST');
    assert.match(h.toasts.join(' '), /Design Done/);
  });

  test('a reassignment sends the brand under the name the API takes', async () => {
    const h = await mount();
    await h.board.reassignSession('RYV-84', 'forge');
    assert.deepEqual(h.sent('/reassign', 'PATCH').body, { project: 'forge' });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Figma paths — the editor's handlers
//
// The board is now the ONLY way to change where design work lands, so a
// handler that sends the wrong thing is a setting that cannot be fixed at all
// without editing the database by hand. render.test.mjs covers what the modal
// draws; these cover what it sends.
// ──────────────────────────────────────────────────────────────────────

const PATHS = {
  defaults: [
    { team: 'Forge', brand: 'forge', file: 'Forge App', fileKey: 'FORGEKEY', page: 'YYYY-MM' },
    { team: 'Websites', brand: 'psiphon', file: 'Psiphon Website', fileKey: 'PSIKEY', page: 'YYYY-MM' },
  ],
  overrides: [
    { id: 'RYV-84', title: 'A card', brand: 'ryve', team: 'Ryve App', fileKey: 'ONEOFF', page: '2026-12' },
  ],
};

// The editor reads its values out of real input elements, so the fields have
// to answer. Anything not set answers '' — which is what an untouched field is.
function withFields(h, values) {
  for (const [id, value] of Object.entries(values)) {
    h.nodes[id] = h.nodes[id] || { value: '' };
    h.nodes[id].value = value;
  }
}

const mountPaths = (over = {}) => mount({
  responses: { '/figma-paths': PATHS, ...(over.responses || {}) },
  ...over,
});

describe('Figma paths — the editor sends what it is showing', () => {
  test('saving a default sends the pair it was drawn from, not a typed one', async () => {
    // The pair is the primary key. Reading it back out of an editable field
    // would let an edit write a SECOND row and leave the first behind.
    const h = await mountPaths();
    h.board.openFigmaPaths();
    withFields(h, { 'fp-file-0': 'Forge App v2', 'fp-fkey-0': 'NEWKEY', 'fp-page-0': '2026-09' });

    await h.board.saveFigmaDefault(0, btn());
    const sent = h.sent('/figma-paths', 'PUT');
    assert.ok(sent, 'nothing was sent');
    assert.equal(sent.body.team, 'Forge');
    assert.equal(sent.body.brand, 'forge');
    assert.equal(sent.body.fileKey, 'NEWKEY');
  });

  test('the body is an object, not a string api() would encode twice', async () => {
    // api() serialises `body` itself. A pre-stringified body arrives as a JSON
    // string, every field reads undefined, and the Worker answers 200 — a save
    // that looks like it worked and changed nothing.
    const h = await mountPaths();
    h.board.openFigmaPaths();
    await h.board.saveFigmaDefault(0, btn());
    const sent = h.sent('/figma-paths', 'PUT');
    assert.equal(typeof sent.body, 'object');
    assert.ok(!Array.isArray(sent.body));
    assert.equal(typeof sent.body.team, 'string');
  });

  test('a row index that is not there sends nothing at all', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    await h.board.saveFigmaDefault(99, btn());
    assert.equal(h.sent('/figma-paths', 'PUT'), undefined,
      'a stale row index wrote to a pair it had not read');
  });

  test('adding a default needs both halves of the key', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    withFields(h, { 'fp-new-team': 'Psiphon App', 'fp-new-brand': '', 'fp-new-fkey': 'K', 'fp-new-page': 'x' });
    await h.board.addFigmaDefault(btn());
    assert.equal(h.sent('/figma-paths', 'PUT'), undefined);
    assert.match(h.toasts.join(' '), /team and a brand/);
  });

  test('and sends them when it has them', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    withFields(h, { 'fp-new-team': 'Psiphon App', 'fp-new-brand': 'psiphon',
                    'fp-new-fkey': 'PSI', 'fp-new-page': 'release-version' });
    await h.board.addFigmaDefault(btn());
    const sent = h.sent('/figma-paths', 'PUT');
    assert.deepEqual(
      [sent.body.team, sent.body.brand, sent.body.fileKey, sent.body.page],
      ['Psiphon App', 'psiphon', 'PSI', 'release-version']);
  });

  test('removing a default asks first, and does not send when refused', async () => {
    // It stops every run for that pair. That is the right behaviour and still
    // worth a question before it happens.
    const h = await mountPaths();
    h.board.openFigmaPaths();
    globalThis.window.confirm = () => false;
    await h.board.removeFigmaDefault(0, btn());
    assert.equal(h.sent('/figma-paths', 'DELETE'), undefined);
    delete globalThis.window.confirm;
  });

  test('and sends the pair in the query string when allowed', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    globalThis.window.confirm = () => true;
    await h.board.removeFigmaDefault(0, btn());
    const sent = h.sent('/figma-paths', 'DELETE');
    assert.ok(sent, 'nothing was sent');
    assert.match(sent.url, /team=Forge/);
    assert.match(sent.url, /brand=forge/);
    delete globalThis.window.confirm;
  });

  test('a host with no confirm still removes rather than throwing', async () => {
    // Matches the other destructive control on this board: a bare confirm()
    // takes the handler down where the host has not got one.
    const h = await mountPaths();
    h.board.openFigmaPaths();
    delete globalThis.window.confirm;
    await h.board.removeFigmaDefault(0, btn());
    assert.ok(h.sent('/figma-paths', 'DELETE'), 'the handler threw instead of asking');
  });

  test('a team name with a space survives the URL', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    globalThis.window.confirm = () => true;
    await h.board.removeFigmaDefault(1, btn());
    const sent = h.sent('/figma-paths', 'DELETE');
    assert.match(sent.url, /team=Websites/);
    assert.ok(!sent.url.includes('Psiphon Website'), 'the file name went into the key');
    delete globalThis.window.confirm;
  });
});

describe('Figma paths — the per-card override', () => {
  test('saving an override PATCHes that card', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    withFields(h, { 'fo-fkey-RYV-84': 'CHANGED', 'fo-page-RYV-84': '2027-01' });
    await h.board.saveFigmaOverride('RYV-84', btn());
    const sent = h.sent('/RYV-84/figma', 'PATCH');
    assert.ok(sent, 'nothing was sent');
    assert.deepEqual(sent.body, { fileKey: 'CHANGED', page: '2027-01' });
  });

  test('clearing sends empty fields — there is no separate clear route', async () => {
    // A control that only ever does one thing is how this board grew its
    // ad-hoc buttons. Empty is the way back to the team default.
    const h = await mountPaths();
    h.board.openFigmaPaths();
    await h.board.clearFigmaOverride('RYV-84', btn());
    assert.deepEqual(h.sent('/RYV-84/figma', 'PATCH').body, { fileKey: '', page: '' });
  });

  test('and says the card went back to its default', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    await h.board.clearFigmaOverride('RYV-84', btn());
    assert.match(h.toasts.join(' '), /team default/);
  });

  test('adding an override needs a card', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    withFields(h, { 'fo-new-id': '', 'fo-new-fkey': 'K', 'fo-new-page': '' });
    await h.board.addFigmaOverride(btn());
    assert.equal(h.sent('/figma', 'PATCH'), undefined);
    assert.match(h.toasts.join(' '), /Choose a card/);
  });

  test('and needs something to override it with', async () => {
    // An override of nothing is not an override, and storing one would put a
    // card in the list that behaves exactly like every card not in it.
    const h = await mountPaths();
    h.board.openFigmaPaths();
    withFields(h, { 'fo-new-id': 'RYV-84', 'fo-new-fkey': '  ', 'fo-new-page': '' });
    await h.board.addFigmaOverride(btn());
    assert.equal(h.sent('/figma', 'PATCH'), undefined);
    assert.match(h.toasts.join(' '), /file key or a page/);
  });

  test('a page-only override is allowed — same file, another page', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    withFields(h, { 'fo-new-id': 'RYV-84', 'fo-new-fkey': '', 'fo-new-page': '2026-12' });
    await h.board.addFigmaOverride(btn());
    assert.deepEqual(h.sent('/RYV-84/figma', 'PATCH').body, { fileKey: '', page: '2026-12' });
  });

  test('a card id with a slash in it is encoded', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    await h.board.saveFigmaOverride('ryve/ryv-84/design', btn());
    const sent = h.calls.find((c) => c.method === 'PATCH');
    assert.ok(sent.url.includes('ryve%2Fryv-84%2Fdesign'),
      `an unencoded slash made a different route: ${sent.url}`);
  });
});

describe('Figma paths — loading and failing', () => {
  test('the paths are loaded with the board, not when the editor opens', async () => {
    // The sidebar shows the override count. A badge that appeared a second
    // after you clicked would be a badge you never see.
    const h = await mount({ responses: { '/figma-paths': PATHS } });
    assert.ok(h.calls.length === 0, 'setup should have been cleared');
    h.board.renderSidebar();
    assert.match(h.nodes['sidebar'].innerHTML, /Figma paths/);
  });

  test('a Hub without piece13 does not take the board down', async () => {
    // Same lesson as piece12: losing the whole board over a deploy-ordering
    // mistake is not worth the purity.
    const h = await mount({ responses: { '/figma-paths': { status: 500 } } });
    h.board.renderSidebar();
    assert.match(h.nodes['sidebar'].innerHTML, /All teams/,
      'the sidebar died when Figma paths failed to load');
  });

  test('a response of the wrong shape is refused rather than rendered', async () => {
    // A proxy answering 200 with something unexpected would otherwise replace
    // the lists with undefined and take the sidebar down on the next draw.
    const h = await mount({ responses: { '/figma-paths': { nonsense: true } } });
    h.board.renderSidebar();
    assert.match(h.nodes['sidebar'].innerHTML, /All teams/);
    h.board.openFigmaPaths();
    assert.match(h.nodes['figma-body'].innerHTML, /No defaults yet/);
  });

  test('a failed save says so and does not claim it worked', async () => {
    const h = await mountPaths({ responses: { '/figma-paths': PATHS } });
    h.board.openFigmaPaths();
    // Fail only the write; the read that follows it still answers.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if ((init.method || 'GET') === 'PUT') return { ok: false, status: 400, json: async () => ({}), text: async () => 'fileKey is the key from the Figma URL, not the whole URL' };
      return realFetch(url, init);
    };
    await h.board.saveFigmaDefault(0, btn());
    globalThis.fetch = realFetch;
    assert.match(h.toasts.join(' '), /whole URL/);
  });

  test('the save button is re-enabled after a failure', async () => {
    // Otherwise one rejected save leaves the row dead until a reload.
    const h = await mountPaths();
    h.board.openFigmaPaths();
    const b = btn();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if ((init.method || 'GET') === 'PUT') return { ok: false, status: 400, json: async () => ({}), text: async () => 'no' };
      return realFetch(url, init);
    };
    await h.board.saveFigmaDefault(0, b);
    globalThis.fetch = realFetch;
    assert.equal(b.disabled, false, 'the button stayed disabled after a failed save');
  });

  test('the editor renders both sections it promises', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    const body = h.nodes['figma-body'].innerHTML;
    assert.match(body, /Default paths/);
    assert.match(body, /Individual changes/);
    assert.match(body, /Forge/);
    assert.match(body, /RYV-84/);
  });

  test('a card that already has an override is not offered as a new one', async () => {
    // Otherwise the list offers you a card twice and the second one silently
    // replaces the first.
    const h = await mountPaths({ rows: [card(), card({ id: 'RYV-99' })] });
    h.board.openFigmaPaths();
    const body = h.nodes['figma-body'].innerHTML;
    const picker = body.slice(body.indexOf('fo-new-id'));
    assert.ok(!picker.includes('>RYV-84'), 'a card with an override is offered again');
    assert.ok(picker.includes('RYV-99'), 'a card without one is not offered');
  });

  test('closing the editor does not reload the board', async () => {
    const h = await mountPaths();
    h.board.openFigmaPaths();
    h.calls.length = 0;
    h.board.closeFigmaPaths();
    assert.equal(h.calls.length, 0);
  });
});
