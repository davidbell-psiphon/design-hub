// Pure board logic — no DOM, no fetch, no state.
//
// A classic script rather than a module, so the inline onclick handlers in
// index.html keep resolving against globals and the page keeps its no-build-
// step property. Split out of index.html so these can be tested in node:vm
// with no browser stub at all.

// Sessions the reader could not place in a brand.
var UNASSIGNED = { id: '_unassigned', name: 'Unassigned', color: '#888780' };

// Which of the three per-brand buckets a session belongs in.
// linear_state is null on rows written before the Piece 4 columns existed;
// those read as Queued rather than disappearing.
function bucketOf(r) {
  if (r.triggered_at) return 'inflight';
  if (r.linear_state === 'backlog') return 'backlog';
  return 'queued'; // unstarted (Todo), or no Linear state at all
}

// Waiting AND triggered. The reader writes every new row as 'waiting', so
// status alone would light up every untriggered card as a decision.
function needsDecision(r) {
  return r.status === 'waiting' && !!r.triggered_at;
}

// Research / Design / QA / Waiting on me
function stageLabel(r) {
  if (r.status === 'waiting') return 'Waiting on me';
  if (!r.phase) return '—';
  if (r.phase.toLowerCase() === 'qa') return 'QA';
  return r.phase.charAt(0).toUpperCase() + r.phase.slice(1);
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
