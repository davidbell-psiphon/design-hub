// A run in progress is seen as one.
//
//   node --test test/alive.test.mjs
//
// WEB-279, 21 Sep 2026, the second time that afternoon. The design run had
// been going for nine minutes — Claude drawing frames in Figma on DaveBellJrII
// — when Stop was pressed and then Run again. Stop cleared the queue entry and
// Run wrote a new one, both moved `updated_at`, and the board's one signal for
// "the runner has spoken since the press" was gone. The card read Queued. The
// second press was accepted. Nothing was wrong with the run.
//
// The runner cannot speak while `spawnSync` has it blocked, so design-ai's
// keepalive.mjs speaks for it: the same `active` post, every two minutes. The
// Hub keeps the moment of the last post as `agent_seen_at` (piece14), and
// three things read it — the board's Working, the board's Stalled, and the
// trigger route's refusal to queue a run that is going. They are here
// together because they must agree.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  freshDb, env, call, readLinear, issue, stubLinear, agentPost, session, wire,
} from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const board = vm.createContext({ Date, Math, isNaN, String });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), board);
const { isRunning, isStalled, queueLabel, RUN_QUIET_MIN, STALL_AFTER_MIN } = board;

const KEY = 'WEB-279';
const SESSION = 'ryve/web-279/design';
const trigger = (e, method, body) =>
  call(e, method, `/api/agent/session/${KEY}/trigger`, body);

// A board with WEB-279 discovered and its design stage pressed.
async function pressed() {
  const db = freshDb();
  const e = env(db);
  stubLinear([issue({ identifier: KEY })]);
  await readLinear(e);
  const res = await trigger(e, 'POST', { stage: 'design' });
  assert.equal(res.status, 200);
  return { db, e };
}

// The runner's word, as the keepalive repeats it.
const spoke = (e, status = 'active', extra = {}) =>
  agentPost(e, { session_id: SESSION, system: 'design-ai', status, project: 'ryve', ...extra });

// Move a stamp on the design row into the past.
const ago = (db, column, minutes) =>
  db.prepare(`UPDATE stage_sessions SET ${column} = datetime('now', ?)
               WHERE issue_key = ? AND stage = 'design'`)
    .run(`-${minutes} minutes`, KEY);

const design = (db) => session(db, KEY, 'design');

// ──────────────────────────────────────────────────────────────────────
// The Hub records when the agent last spoke
// ──────────────────────────────────────────────────────────────────────

describe('the Hub records when the agent last spoke', () => {
  test('every post moves agent_seen_at; only the first sets agent_posted_at', async () => {
    const { db, e } = await pressed();
    await spoke(e);
    const first = design(db);
    assert.ok(first.agent_seen_at, 'the first post did not record when the agent spoke');
    assert.ok(first.agent_posted_at);

    ago(db, 'agent_seen_at', 10);
    ago(db, 'agent_posted_at', 10);
    const moved = design(db);
    await spoke(e);
    const second = design(db);
    assert.notEqual(second.agent_seen_at, moved.agent_seen_at, 'a second post left agent_seen_at where it was');
    assert.equal(second.agent_posted_at, moved.agent_posted_at,
      'agent_posted_at moved — it is the FIRST post, the Stop route depends on that');
  });

  test('a press and a Stop leave it alone', async () => {
    const { db, e } = await pressed();
    await spoke(e);
    ago(db, 'agent_seen_at', 3);
    const before = design(db).agent_seen_at;

    await trigger(e, 'DELETE');
    assert.equal(design(db).agent_seen_at, before, 'Stop moved the agent\'s stamp');
  });

  test('the wire carries it, flattened and per stage', async () => {
    const { db, e } = await pressed();
    await spoke(e);
    const w = wire(db, KEY);
    assert.ok(w.agent_seen_at, 'the flattened card does not say when the agent spoke');
    assert.equal(w.stages.design.agent_seen_at, w.agent_seen_at);
  });
});

// ──────────────────────────────────────────────────────────────────────
// A press while the runner is mid-run is refused, and says so
// ──────────────────────────────────────────────────────────────────────

describe('a press while the runner is mid-run is refused, and says so', () => {
  test('Stop then Run, a minute after the runner spoke, queues nothing and names the run', async () => {
    const { db, e } = await pressed();
    await spoke(e);
    ago(db, 'agent_seen_at', 1);

    const stop = await trigger(e, 'DELETE');
    assert.equal(stop.status, 200);
    assert.equal(design(db).requested_at, null, 'Stop did not clear the queue entry');

    const again = await trigger(e, 'POST', { stage: 'design' });
    assert.equal(again.status, 409, 'a press mid-run was accepted as a new request');
    const body = await again.text();
    assert.match(body, /design is already running/);
    assert.match(body, /last spoke 1m ago/);
    assert.match(body, /Stop only clears the queue entry/);
    assert.equal(design(db).requested_at, null, 'the refused press still wrote a queue entry');
  });

  test('a double press is refused the same way', async () => {
    const { db, e } = await pressed();
    await spoke(e);
    const again = await trigger(e, 'POST', { stage: 'design' });
    assert.equal(again.status, 409);
    assert.match(await again.text(), /already running/);
  });

  test('past the quiet window the press goes through: silence on an active row is a stopped run', async () => {
    const { db, e } = await pressed();
    await spoke(e);
    ago(db, 'agent_seen_at', RUN_QUIET_MIN + 1);
    await trigger(e, 'DELETE');

    const again = await trigger(e, 'POST', { stage: 'design' });
    assert.equal(again.status, 200);
    assert.ok(design(db).requested_at);
  });

  test('a runner that reported an error has stopped, however recently it said so', async () => {
    const { db, e } = await pressed();
    await spoke(e, 'error', { last_error: 'Figma unreachable' });
    await trigger(e, 'DELETE');   // clears the error, as Reset always has

    const again = await trigger(e, 'POST', { stage: 'design' });
    assert.equal(again.status, 200);
  });

  test('a runner waiting at a gate has stopped too', async () => {
    const { db, e } = await pressed();
    await spoke(e, 'waiting', { prompt: 'Which direction?', options: [
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' } ] });
    await trigger(e, 'DELETE');

    const again = await trigger(e, 'POST', { stage: 'design' });
    assert.equal(again.status, 200);
  });

  test('the other stage is not blocked by this one running', async () => {
    // Research on a card whose design is mid-run is still "already queued"
    // for design, by the one-run-per-card rule — not "already running".
    const { e } = await pressed();
    await spoke(e);
    const research = await trigger(e, 'POST', { stage: 'research' });
    assert.equal(research.status, 409);
    assert.match(await research.text(), /already queued for design/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// The board believes a runner that spoke recently
// ──────────────────────────────────────────────────────────────────────

const MIN = 60000;
const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

describe('the board believes a runner that spoke recently', () => {
  // WEB-279 as it stood at 16:18 UTC: pressed and stopped and pressed again
  // at 16:11, the runner's own post at 16:02, and — with the keepalive — its
  // last word a minute ago.
  const web279 = (extra) => ({
    id: 'WEB-279', linear_id: 'WEB-279', status: 'active', requested_stage: 'design',
    requested_at: stamp(9 * MIN), updated_at: stamp(9 * MIN), linear_state: 'backlog',
    ...extra,
  });

  test('Stop then Run cannot turn a live run into a queue position', () => {
    const r = web279({ agent_seen_at: stamp(1 * MIN) });
    assert.equal(isRunning(r), true, 'a runner that spoke a minute ago is not running');
    assert.equal(queueLabel(r, [r]), 'Working…');
  });

  test('without a recent word, equal stamps are a request and not a run — the old rule', () => {
    assert.equal(isRunning(web279({})), false);
    assert.equal(isRunning(web279({ agent_seen_at: stamp((RUN_QUIET_MIN + 1) * MIN) })), false,
      'a word older than the quiet window still counted as alive');
    assert.equal(queueLabel(web279({}), [web279({})]), 'Queued');
  });

  test('and the old rule still recognises a runner that posted after the press', () => {
    const r = web279({ requested_at: stamp(9 * MIN), updated_at: stamp(8 * MIN) });
    assert.equal(isRunning(r), true);
  });

  test('only an active row can be running, whatever it said and when', () => {
    assert.equal(isRunning(web279({ status: 'waiting', agent_seen_at: stamp(1 * MIN) })), false);
    assert.equal(isRunning(web279({ status: 'error', agent_seen_at: stamp(1 * MIN) })), false);
  });

  test('a running card is stalled by its own silence, not by the age of the press', () => {
    // Forty minutes since the press, a word a minute ago: a long design run,
    // going. This used to read Stalled at thirty minutes while drawing.
    const going = web279({ requested_at: stamp(40 * MIN), updated_at: stamp(1 * MIN),
                           agent_seen_at: stamp(1 * MIN) });
    assert.equal(isStalled(going, undefined, [going]), false, 'a run that spoke a minute ago read Stalled');

    // The same card, silent for longer than the stall window: the keepalive
    // stopped, so the run did.
    const dead = web279({ requested_at: stamp(70 * MIN),
                          updated_at: stamp((STALL_AFTER_MIN + 1) * MIN),
                          agent_seen_at: stamp((STALL_AFTER_MIN + 1) * MIN) });
    assert.equal(isStalled(dead, undefined, [dead]), true, 'a run silent past the window was not stalled');
  });

  test('a queued card is still measured from the press', () => {
    const waiting = web279({ requested_at: stamp((STALL_AFTER_MIN + 1) * MIN),
                             updated_at: stamp((STALL_AFTER_MIN + 1) * MIN) });
    assert.equal(isStalled(waiting, undefined, [waiting]), true);
    const fresh = web279({ requested_at: stamp(5 * MIN), updated_at: stamp(5 * MIN) });
    assert.equal(isStalled(fresh, undefined, [fresh]), false);
  });

  test('the board and the Worker draw the quiet line in the same place', () => {
    const worker = fs.readFileSync(path.join(ROOT, 'worker/index.js'), 'utf8');
    const m = worker.match(/const RUN_QUIET_MIN = (\d+);/);
    assert.ok(m, 'the Worker has no RUN_QUIET_MIN');
    assert.equal(Number(m[1]), RUN_QUIET_MIN,
      'the Worker refuses a press for a different window than the board shows Working');
  });
});
