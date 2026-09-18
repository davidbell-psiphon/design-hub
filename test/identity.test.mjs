// §2 — identity. The Linear issue key is the only one.
//
//   node --test test/identity.test.mjs
//
// This is the net under the change that removed the second identity scheme.
// It used to be prevented by reconciliation: two writers, two naming schemes,
// a bridging column and three lookups that agreed after the fact. It is
// prevented now by the database refusing to hold the second row, and most of
// what is here exists to say that the difference is real.
//
// The other half is that nothing outside noticed. The agent's contract did not
// change, so every id anything has ever sent still has to reach the card it
// always reached — by parsing the key out of the string, which is a different
// thing from storing a second copy of it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  linearKeyFromSessionId, stageFromSessionId, parseSessionId, cardId, sessionKey,
} from '../lib/session-id.mjs';
import {  freshDb, env, call, agentPost, readLinear, issue, stubLinear, rows, one,
  applyPieces, PIECES, wire, session, sessionsOf,
} from './helpers.mjs';

// ──────────────────────────────────────────────────────────────────────
// The parser, on its own
// ──────────────────────────────────────────────────────────────────────

describe('§2 — the key is parsed out of whatever was sent', () => {
  test('every shape anything has ever used names the same issue', () => {
    for (const id of [
      'linear/RYV-84',        // the reader's old key
      'ryve/ryv-84/research', // the agent's contract
      'RYV-84/design',        // canonical
      'RYV-84',               // the card
      'ryv-84',               // lower case
      'conduit/ryv-84/design' // the wrong brand, which is still this issue
    ]) {
      assert.equal(linearKeyFromSessionId(id), 'RYV-84', `"${id}" stopped naming RYV-84`);
    }
  });

  test('a string with no issue in it names none', () => {
    for (const id of [
      'conduit/wallet-flow/design', 'zztest/runner-probe/reachability',
      '', null, undefined, 'design', 'a/b/c',
    ]) {
      assert.equal(linearKeyFromSessionId(id), null, `"${id}" was read as an issue key`);
    }
  });

  test('a key is matched as a whole segment, never inside one', () => {
    // 'wallet-flow' has the shape of a key if you squint. Matching a whole
    // segment is what stops a Hub-only session being adopted by an issue, and
    // what stops a key with something glued to it being read as that key.
    for (const id of [
      'conduit/wallet-flow/design',  // a project name, not a key
      'prefix-ryv-84/design',        // a key with a prefix run into it
      'a/ryv-84x/b',                 // trailing character
      'ryv-84-2',                    // a second number
      'RYV84',                       // no separator
    ]) {
      assert.equal(linearKeyFromSessionId(id), null, `"${id}" was read as an issue key`);
    }
  });

  test('anything shaped like a Linear key is treated as one', () => {
    // Deliberate. The Hub does not hold a list of team prefixes and should
    // not: Linear owns which teams exist (§1), a new one appears without
    // anybody telling the Hub, and a hardcoded list would silently drop its
    // issues. So 'notryv-84' parses, because a team called NOTRYV is a
    // perfectly ordinary thing for Linear to have. The cost of being wrong is
    // a lookup that finds no row; the cost of a stale allowlist is a card that
    // never appears.
    assert.equal(linearKeyFromSessionId('notryv-84/design'), 'NOTRYV-84');
    assert.equal(linearKeyFromSessionId('newteam-1/research'), 'NEWTEAM-1');
  });

  test('the stage is read from the segments, not assumed to be last', () => {
    assert.equal(stageFromSessionId('RYV-84/design'), 'design');
    assert.equal(stageFromSessionId('ryve/ryv-84/research'), 'research');
    assert.equal(stageFromSessionId('RYV-84'), null);
    assert.equal(stageFromSessionId('ryve/ryv-84/qa'), null, 'qa is not a stage the Hub runs');
  });

  test('parse gives both halves of the §2 identity at once', () => {
    assert.deepEqual(parseSessionId('ryve/ryv-84/design'), { issueKey: 'RYV-84', stage: 'design' });
    assert.deepEqual(parseSessionId('conduit/wallet-flow/x'), { issueKey: null, stage: null });
  });

  test('the canonical forms are what §2 says they are', () => {
    assert.equal(cardId('ryv-84'), 'RYV-84');
    assert.equal(sessionKey('ryv-84', 'design'), 'RYV-84/design');
    assert.equal(sessionKey('RYV-84', null), 'RYV-84');
    assert.equal(sessionKey(null, 'design'), null, 'a session with no issue was given a key');
  });
});

// ──────────────────────────────────────────────────────────────────────
// One issue, one card — structurally
// ──────────────────────────────────────────────────────────────────────

describe('§2 — one Linear issue can only ever be one card', () => {
  test('two rows cannot claim the same issue', async () => {
    const db = freshDb();
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(env(db));

    // The issue key IS the primary key now (piece11), so this is not a
    // constraint bolted on beside the identity — it is the identity.
    assert.throws(
      () => db.prepare(
        `INSERT INTO cards (issue_key, title) VALUES ('RYV-84', 'A second card')`
      ).run(),
      /UNIQUE|constraint|PRIMARY KEY/i,
      'a second row for RYV-84 was accepted — that makes §2 reconciliation again, not a rule');
  });

  test('one card may hold a session per stage', () => {
    // The finer grain §2 asks for: (issue_key, stage). Two sessions on one
    // card is the normal case, and the thing the old row could not express.
    const db = freshDb();
    db.prepare(`INSERT INTO cards (issue_key) VALUES ('RYV-84')`).run();
    db.prepare(`INSERT INTO stage_sessions (issue_key, stage) VALUES ('RYV-84', 'research')`).run();
    db.prepare(`INSERT INTO stage_sessions (issue_key, stage) VALUES ('RYV-84', 'design')`).run();

    assert.equal(rows(db).length, 1, 'two sessions became two cards');
    assert.equal(sessionsOf(db, 'RYV-84').length, 2);
  });

  test('but not two sessions at the same stage', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO cards (issue_key) VALUES ('RYV-84')`).run();
    db.prepare(`INSERT INTO stage_sessions (issue_key, stage) VALUES ('RYV-84', 'design')`).run();
    assert.throws(
      () => db.prepare(
        `INSERT INTO stage_sessions (issue_key, stage) VALUES ('RYV-84', 'design')`
      ).run(),
      /UNIQUE|constraint|PRIMARY KEY/i,
      '(issue_key, stage) is not the key it is supposed to be');
  });

  test('the two writers agree on the name without being told', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);

    await agentPost(e, {
      session_id: 'ryve/ryv-84/research', system: 'design-ai', status: 'active',
    });
    await readLinear(e);

    const all = rows(db);
    assert.equal(all.length, 1, 'two writers produced two rows again');
    assert.equal(all[0].issue_key, 'RYV-84');
  });

  test('and in the other order', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);

    await readLinear(e);
    await agentPost(e, {
      session_id: 'ryve/ryv-84/research', system: 'design-ai', status: 'active',
    });

    assert.equal(rows(db).length, 1, 'the agent post added a sibling card');
    assert.equal(rows(db)[0].issue_key, 'RYV-84');
  });

  test('a stage posted as its own session is still the same card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);

    await agentPost(e, { session_id: 'ryve/ryv-84/research', system: 'design-ai', status: 'done' });
    await agentPost(e, { session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'active' });

    assert.equal(rows(db).length, 1, 'each stage became its own card');

    // And each stage now keeps its own state, which is the thing the old row
    // could not do: reporting design active used to overwrite research's done.
    assert.equal(session(db, 'RYV-84', 'research').status, 'done');
    assert.equal(session(db, 'RYV-84', 'design').status, 'active');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Brand is a Linear fact, not part of the key
// ──────────────────────────────────────────────────────────────────────

describe('§2 — brand is not part of the key', () => {
  // "Brand is a Linear fact derived from the team. Encoding it in the key means
  // the key can contradict Linear: move the issue and ryve/ryv-84/design
  // becomes a lie nothing detects."
  //
  // So an agent posting the wrong brand has to be harmless. The id names the
  // issue, the issue is the identity, and the brand segment is a Linear fact
  // repeated back that the Hub does not take its word for.
  test('a session id naming the wrong brand still lands on the right card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84', team: 'Ryve App' })]);
    await readLinear(e);
    assert.equal(one(db, 'RYV-84').brand, 'ryve');

    // The issue changed team in Linear and the agent's id still says otherwise.
    await agentPost(e, {
      session_id: 'conduit/ryv-84/design', system: 'design-ai', status: 'active',
    });

    const all = rows(db);
    assert.equal(all.length, 1, 'a stale brand in the id created a second card');
    assert.equal(all[0].issue_key, 'RYV-84');
    assert.equal(all[0].brand, 'ryve',
      'a brand segment in a session id overwrote the brand derived from the team');
  });

  test('the brand still comes from the team on every read', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84', team: 'Ryve App' })]);
    await readLinear(e);
    assert.equal(one(db, 'RYV-84').brand, 'ryve');
    assert.equal(one(db, 'RYV-84').team, 'Ryve App');
    // And the wire still calls it `project`, because the agent posts it under
    // that name. lib/card.mjs is the only place the two names meet.
    assert.equal(wire(db, 'RYV-84').project, 'ryve');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Nothing outside noticed
// ──────────────────────────────────────────────────────────────────────

describe('§2 — every id anything has ever sent still reaches the card', () => {
  const forms = [
    ["the reader's old key", 'linear/RYV-84'],
    ["the agent's contract", 'ryve/ryv-84/research'],
    ['a later stage, never posted before', 'ryve/ryv-84/design'],
    ['the canonical session', 'RYV-84/design'],
    ['the card itself', 'RYV-84'],
    ['lower case', 'ryv-84'],
    ['the wrong brand', 'conduit/ryv-84/design'],
  ];

  for (const [what, id] of forms) {
    test(`${what} — ${id}`, async () => {
      const db = freshDb();
      const e = env(db);
      stubLinear([issue({ identifier: 'RYV-84' })]);
      await readLinear(e);

      const res = await call(e, 'GET', '/api/agent/session/' + encodeURIComponent(id),
                             undefined, { 'X-Agent-Secret': 's' });
      assert.equal(res.status, 200, `"${id}" no longer reaches the card`);
      assert.equal((await res.json()).linear_id, 'RYV-84');
    });
  }

  test('a control pressed through a legacy id reaches the same card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);

    const res = await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/trigger',
      { stage: 'research' });
    assert.equal(res.status, 200);
    assert.equal(wire(db, 'RYV-84').requested_stage, 'research');
  });

  test('an id naming no issue is a 404 rather than the wrong card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);

    const res = await call(e, 'GET', '/api/agent/session/' +
      encodeURIComponent('conduit/wallet-flow/design'), undefined, { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 404, 'an unrelated session id was resolved onto a card');
  });
});

// ──────────────────────────────────────────────────────────────────────
// A record with no issue key is not a card
// ──────────────────────────────────────────────────────────────────────

describe('§2 — a record with no issue key is not a card', () => {
  // §11: "Test card can't exercise its controls". A row with no issue has no
  // Linear uuid, so Run, Skip, Dismiss and Complete all refuse it. Drawing it
  // as a card offered a full set of controls where none of them could work,
  // and it was tested against once, which produced a false result.
  async function withBoth() {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await agentPost(e, {
      session_id: 'zztest/runner-probe/reachability', system: 'design-ai', status: 'active',
    });
    return { db, e };
  }

  test('it never reaches the board', async () => {
    const { db, e } = await withBoth();
    assert.equal(rows(db).length, 2, 'the fixture did not create both rows');

    const board = await (await call(e, 'GET', '/api/agent/sessions')).json();
    assert.deepEqual(board.map((r) => r.id), ['RYV-84'],
      'a record with no Linear issue was drawn as a card');
  });

  test('it still works on its own route, because the probe depends on it', async () => {
    // The runner reads a zztest session every run to prove the Hub is
    // reachable. §2 is about what is a card, not about what may exist.
    const { e } = await withBoth();
    const res = await call(e, 'GET', '/api/agent/session/' +
      encodeURIComponent('zztest/runner-probe/reachability'), undefined,
      { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 200, 'the runner probe stopped working');
  });

  test('every control refuses it, which is why it must not be drawn', async () => {
    const { e } = await withBoth();
    const at = '/api/agent/session/' + encodeURIComponent('zztest/runner-probe/reachability');

    for (const [method, path, body] of [
      ['POST', at + '/trigger', { stage: 'research' }],
      ['POST', at + '/dismiss', undefined],
      ['POST', at + '/complete', undefined],
    ]) {
      const res = await call(e, method, path, body);
      assert.equal(res.status, 400, `${path} did not refuse a record with no issue`);
      assert.match((await res.json()).error, /no linked Linear issue/);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// No second identity is stored
// ──────────────────────────────────────────────────────────────────────

describe('§2 — nothing stores a second identity', () => {
  test('the bridging column does not exist to be written', async () => {
    // Stronger than it was. migration-003 stopped writing `agent_session_id`;
    // piece11 built the new tables without it, so there is no column for a
    // second identity to live in even by accident.
    const db = freshDb();
    const cols = db.prepare(`PRAGMA table_info(cards)`).all().map((c) => c.name);
    assert.ok(!cols.includes('agent_session_id'),
      'the bridge came back — §2 forbids a column joining the two conventions');
    assert.ok(cols.includes('issue_key'), 'the card is not keyed by its issue');
  });

  test('what it stood in for is recorded on the session', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    assert.equal(session(db, 'RYV-84'), undefined,
      'discovering an issue created a session — §3 says Not started is the absence of one');

    await agentPost(e, {
      session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'active',
      detail: 'why this direction',
    });
    assert.ok(session(db, 'RYV-84', 'design').agent_posted_at, 'an agent post left no mark');
  });

  test('the agent detail and the Linear description stop competing', async () => {
    // This used to need a guard: both lived in one `detail` column, so a
    // Wednesday read would overwrite the context behind a decision prompt with
    // the Linear description unless something stopped it. They are separate
    // columns in separate tables now, so there is no guard to get wrong — and
    // both facts survive, which the old shape could not manage at all.
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84', description: 'The Linear description' })]);
    await readLinear(e);
    await agentPost(e, {
      session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'active',
      detail: 'why this direction',
    });

    stubLinear([issue({ identifier: 'RYV-84', description: 'Edited in Linear' })]);
    await readLinear(e);

    assert.equal(session(db, 'RYV-84', 'design').detail, 'why this direction',
      'a cron read wiped the agent detail');
    assert.equal(one(db, 'RYV-84').description, 'Edited in Linear',
      'the card stopped tracking its Linear description');
    // The board shows one line, and it is the agent's where there is one.
    assert.equal(wire(db, 'RYV-84').detail, 'why this direction');
  });

  test('a card no agent has touched shows its Linear description', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84', description: 'First' })]);
    await readLinear(e);
    stubLinear([issue({ identifier: 'RYV-84', description: 'Edited in Linear' })]);
    await readLinear(e);

    assert.equal(wire(db, 'RYV-84').detail, 'Edited in Linear',
      'a quiet card stopped tracking its Linear description');
  });
});

// ──────────────────────────────────────────────────────────────────────
// The migration
// ──────────────────────────────────────────────────────────────────────

// Everything applied after migration-003, which this block replays history
// from before. piece11 and migration-004 build on the column migration-003
// adds, so they cannot be in the database while it is being tested.
const AFTER_003 = ['migration-003-identity.sql', 'piece11-schema.sql',
                   'migration-004-grain.sql'];

describe('§2 — migration-003 renames without losing anything', () => {
  // The live database as it stands before the migration: a reader row under
  // the old key, with gate history against that key, and a Hub-only session
  // the migration must not touch.
  function beforeMigration() {
    const db = freshDb(PIECES.filter((p) => !AFTER_003.includes(p)));
    db.prepare(
      `INSERT INTO agent_sessions (id, system, project, phase, status, linear_id,
                                   agent_session_id, updated_at)
       VALUES ('linear/RYV-84', 'design-ai', 'ryve', 'design', 'waiting', 'RYV-84',
               'ryve/ryv-84/design', '2026-09-09 11:00:00')`).run();
    db.prepare(
      `INSERT INTO agent_sessions (id, system, project, phase, status, updated_at)
       VALUES ('conduit/wallet-flow/design', 'social-ai', 'conduit', 'design', 'active',
               '2026-09-09 11:00:00')`).run();
    db.prepare(
      `INSERT INTO gate_decisions (session_id, gate_round, options_snapshot, response_option_id)
       VALUES ('linear/RYV-84', 1, '[]', 'd1')`).run();
    return db;
  }

  const migrate = (db) => applyPieces(db, ['migration-003-identity.sql']);

  // This block runs against the database as it was *before* piece11, so
  // `cards` does not exist and the shared helpers cannot be used. These read
  // the old table directly, which is the point: it is testing what happened
  // to it.
  const old = (db, id) =>
    db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).get(id);
  const allOld = (db) =>
    db.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all();

  test('the card takes the name of its issue', () => {
    const db = beforeMigration();
    migrate(db);
    assert.ok(old(db, 'RYV-84'), 'the card was not renamed');
    assert.equal(old(db, 'linear/RYV-84'), undefined, 'the old row is still there');
  });

  test('gate history follows the card rather than being orphaned', () => {
    // §11 lists orphaned decision rows as a bug already had once.
    const db = beforeMigration();
    migrate(db);
    const kept = db.prepare(`SELECT session_id FROM gate_decisions`).all();
    assert.deepEqual(kept.map((r) => r.session_id), ['RYV-84'],
      'the decision history was left pointing at an id nothing answers to');
  });

  test('a Hub-only session is left exactly where it is', () => {
    const db = beforeMigration();
    migrate(db);
    assert.ok(old(db, 'conduit/wallet-flow/design'), 'a session with no issue was renamed');
  });

  test('the marker is backfilled, so no row changes behaviour', () => {
    const db = beforeMigration();
    migrate(db);
    assert.ok(old(db, 'RYV-84').agent_posted_at,
      'a card an agent had posted to lost that fact across the migration');
  });

  test('the data steps are idempotent', () => {
    const db = beforeMigration();
    migrate(db);
    const after = JSON.stringify(allOld(db).map((r) => [r.id, r.linear_id, r.agent_posted_at]));

    // The ALTER TABLE fails on a second run, which is what CLAUDE.md asks for:
    // "re-running one fails on a duplicate column instead of destroying data".
    // Everything after it is what has to be safe, so it is run directly.
    assert.throws(() => migrate(db), /duplicate column/i);
    const sql = `
      UPDATE gate_decisions
         SET session_id = (SELECT s.linear_id FROM agent_sessions s
                            WHERE s.id = gate_decisions.session_id AND s.linear_id IS NOT NULL)
       WHERE EXISTS (SELECT 1 FROM agent_sessions s
                      WHERE s.id = gate_decisions.session_id
                        AND s.linear_id IS NOT NULL AND s.id <> s.linear_id)`;
    db.exec(sql);
    db.exec(`UPDATE agent_sessions SET id = linear_id
              WHERE linear_id IS NOT NULL AND id <> linear_id`);

    assert.equal(
      JSON.stringify(allOld(db).map((r) => [r.id, r.linear_id, r.agent_posted_at])), after,
      'a second run moved something');
  });

  test('it refuses to run at all if two cards still share an issue', () => {
    const db = beforeMigration();
    db.prepare(
      `INSERT INTO agent_sessions (id, system, status, linear_id, updated_at)
       VALUES ('ryve/ryv-84/research', 'design-ai', 'active', 'RYV-84', '2026-09-08 10:00:00')`
    ).run();

    assert.throws(() => migrate(db), /UNIQUE|constraint/i,
      'the migration renamed rows with duplicates still in the table');
    // Nothing moved: the index is the first statement for exactly this reason.
    assert.ok(old(db, 'linear/RYV-84'), 'a failed migration had already renamed a row');
  });
});
