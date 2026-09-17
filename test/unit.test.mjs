// Unit tests for the Hub's pure logic. No network, no DOM, no dependencies.
//
//   node --test test/
//
// Everything here is either imported from lib/*.mjs or run in node:vm, so the
// tests exercise the same source the Worker and the board ship.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

import { detectBrand, deriveBrand, deriveTrack } from '../lib/derive.mjs';
import { accessIdentity, resetAccessKeyCache } from '../lib/access.mjs';
import { linearKeyFromSessionId } from '../lib/session-id.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── board-logic.js in a bare context ──────────────────────────────────
// It is a classic script defining globals, so running it in a vm context
// hands back the functions with no DOM stub at all.
const board = vm.createContext({ Date, Math, isNaN, String });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), board);
const { stageOf, stageName, hasLabel, isWorking, actionFor, statusPill,
        sectionOf, isOpen, key, timeAgo,
        optionsOf, isGateOpen, isGateAnswered, chosenLabel, ownSection,
        stageState, stageReached, stageLabel, isSkipped,
        runState, isStalled, lastActivity, queuedSince, stampMs, failureReason,
        consoleRows, clockTime, consoleState, clearLabel, groupOf, projectLabel, elapsed,
        STALL_AFTER_MIN, RUN_STATE_TEXT, RUN_STATE_RANK, RECENT_DONE_H } = board;

// A fixed clock, so "stalled" is a fact about the row and not about when the
// suite happened to run.
const NOW = Date.parse('2026-09-16T21:00:00Z');
const minsAgo = (n) =>
  new Date(NOW - n * 60000).toISOString().slice(0, 19).replace('T', ' ');

// A row as the reader writes it. `labels` is the JSON array the board reads to
// decide a card's column.
const rowWith = (...names) => ({ labels: JSON.stringify(names) });

// Shorthand for a Linear issue as the reader sees it.
const issue = (team, extra = {}) => ({ team: team ? { name: team } : null, ...extra });

describe('deriveTrack — app vs website', () => {
  test('app teams', () => {
    assert.equal(deriveTrack('Conduit App'), 'app');
    assert.equal(deriveTrack('Ryve App'), 'app');
    assert.equal(deriveTrack('Psiphon App'), 'app');
  });

  test('website teams', () => {
    assert.equal(deriveTrack('Forge'), 'website');
    assert.equal(deriveTrack('Websites'), 'website');
  });

  test('unmapped team has no track', () => {
    assert.equal(deriveTrack('Marketing'), null);
  });

  test('missing team does not throw', () => {
    assert.equal(deriveTrack(undefined), null);
    assert.equal(deriveTrack(null), null);
    assert.equal(deriveTrack(''), null);
  });
});

describe('detectBrand — the keyword fallback layer', () => {
  test('matches on Linear project name', () => {
    assert.equal(detectBrand({ project: { name: 'Conduit Website' } }), 'conduit');
  });

  test('matches on a label', () => {
    assert.equal(detectBrand({ labels: { nodes: [{ name: 'Ryve' }] } }), 'ryve');
  });

  test('matches on title', () => {
    assert.equal(detectBrand({ title: 'Psiphon VPN download page' }), 'psiphon');
  });

  test('is case-insensitive', () => {
    assert.equal(detectBrand({ title: 'FORGE homepage refresh' }), 'forge');
  });

  test('project name wins over title', () => {
    assert.equal(
      detectBrand({ project: { name: 'Forge site' }, title: 'Conduit banner' }),
      'forge');
  });

  test('no brand word anywhere returns null', () => {
    assert.equal(detectBrand({ title: 'Update the pricing table', labels: { nodes: [] } }), null);
  });

  test('empty issue returns null rather than throwing', () => {
    assert.equal(detectBrand({}), null);
  });
});

describe('deriveBrand — team map first, keywords second', () => {
  test('mapped teams', () => {
    assert.equal(deriveBrand(issue('Conduit App')), 'conduit');
    assert.equal(deriveBrand(issue('Ryve App')), 'ryve');
    assert.equal(deriveBrand(issue('Psiphon App')), 'psiphon');
    assert.equal(deriveBrand(issue('Forge')), 'forge');
  });

  test('Websites has no mapping and falls through to keywords', () => {
    // This fallback is why WEB-248 is filed under psiphon.
    assert.equal(
      deriveBrand(issue('Websites', { title: 'Psiphon copy review' })),
      'psiphon');
  });

  test('Websites with no brand word is unplaced', () => {
    assert.equal(deriveBrand(issue('Websites', { title: 'Fix the footer' })), null);
  });

  test('Marketing is unmapped — this is the Unassigned path', () => {
    assert.equal(deriveBrand(issue('Marketing', { title: 'Q3 campaign brief' })), null);
  });

  test('Marketing can still be rescued by a keyword', () => {
    assert.equal(deriveBrand(issue('Marketing', { title: 'Conduit launch assets' })), 'conduit');
  });

  test('team mapping beats a conflicting keyword', () => {
    assert.equal(deriveBrand(issue('Forge', { title: 'Conduit cross-post' })), 'forge');
  });
});

describe('stageOf — which column a card is in', () => {
  test('no labels means Backlog', () => {
    assert.equal(stageOf(rowWith()), 'backlog');
    assert.equal(stageOf({}), 'backlog');
    assert.equal(stageOf({ labels: null }), 'backlog');
  });

  test('each done-label moves the card on', () => {
    assert.equal(stageOf(rowWith('AI-research done')), 'researched');
    assert.equal(stageOf(rowWith('AI-design done')), 'designed');
  });

  test('AI-QA done is no longer a level', () => {
    // QA was a stage the board offered and nothing implemented. An issue that
    // still carries the label from before reads as whatever actually ran on
    // it — never as a column of its own.
    assert.equal(stageOf(rowWith('AI-QA done')), 'backlog');
    assert.equal(stageOf(rowWith('AI-design done', 'AI-QA done')), 'designed');
  });

  test('the most advanced label wins', () => {
    assert.equal(stageOf(rowWith('AI-research done', 'AI-design done')), 'designed');
  });

  test('a skipped stage advances the card, same as a completed one', () => {
    // Skipping is a decision. Leaving the card in Backlog hid it, and made a
    // card you marked no-research look like one whose research failed.
    assert.equal(stageOf(rowWith('no-research')), 'researched');
    assert.equal(stageOf(rowWith('Design', 'no-design')), 'designed');
  });

  test('malformed labels render as Backlog rather than throwing', () => {
    // One bad row must not take the whole board down with it.
    assert.equal(stageOf({ labels: 'not json' }), 'backlog');
    assert.equal(stageOf({ labels: '{"a":1}' }), 'backlog');
  });

  test('an already-parsed array works too', () => {
    assert.equal(stageOf({ labels: ['AI-design done'] }), 'designed');
  });

  test('stageName is what the column heading says', () => {
    assert.equal(stageName('backlog'), 'Backlog');
    assert.equal(stageName('researched'), 'Researched');
    assert.equal(stageName('designed'), 'AI-designed');
    // Nothing answers to 'qa' any more, heading included.
    assert.equal(stageName('qa'), 'Backlog');
  });

  test('hasLabel', () => {
    assert.equal(hasLabel(rowWith('no-research'), 'no-research'), true);
    assert.equal(hasLabel(rowWith('no-research'), 'no-design'), false);
    assert.equal(hasLabel({}, 'no-research'), false);
  });
});

describe('stage completion — done, skipped, or not started', () => {
  // The three states the board could not tell apart. Absence of the done-label
  // used to mean both "has not run" and "was deliberately passed over".
  test('each stage reads back its own three states', () => {
    assert.equal(stageState(rowWith(), 'research'), null);
    assert.equal(stageState(rowWith('AI-research done'), 'research'), 'done');
    assert.equal(stageState(rowWith('no-research'), 'research'), 'skipped');

    assert.equal(stageState(rowWith(), 'design'), null);
    assert.equal(stageState(rowWith('AI-design done'), 'design'), 'done');
    assert.equal(stageState(rowWith('no-design'), 'design'), 'skipped');
  });

  test('the Hub knows two stages, and QA is not one of them', () => {
    // Removed end to end rather than hidden: there is no label for it to read
    // and no rung on the ladder for it to land on.
    assert.equal(stageState(rowWith('AI-QA done'), 'qa'), null);
    assert.equal(stageState(rowWith('AI-QA done'), 'design'), null);
    assert.equal(stageReached(rowWith('AI-QA done')).stage, 'backlog');
  });

  test('done outranks skipped — the run happened in the end', () => {
    assert.equal(stageState(rowWith('no-research', 'AI-research done'), 'research'), 'done');
    assert.equal(stageLabel(rowWith('no-research', 'AI-research done')), 'Researched');
  });

  test('the pill says skipped where the column cannot', () => {
    assert.equal(stageLabel(rowWith()), 'Backlog');
    assert.equal(stageLabel(rowWith('AI-research done')), 'Researched');
    assert.equal(stageLabel(rowWith('no-research')), 'Research skipped');
    assert.equal(stageLabel(rowWith('no-design')), 'Design skipped');
    assert.equal(stageLabel(rowWith('AI-QA done')), 'Backlog');
  });

  test('isSkipped tracks the stage that put the card where it is', () => {
    assert.equal(isSkipped(rowWith('no-research')), true);
    assert.equal(isSkipped(rowWith('AI-research done')), false);
    assert.equal(isSkipped(rowWith()), false);
    // Research was skipped, but design actually ran — the card's level is
    // design, and that level was earned.
    assert.equal(isSkipped(rowWith('no-research', 'AI-design done')), false);
    assert.equal(stageLabel(rowWith('no-research', 'AI-design done')), 'AI-designed');
  });

  test('a skipped stage is eligible for the next one', () => {
    // The whole point of counting it as complete: the button and the column
    // agree, because the button now reads the column.
    const act = (r) => { const a = actionFor(r); return a && a.stage + '/' + a.label; };
    assert.equal(stageOf(rowWith('no-research')), 'researched');
    assert.equal(act(rowWith('no-research')), 'design/Run Design');
    // Skipping design lands the card at the end of the board, so there is no
    // next stage to be eligible for — which is a column, not a missing button.
    assert.equal(stageOf(rowWith('no-design')), 'designed');
    assert.equal(act(rowWith('no-design')), null);
  });
});

describe('actionFor — the one button a card offers', () => {
  // Field by field, not deepEqual: these objects are built inside the vm
  // context, so they are structurally right but never reference-equal.
  const act = (r) => { const a = actionFor(r); return a && a.stage + '/' + a.label; };

  test('backlog offers Research', () => {
    assert.equal(act(rowWith()), 'research/Run Research');
  });

  test('no-research skips it straight to Design', () => {
    // Dave applies this label in Linear himself: "this one needs no research".
    // The card now sits under Researched too, so the button and the column say
    // the same thing rather than disagreeing.
    assert.equal(act(rowWith('no-research')), 'design/Run Design');
    assert.equal(stageOf(rowWith('no-research')), 'researched');
  });

  test('researched offers Design', () => {
    assert.equal(act(rowWith('AI-research done')), 'design/Run Design');
  });

  test('AI-designed is the end of the board', () => {
    // It offered Run QA, and nothing implemented QA: the run failed and the
    // card was left holding a queue entry that only stage-done ever clears.
    assert.equal(actionFor(rowWith('AI-design done')), null);
    assert.equal(actionFor(rowWith('AI-design done', 'AI-QA done')), null);
  });

  test('every stage short of the last offers a button — no card renders empty', () => {
    // This is the bug the column board replaced: a card whose status did not
    // match any branch fell through and rendered with no actions at all.
    for (const r of [rowWith(), rowWith('no-research'), rowWith('AI-research done')]) {
      assert.ok(actionFor(r), 'expected an action for ' + r.labels);
    }
  });
});

describe('isWorking and statusPill', () => {
  test('a queued request is working', () => {
    assert.equal(isWorking({ requested_stage: 'research' }), true);
  });

  test('nothing queued is not working', () => {
    assert.equal(isWorking({ requested_stage: null }), false);
    assert.equal(isWorking({}), false);
  });

  test('the pill shows a run in progress', () => {
    assert.equal(statusPill({ requested_stage: 'design' }, NOW).kind, 'working');
  });

  test('the pill shows an error', () => {
    assert.equal(statusPill({ status: 'error' }, NOW).kind, 'error');
  });

  test('a quiet card gets no pill at all', () => {
    // The stage is already on the card, and the reader writes 'waiting' on
    // every row it inserts — so a pill for that status would be on all of them.
    assert.equal(statusPill({ status: 'waiting' }, NOW), null);
    assert.equal(statusPill({}, NOW), null);
  });

  test('an error outranks a queue entry, because nothing will ever clear it', () => {
    // The bug. `requested_stage` is cleared in one place — stage-done — which
    // a run that failed never reaches, so isWorking stays true for ever. This
    // assertion used to read the other way round, and RYV-84 sat on the board
    // saying "Working…" about a QA stage that does not exist.
    assert.equal(statusPill({ status: 'error', requested_stage: 'design' }, NOW).kind, 'error');
    assert.equal(runState({ status: 'error', requested_stage: 'design' }, NOW), 'error');
  });
});

describe('runState — what a card is actually doing', () => {
  // One derivation behind the pill, the card's outline, the stage button's
  // text and the activity panel, so those four cannot contradict each other.
  const gate = { status: 'waiting', options: [{ id: 'd1', label: 'One' }] };

  test('the five states, from their own fields', () => {
    assert.equal(runState({ status: 'error' }, NOW), 'error');
    assert.equal(runState({ requested_stage: 'design', updated_at: minsAgo(90) }, NOW), 'stalled');
    assert.equal(runState({ requested_stage: 'design', updated_at: minsAgo(2) }, NOW), 'working');
    assert.equal(runState(gate, NOW), 'waiting');
    assert.equal(runState({ status: 'done' }, NOW), 'done');
  });

  test('a quiet row is idle, and idle gets no pill', () => {
    assert.equal(runState({ status: 'waiting' }, NOW), 'idle');
    assert.equal(runState({}, NOW), 'idle');
    assert.equal(runState(null, NOW), 'idle');
    assert.equal(statusPill({ status: 'waiting' }, NOW), null);
  });

  test('waiting means an open gate, not the status the reader writes', () => {
    // Every row the reader inserts is status 'waiting'. If that were the
    // test, the pill would be on the whole board and would mean nothing.
    assert.equal(runState({ status: 'waiting' }, NOW), 'idle');
    assert.equal(runState(gate, NOW), 'waiting');
    // Answered — the agent has what it needs and is no longer held up.
    assert.equal(runState({ ...gate, response_option_id: 'd1' }, NOW), 'idle');
  });

  test('a queued run outranks an open gate', () => {
    // Both are true of a re-triggered gate. The run is the more recent fact
    // and the one the button is about.
    assert.equal(runState({ ...gate, requested_stage: 'design' }, NOW), 'working');
  });

  test('every state has a word, and a place in the order', () => {
    for (const state of ['error', 'stalled', 'working', 'waiting', 'done']) {
      assert.ok(RUN_STATE_TEXT[state], 'no text for ' + state);
      assert.ok(RUN_STATE_RANK.indexOf(state) !== -1, 'no rank for ' + state);
    }
    // Most urgent first — this is the activity panel's sort order.
    assert.ok(RUN_STATE_RANK.indexOf('error') < RUN_STATE_RANK.indexOf('working'));
    assert.ok(RUN_STATE_RANK.indexOf('stalled') < RUN_STATE_RANK.indexOf('working'));
    assert.ok(RUN_STATE_RANK.indexOf('idle') === RUN_STATE_RANK.length - 1);
  });
});

describe('isStalled — an eternally-working card cannot hide a dead run', () => {
  test('nothing queued is never stalled, however old the row', () => {
    assert.equal(isStalled({ updated_at: minsAgo(600) }, NOW), false);
  });

  test('the threshold is the one named constant', () => {
    assert.equal(STALL_AFTER_MIN, 30);
    const at = (n) => isStalled({ requested_stage: 'design', updated_at: minsAgo(n) }, NOW);
    assert.equal(at(STALL_AFTER_MIN - 1), false);
    assert.equal(at(STALL_AFTER_MIN), true);
    assert.equal(at(STALL_AFTER_MIN + 120), true);
  });

  test('a row with no usable timestamp is not stalled', () => {
    // Flagging on missing data would flag the whole board the first time a
    // column came back null, and a board crying wolf is one nobody reads.
    assert.equal(isStalled({ requested_stage: 'design' }, NOW), false);
    assert.equal(isStalled({ requested_stage: 'design', updated_at: 'not a date' }, NOW), false);
  });

  test('the two clocks answer two different questions', () => {
    // When the row last moved, for the console's clock column...
    assert.equal(lastActivity({ updated_at: minsAgo(1), requested_at: minsAgo(90) }), minsAgo(1));
    // ...and how long the request has been outstanding, for the stall clock.
    assert.equal(queuedSince({ updated_at: minsAgo(1), requested_at: minsAgo(90) }), minsAgo(90));
    // Each falls back to the other where its own field is missing.
    assert.equal(lastActivity({ requested_at: minsAgo(90) }), minsAgo(90));
    assert.equal(queuedSince({ updated_at: minsAgo(1) }), minsAgo(1));
  });

  test('a Linear read does not clear a stall', () => {
    // The reader's upsert sets updated_at = datetime('now') on every row it
    // refreshes. Running the stall clock on updated_at meant a cron read — or
    // anyone pressing Read Linear — reset it on a run that died hours ago and
    // hid it again for another half hour. requested_at is written once by the
    // trigger and cleared only by stage-done, so nothing else can move it.
    const justRead = { requested_stage: 'design', requested_at: minsAgo(180), updated_at: minsAgo(0) };
    assert.equal(isStalled(justRead, NOW), true, 'a read un-stalled a dead run');
  });

  test('the stamps the Hub actually stores parse', () => {
    // SQLite datetime('now') — space-separated, no zone, always UTC.
    assert.equal(stampMs('2026-09-16 20:31:47'), Date.parse('2026-09-16T20:31:47Z'));
    // And an ISO stamp is not given a second Z.
    assert.equal(stampMs('2026-09-16T20:31:47Z'), Date.parse('2026-09-16T20:31:47Z'));
    assert.ok(isNaN(stampMs(null)));
    assert.ok(isNaN(stampMs('')));
  });
});

describe('consoleRows — the lines the console prints', () => {
  // The ordering and the windowing live here rather than in the panel, so
  // they can be checked without a DOM. The panel only formats what comes back.
  const at = (n) => ({ updated_at: minsAgo(n) });
  // Joined rather than deepEqual: the arrays come back from the vm context,
  // so they are structurally right but never reference-equal to an outer one.
  const ids = (rows) => consoleRows(rows, NOW).map(x => x.r.linear_id).join(" ");

  const rows = [
    { linear_id: 'IDLE', status: 'waiting', ...at(5) },
    { linear_id: 'RUN', requested_stage: 'design', ...at(3) },
    { linear_id: 'GATE', status: 'waiting', options: [{ id: 'd1', label: 'One' }], ...at(10) },
    { linear_id: 'STUCK', requested_stage: 'research', ...at(95) },
    { linear_id: 'DEAD', status: 'error', ...at(200) },
    { linear_id: 'FRESH', status: 'done', ...at(20) },
  ];

  test('most urgent first, and idle rows are not lines at all', () => {
    assert.equal(ids(rows), "DEAD STUCK GATE RUN FRESH");
  });

  test('within a state, whatever moved longest ago comes first', () => {
    // A run stuck for three hours wants attention before one stuck for ten
    // minutes, so the console does not sort live work newest-first.
    const two = [{ linear_id: 'RECENT', requested_stage: 'design', ...at(2) },
                 { linear_id: 'OLDER', requested_stage: 'design', ...at(20) }];
    assert.equal(ids(two), "OLDER RECENT");
  });

  test('finished runs are the exception, and sort newest first', () => {
    // "Longest stuck" says nothing about something that is no longer running.
    const two = [{ linear_id: 'OLDER', status: 'done', ...at(600) },
                 { linear_id: 'NEWER', status: 'done', ...at(5) }];
    assert.equal(ids(two), "NEWER OLDER");
  });

  test('a finished run stops being news after a day', () => {
    // status stays 'done' until something runs on the row again, so without
    // the window the console would carry every stage that ever finished.
    assert.equal(RECENT_DONE_H, 24);
    const within = [{ linear_id: 'YESTERDAY', status: 'done', ...at(60 * 23) }];
    const beyond = [{ linear_id: 'LAST-WEEK', status: 'done', ...at(60 * 24 * 7) }];
    assert.equal(ids(within), "YESTERDAY");
    assert.equal(ids(beyond), "");
    // And a finished run with no usable stamp is not news either — there is
    // nothing to say it happened recently.
    assert.equal(ids([{ linear_id: 'NOSTAMP', status: 'done' }]), '');
  });

  test('a row with no usable timestamp sorts last, not first', () => {
    const two = [{ linear_id: 'NOSTAMP', requested_stage: 'design' },
                 { linear_id: 'TIMED', requested_stage: 'design', ...at(4) }];
    assert.equal(ids(two), "TIMED NOSTAMP");
  });

  test('nothing to print is an empty list, not a throw', () => {
    assert.equal(consoleRows([], NOW).length, 0);
    assert.equal(consoleRows(null, NOW).length, 0);
  });
});

describe('the console columns', () => {
  test('the state column is a level, not a sentence', () => {
    assert.equal(consoleState('error'), 'ERROR');
    assert.equal(consoleState('waiting'), 'NEEDS YOU');
    assert.equal(consoleState('working'), 'WORKING');
    assert.equal(consoleState('idle'), '');
  });

  test('the time column is wall-clock, and never NaN', () => {
    assert.match(clockTime('2026-09-16 20:31:47'), /^\d\d:\d\d$/);
    assert.equal(clockTime(null), '--:--');
    assert.equal(clockTime('not a date'), '--:--');
    // Local, not UTC: the console is read against the clock on the wall.
    const local = new Date(Date.UTC(2026, 8, 16, 20, 31, 47));
    assert.equal(clockTime('2026-09-16 20:31:47'),
      ('0' + local.getHours()).slice(-2) + ':' + ('0' + local.getMinutes()).slice(-2));
  });
});

describe('clearLabel — Stop while it runs, Reset once it has stopped', () => {
  test('a run that is going says Stop', () => {
    assert.equal(clearLabel({ requested_stage: 'design', updated_at: minsAgo(2),
                              requested_at: minsAgo(2) }, NOW), 'Stop');
  });

  test('a run that has stopped says Reset — there is nothing left to stop', () => {
    assert.equal(clearLabel({ status: 'error' }, NOW), 'Reset');
    assert.equal(clearLabel({ requested_stage: 'design', requested_at: minsAgo(90) }, NOW), 'Reset');
  });

  test('a card with no run behind it gets neither', () => {
    assert.equal(clearLabel({ status: 'waiting' }, NOW), '');
    assert.equal(clearLabel({ status: 'done' }, NOW), '');
    assert.equal(clearLabel({}, NOW), '');
    // Not even an open gate: a question is not a run.
    assert.equal(clearLabel({ status: 'waiting', options: [{ id: 'd1', label: 'One' }] }, NOW), '');
  });
});

describe('elapsed — the one thing on the board that moves by itself', () => {
  // It exists because nothing else does: the runner posts 'active' once before
  // it starts and nothing again until it is done, so the card is otherwise
  // identical at second one and at minute nine.
  const at = (secs) => NOW - secs * 1000;

  test('it counts seconds, because the point is that it is moving', () => {
    // timeAgo says "4m" for everything between four and five minutes, which is
    // exactly the stillness this is fixing.
    assert.equal(elapsed(new Date(at(0)).toISOString(), NOW), '0m00s');
    assert.equal(elapsed(new Date(at(9)).toISOString(), NOW), '0m09s');
    assert.equal(elapsed(new Date(at(65)).toISOString(), NOW), '1m05s');
    assert.equal(elapsed(new Date(at(599)).toISOString(), NOW), '9m59s');
  });

  test('past an hour it stops counting seconds nobody is reading', () => {
    assert.equal(elapsed(new Date(at(3600)).toISOString(), NOW), '1h00m');
    assert.equal(elapsed(new Date(at(3600 * 2 + 300)).toISOString(), NOW), '2h05m');
  });

  test('a clock skew does not render a negative run', () => {
    assert.equal(elapsed(new Date(NOW + 5000).toISOString(), NOW), '0m00s');
  });

  test('nothing to count is empty, not NaN', () => {
    assert.equal(elapsed(null, NOW), '');
    assert.equal(elapsed('not a date', NOW), '');
  });

  test('it reads the SQLite stamps the Hub actually stores', () => {
    assert.equal(elapsed(minsAgo(3), NOW), '3m00s');
  });
});

describe('failureReason — the card says why it stopped', () => {
  test('the agent puts the failure in the prompt, and that is what shows', () => {
    assert.equal(failureReason({ status: 'error', prompt: 'The qa stage is not implemented yet' }),
                 'The qa stage is not implemented yet');
    assert.equal(failureReason({ status: 'error', detail: 'unmapped-destination' }),
                 'unmapped-destination');
  });

  test('nothing is shown for a card that has not errored', () => {
    // The one exception is an errored card. A row that is merely waiting still
    // shows no agent prose at all — that is the whole rule, not half of it.
    assert.equal(failureReason({ status: 'waiting', prompt: 'Run design research on FOR-26?' }), '');
    assert.equal(failureReason({ status: 'error' }), '');
    assert.equal(failureReason(null), '');
  });
});

describe('groupOf — team first, project only where there is no team', () => {
  test('the team is the group', () => {
    assert.equal(groupOf({ team: 'Marketing', linear_project: 'BCC' }), 'Marketing');
  });

  test('the Linear project stands in where there is no team', () => {
    // A session an agent posted with no Linear issue behind it has neither a
    // team nor a brand. Without the fallback it is reachable only by scrolling.
    assert.equal(groupOf({ linear_project: 'Forge Self-Serve' }), 'Forge Self-Serve');
  });

  test('a row with neither still lands somewhere', () => {
    assert.equal(groupOf({}), 'No team');
    assert.equal(groupOf(null), 'No team');
  });

  test('one row is in exactly one group, never two', () => {
    // The sidebar's counts have to add up to the board's, so team and project
    // are a fallback chain and not two dimensions.
    const r = { team: 'Forge', linear_project: 'Forge Self-Serve' };
    assert.equal(groupOf(r), 'Forge');
  });
});

describe('projectLabel — shown only where the brand is not obvious', () => {
  test('a team that implies its brand needs no project label', () => {
    for (const team of ['Conduit App', 'Ryve App', 'Psiphon App', 'Forge']) {
      assert.equal(projectLabel({ team, linear_project: 'Something' }), '');
    }
  });

  test('a team that does not gets one', () => {
    assert.equal(projectLabel({ team: 'Marketing', linear_project: 'BCC' }), 'BCC');
    assert.equal(projectLabel({ team: 'Websites', linear_project: 'Q3 Pages' }), 'Q3 Pages');
    assert.equal(projectLabel({ team: 'Insights', linear_project: 'Metrics' }), 'Metrics');
  });

  test('no project, no label', () => {
    assert.equal(projectLabel({ team: 'Marketing' }), '');
    assert.equal(projectLabel(null), '');
  });
});

describe('sectionOf — board vs the collapsed sections', () => {
  test('an ordinary row belongs on the board', () => {
    assert.equal(sectionOf({ linear_state: 'backlog' }), 'board');
    assert.equal(sectionOf({ linear_state: 'unstarted', triggered_at: '2026-09-05 01:00:00' }), 'board');
    assert.equal(sectionOf({}), 'board');
  });

  test('a dismissed row goes to No design', () => {
    assert.equal(sectionOf({ dismissed_at: '2026-09-05 01:00:00', linear_state: 'backlog' }), 'nodesign');
  });

  test('completed and canceled both go to Completed', () => {
    assert.equal(sectionOf({ linear_state: 'completed' }), 'completed');
    assert.equal(sectionOf({ linear_state: 'canceled' }), 'completed');
  });

  test('set aside goes to Dismissed, which is not No design', () => {
    // Two different statements. no-design is about the issue and is written
    // into Linear; set_aside_at is about this Hub's agents and never leaves it.
    assert.equal(sectionOf({ set_aside_at: '2026-09-16 22:00:00' }), 'dismissed');
    assert.equal(sectionOf({ dismissed_at: '2026-09-16 22:00:00' }), 'nodesign');
  });

  test('no-design outranks set aside — a fact beats a preference', () => {
    assert.equal(sectionOf({ dismissed_at: 'x', set_aside_at: 'y' }), 'nodesign');
  });

  test('closed outranks both', () => {
    assert.equal(sectionOf({ linear_state: 'completed', set_aside_at: 'y' }), 'completed');
  });

  test('a set-aside row is not open, so it leaves every count', () => {
    assert.equal(isOpen({ set_aside_at: 'y' }), false);
  });

  test('closed beats dismissed — the more final fact wins', () => {
    assert.equal(
      sectionOf({ linear_state: 'completed', dismissed_at: '2026-09-05 01:00:00' }),
      'completed');
  });

  test('dismissed beats in flight', () => {
    // Dismissing something already triggered should still file it away.
    assert.equal(
      sectionOf({ dismissed_at: '2026-09-05 01:00:00', triggered_at: '2026-09-05 00:00:00' }),
      'nodesign');
  });

  test('isOpen is true only for board rows', () => {
    assert.equal(isOpen({ linear_state: 'backlog' }), true);
    assert.equal(isOpen({ dismissed_at: '2026-09-05 01:00:00' }), false);
    assert.equal(isOpen({ linear_state: 'completed' }), false);
    assert.equal(isOpen({ linear_state: 'canceled' }), false);
  });
});

describe('linearKeyFromSessionId — the join between the two id conventions', () => {
  test('the agent session id shape', () => {
    assert.equal(linearKeyFromSessionId('ryve/ryv-84/research'), 'RYV-84');
    assert.equal(linearKeyFromSessionId('conduit/CON-116/design'), 'CON-116');
  });

  test('a bare key, and the reader\'s own id', () => {
    assert.equal(linearKeyFromSessionId('RYV-84'), 'RYV-84');
    assert.equal(linearKeyFromSessionId('linear/CON-116'), 'CON-116');
  });

  test('a session id with no issue behind it stays unmatched', () => {
    // This is the case that must not produce a false positive: matching a
    // whole path segment is what keeps 'wallet-flow' from reading as a key.
    assert.equal(linearKeyFromSessionId('conduit/wallet-flow/design'), null);
    assert.equal(linearKeyFromSessionId('social-ai/october-campaign'), null);
  });

  test('bad input does not throw', () => {
    for (const v of [null, undefined, '', 42, {}]) {
      assert.equal(linearKeyFromSessionId(v), null);
    }
  });
});

describe('the gate helpers — options, open, answered, chosen', () => {
  const OPTS = [
    { id: 'd1', label: 'Icon-only corner button', summary: '48x48 circular +.' },
    { id: 'd2', label: 'Labelled corner control', summary: 'Costs card width.' },
  ];
  // The Hub sends options as an array; the column holds JSON. Both arrive.
  const asJson = (o) => ({ ...o, options: JSON.stringify(OPTS) });
  const asArray = (o) => ({ ...o, options: OPTS });

  test('options parse from JSON, from an array, and from neither', () => {
    assert.equal(optionsOf(asJson({})).length, 2);
    assert.equal(optionsOf(asArray({})).length, 2);
    assert.equal(optionsOf({}).length, 0);
    assert.equal(optionsOf({ options: null }).length, 0);
    assert.equal(optionsOf(null).length, 0);
  });

  test('a malformed options column is empty, not an exception', () => {
    assert.equal(optionsOf({ options: '{not json' }).length, 0);
    assert.equal(optionsOf({ options: '{"id":"d1"}' }).length, 0);
  });

  test('a gate is open only while it is waiting and unanswered', () => {
    assert.equal(isGateOpen(asJson({ status: 'waiting' })), true);
    assert.equal(isGateOpen(asJson({ status: 'active' })), false);
    assert.equal(isGateOpen(asJson({ status: 'waiting', response_option_id: 'd2' })), false);
    // No options, no gate — the free-text sessions are untouched.
    assert.equal(isGateOpen({ status: 'waiting', prompt: 'Which?' }), false);
  });

  test('a gate stays answered after the agent carries on working', () => {
    assert.equal(isGateAnswered(asJson({ status: 'active', response_option_id: 'd2' })), true);
    assert.equal(isGateAnswered(asJson({ status: 'waiting' })), false);
    // A free-text answer is not a gate decision and offers nothing to reopen.
    assert.equal(isGateAnswered({ response: 'Direction B' }), false);
  });

  test('the chosen option resolves to its label, never the bare id', () => {
    assert.equal(chosenLabel(asJson({ response_option_id: 'd2' })), 'Labelled corner control');
    assert.equal(chosenLabel(asJson({})), '');
  });

  test('a design of your own is a decision with no option id', () => {
    // The shape that identifies it: answered, options present, nothing named.
    const own = asJson({ status: 'active', responded_at: '2026-09-13 10:00:00',
                         response_note: 'Wallet header v3' });
    assert.equal(ownSection(own), 'Wallet header v3');
    assert.equal(isGateAnswered(own), true);
    assert.equal(isGateOpen(own), false);
    assert.equal(chosenLabel(own), 'Wallet header v3');
  });

  test('a note on an unanswered gate is not a decision', () => {
    // Nothing has been responded to, so a note is just a note — which is the
    // whole reason a section arrives under its own field.
    const noted = asJson({ status: 'waiting', response_note: 'Wallet header v3' });
    assert.equal(ownSection(noted), '');
    assert.equal(isGateAnswered(noted), false);
    assert.equal(isGateOpen(noted), true);
  });

  test('a note beside a chosen option is not a section', () => {
    const withNote = asJson({ status: 'active', responded_at: '2026-09-13 10:00:00',
                              response_option_id: 'd2', response_note: 'tighten the copy' });
    assert.equal(ownSection(withNote), '');
    assert.equal(chosenLabel(withNote), 'Labelled corner control');
  });

  test('a free-text session has no section either', () => {
    // No options at all: the old behaviour, and nothing here applies to it.
    assert.equal(ownSection({ status: 'active', responded_at: '2026-09-13 10:00:00',
                              response_note: 'Direction B' }), '');
  });

  test('an id the options no longer carry falls back rather than blanking', () => {
    // A round that dropped an option, read back from history.
    assert.equal(
      chosenLabel({ ...asJson({}), response_option_id: 'd9', response_label: 'Something else' }),
      'Something else');
    assert.equal(chosenLabel({ ...asJson({}), response_option_id: 'd9' }), 'd9');
  });
});

describe('key — the element-id hash that replaced btoa()', () => {
  test('handles an em dash', () => {
    // btoa() threw on exactly this: issue titles and ids with non-Latin1.
    assert.doesNotThrow(() => key('linear/CON-142 — wallet flow'));
  });

  test('handles characters far outside Latin1', () => {
    assert.doesNotThrow(() => key('日本語'));
    assert.doesNotThrow(() => key('🚀 emoji id'));
    assert.doesNotThrow(() => key('العربية'));
  });

  test('output is hex and id-safe', () => {
    for (const id of ['linear/CON-118', 'linear/WEB-265 — blog', '日本語']) {
      assert.match(key(id), /^[0-9a-f]+$/);
    }
  });

  test('stable for the same input', () => {
    assert.equal(key('linear/CON-118'), key('linear/CON-118'));
  });

  test('distinguishes the real session ids on the board', () => {
    const ids = ['linear/CON-116', 'linear/CON-118', 'linear/CON-119', 'linear/CON-120',
                 'linear/CON-122', 'linear/RYV-187', 'linear/WEB-248', 'linear/WEB-265'];
    assert.equal(new Set(ids.map(key)).size, ids.length);
  });

  test('empty string does not throw', () => {
    assert.doesNotThrow(() => key(''));
  });
});

describe('timeAgo', () => {
  test('renders minutes, hours and days', () => {
    const ago = mins => new Date(Date.now() - mins * 60000)
      .toISOString().replace('T', ' ').slice(0, 19);
    assert.equal(timeAgo(ago(0)), 'now');
    assert.equal(timeAgo(ago(5)), '5m');
    assert.equal(timeAgo(ago(120)), '2h');
    assert.equal(timeAgo(ago(60 * 24 * 3)), '3d');
  });

  test('null and garbage are empty, not NaN', () => {
    assert.equal(timeAgo(null), '');
    assert.equal(timeAgo('not a date'), '');
  });
});

// ── Access JWT verification ───────────────────────────────────────────

describe('accessIdentity — Access JWT verification', () => {
  const TEAM = 'testteam';
  const AUD = 'aud-tag-1234';
  const env = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD };

  let privateKey, jwk, realFetch;

  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const req = token => ({ headers: { get: h => (h === 'Cf-Access-Jwt-Assertion' ? token : null) } });

  async function sign(payload, { kid = 'kid-1', alg = 'RS256' } = {}) {
    const head = b64({ alg, kid, typ: 'JWT' });
    const body = b64(payload);
    const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey,
      new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
  }

  const now = () => Math.floor(Date.now() / 1000);
  const good = () => ({
    aud: [AUD],
    iss: `https://${TEAM}.cloudflareaccess.com`,
    exp: now() + 3600,
    iat: now(),
    email: 'd.bell@psiphon.ca',
  });

  beforeEach(async () => {
    // Fresh keys and a cleared cache per case, so one case's key set can never
    // validate the next one's token.
    resetAccessKeyCache();
    const pair = await webcrypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']);
    privateKey = pair.privateKey;
    jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    jwk.kid = 'kid-1'; jwk.alg = 'RS256'; jwk.use = 'sig';
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  });

  test.after(() => { if (realFetch) globalThis.fetch = realFetch; });

  test('a valid token is accepted and its claims returned', async () => {
    const payload = await accessIdentity(req(await sign(good())), env);
    assert.ok(payload);
    assert.equal(payload.email, 'd.bell@psiphon.ca');
  });

  test('expired is rejected', async () => {
    assert.equal(await accessIdentity(req(await sign({ ...good(), exp: now() - 10 })), env), null);
  });

  test('wrong audience is rejected', async () => {
    assert.equal(await accessIdentity(req(await sign({ ...good(), aud: ['another-app'] })), env), null);
  });

  test('wrong issuer is rejected', async () => {
    assert.equal(await accessIdentity(
      req(await sign({ ...good(), iss: 'https://evil.cloudflareaccess.com' })), env), null);
  });

  test('unknown signing key is rejected', async () => {
    assert.equal(await accessIdentity(req(await sign(good(), { kid: 'kid-nope' })), env), null);
  });

  test('alg:none is rejected', async () => {
    assert.equal(await accessIdentity(req(await sign(good(), { alg: 'none' })), env), null);
  });

  test('a tampered payload is rejected', async () => {
    const parts = (await sign(good())).split('.');
    parts[1] = b64({ ...good(), email: 'attacker@example.com' });
    assert.equal(await accessIdentity(req(parts.join('.')), env), null);
  });

  test('missing and malformed tokens are rejected', async () => {
    assert.equal(await accessIdentity(req(null), env), null);
    assert.equal(await accessIdentity(req('not.a.jwt'), env), null);
    assert.equal(await accessIdentity(req('onlyonepart'), env), null);
  });

  test('the CF_Authorization cookie is accepted as a fallback', async () => {
    const token = await sign(good());
    const request = {
      headers: { get: h => (h === 'Cookie' ? `CF_Authorization=${token}; other=1` : null) },
    };
    assert.ok(await accessIdentity(request, env));
  });

  test('an unreachable certs endpoint fails closed', async () => {
    const token = await sign(good());
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    resetAccessKeyCache();
    assert.equal(await accessIdentity(req(token), env), null);
  });
});
