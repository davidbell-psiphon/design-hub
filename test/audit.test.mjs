// Audit cards — flagged by the title, run on a machine you sit at, run again.
//
//   node --test test/audit.test.mjs
//
// A Linear issue whose title has the word "Audit" in it is an audit card. Its
// one stage is `audit`, it runs only on a local machine whose heartbeat names
// the stage — never on GitHub Actions — and, unlike research and design, it
// can be pressed again after it finishes, because "Design audit: Ryve" is a
// standing issue audited over and over. A person still presses the button
// every time; nothing here runs on its own.
//
// Four levels, because the fact is derived at one and acted on at three: the
// title rule in lib/audit.mjs, the `kind` the projection serves, the Worker's
// routes (trigger, queue, stage-done), and what the board draws.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAuditTitle, AUDIT_STAGE } from '../lib/audit.mjs';
import { toWire } from '../lib/card.mjs';
import { stageFromSessionId } from '../lib/session-id.mjs';
import {
  freshDb, env, call, readLinear, issue, stubLinear, session, one, wire, agentPost,
} from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = { 'X-Agent-Secret': 's' };

// ──────────────────────────────────────────────────────────────────────
// The rule
// ──────────────────────────────────────────────────────────────────────

describe('isAuditTitle — the word Audit, whole, any case', () => {
  test('titles with the word are audits', () => {
    assert.equal(isAuditTitle('Design audit: Ryve'), true);
    assert.equal(isAuditTitle('Audit the Conduit onboarding'), true);
    assert.equal(isAuditTitle('AUDIT — Psiphon VPN store page'), true);
    assert.equal(isAuditTitle('Ryve (audit)'), true);
    assert.equal(isAuditTitle('Re-audit the paywall'), true);
  });

  test('the letters inside another word are not the word', () => {
    assert.equal(isAuditTitle('Auditorium seating chart'), false);
    assert.equal(isAuditTitle('Audited flows, archived'), false);
    assert.equal(isAuditTitle('Audits backlog'), false);
    assert.equal(isAuditTitle('Wallet empty state'), false);
  });

  test('nothing is not an audit', () => {
    assert.equal(isAuditTitle(null), false);
    assert.equal(isAuditTitle(undefined), false);
    assert.equal(isAuditTitle(''), false);
  });

  test('the stage is called audit, and a session id can name it', () => {
    assert.equal(AUDIT_STAGE, 'audit');
    assert.equal(stageFromSessionId('ryve/ryv-300/audit'), 'audit');
    assert.equal(stageFromSessionId('RYV-300/audit'), 'audit');
  });
});

// ──────────────────────────────────────────────────────────────────────
// The projection
// ──────────────────────────────────────────────────────────────────────

const card = (o = {}) => ({
  issue_key: 'RYV-300', linear_uuid: 'uuid', title: 'A card', url: 'https://linear.app/x',
  team: 'Ryve App', linear_state: 'unstarted', labels: '[]', linear_project: null,
  linear_read_at: null, brand: 'ryve', track: 'app', figma_url: null,
  dismissed_at: null, set_aside_at: null, description: null,
  updated_at: '2026-10-01 12:00:00', created_at: '2026-10-01 12:00:00', ...o,
});

describe('the wire says it is an audit card, and how its audit stands', () => {
  test('kind is audit for an audit title', () => {
    assert.equal(toWire(card({ title: 'Design audit: Ryve' })).kind, 'audit');
  });

  test('every other card keeps the kind it had', () => {
    assert.equal(toWire(card({ title: 'Auditorium' })).kind, null);
    assert.equal(toWire(card({ title: 'Play Store screenshots' })).kind, 'screenshots');
  });

  test('an audit wins over screenshots — its one stage is the audit', () => {
    assert.equal(toWire(card({ title: 'Audit the store screenshots' })).kind, 'audit');
  });

  test('the audit stage is served under stages, like research and design', () => {
    const w = toWire(card({ title: 'Design audit: Ryve' }), [{
      issue_key: 'RYV-300', stage: 'audit', system: 'design-ai', status: 'done',
      requested_at: null, updated_at: '2026-10-02 09:00:00',
    }]);
    assert.equal(w.stages.audit.status, 'done');
    assert.equal(w.stages.audit.updated_at, '2026-10-02 09:00:00');
  });
});

// ──────────────────────────────────────────────────────────────────────
// The Worker
// ──────────────────────────────────────────────────────────────────────

// A board with one audit card and one ordinary card, read from a stubbed
// Linear, with GitHub dispatches recorded rather than sent.
async function board({ labels = [], mutationError = false } = {}) {
  const db = freshDb();
  const e = env(db, { GITHUB_TOKEN: 't' });
  const mutations = [];
  stubLinear([
    issue({ identifier: 'RYV-300', title: 'Design audit: Ryve', labels }),
    issue({ identifier: 'RYV-84', title: 'Wallet empty state' }),
  ], mutations, { mutationError });
  await readLinear(e);
  const dispatched = [];
  const linear = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.github.com')) {
      dispatched.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    return linear(url, init);
  };
  return { db, e, mutations, dispatched };
}

const press = (e, key, stage) =>
  call(e, 'POST', `/api/agent/session/${key}/trigger`, { stage });

const beat = (e, machine, extra = {}) =>
  call(e, 'POST', '/api/agent/heartbeat',
       { machine, capabilities: ['research', 'design'], ...extra }, SECRET);

const queue = async (e, machine) => (await call(e, 'GET', '/api/agent/queue' +
  (machine === undefined ? '' : `?machine=${encodeURIComponent(machine)}`), undefined, SECRET)).json();

const done = (e, key, stage) =>
  call(e, 'POST', '/api/agent/stage-done', { linear_id: key, stage }, SECRET);

describe('the trigger refuses the wrong stage for the card, both ways', () => {
  test('audit on a card that is not an audit is refused, and queues nothing', async () => {
    const { db, e } = await board();
    const res = await press(e, 'RYV-84', 'audit');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /RYV-84 is not an audit card/);
    assert.equal(session(db, 'RYV-84', 'audit'), undefined);
  });

  test('research or design on an audit card is refused, and queues nothing', async () => {
    const { db, e } = await board();
    for (const stage of ['research', 'design']) {
      const res = await press(e, 'RYV-300', stage);
      assert.equal(res.status, 400, `${stage} was accepted on an audit card`);
      assert.match((await res.json()).error, new RegExp(`RYV-300 is an audit card — its one stage is audit, not ${stage}`));
      assert.equal(session(db, 'RYV-300', stage), undefined);
    }
  });

  test('audit on an audit card is accepted', async () => {
    const { db, e } = await board();
    const res = await press(e, 'RYV-300', 'audit');
    assert.equal(res.status, 200);
    assert.ok(session(db, 'RYV-300', 'audit').requested_at);
  });

  test('research on an ordinary card is untouched', async () => {
    const { e } = await board();
    assert.equal((await press(e, 'RYV-84', 'research')).status, 200);
  });
});

describe('an audit press never fires GitHub Actions', () => {
  test('with no heartbeat at all: queued, not dispatched, and it says it waits on a local runner', async () => {
    const { db, e, dispatched } = await board();
    const body = await (await press(e, 'RYV-300', 'audit')).json();
    assert.equal(body.started, false);
    assert.equal(body.local, true);
    assert.match(body.detail, /queued for a local runner/);
    assert.match(body.detail, /no machine that can run audit has ever checked in/);
    assert.deepEqual(dispatched, [], 'a cloud run was fired for an audit');
    assert.ok(session(db, 'RYV-300', 'audit').requested_at, 'the press itself must still be recorded');
  });

  test('even a cloud runner that claims audit is not dispatched', async () => {
    const { e, dispatched } = await board();
    await beat(e, 'github-actions', { kind: 'ci', capabilities: ['research', 'audit'] });
    const body = await (await press(e, 'RYV-300', 'audit')).json();
    assert.equal(body.started, false);
    assert.deepEqual(dispatched, []);
  });

  test('a cloud runner that declared nothing is not dispatched either', async () => {
    const { e, dispatched } = await board();
    await beat(e, 'github-actions', { kind: 'ci', capabilities: [] });
    await press(e, 'RYV-300', 'audit');
    assert.deepEqual(dispatched, []);
  });

  test('the machine that will take it is named', async () => {
    const { e } = await board();
    await beat(e, 'DaveBellJrII', { kind: 'local', capabilities: ['research', 'design', 'audit'], claim: true });
    const body = await (await press(e, 'RYV-300', 'audit')).json();
    assert.match(body.detail, /audit is reserved for DaveBellJrII, which checked in 0m ago/);
  });

  test('a chosen machine that does not declare audit is said to be the wrong one', async () => {
    const { e } = await board();
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });   // research, design
    await beat(e, 'dave-bell-jr', { kind: 'local', capabilities: ['audit'] });
    const body = await (await press(e, 'RYV-300', 'audit')).json();
    assert.match(body.detail, /reserved for DaveBellJrII, which does not run it — choose dave-bell-jr/);
  });

  test('research still dispatches, and the audit in the queue does not count toward it', async () => {
    const { e, dispatched } = await board();
    await press(e, 'RYV-300', 'audit');
    const body = await (await press(e, 'RYV-84', 'research')).json();
    assert.equal(body.started, true);
    assert.equal(body.local, false);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].inputs.max_issues, '1',
      'the cloud runner was told to take an audit it will never be shown');
  });
});

describe('the queue hands an audit only to a local machine that declared it', () => {
  async function both() {
    const b = await board();
    await press(b.e, 'RYV-300', 'audit');
    await press(b.e, 'RYV-84', 'research');
    return b;
  }
  const stages = (q) => q.map((r) => `${r.id}:${r.requested_stage}`).sort();

  test('a local machine that declares audit is shown it, marked requested_stage audit', async () => {
    const { e } = await both();
    await beat(e, 'DaveBellJrII', { kind: 'local', capabilities: ['research', 'design', 'audit'] });
    const q = await queue(e, 'DaveBellJrII');
    assert.deepEqual(stages(q), ['RYV-300:audit', 'RYV-84:research']);
    const row = q.find((r) => r.id === 'RYV-300');
    assert.equal(row.linear_id, 'RYV-300');
    assert.equal(row.title, 'Design audit: Ryve');
  });

  test('a local machine that does not declare it is not', async () => {
    const { e } = await both();
    await beat(e, 'DaveBellJrII', { kind: 'local' });
    assert.deepEqual(stages(await queue(e, 'DaveBellJrII')), ['RYV-84:research']);
  });

  test('a machine that declared nothing is not — stricter than every other stage', async () => {
    const { e } = await both();
    await beat(e, 'old-runner', { capabilities: [] });
    assert.deepEqual(stages(await queue(e, 'old-runner')), ['RYV-84:research']);
  });

  test('CI is never shown it, even declaring it', async () => {
    const { e } = await both();
    await beat(e, 'github-actions', { kind: 'ci', capabilities: ['research', 'audit'] });
    assert.deepEqual(stages(await queue(e, 'github-actions')), ['RYV-84:research']);
  });

  test('asking without naming a machine, or as one never heard from, does not get it', async () => {
    const { e } = await both();
    assert.deepEqual(stages(await queue(e)), ['RYV-84:research']);
    assert.deepEqual(stages(await queue(e, 'stranger')), ['RYV-84:research']);
  });

  test('the selection still applies: the machine you are not at gets nothing', async () => {
    const { e } = await both();
    await beat(e, 'DaveBellJrII', { kind: 'local', capabilities: ['audit'], claim: true });
    await beat(e, 'laptop', { kind: 'local', capabilities: ['audit'] });
    assert.deepEqual(await queue(e, 'laptop'), []);
    assert.deepEqual(stages(await queue(e, 'DaveBellJrII')), ['RYV-300:audit']);
  });
});

describe('stage-done writes AI-audit done, and the audit can run again', () => {
  test('the label is written to Linear and locally, and the queue entry cleared', async () => {
    const { db, e, mutations } = await board();
    await press(e, 'RYV-300', 'audit');
    const res = await done(e, 'RYV-300', 'audit');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).label, 'AI-audit done');
    assert.ok(mutations.some((m) => /issueAddLabel/.test(m)), 'nothing was written to Linear');
    assert.deepEqual(JSON.parse(one(db, 'RYV-300').labels), ['AI-audit done']);
    const s = session(db, 'RYV-300', 'audit');
    assert.equal(s.status, 'done');
    assert.equal(s.requested_at, null);
  });

  test('the runner\'s own posts land on the audit session', async () => {
    const { db, e } = await board();
    await press(e, 'RYV-300', 'audit');
    await agentPost(e, { session_id: 'ryve/ryv-300/audit', system: 'design-ai', status: 'active' });
    assert.equal(session(db, 'RYV-300', 'audit').status, 'active');
    assert.equal(session(db, 'RYV-300', 'research'), undefined);
  });

  test('pressed again after it finished, it queues again, and finishes again', async () => {
    const { db, e } = await board();
    await press(e, 'RYV-300', 'audit');
    await done(e, 'RYV-300', 'audit');

    const again = await press(e, 'RYV-300', 'audit');
    assert.equal(again.status, 200, 'a finished audit could not be run again');
    assert.ok(session(db, 'RYV-300', 'audit').requested_at);
    assert.equal(wire(db, 'RYV-300').requested_stage, 'audit');

    const second = await done(e, 'RYV-300', 'audit');
    assert.equal(second.status, 200, 'the second finish failed on a label that already exists');
    assert.deepEqual(JSON.parse(one(db, 'RYV-300').labels), ['AI-audit done'],
      'the label was written twice');
    assert.equal(session(db, 'RYV-300', 'audit').requested_at, null);
  });

  test('if Linear refuses a label the issue already carries, the finish still stands', async () => {
    const { db, e } = await board({ labels: [{ name: 'AI-audit done' }], mutationError: true });
    await press(e, 'RYV-300', 'audit');
    const res = await done(e, 'RYV-300', 'audit');
    assert.equal(res.status, 200);
    assert.equal(session(db, 'RYV-300', 'audit').requested_at, null);
  });

  test('a refused label the issue does NOT carry still fails and stays queued, as before', async () => {
    const { db, e } = await board({ mutationError: true });
    await press(e, 'RYV-84', 'research');
    const res = await done(e, 'RYV-84', 'research');
    assert.equal(res.status, 502);
    assert.ok(session(db, 'RYV-84', 'research').requested_at);
  });

  test('the audit has no skip', async () => {
    const { db, e, mutations } = await board();
    const res = await call(e, 'POST', '/api/agent/session/RYV-300/skip', { stage: 'audit' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /audit cannot be skipped/);
    assert.deepEqual(JSON.parse(one(db, 'RYV-300').labels), []);
    assert.equal(mutations.length, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// board-logic.js
// ──────────────────────────────────────────────────────────────────────

const logic = vm.createContext({ Date, Math, isNaN, String });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), logic);
const { isAudit, actionFor, actionsFor, stageLabel, lastAuditAt, nobodyComing, stageOf } = logic;

const row = (o = {}) => ({
  kind: null, linear_state: 'unstarted', requested_stage: null, stages: {},
  ...o, labels: JSON.stringify(o.labels || []),
});
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

describe('the board offers the audit, and only on an audit card', () => {
  test('an audit card offers Run audit, and nothing else', () => {
    const r = row({ kind: 'audit' });
    same(actionFor(r), { stage: 'audit', label: 'Run audit' });
    assert.equal(actionsFor(r).length, 1, 'an audit card offered a skip');
  });

  test('once audited, it offers Run audit again — the button does not go away', () => {
    same(actionFor(row({ kind: 'audit', labels: ['AI-audit done'] })),
         { stage: 'audit', label: 'Run audit again' });
    same(actionFor(row({ kind: 'audit', stages: { audit: { status: 'done' } } })),
         { stage: 'audit', label: 'Run audit again' });
  });

  test('an audit card never offers research or design, whatever labels it carries', () => {
    for (const labels of [[], ['AI-research done'], ['AI-design done'], ['no-research']]) {
      for (const a of actionsFor(row({ kind: 'audit', labels }))) {
        assert.equal(a.stage, 'audit', `an audit card with ${labels} offered ${a.stage}`);
      }
    }
  });

  test('an ordinary card never offers the audit, and research/design are as they were', () => {
    same(actionFor(row()), { stage: 'research', label: 'Run Research' });
    assert.equal(actionsFor(row())[1].label, 'Skip to Design');
    same(actionFor(row({ labels: ['AI-research done'] })), { stage: 'design', label: 'Run Design' });
    assert.equal(actionFor(row({ labels: ['AI-design done'] })), null,
      'design finished and the card offered something again');
    // An AI-audit done label on an ordinary card changes nothing.
    assert.equal(stageOf(row({ labels: ['AI-audit done'] })), 'backlog');
    same(actionFor(row({ labels: ['AI-audit done'] })), { stage: 'research', label: 'Run Research' });
  });

  test('the flag is read from the wire, not re-derived from the title', () => {
    assert.equal(isAudit(row({ title: 'Design audit: Ryve' })), false);
    assert.equal(isAudit(row({ kind: 'audit' })), true);
  });

  test('the pill says whether it has been audited', () => {
    assert.equal(stageLabel(row({ kind: 'audit' })), 'Not audited');
    assert.equal(stageLabel(row({ kind: 'audit', labels: ['AI-audit done'] })), 'Audited');
  });

  test('when it last ran is the finish, and only while nothing is queued', () => {
    const fin = { status: 'done', requested_at: null, updated_at: '2026-10-02 09:00:00' };
    assert.equal(lastAuditAt(row({ kind: 'audit', stages: { audit: fin } })), '2026-10-02 09:00:00');
    assert.equal(lastAuditAt(row({ kind: 'audit', stages: { audit: { ...fin, requested_at: '2026-10-03 10:00:00' } } })), '');
    assert.equal(lastAuditAt(row({ kind: 'audit', stages: { audit: { ...fin, status: 'active' } } })), '');
    assert.equal(lastAuditAt(row({ kind: 'audit' })), '');
  });
});

describe('a stalled audit names the machine it waits on', () => {
  const NOW = Date.parse('2026-10-16T16:30:00Z');
  const at = (iso) => iso.replace('T', ' ').replace('Z', '');
  const audit = { id: 'RYV-300', requested_stage: 'audit', requested_at: at('2026-10-16T15:00:00Z') };

  test('with no heartbeats at all it still says nobody is coming', () => {
    assert.match(nobodyComing(audit, [], NOW), /no machine that can run audit has ever checked in/);
  });

  test('a machine that declared nothing does not count as able', () => {
    const old = { machine: 'old', kind: 'local', capabilities: [], last_seen: at('2026-10-16T16:29:00Z') };
    assert.match(nobodyComing(audit, [old], NOW), /no machine that can run audit/);
  });

  test('a cloud runner is never the answer', () => {
    const ci = { machine: 'github-actions', kind: 'ci', capabilities: ['audit'], last_seen: at('2026-10-16T16:29:00Z') };
    const asleep = { machine: 'DaveBellJrII', kind: 'local', capabilities: ['audit'],
                     last_seen: at('2026-10-15T16:30:00Z') };
    assert.match(nobodyComing(audit, [ci, asleep], NOW), /DaveBellJrII last checked in 24h ago/);
  });

  test('an awake machine that declares it makes it a real stall', () => {
    const awake = { machine: 'DaveBellJrII', kind: 'local', capabilities: ['audit'], last_seen: at('2026-10-16T16:25:00Z') };
    assert.equal(nobodyComing(audit, [awake], NOW), null);
  });
});

// ──────────────────────────────────────────────────────────────────────
// What the board draws, and what the press says
// ──────────────────────────────────────────────────────────────────────

const wireRow = (o) => ({
  id: o.linear_id, linear_id: o.linear_id, system: 'design-ai',
  project: 'ryve', track: 'app', phase: null, status: null,
  title: o.title || o.linear_id, updated_at: null, requested_at: null, prompt: null,
  team: 'Ryve App', linear_project: null, set_aside_at: null, options: null,
  linear_state: 'unstarted', labels: JSON.stringify(o.labels || []),
  kind: o.kind === undefined ? null : o.kind,
  requested_stage: null, dismissed_at: null,
  linear_uuid: 'uuid-' + o.linear_id, url: 'https://linear.app/x', stages: o.stages || {},
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

async function mount(rows, triggerAnswer = { ok: true }) {
  const html = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8');
  const inline = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const nodes = {};
  const sent = [];
  globalThis.document = { getElementById: id => (nodes[id] = nodes[id] || stubEl()) };
  globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener: () => {}, scrollTo: () => {} };
  globalThis.fetch = async (url, init) => {
    sent.push({ url, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      json: async () => {
        if (url.endsWith('/trigger')) return triggerAnswer;
        if (url.endsWith('/brands')) return [{ id: 'ryve', name: 'Ryve', color: '#206CCC' }];
        if (url.endsWith('/reader/teams')) return { selected: [], available: ['Ryve App'], source: 'linear', all: true };
        if (url.endsWith('/runner')) return { repo: 'x/design-ai', workflow: 'design-ai.yml', url: 'https://github.com/x' };
        if (url.endsWith('/agent/heartbeat')) return [];
        return rows;
      },
    };
  };
  const run = new Function(src + '\n' + inline + '\n;return { loadBoard, triggerSession };');
  const api = run();
  await api.loadBoard();
  return { board: nodes['board'].innerHTML, nodes, sent, api };
}

const cardOf = (board, id) => {
  const at = board.indexOf(`<span class="session-id">${id}</span>`);
  assert.ok(at >= 0, `${id} is not on the board`);
  const start = board.lastIndexOf('<div class="session-card', at);
  const next = board.indexOf('<div class="session-card', at + 1);
  return board.slice(start, next === -1 ? undefined : next);
};

describe('the board draws the Audit button on audit cards only', () => {
  const recent = new Date(Date.now() - 3 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  let board;
  before(async () => {
    ({ board } = await mount([
      wireRow({ linear_id: 'RYV-300', title: 'Design audit: Ryve', kind: 'audit' }),
      wireRow({ linear_id: 'RYV-301', title: 'Audit the Conduit onboarding', kind: 'audit',
                labels: ['AI-audit done'],
                stages: { audit: { stage: 'audit', status: 'done', requested_at: null, updated_at: recent } } }),
      wireRow({ linear_id: 'RYV-84', title: 'Wallet empty state' }),
      wireRow({ linear_id: 'RYV-85', title: 'Auditorium map' }),
    ]));
  });

  test('an audit card carries the chip, the edge, and the Run audit button', () => {
    const c = cardOf(board, 'RYV-300');
    assert.match(c, /session-card state-\w+ kind-audit/);
    assert.match(c, /<span class="kind-pill kind-pill-audit"[^>]*>Audit<\/span>/);
    assert.match(c, /triggerSession\('RYV-300', 'audit', this\)"\s*>Run audit</);
    assert.doesNotMatch(c, /Run Research|Run Design|Skip to/);
  });

  test('it keeps every other control a card has', () => {
    const c = cardOf(board, 'RYV-300');
    assert.match(c, />Dismiss</);
    assert.match(c, />Mark done</);
    assert.match(c, />No design</);
    assert.match(c, />Linear ↗</);
  });

  test('an audited card offers Run audit again, and says when it last ran', () => {
    const c = cardOf(board, 'RYV-301');
    assert.match(c, /triggerSession\('RYV-301', 'audit', this\)"\s*>Run audit again</);
    assert.match(c, /last audit 3d ago/);
    assert.match(c, /<span class="stage-pill">Audited<\/span>/);
  });

  test('an ordinary card has no audit anywhere on it', () => {
    for (const id of ['RYV-84', 'RYV-85']) {
      const c = cardOf(board, id);
      assert.doesNotMatch(c, /kind-audit|'audit'|Run audit/, `${id} offered the audit`);
      assert.match(c, />Run Research</);
    }
  });

  test('the audit kind has its own token, distinct from every run state', () => {
    const css = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');
    const m = css.match(/--kind-audit:\s*(#[0-9a-f]{6})/i);
    assert.ok(m, 'no --kind-audit token');
    for (const run of ['error', 'stalled', 'working', 'waiting', 'done']) {
      const r = css.match(new RegExp(`--run-${run}:\\s*(#[0-9a-f]{6})`, 'i'))[1];
      assert.notEqual(m[1].toLowerCase(), r.toLowerCase(), `the audit colour is the same as --run-${run}`);
    }
  });
});

describe('the press says it is queued for a local runner', () => {
  test('it asks for the audit, and the toast says where it waits', async () => {
    const h = await mount([wireRow({ linear_id: 'RYV-300', title: 'Design audit: Ryve', kind: 'audit' })], {
      ok: true, requested: 'audit', started: false, local: true,
      detail: 'nothing was started: audit runs only on a local machine that declares it, so it is queued for a local runner.',
    });
    await h.api.triggerSession('RYV-300', 'audit', stubEl());
    const post = h.sent.find((c) => c.url.endsWith('/trigger'));
    assert.equal(post.method, 'POST');
    assert.equal(post.body.stage, 'audit');
    assert.match(h.nodes['toast'].textContent, /^Audit requested — queued for a local runner\./);
    assert.doesNotMatch(h.nodes['toast'].textContent, /did not start/);
  });
});
