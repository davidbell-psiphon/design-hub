// §14.4 — the rules of the architecture, as tests named after the rules.
//
//   node --test test/invariants.test.mjs
//
// The point of naming them this way: a violation reports which rule broke
// rather than which line. The other suites test behaviour, and behaviour is
// allowed to change. These test the things that are not allowed to change, so
// when one goes red the question is never "is this test out of date" — it is
// "which rule did we just break, and did we mean to".
//
// §14 also asks for the configuration and connectivity checks that fail
// silently in production, and those are here for the same reason: they are
// about whether the system is wired up at all, not about what it does.
//
// Every fixture carries a real Linear issue key (§2). A fixture with no issue
// cannot exercise the controls, and testing against one has produced a false
// result here before.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { diagnose, accessState, HEARTBEAT_STALE_MIN } from '../lib/diagnostics.mjs';
import { deriveBrand, deriveTrack, TEAM_BRAND, TEAM_TRACK } from '../lib/derive.mjs';
import {  freshDb, env, call, agentPost, readLinear, issue, stubLinear, d1, one, wire, session, sessionsOf,
} from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// board-logic.js in a bare context, same as unit.test.mjs.
const board = vm.createContext({ Date, Math, isNaN, String });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), board);
const { stageOf, stageState, actionFor, isSkipped, hasLabel } = board;

// actionFor returns an object built inside the vm context, which carries a
// different Object prototype — deepStrictEqual refuses it however well the
// structure matches. The fields are what the assertion is about.
function assertAction(action, stage, label, msg) {
  assert.ok(action, msg + ' — no action was offered at all');
  assert.equal(action.stage, stage, msg);
  assert.equal(action.label, label, msg);
}

// A database with a machine currently checked in. The heartbeat check is a
// real dependency and fails when nothing has ever called in (§14.2), so a
// suite asking "is this Hub otherwise healthy" has to hold that steady or it
// is measuring two things at once.
function healthyDb() {
  const db = freshDb();
  db.prepare(
    `INSERT INTO agent_heartbeats (machine, capabilities, last_seen, first_seen)
     VALUES ('dave-bell-jr', '[]', datetime('now'), datetime('now'))`
  ).run();
  return db;
}

// A card as the board receives it: labels as the JSON array the reader stores.
const card = (labels = [], extra = {}) => ({
  id: 'RYV-84', linear_id: 'RYV-84', title: 'A real issue',
  labels: JSON.stringify(labels), ...extra,
});

// ──────────────────────────────────────────────────────────────────────
// §3 — claims and evidence
// ──────────────────────────────────────────────────────────────────────

describe('§3 — the Manager never writes a label to correct drift', () => {
  // Drift is evidence without a claim: the stage ran, the label was never
  // written. §3 says it is surfaced and never auto-corrected, because writing
  // the missing label would make the Manager the author of a fact it does not
  // own (§1). The reader is where that temptation lives — it is the pass that
  // can see the disagreement — so it is the pass that must keep its hands off.
  test('a full reader pass writes nothing to Linear', async () => {
    const db = freshDb();
    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84', labels: [] })], mutations);

    await readLinear(env(db));

    assert.deepEqual(mutations, [],
      'the reader mutated Linear — discovery and reconciliation are reads');
  });

  test('a second pass over an unlabelled issue still writes nothing', async () => {
    const db = freshDb();
    const mutations = [];
    // An issue the Hub already holds, with no stage labels on it at all: the
    // exact shape that looks like something the Hub could helpfully fix.
    stubLinear([issue({ identifier: 'RYV-84', labels: [] })], mutations);
    await readLinear(env(db));
    await readLinear(env(db));

    assert.deepEqual(mutations, [], 'a repeat read started writing labels');
  });

  test('reading the board writes nothing to Linear', async () => {
    const db = freshDb();
    stubLinear([issue({ identifier: 'RYV-84', labels: [] })]);
    await readLinear(env(db));

    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84', labels: [] })], mutations);
    await call(env(db), 'GET', '/api/agent/sessions');
    await call(env(db), 'GET', '/api/sessions');

    assert.deepEqual(mutations, [], 'rendering the board wrote to Linear');
  });
});

// ──────────────────────────────────────────────────────────────────────
// §5 — read discipline
// ──────────────────────────────────────────────────────────────────────

describe('§5 — a Linear-owned fact is refreshed, never merged', () => {
  // The Hub keeps a copy of title, state and labels so the board can render
  // without a Linear call per card. §5 permits that as a cache and forbids it
  // becoming a second home. The line between those two is whether a read
  // overwrites it: a cache that COALESCEs is a cache that can disagree with
  // its source for ever, which is the "stale claim" §3 says is never
  // acceptable.
  const stale = {
    title: 'A title from three weeks ago',
    labels: JSON.stringify(['AI-research done']),
    linear_state: 'backlog',
    team: 'Wrong Team',
  };

  test('the reader overwrites a stale local copy rather than keeping it', async () => {
    const db = freshDb();
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(env(db));

    db.prepare(
      `UPDATE cards SET title = ?, labels = ?, linear_state = ?, team = ?
        WHERE issue_key = 'RYV-84'`
    ).run(stale.title, stale.labels, stale.linear_state, stale.team);

    stubLinear([issue({
      identifier: 'RYV-84', title: 'The title Linear actually has',
      labels: [{ name: 'AI-design done' }], state: 'started', team: 'Ryve App',
    })]);
    await readLinear(env(db));

    const row = one(db, 'RYV-84');
    assert.equal(row.title, 'The title Linear actually has', 'title survived as a stale copy');
    assert.equal(row.team, 'Ryve App', 'team survived as a stale copy');
    assert.deepEqual(JSON.parse(row.labels), ['AI-design done'],
      'labels were merged rather than replaced — Linear owns the whole set');
    assert.equal(row.linear_state, 'started', 'linear_state survived as a stale copy');
  });

  test('the same pass leaves every Hub-owned fact alone', async () => {
    const db = freshDb();
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(env(db));

    // The card's own overrides…
    db.prepare(
      `UPDATE cards
          SET figma_url = 'https://figma.com/file/abc',
              set_aside_at = '2026-09-01 10:00:00',
              brand = 'conduit'
        WHERE issue_key = 'RYV-84'`
    ).run();
    // …and a run queued on the session, which is a different table now. The
    // reader must leave both alone, and the two halves are written by
    // different code, so both are worth asserting.
    db.prepare(
      `INSERT INTO sessions (issue_key, stage, requested_at)
       VALUES ('RYV-84', 'design', '2026-09-01 10:00:00')`
    ).run();

    stubLinear([issue({ identifier: 'RYV-84', team: 'Ryve App' })]);
    await readLinear(env(db));

    const row = one(db, 'RYV-84');
    assert.equal(row.figma_url, 'https://figma.com/file/abc', 'a read cleared the Figma override');
    assert.equal(row.set_aside_at, '2026-09-01 10:00:00', 'a read un-set-aside a card');
    assert.equal(row.brand, 'conduit', 'a read undid a manual brand reassignment');
    assert.equal(wire(db, 'RYV-84').requested_stage, 'design', 'a read cleared a queued run');
  });

  // The one CLAUDE.md calls out by name, and the one the first pass of this
  // suite missed. A cron read can only ever ADD a dismissal, never clear one:
  // the card is dismissed here, the label is gone from Linear, and a Wednesday
  // read must not put it back on the board. Dismissing is the Hub's own fact
  // (§1), so Linear's silence about it says nothing at all.
  test('a read can add a dismissal and never clear one', async () => {
    const db = freshDb();
    stubLinear([issue({ identifier: 'RYV-84', labels: [{ name: 'no-design' }] })]);
    await readLinear(env(db));
    assert.ok(one(db, 'RYV-84').dismissed_at, 'the no-design label did not dismiss the card');

    // The label comes off in Linear. The dismissal is the Hub's, and stays.
    stubLinear([issue({ identifier: 'RYV-84', labels: [] })]);
    await readLinear(env(db));

    assert.ok(one(db, 'RYV-84').dismissed_at,
      'a cron read un-dismissed a card — every dismissal whose label had been removed ' +
      'in Linear would come back onto the board');
  });

  test('a card dismissed in the Hub is not resurrected by a read', async () => {
    const db = freshDb();
    stubLinear([issue({ identifier: 'RYV-84', labels: [] })]);
    await readLinear(env(db));

    await call(env(db), 'POST', '/api/agent/session/linear%2FRYV-84/dismiss');
    const dismissedAt = one(db, 'RYV-84').dismissed_at;
    assert.ok(dismissedAt);

    // Linear has not caught up — the mutation has not propagated to what the
    // next read sees. The board must not flicker.
    stubLinear([issue({ identifier: 'RYV-84', labels: [] })]);
    await readLinear(env(db));

    assert.equal(one(db, 'RYV-84').dismissed_at, dismissedAt,
      'a read undid a dismissal made seconds earlier');
  });
});

describe('§5 — the button and the column come from one derivation', () => {
  // "A button and a column reading different sources will drift, and the drift
  // is invisible until someone presses the button." This asserts on the
  // derivation rather than on markup, so it holds when the UI changes.
  //
  // Every combination of the four reserved labels, which is the whole input
  // space the board's column logic has.
  const RESERVED = ['AI-research done', 'AI-design done', 'no-research', 'no-design'];

  const combinations = () => {
    const out = [];
    for (let mask = 0; mask < (1 << RESERVED.length); mask++) {
      out.push(RESERVED.filter((_, i) => mask & (1 << i)));
    }
    return out;
  };

  test('the action a card offers always matches the column it is drawn in', () => {
    for (const labels of combinations()) {
      const r = card(labels);
      const column = stageOf(r);
      const action = actionFor(r);

      if (column === 'backlog') {
        assertAction(action, 'research', 'Run Research',
          `a card in Backlog offered ${JSON.stringify(action)} — labels: ${labels}`);
      } else if (column === 'researched') {
        assertAction(action, 'design', 'Run Design',
          `a card in Researched offered ${JSON.stringify(action)} — labels: ${labels}`);
      } else {
        assert.equal(action, null,
          `a card in AI-designed still offered an action — labels: ${labels}`);
      }
    }
  });

  test('every combination lands in exactly one column', () => {
    for (const labels of combinations()) {
      const column = stageOf(card(labels));
      assert.ok(['backlog', 'researched', 'designed'].includes(column),
        `labels ${JSON.stringify(labels)} produced column "${column}"`);
    }
  });

  test('a skipped stage advances the card and still reads as skipped', () => {
    const skipped = card(['no-research']);
    assert.equal(stageOf(skipped), 'researched', 'skipping did not advance the card');
    assert.equal(isSkipped(skipped), true, 'a skipped card is indistinguishable from a done one');
    assertAction(actionFor(skipped), 'design', 'Run Design',
      'a skipped research stage did not make the card eligible for design');

    const done = card(['AI-research done']);
    assert.equal(stageOf(done), 'researched');
    assert.equal(isSkipped(done), false, 'a completed stage reported itself as skipped');
  });

  test('done outranks skipped when an issue carries both', () => {
    const both = card(['no-research', 'AI-research done']);
    assert.equal(stageState(both, 'research'), 'done',
      'the label the system wrote lost to the one saying it was not going to happen');
  });
});

// ──────────────────────────────────────────────────────────────────────
// §6 — write discipline
// ──────────────────────────────────────────────────────────────────────

describe('§6 — every write to Linear is idempotent', () => {
  // "Applying a label already applied succeeds silently. Retrying a failed
  // write is always safe." The runner retries: stage-done deliberately leaves
  // the queue entry in place when the label write fails, so the second attempt
  // is the normal path and not the exception.
  async function cardFor(db, identifier = 'RYV-84') {
    stubLinear([issue({ identifier })]);
    await readLinear(env(db));
  }

  test('stage-done twice succeeds twice', async () => {
    const db = freshDb();
    await cardFor(db);

    const first = await call(env(db), 'POST', '/api/agent/stage-done',
      { linear_id: 'RYV-84', stage: 'research' });
    const second = await call(env(db), 'POST', '/api/agent/stage-done',
      { linear_id: 'RYV-84', stage: 'research' });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'the retry that the failure path depends on was rejected');
  });

  test('the label is recorded once, however many times it is applied', async () => {
    const db = freshDb();
    await cardFor(db);

    await call(env(db), 'POST', '/api/agent/stage-done', { linear_id: 'RYV-84', stage: 'research' });
    await call(env(db), 'POST', '/api/agent/stage-done', { linear_id: 'RYV-84', stage: 'research' });
    await call(env(db), 'POST', '/api/agent/stage-done', { linear_id: 'RYV-84', stage: 'research' });

    const labels = JSON.parse(one(db, 'RYV-84').labels);
    assert.deepEqual(labels.filter((l) => l === 'AI-research done'), ['AI-research done'],
      'the local label set accumulated duplicates');
  });

  test('dismissing twice succeeds and does not move the timestamp', async () => {
    const db = freshDb();
    await cardFor(db);

    await call(env(db), 'POST', '/api/agent/session/linear%2FRYV-84/dismiss');
    const firstAt = one(db, 'RYV-84').dismissed_at;
    await call(env(db), 'POST', '/api/agent/session/linear%2FRYV-84/dismiss');
    const secondAt = one(db, 'RYV-84').dismissed_at;

    assert.equal(secondAt, firstAt, 'a repeat dismissal rewrote when it was dismissed');
  });

  test('a failed label write leaves the queue entry to be retried', async () => {
    const db = freshDb();
    await cardFor(db);
    await call(env(db), 'POST', '/api/agent/session/linear%2FRYV-84/trigger', { stage: 'research' });

    stubLinear([issue({ identifier: 'RYV-84' })], null, { mutationError: true });
    const res = await call(env(db), 'POST', '/api/agent/stage-done',
      { linear_id: 'RYV-84', stage: 'research' });

    assert.equal(res.status, 502);
    assert.equal(wire(db, 'RYV-84').requested_stage, 'research',
      'a stage whose label could not be written vanished from the queue');
  });
});

describe('§6 — issue status moves only when a human presses Complete', () => {
  // §15 asked whether the Manager advances Linear status. It does, through one
  // route, and §6 says it never should. The document moves rather than the
  // code: the rule is there to stop the Manager *inventing* a fact it does not
  // own — deciding by itself that work is finished — and a human pressing
  // Complete is not that. It is the press being carried to Linear.
  //
  // What keeps that defensible is that it is the only path that can do it.
  // These are what say so, and they are the reason the exception is safe
  // rather than the paragraph explaining it.
  const statusWrites = (queries) =>
    queries.filter((q) => /issueUpdate/.test(q));

  async function withRecorder(fn) {
    const db = freshDb();
    const queries = [];
    stubLinear([issue({ identifier: 'RYV-84' })], null, { queries });
    const e = env(db);
    await readLinear(e);
    queries.length = 0;          // discovery itself is not what is under test
    await fn(db, e, queries);
    return queries;
  }

  test('a cron read never writes issue status', async () => {
    const queries = await withRecorder(async (db, e) => {
      await readLinear(e);
      await readLinear(e);
    });
    assert.deepEqual(statusWrites(queries), [],
      'the reader moved an issue in Linear — §6 forbids it and §1 says Linear owns it');
  });

  test('an agent post never writes issue status', async () => {
    const queries = await withRecorder(async (db, e) => {
      await agentPost(e, {
        session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'done',
      });
    });
    assert.deepEqual(statusWrites(queries), [],
      'an agent reporting done moved the issue in Linear');
  });

  test('reporting a finished stage never writes issue status', async () => {
    // The nearest miss of all: the stage is done, so it is tempting. It
    // applies a label, which §1 says the agent owns, and stops there.
    const queries = await withRecorder(async (db, e) => {
      await call(e, 'POST', '/api/agent/stage-done',
                 { linear_id: 'RYV-84', stage: 'design' }, { 'X-Agent-Secret': 's' });
    });
    assert.deepEqual(statusWrites(queries), [],
      'finishing the design stage moved the issue to Done by itself');
  });

  test('dismissing and setting aside never write issue status', async () => {
    const queries = await withRecorder(async (db, e) => {
      await call(e, 'POST', '/api/agent/session/RYV-84/dismiss');
      await call(e, 'POST', '/api/agent/session/RYV-84/setaside');
    });
    assert.deepEqual(statusWrites(queries), [],
      'filing a card away closed the issue');
  });

  test('pressing Complete does write it, which is the whole exception', async () => {
    const queries = await withRecorder(async (db, e) => {
      const res = await call(e, 'POST', '/api/agent/session/RYV-84/complete');
      assert.equal(res.status, 200);
    });
    assert.equal(statusWrites(queries).length, 1,
      'the one route that is supposed to write status stopped doing it');
  });

  test('and it refuses a card with no Linear issue behind it', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await agentPost(e, {
      session_id: 'zztest/probe/design', system: 'design-ai', status: 'active',
    });
    const res = await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('zztest/probe/design') + '/complete');
    assert.equal(res.status, 400);
  });
});

// ──────────────────────────────────────────────────────────────────────
// §8 — what a decision is
// ──────────────────────────────────────────────────────────────────────

describe('§8 — a response naming no option is never a decision', () => {
  const OPTIONS = [
    { id: 'd1', label: 'Single column' },
    { id: 'd2', label: 'Split header' },
  ];

  async function gated() {
    const db = freshDb();
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(env(db));
    await agentPost(env(db), {
      session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'waiting',
      prompt: 'Which direction?', options: OPTIONS,
    });
    return db;
  }

  const undecided = (db) => {
    const row = session(db, 'RYV-84');
    assert.equal(row.responded_at, null, 'the gate recorded an answer it should have refused');
    assert.equal(row.response_option_id, null, 'an option id was stored that was never offered');
    assert.equal(row.status, 'waiting', 'the card stopped waiting on a decision nobody made');
  };

  test('prose is rejected, and the gate stays open', async () => {
    const db = await gated();
    const res = await call(env(db), 'PATCH', '/api/agent/session/linear%2FRYV-84/respond',
      { response: 'Yes' });

    assert.equal(res.status, 400, '"Yes" was accepted as an answer to a two-option question');
    undecided(db);
  });

  test('a note alone is rejected, and the gate stays open', async () => {
    const db = await gated();
    const res = await call(env(db), 'PATCH', '/api/agent/session/linear%2FRYV-84/respond',
      { response_note: 'I like the second one better' });

    assert.equal(res.status, 400, 'a note decided a gate');
    undecided(db);
  });

  test('an empty body is rejected, and the gate stays open', async () => {
    const db = await gated();
    const res = await call(env(db), 'PATCH', '/api/agent/session/linear%2FRYV-84/respond', {});

    assert.equal(res.status, 400);
    undecided(db);
  });

  test('an option id that was never offered is rejected', async () => {
    const db = await gated();
    const res = await call(env(db), 'PATCH', '/api/agent/session/linear%2FRYV-84/respond',
      { response_option_id: 'd9' });

    assert.equal(res.status, 400, 'an id naming nothing on the list was stored as a decision');
    const body = await res.json();
    assert.match(body.error, /d1, d2/, 'the refusal did not say what the gate actually offers');
    undecided(db);
  });

  test('the refusal names the options rather than just saying no', async () => {
    const db = await gated();
    const res = await call(env(db), 'PATCH', '/api/agent/session/linear%2FRYV-84/respond',
      { response: 'Yes' });
    const body = await res.json();
    assert.match(body.error, /d1, d2/);
  });

  test('naming an offered option is accepted, and is the only thing that is', async () => {
    const db = await gated();
    const res = await call(env(db), 'PATCH', '/api/agent/session/linear%2FRYV-84/respond',
      { response_option_id: 'd2', response_note: 'keep the balance visible' });

    assert.equal(res.status, 200);
    const row = session(db, 'RYV-84');
    assert.equal(row.response_option_id, 'd2');
    assert.equal(row.response, 'Split header',
      'the stored answer was typed rather than copied off the chosen option');
    assert.ok(row.responded_at, 'an accepted decision was not timestamped');
  });

  test('a design you drew yourself is a decision, and carries no option id', async () => {
    const db = await gated();
    const res = await call(env(db), 'PATCH', '/api/agent/session/linear%2FRYV-84/respond',
      { response_section: 'Wallet v4 — Dave' });

    assert.equal(res.status, 200);
    const row = session(db, 'RYV-84');
    assert.equal(row.response_option_id, null,
      'a section name was stored in the column that only ever holds offered ids');
    assert.equal(row.response_note, 'Wallet v4 — Dave');
    assert.ok(row.responded_at);
  });

  test('a gate with no options is still answered in prose', async () => {
    const db = freshDb();
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(env(db));
    await agentPost(env(db), {
      session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'waiting',
      prompt: 'Anything to add before I start?',
    });

    const res = await call(env(db), 'PATCH', '/api/agent/session/linear%2FRYV-84/respond',
      { response: 'Go wider' });
    assert.equal(res.status, 200, 'the options rule leaked onto a gate that offered none');
  });
});

// ──────────────────────────────────────────────────────────────────────
// §12 — reserved vocabulary
// ──────────────────────────────────────────────────────────────────────

describe('§12 — the label list is closed', () => {
  // "This list is closed — adding to it is a decision, not a convenience."
  // And: "Absence means 'not yet' and nothing else."
  test('an unknown label changes nothing about where a card sits', () => {
    const plain = stageOf(card([]));
    for (const noise of ['design-ai:go', 'design-ai:qa', 'AI-QA done', 'urgent', 'p1', '']) {
      assert.equal(stageOf(card([noise])), plain,
        `the label "${noise}" moved a card between columns`);
    }
  });

  test('a retired trigger label does not trigger anything', () => {
    // design-ai:go is still on RYV-84 in Linear and is documented as having no
    // effect (§12). "No effect" is a claim worth holding down rather than
    // trusting, because it is on real issues right now.
    const r = card(['design-ai:go']);
    assert.equal(stageOf(r), 'backlog');
    assert.equal(isSkipped(r), false);
    assertAction(actionFor(r), 'research', 'Run Research',
      'the retired design-ai:go label changed what the card offers');
  });

  test('only the four reserved labels are recognised', () => {
    const recognised = ['AI-research done', 'AI-design done', 'no-research', 'no-design'];
    for (const name of recognised) {
      assert.notEqual(stageOf(card([name])), 'backlog',
        `the reserved label "${name}" was ignored`);
    }
    assert.equal(hasLabel(card(['no-design']), 'no-design'), true);
  });

  test('absence means not yet, and nothing else', () => {
    const r = card([]);
    assert.equal(stageState(r, 'research'), null, 'absence was read as something other than "not yet"');
    assert.equal(stageState(r, 'design'), null);
  });
});

// ──────────────────────────────────────────────────────────────────────
// §14.1 — configuration and secrets
// ──────────────────────────────────────────────────────────────────────

describe('§14.1 — a missing variable is named, not discovered mid-run', () => {
  const base = (extra = {}) => ({
    DB: d1(healthyDb()), LINEAR_API_KEY: 'k', AGENT_SECRET: 's',
    ACCESS_MODE: 'open', ...extra,
  });

  const check = (report, name) => report.checks.find((c) => c.name === name);

  test('a healthy Hub reports ok', async () => {
    const report = await diagnose(base());
    assert.equal(report.ok, true, `failing: ${report.failing.join(', ')}`);
  });

  test('AGENT_SECRET absent is a failure that names the variable', async () => {
    const report = await diagnose(base({ AGENT_SECRET: '' }));
    assert.equal(report.ok, false);
    assert.equal(check(report, 'agent_secret').state, 'fail');
    assert.match(check(report, 'agent_secret').detail, /AGENT_SECRET/);
  });

  test('a whitespace-only AGENT_SECRET is treated as absent', async () => {
    const report = await diagnose(base({ AGENT_SECRET: '   ' }));
    assert.equal(check(report, 'agent_secret').state, 'fail');
  });

  test('agent writes are actually rejected without AGENT_SECRET', async () => {
    // The check above says the variable is missing. This says what that costs,
    // so the two cannot drift apart.
    const db = freshDb();
    const res = await call({ DB: d1(db), LINEAR_API_KEY: 'k' }, 'POST',
      '/api/agent/session',
      { session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'active' },
      { 'X-Agent-Secret': 'anything' });
    assert.equal(res.status, 403);
  });

  test('LINEAR_API_KEY absent is a failure that names the variable', async () => {
    const report = await diagnose(base({ LINEAR_API_KEY: '' }));
    assert.equal(report.ok, false);
    assert.match(check(report, 'linear').detail, /LINEAR_API_KEY/);
  });

  test('no D1 binding is a failure', async () => {
    const report = await diagnose({ ...base(), DB: undefined });
    assert.equal(report.ok, false);
    assert.equal(check(report, 'd1').state, 'fail');
  });

  test('a D1 binding that cannot be queried is a failure, not a pass', async () => {
    const broken = { prepare: () => ({ bind: () => broken, first: async () => { throw new Error('no such table'); } }) };
    const report = await diagnose({ ...base(), DB: broken });
    assert.equal(check(report, 'd1').state, 'fail');
    assert.match(check(report, 'd1').detail, /no such table/);
  });
});

describe('§14.1 — Access is off deliberately, or it is a fault', () => {
  // "With the team unset, every route currently runs open. That must be a
  // deliberate, asserted state, not a silent default."
  test('configured Access reports as enforced', () => {
    const st = accessState({ ACCESS_AUD: 'aud', ACCESS_TEAM: 'psiphon' });
    assert.equal(st.mode, 'enforced');
  });

  test('unconfigured and unasserted is open-default', () => {
    assert.equal(accessState({}).mode, 'open-default');
    assert.equal(accessState({ ACCESS_AUD: 'aud' }).mode, 'open-default',
      'half-configured Access read as something other than open');
  });

  test('open-default fails the diagnostic and names both variables', async () => {
    const report = await diagnose({ DB: d1(healthyDb()), LINEAR_API_KEY: 'k', AGENT_SECRET: 's' });
    const access = report.checks.find((c) => c.name === 'access');
    assert.equal(access.state, 'fail', 'a Hub running wide open reported itself healthy');
    assert.match(access.detail, /ACCESS_AUD/);
    assert.match(access.detail, /ACCESS_TEAM/);
    assert.equal(report.ok, false);
  });

  test('ACCESS_MODE=open passes, because somebody said so', async () => {
    const report = await diagnose({
      DB: d1(healthyDb()), LINEAR_API_KEY: 'k', AGENT_SECRET: 's', ACCESS_MODE: 'open',
    });
    const access = report.checks.find((c) => c.name === 'access');
    assert.equal(access.state, 'pass');
    assert.equal(access.mode, 'open-asserted');
  });

  test('asserting it open does not change who gets in', async () => {
    // The assertion is a statement about intent, not a switch. If it ever
    // starts changing behaviour, this is what catches it.
    const db = freshDb();
    const open = await call({ DB: d1(db), LINEAR_API_KEY: 'k' }, 'GET', '/api/agent/sessions');
    const asserted = await call(
      { DB: d1(db), LINEAR_API_KEY: 'k', ACCESS_MODE: 'open' }, 'GET', '/api/agent/sessions');
    assert.equal(open.status, asserted.status);
  });
});

describe('§14.1 — a credential you do not have is unknown, never "none"', () => {
  // "Reporting absence when you cannot look is worse than reporting nothing."
  // The evidence layer does not exist yet; this is the rule waiting for it.
  const base = { DB: d1(healthyDb()), LINEAR_API_KEY: 'k', AGENT_SECRET: 's', ACCESS_MODE: 'open' };

  test('no Figma credential is unknown, and does not fail the Hub', async () => {
    const report = await diagnose(base);
    const figma = report.checks.find((c) => c.name === 'evidence_figma');
    assert.equal(figma.state, 'unknown', 'a missing evidence credential reported as a failure');
    assert.equal(report.ok, true, 'an unconfigured evidence source brought the whole Hub down');
  });

  test('no GitHub credential is unknown for the same reason', async () => {
    const report = await diagnose(base);
    assert.equal(report.checks.find((c) => c.name === 'evidence_github').state, 'unknown');
  });

  test('a configured evidence source passes', async () => {
    const report = await diagnose({ ...base, FIGMA_TOKEN: 'figd_x' });
    assert.equal(report.checks.find((c) => c.name === 'evidence_figma').state, 'pass');
  });

  test('no runner token degrades the dispatch rather than failing it', async () => {
    const report = await diagnose(base);
    const runner = report.checks.find((c) => c.name === 'runner_dispatch');
    assert.equal(runner.state, 'unknown');
    assert.match(runner.detail, /queued but nothing starts them/);
    assert.equal(report.ok, true, 'a Hub that queues correctly reported itself broken');
  });
});

// ──────────────────────────────────────────────────────────────────────
// §14.2 — connectivity
// ──────────────────────────────────────────────────────────────────────

describe('§14.2 — a dead machine becomes visible on the board', () => {
  // "This is the connectivity test that matters — it is how a dead local
  // machine becomes visible on the board." The Hub cannot reach the runner, so
  // the heartbeat is the only direction the question can be asked from.
  const NOW = Date.parse('2026-09-16T21:00:00Z');
  const stamp = (minsAgo) =>
    new Date(NOW - minsAgo * 60000).toISOString().replace('T', ' ').slice(0, 19);

  const envWith = (db) => ({
    DB: d1(db), LINEAR_API_KEY: 'k', AGENT_SECRET: 's', ACCESS_MODE: 'open',
  });

  const beat = (db, machine, minsAgo) =>
    db.prepare(
      `INSERT INTO agent_heartbeats (machine, capabilities, last_seen, first_seen)
       VALUES (?, '[]', ?, ?)`
    ).run(machine, stamp(minsAgo), stamp(minsAgo));

  test('no machine has ever checked in is a failure', async () => {
    const report = await diagnose(envWith(freshDb()), { now: NOW });
    const hb = report.checks.find((c) => c.name === 'runner_heartbeat');
    assert.equal(hb.state, 'fail');
    assert.match(hb.detail, /has ever checked in/);
  });

  test('a recent check-in passes and says how long ago', async () => {
    const db = freshDb();
    beat(db, 'dave-bell-jr', 4);
    const report = await diagnose(envWith(db), { now: NOW });
    const hb = report.checks.find((c) => c.name === 'runner_heartbeat');
    assert.equal(hb.state, 'pass');
    assert.equal(hb.machine, 'dave-bell-jr');
    assert.equal(hb.mins_ago, 4);
  });

  test('a machine past the stale window is presumed offline', async () => {
    const db = freshDb();
    beat(db, 'dave-bell-jr', HEARTBEAT_STALE_MIN + 60);
    const report = await diagnose(envWith(db), { now: NOW });
    const hb = report.checks.find((c) => c.name === 'runner_heartbeat');
    assert.equal(hb.state, 'fail');
    assert.match(hb.detail, /presumed offline/);
  });

  test('the most recent machine is the one reported', async () => {
    const db = freshDb();
    beat(db, 'old-laptop', 5000);
    beat(db, 'dave-bell-jr', 3);
    const report = await diagnose(envWith(db), { now: NOW });
    assert.equal(report.checks.find((c) => c.name === 'runner_heartbeat').machine, 'dave-bell-jr');
  });

  test('a heartbeat posted through the API is what the diagnostic reads', async () => {
    // End to end, so the check cannot pass against a row shape nothing writes.
    const db = freshDb();
    const e = envWith(db);
    await call(e, 'POST', '/api/agent/heartbeat',
      { machine: 'dave-bell-jr', capabilities: ['research', 'design'] },
      { 'X-Agent-Secret': 's' });

    const report = await diagnose(e);
    const hb = report.checks.find((c) => c.name === 'runner_heartbeat');
    assert.equal(hb.state, 'pass', hb.detail);
    assert.equal(hb.machine, 'dave-bell-jr');
  });
});

describe('§14.2 — the diagnostic is reachable and does not lie by omission', () => {
  test('GET /api/diagnostics answers 200 even when things are broken', async () => {
    const res = await call({ DB: undefined }, 'GET', '/api/diagnostics');
    assert.equal(res.status, 200,
      'a broken Hub answered its own diagnostic with an error, which is indistinguishable ' +
      'from the Worker being down');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.failing.includes('d1'));
  });

  test('every check reports a state and a reason', async () => {
    const res = await call(
      { DB: d1(freshDb()), LINEAR_API_KEY: 'k', AGENT_SECRET: 's', ACCESS_MODE: 'open' },
      'GET', '/api/diagnostics');
    const body = await res.json();
    for (const c of body.checks) {
      assert.ok(['pass', 'fail', 'unknown'].includes(c.state), `${c.name} has state "${c.state}"`);
      assert.ok(c.detail && c.detail.length > 0, `${c.name} reported no reason`);
    }
  });

  test('it does not touch the network unless asked', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error('should not be reached'); };
    await call({ DB: d1(freshDb()), LINEAR_API_KEY: 'k', AGENT_SECRET: 's', ACCESS_MODE: 'open' },
               'GET', '/api/diagnostics');
    assert.equal(called, false, 'the default diagnostic spent a Linear call');
  });
});

// ──────────────────────────────────────────────────────────────────────
// §14.3 — Linear organisation
// ──────────────────────────────────────────────────────────────────────

describe('§14.3 — brand derives from team, for every team', () => {
  test('every mapped team derives its brand', () => {
    for (const [team, brand] of Object.entries(TEAM_BRAND)) {
      assert.equal(deriveBrand(issue({ identifier: 'RYV-84', team })), brand,
        `team "${team}" stopped deriving "${brand}"`);
    }
  });

  test('every mapped team derives its track', () => {
    for (const [team, track] of Object.entries(TEAM_TRACK)) {
      assert.equal(deriveTrack(team), track, `team "${team}" stopped deriving "${track}"`);
    }
  });

  test('the unmapped case falls through to keywords, then to null', () => {
    // 'Websites' covers every brand, so it has no mapping on purpose and its
    // issues are placed by keyword — this is what rescues them.
    const byTitle = issue({ identifier: 'WEB-248', team: 'Websites', title: 'psiphon landing page' });
    assert.equal(deriveBrand(byTitle), 'psiphon');

    const unplaceable = issue({ identifier: 'WEB-249', team: 'Websites', title: 'Tidy the footer' });
    assert.equal(deriveBrand(unplaceable), null,
      'an issue with nothing to go on was placed in a brand anyway');
  });

  test('an unmapped team has no track, and does not invent one', () => {
    assert.equal(deriveTrack('Marketing'), null);
    assert.equal(deriveTrack(undefined), null);
  });
});

describe('§14.3 — discovery is bounded to open work assigned to the owner', () => {
  test('the query asks for open states only', async () => {
    const db = freshDb();
    const queries = [];
    stubLinear([issue({ identifier: 'RYV-84' })], null, { queries });
    await readLinear(env(db));

    const discovery = queries.find((q) => /DesignReaderIssues/.test(q));
    const states = discovery.match(/type:\s*\{\s*in:\s*\[([^\]]*)\]/)[1];
    for (const closed of ['completed', 'canceled']) {
      assert.ok(!states.includes(closed),
        `discovery asked for "${closed}" — closed issues eat the first: 100 budget (§0)`);
    }
    for (const open of ['triage', 'backlog', 'unstarted', 'started']) {
      assert.ok(states.includes(open), `discovery stopped asking for "${open}"`);
    }
  });

  test('an issue assigned to somebody else never becomes a card', async () => {
    const db = freshDb();
    stubLinear([
      issue({ identifier: 'RYV-84' }),
      issue({ identifier: 'RYV-85', assignee: 'Someone Else' }),
    ]);
    await readLinear(env(db));

    const keys = db.prepare(`SELECT issue_key FROM cards ORDER BY issue_key`)
      .all().map((r) => r.issue_key);
    assert.deepEqual(keys, ['RYV-84'], "another person's issue reached the board");
  });

  test('discovery and reconciliation stay two passes', async () => {
    // "Merging them lets closed issues eat the budget and starve the board of
    // real work." Two distinct operations, every read.
    const db = freshDb();
    const queries = [];
    stubLinear([issue({ identifier: 'RYV-84' })], null, { queries });
    await readLinear(env(db));

    assert.ok(queries.some((q) => /DesignReaderIssues/.test(q)), 'discovery did not run');
    assert.ok(queries.some((q) => /Reconcile/.test(q)), 'reconciliation did not run');
  });
});
