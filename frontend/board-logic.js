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
// A row can qualify for more than one, so the order is fixed, from the most
// final fact to the least:
//
//   completed  closed in Linear, and nothing else can outrank that
//   nodesign   the `no-design` label — a fact about the issue, in Linear,
//              visible to everyone, meaning it is not design work at all
//   dismissed  set aside in this Hub — design work, but not for these agents.
//              The weakest of the three: it is a preference about our own
//              tooling, so it loses to both of the facts above it.
function sectionOf(r) {
  if (r.linear_state === 'completed' || r.linear_state === 'canceled') return 'completed';
  if (r.dismissed_at) return 'nodesign';
  if (r.set_aside_at) return 'dismissed';
  return 'board';
}

// True for the rows that make up the board proper — everything that is not
// collapsed away. Counts use this, so dismissing a card drops it out of the
// topbar total and its brand header.
function isOpen(r) {
  return sectionOf(r) === 'board';
}

// ─── GROUPING: WHAT THE SIDEBAR FILTERS ON ─────────
// The reader stopped filtering by team, so every issue assigned to Dave now
// reaches the board — 57 open cards where there were a dozen. Brand stays the
// container the board is built from; the team is how you narrow it.
//
// Team first, and the Linear project only where there is no team. A session an
// agent posted with no Linear issue behind it has neither a team nor a brand,
// and without the fallback it would be reachable only by scrolling. One row
// belongs to exactly one group either way — never both — or the sidebar's
// counts stop adding up to the board's.
var UNGROUPED = 'No team';

function groupOf(r) {
  if (!r) return UNGROUPED;
  return r.team || r.linear_project || UNGROUPED;
}

// The teams whose brand is obvious from the team itself. A card on one of these
// sits in the brand section you would expect it to, so naming its Linear
// project on the card adds nothing.
//
// Anywhere else — Marketing, Websites, Insights — the brand came from a keyword
// in the title or project, or could not be derived at all, and then the project
// is the thing that says what the work actually is. It is also the cue for
// whether "Move to…" is worth reaching for.
//
// Kept in step with TEAM_BRAND in lib/derive.mjs by hand, the same way
// STAGE_LABELS is kept in step with the Worker's copy. There is no build step
// to share them through.
var BRAND_FROM_TEAM = {
  'Conduit App': 'conduit',
  'Ryve App': 'ryve',
  'Psiphon App': 'psiphon',
  'Forge': 'forge',
};

function projectLabel(r) {
  if (!r || !r.linear_project) return '';
  if (BRAND_FROM_TEAM[r.team]) return '';
  return r.linear_project;
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

// When this row last moved, for the console's clock column. `updated_at` is
// touched by the trigger route, by every agent post — and by the Linear
// reader, which is why it is not what the stall clock runs on. See
// `queuedSince`.
function lastActivity(r) {
  return (r && (r.updated_at || r.requested_at)) || '';
}

// How long this request has been outstanding, which is a different question
// from when the row last moved.
//
// `requested_at` is written once, by the trigger route, and cleared in one
// place — /api/agent/stage-done. Nothing else touches it. `updated_at` looked
// like the better field and is not: the reader's upsert sets
// `updated_at = datetime('now')` on every row it refreshes, so a cron read, or
// anyone pressing Read Linear, would reset the stall clock on a run that died
// hours ago and quietly hide it again for another half hour.
function queuedSince(r) {
  return (r && (r.requested_at || r.updated_at)) || '';
}

// ─── THE QUEUE ─────────────────────────────────────
// `requested_stage` says a run was asked for. It does not say the run has
// started, and with runs strictly serialised — GitHub's concurrency group lets
// exactly one happen at a time — most queued cards have not. They all read
// "Working…", so the one actually being worked looked identical to the one
// fourth in line.
//
// The Hub can tell them apart without anything new being sent. The runner
// posts `status: 'active'` as it picks an issue up, and that post moves
// `updated_at`. So a row whose `updated_at` is later than its `requested_at`
// has been started; one where they are still equal has only been asked for.
//
// Comparing the two timestamps rather than trusting `status` alone is what
// makes it safe: a row left `active` by a previous run and then re-triggered
// would otherwise claim to be running the moment you pressed the button.
function isRunning(r) {
  if (!isWorking(r) || !r || r.status !== 'active') return false;
  var at = stampMs(lastActivity(r));
  var asked = stampMs(r.requested_at);
  if (isNaN(at) || isNaN(asked)) return false;
  return at > asked;
}

// Everything waiting on the runner, oldest request first.
//
// Deliberately the same order and the same exclusions as GET /api/agent/queue:
// a position shown on a card has to be the position the runner will actually
// work in, or it is worse than showing nothing.
function queuedRows(rows) {
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (r && isWorking(r) && isOpen(r)) out.push(r);
  }
  out.sort(function (a, b) {
    var ta = stampMs(a.requested_at), tb = stampMs(b.requested_at);
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return ta - tb;
  });
  return out;
}

// Where this card sits in that queue, 1-based. 0 for a card that is not in it.
function queuePosition(r, rows) {
  var q = queuedRows(rows);
  for (var i = 0; i < q.length; i++) {
    if (q[i] === r || (r && q[i].id && q[i].id === r.id)) return i + 1;
  }
  return 0;
}

// 1st, 2nd, 3rd, 4th — and 11th rather than 11st.
function ordinal(n) {
  var suffix = ['th', 'st', 'nd', 'rd'];
  var v = n % 100;
  return n + (suffix[(v - 20) % 10] || suffix[v] || suffix[0]);
}

// What a queued card says instead of "Working…", which was true of at most one
// of them at a time.
function queueLabel(r, rows) {
  if (isRunning(r)) return RUN_STATE_TEXT.working;
  var pos = queuePosition(r, rows);
  var total = queuedRows(rows).length;
  if (!pos) return RUN_STATE_TEXT.working;
  // Alone in the queue and not yet started: "1st of 1" says nothing useful.
  if (total < 2) return 'Queued';
  return ordinal(pos) + ' of ' + total;
}

// Queued, and still queued half an hour later. This is the check that stops an
// eternally-"working" card from hiding a process that died: the queue entry is
// cleared when the stage reports done, so a request still sitting there is a
// request nothing has finished.
//
// A row whose timestamp will not parse is deliberately *not* stalled. Flagging
// on missing data would flag the whole board the first time a column comes
// back null, and a board crying wolf is a board nobody reads.
function isStalled(r, now, rows) {
  if (!isWorking(r)) return false;
  var t = stampMs(queuedSince(r));
  if (isNaN(t)) return false;
  if (((now === undefined ? Date.now() : now) - t) < STALL_AFTER_MIN * 60000) return false;

  // Waiting your turn is not stalling. Runs are serialised, so a queue of four
  // ten-minute runs leaves the last one waiting forty minutes entirely
  // correctly — and flagging that as a dead process is the board crying wolf
  // about its own design.
  //
  // What the flag is actually for is the case where nothing is coming: the
  // runner took its two issues, deferred the rest, and nothing re-dispatched.
  // So a queued card is stalled once it is old AND nothing in the queue is
  // running. The card being worked is judged on its own silence, as before.
  if (rows && !isRunning(r)) {
    var q = queuedRows(rows);
    for (var i = 0; i < q.length; i++) {
      if (isRunning(q[i])) return false;
    }
  }
  return true;
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
function runState(r, now, rows) {
  if (!r) return 'idle';
  if (r.status === 'error') return 'error';
  if (isStalled(r, now, rows)) return 'stalled';
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
function statusPill(r, now, rows) {
  var state = runState(r, now, rows);
  if (state === 'idle') return null;
  // A queued card says where it is in the queue rather than claiming to be
  // working, which was only ever true of one of them at a time.
  if (state === 'working') return { text: queueLabel(r, rows), kind: 'working' };
  return { text: RUN_STATE_TEXT[state], kind: state };
}

// Stop and Reset are one operation — clearing the queue entry — named for what
// it means where you press it. On a run still believed to be going it is Stop;
// on one that has already failed or gone quiet there is nothing left to stop,
// so it is Reset. Everything else gets neither: a button whose whole job is to
// interrupt a run has no business on a card with no run behind it.
//
// What Stop can and cannot do is the runner's half of the contract. It re-reads
// the queue before each issue, so a card called off after a run started is
// skipped rather than worked. It cannot interrupt the issue being worked at
// that moment.
var CLEAR_LABEL = {
  working: 'Stop',
  stalled: 'Reset',
  error: 'Reset',
};

function clearLabel(r, now, rows) {
  return CLEAR_LABEL[runState(r, now, rows)] || '';
}

// Why it stopped, in the agent's own words. The Hub shows no agent prose as a
// rule — the research is a comment on the Linear issue and is read there — and
// this is the second deliberate exception after a gate's options, for the same
// reason they were the first: a card that has stopped and will not say why is
// a card you have to go and look up somewhere else, which is precisely the
// trip the board exists to save.
// Why the last run failed, in words, for the card.
//
// `last_error` first: §4 gives the error its own home precisely so it does not
// have to share the prompt, which is the question put to a human. The prompt is
// still read after it, because that is where every error written before the
// column existed still lives.
function failureReason(r) {
  if (!r || r.status !== 'error') return '';
  return String(r.last_error || r.prompt || r.detail || '').trim();
}

// When it failed. Null when nothing recorded it, which is every error written
// before the column existed — the card says what went wrong without claiming
// to know when.
function failureAt(r) {
  if (!r || r.status !== 'error') return '';
  return (r.last_error_at || '');
}

// A failure as one line, for a card that has no room for a stack trace.
//
// Machine output gets cut at the first line break, because a runner that dumps
// a JSON summary turns the card into a wall of fields — and the first line is
// the part a person can act on. The whole thing is still there in
// `failureReason` for anywhere with room to show it.
function failureSummary(r) {
  var full = failureReason(r);
  if (!full) return '';
  var first = full.split(/\r?\n/)[0].trim();
  return first.length > 200 ? first.slice(0, 197) + '…' : first;
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
    var state = runState(r, t, rows);
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

// What a card's clock counts from, which is not the same question for a run
// that is going as for one that is waiting its turn.
//
// A queued card counts from the press. How long you have been waiting is the
// only thing there is to say about a run that has not started.
//
// A running card counts from when the runner picked it up — its `active` post,
// the last thing to move `updated_at` before the long silence of the Claude
// call. Counting a running card from the press would fold its queue wait into
// its run time and report a two-minute run as forty.
//
// The stall clock deliberately does NOT use this: it stays on `requested_at`
// via queuedSince, because the Linear reader bumps `updated_at` on every row it
// refreshes and a read must not be able to clear a stall. The same bump can
// reset a running card's *displayed* clock, which is cosmetic, rare, and worth
// it for a number that means what it says the rest of the time.
function clockFrom(r) {
  return isRunning(r) ? lastActivity(r) : queuedSince(r);
}

// How long a run has been going, counted in seconds.
//
// The one thing on this board that moves on its own, and it exists because
// nothing else does: the runner posts `active` once before it starts and does
// not post again until it is done or has failed, often many minutes later. So
// the card is otherwise *identical* at second one and at minute nine, and
// "Working…" is a claim with no evidence behind it.
//
// timeAgo is no use here — it says "4m" for everything between four and five
// minutes, which is exactly the stillness being fixed. This counts seconds,
// because the whole point is that it is visibly moving.
function elapsed(ts, now) {
  var t = stampMs(ts);
  if (isNaN(t)) return '';
  var secs = Math.floor(((now === undefined ? Date.now() : now) - t) / 1000);
  if (secs < 0) secs = 0;
  var h = Math.floor(secs / 3600);
  var m = Math.floor((secs % 3600) / 60);
  var s = secs % 60;
  if (h) return h + 'h' + ('0' + m).slice(-2) + 'm';
  return m + 'm' + ('0' + s).slice(-2) + 's';
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

// The same, but a queued line says where in the queue it is rather than
// claiming to be working. Short form, because it is a column: QUEUED 3/4.
function consoleLabel(r, state, rows) {
  if (state !== 'working') return consoleState(state);
  if (isRunning(r)) return RUN_STATE_CONSOLE.working;
  var pos = queuePosition(r, rows);
  var total = queuedRows(rows).length;
  if (!pos || total < 2) return 'QUEUED';
  return 'QUEUED ' + pos + '/' + total;
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

// Whether a press that queues Figma/Mobbin work will actually be picked up —
// the whole reason the heartbeat exists. The local runner checks in every 10
// minutes when it's running at all (see design-ai's Task Scheduler setup), so
// one missed tick is not "gone"; three in a row probably is. A day is the line
// past "probably asleep" and into "this machine has stopped checking in".
var HEARTBEAT_FRESH_MIN = 20;
var HEARTBEAT_STALE_MIN = 24 * 60;

// rows: whatever GET /api/agent/heartbeat returned, any order — sorted here
// rather than trusted, so a caller cannot get "most recent" wrong by handing
// rows in over in the order the network happened to return them.
// The machines you sit at. CI runners are not among them: a GitHub runner is
// not somewhere you can sign in to Figma, and offering it as "where I am
// working" would be offering a choice that cannot be true.
//
// A machine that has never said which it is reads as local, matching the
// Worker — an old runner must not disappear from the board.
function localAgents(rows) {
  return (rows || []).filter(function (r) { return r && r.kind !== 'ci'; });
}

// Which machine you are working from, or null if you have not said. At most
// one row carries it; the Worker clears the others when it sets one.
function workingFrom(rows) {
  var local = localAgents(rows);
  for (var i = 0; i < local.length; i++) {
    if (local[i].selected_at) return local[i];
  }
  return null;
}

// How long ago a machine checked in, and what that means.
function agentFreshness(row, now) {
  var mins = Math.floor(((now === undefined ? Date.now() : now) - stampMs(row.last_seen)) / 60000);
  return {
    minsAgo: mins,
    state: mins <= HEARTBEAT_FRESH_MIN ? 'fresh'
         : mins <= HEARTBEAT_STALE_MIN ? 'stale'
         : 'gone',
  };
}

// The machine the board speaks for.
//
// The one you are working from, if you have said — NOT the freshest. That
// distinction is the whole point: a laptop on a Task Scheduler entry checks in
// every few minutes from wherever it is, so "most recent" is wrong exactly
// when it matters, which is when you are somewhere else.
//
// Falls back to the freshest when nothing is selected, which is the old
// behaviour and is right when there is only one machine.
function heartbeatStatus(rows, now) {
  var local = localAgents(rows);
  if (!local.length) return { state: 'never', row: null, minsAgo: null, chosen: false };

  var chosen = workingFrom(rows);
  var row = chosen || local.slice().sort(function (a, b) {
    return stampMs(b.last_seen) - stampMs(a.last_seen);
  })[0];

  var f = agentFreshness(row, now);
  return { state: f.state, row: row, minsAgo: f.minsAgo, chosen: !!chosen };
}

// Every machine you sit at, as the board lists them: the selected one first,
// then by how recently each checked in. One row per machine, so the list and
// the line above it cannot disagree about which is which.
function agentList(rows, now) {
  var local = localAgents(rows);
  var chosen = workingFrom(rows);
  return local.slice().sort(function (a, b) {
    if (chosen) {
      if (a.machine === chosen.machine) return -1;
      if (b.machine === chosen.machine) return 1;
    }
    return stampMs(b.last_seen) - stampMs(a.last_seen);
  }).map(function (r) {
    var f = agentFreshness(r, now);
    return {
      machine: r.machine,
      capabilities: r.capabilities || [],
      state: f.state,
      minsAgo: f.minsAgo,
      selected: !!(chosen && r.machine === chosen.machine),
    };
  });
}

// Where a queued run will actually be picked up, in one sentence.
//
// There are three answers and they are genuinely different, which is why this
// is derived once here rather than written out at each place that shows it.
function queueDestination(rows, now) {
  var local = localAgents(rows);
  if (!local.length) {
    return { kind: 'none', text: 'no machine has ever connected — local work will not run' };
  }
  var chosen = workingFrom(rows);
  if (!chosen) {
    return { kind: 'any',
             text: 'no machine chosen — work goes to whichever runner asks first' };
  }
  var f = agentFreshness(chosen, now);
  if (f.state === 'fresh') {
    return { kind: 'ok', machine: chosen.machine,
             text: 'work goes to ' + chosen.machine };
  }
  // Chosen, but not answering. The most useful thing the board can say, and
  // the state that would otherwise look like nothing happening at all.
  //
  // The age is formatted from the minutes already derived rather than by
  // calling timeAgo, which reads the real clock and would ignore the `now`
  // every other line here is measured against.
  var age = f.minsAgo < 90 ? f.minsAgo + 'm'
          : f.minsAgo < 60 * 48 ? Math.floor(f.minsAgo / 60) + 'h'
          : Math.floor(f.minsAgo / 1440) + 'd';
  return { kind: 'stale', machine: chosen.machine,
           text: 'work goes to ' + chosen.machine + ', which has not checked in for ' +
                 age + ' — start it, or choose another machine' };
}
