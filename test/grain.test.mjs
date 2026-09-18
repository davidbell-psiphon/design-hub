// piece11 — three kinds of fact, three homes, and what that makes possible.
//
//   node --test test/grain.test.mjs
//
// The identity work (§2, test/identity.test.mjs) made the card's *name* right.
// This is about its *grain*: a session is (issue_key, stage), so research and
// design each carry their own status, their own gate and their own history.
//
// Almost everything here was impossible before, and impossible in a way that
// did not show: runs are serialised, so only one stage was ever in flight and
// one set of gate columns was enough. The failure was waiting for the first
// time two stages had something to say at once — which is every one of §3's
// six states, §4's per-stage error, and §8's per-stage rounds.
//
// The other half is that nothing outside noticed. The board reads a flattened
// card and always has; lib/card.mjs computes that per request and never stores
// it, so there is no third copy to drift.

import { test, describe } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { toWire, activeSession } from '../lib/card.mjs';
import {
  freshDb, env, call, agentPost, readLinear, issue, stubLinear, rows, one,
  session, sessionsOf, wire,
} from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'RYV-84';

async function board(issues = [issue({ identifier: KEY })]) {
  const db = freshDb();
  const e = env(db);
  stubLinear(issues);
  await readLinear(e);
  return { db, e };
}

const post = (e, stage, body = {}) => agentPost(e, {
  session_id: `ryve/ryv-84/${stage}`, system: 'design-ai', status: 'active', ...body,
});

// ──────────────────────────────────────────────────────────────────────
// Two stages, two states
// ──────────────────────────────────────────────────────────────────────

describe('a card holds one session per stage', () => {
  test('research being done does not erase design being active', async () => {
    const { db, e } = await board();
    await post(e, 'research', { status: 'done' });
    await post(e, 'design', { status: 'active' });

    assert.equal(rows(db).length, 1, 'two stages became two cards');
    assert.equal(session(db, KEY, 'research').status, 'done');
    assert.equal(session(db, KEY, 'design').status, 'active');
  });

  test('a stage that failed and a stage waiting on a human coexist', async () => {
    // §4 keeps the last error, and §8 keeps an open gate. On one row these
    // were the same three columns and the second one posted won.
    const { db, e } = await board();
    await post(e, 'research', { status: 'error', prompt: 'No BCC documents for ryve' });
    await post(e, 'design', {
      status: 'waiting', prompt: 'Which direction?',
      options: [{ id: 'd1', label: 'One' }, { id: 'd2', label: 'Two' }],
    });

    assert.equal(session(db, KEY, 'research').status, 'error');
    assert.equal(session(db, KEY, 'research').prompt, 'No BCC documents for ryve');
    assert.equal(session(db, KEY, 'design').status, 'waiting');
    assert.equal(session(db, KEY, 'design').prompt, 'Which direction?');
  });

  test('each stage keeps its own gate and its own round', async () => {
    const { db, e } = await board();
    const opts = (a, b) => [{ id: a, label: a }, { id: b, label: b }];

    await post(e, 'research', { status: 'waiting', prompt: 'R?', options: opts('r1', 'r2') });
    await post(e, 'design', { status: 'waiting', prompt: 'D?', options: opts('d1', 'd2') });

    // Answer design, and reopen it. Research must not move.
    await call(e, 'PATCH', `/api/agent/session/${encodeURIComponent('ryve/ryv-84/design')}/respond`,
               { response_option_id: 'd2' });
    await call(e, 'PATCH', `/api/agent/session/${encodeURIComponent('ryve/ryv-84/design')}/reopen`,
               { note: 'neither, actually' });

    assert.equal(session(db, KEY, 'design').gate_round, 2, 'the design round did not move on');
    assert.equal(session(db, KEY, 'research').gate_round, 1,
                 'answering design moved research to round 2');
    assert.equal(session(db, KEY, 'research').response_option_id, null,
                 'answering design answered research');
  });

  test('gate history records which stage it belongs to', async () => {
    const { db, e } = await board();
    await post(e, 'design', {
      status: 'waiting', prompt: 'D?',
      options: [{ id: 'd1', label: 'One' }, { id: 'd2', label: 'Two' }],
    });
    await call(e, 'PATCH', `/api/agent/session/${encodeURIComponent('ryve/ryv-84/design')}/respond`,
               { response_option_id: 'd1' });
    await call(e, 'PATCH', `/api/agent/session/${encodeURIComponent('ryve/ryv-84/design')}/reopen`,
               { note: 'try again' });

    const history = db.prepare(`SELECT session_id, stage, gate_round FROM gate_decisions`).all();
    assert.equal(history.length, 1);
    assert.equal(history[0].session_id, KEY, 'history is filed under the issue key');
    assert.equal(history[0].stage, 'design',
                 'a decision was archived without saying which stage it decided');
  });

  test('finishing one stage does not take the other out of the queue', async () => {
    const { db, e } = await board();
    await call(e, 'POST', `/api/agent/session/${KEY}/trigger`, { stage: 'research' });
    await post(e, 'design', { status: 'waiting', prompt: 'D?' });

    await call(e, 'POST', '/api/agent/stage-done',
               { linear_id: KEY, stage: 'research' }, { 'X-Agent-Secret': 's' });

    assert.equal(session(db, KEY, 'research').status, 'done');
    assert.equal(session(db, KEY, 'research').requested_at, null);
    assert.equal(session(db, KEY, 'design').status, 'waiting',
                 'reporting research done marked the design session done too');
  });
});

// ──────────────────────────────────────────────────────────────────────
// What the board still sees
// ──────────────────────────────────────────────────────────────────────

describe('the projection speaks for the right session', () => {
  const s = (o) => ({ issue_key: KEY, stage: 'x', status: 'active', ...o });

  test('a queued session outranks everything', () => {
    const picked = activeSession([
      s({ stage: 'design', status: 'waiting', options: '[{"id":"d1","label":"One"}]',
          updated_at: '2026-09-18 12:00:00' }),
      s({ stage: 'research', requested_at: '2026-09-18 09:00:00',
          updated_at: '2026-09-18 09:00:00' }),
    ]);
    assert.equal(picked.stage, 'research');
  });

  test('the oldest request wins, which is the order the runner works in', () => {
    const picked = activeSession([
      s({ stage: 'design', requested_at: '2026-09-18 11:00:00' }),
      s({ stage: 'research', requested_at: '2026-09-18 09:00:00' }),
    ]);
    assert.equal(picked.stage, 'research');
  });

  test('an open gate outranks a quiet session', () => {
    const picked = activeSession([
      s({ stage: 'research', status: 'done', updated_at: '2026-09-18 12:00:00' }),
      s({ stage: 'design', status: 'waiting',
          options: '[{"id":"d1","label":"One"}]', updated_at: '2026-09-18 09:00:00' }),
    ]);
    assert.equal(picked.stage, 'design', 'a decision waiting on a human was passed over');
  });

  test('an answered gate is not an open one', () => {
    const picked = activeSession([
      s({ stage: 'research', status: 'done', updated_at: '2026-09-18 12:00:00' }),
      s({ stage: 'design', status: 'waiting', options: '[{"id":"d1","label":"One"}]',
          responded_at: '2026-09-18 10:00:00', response_option_id: 'd1',
          updated_at: '2026-09-18 09:00:00' }),
    ]);
    assert.equal(picked.stage, 'research', 'an answered gate still counted as needing someone');
  });

  test('otherwise the most recent thing that happened', () => {
    const picked = activeSession([
      s({ stage: 'research', status: 'done', updated_at: '2026-09-18 09:00:00' }),
      s({ stage: 'design', status: 'done', updated_at: '2026-09-18 12:00:00' }),
    ]);
    assert.equal(picked.stage, 'design');
  });

  test('no sessions is not started, and says so in every field', () => {
    const w = toWire({ issue_key: KEY, title: 'A real issue' }, []);
    assert.equal(w.status, null);
    assert.equal(w.prompt, null);
    assert.equal(w.options, null);
    assert.equal(w.requested_stage, null);
    assert.equal(w.response_kind, null);
    // Present and null, rather than absent — a consumer should not have to
    // test for two different kinds of nothing.
    for (const k of ['gate_round', 'response', 'response_option_id', 'responded_at']) {
      assert.ok(k in w, `${k} is missing rather than null on a card with no session`);
    }
  });
});

describe('the wire the board reads is unchanged', () => {
  // frontend/board-logic.js and index.html read exactly these. If the split
  // had changed any of them the board would have needed changing with it, and
  // it did not.
  const BOARD_READS = [
    'id', 'detail', 'dismissed_at', 'labels', 'linear_project', 'linear_state',
    'options', 'prompt', 'requested_at', 'requested_stage', 'responded_at',
    'response_label', 'response_note', 'response_option_id', 'set_aside_at',
    'status', 'team', 'updated_at', 'figma_url', 'linear_id', 'phase',
    'project', 'title', 'track', 'url',
  ];

  test('every field the board reads is present', async () => {
    const { db, e } = await board();
    await post(e, 'design', { status: 'waiting', prompt: 'D?' });
    const w = wire(db, KEY);
    for (const k of BOARD_READS) {
      assert.ok(k in w, `the board reads ${k} and the projection does not serve it`);
    }
  });

  test('and the list route serves the same shape', async () => {
    const { e } = await board();
    await post(e, 'design', { status: 'waiting', prompt: 'D?' });
    const list = await (await call(e, 'GET', '/api/agent/sessions')).json();
    assert.equal(list.length, 1);
    for (const k of BOARD_READS) {
      assert.ok(k in list[0], `the list route stopped serving ${k}`);
    }
  });

  test('stages rides alongside, for what reads per-stage state', async () => {
    const { e } = await board();
    await post(e, 'research', { status: 'done' });
    await post(e, 'design', { status: 'waiting', prompt: 'D?' });

    const list = await (await call(e, 'GET', '/api/agent/sessions')).json();
    assert.deepEqual(Object.keys(list[0].stages).sort(), ['design', 'research']);
    assert.equal(list[0].stages.research.status, 'done');
    assert.equal(list[0].stages.design.status, 'waiting');
  });

  test('the agent asking about one stage is answered about that stage', async () => {
    const { e } = await board();
    await post(e, 'research', { status: 'done' });
    await post(e, 'design', { status: 'waiting', prompt: 'Which direction?' });

    const res = await call(e, 'GET',
      '/api/agent/session/' + encodeURIComponent('ryve/ryv-84/research'),
      undefined, { 'X-Agent-Secret': 's' });
    const body = await res.json();
    assert.equal(body.status, 'done', 'asking about research answered about design');
    assert.equal(body.phase, 'research');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Who owns what
// ──────────────────────────────────────────────────────────────────────

describe('the three kinds of fact stay in their own homes', () => {
  test('the reader creates a card and no session', async () => {
    // §3: "Not started" is the absence of a session. Discovering an issue is
    // not a stage having run, and the reader used to write status='waiting'
    // and a prompt onto every row — a gate on every card that was not one.
    const { db } = await board();
    assert.equal(rows(db).length, 1);
    assert.deepEqual(sessionsOf(db, KEY), []);
    assert.equal(wire(db, KEY).status, null);
  });

  test('the Linear description and the agent context stop competing', async () => {
    const { db, e } = await board([issue({ identifier: KEY, description: 'From Linear' })]);
    await post(e, 'design', { detail: 'why this direction' });

    assert.equal(one(db, KEY).description, 'From Linear');
    assert.equal(session(db, KEY, 'design').detail, 'why this direction');
    // One line on the card, and it is the agent's where there is one.
    assert.equal(wire(db, KEY).detail, 'why this direction');
  });

  test('the cache carries its own age', async () => {
    // §5 permits a cache on three conditions, and this is the one that was
    // missing: "it has a visible age".
    const { db } = await board();
    assert.ok(one(db, KEY).linear_read_at, 'the Linear cache has no age on it');
  });

  test('a card can be deleted without leaving its sessions behind', async () => {
    const { db, e } = await board();
    await post(e, 'research', { status: 'done' });
    await post(e, 'design', { status: 'waiting', prompt: 'D?' });
    assert.equal(sessionsOf(db, KEY).length, 2);

    await call(e, 'DELETE', `/api/agent/session/${KEY}`);
    assert.equal(rows(db).length, 0);
    assert.deepEqual(sessionsOf(db, KEY), [],
      'the sessions outlived the card — orphaned rows, which §11 already lists once');
  });

  test('one run per card at a time, still', async () => {
    const { e } = await board();
    const first = await call(e, 'POST', `/api/agent/session/${KEY}/trigger`, { stage: 'research' });
    assert.equal(first.status, 200);
    const second = await call(e, 'POST', `/api/agent/session/${KEY}/trigger`, { stage: 'design' });
    assert.equal(second.status, 409, 'two stages of one card queued at once');
    assert.match((await second.json()).error, /already queued for research/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// The migration
// ──────────────────────────────────────────────────────────────────────

describe('migration-004 moves what is there without losing it', () => {
  // The database as it stands before the split: one row per issue, holding all
  // three kinds of fact.
  function beforeMigration() {
    const db = freshDb(PIECES_BEFORE);
    db.prepare(
      `INSERT INTO agent_sessions
         (id, system, project, track, phase, status, prompt, detail, url, linear_id,
          team, linear_uuid, linear_state, title, labels, figma_url, dismissed_at,
          requested_stage, requested_at, agent_posted_at, gate_round, created_at, updated_at)
       VALUES ('RYV-84', 'design-ai', 'ryve', 'app', 'design', 'waiting',
               'Which direction?', 'why this direction',
               'https://linear.app/x/issue/RYV-84', 'RYV-84', 'Ryve App', 'uuid-RYV-84',
               'started', 'Add Currency', '["AI-research done"]', 'https://figma.com/f/1',
               NULL, 'design', '2026-09-17 10:00:00', '2026-09-17 09:00:00', 3,
               '2026-09-01 08:00:00', '2026-09-17 11:00:00')`).run();
    // `requested_at` left behind with no `requested_stage` beside it. The two
    // were written and cleared together, so this should not happen — which is
    // exactly why the migration has to survive it. Carrying the timestamp
    // across on its own would queue a run nobody asked for, on a card nobody
    // is watching, the moment the new Worker reads the queue.
    db.prepare(
      `INSERT INTO agent_sessions (id, system, phase, status, detail, linear_id,
                                   linear_uuid, title, requested_at,
                                   created_at, updated_at)
       VALUES ('CON-9', 'design-ai', 'research', 'active', 'A Linear description',
               'CON-9', 'uuid-CON-9', 'Wallet', '2026-09-05 12:00:00',
               '2026-09-02 08:00:00', '2026-09-02 08:00:00')`
    ).run();
    // No Linear issue: §2 says this is not a card, and it does not become one.
    db.prepare(
      `INSERT INTO agent_sessions (id, system, phase, status, updated_at)
       VALUES ('conduit/wallet-flow/design', 'social-ai', 'design', 'active',
               '2026-09-09 11:00:00')`).run();
    return db;
  }

  const migrate = (db) => applyPieces(db, ['piece11-schema.sql', 'migration-004-grain.sql']);

  test('every card comes across with what it owned', () => {
    const db = beforeMigration();
    migrate(db);

    const card = one(db, 'RYV-84');
    assert.equal(card.title, 'Add Currency');
    assert.equal(card.linear_uuid, 'uuid-RYV-84');
    assert.equal(card.brand, 'ryve', 'the brand did not come across from `project`');
    assert.equal(card.figma_url, 'https://figma.com/f/1');
    assert.deepEqual(JSON.parse(card.labels), ['AI-research done']);
  });

  test('the session comes across at the stage that was queued', () => {
    const db = beforeMigration();
    migrate(db);

    const s = session(db, 'RYV-84', 'design');
    assert.ok(s, 'the session did not land on the stage that was queued');
    assert.equal(s.status, 'waiting');
    assert.equal(s.prompt, 'Which direction?');
    assert.equal(s.gate_round, 3, 'the round was reset');
    assert.equal(s.requested_at, '2026-09-17 10:00:00');
  });

  test('the agent detail and the Linear description are separated correctly', () => {
    const db = beforeMigration();
    migrate(db);

    // An agent had posted to RYV-84, so `detail` was its context, not Linear's.
    assert.equal(session(db, 'RYV-84', 'design').detail, 'why this direction');
    assert.equal(one(db, 'RYV-84').description, null,
      'the agent context was filed as the Linear description');

    // Nothing had posted to CON-9, so `detail` was the Linear description.
    assert.equal(one(db, 'CON-9').description, 'A Linear description');
    assert.equal(session(db, 'CON-9', 'research').detail, null);
  });

  test('a record with no Linear issue does not become a card', () => {
    const db = beforeMigration();
    migrate(db);
    assert.deepEqual(rows(db).map((r) => r.issue_key).sort(), ['CON-9', 'RYV-84']);
  });

  test('a card with nothing queued is not queued by the migration', () => {
    const db = beforeMigration();
    migrate(db);
    assert.equal(session(db, 'CON-9', 'research').requested_at, null,
      'a card nobody had asked to run came out of the migration queued');
  });

  test('running it twice changes nothing', () => {
    const db = beforeMigration();
    migrate(db);
    const snapshot = () => JSON.stringify([
      rows(db).map((r) => [r.issue_key, r.brand, r.description]),
      db.prepare(`SELECT issue_key, stage, status, requested_at FROM stage_sessions
                   ORDER BY issue_key, stage`).all().map((r) => Object.values(r)),
    ]);
    const after = snapshot();
    // The ALTER TABLE fails on a second run, which is what CLAUDE.md asks for.
    // Everything before it is INSERT OR IGNORE and has to be safe.
    try { migrate(db); } catch (e) { /* duplicate column name: expected */ }
    assert.equal(snapshot(), after, 'a second run moved something');
  });
});


// ──────────────────────────────────────────────────────────────────────
// §4 — the last error is kept and shown
// ──────────────────────────────────────────────────────────────────────

describe('§4 — an error that cannot be read is still a mystery', () => {
  // "The last error is kept and shown on the card — message, stage, and when.
  // An error that exists only in a terminal you have closed is not an error
  // state, it is a mystery."
  //
  // This was failing in production. A research run died, and the card said:
  //
  //   Research failed — claude-failed. {"is_error":true,"duration_api_ms":
  //   671294,"num_turns":42,"stop_reason":"tool_use","session_id":"1e5b7abe-…
  //
  // truncated mid-field, naming no cause, filed in `prompt` — which is the
  // question put to a human, not a place for a stack trace.
  async function errored(body = {}) {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await agentPost(e, {
      session_id: 'ryve/ryv-84/research', system: 'design-ai', status: 'error',
      prompt: 'Research failed — claude-failed.',
      last_error: 'claude exited 1 (stop_reason: tool_use, 42 turns)\nfull output: logs/runs/x/RYV-84.json',
      ...body,
    });
    return { db, e };
  }

  test('it is kept, with the stage and the time', async () => {
    const { db } = await errored();
    const s = session(db, 'RYV-84', 'research');
    assert.match(s.last_error, /stop_reason: tool_use/);
    assert.ok(s.last_error_at, 'the error has no time on it');
    assert.equal(s.stage, 'research', 'the error is not attached to a stage');
  });

  test('the whole message survives — no truncation mid-field', async () => {
    // 400 characters was the old limit, and it cut the only useful part.
    const long = 'x'.repeat(1200) + ' END';
    const { db } = await errored({ last_error: long });
    assert.match(session(db, 'RYV-84', 'research').last_error, /END$/,
      'the error was truncated before the part that says what happened');
  });

  test('an agent that reports an error and says nothing still leaves a trace', async () => {
    const { db } = await errored({ last_error: undefined, prompt: undefined });
    assert.ok(session(db, 'RYV-84', 'research').last_error,
      'a card said it failed and could not say how — the mystery §4 names');
  });

  test('it falls back to the prompt, for errors written before the column', async () => {
    const { db } = await errored({ last_error: undefined });
    assert.match(session(db, 'RYV-84', 'research').last_error, /claude-failed/);
  });

  test('starting again clears it', async () => {
    // A run that is going is not still carrying the last failure.
    const { db, e } = await errored();
    await agentPost(e, {
      session_id: 'ryve/ryv-84/research', system: 'design-ai', status: 'active',
    });
    const s = session(db, 'RYV-84', 'research');
    assert.equal(s.last_error, null, 'a running card still showed the last failure');
    assert.equal(s.last_error_at, null);
  });

  test('it reaches the board', async () => {
    const { db } = await errored();
    const w = wire(db, 'RYV-84');
    assert.match(w.last_error, /stop_reason: tool_use/);
    assert.ok(w.last_error_at);
  });

  test('and one stage failing does not put an error on the other', async () => {
    const { db, e } = await errored();
    await agentPost(e, {
      session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'waiting',
      prompt: 'Which direction?',
    });
    assert.ok(session(db, 'RYV-84', 'research').last_error);
    assert.equal(session(db, 'RYV-84', 'design').last_error, null,
      'the design session inherited the research failure');
  });
});

describe('§4 — the board can read a failure at a glance', () => {
  const b = (row) => {
    const ctx = vm.createContext({ Date, Math, isNaN, String });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), ctx);
    return ctx;
  };

  test('the summary is the first line, not the whole dump', () => {
    const ctx = b();
    const row = { status: 'error',
      last_error: 'claude exited 1 (stop_reason: tool_use, 42 turns)\nfull output: logs/runs/x/RYV-84.json' };
    assert.equal(ctx.failureSummary(row), 'claude exited 1 (stop_reason: tool_use, 42 turns)');
    // The rest is still available where there is room for it.
    assert.match(ctx.failureReason(row), /full output:/);
  });

  test('a very long first line is cut short and marked as cut', () => {
    // Cut by character count, not by word — a card has a fixed width and the
    // ellipsis is what says there is more, which `failureReason` still has.
    const ctx = b();
    const row = { status: 'error', last_error: 'y'.repeat(400) };
    const out = ctx.failureSummary(row);
    assert.ok(out.length <= 200, 'a 400-character line reached the card whole');
    assert.match(out, /…$/, 'it was cut with nothing to say so');
    assert.equal(ctx.failureReason(row).length, 400, 'the full text was lost too');
  });

  test('an error written before the column still reads', () => {
    const ctx = b();
    assert.equal(ctx.failureSummary({ status: 'error', prompt: 'Research failed — old style' }),
                 'Research failed — old style');
  });

  test('a card that has not failed says nothing', () => {
    const ctx = b();
    assert.equal(ctx.failureSummary({ status: 'active', last_error: 'stale' }), '');
    assert.equal(ctx.failureAt({ status: 'active', last_error_at: 'x' }), '');
  });
});

// The pieces as they stood before the split, for the migration block above.
// Imported late so the list is next to the thing that uses it.
import { PIECES, applyPieces } from './helpers.mjs';
const AFTER = ['piece11-schema.sql', 'migration-004-grain.sql'];
const PIECES_BEFORE = PIECES.filter((p) => !AFTER.includes(p));
