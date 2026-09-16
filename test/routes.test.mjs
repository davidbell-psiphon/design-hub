// The routes nothing else reached.
//
//   node --test test/routes.test.mjs
//
// session.test.mjs covers the agent's surface and the gate contract, and
// dismiss/reader/access cover the three invariants. What was left with no
// local coverage at all: the delete route, the legacy /api/sessions shape the
// agent still reads, /api/brands, and the CORS preflight.
//
// The delete route is here for a specific reason. It is the one destructive
// route on the API, it is reachable with a single call, and until now nothing
// asserted what it destroys — or what it leaves behind.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  freshDb, env, call, agentPost, readLinear, issue, stubLinear, rows,
} from './helpers.mjs';

const CARD = 'linear/RYV-84';
const AGENT_ID = 'ryve/ryv-84/design';

// A card that has been through a gate, so there is history to lose.
async function cardWithGateHistory() {
  const db = freshDb();
  const e = env(db);
  stubLinear([issue({ identifier: 'RYV-84' })]);
  await readLinear(e);

  const options = [{ id: 'd1', label: 'One' }, { id: 'd2', label: 'Two' }];
  await agentPost(e, {
    session_id: AGENT_ID, system: 'design-ai', status: 'waiting',
    prompt: 'Which direction proceeds?', options,
  });
  await call(e, 'PATCH', '/api/agent/session/' + encodeURIComponent(CARD) + '/respond',
             { response_option_id: 'd2' });
  await call(e, 'PATCH', '/api/agent/session/' + encodeURIComponent(CARD) + '/reopen',
             { note: 'going back' });
  return { db, e };
}

const decisions = db =>
  db.prepare('SELECT * FROM gate_decisions WHERE session_id = ?').all(CARD);

describe('DELETE /api/agent/session/:id', () => {
  test('drops the session', async () => {
    const { db, e } = await cardWithGateHistory();
    assert.equal(rows(db).length, 1);

    const res = await call(e, 'DELETE', '/api/agent/session/' + encodeURIComponent(CARD));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(rows(db).length, 0);
  });

  test('the agent can drop it by the id it owns', async () => {
    const { db, e } = await cardWithGateHistory();
    const res = await call(e, 'DELETE', '/api/agent/session/' + encodeURIComponent(AGENT_ID));
    assert.equal(res.status, 200);
    assert.equal(rows(db).length, 0, 'the alias did not resolve to the merged card');
  });

  test('deleting one card leaves the others alone', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' }), issue({ identifier: 'RYV-85' })]);
    await readLinear(e);
    assert.equal(rows(db).length, 2);

    await call(e, 'DELETE', '/api/agent/session/' + encodeURIComponent(CARD));
    const left = rows(db);
    assert.equal(left.length, 1);
    assert.equal(left[0].id, 'linear/RYV-85');
  });

  // KNOWN GAP, asserted so it cannot change unnoticed.
  //
  // The route deletes from agent_sessions and nothing else, so a card's
  // gate_decisions rows outlive the card they belong to. They are unreachable
  // — every read joins from the session — but they are still there, and the
  // only way to clear them is by hand against D1.
  //
  // If the cascade is ever added, this test fails. That is the point: flip it
  // to assert an empty table rather than deleting it.
  test('gate history is left behind — the cascade this route does not do', async () => {
    const { db, e } = await cardWithGateHistory();
    assert.equal(decisions(db).length, 1, 'the fixture recorded no gate history');

    await call(e, 'DELETE', '/api/agent/session/' + encodeURIComponent(CARD));

    assert.equal(rows(db).length, 0);
    assert.equal(decisions(db).length, 1,
                 'the cascade was added — update this test to expect 0');
  });

  test('deleting something that is not there is not an error', async () => {
    const { db, e } = await cardWithGateHistory();
    const res = await call(e, 'DELETE', '/api/agent/session/linear%2FNOPE-1');
    assert.equal(res.status, 200);
    assert.equal(rows(db).length, 1, 'an unknown id deleted a real card');
  });
});

describe('GET /api/sessions — the legacy shape the agent still reads', () => {
  test('waiting sessions only', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([]);
    await agentPost(e, { session_id: 'a/b/waiting', system: 'design-ai', status: 'waiting' });
    await agentPost(e, { session_id: 'a/b/active',  system: 'design-ai', status: 'active' });
    await agentPost(e, { session_id: 'a/b/done',    system: 'design-ai', status: 'done' });

    const out = await (await call(e, 'GET', '/api/sessions')).json();
    assert.deepEqual(out.map(r => r.id), ['a/b/waiting']);
  });

  test('it carries the gate fields, so a waiting card is answerable', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([]);
    await agentPost(e, {
      session_id: 'a/b/gate', system: 'design-ai', status: 'waiting',
      prompt: 'Which?', options: [{ id: 'd1', label: 'One' }],
    });

    const out = await (await call(e, 'GET', '/api/sessions')).json();
    assert.equal(out.length, 1);
    // Normalised on the way out: every option carries all three fields, so a
    // consumer never has to test for a missing summary.
    assert.deepEqual(out[0].options, [{ id: 'd1', label: 'One', summary: null }],
                     'options came back as a blob rather than a normalised array');
    assert.ok('response_kind' in out[0], 'the legacy shape lost response_kind');
  });

  test('an empty board is an empty array, not an error', async () => {
    const out = await (await call(env(freshDb()), 'GET', '/api/sessions')).json();
    assert.deepEqual(out, []);
  });
});

describe('GET /api/brands', () => {
  test('returns the brand rows in sort order', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO projects (id, name, color, section_id, sort_order) VALUES
      ('ryve', 'Ryve', '#206CCC', 'brands', 2),
      ('conduit', 'Conduit', '#7E67A4', 'brands', 1),
      ('notabrand', 'Something else', '#000', 'other', 0)`);

    const out = await (await call(env(db), 'GET', '/api/brands')).json();
    assert.deepEqual(out.map(b => b.id), ['conduit', 'ryve'],
                     'brands came back unsorted, or a non-brand row leaked in');
    assert.equal(out[0].color, '#7E67A4');
  });

  test('no brand rows is an empty array', async () => {
    const out = await (await call(env(freshDb()), 'GET', '/api/brands')).json();
    assert.deepEqual(out, []);
  });
});

describe('the CORS preflight', () => {
  test('is answered 204 with the methods the board uses', async () => {
    const res = await call(env(freshDb()), 'OPTIONS', '/api/agent/sessions');
    assert.equal(res.status, 204);
    const allowed = res.headers.get('Access-Control-Allow-Methods') || '';
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) {
      assert.match(allowed, new RegExp(m), m + ' is not allowed by the preflight');
    }
  });
});
