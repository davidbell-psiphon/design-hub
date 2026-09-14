// One card per Linear issue — the Worker and the schema files, run for real.
//
//   node --test test/session.test.mjs
//
// No network and no dependencies: node:sqlite stands in for D1 behind a shim
// with the same prepare/bind/first/all/run shape, and Linear is a stubbed
// fetch. That means these exercise the actual SQL that ships — the reader's
// upsert, the agent's merge, and piece6-schema.sql itself — rather than a
// paraphrase of it, which is the only way to catch the id mismatch that put
// two rows on the board for one issue.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The schema as the live database got it: additive pieces, in order. The gate
// migration is last because that is the order it was applied in, and applying
// them in order is half of what this suite checks.
const PIECES = ['agent-schema.sql', 'reader-schema.sql', 'track-schema.sql',
                'piece4-schema.sql', 'piece5-schema.sql', 'piece6-schema.sql',
                'piece7-schema.sql', 'migration-001-gates.sql'];

// Comments first, then split on statement boundaries — that order matters,
// because one piece4 comment has a semicolon in it. Safe here because none of
// the pieces put a `--` or a `;` inside a string literal.
function statements(sql) {
  return sql.replace(/--[^\n]*/g, '')
            .split(';')
            .map(s => s.trim())
            .filter(Boolean);
}

function applyPieces(db, pieces) {
  for (const file of pieces) {
    for (const stmt of statements(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      db.exec(stmt);
    }
  }
}

// piece4-schema.sql sets the brand colours, so `projects` has to exist for it
// to apply verbatim — which is worth keeping, since applying every piece in
// order is half of what this suite checks.
function freshDb(pieces = PIECES) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, color TEXT,
             section_id TEXT, sort_order INTEGER)`);
  applyPieces(db, pieces);
  return db;
}

// D1's binding surface, over node:sqlite.
function d1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const run = (args) => {
        const r = stmt.run(...args);
        return { success: true, meta: { changes: r.changes } };
      };
      const api = (args) => ({
        bind: (...more) => api([...args, ...more]),
        first: async () => stmt.get(...args) ?? null,
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => run(args),
      });
      return api([]);
    },
  };
}

// worker/index.js is ESM with a .js extension, and this repo has no
// package.json to say so — so load it as a data: URL with its relative imports
// rewritten to absolute ones. Same source the Worker ships.
async function loadWorker() {
  const src = fs.readFileSync(path.join(ROOT, 'worker/index.js'), 'utf8')
    .replace(/from '\.\.\/lib\/([^']+)'/g,
             (_, f) => `from '${new URL('lib/' + f, 'file:///' + ROOT.replace(/\\/g, '/') + '/')}'`);
  return (await import('data:text/javascript,' + encodeURIComponent(src))).default;
}

const worker = await loadWorker();

// A Linear issue as the reader's GraphQL query returns it.
const issue = (o) => ({
  id: o.uuid || 'uuid-' + o.identifier,
  identifier: o.identifier,
  title: o.title || o.identifier + ' title',
  description: o.description || 'A Linear description.',
  url: 'https://linear.app/x/issue/' + o.identifier,
  assignee: { name: 'Dave Bell' },
  project: null,
  labels: { nodes: o.labels || [] },
  team: { name: o.team || 'Ryve App' },
  state: { type: o.state || 'unstarted' },
});

// Stub Linear: the reader's discovery query gets issues, reconciliation gets
// the same states back, and label mutations always succeed.
function stubLinear(issues, mutations) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const q = body.query;
    // Optional recorder, so a test can assert that a route wrote nothing to
    // Linear — which is the whole contract of the trigger button now.
    if (mutations && /^\s*mutation/.test(q)) mutations.push(q.trim().split('\n')[0]);
    if (/DesignReaderIssues/.test(q)) {
      return { ok: true, json: async () => ({ data: { issues: { nodes: issues } } }) };
    }
    if (/Reconcile/.test(q)) {
      const ids = body.variables.ids;
      return { ok: true, json: async () => ({ data: { issues: { nodes:
        issues.filter(i => ids.includes(i.id))
              .map(i => ({ id: i.id, state: i.state, labels: i.labels })) } } }) };
    }
    if (/issueLabels/.test(q)) {
      return { ok: true, json: async () => ({ data: { issueLabels: { nodes: [{ id: 'label-1' }] } } }) };
    }
    return { ok: true, json: async () => ({ data: { issueAddLabel: { success: true },
                                                    issueRemoveLabel: { success: true } } }) };
  };
}

const env = (db) => ({ DB: d1(db), LINEAR_API_KEY: 'k', AGENT_SECRET: 's' });

function call(e, method, path, body, headers = {}) {
  return worker.fetch(new Request('https://hub.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
}

const agentPost = (e, body) =>
  call(e, 'POST', '/api/agent/session', body, { 'X-Agent-Secret': 's' });

const readLinear = (e) => call(e, 'POST', '/api/read-linear');

const rows = (db) => db.prepare(
  `SELECT * FROM agent_sessions ORDER BY id`).all();

// Options as stored (JSON) or as a read hands them back (an array).
const parseOpts = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : (raw || []));

// The agent's session id for a Linear issue, exactly as design-ai posts it.
const AGENT_ID = 'ryve/ryv-84/research';
const AGENT_BODY = {
  session_id: AGENT_ID, system: 'design-ai', brand: 'ryve', stage: 'research',
  status: 'waiting', prompt: 'Two directions for the wallet header — which?',
  detail: 'Direction A keeps the balance card. Direction B drops it.'.repeat(4),
};

describe('the schema pieces apply in order', () => {
  test('every piece applies to a clean database', () => {
    const db = freshDb();
    const cols = db.prepare(`PRAGMA table_info(agent_sessions)`).all().map(c => c.name);
    for (const c of ['linear_id', 'track', 'linear_uuid', 'dismissed_at', 'agent_session_id',
                     'options', 'response_option_id', 'response_note', 'gate_round',
                     'mockups_url', 'mockups_at', 'handoff_at']) {
      assert.ok(cols.includes(c), `${c} missing`);
    }
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'gate_decisions'`).get(),
              'gate_decisions missing');
  });

  test('re-running piece6 fails on the duplicate column rather than destroying data', () => {
    const db = freshDb();
    assert.throws(() => applyPieces(db, ['piece6-schema.sql']), /duplicate column/i);
  });
});

describe('reader first, then the agent posts', () => {
  test('the agent post lands on the Linear card, not beside it', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    assert.equal(rows(db).length, 1);

    const res = await agentPost(e, AGENT_BODY);
    assert.equal(res.status, 200);

    const all = rows(db);
    assert.equal(all.length, 1, 'the agent post added a second row');
    const r = all[0];
    assert.equal(r.id, 'linear/RYV-84');
    assert.equal(r.agent_session_id, AGENT_ID);
    // Agent state on the card…
    assert.equal(r.phase, 'research');
    assert.equal(r.status, 'waiting');
    assert.equal(r.prompt, AGENT_BODY.prompt);
    // …and the Linear identity kept.
    assert.equal(r.linear_id, 'RYV-84');
    assert.equal(r.linear_uuid, 'uuid-RYV-84');
    assert.equal(r.title, 'RYV-84 title');
    assert.equal(r.url, 'https://linear.app/x/issue/RYV-84');
  });

  test('a later read keeps one row and does not wipe the agent state', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await agentPost(e, { ...AGENT_BODY, figma_url: 'https://figma.com/f/1' });
    await readLinear(e);

    const all = rows(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].phase, 'research');
    assert.equal(all[0].status, 'waiting');
    assert.equal(all[0].prompt, AGENT_BODY.prompt);
    assert.equal(all[0].detail, AGENT_BODY.detail);
    assert.equal(all[0].figma_url, 'https://figma.com/f/1');
  });

  test('a manual brand reassignment survives the agent post', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84', team: 'Websites' })]);
    await readLinear(e);
    await call(e, 'PATCH', '/api/agent/session/linear%2FRYV-84/reassign', { project: 'forge' });
    await agentPost(e, AGENT_BODY);  // posts brand 'ryve'
    assert.equal(rows(db)[0].project, 'forge');
  });
});

describe('the agent posts first, then the reader discovers the issue', () => {
  test('the read merges onto the agent row instead of adding a card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);

    await agentPost(e, AGENT_BODY);
    assert.equal(rows(db).length, 1);
    assert.equal(rows(db)[0].id, AGENT_ID);

    await readLinear(e);
    const all = rows(db);
    assert.equal(all.length, 1, 'the reader added a second row');
    assert.equal(all[0].id, AGENT_ID);
    assert.equal(all[0].linear_id, 'RYV-84');
    assert.equal(all[0].linear_uuid, 'uuid-RYV-84');
    assert.equal(all[0].title, 'RYV-84 title');
    assert.equal(all[0].phase, 'research');
  });
});

describe('the agent still addresses its own session id', () => {
  test('the poll route resolves the alias to the merged card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await agentPost(e, AGENT_BODY);

    const res = await call(e, 'GET', '/api/agent/session/' + encodeURIComponent(AGENT_ID),
                           undefined, { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.linear_id, 'RYV-84');
    assert.equal(body.agent_session_id, AGENT_ID);
  });

  test('a response written through the alias reaches the same row', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await agentPost(e, AGENT_BODY);

    const res = await call(e, 'PATCH',
      '/api/agent/session/' + encodeURIComponent(AGENT_ID) + '/respond',
      { response: 'Direction B' });
    assert.equal(res.status, 200);
    assert.equal(rows(db)[0].response, 'Direction B');
    assert.equal(rows(db)[0].status, 'active');
  });

  test('the trigger works through either id and queues the one card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await agentPost(e, AGENT_BODY);

    const res = await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent(AGENT_ID) + '/trigger', { stage: 'research' });
    assert.equal(res.status, 200);
    const all = rows(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].requested_stage, 'research');
  });

  test('the trigger applies no Linear label — the Hub owns the queue now', async () => {
    // The whole point of piece 7: pressing a button must not write to Linear.
    const db = freshDb();
    const e = env(db);
    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84' })], mutations);
    await readLinear(e);
    await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/trigger',
      { stage: 'research' });
    assert.equal(mutations.length, 0, 'the trigger mutated Linear: ' + mutations.join(', '));
  });

  test('an unknown stage is refused', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    const res = await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/trigger', { stage: 'go' });
    assert.equal(res.status, 400);
  });

  test('a card already queued is not queued twice', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    const id = '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/trigger';
    assert.equal((await call(e, 'POST', id, { stage: 'research' })).status, 200);
    assert.equal((await call(e, 'POST', id, { stage: 'design' })).status, 409);
    assert.equal(rows(db)[0].requested_stage, 'research');
  });

  test('the reader collects design teams only', async () => {
    // Every Backlog/Todo issue assigned to Dave used to reach the board,
    // Marketing included, which buried the design work under campaign issues.
    const db = freshDb();
    const e = env(db);
    stubLinear([
      issue({ identifier: 'RYV-84' }),                              // Ryve App
      issue({ identifier: 'CON-116', team: 'Conduit App' }),
      issue({ identifier: 'WEB-265', team: 'Websites' }),
      issue({ identifier: 'MAR-980', team: 'Marketing' }),          // out of scope
      issue({ identifier: 'STO-421', team: 'Sysadmin' }),           // out of scope
    ]);
    const result = await (await readLinear(e)).json();
    const ids = rows(db).map(r => r.linear_id).sort();
    assert.deepEqual(ids, ['CON-116', 'RYV-84', 'WEB-265']);
    assert.equal(result.skipped, 2);
  });

  test('the queue is what the runner reads, oldest request first', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' }),
                issue({ identifier: 'CON-116', team: 'Conduit App' })]);
    await readLinear(e);
    await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/trigger',
      { stage: 'research' });

    const res = await call(e, 'GET', '/api/agent/queue', undefined, { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 200);
    const queue = await res.json();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].linear_id, 'RYV-84');
    assert.equal(queue[0].requested_stage, 'research');
  });

  test('stage-done labels the issue, clears the queue and moves the card', async () => {
    const db = freshDb();
    const e = env(db);
    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84' })], mutations);
    await readLinear(e);
    await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/trigger',
      { stage: 'research' });

    const res = await call(e, 'POST', '/api/agent/stage-done',
      { linear_id: 'RYV-84', stage: 'research' }, { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 200);

    const row = rows(db)[0];
    assert.equal(row.requested_stage, null, 'still queued after reporting done');
    // Written locally as well as in Linear: the reader only runs twice a week,
    // and without this the card sits in the wrong column until it next does.
    assert.ok(JSON.parse(row.labels).includes('AI-research done'),
              'the done label was not recorded on the row');
    assert.ok(mutations.length >= 1, 'no Linear label was applied');
  });

  test('a later phase posted as its own session is the same card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await agentPost(e, AGENT_BODY);

    // The design phase, posted and polled under a session id the Hub has
    // never seen. It is still RYV-84's card.
    const res = await call(e, 'GET', '/api/agent/session/' + encodeURIComponent('ryve/ryv-84/design'),
                           undefined, { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).linear_id, 'RYV-84');

    await agentPost(e, { ...AGENT_BODY, session_id: 'ryve/ryv-84/design', stage: 'design' });
    const all = rows(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].phase, 'design');
    assert.equal(all[0].agent_session_id, 'ryve/ryv-84/design');
  });

  test('an unknown id is still a 404', async () => {
    const db = freshDb();
    const e = env(db);
    const res = await call(e, 'GET', '/api/agent/session/nope', undefined,
                           { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 404);
  });
});

describe('sessions with no Linear issue behind them', () => {
  test('a Hub-only session inserts and updates exactly as before', async () => {
    const db = freshDb();
    const e = env(db);
    const id = 'conduit/wallet-flow/design';
    await agentPost(e, { session_id: id, system: 'social-ai', brand: 'conduit',
                         stage: 'design', status: 'active', title: 'Wallet flow' });
    assert.equal(rows(db).length, 1);
    assert.equal(rows(db)[0].id, id);
    assert.equal(rows(db)[0].linear_id, null);

    await agentPost(e, { session_id: id, system: 'social-ai', brand: 'conduit',
                         stage: 'qa', status: 'waiting', prompt: 'Ship it?' });
    const all = rows(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].phase, 'qa');
    assert.equal(all[0].status, 'waiting');
    assert.equal(all[0].system, 'social-ai');
  });

  test('two issues stay two cards', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' }), issue({ identifier: 'CON-116', team: 'Conduit App' })]);
    await readLinear(e);
    await agentPost(e, AGENT_BODY);
    await agentPost(e, { ...AGENT_BODY, session_id: 'conduit/con-116/design', stage: 'design' });
    const all = rows(db);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map(r => r.linear_id).sort(), ['CON-116', 'RYV-84']);
  });
});


// ─── CONSTRAINED GATE DECISIONS ────────────────────
// The bug these close: a three-option question was answered "Yes". "Yes" names
// none of the three, the client still reported a decision, and the agent was
// left to pick a direction itself. Everything below is about the answer naming
// one of the options that were actually offered.

const OPTIONS = [
  { id: 'd1', label: 'Icon-only corner button', summary: '48x48 circular + at the corner.' },
  { id: 'd2', label: 'Labelled corner control', summary: 'Costs card width.' },
  { id: 'd3', label: 'Collection-level add row', summary: 'Leaves the corner empty.' },
];
const GATE = { ...AGENT_BODY, status: 'waiting', options: OPTIONS };

const respond = (e, id, body) =>
  call(e, 'PATCH', '/api/agent/session/' + encodeURIComponent(id) + '/respond', body);
const reopen = (e, id, body) =>
  call(e, 'PATCH', '/api/agent/session/' + encodeURIComponent(id) + '/reopen', body);
const setState = (e, id, body) =>
  call(e, 'PATCH', '/api/agent/session/' + encodeURIComponent(id) + '/state', body);
const decisions = (db) => db.prepare(`SELECT * FROM gate_decisions ORDER BY id`).all();
const only = (db) => rows(db)[0];

// A Linear card with a gate posted against it, reached through the agent's own
// session id — the same path everything else in this file uses.
async function gated(body = GATE) {
  const db = freshDb();
  const e = env(db);
  stubLinear([issue({ identifier: 'RYV-84' })]);
  await readLinear(e);
  const res = await agentPost(e, body);
  assert.equal(res.status, 200, await res.clone().text());
  return { db, e };
}

describe('posting a gate', () => {
  test('options are stored, and read back as an array rather than a blob', async () => {
    const { db, e } = await gated();
    assert.equal(typeof only(db).options, 'string', 'the column should hold JSON');

    const res = await call(e, 'GET', '/api/agent/session/' + encodeURIComponent(AGENT_ID),
                           undefined, { 'X-Agent-Secret': 's' });
    const body = await res.json();
    assert.equal(Array.isArray(body.options), true, 'options came back as a string');
    assert.deepEqual(body.options.map(o => o.id), ['d1', 'd2', 'd3']);
    assert.equal(body.options[1].label, 'Labelled corner control');
  });

  test('options that cannot be answered are refused at post time', async () => {
    const db = freshDb();
    const e = env(db);
    const bad = async (options) => {
      const res = await agentPost(e, { ...GATE, options });
      assert.equal(res.status, 400, JSON.stringify(options));
      return (await res.json()).error;
    };
    await bad('d1, d2, d3');                              // not an array
    await bad([]);                                        // nothing to choose
    await bad([{ label: 'No id' }]);                      // no id to answer with
    await bad([{ id: 'd1' }]);                            // no label to show
    await bad([{ id: 'd1', label: 'A' }, { id: 'd1', label: 'B' }]);  // ambiguous
    await bad([{ id: "d1' onclick='x", label: 'A' }]);    // not an opaque token
    assert.equal(rows(db).length, 0, 'a refused gate should write nothing');
  });

  test('a later post without options leaves the question standing', async () => {
    const { db, e } = await gated();
    await agentPost(e, { ...AGENT_BODY, status: 'active', detail: 'Still working.' });
    assert.equal(parseOpts(only(db).options).length, 3, 'the options were wiped');
  });
});

describe('answering a gate', () => {
  test('a note on its own is not a decision', async () => {
    const { db, e } = await gated();
    const res = await respond(e, AGENT_ID, { response_note: 'Yes' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /response_option_id or response_section required/);
    assert.equal(only(db).response_option_id, null);
    assert.equal(only(db).status, 'waiting', 'a rejected answer must not start the agent');
  });

  test('free text on its own is not a decision either — this is the "Yes" bug', async () => {
    const { db, e } = await gated();
    const res = await respond(e, AGENT_ID, { response: 'Yes' });
    assert.equal(res.status, 400);
    assert.equal(only(db).response, null);
    assert.equal(only(db).status, 'waiting');
  });

  test('an id that names no option is refused', async () => {
    const { db, e } = await gated();
    const res = await respond(e, AGENT_ID, { response_option_id: 'd9' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /d1, d2, d3/);
    assert.equal(only(db).response_option_id, null);
  });

  test('a valid id is accepted, and the answer comes back in words', async () => {
    const { db, e } = await gated();
    const res = await respond(e, AGENT_ID, {
      response_option_id: 'd2', response_note: 'but tighten the label copy',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).response_label, 'Labelled corner control');

    const r = only(db);
    assert.equal(r.response_option_id, 'd2');
    assert.equal(r.response_note, 'but tighten the label copy');
    // The old column carries the answer in words, copied off the option.
    assert.equal(r.response, 'Labelled corner control');
    assert.equal(r.status, 'active');
    assert.ok(r.responded_at);
  });

  test('the chosen label rides alongside the id on every read', async () => {
    const { e } = await gated();
    await respond(e, AGENT_ID, { response_option_id: 'd2' });

    const one = await (await call(e, 'GET', '/api/agent/session/' + encodeURIComponent(AGENT_ID),
                                  undefined, { 'X-Agent-Secret': 's' })).json();
    assert.equal(one.response_label, 'Labelled corner control');

    const list = await (await call(e, 'GET', '/api/agent/sessions')).json();
    assert.equal(list[0].response_label, 'Labelled corner control');
    assert.equal(Array.isArray(list[0].options), true);
  });

  test('a gate with no options is still answered in free text', async () => {
    // No backfill: every session posted before the contract changed keeps
    // working exactly as it did.
    const { db, e } = await gated(AGENT_BODY);
    const res = await respond(e, AGENT_ID, { response: 'Direction B' });
    assert.equal(res.status, 200);
    assert.equal(only(db).response, 'Direction B');
    assert.equal(only(db).response_option_id, null);
    assert.equal(only(db).status, 'active');
  });

  test('a free-text gate still requires something to be said', async () => {
    const { e } = await gated(AGENT_BODY);
    assert.equal((await respond(e, AGENT_ID, {})).status, 400);
  });
});

describe('reopening a gate', () => {
  test('the round is archived, the decision clears, and it waits again', async () => {
    const { db, e } = await gated();
    await respond(e, AGENT_ID, { response_option_id: 'd2', response_note: 'tighten the copy' });

    const res = await reopen(e, AGENT_ID, { note: 'Both collide with the Wallet Connect pill.' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).gate_round, 2);

    const r = only(db);
    assert.equal(r.status, 'waiting');
    assert.equal(r.gate_round, 2);
    assert.equal(r.response_option_id, null);
    assert.equal(r.response_note, null);
    assert.equal(r.response, null);
    assert.equal(r.responded_at, null);

    // The first round survives, with what was offered and what was chosen.
    const history = decisions(db);
    assert.equal(history.length, 1);
    assert.equal(history[0].gate_round, 1);
    assert.equal(history[0].response_option_id, 'd2');
    assert.deepEqual(parseOpts(history[0].options_snapshot).map(o => o.id), ['d1', 'd2', 'd3']);
    assert.match(history[0].response_note, /tighten the copy/);
    assert.match(history[0].response_note, /Wallet Connect pill/);
  });

  test('the agent posts a fresh round onto the reopened gate', async () => {
    const { db, e } = await gated();
    await respond(e, AGENT_ID, { response_option_id: 'd2' });
    await reopen(e, AGENT_ID, { note: 'Revise.' });

    const round2 = [{ id: 'r1', label: 'Pill above the card' },
                    { id: 'r2', label: 'Pill inside the header' }];
    await agentPost(e, { ...GATE, options: round2 });
    assert.deepEqual(parseOpts(only(db).options).map(o => o.id), ['r1', 'r2']);
    assert.equal(only(db).gate_round, 2);

    // And the ids of the new round are the only ones it will take.
    assert.equal((await respond(e, AGENT_ID, { response_option_id: 'd2' })).status, 400);
    assert.equal((await respond(e, AGENT_ID, { response_option_id: 'r1' })).status, 200);
    assert.equal(only(db).response, 'Pill above the card');
  });

  test('a reopen always leaves a trail', async () => {
    // Nothing decided and no reason given records nothing at all, which is
    // how a gate reopens and the agent re-asks the same question.
    const { db, e } = await gated();
    const bare = await reopen(e, AGENT_ID, undefined);
    assert.equal(bare.status, 400);
    assert.match((await bare.json()).error, /note required/);
    assert.equal(decisions(db).length, 0);
    assert.equal(only(db).gate_round, 1, 'a refused reopen must not move the round');
    assert.equal(only(db).status, 'waiting');

    assert.equal((await reopen(e, AGENT_ID, { note: '   ' })).status, 400, 'whitespace is not a reason');
  });

  test('taking back a decision needs no reason — the decision is the trail', async () => {
    const { db, e } = await gated();
    await respond(e, AGENT_ID, { response_option_id: 'd2' });
    assert.equal((await reopen(e, AGENT_ID, undefined)).status, 200);
    assert.equal(decisions(db).length, 1);
    assert.equal(decisions(db)[0].response_option_id, 'd2');
  });

  test('reopening a session that does not exist is a 404', async () => {
    const { e } = await gated();
    assert.equal((await reopen(e, 'nope/nothing/here', { note: 'x' })).status, 404);
  });
});

describe('answering with a design you already made', () => {
  // The agent enumerates the choices, so the agent bounds what can be decided.
  // Naming a Figma section decides the gate with something it never offered —
  // without that section name ever being stored as though it were an option id.
  test('the section decides the gate, and no option id is invented for it', async () => {
    const { db, e } = await gated();
    const res = await respond(e, AGENT_ID, { response_section: 'Wallet header v3' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.response_kind, 'own');
    assert.equal(body.response_label, 'Wallet header v3');

    const r = only(db);
    assert.equal(r.response_option_id, null, 'a section name must never land in response_option_id');
    assert.equal(r.response_note, 'Wallet header v3');
    assert.equal(r.response, 'Wallet header v3');
    assert.equal(r.status, 'active', 'the agent proceeds rather than asking again');
    assert.ok(r.responded_at);
  });

  test('reads say which kind of decision it is', async () => {
    const { e } = await gated();
    await respond(e, AGENT_ID, { response_section: 'Wallet header v3' });
    const one = await (await call(e, 'GET', '/api/agent/session/' + encodeURIComponent(AGENT_ID),
                                  undefined, { 'X-Agent-Secret': 's' })).json();
    assert.equal(one.response_kind, 'own');
    assert.equal(one.response_label, 'Wallet header v3');
    assert.equal(one.response_option_id, null);
  });

  test('choosing an option is still marked as one', async () => {
    const { e } = await gated();
    await respond(e, AGENT_ID, { response_option_id: 'd2' });
    const one = await (await call(e, 'GET', '/api/agent/session/' + encodeURIComponent(AGENT_ID),
                                  undefined, { 'X-Agent-Secret': 's' })).json();
    assert.equal(one.response_kind, 'option');
    assert.equal(one.response_label, 'Labelled corner control');
  });

  test('an unanswered gate has no decision kind at all', async () => {
    const { e } = await gated();
    const one = await (await call(e, 'GET', '/api/agent/session/' + encodeURIComponent(AGENT_ID),
                                  undefined, { 'X-Agent-Secret': 's' })).json();
    assert.equal(one.response_kind, null);
    assert.equal(one.response_label, null);
  });

  test('a bare note is still not a decision, whatever it says', async () => {
    // The whole point: the section arrives under its own field name. A note
    // that decides a gate is the "Yes" bug however it is worded.
    const { db, e } = await gated();
    assert.equal((await respond(e, AGENT_ID, { response_note: 'Wallet header v3' })).status, 400);
    assert.equal(only(db).responded_at, null);
    assert.equal(only(db).status, 'waiting');
  });

  test('an empty or oversized section is refused, and both answers at once', async () => {
    const { db, e } = await gated();
    assert.equal((await respond(e, AGENT_ID, { response_section: '   ' })).status, 400);
    assert.equal((await respond(e, AGENT_ID, { response_section: 'x'.repeat(201) })).status, 400);
    const both = await respond(e, AGENT_ID, { response_option_id: 'd2', response_section: 'Mine' });
    assert.equal(both.status, 400);
    assert.match((await both.json()).error, /not both/);
    assert.equal(only(db).responded_at, null);
  });

  test('it can be taken back like any other decision', async () => {
    const { db, e } = await gated();
    await respond(e, AGENT_ID, { response_section: 'Wallet header v3' });
    assert.equal((await reopen(e, AGENT_ID, undefined)).status, 200,
                 'a decision is a trail, so no reason is needed');
    assert.equal(only(db).response_note, null);
    assert.equal(only(db).status, 'waiting');
    assert.equal(decisions(db).length, 1);
    assert.match(decisions(db)[0].response_note, /Wallet header v3/);
    assert.equal(decisions(db)[0].response_option_id, null);
  });
});

describe('rejecting every option', () => {
  // Not a fourth option. Nothing was chosen, so nothing may be recorded as
  // chosen — the reason is the decision record, and the round starts again.
  test('the reason is kept, and nothing is recorded as chosen', async () => {
    const { db, e } = await gated();
    const res = await reopen(e, AGENT_ID, {
      note: 'None of these — put the control in the collection header instead.',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).gate_round, 2);

    const r = only(db);
    assert.equal(r.response_option_id, null, 'a rejection must never name an option');
    assert.equal(r.response, null);
    assert.equal(r.response_note, null);
    assert.equal(r.status, 'waiting');
    assert.equal(r.gate_round, 2);

    const history = decisions(db);
    assert.equal(history.length, 1);
    assert.equal(history[0].gate_round, 1);
    assert.equal(history[0].response_option_id, null);
    assert.match(history[0].response_note, /collection header/);
    // What was rejected is kept with the reason for rejecting it.
    assert.deepEqual(parseOpts(history[0].options_snapshot).map(o => o.id), ['d1', 'd2', 'd3']);
  });

  test('the agent posts a fresh round onto it without the round moving twice', async () => {
    const { db, e } = await gated();
    await reopen(e, AGENT_ID, { note: 'None of these.' });
    await agentPost(e, { ...GATE, options: [
      { id: 'r1', label: 'Control in the collection header' },
      { id: 'r2', label: 'Control in the toolbar' },
    ] });
    assert.equal(only(db).gate_round, 2, 'replacing an unanswered gate is not another round');
    assert.deepEqual(parseOpts(only(db).options).map(o => o.id), ['r1', 'r2']);
    assert.equal(decisions(db).length, 1, 'nothing was decided, so nothing more to archive');

    assert.equal((await respond(e, AGENT_ID, { response_option_id: 'r2' })).status, 200);
    assert.equal(only(db).response, 'Control in the toolbar');
  });
});

describe('a different set of options is a different question', () => {
  test('the old answer is archived and cleared, never carried over', async () => {
    // Ids are stable for the life of a round. A round-1 `d1` sitting on a
    // round-2 gate is the "Yes" bug wearing an id.
    const { db, e } = await gated();
    await respond(e, AGENT_ID, { response_option_id: 'd2' });

    await agentPost(e, { ...GATE, options: [
      { id: 'd1', label: 'Something else entirely' },
      { id: 'd2', label: 'And another thing' },
    ] });

    const r = only(db);
    assert.equal(r.response_option_id, null, 'the previous answer survived the new question');
    assert.equal(r.response, null);
    assert.equal(r.gate_round, 2);
    assert.equal(r.status, 'waiting');
    assert.equal(decisions(db).length, 1);
    assert.equal(decisions(db)[0].response_option_id, 'd2');
  });

  test('re-posting the same options is the agent repeating itself', async () => {
    // The agent posts its state as it works. If each post reset the gate, an
    // answer given a second earlier would vanish.
    const { db, e } = await gated();
    await respond(e, AGENT_ID, { response_option_id: 'd2' });
    await agentPost(e, GATE);

    assert.equal(only(db).response_option_id, 'd2');
    assert.equal(only(db).gate_round, 1);
    assert.equal(decisions(db).length, 0);
  });
});

describe('mockups and handoff', () => {
  test('a mockups url and its timestamp both land', async () => {
    const { db, e } = await gated();
    const res = await setState(e, AGENT_ID, {
      mockups_url: 'https://figma.com/file/abc/page', mockups_at: 'now',
    });
    assert.equal(res.status, 200);
    assert.equal(only(db).mockups_url, 'https://figma.com/file/abc/page');
    assert.match(only(db).mockups_at, /^\d{4}-\d{2}-\d{2} /);
  });

  test('a url with no timestamp still records when it arrived', async () => {
    const { db, e } = await gated();
    await setState(e, AGENT_ID, { mockups_url: 'https://figma.com/file/abc/page' });
    assert.ok(only(db).mockups_at, 'a url without a stamp records half the fact');
  });

  test('handoff is its own level and touches nothing else', async () => {
    const { db, e } = await gated();
    await setState(e, AGENT_ID, { mockups_url: 'https://figma.com/file/abc/page', mockups_at: 'now' });
    await setState(e, AGENT_ID, { handoff_at: 'now' });
    assert.ok(only(db).handoff_at);
    assert.equal(only(db).mockups_url, 'https://figma.com/file/abc/page');
  });

  test('an explicit timestamp is taken as given, and null clears', async () => {
    const { db, e } = await gated();
    await setState(e, AGENT_ID, { handoff_at: '2026-09-12 14:30:00' });
    assert.equal(only(db).handoff_at, '2026-09-12 14:30:00');
    await setState(e, AGENT_ID, { handoff_at: null });
    assert.equal(only(db).handoff_at, null);
  });

  test('a state call with nothing in it, or for nothing, is refused', async () => {
    const { e } = await gated();
    assert.equal((await setState(e, AGENT_ID, { phase: 'qa' })).status, 400);
    assert.equal((await setState(e, 'nope/nothing/here', { handoff_at: 'now' })).status, 404);
  });
});

describe('piece6-schema.sql merges the rows already in the table', () => {
  // The state the live database is in before the migration: a reader row and
  // an agent row for the same issue, written by the two old code paths.
  function withDuplicates() {
    const db = freshDb(PIECES.filter(p => p !== 'piece6-schema.sql'));  // everything except piece6
    db.prepare(
      `INSERT INTO agent_sessions
         (id, system, project, track, phase, status, prompt, detail, url,
          linear_id, team, linear_uuid, linear_state, title, triggered_at, updated_at)
       VALUES ('linear/RYV-84', 'design-ai', 'ryve', 'app', 'research', 'waiting',
               'Run design research on RYV-84?', 'A Linear description.',
               'https://linear.app/x/issue/RYV-84', 'RYV-84', 'Ryve App',
               'uuid-RYV-84', 'unstarted', 'RYV-84 title',
               '2026-09-08 10:00:00', '2026-09-08 10:00:00')`).run();
    db.prepare(
      `INSERT INTO agent_sessions (id, system, project, phase, status, prompt, detail, figma_url, updated_at)
       VALUES (?, 'design-ai', 'ryve', 'design', 'waiting', ?, ?, 'https://figma.com/f/1',
               '2026-09-09 11:00:00')`
    ).run(AGENT_ID, AGENT_BODY.prompt, AGENT_BODY.detail);
    // A Hub-only session, which the migration must leave alone.
    db.prepare(
      `INSERT INTO agent_sessions (id, system, project, phase, status, updated_at)
       VALUES ('conduit/wallet-flow/design', 'social-ai', 'conduit', 'design', 'active',
               '2026-09-09 11:00:00')`).run();
    return db;
  }

  test('the twin collapses onto the Linear row', () => {
    const db = withDuplicates();
    assert.equal(rows(db).length, 3);

    applyPieces(db, ['piece6-schema.sql']);

    const all = rows(db);
    assert.equal(all.length, 2, 'the duplicate row is still there');
    const merged = all.find(r => r.linear_id === 'RYV-84');
    assert.equal(merged.id, 'linear/RYV-84');
    assert.equal(merged.agent_session_id, AGENT_ID);
    assert.equal(merged.phase, 'design');                  // the agent's
    assert.equal(merged.prompt, AGENT_BODY.prompt);        // the agent's
    assert.equal(merged.figma_url, 'https://figma.com/f/1');
    assert.equal(merged.title, 'RYV-84 title');            // Linear's
    assert.equal(merged.triggered_at, '2026-09-08 10:00:00'); // history kept
    assert.equal(merged.linear_uuid, 'uuid-RYV-84');
  });

  test('a Hub-only session is left where it is', () => {
    const db = withDuplicates();
    applyPieces(db, ['piece6-schema.sql']);
    const hub = rows(db).find(r => r.id === 'conduit/wallet-flow/design');
    assert.ok(hub, 'the Hub-only session was swept up');
    assert.equal(hub.agent_session_id, 'conduit/wallet-flow/design');
    assert.equal(hub.linear_id, null);
  });

  test('a second twin for the same issue is merged away too', () => {
    const db = withDuplicates();
    db.prepare(
      `INSERT INTO agent_sessions (id, system, phase, status, updated_at)
       VALUES ('ryve/ryv-84/qa', 'design-ai', 'qa', 'active', '2026-09-09 12:00:00')`).run();

    applyPieces(db, ['piece6-schema.sql']);

    const all = rows(db);
    assert.equal(all.length, 2);
    const merged = all.find(r => r.linear_id === 'RYV-84');
    // Newest twin wins, and the older one is gone rather than left orphaned.
    assert.equal(merged.agent_session_id, 'ryve/ryv-84/qa');
    assert.equal(merged.phase, 'qa');
    assert.equal(all.some(r => r.id === AGENT_ID), false);
  });

  test('after the migration the agent still reaches the card by its own id', async () => {
    const db = withDuplicates();
    applyPieces(db, ['piece6-schema.sql']);
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);

    const res = await call(e, 'GET', '/api/agent/session/' + encodeURIComponent(AGENT_ID),
                           undefined, { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, 'linear/RYV-84');

    await agentPost(e, { ...AGENT_BODY, stage: 'qa' });
    await readLinear(e);
    assert.equal(rows(db).length, 2);   // the merged card + the Hub-only one
  });
});
