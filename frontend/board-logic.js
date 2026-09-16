// Pure board logic — no DOM, no fetch, no state.
//
// A classic script rather than a module, so the inline onclick handlers in
// index.html keep resolving against globals and the page keeps its no-build-
// step property. Split out of index.html so these can be tested in node:vm
// with no browser stub at all.

// Sessions the reader could not place in a brand.
var UNASSIGNED = { id: '_unassigned', name: 'Unassigned', color: '#888780' };

// The labels the system writes when a stage completes. Dave never applies one
// and nothing triggers off them — they are the record of what has been done,
// and the board reads them to decide which column a card is in.
//
// `AI-QA done` is deliberately absent. QA was a stage the board offered and
// nothing implemented: pressing Run QA queued a run that failed with "the qa
// stage is not implemented yet", and the card then sat there claiming to be
// working on it. An issue still carrying that label from before reads as
// AI-designed, which is the last stage that actually ran on it.
var STAGE_LABELS = {
  research: 'AI-research done',
  design: 'AI-design done',
};

// Where a session belongs on the whole board: one of the collapsed sections
// at the bottom, or the brand buckets above them.
//
// A row can qualify for more than one, so the order is fixed. Completed is
// checked first because closed is the more final fact: an issue you dismissed
// and then closed belongs under Completed, not No design.
function sectionOf(r) {
  if (r.linear_state === 'completed' || r.linear_state === 'canceled') return 'completed';
  if (r.dismissed_at) return 'nodesign';
  return 'board';
}

// True for the rows that make up the board proper — everything that is not
// collapsed away. Counts use this, so dismissing a card drops it out of the
// topbar total and its brand header.
function isOpen(r) {
  return sectionOf(r) === 'board';
}

// The issue's Linear labels. Stored as a JSON array by the reader; tolerant of
// null, of an array already parsed, and of malformed JSON, because a board
// that throws on one bad row renders nothing at all.
function labelsOf(r) {
  var raw = r && r.labels;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function hasLabel(r, name) {
  return labelsOf(r).indexOf(name) !== -1;
}


// ─── GATES ─────────────────────────────────────────
// A gate is a question with a fixed set of answers. The options are the
// decision, so they are the one piece of agent prose the card does show: a
// question you cannot see from the board is a card that just sits there.
//
// Sessions with no options are unaffected by every one of these — no gate
// block, no prose, the quiet card the board already had.

// The options on a row, as an array. Same tolerance as labelsOf, for the same
// reason: a board that throws on one bad row renders nothing at all.
function optionsOf(r) {
  var raw = r && r.options;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Waiting on an answer nobody has given yet. This is the only state that puts
// the options in front of you.
function isGateOpen(r) {
  return !!(r && r.status === 'waiting' && optionsOf(r).length && !r.response_option_id);
}

// A design you drew yourself, named by the Figma section it lives in — the
// answer for when none of the offered directions is the one you want.
//
// It is a decision with no option id, because a section name was never one of
// the ids the agent offered and must never be stored as though it were. That
// shape — answered, options present, nothing named — is what identifies it,
// and it is the same rule the Hub applies to derive `response_kind`.
function ownSection(r) {
  if (!r || r.response_option_id || !r.responded_at) return '';
  if (!optionsOf(r).length) return '';
  return r.response_note || '';
}

// Answered, either way. Stays true after the agent carries on working, because
// a decision you can no longer see is a decision you can no longer take back.
function isGateAnswered(r) {
  if (!r || !optionsOf(r).length) return false;
  return !!(r.response_option_id || ownSection(r));
}

// What was decided, in words. The board never shows the bare id — "d2" says
// nothing about what was decided. For your own design that is the section name
// you typed. Falls back to the label the Hub resolved server-side, and then to
// the id itself, so an option since dropped still renders as something rather
// than as an empty space.
function chosenLabel(r) {
  var own = ownSection(r);
  if (own) return own;
  if (!r || !r.response_option_id) return '';
  var opts = optionsOf(r);
  for (var i = 0; i < opts.length; i++) {
    if (opts[i] && opts[i].id === r.response_option_id) {
      return opts[i].label || r.response_option_id;
    }
  }
  return r.response_label || r.response_option_id;
}

// ─── STAGE COMPLETION: THREE STATES, NOT TWO ───────
// Absence of `AI-research done` used to mean two different things — the stage
// has not run, and the stage was deliberately passed over — so a card marked
// no-research was indistinguishable from one whose research silently failed.
//
// Skipping is a decision, and a decision the board hid. These read it back out
// of the labels that already record it: nothing is written here, and no column
// was added.

// Dave's own labels, applied in Linear: "this one needs no research", "this
// one needs no design". One entry per stage the board still runs.
var SKIP_LABELS = {
  research: 'no-research',
  design: 'no-design',
};

// How far one stage got: 'done', 'skipped', or null for not started.
//
// Done outranks skipped. A card carrying both `no-research` and
// `AI-research done` had the research run in the end, whatever was intended
// earlier, and the label the system wrote is the more reliable of the two.
function stageState(r, stage) {
  if (hasLabel(r, STAGE_LABELS[stage])) return 'done';
  var skip = SKIP_LABELS[stage];
  if (skip && hasLabel(r, skip)) return 'skipped';
  return null;
}

// The furthest stage a card has got past, and how it got past it, as
// { stage, how }. Most-advanced first, so an issue carrying every label lands
// in the last stage rather than the first.
//
// A skipped stage counts as got-past: the card advances to the next column and
// becomes eligible for the next stage, exactly as a completed one does. What
// it must not do is *look* the same, which is what `how` carries.
function stageReached(r) {
  var levels = [
    { stage: 'designed', of: 'design' },
    { stage: 'researched', of: 'research' },
  ];
  for (var i = 0; i < levels.length; i++) {
    var how = stageState(r, levels[i].of);
    if (how) return { stage: levels[i].stage, how: how };
  }
  return { stage: 'backlog', how: null };
}

// Which column the card sits in.
function stageOf(r) {
  return stageReached(r).stage;
}

// Column headings. 'Backlog' rather than 'Queued': nothing is queued until you
// press a button, and the queue is `requested_stage`.
function stageName(stage) {
  if (stage === 'researched') return 'Researched';
  if (stage === 'designed') return 'AI-designed';
  return 'Backlog';
}

// What the card's own pill says. A skipped stage says so: 'Researched' would
// claim work that never happened, and 'Backlog' would hide a decision you
// made. The column heading stays plain — the pill is where the difference goes.
function stageLabel(r) {
  var reached = stageReached(r);
  if (reached.how !== 'skipped') return stageName(reached.stage);
  if (reached.stage === 'researched') return 'Research skipped';
  if (reached.stage === 'designed') return 'Design skipped';
  return stageName(reached.stage);
}

// True when the card is where it is because a stage was passed over rather
// than run. The pill reads differently for these.
function isSkipped(r) {
  return stageReached(r).how === 'skipped';
}

// A run has been asked for and has not reported back. This is the only thing
// that greys a button out, and it is cleared by /api/agent/stage-done.
function isWorking(r) {
  return !!(r && r.requested_stage);
}

// The one action a card offers, as { stage, label } — or null for a card that
// has been through every stage. Exactly one per card, always present while the
// card is on the board: there is deliberately no branch here that can return
// nothing for an open card short of the final stage.
//
// `no-research` used to be a special case here, offering Design from a card
// the board still showed in Backlog — the button and the column disagreed
// about where the card was. Skipping is part of stageOf now, so this reads the
// column and nothing else, and the two cannot drift apart.
function actionFor(r) {
  var stage = stageOf(r);
  if (stage === 'designed') return null;
  if (stage === 'researched') return { stage: 'design', label: 'Run Design' };
  return { stage: 'research', label: 'Run Research' };
}

// ─── WHAT A CARD IS ACTUALLY DOING ─────────────────
// One derivation, read by the pill, the card's tint, the stage button's text
// and the activity panel — so those four cannot disagree with each other the
// way the button and the column once did.
//
// Everything here is read-side. Nothing is written, no column was added, and
// there is no heartbeat and no poll: these are the fields the API already
// returns, compared against the clock.

// How long a queued run may go without its row moving before the board stops
// believing it. Long enough that an ordinary research or design run never
// trips it; short enough that a dead process is caught inside the hour.
var STALL_AFTER_MIN = 30;

// A SQLite `datetime('now')` stamp — "2026-09-16 20:31:47", always UTC — as
// milliseconds. NaN for anything that will not parse, which every caller
// treats as "cannot tell" rather than as a value.
function stampMs(ts) {
  if (!ts) return NaN;
  var s = String(ts).replace(' ', 'T');
  if (!/[Zz]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  return new Date(s).getTime();
}

// When this row last moved. `updated_at` is touched by the trigger route and
// by every agent post, so it is the closest thing to activity the Hub has;
// `requested_at` is the fallback for a row that somehow has no updated_at.
function lastActivity(r) {
  return (r && (r.updated_at || r.requested_at)) || '';
}

// Queued, and nothing has touched the row since. This is the check that stops
// an eternally-"working" card from hiding a process that died: a run reports
// in as it goes, so silence for half an hour is not progress.
//
// A row whose timestamp will not parse is deliberately *not* stalled. Flagging
// on missing data would flag the whole board the first time a column comes
// back null, and a board crying wolf is a board nobody reads.
function isStalled(r, now) {
  if (!isWorking(r)) return false;
  var t = stampMs(lastActivity(r));
  if (isNaN(t)) return false;
  return ((now === undefined ? Date.now() : now) - t) >= STALL_AFTER_MIN * 60000;
}

// The card's one true state. First match wins, and the order is the whole fix.
//
// `error` outranks `working` because `requested_stage` is cleared in exactly
// one place — POST /api/agent/stage-done — which a run that failed never
// reaches. Checking `isWorking` first painted "Working…" on a session that had
// already reported `status: "error"` and would never move again. RYV-84 sat
// like that for days, working on a QA stage that does not exist.
//
// `waiting` is an open gate, not `status === 'waiting'`. The reader writes
// that status on every quiet row it inserts, so a pill for it would appear on
// the entire board. What actually needs a human is a question with no answer.
//
// `done` is safe to render because it is written in one place, by the runner
// reporting a finished stage, and is never a default.
function runState(r, now) {
  if (!r) return 'idle';
  if (r.status === 'error') return 'error';
  if (isStalled(r, now)) return 'stalled';
  if (isWorking(r)) return 'working';
  if (isGateOpen(r)) return 'waiting';
  if (r.status === 'done') return 'done';
  return 'idle';
}

// What each state is called on the board. "Needs you" rather than "Waiting",
// because the thing being waited on is Dave.
var RUN_STATE_TEXT = {
  error: 'Error',
  stalled: 'Stalled',
  working: 'Working\u2026',
  waiting: 'Needs you',
  done: 'Done',
};

// How loud each one is, most urgent first. The console sorts on this; nothing
// else needs to know the order.
var RUN_STATE_RANK = ['error', 'stalled', 'waiting', 'working', 'done', 'idle'];

// The console's own words. Uppercase, because a console column reads as a
// level rather than as a sentence — and 'WORKING…' with the ellipsis in it
// does not line up with anything.
var RUN_STATE_CONSOLE = {
  error: 'ERROR',
  stalled: 'STALLED',
  working: 'WORKING',
  waiting: 'NEEDS YOU',
  done: 'DONE',
};

// How long a finished run stays news. A row keeps `status = 'done'` until
// something runs on it again, so without a window the console would carry
// every stage that has ever finished, for ever, which is a list and not a
// console.
var RECENT_DONE_H = 24;

// The pill on the right of the card. Everything that is doing something gets
// one; a quiet card still shows nothing but its stage.
function statusPill(r, now) {
  var state = runState(r, now);
  if (state === 'idle') return null;
  return { text: RUN_STATE_TEXT[state], kind: state };
}

// Why it stopped, in the agent's own words. The Hub shows no agent prose as a
// rule — the research is a comment on the Linear issue and is read there — and
// this is the second deliberate exception after a gate's options, for the same
// reason they were the first: a card that has stopped and will not say why is
// a card you have to go and look up somewhere else, which is precisely the
// trip the board exists to save.
function failureReason(r) {
  if (!r || r.status !== 'error') return '';
  return String(r.prompt || r.detail || '').trim();
}

// ─── THE CONSOLE ───────────────────────────────────
// What the right-hand panel prints. Pure, so the ordering and the windowing
// are testable without a DOM — the panel itself only formats what comes back.
//
// There is no event log behind this. Every line is a row's *current* state,
// stamped with when that row last moved, so the console reads like a log
// without pretending to be a history of transitions it never recorded.

// The lines to print, in order. Everything that is doing something, plus runs
// that finished recently enough to still be worth saying.
//
// Within a state, whatever moved longest ago comes first: a run stuck for
// three hours wants attention before one stuck for ten minutes. Finished runs
// are the exception and sort newest first — "longest stuck" means nothing
// about something that is no longer running.
function consoleRows(rows, now) {
  var t = (now === undefined ? Date.now() : now);
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    var state = runState(r, t);
    if (state === 'idle') continue;
    if (state === 'done') {
      var at = stampMs(lastActivity(r));
      if (isNaN(at) || (t - at) > RECENT_DONE_H * 3600000) continue;
    }
    out.push({ r: r, state: state });
  }
  out.sort(function (a, b) {
    var d = RUN_STATE_RANK.indexOf(a.state) - RUN_STATE_RANK.indexOf(b.state);
    if (d) return d;
    var ta = stampMs(lastActivity(a.r)), tb = stampMs(lastActivity(b.r));
    // A row with no usable timestamp sorts last rather than first — it is the
    // one we know least about, not the one that needs attention most.
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return a.state === 'done' ? tb - ta : ta - tb;
  });
  return out;
}

// The left column: local wall-clock time, because the console is read against
// the clock on the wall and not against a UTC stamp in the database.
function clockTime(ts) {
  var t = stampMs(ts);
  if (isNaN(t)) return '--:--';
  var d = new Date(t);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// What the console prints in the state column for a line.
function consoleState(state) {
  return RUN_STATE_CONSOLE[state] || '';
}

// Element ids are derived from session ids, which contain '/' and '-'.
// btoa would throw on any non-Latin1 character — issue titles already contain
// em dashes — so hash to hex instead.
function key(id) {
  var h = 0;
  for (var i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function timeAgo(ts, now) {
  var then = stampMs(ts);
  if (isNaN(then)) return '';
  var mins = Math.floor(((now === undefined ? Date.now() : now) - then) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  return Math.floor(hrs / 24) + 'd';
}
