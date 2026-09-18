// The No design control, and the invariant underneath it.
//
//   node --test test/dismiss.test.mjs
//
// Two things are checked here that nothing else covered. The first is the
// dismiss route's ordering contract: the Linear label is written before the
// local stamp, and a Linear failure must leave the card exactly where it was.
// The second is the one CLAUDE.md calls out by line number —
//
//   dismissed_at = COALESCE(agent_sessions.dismissed_at, excluded.dismissed_at)
//
// — which is what makes a cron read able only ever to *add* a dismissal. Drop
// either COALESCE (the discovery upsert's, or the reconciliation pass's) and a
// Wednesday run silently un-dismisses every card whose no-design label came
// off in Linear. That is data loss with no error and no log line, so it gets
// tests that fail loudly instead.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {  freshDb, env, call, agentPost, readLinear, issue, stubLinear, one, wire, session, sessionsOf,
} from './helpers.mjs';

const RYV = () => issue({ identifier: 'RYV-84' });
const NO_DESIGN = () => issue({ identifier: 'RYV-84', labels: [{ name: 'no-design' }] });

const CARD = 'RYV-84';
const dismiss = (e, id = CARD) =>
  call(e, 'POST', '/api/agent/session/' + encodeURIComponent(id) + '/dismiss');
const undismiss = (e, id = CARD) =>
  call(e, 'DELETE', '/api/agent/session/' + encodeURIComponent(id) + '/dismiss');

// A fixed, obviously-not-now timestamp. Comparing against datetime('now')
// cannot prove a value survived — both sides are the same second — so every
// test that cares about survival plants this and checks it comes back intact.
const PLANTED = '2020-01-01 00:00:00';
const plant = (db, id = CARD) =>
  db.prepare('UPDATE cards SET dismissed_at = ? WHERE issue_key = ?').run(PLANTED, id);

// A board with one discovered Linear card on it.
async function boardWithOneCard(issues = [RYV()]) {
  const db = freshDb();
  const e = env(db);
  stubLinear(issues);
  await readLinear(e);
  return { db, e };
}

describe('the No design control', () => {
  test('dismissing applies the label in Linear, then files the card away', async () => {
    const { db, e } = await boardWithOneCard();
    const mutations = [];
    stubLinear([RYV()], mutations);

    const res = await dismiss(e);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, dismissed: true });

    assert.ok(one(db, CARD).dismissed_at, 'the card was not stamped');
    assert.ok(mutations.some(m => /issueAddLabel/.test(m)),
              'no label was written to Linear');
  });

  test('undoing removes the label and puts the card back', async () => {
    const { db, e } = await boardWithOneCard();
    stubLinear([RYV()]);
    await dismiss(e);

    const mutations = [];
    stubLinear([RYV()], mutations);
    const res = await undismiss(e);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, dismissed: false });

    assert.equal(one(db, CARD).dismissed_at, null, 'the card is still filed away');
    assert.ok(mutations.some(m => /issueRemoveLabel/.test(m)),
              'the label was never taken off in Linear');
  });

  test('a session with no Linear issue behind it cannot be dismissed', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([]);
    await agentPost(e, { session_id: 'conduit/wallet-flow/design', system: 'design-ai' });

    const res = await dismiss(e, 'conduit/wallet-flow/design');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no linked Linear issue/i);
  });

  test('an unknown id is a 404', async () => {
    const { e } = await boardWithOneCard();
    stubLinear([RYV()]);
    assert.equal((await dismiss(e, 'linear/NOPE-1')).status, 404);
  });

  test('a workspace with no no-design label is refused, and nothing is written', async () => {
    const { db, e } = await boardWithOneCard();
    stubLinear([RYV()], null, { noLabel: true });

    const res = await dismiss(e);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /label "no-design" not found/i);
    assert.equal(one(db, CARD).dismissed_at, null,
                 'the card was filed away without the label being applied');
  });

  // The ordering contract, both directions. These are the two states the
  // route's own comment says must never happen.
  test('a Linear failure leaves the card on the board, not half-dismissed', async () => {
    const { db, e } = await boardWithOneCard();
    stubLinear([RYV()], null, { mutationError: true });

    const res = await dismiss(e);
    assert.equal(res.status, 502);
    assert.equal(one(db, CARD).dismissed_at, null,
                 'dismissed locally even though Linear refused the label');
  });

  test('a failed removal leaves the card dismissed rather than flickering', async () => {
    const { db, e } = await boardWithOneCard();
    stubLinear([RYV()]);
    await dismiss(e);
    plant(db);

    stubLinear([RYV()], null, { mutationError: true });
    const res = await undismiss(e);
    assert.equal(res.status, 502);
    // Clearing first would put the card back still carrying the label, and the
    // next reconciliation would dismiss it again — a card that flickers.
    assert.equal(one(db, CARD).dismissed_at, PLANTED,
                 'the card came back while the label was still on the issue');
  });

  test('dismissing twice keeps the first timestamp', async () => {
    const { db, e } = await boardWithOneCard();
    stubLinear([RYV()]);
    await dismiss(e);
    plant(db);

    await dismiss(e);
    assert.equal(one(db, CARD).dismissed_at, PLANTED,
                 'the second press moved the dismissal date');
  });

  test('a dismissed card is not handed to the runner', async () => {
    const { e } = await boardWithOneCard();
    stubLinear([RYV()]);
    await call(e, 'POST', '/api/agent/session/' + encodeURIComponent(CARD) + '/trigger',
               { stage: 'research' });

    const before = await (await call(e, 'GET', '/api/agent/queue')).json();
    assert.ok(before.some(r => r.id === CARD), 'the trigger never reached the queue');

    await dismiss(e);
    const after = await (await call(e, 'GET', '/api/agent/queue')).json();
    assert.ok(!after.some(r => r.id === CARD),
              'a card filed under No design is still in the runner queue');
  });
});

// ─── THE INVARIANT ────────────────────────────────────────────────────────
// CLAUDE.md: "a cron read can only ever *add* a dismissal, never clear one."
describe('a cron read can only ever add a dismissal', () => {
  test('the reconciliation pass files away a card labelled in Linear', async () => {
    const { db, e } = await boardWithOneCard();
    assert.equal(one(db, CARD).dismissed_at, null);

    // The label goes on in Linear, and the issue closes — so only the
    // reconciliation pass can see it, since discovery asks for open issues.
    stubLinear([issue({ identifier: 'RYV-84', state: 'completed',
                        labels: [{ name: 'no-design' }] })]);
    await readLinear(e);

    assert.ok(one(db, CARD).dismissed_at,
              'a no-design label applied in Linear never reached the board');
  });

  test('removing the label in Linear does not put the card back', async () => {
    const { db, e } = await boardWithOneCard([NO_DESIGN()]);
    stubLinear([NO_DESIGN()]);
    await dismiss(e);
    plant(db);

    // The label comes off in Linear. Every later read sees an ordinary issue.
    stubLinear([RYV()]);
    await readLinear(e);
    await readLinear(e);

    assert.equal(one(db, CARD).dismissed_at, PLANTED,
                 'a cron read un-dismissed the card — the COALESCE is gone');
  });

  test('the discovery upsert cannot clear one either', async () => {
    const { db, e } = await boardWithOneCard();
    plant(db);

    // Open, unlabelled, and therefore squarely in the discovery pass.
    stubLinear([RYV()]);
    await readLinear(e);

    const r = one(db, CARD);
    assert.equal(r.dismissed_at, PLANTED,
                 'the discovery upsert overwrote the dismissal');
    // …while still doing its actual job.
    assert.equal(r.title, 'RYV-84 title');
  });

  test('the Hub Undo control is the only thing that clears it', async () => {
    const { db, e } = await boardWithOneCard([NO_DESIGN()]);
    stubLinear([NO_DESIGN()]);
    await dismiss(e);
    assert.ok(one(db, CARD).dismissed_at);

    stubLinear([RYV()]);
    await undismiss(e);
    assert.equal(one(db, CARD).dismissed_at, null);
  });
});
