// Undo — not done. Taking back a Mark done.
//
//   node --test test/undo.test.mjs
//
// Mark done moves the Linear issue to its team's finished state, and until
// now the only way back was opening Linear. Undo is the same exception §6
// makes for Mark done, in the other direction: a human press carried to
// Linear. What these hold down is WHERE it goes back to — the state the
// issue left, when the Hub saw it leave, and the team's first open state
// when it did not — and that the local row follows Linear rather than
// leading it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  freshDb, env, call, readLinear, issue, stubLinear, one, PIECES,
} from './helpers.mjs';

const KEY = 'RYV-84';
const complete = (e, method) => call(e, method, `/api/agent/session/${KEY}/complete`);

// A team with something to go back to. The stub's default states have no
// open state but Backlog, which is exactly what the fallback order must not
// pick first.
const STATES = [
  { id: 'st-backlog',  name: 'Backlog',     type: 'backlog',   position: 0 },
  { id: 'st-todo',     name: 'Todo',        type: 'unstarted', position: 1 },
  { id: 'st-progress', name: 'In Progress', type: 'started',   position: 2 },
  { id: 'st-done',     name: 'Design Done', type: 'completed', position: 3 },
];

// An issue with a full state, so the press has something to remember. The
// helper's issue() carries only the type, which is all the reader stores.
const inProgress = () => ({
  ...issue({ identifier: KEY }),
  state: { id: 'st-progress', name: 'In Progress', type: 'started' },
});
const closed = () => ({
  ...issue({ identifier: KEY }),
  state: { id: 'st-done', name: 'Design Done', type: 'completed' },
});

// Discovery only takes open issues — closed ones never pass the reader's
// state filter — so every card here starts open, and is closed afterwards
// either by the press or by hand.
async function discovered() {
  const db = freshDb();
  const e = env(db);
  stubLinear([inProgress()]);
  await readLinear(e);
  return { db, e };
}

// Closed in Linear, and the Hub found out from a reconciliation read rather
// than from its own press: nothing remembered.
function closedByHand(db) {
  db.prepare(`UPDATE cards SET linear_state = 'completed' WHERE issue_key = ?`).run(KEY);
}

describe('Mark done remembers where the issue came from', () => {
  test('the press writes done_from, and only when it moved the issue', async () => {
    const { db, e } = await discovered();
    stubLinear([inProgress()], null, { states: STATES });
    const res = await complete(e, 'POST');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(one(db, KEY).done_from),
      { id: 'st-progress', name: 'In Progress', type: 'started' });
  });

  test('an issue already finished in Linear came from nowhere the Hub saw', async () => {
    const { db, e } = await discovered();
    stubLinear([closed()], null, { states: STATES });
    const res = await complete(e, 'POST');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).already, true);
    assert.equal(one(db, KEY).done_from, null, 'a no-op press invented a place to go back to');
  });
});

describe('Undo puts it back', () => {
  test('to the state it was in when Mark done was pressed', async () => {
    const { db, e } = await discovered();
    stubLinear([inProgress()], null, { states: STATES });
    await complete(e, 'POST');
    assert.equal(one(db, KEY).linear_state, 'completed');

    // Linear now says it is done, and the undo asks Linear first.
    const mutations = [];
    stubLinear([closed()], mutations, { states: STATES });
    const res = await complete(e, 'DELETE');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'In Progress');
    assert.equal(body.already, false);
    const row = one(db, KEY);
    assert.equal(row.linear_state, 'started', 'the card is still filed under Completed');
    assert.equal(row.done_from, null, 'the undo left a stale place to go back to');
  });

  test('the wire says so: the card leaves Completed without waiting for a read', async () => {
    const { e } = await discovered();
    stubLinear([inProgress()], null, { states: STATES });
    await complete(e, 'POST');
    stubLinear([closed()], null, { states: STATES });
    await complete(e, 'DELETE');
    const rows = await (await call(e, 'GET', '/api/agent/sessions')).json();
    const card = rows.find((r) => r.id === KEY);
    assert.equal(card.linear_state, 'started');
  });

  test('a remembered state the team no longer has falls through to Todo', async () => {
    const { db, e } = await discovered();
    closedByHand(db);
    db.prepare(`UPDATE cards SET done_from = ? WHERE issue_key = ?`)
      .run(JSON.stringify({ id: 'st-gone', name: 'Old Column', type: 'started' }), KEY);
    const mutations = [];
    stubLinear([closed()], mutations, { states: STATES });
    const res = await complete(e, 'DELETE');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, 'Todo');
  });
});

describe('when the Hub never saw it marked done', () => {
  // Closed in Linear by hand, or before piece15. Nothing remembered.
  test('it goes to the earliest unstarted state, not Backlog', async () => {
    const { db, e } = await discovered();
    closedByHand(db);
    assert.equal(one(db, KEY).done_from, null);
    const mutations = [];
    stubLinear([closed()], mutations, { states: STATES });
    const res = await complete(e, 'DELETE');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, 'Todo');
    assert.equal(one(db, KEY).linear_state, 'unstarted');
  });

  test('then started, then backlog, when a team has no Todo', async () => {
    const { db, e } = await discovered();
    closedByHand(db);
    const mutations = [];
    stubLinear([closed()], mutations, {
      states: STATES.filter((st) => st.type !== 'unstarted'),
    });
    assert.equal((await (await complete(e, 'DELETE')).json()).state, 'In Progress');

    closedByHand(db);
    const only = STATES.filter((st) => st.type === 'backlog' || st.type === 'completed');
    stubLinear([closed()], mutations, { states: only });
    assert.equal((await (await complete(e, 'DELETE')).json()).state, 'Backlog');
  });

  test('a canceled issue can be brought back the same way', async () => {
    const canceled = { ...closed(), state: { id: 'st-x', name: 'Canceled', type: 'canceled' } };
    const { db, e } = await discovered();
    db.prepare(`UPDATE cards SET linear_state = 'canceled' WHERE issue_key = ?`).run(KEY);
    stubLinear([canceled], null, { states: STATES });
    const res = await complete(e, 'DELETE');
    assert.equal(res.status, 200);
    assert.equal(one(db, KEY).linear_state, 'unstarted');
  });

  test('a team with no open state at all is an error, not a guess', async () => {
    const { db, e } = await discovered();
    closedByHand(db);
    stubLinear([closed()], null, { states: STATES.filter((st) => st.type === 'completed') });
    const res = await complete(e, 'DELETE');
    assert.equal(res.status, 502);
    assert.equal(one(db, KEY).linear_state, 'completed');
  });
});

describe('Linear first, the local row second', () => {
  test('an issue already open in Linear is only fixed locally', async () => {
    // The row says completed — a press that went through, say — but Linear
    // was reopened by hand since. Nothing to write there; say so.
    const { db, e } = await discovered();
    closedByHand(db);
    const mutations = [];
    stubLinear([inProgress()], mutations, { states: STATES });
    const res = await complete(e, 'DELETE');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.already, true);
    assert.equal(body.state, 'In Progress');
    assert.equal(mutations.length, 0, 'wrote to Linear an issue that was already open');
    assert.equal(one(db, KEY).linear_state, 'started');
  });

  test('a refused Linear write leaves the card under Completed', async () => {
    const { db, e } = await discovered();
    closedByHand(db);
    stubLinear([closed()], null, { states: STATES, mutationError: true });
    const res = await complete(e, 'DELETE');
    assert.equal(res.status, 502);
    assert.equal(one(db, KEY).linear_state, 'completed',
      'the card left Completed with the issue still closed in Linear — it will flicker back');
  });

  test('and a refused Mark done leaves the card open, not filed under Completed', async () => {
    // Found while writing the undo: the press checked the wrong field on the
    // Linear reply, reported success, and moved the local row anyway.
    const { db, e } = await discovered();
    stubLinear([inProgress()], null, { states: STATES, mutationError: true });
    const res = await complete(e, 'POST');
    assert.equal(res.status, 502);
    assert.equal(one(db, KEY).linear_state, 'started',
      'the card was filed under Completed with the issue still open in Linear');
    assert.equal(one(db, KEY).done_from, null);
  });

  test('a card with no Linear issue behind it is refused', async () => {
    const db = freshDb();
    const e = env(db);
    db.prepare(`INSERT INTO cards (issue_key, brand) VALUES ('ZZ-1', 'ryve')`).run();
    const res = await call(e, 'DELETE', '/api/agent/session/ZZ-1/complete');
    assert.equal(res.status, 400);
  });
});

describe('the column can be missing', () => {
  // A Worker deployed ahead of piece15. The press still completes, and the
  // undo takes the fallback rather than failing.
  const PIECES_WITHOUT_15 = PIECES.filter((p) => p !== 'piece15-schema.sql');

  test('Mark done still completes, and Undo still reopens', async () => {
    const db = freshDb(PIECES_WITHOUT_15);
    const e = env(db);
    stubLinear([inProgress()]);
    await readLinear(e);
    stubLinear([inProgress()], null, { states: STATES });
    assert.equal((await complete(e, 'POST')).status, 200);
    stubLinear([closed()], null, { states: STATES });
    const res = await complete(e, 'DELETE');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, 'Todo');
  });
});
