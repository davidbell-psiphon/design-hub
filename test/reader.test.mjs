// The two-pass reader.
//
//   node --test test/reader.test.mjs
//
// CLAUDE.md's second load-bearing invariant:
//
//   "Discovery carries a fixed `first: 100` budget; reconciliation is a
//    separate update-only pass. Merging them lets closed issues eat the
//    budget and starve the board of real work."
//
// That is the kind of bug that never throws. A merged query would look fine on
// a small workspace and quietly drop real work on a large one, months later,
// with no error anywhere. So the shape of the two passes is asserted directly:
// what discovery is allowed to ask for, what reconciliation is allowed to do,
// and the fact that they stay two calls rather than one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  freshDb, env, call, agentPost, readLinear, issue, stubLinear, rows, one,
} from './helpers.mjs';

const RYV = (o = {}) => issue({ identifier: 'RYV-84', ...o });

// Run a read and hand back every GraphQL operation it made, in order.
async function readAndRecord(e, issues) {
  const queries = [];
  stubLinear(issues, null, { queries });
  const res = await readLinear(e);
  return { queries, result: await res.json() };
}

const discovery = qs => qs.find(q => /DesignReaderIssues/.test(q));
const reconcile = qs => qs.find(q => /Reconcile/.test(q));

describe('the two passes are two passes', () => {
  test('a read runs discovery and then reconciliation', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV()]);
    await readLinear(e);          // seed one tracked row to reconcile

    const { queries, result } = await readAndRecord(e, [RYV()]);
    assert.ok(discovery(queries), 'no discovery pass ran');
    assert.ok(reconcile(queries), 'no reconciliation pass ran');
    assert.ok(queries.indexOf(discovery(queries)) < queries.indexOf(reconcile(queries)),
              'reconciliation ran before discovery');
    // `teams` says which teams the read was scoped to, or 'all' where the
    // reader_teams table is empty — so a read that quietly narrowed says so.
    assert.deepEqual(Object.keys(result).sort(),
                     ['inserted', 'reconciled', 'skipped', 'teams', 'updated']);
    assert.equal(result.teams, 'all', 'an unconfigured reader should read every team');
  });

  test('with nothing tracked yet there is nothing to reconcile', async () => {
    const db = freshDb();
    const { queries, result } = await readAndRecord(env(db), []);
    assert.ok(discovery(queries), 'discovery must still run');
    assert.equal(reconcile(queries), undefined,
                 'reconciliation queried Linear with an empty id list');
    assert.equal(result.reconciled, 0);
  });
});

describe('discovery keeps its budget for open work', () => {
  test('it asks for every open state, and for nothing closed', async () => {
    const db = freshDb();
    const { queries } = await readAndRecord(env(db), []);
    const q = discovery(queries);

    // All four open states. Asking for only backlog and unstarted made an
    // issue you had started invisible unless the board read it before you
    // moved it — which is not "every issue assigned to Dave Bell".
    for (const state of ['triage', 'backlog', 'unstarted', 'started']) {
      assert.match(q, new RegExp(state), 'discovery stopped asking for ' + state);
    }
    // The invariant itself, unchanged and in one line. It was never about how
    // many open states are listed; it is about closed ones, which outnumber
    // the open work and would consume the budget it needs.
    assert.ok(!/completed|canceled/.test(q),
              'discovery is asking for closed issues — they will eat the ' +
              'first: 100 budget and starve the board of real work');
  });

  test('an issue you have started reaches the board', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-189', state: 'started' }),
                issue({ identifier: 'PSI2-278', state: 'started', team: 'Psiphon App' })]);
    await readLinear(e);
    assert.deepEqual(rows(db).map(r => r.linear_id).sort(), ['PSI2-278', 'RYV-189']);
  });

  test('the budget is still bounded and still 100', async () => {
    const db = freshDb();
    const { queries } = await readAndRecord(env(db), []);
    assert.match(discovery(queries), /first:\s*100/,
                 'the discovery budget changed — reconciliation is sized against it');
  });

  test('a closed issue the board has never seen does not arrive', async () => {
    const db = freshDb();
    const e = env(db);
    // Linear holds it, but discovery filters by state and reconciliation only
    // looks up ids already tracked — so nothing can reach the board.
    stubLinear([issue({ identifier: 'RYV-99', state: 'completed' })]);
    await readLinear(e);
    assert.equal(rows(db).length, 0,
                 'a closed issue was pulled onto the board by the reader');
  });
});

describe('reconciliation is update-only', () => {
  test('it only ever asks about issues already tracked', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV()]);
    await readLinear(e);

    const { queries } = await readAndRecord(e, [RYV(), issue({ identifier: 'RYV-99' })]);
    // The id list is built from the rows we hold, not from what Linear returns.
    const q = reconcile(queries);
    assert.ok(q, 'no reconciliation pass ran');
    assert.equal(rows(db).length, 2, 'discovery should have added RYV-99');
  });

  test('an id Linear volunteers that we do not track inserts nothing', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV()]);
    await readLinear(e);
    assert.equal(rows(db).length, 1);

    // Reconciliation answers with a row we never asked about. The guard in
    // reconcileTracked drops it; without that guard this is a phantom card.
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (/DesignReaderIssues/.test(body.query)) {
        return { ok: true, json: async () => ({ data: { issues: { nodes: [] } } }) };
      }
      if (/Reconcile/.test(body.query)) {
        return { ok: true, json: async () => ({ data: { issues: { nodes: [
          { id: 'uuid-RYV-84', state: { type: 'completed' }, labels: { nodes: [] } },
          { id: 'uuid-GHOST',  state: { type: 'completed' }, labels: { nodes: [] } },
        ] } } }) };
      }
      return { ok: true, json: async () => ({ data: {} }) };
    };
    await readLinear(e);

    assert.equal(rows(db).length, 1, 'reconciliation inserted a row');
    assert.equal(one(db, 'linear/RYV-84').linear_state, 'completed');
  });

  test('closing an issue in Linear is what fills the Completed section', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV()]);
    await readLinear(e);
    assert.equal(one(db, 'linear/RYV-84').linear_state, 'unstarted');

    // Now it closes. Discovery can no longer see it; reconciliation must.
    stubLinear([RYV({ state: 'completed' })]);
    await readLinear(e);
    assert.equal(one(db, 'linear/RYV-84').linear_state, 'completed',
                 'a card closed in Linear never reached Completed');
  });

  test('a canceled issue lands there too', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV()]);
    await readLinear(e);
    stubLinear([RYV({ state: 'canceled' })]);
    await readLinear(e);
    assert.equal(one(db, 'linear/RYV-84').linear_state, 'canceled');
  });

  test('Linear failing the reconciliation query is survivable', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV()]);
    await readLinear(e);

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (/DesignReaderIssues/.test(body.query)) {
        return { ok: true, json: async () => ({ data: { issues: { nodes: [] } } }) };
      }
      return { ok: true, json: async () => ({ errors: [{ message: 'rate limited' }] }) };
    };

    const res = await readLinear(e);
    assert.equal(res.status, 200, 'a failed reconciliation broke the whole read');
    assert.equal((await res.json()).reconciled, 0);
    assert.equal(rows(db).length, 1, 'the board lost a row to a Linear error');
  });
});

describe('a read refreshes Linear, and only Linear', () => {
  test('a run in flight is not cancelled by a Wednesday read', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV()]);
    await readLinear(e);
    await call(e, 'POST', '/api/agent/session/' + encodeURIComponent('linear/RYV-84') +
               '/trigger', { stage: 'research' });
    assert.equal(one(db, 'linear/RYV-84').requested_stage, 'research');

    stubLinear([RYV()]);
    await readLinear(e);
    assert.equal(one(db, 'linear/RYV-84').requested_stage, 'research',
                 'a read cleared the queue and the run will never happen');
  });

  test('a gate waiting on an answer still is afterwards', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV()]);
    await readLinear(e);
    await agentPost(e, {
      session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'waiting',
      prompt: 'Which direction proceeds?',
      options: [{ id: 'd1', label: 'One' }, { id: 'd2', label: 'Two' }],
    });

    stubLinear([RYV()]);
    await readLinear(e);

    const r = one(db, 'linear/RYV-84');
    assert.equal(r.status, 'waiting', 'a read closed an open gate');
    assert.equal(r.prompt, 'Which direction proceeds?');
    assert.equal(JSON.parse(r.options).length, 2, 'a read dropped the options');
  });

  test('the title and state do refresh — that is the job', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV({ title: 'Old title' })]);
    await readLinear(e);
    assert.equal(one(db, 'linear/RYV-84').title, 'Old title');

    stubLinear([RYV({ title: 'Renamed in Linear' })]);
    await readLinear(e);
    assert.equal(one(db, 'linear/RYV-84').title, 'Renamed in Linear');
  });

  test('labels refresh, so a finished stage moves its card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([RYV()]);
    await readLinear(e);
    assert.deepEqual(JSON.parse(one(db, 'linear/RYV-84').labels), []);

    stubLinear([RYV({ labels: [{ name: 'AI-research done' }] })]);
    await readLinear(e);
    assert.deepEqual(JSON.parse(one(db, 'linear/RYV-84').labels), ['AI-research done']);
  });

  test('every team reaches the board — only the assignee filters', async () => {
    // There was a team filter here, and Marketing was outside it. It went:
    // anything assigned to Dave belongs in the Hub whatever team it sits on,
    // and the brand filter is what provides the context instead. `skipped`
    // now counts one thing only — an issue assigned to somebody else.
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'MAR-978', team: 'Marketing' }),
                issue({ identifier: 'INS-66', team: 'Insights' }),
                issue({ identifier: 'NET-9', team: 'Network Ops', assignee: 'Someone Else' })]);
    const res = await readLinear(e);
    const out = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(rows(db).map(r => r.linear_id).sort(), ['INS-66', 'MAR-978']);
    assert.equal(out.skipped, 1, 'skipped should count the other assignee, and only that');
  });
});
