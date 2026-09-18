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

// The harness these suites share — node:sqlite behind D1's binding surface,
// the schema pieces in the order the live database got them, and a stubbed
// Linear. It lives in helpers.mjs so that adding a pieceN-schema.sql is one
// edit rather than one per suite.
import {  PIECES, applyPieces, freshDb, env, call, agentPost, readLinear,
  issue, stubLinear, rows, wire, session, sessionsOf,
} from './helpers.mjs';

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

    assert.equal(rows(db).length, 1, 'the agent post added a second row');
    const r = only(db);
    // §2: the Linear issue key is the only identity, and it is the row's
    // name. It used to be 'linear/RYV-84' with the agent's own id remembered
    // alongside it, which was the second identity §2 removes.
    assert.equal(r.id, 'RYV-84');
    assert.ok(onlySession(db).agent_posted_at,
              'nothing recorded that an agent had written here');
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

    assert.equal(rows(db).length, 1);
    const r = only(db);
    assert.equal(r.phase, 'research');
    assert.equal(r.status, 'waiting');
    assert.equal(r.prompt, AGENT_BODY.prompt);
    assert.equal(r.detail, AGENT_BODY.detail);
    assert.equal(r.figma_url, 'https://figma.com/f/1');
  });

  test('a manual brand reassignment survives the agent post', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84', team: 'Websites' })]);
    await readLinear(e);
    await call(e, 'PATCH', '/api/agent/session/linear%2FRYV-84/reassign', { project: 'forge' });
    await agentPost(e, AGENT_BODY);  // posts brand 'ryve'
    assert.equal(rows(db)[0].brand, 'forge');
  });
});

describe('the agent posts first, then the reader discovers the issue', () => {
  test('the read merges onto the agent row instead of adding a card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);

    await agentPost(e, AGENT_BODY);
    assert.equal(rows(db).length, 1);
    // §2: the agent posts 'ryve/ryv-84/research' and the row is named RYV-84,
    // because that is the identity and the rest of the string is a Linear fact
    // repeated back. The brand segment is read and discarded — encoding it in
    // the key is what let the key contradict Linear.
    assert.equal(rows(db)[0].issue_key, 'RYV-84');

    await readLinear(e);
    assert.equal(rows(db).length, 1, 'the reader added a second row');
    const r = only(db);
    assert.equal(r.id, 'RYV-84');
    assert.equal(r.linear_id, 'RYV-84');
    assert.equal(r.linear_uuid, 'uuid-RYV-84');
    assert.equal(r.title, 'RYV-84 title');
    assert.equal(r.phase, 'research');
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
    // The agent polls by the id it posted and reaches the card, with no
    // column storing that id anywhere — the key is parsed out of it (§2).
    assert.equal(body.id, 'RYV-84');
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
    assert.equal(only(db).response, 'Direction B');
    assert.equal(only(db).status, 'active');
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
    assert.equal(rows(db).length, 1);
    assert.equal(only(db).requested_stage, 'research');
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

  test('qa is not a stage the Hub will queue', async () => {
    // It was, and nothing implemented it: the run failed with "the qa stage is
    // not implemented yet" and left the card holding a queue entry that only
    // stage-done ever clears, so the board read it as working on QA for as
    // long as it sat there. A stage the Hub queues has to be one something
    // runs. Both ends refuse it, and neither touches the row.
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);

    const trigger = await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/trigger', { stage: 'qa' });
    assert.equal(trigger.status, 400);
    assert.match((await trigger.json()).error, /research, design/);
    assert.equal(only(db).requested_stage, null, 'a refused stage was still queued');

    const done = await call(e, 'POST', '/api/agent/stage-done',
      { linear_id: 'RYV-84', stage: 'qa' }, { 'X-Agent-Secret': 's' });
    assert.equal(done.status, 400);
    assert.equal(String(rows(db)[0].labels).includes('QA'), false,
                 'a refused stage still wrote a label');
  });

  test('a card already queued is not queued twice', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    const id = '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/trigger';
    assert.equal((await call(e, 'POST', id, { stage: 'research' })).status, 200);
    assert.equal((await call(e, 'POST', id, { stage: 'design' })).status, 409);
    assert.equal(only(db).requested_stage, 'research');
  });

  // The runner's workflow declares max_issues with a default of '2', and
  // GitHub applies that default to a dispatch that names no inputs. The Hub
  // used to send none, believing the runner drained the queue; it does not, it
  // logs DEFERRED for everything past the second and nothing re-dispatches.
  // Four issues sat in the queue for a day because of it.
  const withDispatch = async (e, fn) => {
    const sent = [];
    const passthrough = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('api.github.com')) {
        sent.push(JSON.parse(init.body));
        return { status: 204, ok: true, text: async () => '' };
      }
      return passthrough(url, init);
    };
    try { await fn(); } finally { globalThis.fetch = passthrough; }
    return sent;
  };

  const trigger = (k) => '/api/agent/session/' + encodeURIComponent('linear/' + k) + '/trigger';

  test('the dispatch tells the runner how much is waiting', async () => {
    const db = freshDb();
    const e = env(db, { GITHUB_TOKEN: 'gh' });
    stubLinear([issue({ identifier: 'RYV-84' }),
                issue({ identifier: 'CON-116', team: 'Conduit App' })]);
    await readLinear(e);

    const sent = await withDispatch(e, async () => {
      await call(e, 'POST', trigger('RYV-84'), { stage: 'research' });
      await call(e, 'POST', trigger('CON-116'), { stage: 'research' });
    });

    assert.equal(sent.length, 2, 'the runner was not dispatched');
    // The depth includes the row just written, and the second press sees both.
    assert.equal(sent[0].inputs.max_issues, '1');
    assert.equal(sent[1].inputs.max_issues, '2', 'the second press did not count the first');
    // The workflow declares the input as `type: string`; GitHub refuses a number.
    assert.equal(typeof sent[1].inputs.max_issues, 'string');
    // And still no issue: the runner picks its work by reading the queue, and
    // naming one here would strand the others. That half was always right.
    assert.equal(sent[1].inputs.issue, undefined);
  });

  test('a dismissed row is not counted, because the runner will not be shown it', async () => {
    // The count has to use the same WHERE clause as /api/agent/queue. If the
    // two disagreed, the Hub would tell the runner to take a number of issues
    // it is not going to be given.
    const db = freshDb();
    const e = env(db, { GITHUB_TOKEN: 'gh' });
    stubLinear([issue({ identifier: 'RYV-84' }),
                issue({ identifier: 'CON-116', team: 'Conduit App' })]);
    await readLinear(e);
    await call(e, 'POST', trigger('CON-116'), { stage: 'research' });
    await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/CON-116') + '/dismiss');

    const sent = await withDispatch(e, async () => {
      await call(e, 'POST', trigger('RYV-84'), { stage: 'research' });
    });
    const queue = await (await call(e, 'GET', '/api/agent/queue')).json();
    assert.equal(sent[0].inputs.max_issues, String(queue.length));
    assert.equal(sent[0].inputs.max_issues, '1');
  });

  test('the dispatch is capped, so one press cannot become a run of fifty', async () => {
    // The runner's spend guard is per issue, so the count is what bounds a
    // run's total cost.
    const db = freshDb();
    const e = env(db, { GITHUB_TOKEN: 'gh', RUNNER_MAX_ISSUES: '1' });
    stubLinear([issue({ identifier: 'RYV-84' }),
                issue({ identifier: 'CON-116', team: 'Conduit App' })]);
    await readLinear(e);

    const sent = await withDispatch(e, async () => {
      await call(e, 'POST', trigger('RYV-84'), { stage: 'research' });
      await call(e, 'POST', trigger('CON-116'), { stage: 'research' });
    });
    assert.equal(sent[1].inputs.max_issues, '1', 'the cap was not applied');
  });

  test('marking done sets the team\'s own finished state', async () => {
    // The board could say what a card is not — no design, dismissed — and had
    // no way to say it was finished. That meant opening Linear.
    const db = freshDb();
    const e = env(db);
    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84' })], mutations);
    await readLinear(e);

    const res = await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/complete');
    assert.equal(res.status, 200);
    const out = await res.json();

    // Resolved by type, not by name: every team calls this something else.
    // 'Design Done' is at position 1, 'Archived' at 3 — earliest wins, and it
    // is second in the array, so array order cannot be what decided it.
    assert.equal(out.state, 'Design Done');
    assert.equal(out.already, false);
    assert.equal(mutations.length, 1, 'expected exactly one Linear write');
    assert.match(mutations[0], /issueUpdate/);
    assert.match(mutations[0], /stateId/);

    // And the card files itself under Completed without waiting for a read.
    assert.equal(rows(db)[0].linear_state, 'completed');
  });

  test('marking done takes the card out of the queue with it', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    const card = '/api/agent/session/' + encodeURIComponent('linear/RYV-84');
    await call(e, 'POST', card + '/trigger', { stage: 'research' });

    await call(e, 'POST', card + '/complete');
    // A finished issue is not work to hand the runner, and an entry left
    // behind would sit on a card in the Completed drawer reading as Working.
    assert.equal(only(db).requested_stage, null);
    assert.equal(only(db).requested_at, null);
  });

  test('an issue already finished is said so, and written to twice never', async () => {
    const db = freshDb();
    const e = env(db);
    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84', state: 'completed' })], mutations);
    // Discovery does not return closed issues, so seed the row from an open
    // one and let the stub report the closed state back.
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    stubLinear([issue({ identifier: 'RYV-84', state: 'completed' })], mutations);

    const res = await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/complete');
    const out = await res.json();
    assert.equal(res.status, 200);
    assert.equal(out.already, true);
    assert.equal(mutations.length, 0, 'wrote to Linear for an issue already done');
  });

  test('a team with no finished state is refused, and the card does not move', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })], null, {
      states: [{ id: 'st-1', name: 'Backlog', type: 'backlog', position: 0 }],
    });
    await readLinear(e);
    const before = rows(db)[0].linear_state;

    const res = await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/complete');
    assert.equal(res.status, 502);
    // Linear first, local second — so a refusal leaves the board as it was
    // rather than filing a card under Completed that Linear disagrees with.
    assert.equal(rows(db)[0].linear_state, before);
  });

  test('marking done an id nothing knows is a 404', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([]);
    assert.equal((await call(e, 'POST', '/api/agent/session/nope/complete')).status, 404);
  });

  test('a whole team is dismissed in one call', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'MAR-1', team: 'Marketing' }),
                issue({ identifier: 'MAR-2', team: 'Marketing' }),
                issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/MAR-1') + '/trigger',
      { stage: 'research' });

    const res = await call(e, 'POST', '/api/agent/sessions/setaside',
      { ids: ['linear/MAR-1', 'linear/MAR-2', 'linear/NOPE'] });
    assert.equal(res.status, 200);
    const out = await res.json();
    // Three asked for, two that exist — an id it does not know is skipped
    // rather than failing the call, so one stale id cannot strand the rest.
    assert.equal(out.set_aside, 2);
    assert.equal(out.asked, 3);

    const byId = Object.fromEntries(rows(db).map(r => [r.issue_key, r]));
    assert.ok(byId['MAR-1'].set_aside_at, 'MAR-1 was not set aside');
    assert.ok(byId['MAR-2'].set_aside_at, 'MAR-2 was not set aside');
    assert.equal(byId['RYV-84'].set_aside_at, null, 'a card nobody asked about was set aside');
    // And a card told to stop being agent work leaves the queue with it.
    assert.equal(wire(db, 'MAR-1').requested_stage, null);
  });

  test('the queue and the dispatch count both skip a dismissed card', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' }), issue({ identifier: 'CON-1', team: 'Conduit App' })]);
    await readLinear(e);
    await call(e, 'POST',
      '/api/agent/session/' + encodeURIComponent('linear/CON-1') + '/trigger', { stage: 'research' });
    await call(e, 'POST', '/api/agent/sessions/setaside', { ids: ['linear/CON-1'] });

    const queue = await (await call(e, 'GET', '/api/agent/queue')).json();
    assert.equal(queue.length, 0, 'a dismissed card is still being handed to the runner');
  });

  test('an empty list is refused rather than quietly doing nothing', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([]);
    assert.equal((await call(e, 'POST', '/api/agent/sessions/setaside', { ids: [] })).status, 400);
    assert.equal((await call(e, 'POST', '/api/agent/sessions/setaside', {})).status, 400);
  });

  test('reset takes the request back out of the queue', async () => {
    // The state the board could not get itself out of. requested_stage is
    // cleared by stage-done and nothing else, so a run that failed — or was
    // never picked up — held its queue entry for ever and the button stayed
    // disabled behind a 409.
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    const card = '/api/agent/session/' + encodeURIComponent('linear/RYV-84');

    assert.equal((await call(e, 'POST', card + '/trigger', { stage: 'research' })).status, 200);
    assert.equal((await call(e, 'POST', card + '/trigger', { stage: 'design' })).status, 409);

    const res = await call(e, 'DELETE', card + '/trigger');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).cleared, 'research');
    assert.equal(only(db).requested_stage, null);
    assert.equal(only(db).requested_at, null);

    // And the whole point: the stage can be pressed again.
    assert.equal((await call(e, 'POST', card + '/trigger', { stage: 'research' })).status, 200);
  });

  test('reset clears an error, and the prose that explained it', async () => {
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-86' })]);
    await readLinear(e);
    await call(e, 'POST', '/api/agent/session',
      { session_id: 'ryve/ryv-86/research', system: 'design-ai', status: 'error',
        prompt: 'Research blocked — no BCC documents for ryve' },
      { 'X-Agent-Secret': 's' });
    assert.equal(only(db).status, 'error');

    const res = await call(e, 'DELETE',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-86') + '/trigger');
    assert.equal(res.status, 200);
    // 'waiting' is what the reader writes on every quiet row, so this is the
    // card going quiet rather than claiming anything new.
    assert.equal(only(db).status, 'waiting');
    assert.equal(only(db).prompt, null, 'the failure prose outlived the failure');
  });

  test('reset leaves everything that is not the request alone', async () => {
    const db = freshDb();
    const e = env(db);
    const mutations = [];
    stubLinear([issue({ identifier: 'RYV-84', labels: [{ name: 'AI-research done' }] })], mutations);
    await readLinear(e);
    const card = '/api/agent/session/' + encodeURIComponent('linear/RYV-84');
    await call(e, 'POST', card + '/trigger', { stage: 'design' });
    await call(e, 'DELETE', card + '/trigger');

    const row = rows(db)[0];
    assert.equal(rows(db).length, 1, 'reset dropped the row — it is not a delete');
    assert.deepEqual(JSON.parse(row.labels), ['AI-research done'], 'reset moved the stage');
    assert.equal(row.issue_key, 'RYV-84');
    assert.equal(row.linear_uuid, 'uuid-RYV-84');
    assert.equal(mutations.length, 0, 'reset wrote to Linear: ' + mutations.join(', '));
  });

  test('reset does not wipe the question a waiting card is asking', async () => {
    // prompt is cleared because an errored row's prompt *is* the error. On any
    // other status it is the gate, and must survive.
    const db = freshDb();
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await call(e, 'POST', '/api/agent/session',
      { session_id: 'ryve/ryv-84/design', system: 'design-ai', status: 'waiting',
        prompt: 'Which direction proceeds?',
        options: [{ id: 'd1', label: 'One' }, { id: 'd2', label: 'Two' }] },
      { 'X-Agent-Secret': 's' });

    await call(e, 'DELETE',
      '/api/agent/session/' + encodeURIComponent('linear/RYV-84') + '/trigger');
    assert.equal(only(db).prompt, 'Which direction proceeds?');
    assert.equal(only(db).status, 'waiting');
    assert.equal(only(db).options.length, 2);
  });

  test('reset on an id nothing knows is a 404, not a silent ok', async () => {
    const db = freshDb();
    const e = env(db);
    const res = await call(e, 'DELETE', '/api/agent/session/nope/trigger');
    assert.equal(res.status, 404);
  });

  test('the reader collects every team, in every open state', async () => {
    // It collected design teams only, and Backlog/Todo only. Both filters
    // went: the first because a brand is derived from the issue rather than
    // granted by its team, the second because an issue you had started was
    // invisible unless the board read it before you moved it.
    const db = freshDb();
    const e = env(db);
    stubLinear([
      issue({ identifier: 'RYV-84', state: 'started' }),            // In Progress
      issue({ identifier: 'CON-116', team: 'Conduit App' }),
      issue({ identifier: 'WEB-265', team: 'Websites' }),
      issue({ identifier: 'MAR-980', team: 'Marketing' }),
      issue({ identifier: 'STO-421', team: 'Sysadmin', state: 'triage' }),
      issue({ identifier: 'OLD-1', state: 'completed' }),           // closed: not discovered
    ]);
    const result = await (await readLinear(e)).json();
    const ids = rows(db).map(r => r.issue_key).sort();
    assert.deepEqual(ids, ['CON-116', 'MAR-980', 'RYV-84', 'STO-421', 'WEB-265']);
    assert.equal(result.skipped, 0);
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

    assert.equal(only(db).requested_stage, null, 'still queued after reporting done');
    assert.equal(onlySession(db, 'research').status, 'done',
                 'the session that finished was not marked done');
    // Written locally as well as in Linear: the reader only runs twice a week,
    // and without this the card sits in the wrong column until it next does.
    // The labels are the issue's, so they are on the card.
    assert.ok(JSON.parse(rows(db)[0].labels).includes('AI-research done'),
              'the done label was not recorded on the card');
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
    assert.equal(rows(db).length, 1);
    assert.equal(rows(db)[0].issue_key, 'RYV-84',
                 'a later stage was filed under its own name');
    // One card, two sessions — the grain §2 asks for. The research session is
    // still there rather than having been overwritten by design, which is what
    // the single-row shape did.
    assert.deepEqual(sessionsOf(db, 'RYV-84').map((x) => x.stage), ['design', 'research']);
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
    // No Linear key in the id, so the id itself is what it is filed under —
    // nothing is invented for it (§2 forbids a second identity, not a session
    // that has no issue). What makes it not a card is that Linear has nothing
    // behind it.
    assert.equal(rows(db)[0].issue_key, id);
    assert.equal(rows(db)[0].linear_uuid, null);

    await agentPost(e, { session_id: id, system: 'social-ai', brand: 'conduit',
                         stage: 'qa', status: 'waiting', prompt: 'Ship it?' });
    assert.equal(rows(db).length, 1, 'a second stage became a second card');
    // 'qa' is not a stage the Hub runs, and it is stored anyway: the schema
    // does not constrain stage, because the Hub stays generic and does not own
    // another agent system's vocabulary. The trigger route is where the Hub's
    // own stages are enforced.
    const qa = session(db, id, 'qa');
    assert.equal(qa.status, 'waiting');
    assert.equal(qa.system, 'social-ai');
    assert.equal(qa.prompt, 'Ship it?');
    // And the design session it posted first is still there beside it.
    assert.equal(session(db, id, 'design').status, 'active');
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
    assert.deepEqual(all.map(r => r.issue_key).sort(), ['CON-116', 'RYV-84']);
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
// The one card on the board, as a consumer sees it: the projection in
// lib/card.mjs over both tables. piece11 split the card from its sessions, and
// almost everything below is about a gate or a run — which live on the
// session — so asserting on the card row alone would be asserting on the wrong
// half. This is the shape the board and the agent both read.
const only = (db) => wire(db, rows(db)[0].issue_key);

// The stored session, for the few assertions that are about what is written
// rather than what is served.
const onlySession = (db, stage) => session(db, rows(db)[0].issue_key, stage);

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
    assert.equal(typeof onlySession(db).options, 'string', 'the column should hold JSON');

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
  // Everything applied after piece6. This block replays the database as it
  // was before piece6 ran, so none of them can be present: migration-003
  // reads the column piece6 adds, and piece11/migration-004 move the data out
  // of the table this is about entirely.
  const AFTER_006 = ['piece6-schema.sql', 'migration-003-identity.sql',
                     'piece11-schema.sql', 'migration-004-grain.sql'];

  // `agent_sessions` directly, because `cards` does not exist at this point in
  // history and the shared helpers read it. That is the point of the block.
  const allOld = (db) =>
    db.prepare(`SELECT * FROM agent_sessions ORDER BY id`).all();

  function withDuplicates() {
    const db = freshDb(PIECES.filter(p => !AFTER_006.includes(p)));
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
    assert.equal(allOld(db).length, 3);

    applyPieces(db, ['piece6-schema.sql']);

    const all = allOld(db);
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
    const hub = allOld(db).find(r => r.id === 'conduit/wallet-flow/design');
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

    const all = allOld(db);
    assert.equal(all.length, 2);
    const merged = all.find(r => r.linear_id === 'RYV-84');
    // Newest twin wins, and the older one is gone rather than left orphaned.
    assert.equal(merged.agent_session_id, 'ryve/ryv-84/qa');
    assert.equal(merged.phase, 'qa');
    assert.equal(all.some(r => r.id === AGENT_ID), false);
  });

  // There used to be a fourth test here, driving the Worker against this
  // schema to show the agent could still reach the merged card by its own id.
  // The Worker does not read `agent_sessions` any more (piece11), so that can
  // no longer be asked here — and it is the wrong place to ask it now anyway.
  // It lives in test/identity.test.mjs, "every id anything has ever sent still
  // reaches the card", against the schema that actually ships.
});
