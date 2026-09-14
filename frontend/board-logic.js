// Pure board logic — no DOM, no fetch, no state.
//
// A classic script rather than a module, so the inline onclick handlers in
// index.html keep resolving against globals and the page keeps its no-build-
// step property. Split out of index.html so these can be tested in node:vm
// with no browser stub at all.

// Sessions the reader could not place in a brand.
var UNASSIGNED = { id: '_unassigned', name: 'Unassigned', color: '#888780' };

// The three labels the system writes when a stage completes. Dave never
// applies one and nothing triggers off them — they are the record of what has
// been done, and the board reads them to decide which column a card is in.
var STAGE_LABELS = {
  research: 'AI-research done',
  design: 'AI-design done',
  qa: 'AI-QA done',
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

// Answered, by naming one of the options. Stays true after the agent carries
// on working, because a decision you can no longer see is a decision you can
// no longer take back.
function isGateAnswered(r) {
  return !!(r && r.response_option_id && optionsOf(r).length);
}

// What was chosen, in words. The board never shows the bare id — "d2" says
// nothing about what was decided. Falls back to the label the Hub resolved
// server-side, and then to the id itself, so an option that has since been
// dropped still renders as something rather than as an empty space.
function chosenLabel(r) {
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
// one needs no design". Nothing skips QA, which is why `qa` has no entry.
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
    { stage: 'qa', of: 'qa' },
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
  if (stage === 'qa') return "QA'd";
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
  if (stage === 'qa') return null;
  if (stage === 'designed') return { stage: 'qa', label: 'Run QA' };
  if (stage === 'researched') return { stage: 'design', label: 'Run Design' };
  return { stage: 'research', label: 'Run Research' };
}

// The pill on the right of the card. Only two states are worth a pill —
// something is running, or the last run failed. Anything else is just the
// stage, which the card already shows, so it renders no pill at all.
function statusPill(r) {
  if (isWorking(r)) return { text: 'Working…', kind: 'working' };
  if (r && r.status === 'error') return { text: 'Error', kind: 'error' };
  return null;
}

// Element ids are derived from session ids, which contain '/' and '-'.
// btoa would throw on any non-Latin1 character — issue titles already contain
// em dashes — so hash to hex instead.
function key(id) {
  var h = 0;
  for (var i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function timeAgo(ts) {
  if (!ts) return '';
  var then = new Date(ts.replace(' ', 'T') + 'Z');
  var mins = Math.floor((Date.now() - then) / 60000);
  if (isNaN(mins)) return '';
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  return Math.floor(hrs / 24) + 'd';
}
