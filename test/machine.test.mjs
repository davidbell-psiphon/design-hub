// Which machine you are at, and where queued work goes.
//
//   node --test test/machine.test.mjs
//
// The Hub cannot see which machine your browser is on. It never reaches out to
// anything — runners poll it — and a page cannot read its own hostname. So the
// machine says so, two ways, and both are here:
//
//   automatic  running design-local.bat claims the machine, because that
//              command only makes sense where you are sitting
//   by hand    the board picks one
//
// What makes it worth having at all: local runs are scheduled on at least one
// machine, so a laptop you are nowhere near polls the queue and can take Figma
// or Mobbin work that only runs where somebody has signed in.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  freshDb, env, call, readLinear, issue, stubLinear, PIECES,
} from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const board = vm.createContext({ Date, Math, isNaN, String });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), board);
const { agentList, workingFrom, queueDestination, heartbeatStatus,
        machineToAssert, machineToCheckIn, agentLine } = board;

const SECRET = { 'X-Agent-Secret': 's' };

const beat = (e, machine, extra = {}) =>
  call(e, 'POST', '/api/agent/heartbeat',
       { machine, capabilities: ['research', 'design'], ...extra }, SECRET);

const workingFromApi = (e, machine) =>
  call(e, 'PUT', '/api/agent/working-from', { machine });

const queue = (e, machine) =>
  call(e, 'GET', '/api/agent/queue' +
       (machine === undefined ? '' : `?machine=${encodeURIComponent(machine)}`),
       undefined, SECRET);

const machines = (e) => call(e, 'GET', '/api/agent/heartbeat', undefined, SECRET);

// A board with one card, queued for research.
async function queued(stage = 'research') {
  const db = freshDb();
  const e = env(db);
  stubLinear([issue({ identifier: 'RYV-84' })]);
  await readLinear(e);
  await call(e, 'POST', '/api/agent/session/RYV-84/trigger', { stage });
  return { db, e };
}

// ──────────────────────────────────────────────────────────────────────
// Checking in
// ──────────────────────────────────────────────────────────────────────

describe('a runner says where it is', () => {
  test('kind is recorded', async () => {
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local' });
    await beat(e, 'gh-runner-7', { kind: 'ci' });

    const rows = await (await machines(e)).json();
    const by = Object.fromEntries(rows.map((r) => [r.machine, r]));
    assert.equal(by['DaveBellJrII'].kind, 'local');
    assert.equal(by['gh-runner-7'].kind, 'ci');
  });

  test('a runner that does not say is stored as unknown, not guessed at', async () => {
    // It used to be stored as 'local', which was a guess written as a fact —
    // and the guess then overwrote anything already known. What is stored is
    // what was said.
    const { e } = await queued();
    await beat(e, 'old-runner');
    const rows = await (await machines(e)).json();
    assert.equal(rows[0].kind, null);
  });

  test('but unknown is READ as local, which is the safe reading of silence', async () => {
    // An old runner must not vanish from the board, and must not escape a
    // selection either: it could be the laptop you are not sitting at.
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });
    await beat(e, 'old-runner');
    assert.deepEqual(await (await queue(e, 'old-runner')).json(), [],
      'a machine that never said what it is escaped the selection');
  });
});

describe('running design-local claims the machine', () => {
  test('a claim points the queue at that machine', async () => {
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });

    const rows = await (await machines(e)).json();
    assert.ok(rows.find((r) => r.machine === 'DaveBellJrII').selected_at,
              'the claim did not select the machine');
  });

  test('a second claim moves the selection rather than adding one', async () => {
    const { e } = await queued();
    await beat(e, 'dave-bell-jr', { kind: 'local', claim: true });
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });

    const rows = await (await machines(e)).json();
    const selected = rows.filter((r) => r.selected_at).map((r) => r.machine);
    assert.deepEqual(selected, ['DaveBellJrII'],
                     'two machines were selected at once, which nothing can read');
  });

  test('a scheduled run does not claim', async () => {
    // runner.bat on a Task Scheduler entry fires on a laptop you may be
    // nowhere near. A machine checking in is not you being in front of it,
    // and that distinction is the entire point of this feature.
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });
    await beat(e, 'dave-bell-jr', { kind: 'local' });   // no claim

    const rows = await (await machines(e)).json();
    assert.deepEqual(rows.filter((r) => r.selected_at).map((r) => r.machine),
                     ['DaveBellJrII'],
                     'a scheduled check-in stole the selection');
  });

  test('CI can never claim', async () => {
    const { e } = await queued();
    const res = await beat(e, 'gh-runner-7', { kind: 'ci', claim: true });
    assert.equal((await res.json()).claimed, false);

    const rows = await (await machines(e)).json();
    assert.deepEqual(rows.filter((r) => r.selected_at), [],
                     'a GitHub runner was recorded as somewhere Dave is sitting');
  });
});

describe('choosing a machine by hand', () => {
  test('it selects, and clears the others', async () => {
    const { e } = await queued();
    await beat(e, 'dave-bell-jr', { kind: 'local', claim: true });
    await beat(e, 'DaveBellJrII', { kind: 'local' });

    const res = await workingFromApi(e, 'DaveBellJrII');
    assert.equal(res.status, 200);

    const rows = await (await machines(e)).json();
    assert.deepEqual(rows.filter((r) => r.selected_at).map((r) => r.machine),
                     ['DaveBellJrII']);
  });

  test('null clears it, back to whichever runner asks first', async () => {
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });

    await workingFromApi(e, null);
    const rows = await (await machines(e)).json();
    assert.deepEqual(rows.filter((r) => r.selected_at), []);
  });

  test('a machine that never checked in is refused', async () => {
    // Selecting one would route every queued run to nothing at all, silently.
    const { e } = await queued();
    const res = await workingFromApi(e, 'some-laptop');
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /ever checked in/);
  });

  test('a CI runner is refused', async () => {
    const { e } = await queued();
    await beat(e, 'gh-runner-7', { kind: 'ci' });
    const res = await workingFromApi(e, 'gh-runner-7');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not a machine you sit at/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Where the work goes
// ──────────────────────────────────────────────────────────────────────

describe('the queue answers the machine that asks', () => {
  test('asking with no name gets everything, exactly as before', async () => {
    // The runner is fed entirely by this route. A runner that has not been
    // updated must keep working, or updating the Hub stops every run.
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });

    const out = await (await queue(e)).json();
    assert.equal(out.length, 1, 'an un-named caller was filtered');
  });

  test('the chosen machine gets the work', async () => {
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });

    const out = await (await queue(e, 'DaveBellJrII')).json();
    assert.equal(out.length, 1);
    assert.equal(out[0].linear_id, 'RYV-84');
  });

  test('another machine you sit at gets nothing', async () => {
    // The whole feature, in one assertion: the work laptop polling on a
    // schedule does not take work while you are at the other machine.
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });
    await beat(e, 'dave-bell-jr', { kind: 'local' });

    const out = await (await queue(e, 'dave-bell-jr')).json();
    assert.deepEqual(out, [], 'a machine Dave is not at took the queued work');
  });

  test('with nothing chosen, every machine still gets it', async () => {
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local' });
    await beat(e, 'dave-bell-jr', { kind: 'local' });

    assert.equal((await (await queue(e, 'dave-bell-jr')).json()).length, 1);
    assert.equal((await (await queue(e, 'DaveBellJrII')).json()).length, 1);
  });

  test('CI is never filtered by the selection', async () => {
    // Choosing a machine must not starve GitHub Actions of research. This is
    // the assertion that keeps that true.
    const { e } = await queued('research');
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });
    await beat(e, 'gh-runner-7', { kind: 'ci', capabilities: ['research'] });

    const out = await (await queue(e, 'gh-runner-7')).json();
    assert.equal(out.length, 1, 'choosing a machine starved the cloud runner');
  });
});

describe('a runner is only offered a stage it said it can run', () => {
  test('CI declaring research only is not handed design', async () => {
    const { e } = await queued('design');
    await beat(e, 'gh-runner-7', { kind: 'ci', capabilities: ['research'] });

    const out = await (await queue(e, 'gh-runner-7')).json();
    assert.deepEqual(out, [],
      'the cloud runner was handed design work it cannot do and would fail');
  });

  test('and is handed research', async () => {
    const { e } = await queued('research');
    await beat(e, 'gh-runner-7', { kind: 'ci', capabilities: ['research'] });
    assert.equal((await (await queue(e, 'gh-runner-7')).json()).length, 1);
  });

  test('a machine declaring nothing is not filtered to nothing', async () => {
    // No capabilities is a runner that has not said, not one that can do
    // nothing. Stranding the queue on a missing field would be worse than
    // handing over work that turns out not to run.
    const { e } = await queued('design');
    await beat(e, 'DaveBellJrII', { kind: 'local', capabilities: [] });
    assert.equal((await (await queue(e, 'DaveBellJrII')).json()).length, 1);
  });

  test('the capability filter is by name, and the Hub knows no more than that', async () => {
    const { e } = await queued('design');
    await beat(e, 'DaveBellJrII', { kind: 'local', capabilities: ['research', 'figma'] });
    assert.deepEqual(await (await queue(e, 'DaveBellJrII')).json(), [],
      'design was offered to a runner that never said it could run design');
  });
});

// ──────────────────────────────────────────────────────────────────────
// What the board shows
// ──────────────────────────────────────────────────────────────────────

describe('the board speaks for the machine you chose, not the freshest', () => {
  const NOW = Date.parse('2026-09-18T21:00:00Z');
  const ago = (mins) =>
    new Date(NOW - mins * 60000).toISOString().replace('T', ' ').slice(0, 19);

  const rows = [
    { machine: 'dave-bell-jr', kind: 'local', capabilities: ['research'],
      last_seen: ago(2), selected_at: null },
    { machine: 'DaveBellJrII', kind: 'local', capabilities: ['research', 'design', 'figma'],
      last_seen: ago(5), selected_at: ago(35) },
    { machine: 'gh-runner-7', kind: 'ci', capabilities: ['research'],
      last_seen: ago(1), selected_at: null },
  ];

  test('the chosen machine wins over a more recent check-in', () => {
    // A laptop on a schedule checks in from wherever it is, so "most recent"
    // is wrong exactly when it matters.
    const s = heartbeatStatus(rows, NOW);
    assert.equal(s.row.machine, 'DaveBellJrII');
    assert.equal(s.chosen, true);
  });

  test('with nothing chosen it falls back to the freshest, as before', () => {
    const none = rows.map((r) => ({ ...r, selected_at: null }));
    const s = heartbeatStatus(none, NOW);
    assert.equal(s.row.machine, 'dave-bell-jr');
    assert.equal(s.chosen, false);
  });

  test('CI is never offered as somewhere you are sitting', () => {
    assert.deepEqual(agentList(rows, NOW).map((a) => a.machine),
                     ['DaveBellJrII', 'dave-bell-jr']);
    assert.equal(workingFrom(rows).machine, 'DaveBellJrII');
  });

  test('the chosen machine is listed first, then by how recent', () => {
    const list = agentList(rows, NOW);
    assert.equal(list[0].selected, true);
    assert.equal(list[1].selected, false);
  });

  test('a board with only CI runners has no machine at all', () => {
    const s = heartbeatStatus(rows.filter((r) => r.kind === 'ci'), NOW);
    assert.equal(s.state, 'never');
  });

  test('it says where work will actually go', () => {
    assert.equal(queueDestination(rows, NOW).kind, 'ok');
    assert.match(queueDestination(rows, NOW).text, /work goes to DaveBellJrII/);
  });

  test('and warns when the chosen machine has stopped answering', () => {
    // The state that would otherwise look exactly like nothing happening.
    const cold = rows.map((r) => r.machine === 'DaveBellJrII'
      ? { ...r, last_seen: ago(60 * 30) } : r);
    const d = queueDestination(cold, NOW);
    assert.equal(d.kind, 'stale');
    assert.match(d.text, /has not checked in/);
  });

  test('and says so plainly when nothing is chosen', () => {
    const none = rows.map((r) => ({ ...r, selected_at: null }));
    assert.equal(queueDestination(none, NOW).kind, 'any');
    assert.match(queueDestination(none, NOW).text, /whichever runner asks first/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Deploying this Worker before piece12 is applied
// ──────────────────────────────────────────────────────────────────────

describe('a check-in never overwrites what is already known about a machine', () => {
  // This was live, and it starved GitHub Actions. `kind` defaulted a missing
  // value to 'local', so every heartbeat from a runner that predates the field
  // overwrote whatever was there — including a correction made by hand. A CI
  // runner marked 'ci' flipped back to 'local' on its next check-in and was
  // immediately caught by the selection.
  test('a silent runner does not undo a known kind', async () => {
    const { e, db } = await queued();
    await beat(e, 'gh-runner-7', { kind: 'ci' });
    await beat(e, 'gh-runner-7');                 // old runner: says nothing

    const rows = await (await machines(e)).json();
    assert.equal(rows.find((r) => r.machine === 'gh-runner-7').kind, 'ci',
      'a silent check-in overwrote the kind, which is how CI got starved');
  });

  test('and a silent runner that was never known stays unknown', async () => {
    const { e } = await queued();
    await beat(e, 'mystery-box');
    const rows = await (await machines(e)).json();
    assert.equal(rows.find((r) => r.machine === 'mystery-box').kind, null,
      'the Hub stored a guess instead of what it was told');
  });

  test('a runner that changes its mind is believed', async () => {
    const { e } = await queued();
    await beat(e, 'shape-shifter', { kind: 'local' });
    await beat(e, 'shape-shifter', { kind: 'ci' });
    const rows = await (await machines(e)).json();
    assert.equal(rows.find((r) => r.machine === 'shape-shifter').kind, 'ci');
  });

  test('a known CI runner keeps its exemption across a silent check-in', async () => {
    // The consequence, end to end: this is the assertion that says research
    // still runs in the cloud while a machine is selected.
    const { e } = await queued('research');
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });
    await beat(e, 'gh-runner-7', { kind: 'ci', capabilities: ['research'] });
    await beat(e, 'gh-runner-7', { capabilities: ['research'] });   // silent

    const out = await (await queue(e, 'gh-runner-7')).json();
    assert.equal(out.length, 1, 'the cloud runner was starved after a silent check-in');
  });

  test('an unknown machine is still treated as local by the selection', async () => {
    // Unchanged, and deliberate: a runner that has never said what it is could
    // be the laptop you are not at, and it must not keep taking work you have
    // pointed elsewhere.
    const { e } = await queued();
    await beat(e, 'DaveBellJrII', { kind: 'local', claim: true });
    await beat(e, 'unknown-laptop');
    assert.deepEqual(await (await queue(e, 'unknown-laptop')).json(), []);
  });
});

describe('a browser says which machine it is on', () => {
  // The Hub cannot see it: it never reaches out to anything, and a page cannot
  // read its own hostname. What a browser CAN do is remember, because a
  // browser only ever runs on one machine. So "connect to whatever computer
  // loads this site" is the site remembering, per browser, and saying so on
  // every load.
  const NOW = Date.parse('2026-09-19T02:00:00Z');
  const ago = (m) => new Date(NOW - m * 60000).toISOString().replace('T', ' ').slice(0, 19);

  const two = (selected) => [
    { machine: 'DaveBellJrII', kind: 'local', capabilities: ['research', 'design'],
      last_seen: ago(3), selected_at: selected === 'DaveBellJrII' ? ago(2) : null },
    { machine: 'dave-bell-jr', kind: 'local', capabilities: ['research'],
      last_seen: ago(1), selected_at: selected === 'dave-bell-jr' ? ago(2) : null },
  ];

  test('it asserts the machine it remembers', () => {
    assert.equal(machineToAssert(two('dave-bell-jr'), 'DaveBellJrII'), 'DaveBellJrII');
  });

  test('it says nothing when the Hub already agrees', () => {
    // Returning a value here is what would turn every page load into an
    // assert loop.
    assert.equal(machineToAssert(two('DaveBellJrII'), 'DaveBellJrII'), null);
  });

  test('it says nothing when this browser has not been told', () => {
    // Guessing is worse than asking once. The picker is how it gets told.
    assert.equal(machineToAssert(two(null), null), null);
    assert.equal(machineToAssert(two(null), ''), null);
  });

  test('it refuses to select a machine that has never checked in', () => {
    // Selecting one would route every queued run at nothing at all, silently —
    // the same reason the API refuses it.
    assert.equal(machineToAssert(two(null), 'a-laptop-that-never-connected'), null);
  });

  test('it asserts even when the remembered machine is the stale one', () => {
    // Stale is not wrong. You have just sat down at a machine whose runner has
    // not woken up yet, and pointing work at it is exactly right — the board
    // says separately that it has not checked in lately.
    const rows = two('dave-bell-jr');
    rows[0].last_seen = ago(60 * 5);
    assert.equal(machineToAssert(rows, 'DaveBellJrII'), 'DaveBellJrII');
  });

  test('it never asserts a CI runner', () => {
    const rows = [...two(null),
      { machine: 'gh-runner-7', kind: 'ci', capabilities: ['research'],
        last_seen: ago(1), selected_at: null }];
    assert.equal(machineToAssert(rows, 'gh-runner-7'), null,
      'a browser claimed to be running on a GitHub runner');
  });

  test('with no machines at all it says nothing', () => {
    assert.equal(machineToAssert([], 'DaveBellJrII'), null);
    assert.equal(machineToAssert(null, 'DaveBellJrII'), null);
  });
});

describe('which machine a press of "I’m at this computer" checks in', () => {
  // Choosing and being here are different questions, and this one can only be
  // answered by the browser the press happened in. The Hub never reaches out,
  // nothing on a page can start a process on your computer, and a page cannot
  // read its own hostname — so the press is the fact, and this decides which
  // machine it is about.
  const NOW = Date.parse('2026-09-19T02:00:00Z');
  const ago = (m) => new Date(NOW - m * 60000).toISOString().replace('T', ' ').slice(0, 19);
  const rows = (selected) => [
    { machine: 'DaveBellJrII', kind: 'local', capabilities: ['research', 'design'],
      last_seen: ago(3), selected_at: selected === 'DaveBellJrII' ? ago(2) : null },
    { machine: 'dave-bell-jr', kind: 'local', capabilities: ['research'],
      last_seen: ago(1), selected_at: selected === 'dave-bell-jr' ? ago(2) : null },
  ];

  test('the machine this browser was told it is on', () => {
    assert.equal(machineToCheckIn(rows(null), 'DaveBellJrII'), 'DaveBellJrII');
  });

  test('NOT the chosen one, when they are different', () => {
    // Choosing can point at a laptop in another room and be entirely right.
    // Checking that laptop in from a browser here would say somebody is
    // sitting at it, which is the one thing the heartbeat must never invent.
    assert.equal(machineToCheckIn(rows('dave-bell-jr'), 'DaveBellJrII'), 'DaveBellJrII');
  });

  test('one machine needs no telling', () => {
    // Not a guess: with a single machine there is nothing else the press could
    // be about, and a trip through the picker first would be ceremony.
    assert.equal(machineToCheckIn([rows(null)[0]], null), 'DaveBellJrII');
  });

  test('two machines and nothing remembered is a question, not a guess', () => {
    assert.equal(machineToCheckIn(rows(null), null), null);
  });

  test('a remembered machine that has never checked in is not invented', () => {
    // There is no row to refresh, and creating one would put a machine on the
    // board that the Hub has never heard from.
    assert.equal(machineToCheckIn(rows(null), 'a-laptop-elsewhere'), null);
  });

  test('a CI runner is never somewhere you are sitting', () => {
    const ci = [{ machine: 'gh-runner-7', kind: 'ci', capabilities: ['research'],
                  last_seen: ago(1), selected_at: null }];
    assert.equal(machineToCheckIn(ci, 'gh-runner-7'), null);
    assert.equal(machineToCheckIn(ci, null), null,
      'a GitHub runner was offered as the one machine you must be at');
  });

  test('with nothing at all there is nothing to check in', () => {
    assert.equal(machineToCheckIn([], 'DaveBellJrII'), null);
    assert.equal(machineToCheckIn(null, null), null);
  });
});

describe('chosen and checked-in are different facts, and the board says which', () => {
  // These two get confused constantly, including by the person reading the
  // board. A chosen machine that has gone quiet is NOT disconnected: the work
  // is reserved for it and will wait until something on it wakes up. Saying
  // "may not be running right now" for that case answers a question nobody
  // asked and reads as a fault.
  const NOW = Date.parse('2026-09-19T04:00:00Z');
  const ago = (m) => new Date(NOW - m * 60000).toISOString().replace('T', ' ').slice(0, 19);
  const m = (o) => [{ machine: 'DaveBellJrII', kind: 'local',
    capabilities: ['research', 'design', 'figma', 'mobbin'],
    last_seen: ago(o.seen), selected_at: o.sel === undefined ? null : ago(o.sel) }];

  test('chosen and fresh says it is ready', () => {
    const l = agentLine(m({ seen: 3, sel: 3 }), NOW);
    assert.equal(l.chosen, true);
    assert.match(l.text, /work goes here, ready now/);
  });

  test('chosen and quiet still says work goes here', () => {
    // The exact state that read as a fault: selected, nothing checked in for
    // half an hour because nothing on that machine runs on a schedule.
    const l = agentLine(m({ seen: 33, sel: 33 }), NOW);
    assert.match(l.text, /work goes here/);
    assert.ok(!/may not be running/.test(l.text),
      'a chosen machine was reported as possibly not running, which is the wrong question');
    assert.match(l.text, /33m/, 'it stopped saying how long it had been');
  });

  test('chosen and long gone says what to do about it', () => {
    const l = agentLine(m({ seen: 60 * 24 * 20, sel: 60 }), NOW);
    assert.match(l.text, /20d/);
    assert.match(l.text, /at this computer|choose another machine/);
  });

  test('not chosen keeps the old wording, because the question is different', () => {
    // With nothing selected, work goes to whoever asks first — so whether
    // anything is listening really is the only thing worth saying.
    const l = agentLine(m({ seen: 3 }), NOW);
    assert.equal(l.chosen, false);
    assert.match(l.text, /connected — checked in 3m ago/);

    const stale = agentLine(m({ seen: 33 }), NOW);
    assert.match(stale.text, /may not be running right now/);
  });

  test('no machines at all is its own state', () => {
    assert.equal(agentLine([], NOW).state, 'never');
    assert.match(agentLine([], NOW).text, /no machine has ever connected/);
  });

  test('freshness is still reported even when the headline is reassuring', () => {
    // The dot keeps the real state, so a machine that has genuinely stopped is
    // still visible rather than hidden behind "work goes here".
    assert.equal(agentLine(m({ seen: 33, sel: 33 }), NOW).state, 'stale');
    assert.equal(agentLine(m({ seen: 3, sel: 3 }), NOW).state, 'fresh');
    assert.equal(agentLine(m({ seen: 60 * 24 * 20, sel: 60 }), NOW).state, 'gone');
  });
});

describe('the Worker survives a database without piece12', () => {
  // DEPLOY.md says the order does not matter. This is what makes that true,
  // rather than a sentence somebody has to remember — and it was NOT true
  // when it was first written: every heartbeat route answered 500, which
  // would have taken the runner down with it.
  //
  // Same shape as readerTeams: a configuration question is not worth a 500 on
  // the route the runner depends on for all of its work.
  const unmigrated = () => env(freshDb(PIECES.filter((p) => p !== 'piece12-schema.sql')));

  test('a runner can still check in', async () => {
    const e = unmigrated();
    const res = await call(e, 'POST', '/api/agent/heartbeat',
      { machine: 'DaveBellJrII', capabilities: ['research'], kind: 'local', claim: true },
      SECRET);
    assert.equal(res.status, 200, 'the heartbeat broke — the board loses every machine');
  });

  test('the board can still read the machines', async () => {
    const e = unmigrated();
    await call(e, 'POST', '/api/agent/heartbeat',
      { machine: 'DaveBellJrII', capabilities: ['research'] }, SECRET);
    const res = await call(e, 'GET', '/api/agent/heartbeat', undefined, SECRET);
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.equal(rows[0].machine, 'DaveBellJrII');
    // No columns, so nothing is selected — which is the behaviour that was
    // there before the feature, and the right answer.
    assert.ok(!rows[0].selected_at);
  });

  test('the runner can still read the queue, named or not', async () => {
    const db = freshDb(PIECES.filter((p) => p !== 'piece12-schema.sql'));
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await readLinear(e);
    await call(e, 'POST', '/api/agent/session/RYV-84/trigger', { stage: 'research' });
    await call(e, 'POST', '/api/agent/heartbeat',
      { machine: 'DaveBellJrII', capabilities: ['research'] }, SECRET);

    assert.equal((await (await call(e, 'GET', '/api/agent/queue?machine=DaveBellJrII',
      undefined, SECRET)).json()).length, 1, 'the runner was starved of its own work');
    assert.equal((await (await call(e, 'GET', '/api/agent/queue',
      undefined, SECRET)).json()).length, 1);
  });

  test('choosing a machine says what is missing rather than failing', async () => {
    // This one genuinely cannot work without the columns. What it must not do
    // is answer 500, which tells nobody anything.
    const e = unmigrated();
    await call(e, 'POST', '/api/agent/heartbeat',
      { machine: 'DaveBellJrII', capabilities: ['research'] }, SECRET);
    const res = await call(e, 'PUT', '/api/agent/working-from', { machine: 'DaveBellJrII' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /piece12/);
  });

  test('and clearing it succeeds, because there is nothing to clear', async () => {
    const res = await call(unmigrated(), 'PUT', '/api/agent/working-from', { machine: null });
    assert.equal(res.status, 200);
  });
});
