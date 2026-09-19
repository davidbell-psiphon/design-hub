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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {  freshDb, env, call, agentPost, readLinear, issue, stubLinear, rows, applyPieces, wire, session, sessionsOf,
} from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD = 'RYV-84';
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
    assert.equal(left[0].issue_key, 'RYV-85');
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

  // piece10-schema.sql moved brand identity out of `projects` — the retired
  // chat organiser's sidebar hierarchy — into a table named for what it holds.
  // The two tests above still pass because the fallback is still there; these
  // are what say the new table is actually the one being read.
  test('reads the brands table', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO brands (id, name, color, sort_order) VALUES
      ('ryve', 'Ryve', '#206CCC', 2),
      ('conduit', 'Conduit', '#7E67A4', 1)`);

    const out = await (await call(env(db), 'GET', '/api/brands')).json();
    assert.deepEqual(out.map(b => b.id), ['conduit', 'ryve'],
                     'brands came back unsorted, or not from the brands table');
    assert.equal(out[0].color, '#7E67A4');
  });

  test('the brands table wins over the projects fallback', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO projects (id, name, color, section_id, sort_order) VALUES
      ('stale', 'Left over', '#000', 'brands', 0)`);
    db.exec(`INSERT INTO brands (id, name, color, sort_order) VALUES
      ('conduit', 'Conduit', '#7E67A4', 1)`);

    const out = await (await call(env(db), 'GET', '/api/brands')).json();
    assert.deepEqual(out.map(b => b.id), ['conduit'],
                     'the legacy projects row leaked through a populated brands table');
  });

  // The window between deploying this Worker and applying piece10. The board
  // losing every brand bucket over a deploy-ordering mistake is the thing the
  // fallback exists to prevent, so it gets a test rather than a comment alone.
  test('falls back to projects while brands is empty', async () => {
    const db = freshDb();
    db.exec(`INSERT INTO projects (id, name, color, section_id, sort_order) VALUES
      ('conduit', 'Conduit', '#7E67A4', 'brands', 1)`);

    const out = await (await call(env(db), 'GET', '/api/brands')).json();
    assert.deepEqual(out.map(b => b.id), ['conduit'],
                     'an unmigrated database lost its brand buckets');
  });

  // And the window on the other side: `projects` dropped by §13 step 4 before
  // anyone noticed the fallback was still wired up. A missing table must not
  // 500 the board's only structural read.
  test('a missing projects table is an empty list, not a 500', async () => {
    const db = freshDb();
    db.exec(`DROP TABLE projects`);

    const res = await call(env(db), 'GET', '/api/brands');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  // piece10 carries the live values across rather than retyping them, so a
  // colour changed by hand since piece4 arrives with the rest.
  test('piece10 seeds brands from whatever projects currently holds', async () => {
    // freshDb creates `projects` and applies nothing, so this is the table as
    // it stands the moment before the migration runs.
    const db = freshDb([]);
    db.exec(`INSERT INTO projects (id, name, color, section_id, sort_order) VALUES
      ('conduit', 'Conduit', '#CHANGED', 'brands', 1),
      ('notabrand', 'Something else', '#000', 'other', 0)`);
    applyPieces(db, ['piece10-schema.sql']);

    const seeded = db.prepare(`SELECT id, color FROM brands ORDER BY id`)
      .all().map(r => [r.id, r.color]);
    assert.deepEqual(seeded, [['conduit', '#CHANGED']],
                     'the seed retyped the colours, or dragged a non-brand row across');
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

// ──────────────────────────────────────────────────────────────────────
// Route matching — a subroute must never fall into a catch-all
//
// `route()` is one long function of sequential `if`s, so which handler answers
// a request depends on DECLARATION ORDER, and nothing enforces that order.
// Two of those handlers used to match the whole `/api/agent/session/` prefix:
// the GET that answers as a session, and the DELETE that removes the card.
//
// The DELETE one was the dangerous half. resolveKey() parses an issue key out
// of anything — `RYV-84/figma`, `RYV-84/skipp`, `RYV-84/anything/at/all` all
// come back as `RYV-84` — so any DELETE under that prefix which was not caught
// by an earlier block deleted the card and every session on it, and answered
// `{ ok: true }`. Nothing did that, because every real DELETE subroute is
// declared above it. "Correct as long as nobody adds a route below this line"
// is not a property worth relying on when the failure is silent data loss.
// ──────────────────────────────────────────────────────────────────────

describe('a subroute is never mistaken for a session id', () => {
  const CARD = 'RYV-84';

  async function board() {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: CARD })]);
    await readLinear(e);
    return { db, e };
  }

  const alive = (db) =>
    !!db.prepare(`SELECT issue_key FROM cards WHERE issue_key = ?`).get(CARD);

  // Every subroute the Worker serves, plus shapes that do not exist. A DELETE
  // to any of them must not destroy the card.
  const SUBROUTES = ['figma', 'skip', 'setaside', 'dismiss', 'complete',
                     'state', 'reopen', 'reassign', 'respond', 'trigger',
                     'skipp', 'nonesuch', 'anything/at/all'];

  for (const sub of SUBROUTES) {
    test(`DELETE …/${sub} does not delete the card`, async () => {
      const { db, e } = await board();
      assert.ok(alive(db), 'fixture did not create the card');
      await call(e, 'DELETE', `/api/agent/session/${CARD}/${sub}`, undefined,
                 { 'X-Agent-Secret': 's' });
      assert.ok(alive(db),
        `DELETE …/${sub} destroyed the card and every session on it`);
    });
  }

  test('and the real delete still works', async () => {
    // The tightening is worthless if it also broke the route.
    const { db, e } = await board();
    const res = await call(e, 'DELETE', `/api/agent/session/${CARD}`, undefined,
                           { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 200);
    assert.ok(!alive(db), 'the card survived its own delete');
  });

  test('an id with slashes still deletes, because clients encode it', async () => {
    const { db, e } = await board();
    await call(e, 'DELETE',
      '/api/agent/session/' + encodeURIComponent('ryve/ryv-84/design'),
      undefined, { 'X-Agent-Secret': 's' });
    assert.ok(!alive(db), 'the encoded agent id form stopped resolving');
  });

  test('the sessions go with the card, and only that card', async () => {
    const { db, e } = await board();
    await call(e, 'POST', '/api/agent/session',
      { session_id: 'ryve/ryv-84/research', system: 'design-ai', status: 'active' },
      { 'X-Agent-Secret': 's' });
    await call(e, 'DELETE', `/api/agent/session/${CARD}`, undefined, { 'X-Agent-Secret': 's' });
    const left = db.prepare(`SELECT COUNT(*) AS n FROM stage_sessions`).get().n;
    assert.equal(left, 0, 'the sessions outlived the card they belonged to');
  });

  test('GET of a subroute does not answer as if it were a session', async () => {
    // The GET catch-all carried an exclusion list — trigger, reassign,
    // respond, dismiss — that had to grow by hand for every subroute added
    // since, and had fallen six behind. It only held because all six are
    // non-GET, which is a coincidence rather than a design.
    const { e } = await board();
    for (const sub of ['figma', 'skip', 'complete', 'state', 'nonesuch']) {
      const res = await call(e, 'GET', `/api/agent/session/${CARD}/${sub}`,
                             undefined, { 'X-Agent-Secret': 's' });
      assert.notEqual(res.status, 200,
        `GET …/${sub} was answered as the session for ${CARD}`);
    }
  });

  test('a real session GET still answers', async () => {
    const { e } = await board();
    const res = await call(e, 'GET', `/api/agent/session/${CARD}`, undefined,
                           { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 200);
  });

  test('neither route matches by bare prefix any more', () => {
    // The structural half. A future `startsWith('/api/agent/session/')` on a
    // GET or DELETE puts the trap straight back, and no behavioural test above
    // would notice until somebody added the subroute that falls into it.
    const src = fs.readFileSync(path.join(ROOT, 'worker/index.js'), 'utf8');
    for (const method of ['GET', 'DELETE']) {
      const bad = new RegExp(
        `method === '${method}' && path\\.startsWith\\('/api/agent/session/'\\)`);
      assert.ok(!bad.test(src),
        `the ${method} handler matches the whole session prefix again`);
    }
  });

  test('every session subroute is anchored at both ends', () => {
    // `path.match(/\/respond$/)` matches any path ending in /respond,
    // anywhere. Anchoring both ends is what makes the route mean one thing.
    const src = fs.readFileSync(path.join(ROOT, 'worker/index.js'), 'utf8');
    const loose = [...src.matchAll(/path\.match\(\/([^/\n]*(?:\\\/[^/\n]*)*)\/\)/g)]
      .map((m) => m[1])
      .filter((re) => re.includes('respond') || re.includes('trigger') ||
                      re.includes('skip') || re.includes('dismiss') ||
                      re.includes('setaside') || re.includes('complete') ||
                      re.includes('reassign'))
      .filter((re) => !re.startsWith('^'));
    assert.deepEqual(loose, [],
      `these session routes are not anchored at the start: ${loose.join(', ')}`);
  });
});
