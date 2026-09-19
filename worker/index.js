import { deriveBrand, deriveTrack, TEAM_TRACK } from '../lib/derive.mjs';
import { accessIdentity } from '../lib/access.mjs';
import { linearKeyFromSessionId, stageFromSessionId } from '../lib/session-id.mjs';
import { diagnose } from '../lib/diagnostics.mjs';
// The gate lives in lib/gate.mjs so the Worker and lib/card.mjs read one
// decision the same way. `withGate` is not imported here on purpose: reading a
// row into the board's shape is the projection's job, and a second reading in
// this file is the §5 drift the split exists to end.
import { parseOptions, normaliseOptions, sameOptions } from '../lib/gate.mjs';
import { toWire, activeSession } from '../lib/card.mjs';

// Allowed origins - your Pages deployments
const ALLOWED_ORIGINS = [
    'https://design-hub-7y2.pages.dev',
    'https://design-hub-git.pages.dev',
    'http://localhost:8788',
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ||
   /^https:\/\/[a-z0-9]+\.design-hub-(7y2|git)\.pages\.dev$/.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Secret',
    'Vary': 'Origin',
  };
}

let _req = null;
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(_req), 'Content-Type': 'application/json', ...extra },
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

// ─── GATES ─────────────────────────────────────────
// Moved to lib/gate.mjs, imported above. It is read by the projection in
// lib/card.mjs as well as by the routes here, and two readings of one
// decision is the §5 drift this whole document is about.

// Close the round a session is on: the decision goes to gate_decisions, the
// round number moves on, and the session's own answer fields clear. Two paths
// arrive here — the reopen route, and an agent posting a different set of
// options — because they are the same event. The question changed, and the
// previous answer must neither survive onto the new one nor disappear.
// Returns the new round number. The caller owns `status`.
async function closeRound(env, key, stage, row, note) {
  const round = row.gate_round || 1;
  const decided = row.response_option_id || row.response || row.response_note;
  if (decided || note) {
    // The reopen note is the last thing said about the round that is ending,
    // so it is kept with that round. The contract clears the session's own
    // note on reopen and there is no column for a reopen reason, so this row
    // is the only place it survives.
    const trail = [row.response_note, note ? 'Reopened: ' + note : null]
      .filter(Boolean).join('\n\n') || null;
    // `session_id` holds the issue key and `stage` says which session on it.
    // History is per (issue, stage) because a gate is (§2), and a design
    // round archived against the issue alone would sit in research's history
    // as soon as there were two.
    await env.DB.prepare(
      `INSERT INTO gate_decisions
         (session_id, stage, gate_round, options_snapshot, response_option_id,
          response_note)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(key, stage, round, row.options || null,
           row.response_option_id || null, trail).run();
  }
  await env.DB.prepare(
    `UPDATE stage_sessions
        SET gate_round = COALESCE(gate_round, 1) + 1,
            response = NULL, response_option_id = NULL, response_note = NULL,
            responded_at = NULL, updated_at = datetime('now')
      WHERE issue_key = ? AND stage = ?`
  ).bind(key, stage).run();
  return round + 1;
}

// The stages the Hub can request, and the label the system writes when one
// completes. Dave never applies these labels and nothing triggers off them —
// they are the record of what has been done, and the board reads them to
// decide which column a card is in.
//
// There was a third, . Nothing implemented it: the board offered a Run QA
// button, the trigger route accepted the stage, the runner failed with "the qa
// stage is not implemented yet", and the card was left holding a queue entry
// that only /api/agent/stage-done ever clears — so it read as working on QA
// for as long as it sat there. A stage the Hub will queue is a stage something
// has to run, so it is out of this list until something does. Requesting it
// now answers 400, which is the honest response and the one the board can show.
const STAGES = ['research', 'design'];
const STAGE_LABEL = {
  research: 'AI-research done',
  design: 'AI-design done',
};

// §12's other half. `AI-… done` is the record that a stage RAN; these are the
// record that one was deliberately passed over, and the difference is the
// whole of §3: absence means "not yet" and nothing else, so a stage nobody is
// going to run needs something written or the card sits in Backlog for ever.
//
// Skipping design is what the No design control already writes, which is why
// this table and that route name the same label. One fact, one label — the
// route is a different door into it, not a second meaning.
const SKIP_LABEL = {
  research: 'no-research',
  design: 'no-design',
};

// Where the runner lives. Overridable by env vars so a fork or a rename does
// not need a code change, but the defaults are the real thing.
const RUNNER_REPO = 'davidbell-psiphon/design-ai';
const RUNNER_WORKFLOW = 'design-ai.yml';
const RUNNER_REF = 'main';

// The most issues one dispatch may ask the runner to take. The runner's own
// spend guard is per issue — `--max-budget-usd`, $5 by default — so this is
// what bounds a run's total cost, and a queue that somehow grew to fifty
// cannot turn one button press into fifty research calls. Override with
// RUNNER_MAX_ISSUES on the Worker rather than editing this.
const RUNNER_MAX_ISSUES = 10;


export default {
  async fetch(request, env) {
    _req = request;
    try {
      return await route(request, env);
    } catch (e) {
      return err('Server error: ' + (e && e.message ? e.message : String(e)), 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(readLinear(env));
  },
};

// ─── ONE CARD PER LINEAR ISSUE (§2) ────────────────
// Two writers share this database and used to disagree about the primary key.
// The reader keyed rows `linear/RYV-84`; the agent posts `ryve/ryv-84/research`.
// Neither collided with the other, so one Linear issue grew two rows and
// triggering research added a sibling instead of moving the card.
//
// piece6 merged the duplicates and remembered the agent's id in a bridging
// column. §2 is explicit that the bridge is the bug rather than the fix: "A
// bridge implies two identities, and two identities is how one issue becomes
// two cards."
//
// So `cards.issue_key` IS the primary key. There is nothing to reconcile and
// nothing to look up in: a second card for one issue cannot be written. What
// used to be three cooperating lookups and an alias column is now one parse
// and one primary-key read.
//
// The agent's contract is untouched. It posts whatever id it likes and the key
// is read back out of it here — parsing an id is a different thing from
// storing a second one.

// Which row an id names. The Linear issue key parsed out of it, or — for a
// session with no Linear issue behind it — the id exactly as given, which is
// the key such a row was stored under in the first place.
//
// Null when nothing matches, so a route's own "not found" check is what
// answers rather than a different error here.
async function resolveKey(env, idOrSegment) {
  const asked = decodeURIComponent(String(idOrSegment || ''));
  if (!asked) return null;
  const key = linearKeyFromSessionId(asked) || asked;
  const row = await env.DB.prepare(
    `SELECT issue_key FROM cards WHERE issue_key = ?`
  ).bind(key).first();
  return row ? row.issue_key : null;
}

// The key a body or a path is *about*, whether or not a row exists yet. Used
// by the writes, which have to be able to create the row they are naming.
function keyFor(idOrSegment) {
  const asked = decodeURIComponent(String(idOrSegment || ''));
  return linearKeyFromSessionId(asked) || asked || null;
}

// The stage a session id names, defaulting to the Hub's first stage.
//
// The Hub does not police this: `stage` is unconstrained in the schema on
// purpose (CLAUDE.md — the Hub stays generic and does not own another agent
// system's vocabulary). The trigger route is where 'research' and 'design' are
// required, because that is the Hub deciding what it will queue.
function stageFor(sessionId, explicit) {
  const given = explicit === undefined || explicit === null ? '' : String(explicit).trim();
  if (given) return given;
  return stageFromSessionId(sessionId) || STAGES[0];
}

// A card and every session on it, as the board reads it (lib/card.mjs).
// Computed per request and never stored — a stored flattening would be a third
// copy of two facts, which is how §11's bugs started.
async function cardWire(env, key) {
  const card = await env.DB.prepare(
    `SELECT * FROM cards WHERE issue_key = ?`
  ).bind(key).first();
  if (!card) return null;
  const { results } = await env.DB.prepare(
    `SELECT * FROM stage_sessions WHERE issue_key = ? ORDER BY stage`
  ).bind(key).all();
  return toWire(card, results || []);
}

// Make sure a card row exists for a key, without disturbing one that does.
// The agent can post about an issue the reader has not discovered yet, and
// that must not be an error — the next reader pass fills in everything Linear
// owns.
async function ensureCard(env, key) {
  await env.DB.prepare(
    `INSERT INTO cards (issue_key) VALUES (?) ON CONFLICT(issue_key) DO NOTHING`
  ).bind(key).run();
  return key;
}

// One session row, created on first write. §3's "Not started" is the absence
// of one of these, so nothing creates them speculatively.
async function ensureSession(env, key, stage) {
  await env.DB.prepare(
    `INSERT INTO stage_sessions (issue_key, stage) VALUES (?, ?)
     ON CONFLICT(issue_key, stage) DO NOTHING`
  ).bind(key, stage).run();
}

// ─── WHICH MACHINE YOU ARE AT ──────────────────────
// The Hub cannot tell. It never reaches out to anything — runners poll it —
// and a browser cannot read its own hostname. So the machine says so, either
// by running design-local.bat (which means you are sitting at it) or by you
// picking it on the board.
//
// Exactly one machine holds the selection, which is why this clears the others
// in the same breath as setting one. Two selected machines is not a state
// anything downstream knows how to read.
// The try/catch on each of these is for the window between deploying this
// Worker and applying piece12 — no columns, no selection, and the board
// behaves exactly as it did before the feature existed. Same reasoning as
// readerTeams: a configuration question is not worth a 500 on the route the
// runner depends on for all of its work.
//
// Delete the fallbacks once piece12 is applied everywhere. They are marked so
// they can be found.
async function selectMachine(env, machine) {
  try {
    await env.DB.prepare(
      `UPDATE agent_heartbeats SET selected_at = NULL
        WHERE selected_at IS NOT NULL AND machine <> ?`
    ).bind(machine).run();
    await env.DB.prepare(
      `UPDATE agent_heartbeats
          SET selected_at = COALESCE(selected_at, datetime('now'))
        WHERE machine = ?`
    ).bind(machine).run();
    return true;
  } catch (e) {
    return false;   // pre-piece12: nothing to select, and nothing reads it
  }
}

// The machine you are working from, or null when you have not said — which is
// also the answer before piece12, and it is the right one: no selection means
// the queue is not filtered, which is the behaviour that was there before.
async function workingFrom(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT machine FROM agent_heartbeats
        WHERE selected_at IS NOT NULL
        ORDER BY selected_at DESC LIMIT 1`
    ).first();
    return row ? row.machine : null;
  } catch (e) {
    return null;
  }
}

// Every session on a card, oldest stage first.
async function sessionsFor(env, key) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM stage_sessions WHERE issue_key = ? ORDER BY stage`
  ).bind(key).all();
  return results || [];
}

// Which session a request is about: `{ key, stage, session }`, or null.
//
// A card can hold one session per stage now, and two kinds of caller address
// them differently. The agent names the stage in its session id —
// `ryve/ryv-84/design` — and means that one. The board sends the card's id and
// means *the gate it is currently showing you*, because that is the only gate
// it drew.
//
// So an explicit stage wins, and otherwise this picks the same session
// `lib/card.mjs` flattened onto the card. Deliberately the same function: the
// board answering a different gate from the one it rendered is §5's drift with
// the stakes of §8.
async function resolveSession(env, segment) {
  const asked = decodeURIComponent(String(segment || ''));
  const key = await resolveKey(env, asked);
  if (!key) return null;

  const all = await sessionsFor(env, key);
  const named = stageFromSessionId(asked);
  if (named) {
    const hit = all.find((s) => s.stage === named);
    return { key, stage: named, session: hit || null };
  }
  const active = activeSession(all);
  return { key, stage: active ? active.stage : null, session: active };
}

// ─── WHERE ISSUES ARE READ FROM ────────────────────
// The team filter used to be a constant in this file, so changing it meant a
// deploy. It is a table now (piece9-schema.sql) and the board edits it.
//
// **Empty means every team.** That is not a fallback, it is the setting: the
// reader with no configured teams behaves exactly as it does today, so applying
// the schema changes nothing until someone chooses.
//
// The try/catch is for the window between deploying this and applying piece9 —
// no table, no configuration, read everything. A configuration question is not
// worth a 500 on the cron.
async function readerTeams(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT name FROM reader_teams ORDER BY name`
    ).all();
    return (results || []).map((r) => r.name).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// Every team in the workspace, so the board can offer one that has no issue
// assigned to Dave yet. Falls back to the teams the Hub has actually seen: a
// Linear outage should narrow the list rather than empty the screen.
const READER_TEAMS_QUERY = `query ReaderTeams { teams(first: 100) { nodes { name } } }`;

async function availableTeams(env) {
  try {
    const data = await linearGraphQL(env, READER_TEAMS_QUERY, {});
    const nodes = (data && data.data && data.data.teams && data.data.teams.nodes) || [];
    const names = nodes.map((t) => t && t.name).filter(Boolean);
    if (names.length) return { teams: names.sort(), from: 'linear' };
  } catch (e) { /* fall through to what we have seen */ }

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT team AS name FROM cards WHERE team IS NOT NULL ORDER BY team`
  ).all();
  return { teams: (results || []).map((r) => r.name).filter(Boolean), from: 'seen' };
}

// ─── LINEAR READER ─────────────────────────────────
// Pulls every issue assigned to Dave Bell, across all teams, in any open
// state. No label filter — gathering is not triggering.
// Writes one `cards` row per issue. No session is created — §3's
// "Not started" is the absence of one, and discovery is not a stage running.
// Idempotent: skips issues whose linear_id already has a row.
//
async function readLinear(env) {
  // Configured teams narrow the query itself rather than the rows it returns.
  // Filtering after the fact would let teams nobody reads eat the first: 100
  // budget, which is the same trap the two-pass reader exists to avoid.
  const teams = await readerTeams(env);
  const teamFilter = teams.length
    ? `\n          team: { name: { in: [${teams.map((t) => JSON.stringify(t)).join(', ')}] } }`
    : '';

  const query = `
    query DesignReaderIssues {
      issues(
        first: 100
        filter: {
          assignee: { name: { eq: "Dave Bell" } }
          # Every open state. It was ["backlog", "unstarted"], which meant an
          # issue you had actually started was invisible here unless the board
          # happened to read it before you moved it — nine of them were.
          #
          # This does not touch the budget invariant, which is about closed
          # issues: there are ~66 of those against ~60 open, so letting them in
          # would blow the first: 100 and starve the board of real work. Open
          # work is the work the board is for, and all of it fits.
          state: { type: { in: ["triage", "backlog", "unstarted", "started"] } }${teamFilter}
        }
      ) {
        nodes {
          id
          identifier
          title
          description
          url
          assignee { name }
          project { name }
          labels { nodes { name } }
          team { name }
          state { type }
        }
      }
    }`;

  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      // Linear uses a raw API key with NO "Bearer" prefix.
      'Authorization': env.LINEAR_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    return { error: 'Linear request failed', status: res.status };
  }

  const data = await res.json();
  if (data.errors) {
    return { error: 'Linear GraphQL error', detail: data.errors };
  }

  const nodes = (data.data && data.data.issues && data.data.issues.nodes) || [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const issue of nodes) {
    // Assigned to Dave Bell only — not subscribers. Matches "assigned to me".
    const assignee = issue.assignee && issue.assignee.name;
    if (assignee !== 'Dave Bell') { skipped++; continue; }

    const teamName = issue.team && issue.team.name;

        // No team filter. Anything assigned to Dave Bell belongs in the Hub,
          // whatever team it sits on. Brand is derived from the issue by
          // deriveBrand (team map first, then keyword fallback on project name,
          // labels and title), and the board's brand filter is what provides the
          // context of where the work lives — so a project's team no longer gates
          // whether it reaches the board.
    const track = deriveTrack(teamName);
    const brand = deriveBrand(issue);

    const detail = (issue.description || '').slice(0, 300) || null;
    // The board reads these to decide the card's column, so the stage lives in
    // Linear and cannot drift away from it.
    const labelNames = JSON.stringify(
      ((issue.labels && issue.labels.nodes) || []).map((l) => l.name));
    // 'triage' | 'backlog' | 'unstarted' | 'started' from discovery; the
    // reconciliation pass is what later writes 'completed' or 'canceled'.
    const linearState = issue.state && issue.state.type;
    // The Linear project's name, for the sidebar's fallback grouping and for
    // the card to show where its brand section is not self-evident. It is the
    // Linear project, which is a different thing from the brand — the two used
    // to be `linear_project` and `project`, where `project` meant the brand and
    // needed a comment to say so every time. The brand column is called `brand`
    // now (piece11).
    const linearProject = (issue.project && issue.project.name) || null;
    // An issue can arrive already labelled no-design, dismissed in Linear
    // before the Hub ever saw it.
    const dismissedAt = hasNoDesign(issue) ? nowStamp() : null;

    // Whether this is a card the Hub already has, for the counters. The key is
    // the primary key (§2), so this is a primary-key read and nothing more —
    // no reconciliation, no alias, no second convention to check.
    const existing = await env.DB.prepare(
      `SELECT issue_key FROM cards WHERE issue_key = ?`
    ).bind(issue.identifier).first();

    // Upsert rather than skip. Rows written before the Piece 4 columns existed
    // have no linear_uuid, and without it the trigger button has nothing to
    // apply a label to. Refreshing on every read also keeps linear_state
    // current, which is what sorts a card into Queued vs Backlog.
    //
    // ── The §5 pair, and it is the whole shape of this statement ──
    //
    // Every Linear-owned column is REPLACED. Not COALESCEd: a cache that
    // merges can disagree with its source for ever, and at that point it is
    // not a cache, it is a second home for a fact Linear owns.
    //
    // Every Hub-owned column is absent from the DO UPDATE entirely. Not
    // "preserved carefully" — simply not mentioned, so there is no version of
    // this statement that touches your brand correction, your Figma override
    // or your dismissal. The columns are in different halves of the table now
    // (piece11) and the two halves are written by different code.
    //
    // `description` holds the Linear description and only ever that. It used
    // to share a column with the agent's own context and needed a guard to
    // stop a Wednesday read wiping it; the agent's context lives on the
    // session now, so the guard is gone and cannot be got wrong.
    //
    // No session is created here. §3's "Not started" is the absence of one,
    // and the reader discovering an issue is not a stage having run.
    await env.DB.prepare(
      `INSERT INTO cards
         (issue_key, linear_uuid, title, description, url, team, linear_state,
          labels, linear_project, linear_read_at, brand, track, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
       ON CONFLICT(issue_key) DO UPDATE SET
         -- Linear owns these outright. Replaced, every read.
         linear_uuid    = excluded.linear_uuid,
         title          = excluded.title,
         description    = excluded.description,
         url            = excluded.url,
         team           = excluded.team,
         linear_state   = excluded.linear_state,
         labels         = excluded.labels,
         linear_project = excluded.linear_project,
         linear_read_at = excluded.linear_read_at,
         -- Derived from the team, and only filled in while still empty, so a
         -- manual reassignment survives. These two are the Hub's, not Linear's.
         brand          = COALESCE(cards.brand, excluded.brand),
         track          = COALESCE(cards.track, excluded.track),
         -- COALESCE, so a read can only ever ADD a dismissal, never clear one.
         -- A dismissed card cannot be resurrected onto the board by the cron
         -- if the label mutation has not propagated yet. Un-dismissing is the
         -- Hub's Undo control, which removes the label first.
         dismissed_at   = COALESCE(cards.dismissed_at, excluded.dismissed_at),
         updated_at     = datetime('now')`
    ).bind(
      issue.identifier,
      issue.id,
      issue.title,
      detail,
      issue.url,
      teamName,
      linearState || null,
      labelNames,
      linearProject,
      brand,
      track,
      dismissedAt
    ).run();
    if (existing) { updated++; } else { inserted++; }
  }

  const reconciled = await reconcileTracked(env);
  return { inserted, updated, skipped, reconciled, teams: teams.length ? teams : 'all' };
}

// ─── RECONCILIATION PASS ───────────────────────────
// The discovery query above asks only for backlog and unstarted issues. It
// cannot ask for completed and canceled too: `first: 100` is a fixed budget,
// and closed issues would eat it, silently starving the board of real work.
//
// So this second pass looks up only the issues already tracked, by their
// Linear ids. Bounded by the number of rows we hold, update-only, never
// inserts. That gives Completed the right meaning — work that passed through
// this board and is now closed, not every issue ever finished — and it also
// picks up labels applied directly in Linear.
async function reconcileTracked(env) {
  const { results } = await env.DB.prepare(
    `SELECT issue_key, linear_uuid FROM cards WHERE linear_uuid IS NOT NULL`
  ).all();
  const rows = results || [];
  if (!rows.length) return 0;

  const byUuid = new Map(rows.map(r => [r.linear_uuid, r.issue_key]));
  const q = `query Reconcile($ids: [ID!]) {
    issues(first: 250, filter: { id: { in: $ids } }) {
      nodes { id state { type } labels { nodes { name } } }
    }
  }`;
  const r = await linearGraphQL(env, q, { ids: [...byUuid.keys()] });
  if (r.error) return 0;

  const nodes = (r.data && r.data.issues && r.data.issues.nodes) || [];
  let changed = 0;
  for (const issue of nodes) {
    const id = byUuid.get(issue.id);
    if (!id) continue;
    const state = issue.state && issue.state.type;
    const dismissedAt = hasNoDesign(issue) ? nowStamp() : null;
    await env.DB.prepare(
      `UPDATE cards
       SET linear_state = COALESCE(?, linear_state),
           dismissed_at = COALESCE(dismissed_at, ?),
           linear_read_at = datetime('now'),
           updated_at = datetime('now')
       WHERE issue_key = ?`
    ).bind(state || null, dismissedAt, id).run();
    changed++;
  }
  return changed;
}

// Does the issue carry the no-design label?
function hasNoDesign(issue) {
  const labels = (issue.labels && issue.labels.nodes) || [];
  return labels.some(l => l.name === 'no-design');
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ─── LINEAR LABEL TRIGGER ──────────────────────────
// The Hub's entire "start work" mechanism: apply a label to the Linear
// issue. The agent on the other end watches for that label; the Hub never
// starts work itself.
async function linearGraphQL(env, query, variables) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Authorization': env.LINEAR_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) return { error: data.errors || `HTTP ${res.status}` };
  return { data: data.data };
}

async function getLabelId(env, name) {
  const q = `query($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id } } }`;
  const r = await linearGraphQL(env, q, { name });
  if (r.error) return null;
  const nodes = r.data && r.data.issueLabels && r.data.issueLabels.nodes;
  return nodes && nodes[0] ? nodes[0].id : null;
}

async function addLabelToIssue(env, issueId, labelId) {
  const m = `mutation($issueId: String!, $labelId: String!) {
    issueAddLabel(id: $issueId, labelId: $labelId) { success }
  }`;
  return linearGraphQL(env, m, { issueId, labelId });
}

// ─── STARTING THE RUNNER ──────────────────────────────
// Pressing a stage button queues the work. Something still has to come along
// and do it, and this is what tells it to: a workflow_dispatch on the runner's
// GitHub Actions workflow, fired the moment the queue row is written.
//
// It is deliberately advisory. The queue row is the durable record of the
// request and is written first; this only decides whether the work starts in
// seconds or waits for someone to start a run by hand. So every failure here
// is reported and none of them fail the button press — a press that queued the
// work but could not start it is still a press that was recorded.
//
// With no GITHUB_TOKEN set the Hub behaves exactly as it did before: it queues,
// and says plainly that nothing was started.
async function startRunner(env, queued) {
  if (!env.GITHUB_TOKEN) {
    return { started: false, reason: 'no GITHUB_TOKEN set on the Hub — the request was queued but nothing was started' };
  }

  const repo = env.RUNNER_REPO || RUNNER_REPO;
  const workflow = env.RUNNER_WORKFLOW || RUNNER_WORKFLOW;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;

  // One input, and it is the fix for a real stranding.
  //
  // This used to pass no inputs at all, on the belief that "the runner drains
  // the queue itself, so a press also picks up anything else already sitting
  // there". It does not. The runner's workflow declares max_issues with a
  // default of '2', and GitHub applies that default to an API dispatch that
  // names no inputs; the runner then logs DEFERRED reason=max-issues=2 for
  // everything past the second — and a *blocked* issue burns one of the two
  // slots just as a successful one does. Nothing re-dispatches, so the rest sit
  // in the queue until the next button press, which takes two more.
  //
  // Four issues sat like that for a day. Passing the queue depth is what makes
  // the sentence above true: a press picks up everything that is waiting.
  //
  // Still passing no *issue*, which was the right half of that decision — the
  // runner chooses what to work on by reading the queue, and naming one here
  // would strand the others.
  const max = Math.min(
    Math.max(1, Number(queued) || 1),
    Math.max(1, Number(env.RUNNER_MAX_ISSUES) || RUNNER_MAX_ISSUES)
  );

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub rejects an API call with no User-Agent.
        'User-Agent': 'design-hub-worker',
        'Content-Type': 'application/json',
      },
      // max_issues is declared `type: string` on the workflow, so it is sent
      // as one — GitHub rejects a number against a string input.
      body: JSON.stringify({
        ref: env.RUNNER_REF || RUNNER_REF,
        inputs: { max_issues: String(max) },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { started: false, reason: `could not reach GitHub — ${e.name === 'TimeoutError' ? 'no response in 10s' : e.message}` };
  }

  // A dispatch that works answers 204 with an empty body.
  if (res.status === 204) return { started: true };

  const body = (await res.text()).slice(0, 300);
  const hint = res.status === 401 || res.status === 403
    ? 'GITHUB_TOKEN is wrong, expired, or lacks Actions: read and write on the runner repo'
    : res.status === 404
      ? `no workflow ${workflow} on ${RUNNER_REF} in ${repo} — or the token cannot see the repo`
      : `GitHub returned HTTP ${res.status}`;
  return { started: false, reason: `${hint}. ${body}`.trim() };
}

// ─── ACCESS IDENTITY ──────────────────────────────────
// Verification lives in lib/access.mjs so it can be tested against tokens
// signed in the test itself. Enforcement stays off until ACCESS_AUD and
// ACCESS_TEAM are set as secrets.

// Gate for everything the board calls. Returns an error Response to send, or
// null to continue.
async function requireHuman(request, env) {
  // Not configured yet — run open, exactly as before Access existed.
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM) return null;

  if (await accessIdentity(request, env)) return null;

  // The agent reaches these routes with the shared secret rather than a
  // browser session; a service token on the Access app covers the hop before
  // this one.
  const secret = request.headers.get('X-Agent-Secret');
  if (env.AGENT_SECRET && secret && secret === env.AGENT_SECRET) return null;

  return err('Forbidden — no valid Access identity', 403);
}

// ─── MARKING AN ISSUE DONE ────────────────────────────
// Every team names its finished state differently — Done, Design Done, Posted,
// Shipped — so the name is exactly the wrong thing to match on. Linear gives
// every workflow state a `type`, and `completed` is the one that renders with
// the checkmark. That is the thing that is the same everywhere.
//
// Where a team has more than one completed state, the earliest by position
// wins: Linear orders a team's states left to right, and the first completed
// one is the state its board's first checkmark column maps onto.
const ISSUE_STATES_QUERY = `
query IssueStates($id: String!) {
  issue(id: $id) {
    id
    state { id name type }
    team { id name states(first: 50) { nodes { id name type position } } }
  }
}`;

const COMPLETE_MUTATION = `
mutation Complete($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`;

async function completedStateFor(env, issueId) {
  const data = await linearGraphQL(env, ISSUE_STATES_QUERY, { id: String(issueId) });
  if (data.errors) return { error: data.errors };
  const issue = data.data && data.data.issue;
  if (!issue) return { error: 'no such issue in Linear' };
  // Already finished. Nothing to write, and saying so is more useful than
  // reporting a mutation that changed nothing.
  if (issue.state && issue.state.type === 'completed') {
    return { already: true, state: issue.state };
  }
  const done = ((issue.team && issue.team.states && issue.team.states.nodes) || [])
    .filter((st) => st && st.type === 'completed')
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  if (!done.length) {
    return { error: `team "${(issue.team && issue.team.name) || '?'}" has no completed state` };
  }
  return { state: done[0] };
}

async function removeLabelFromIssue(env, issueId, labelId) {
  const m = `mutation($issueId: String!, $labelId: String!) {
    issueRemoveLabel(id: $issueId, labelId: $labelId) { success }
  }`;
  return linearGraphQL(env, m, { issueId, labelId });
}

// Brand rows as they were stored before piece10-schema.sql: in `projects`,
// found by a section id. Only reached while `brands` is empty, and returns
// nothing rather than throwing if the old table has gone — a board with no
// brand buckets is recoverable, a 500 on its only structural read is not.
async function legacyBrands(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, color FROM projects WHERE section_id = 'brands' ORDER BY sort_order`
    ).all();
    return results || [];
  } catch (e) {
    return [];
  }
}

async function route(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // POST /api/agent/session checks X-Agent-Secret itself; everything else
    // needs an Access identity once Access is configured. This is what closes
    // the trigger, reassign and respond routes.
    if (!(method === 'POST' && path === '/api/agent/session')) {
      const denied = await requireHuman(request, env);
      if (denied) return denied;
    }

    // ─── AGENT SESSION API ─────────────────────────────
    // Generic across systems. The Hub never interprets prompt content.

    // POST /api/agent/session — the agent publishes what it is doing.
    //
    // One session, identified by (issue_key, stage) — §2. Both are read out of
    // the session id the agent posts, so its contract is unchanged: it still
    // sends `ryve/ryv-84/design` and that still means "the design stage of
    // RYV-84". The brand segment is read for nothing but a default, because
    // brand is a Linear fact derived from the team and the Hub does not take
    // the agent's word for it.
    if (method === 'POST' && path === '/api/agent/session') {
      const secret = request.headers.get('X-Agent-Secret');
      if (!env.AGENT_SECRET || secret !== env.AGENT_SECRET) return err('Forbidden', 403);
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!b.session_id || !b.system) return err('session_id and system required');
      const status = b.status || 'active';
      if (!['active','waiting','done','error'].includes(status)) return err('invalid status');

      // Accepts both the original field names (project/phase/url) and the
      // integration-surface names (brand/stage/figma_url) — same columns.
      const brand = b.project || b.brand || null;
      const track = b.track || null;
      const url = b.url || null;
      const title = b.title || null;

      const key = String(b.linear_id || '').toUpperCase() || keyFor(b.session_id);
      if (!key) return err('session_id names nothing to file this under');
      const stage = stageFor(b.session_id, b.phase || b.stage);

      // The gate's options, when this post carries them. A post without
      // `options` leaves whatever is stored alone: the agent posts its gate
      // once and then keeps posting its state as it works, and none of those
      // later posts may erase the question Dave is looking at.
      let options = null;
      if (b.options !== undefined && b.options !== null) {
        const parsed = normaliseOptions(b.options);
        if (typeof parsed === 'string') return err(parsed);
        options = JSON.stringify(parsed);
      }

      // The card first. An agent may post about an issue the reader has not
      // discovered yet, and that must not be an error — everything Linear owns
      // is filled in by the next read.
      await ensureCard(env, key);
      await ensureSession(env, key, stage);

      // A different set of options supersedes a decision that has already been
      // made, so that decision is archived and cleared rather than left sitting
      // on the new question: a round-1 `d1` answering a round-2 gate is the
      // "Yes" bug wearing an id.
      //
      // Two things deliberately do not move the round on. The same set
      // re-posted is the agent repeating its state as it works, and must not
      // wipe an answer given a second earlier. A new set replacing a gate
      // nobody has answered yet is just the question being rewritten — there is
      // no decision to supersede, and no round to archive.
      const prev = await env.DB.prepare(
        `SELECT issue_key, stage, options, gate_round, response,
                response_option_id, response_note
           FROM stage_sessions WHERE issue_key = ? AND stage = ?`
      ).bind(key, stage).first();
      if (options && prev && (prev.response_option_id || prev.response) &&
          !sameOptions(parseOptions(prev.options), parseOptions(options))) {
        await closeRound(env, key, stage, prev, null);
      }

      // Everything on this statement is the agent's to write, because the
      // session table holds nothing else. There is no CASE guarding a
      // Linear-owned column, and no guard stopping a cron read wiping the
      // agent's detail, because none of those columns are here any more.
      // §4: "The last error is kept and shown on the card — message, stage,
      // and when. An error that exists only in a terminal you have closed is
      // not an error state, it is a mystery."
      //
      // It is its own column rather than the prompt, because the prompt is the
      // question put to a human and an error is not one — that is the same
      // "one signal, one meaning" the whole document is about. An agent that
      // sends no `last_error` and reports `error` still gets something stored,
      // because a card that says it failed and cannot say how is the mystery
      // §4 names.
      //
      // Cleared on any status that is not an error: a run that has started
      // again is not still carrying the last one.
      const failed = status === 'error';
      const lastError = failed
        ? String(b.last_error || b.prompt || 'the run reported an error and said nothing more')
            .slice(0, 4000)
        : null;

      await env.DB.prepare(
        `UPDATE stage_sessions SET
           system          = ?,
           status          = ?,
           prompt          = ?,
           detail          = COALESCE(?, detail),
           options         = COALESCE(?, options),
           last_error      = ?,
           last_error_at   = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
           agent_posted_at = COALESCE(agent_posted_at, datetime('now')),
           updated_at      = datetime('now')
         WHERE issue_key = ? AND stage = ?`
      ).bind(
        b.system, status, b.prompt || null, b.detail || null, options,
        lastError, lastError, key, stage
      ).run();

      // The three Linear-owned fields an agent may still send are only ever
      // filled in where the card has nothing, so a post cannot rename a card,
      // relink it, or undo a manual brand reassignment. `figma_url` is yours
      // rather than Linear's, and the same rule is the safe one: an agent that
      // found a file does not get to overwrite a destination you chose.
      await env.DB.prepare(
        `UPDATE cards SET
           brand     = COALESCE(brand, ?),
           track     = COALESCE(track, ?),
           url       = COALESCE(url, ?),
           title     = COALESCE(title, ?),
           figma_url = COALESCE(figma_url, ?),
           updated_at = datetime('now')
         WHERE issue_key = ?`
      ).bind(brand, track, url, title, b.figma_url || null, key).run();

      return json({ ok: true, session_id: b.session_id, issue_key: key,
                    stage, status });
    }

    // GET /api/agent/session/:id — agent polls for the human's response
    if (method === 'GET' && path.startsWith('/api/agent/session/') && !path.includes('/trigger') && !path.includes('/reassign') && !path.includes('/respond') && !path.includes('/dismiss')) {
      const asked = decodeURIComponent(path.slice('/api/agent/session/'.length));
      if (!asked) return err('session_id required');
      // The agent polls by the session id it posted. The card comes back
      // flattened exactly as the board's list serves it — same projection,
      // same fields — so the agent and the board cannot be looking at two
      // different readings of one gate (§5).
      //
      // `stages` rides along, which is what an agent should read once research
      // and design can be at different points at the same time.
      const key = await resolveKey(env, asked);
      if (!key) return err('not found', 404);
      const wire = await cardWire(env, key);
      if (!wire) return err('not found', 404);

      // Asked for one stage by name, answer about that stage. The flattened
      // fields describe whichever session is most current, and that is the
      // wrong answer to "how is design doing" when research is the one queued.
      const named = stageFromSessionId(asked);
      if (named && wire.stages[named]) {
        return json({ ...wire, ...wire.stages[named], phase: named });
      }
      return json(wire);
    }

    // POST /api/agent/session/:id/trigger — human presses a card button.
    //
    // This used to write a `design-ai:go` label onto the Linear issue, and the
    // runner polled Linear looking for it: Linear was the message bus between
    // the button and the agent, which is why board state and control labels
    // ended up scattered across two systems. The button now writes to the
    // Hub's own queue and applies no label at all. The runner reads
    // /api/agent/queue.
    //
    // Writing the queue row and starting the runner are two steps on purpose,
    // in that order. The row is the request; starting the run is a convenience
    // on top of it. If GitHub is down, or the token has expired, the press is
    // still recorded and the work still happens on the next run — the response
    // says so rather than pretending the run began.
    if (method === 'POST' && path.match(/^\/api\/agent\/session\/[^/]+\/trigger$/)) {
      const key = await resolveKey(env, path.split('/')[4]);
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      // The Hub's trigger vocabulary, and the one place it is enforced. The
      // `sessions` table itself does not constrain `stage` — that would put
      // another agent system's stage names in this Worker's gift, and the Hub
      // stays generic.
      if (!STAGES.includes(b.stage)) {
        return err(`stage must be one of: ${STAGES.join(', ')}`);
      }
      if (!key) return err('not found', 404);
      const card = await env.DB.prepare(
        `SELECT linear_uuid FROM cards WHERE issue_key = ?`
      ).bind(key).first();
      if (!card) return err('not found', 404);
      // The runner works from the Linear issue, so a card with nothing behind
      // it in Linear has nothing to run against.
      if (!card.linear_uuid) return err('session has no linked Linear issue');

      // One run per card at a time, still. A card can hold a session per stage
      // now, but runs are serialised and queuing design while research is
      // waiting to start would put two rows in the queue for one issue — which
      // reads on the board as one card in two places.
      const busy = await env.DB.prepare(
        `SELECT stage FROM stage_sessions WHERE issue_key = ? AND requested_at IS NOT NULL`
      ).bind(key).first();
      if (busy) return err(`already queued for ${busy.stage}`, 409);

      // The stage is the row, so queuing is a timestamp on the row for that
      // stage — there is no `requested_stage` to disagree with it.
      await ensureSession(env, key, b.stage);
      await env.DB.prepare(
        `UPDATE stage_sessions
            SET requested_at = datetime('now'), updated_at = datetime('now')
          WHERE issue_key = ? AND stage = ?`
      ).bind(key, b.stage).run();

      // What the runner will find when it reads the queue, including the row
      // just written. Deliberately the same WHERE clause as /api/agent/queue:
      // if the two ever disagreed, the Hub would be telling the runner to take
      // a number of issues it is not going to be shown.
      const queued = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM stage_sessions s
           JOIN cards c ON c.issue_key = s.issue_key
          WHERE s.requested_at IS NOT NULL
            AND c.dismissed_at IS NULL
            AND c.set_aside_at IS NULL`
      ).first();

      const run = await startRunner(env, queued && queued.n);
      return json({ ok: true, requested: b.stage, started: run.started, detail: run.reason });
    }

    // DELETE /api/agent/session/:id/trigger — take a request back out of the
    // queue. The exact inverse of the POST above, and the way out of the one
    // state the board could not get itself out of.
    //
    // `requested_stage` is written by the trigger and cleared in exactly one
    // other place, /api/agent/stage-done — which a run that failed never
    // reaches. So a run that errored or was never picked up kept its queue
    // entry for ever: the stage button stayed disabled, and pressing it again
    // answered 409 already queued. Four issues sat like that for a day because
    // the runner takes two per dispatch and nothing re-dispatches.
    //
    // It touches nothing in Linear and no label. It clears the queue entry, and
    // an error along with it — a row you have just reset is not still failing,
    // and leaving `status = 'error'` behind would leave the card shouting about
    // a run you have already dealt with. The error prose goes with the status
    // that made it worth showing.
    //
    // Deliberately not destructive: the row, its stage labels, its brand, its
    // gate and its history are all untouched. The worst it can do is let you
    // press the button again, which is the entire point.
    if (method === 'DELETE' && path.match(/^\/api\/agent\/session\/[^/]+\/trigger$/)) {
      const key = await resolveKey(env, path.split('/')[4]);
      if (!key) return err('not found', 404);

      // Every session on the card, because the button is pressed on a card and
      // means "whatever this is stuck in, stop". A card with a queued research
      // run and a design session that errored is one card in one bad state,
      // and clearing half of it would leave the other half showing.
      //
      // What is reported back is the queued stage, which is the thing the
      // press was most likely about.
      const queued = await env.DB.prepare(
        `SELECT stage, status FROM stage_sessions
          WHERE issue_key = ? AND requested_at IS NOT NULL`
      ).bind(key).first();
      const errored = await env.DB.prepare(
        `SELECT stage, status FROM stage_sessions
          WHERE issue_key = ? AND status = 'error'`
      ).bind(key).first();

      // Nothing queued and nothing failed is not an error. The button's whole
      // job is to get a card out of a state it cannot leave, so pressing it
      // again has simply nothing to do — but the card still has to exist.
      const exists = await env.DB.prepare(
        `SELECT issue_key FROM cards WHERE issue_key = ?`
      ).bind(key).first();
      if (!exists) return err('not found', 404);

      // Both CASEs read each row as it was, so clearing the prompt keys off
      // the old status rather than the one being written in the same statement.
      await env.DB.prepare(
        `UPDATE stage_sessions
            SET requested_at = NULL,
                status = CASE WHEN status = 'error' THEN 'waiting' ELSE status END,
                prompt = CASE WHEN status = 'error' THEN NULL ELSE prompt END,
                last_error = CASE WHEN status = 'error' THEN NULL ELSE last_error END,
                updated_at = datetime('now')
          WHERE issue_key = ?
            AND (requested_at IS NOT NULL OR status = 'error')`
      ).bind(key).run();

      const was = queued || errored || {};
      return json({ ok: true, cleared: (queued && queued.stage) || null,
                    was: was.status || null });
    }

    // GET /api/agent/queue — what the runner asks for instead of polling
    // Linear. Oldest request first, so a button pressed on Monday is not
    // starved by one pressed this morning.
    if (method === 'GET' && path === '/api/agent/queue') {
      // ── Who is asking ──
      //
      // A runner that names itself gets the work meant for it. One that does
      // not gets everything, exactly as before, so a runner that has not been
      // updated keeps working — this route is the runner's only source of
      // work and breaking it silently would stop every run.
      //
      // Two filters, in this order, and both are about the asker rather than
      // about the work:
      //
      //   capability   a runner is only offered a stage it said it can run.
      //                Generic: the Hub matches the stage name against the
      //                names the runner declared, and knows what neither
      //                means. It is what keeps GitHub Actions — which declares
      //                research only — from being handed design work it cannot
      //                do and would fail.
      //
      //   selection    when you have said which machine you are at, the other
      //                machines you sit at get nothing. CI is never filtered
      //                this way: starving Actions of research is not what
      //                anybody means by "run this here".
      const asking = url.searchParams.get('machine');
      let me = null;
      if (asking) {
        try {
          me = await env.DB.prepare(
            `SELECT machine, capabilities, kind FROM agent_heartbeats WHERE machine = ?`
          ).bind(asking).first();
        } catch (e) {
          // pre-piece12: no kind column. Capability filtering still works,
          // and with nothing selectable there is no selection to apply.
          me = await env.DB.prepare(
            `SELECT machine, capabilities FROM agent_heartbeats WHERE machine = ?`
          ).bind(asking).first();
        }

        const chosen = await workingFrom(env);
        // An unknown machine is treated as local and as not the chosen one.
        // The runner heartbeats before it reads the queue, so in practice this
        // is a caller that is not the runner.
        const isCi = me && me.kind === 'ci';
        if (chosen && !isCi && asking !== chosen) {
          return json([]);
        }
      }

      // The runner's shape is unchanged — `requested_stage` is what it reads,
      // and it is the stage of the queued session rather than a column that
      // could disagree with one.
      const { results } = await env.DB.prepare(
        `SELECT c.issue_key   AS id,
                c.issue_key   AS linear_id,
                c.linear_uuid AS linear_uuid,
                c.title       AS title,
                c.brand       AS project,
                c.track       AS track,
                c.team        AS team,
                s.stage       AS requested_stage,
                s.requested_at AS requested_at
           FROM stage_sessions s
           JOIN cards c ON c.issue_key = s.issue_key
          WHERE s.requested_at IS NOT NULL
            AND c.dismissed_at IS NULL
            AND c.set_aside_at IS NULL
          ORDER BY s.requested_at ASC`
      ).all();

      let queue = results || [];
      if (me) {
        const can = parseOptions(me.capabilities);
        // No declared capabilities is not "can do nothing" — it is a runner
        // that has not said. Filtering it to nothing would strand the queue on
        // a single missing field.
        if (can.length) queue = queue.filter((r) => can.includes(r.requested_stage));
      }
      return json(queue);
    }

    // POST /api/agent/stage-done — the runner reports a finished stage.
    // The Hub, not the runner, is what writes the record label: it already
    // holds the Linear key and the mutation helpers, and keeping label writes
    // in one place is what stops the two systems disagreeing again.
    if (method === 'POST' && path === '/api/agent/stage-done') {
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!b.linear_id) return err('linear_id required');
      if (!STAGES.includes(b.stage)) {
        return err(`stage must be one of: ${STAGES.join(', ')}`);
      }
      const id = await resolveKey(env, String(b.linear_id).toUpperCase());
      if (!id) return err(`no row for Linear issue ${b.linear_id}`, 404);
      const row = await env.DB.prepare(
        `SELECT linear_uuid, labels FROM cards WHERE issue_key = ?`
      ).bind(id).first();
      if (!row) return err('not found', 404);
      if (!row.linear_uuid) return err('session has no linked Linear issue');

      const name = STAGE_LABEL[b.stage];
      const labelId = await getLabelId(env, name);
      if (!labelId) return err(`Linear label "${name}" not found`, 502);
      const res = await addLabelToIssue(env, row.linear_uuid, labelId);
      // Deliberately leave requested_stage set. A stage whose label could not
      // be written must stay in the queue and be retried, not silently vanish
      // from both the board and the runner's view of the work.
      if (res.error) {
        return err('Linear mutation failed: ' + JSON.stringify(res.error), 502);
      }

      // Write the label locally as well. The reader only runs Wednesday and
      // Friday; without this the card would sit in the wrong column for days
      // after the work was actually finished.
      let labels = [];
      try { labels = JSON.parse(row.labels || '[]'); } catch { labels = []; }
      if (!Array.isArray(labels)) labels = [];
      if (!labels.includes(name)) labels.push(name);

      // Two writes now, because they are two facts. The label is the issue's
      // and lives on the card; finishing is the session's and lives on the
      // session for the stage that finished — so reporting design done no
      // longer marks a research session done along with it.
      await env.DB.prepare(
        `UPDATE cards SET labels = ?, updated_at = datetime('now')
          WHERE issue_key = ?`
      ).bind(JSON.stringify(labels), id).run();

      await ensureSession(env, id, b.stage);
      await env.DB.prepare(
        `UPDATE stage_sessions
            SET status = 'done', requested_at = NULL,
                last_error = NULL, last_error_at = NULL,
                updated_at = datetime('now')
          WHERE issue_key = ? AND stage = ?`
      ).bind(id, b.stage).run();
      return json({ ok: true, label: name, stage: b.stage });
    }

    // POST /api/agent/session/:id/skip — "do not run this stage; move on".
    //
    // §7 lists Skip a stage as one of the card's actions and nothing
    // implemented it. §1 says the label is the Manager's to write, but only
    // "when you press it" — so this route exists and no automatic path may
    // reach it.
    //
    // What it is FOR: a design task that needs no research. The design agent
    // already handles that case — it works from the description, the BCC and
    // the design bible and records the absence as an assumption — but the
    // board could not express it, because a card sits in Backlog until
    // something says research is not coming. Absence means "not yet" and
    // nothing else (§12), so "not going to happen" has to be written down.
    //
    // Deliberately a label and not a Hub-only flag: skipping is a fact about
    // the issue, it is visible to everyone in Linear, and §3 reads it back as
    // `skipped` — a state that renders differently from both done and not
    // started, which is the whole reason it was given a label in the first
    // place.
    if (path.match(/^\/api\/agent\/session\/[^/]+\/skip$/) &&
        (method === 'POST' || method === 'DELETE')) {
      const key = await resolveKey(env, path.split('/')[4]);
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!STAGES.includes(b.stage)) {
        return err(`stage must be one of: ${STAGES.join(', ')}`);
      }
      const row = key && await env.DB.prepare(
        `SELECT linear_uuid, labels FROM cards WHERE issue_key = ?`
      ).bind(key).first();
      if (!row) return err('not found', 404);
      if (!row.linear_uuid) return err('session has no linked Linear issue');

      const name = SKIP_LABEL[b.stage];
      const labelId = await getLabelId(env, name);
      if (!labelId) return err(`Linear label "${name}" not found`, 502);

      // Linear first, the local copy second — the same ordering the dismiss
      // route follows, and for the same reason: a card moved here but not
      // there is put back by the next reconciliation and flickers.
      const res = method === 'POST'
        ? await addLabelToIssue(env, row.linear_uuid, labelId)
        : await removeLabelFromIssue(env, row.linear_uuid, labelId);
      if (res.error) {
        return err('Linear mutation failed: ' + JSON.stringify(res.error), 502);
      }

      let labels = [];
      try { labels = JSON.parse(row.labels || '[]'); } catch { labels = []; }
      if (!Array.isArray(labels)) labels = [];
      labels = method === 'POST'
        ? (labels.includes(name) ? labels : [...labels, name])
        : labels.filter((l) => l !== name);

      await env.DB.prepare(
        `UPDATE cards SET labels = ?, updated_at = datetime('now') WHERE issue_key = ?`
      ).bind(JSON.stringify(labels), key).run();

      return json({ ok: true, stage: b.stage, label: name,
                    skipped: method === 'POST' });
    }

    // POST /api/agent/session/:id/dismiss — "this needs no design".
    // Applies the no-design label, same mechanism as trigger, and records the
    // dismissal locally so the card moves immediately rather than waiting for
    // the next cron read.
    //
    // DELETE undoes it. Order matters: the label comes off in Linear first,
    // and dismissed_at is only cleared if that succeeded. Clearing first would
    // put a card back on the board still carrying the label, and the next
    // reconciliation would dismiss it again — a card that flickers.
    if (path.match(/^\/api\/agent\/session\/[^/]+\/dismiss$/) &&
        (method === 'POST' || method === 'DELETE')) {
      const id = await resolveKey(env, path.split('/')[4]);
      const row = id && await env.DB.prepare(
        `SELECT linear_uuid FROM cards WHERE issue_key = ?`
      ).bind(id).first();
      if (!row) return err('not found', 404);
      if (!row.linear_uuid) return err('session has no linked Linear issue');

      const labelId = await getLabelId(env, 'no-design');
      if (!labelId) return err('Linear label "no-design" not found', 502);

      if (method === 'POST') {
        const res = await addLabelToIssue(env, row.linear_uuid, labelId);
        if (res.error) return err('Linear mutation failed: ' + JSON.stringify(res.error), 502);
        await env.DB.prepare(
          `UPDATE cards
           SET dismissed_at = COALESCE(dismissed_at, datetime('now')),
               updated_at = datetime('now')
           WHERE issue_key = ?`
        ).bind(id).run();
        return json({ ok: true, dismissed: true });
      }

      const res = await removeLabelFromIssue(env, row.linear_uuid, labelId);
      if (res.error) return err('Linear mutation failed: ' + JSON.stringify(res.error), 502);
      await env.DB.prepare(
        `UPDATE cards SET dismissed_at = NULL, updated_at = datetime('now')
         WHERE issue_key = ?`
      ).bind(id).run();
      return json({ ok: true, dismissed: false });
    }

    // POST/DELETE /api/agent/session/:id/setaside — "this is design work,
    // but not for the agents".
    //
    // Deliberately not the dismiss route with a flag. `no-design` is a
    // statement about the issue, it is written into Linear, and it means the
    // work is not design work at all. This is a statement about this Hub's
    // agents, it is nobody else's business, and it writes nothing to Linear —
    // keeping control labels out of Dave's Linear workflow is the whole reason
    // piece 7 exists.
    //
    // Which is why it needs no Linear call at all, and why it cannot fail
    // half-way the way dismiss can. There is no ordering contract here.
    if (path.match(/^\/api\/agent\/session\/[^/]+\/setaside$/) &&
        (method === 'POST' || method === 'DELETE')) {
      const id = await resolveKey(env, path.split('/')[4]);
      if (!id) return err('not found', 404);
      // Whatever is queued on this card, so setting it aside can report what
      // it called off. There may be no session at all, which is not an error.
      const row = (await env.DB.prepare(
        `SELECT stage FROM stage_sessions WHERE issue_key = ? AND requested_at IS NOT NULL`
      ).bind(id).first()) || {};

      if (method === 'POST') {
        // Setting aside clears any queued run with it. A card you have just
        // told the agents to leave alone must not still be sitting in the
        // queue they read — and /api/agent/queue filters this column now, so
        // leaving the entry would strand a row nothing will ever come back to.
        //
        // COALESCE so a second press does not move the timestamp: when it was
        // set aside is a fact worth keeping.
        await env.DB.prepare(
          `UPDATE cards
              SET set_aside_at = COALESCE(set_aside_at, datetime('now')),
                  updated_at = datetime('now')
            WHERE issue_key = ?`
        ).bind(id).run();
        await env.DB.prepare(
          `UPDATE stage_sessions SET requested_at = NULL, updated_at = datetime('now')
            WHERE issue_key = ? AND requested_at IS NOT NULL`
        ).bind(id).run();
        return json({ ok: true, set_aside: true, cleared: row.stage || null });
      }

      await env.DB.prepare(
        `UPDATE cards SET set_aside_at = NULL, updated_at = datetime('now')
          WHERE issue_key = ?`
      ).bind(id).run();
      return json({ ok: true, set_aside: false });
    }

    // POST /api/agent/session/:id/complete — mark the issue done in Linear.
    //
    // ── The one §6 exception, and it is deliberate ──
    //
    // §6 lists what the Manager writes and says plainly: "Never issue status,
    // title, assignee, cycle, or brand." This route writes issue status. §15
    // asked which of the two should move; the answer is the document, and this
    // comment is where the reasoning lives so the next reader does not have to
    // rediscover it.
    //
    // The rule exists to stop the Manager *inventing* a fact it does not own —
    // deciding on its own that work is finished, from a label or an evidence
    // read or a timer. That is still forbidden and nothing does it.
    //
    // This is not that. It is a human pressing a button that means "this is
    // finished", and the Hub carrying the press to Linear. The alternative is
    // opening Linear to do the same thing by hand, which is the trip the Hub
    // exists to save.
    //
    // What keeps the exception honest is that it is the ONLY path here that
    // can write status. No cron read, no agent post and no stage report can
    // reach this mutation — test/invariants.test.mjs holds that down, and it
    // is the assertion that matters rather than this paragraph.
    //
    // It resolves the state rather than naming one: see completedStateFor.
    // Linear first and the local row second, which is the same ordering the
    // dismiss route follows and for the same reason — a card moved to Completed
    // here but not there is put back by the next reconciliation pass, and
    // flickers on and off the board with every read.
    if (method === 'POST' && path.match(/^\/api\/agent\/session\/[^/]+\/complete$/)) {
      const id = await resolveKey(env, path.split('/')[4]);
      const row = id && await env.DB.prepare(
        `SELECT linear_uuid FROM cards WHERE issue_key = ?`
      ).bind(id).first();
      if (!row) return err('not found', 404);
      if (!row.linear_uuid) return err('session has no linked Linear issue');

      const found = await completedStateFor(env, row.linear_uuid);
      if (found.error) return err('Linear: ' + JSON.stringify(found.error), 502);

      if (!found.already) {
        const res = await linearGraphQL(env, COMPLETE_MUTATION,
          { id: row.linear_uuid, stateId: found.state.id });
        if (res.errors) {
          return err('Linear mutation failed: ' + JSON.stringify(res.errors), 502);
        }
      }

      // The queue entry goes with it. A finished issue is not work the runner
      // should still be handed — it would read the card as ineligible and skip
      // it anyway, and the entry would sit there reading as Working.
      await env.DB.prepare(
        `UPDATE cards
            SET linear_state = 'completed', updated_at = datetime('now')
          WHERE issue_key = ?`
      ).bind(id).run();
      await env.DB.prepare(
        `UPDATE stage_sessions SET requested_at = NULL, updated_at = datetime('now')
          WHERE issue_key = ? AND requested_at IS NOT NULL`
      ).bind(id).run();
      return json({ ok: true, state: found.state.name, already: !!found.already });
    }

    // POST /api/agent/heartbeat — the local runner checks in, whether or not
    // it found anything queued. Everything else here is pull-only: the runner
    // reads the queue and the Hub never reaches out to it, so a card queued
    // for Figma or Mobbin work — both local-only, both reachable only from a
    // person's own machine — looked identical whether or not anything was
    // going to pick it up. This is the one write that exists purely so the
    // board can tell those two apart. Guarded by the same X-Agent-Secret
    // gate as every other agent write, via requireHuman above.
    if (method === 'POST' && path === '/api/agent/heartbeat') {
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!b.machine) return err('machine required');
      const capabilities = Array.isArray(b.capabilities) ? JSON.stringify(b.capabilities) : '[]';
      // What the runner SAID it is, or null when it said nothing.
      //
      // Storing a guess here was a bug, and a live one: defaulting a missing
      // value to 'local' meant every check-in from a runner that predates this
      // field overwrote whatever was there — including a correction made by
      // hand. A GitHub runner marked 'ci' flipped back to 'local' on its next
      // heartbeat and was promptly starved by the selection, which is the one
      // thing this feature is supposed never to do.
      //
      // So: store what was said. Null stays null, and a value already recorded
      // survives a runner that has nothing to say about it.
      const kind = b.kind === 'ci' ? 'ci' : b.kind === 'local' ? 'local' : null;

      try {
        await env.DB.prepare(
          `INSERT INTO agent_heartbeats (machine, capabilities, kind, last_seen, first_seen)
             VALUES (?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(machine) DO UPDATE SET
             capabilities = excluded.capabilities,
             -- Only where the runner said. A check-in that is silent about
             -- what it is must not overwrite what is already known.
             kind         = COALESCE(excluded.kind, agent_heartbeats.kind),
             last_seen    = excluded.last_seen`
        ).bind(b.machine, capabilities, kind).run();
      } catch (e) {
        // pre-piece12. Checking in is how the board knows a machine is alive
        // at all, and losing that to a column the deploy has not caught up
        // with would be worse than losing the one field.
        await env.DB.prepare(
          `INSERT INTO agent_heartbeats (machine, capabilities, last_seen, first_seen)
             VALUES (?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(machine) DO UPDATE SET
             capabilities = excluded.capabilities,
             last_seen    = excluded.last_seen`
        ).bind(b.machine, capabilities).run();
      }

      // `claim` is the automatic half of "which machine am I at". Running
      // design-local.bat means you are sitting at that machine — that is what
      // the command is for — so the runner says so and the board follows.
      // Nothing else claims: a scheduled run on a laptop you are nowhere near
      // must not decide where you are.
      //
      // CI can never claim. A GitHub runner is not somewhere you are sitting.
      if (b.claim && kind !== 'ci') await selectMachine(env, b.machine);

      return json({ ok: true, machine: b.machine, kind: kind, 
                    claimed: !!b.claim && kind !== 'ci' });
    }

    // PUT /api/agent/working-from — the by-hand half. The board sends a machine
    // name, or null to stop preferring any.
    //
    // Deliberately not inferred from the browser: a page cannot read its own
    // hostname, and guessing from the freshest check-in gets it wrong exactly
    // when it matters, which is when a scheduled run on the other machine has
    // just checked in.
    if (method === 'PUT' && path === '/api/agent/working-from') {
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }

      if (b.machine === null || b.machine === '') {
        try {
          await env.DB.prepare(
            `UPDATE agent_heartbeats SET selected_at = NULL WHERE selected_at IS NOT NULL`
          ).run();
        } catch (e) {
          // pre-piece12: there is nothing selected to clear, so clearing it
          // has already succeeded.
        }
        return json({ ok: true, machine: null });
      }
      if (!b.machine) return err('machine required, or null to clear');

      let row;
      try {
        row = await env.DB.prepare(
          `SELECT machine, kind FROM agent_heartbeats WHERE machine = ?`
        ).bind(b.machine).first();
      } catch (e) {
        // pre-piece12. Say so rather than 500 — this one genuinely cannot work
        // without the columns, and "apply the migration" is a far more useful
        // thing for the board to show than a server error.
        return err('the Hub has not been migrated yet — apply piece12-schema.sql ' +
                   'to choose which machine work goes to', 503);
      }
      // Only a machine that has actually checked in. Selecting one that never
      // has would silently route every queued run to nothing at all.
      if (!row) return err(`no machine called "${b.machine}" has ever checked in`, 404);
      if (row.kind === 'ci') {
        return err('that is a CI runner, not a machine you sit at');
      }

      if (!(await selectMachine(env, b.machine))) {
        return err('the Hub has not been migrated yet — apply piece12-schema.sql ' +
                   'to choose which machine work goes to', 503);
      }
      return json({ ok: true, machine: b.machine });
    }

    // GET /api/agent/heartbeat — every machine that has ever checked in, most
    // recent first. What the board reads to say whether a press that queues
    // local-only work will actually be picked up, or is sitting there with
    // nobody listening.
    if (method === 'GET' && path === '/api/agent/heartbeat') {
      let results;
      try {
        ({ results } = await env.DB.prepare(
          `SELECT machine, capabilities, kind, selected_at, last_seen, first_seen
             FROM agent_heartbeats ORDER BY last_seen DESC`
        ).all());
      } catch (e) {
        // pre-piece12: every machine reads as local with nothing selected,
        // which is exactly the board that was there before.
        ({ results } = await env.DB.prepare(
          `SELECT machine, capabilities, last_seen, first_seen
             FROM agent_heartbeats ORDER BY last_seen DESC`
        ).all());
      }
      return json(results.map((r) => ({ ...r, capabilities: parseOptions(r.capabilities) })));
    }

    // GET /api/runner — where the work actually happens, so the board can link
    // to it. The run's own log is the only truly live view of a job: the runner
    // reports `active` once and then nothing until it is done, because the
    // Claude call blocks for minutes. One link beats guessing.
    if (method === 'GET' && path === '/api/runner') {
      const repo = env.RUNNER_REPO || RUNNER_REPO;
      const workflow = env.RUNNER_WORKFLOW || RUNNER_WORKFLOW;
      return json({
        repo, workflow,
        url: `https://github.com/${repo}/actions/workflows/${workflow}`,
      });
    }

    // GET /api/reader/teams — what the reader reads, and what it could read.
    if (method === 'GET' && path === '/api/reader/teams') {
      const [selected, available] = await Promise.all([
        readerTeams(env), availableTeams(env),
      ]);
      // `all: true` is the honest way to say "nothing is selected", because an
      // empty list means every team rather than no teams, and a board that
      // showed an empty list as "reading nothing" would have it backwards.
      return json({ selected, available: available.teams, source: available.from,
                    all: selected.length === 0 });
    }

    // PUT /api/reader/teams — replace the set. `{"teams": []}` means every
    // team, which is the setting and not a refusal to choose.
    if (method === 'PUT' && path === '/api/reader/teams') {
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!Array.isArray(b.teams)) return err('teams must be an array');
      const names = [...new Set(b.teams.map((t) => String(t || '').trim()).filter(Boolean))];
      if (names.length > 100) return err('too many teams', 413);
      if (names.some((n) => n.length > 200)) return err('team name too long');

      // Replaced rather than merged: the board sends the whole set it is
      // showing, so what is stored is what you were looking at.
      await env.DB.prepare(`DELETE FROM reader_teams`).run();
      for (const name of names) {
        await env.DB.prepare(
          `INSERT INTO reader_teams (name) VALUES (?) ON CONFLICT(name) DO NOTHING`
        ).bind(name).run();
      }
      return json({ ok: true, selected: names, all: names.length === 0 });
    }

    // POST /api/agent/sessions/setaside — dismiss a list of cards at once.
    //
    // The ids come from the board rather than a filter sent to the server: the
    // board already knows exactly which cards it is showing you, and a team
    // filter reimplemented here could drift out of step with the one you are
    // actually looking at. What you see dismissed is what you asked to dismiss.
    if (method === 'POST' && path === '/api/agent/sessions/setaside') {
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : null;
      if (!ids || !ids.length) return err('ids required');
      if (ids.length > 200) return err('too many ids in one call', 413);

      let n = 0;
      for (const asked of ids) {
        const id = await resolveKey(env, String(asked));
        if (!id) continue;
        await env.DB.prepare(
          `UPDATE cards
              SET set_aside_at = COALESCE(set_aside_at, datetime('now')),
                  updated_at = datetime('now')
            WHERE issue_key = ?`
        ).bind(id).run();
        await env.DB.prepare(
          `UPDATE stage_sessions SET requested_at = NULL, updated_at = datetime('now')
            WHERE issue_key = ? AND requested_at IS NOT NULL`
        ).bind(id).run();
        n++;
      }
      return json({ ok: true, set_aside: n, asked: ids.length });
    }

    // PATCH /api/agent/session/:id/reassign — manual brand/track correction
    // for when the Linear Reader's auto-detected brand is wrong.
    if (method === 'PATCH' && path.match(/^\/api\/agent\/session\/[^/]+\/reassign$/)) {
      const id = await resolveKey(env, path.split('/')[4]);
      if (!id) return err('not found', 404);
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      // `project` on the wire is the brand — the agent posts it under that
      // name too. The column is called `brand` now, and this is one of only
      // two places the old name is translated (the other is lib/card.mjs).
      const fields = []; const values = [];
      if (b.project !== undefined) { fields.push('brand = ?'); values.push(b.project); }
      if (b.track !== undefined) { fields.push('track = ?'); values.push(b.track); }
      if (!fields.length) return err('project or track required');
      fields.push("updated_at = datetime('now')");
      values.push(id);
      await env.DB.prepare(`UPDATE cards SET ${fields.join(', ')} WHERE issue_key = ?`).bind(...values).run();
      return json({ ok: true });
    }

    // GET /api/agent/sessions — the board's list, newest first.
    //
    // §2: "A record with no Linear issue key is not a card and cannot appear
    // on the board." This is where that is true. A session with no issue
    // behind it still exists, still reads and writes on its own route, and
    // still works exactly as it always did — the runner's reachability probe
    // is one and has to keep working — but it is not a card, and the board is
    // where the difference is enforced.
    //
    // §11 lists this as a bug already had: "Test card can't exercise its
    // controls". A row with no issue has no Linear uuid, so Run, Skip,
    // Dismiss and Complete all refuse it. Drawing it as a card offered a full
    // set of controls where none of them could work, and it was tested against
    // once, which produced a false result.
    if (method === 'GET' && path === '/api/agent/sessions') {
      // Two reads and a join in code rather than SQL, because the sort is a
      // property of the projection: which session speaks for a card is decided
      // in lib/card.mjs, and a second copy of that rule in an ORDER BY is
      // exactly the §5 drift this split exists to end.
      const { results: cardRows } = await env.DB.prepare(
        `SELECT * FROM cards WHERE linear_uuid IS NOT NULL`
      ).all();
      const { results: sessionRows } = await env.DB.prepare(
        `SELECT * FROM stage_sessions`
      ).all();

      const byKey = new Map();
      for (const r of sessionRows || []) {
        if (!byKey.has(r.issue_key)) byKey.set(r.issue_key, []);
        byKey.get(r.issue_key).push(r);
      }

      const RANK = { waiting: 0, error: 1, active: 2 };
      const wires = (cardRows || [])
        .map((c) => toWire(c, byKey.get(c.issue_key) || []))
        .sort((a, b) => {
          const ra = RANK[a.status] === undefined ? 3 : RANK[a.status];
          const rb = RANK[b.status] === undefined ? 3 : RANK[b.status];
          if (ra !== rb) return ra - rb;
          return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
        });
      return json(wires);
    }

    // PATCH /api/agent/session/:id/respond — human answers the prompt.
    //
    // When the gate offers options the answer has to name one of them. A note
    // on its own is never a decision: that is the whole point, and it is what
    // stops "Yes" from reading as a direction. A gate with no options is
    // answered in free text exactly as it always was.
    if (method === 'PATCH' && path.match(/\/respond$/)) {
      // The session this answers. The board sends the card's id and means
      // the gate it drew; the agent may name a stage and mean that one.
      const target = await resolveSession(
        env, path.slice('/api/agent/session/'.length, path.length - '/respond'.length)
      );
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!target || !target.session) return err('not found', 404);
      const { key, stage } = target;
      const existing = target.session;

      const options = parseOptions(existing.options);
      if (options.length) {
        const offered = options.map(o => o.id).join(', ');

        // A direction you drew yourself. The agent enumerates the choices, so
        // the agent bounds what you are allowed to decide — and sometimes the
        // right answer is a design that already exists in Figma. Naming its
        // section decides the gate.
        //
        // It is a decision, but it is not one of the ids the agent offered, so
        // `response_option_id` stays null: that column only ever holds
        // something that was actually on the list. `response_kind` on reads is
        // what tells a consumer which kind of decision it is looking at.
        //
        // This arrives under its own field name, never as a bare note. A note
        // that decides a gate is the "Yes" bug, whatever it says.
        const section = b.response_section === undefined || b.response_section === null
          ? '' : String(b.response_section).trim();
        if (section && b.response_option_id) {
          return err('answer with an option or with your own design, not both');
        }
        if (section) {
          if (section.length > 200) return err('section name too long — 200 characters at most');
          await env.DB.prepare(
            `UPDATE stage_sessions
                SET response_option_id = NULL, response_note = ?, response = ?,
                    responded_at = datetime('now'),
                    status = 'active', updated_at = datetime('now')
              WHERE issue_key = ? AND stage = ?`
          ).bind(section, section, key, stage).run();
          return json({ ok: true, response_kind: 'own', response_label: section });
        }

        if (!b.response_option_id) {
          return err('response_option_id or response_section required — this gate offers ' + offered);
        }
        const chosen = options.find(o => o && o.id === b.response_option_id);
        if (!chosen) {
          return err("unknown option '" + b.response_option_id +
                     "' — this gate offers " + offered);
        }
        // `response` keeps carrying the answer in words for anything still
        // reading that column, but it is copied off the chosen option rather
        // than typed, so it can no longer say something the question never
        // offered.
        await env.DB.prepare(
          `UPDATE stage_sessions
              SET response_option_id = ?, response_note = ?, response = ?,
                  responded_at = datetime('now'),
                  status = 'active', updated_at = datetime('now')
            WHERE issue_key = ? AND stage = ?`
        ).bind(chosen.id, b.response_note || null, chosen.label, key, stage).run();
        return json({ ok: true, response_kind: 'option',
                      response_option_id: chosen.id, response_label: chosen.label });
      }

      if (!b.response) return err('response required');
      await env.DB.prepare(
        `UPDATE stage_sessions
         SET response = ?, response_note = ?, responded_at = datetime('now'),
             status = 'active', updated_at = datetime('now')
         WHERE issue_key = ? AND stage = ?`
      ).bind(b.response, b.response_note || null, key, stage).run();
      return json({ ok: true });
    }

    // PATCH /api/agent/session/:id/reopen — the answer was wrong, or the
    // options were. gates.md has always listed "Revise — [feedback]" as a
    // valid answer, which means going back to a gate that was already
    // answered. The round is archived, the round number moves on, the decision
    // clears and the card returns to waiting. The agent posts a fresh options
    // array for the new round; the old round survives in gate_decisions, so a
    // revised direction does not erase the first one.
    if (method === 'PATCH' && path.startsWith('/api/agent/session/') && path.endsWith('/reopen')) {
      const target = await resolveSession(
        env, path.slice('/api/agent/session/'.length, path.length - '/reopen'.length)
      );
      // The note is optional, and so is the body that would carry it.
      let b = {};
      try { b = (await request.json()) || {}; } catch { b = {}; }
      if (!target || !target.session) return err('not found', 404);
      const { key, stage } = target;
      const row = target.session;

      // A reopen always leaves a trail. Taking a decision back has one to
      // archive already. Rejecting the options outright — "none of these" —
      // has nothing but the reason, and that reason is the only record the
      // round will ever have: without it the agent learns the gate reopened
      // and nothing about why, so it re-asks the same question.
      const note = b.note ? String(b.note).trim() : '';
      const decided = row.response_option_id || row.response || row.response_note;
      if (!decided && !note) {
        return err('note required — rejecting the options with no reason recorded ' +
                   'leaves the agent nothing to go on');
      }
      const round = await closeRound(env, key, stage, row, note || null);
      await env.DB.prepare(
        `UPDATE stage_sessions SET status = 'waiting', updated_at = datetime('now')
          WHERE issue_key = ? AND stage = ?`
      ).bind(key, stage).run();
      return json({ ok: true, gate_round: round, status: 'waiting' });
    }

    // PATCH /api/agent/session/:id/state — the two completion levels that had
    // nowhere to live. "AI-design done" means a spec was written; mockups_at
    // means something was actually drawn; handoff_at means a developer can
    // pick it up. The Hub stores all three and interprets none of them.
    if (method === 'PATCH' && path.startsWith('/api/agent/session/') && path.endsWith('/state')) {
      const target = await resolveSession(
        env, path.slice('/api/agent/session/'.length, path.length - '/state'.length)
      );
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!target || !target.session) return err('not found', 404);
      const { key, stage } = target;

      // "now" is what the contract's examples send, and it is the only thing
      // an agent reliably knows at the moment it finishes. An explicit
      // timestamp is taken as given; an explicit null clears the field.
      const stamp = (v) => (v === 'now' || v === true) ? nowStamp() : (v || null);
      const fields = []; const values = [];
      if (b.mockups_url !== undefined) {
        fields.push('mockups_url = ?'); values.push(b.mockups_url || null);
      }
      if (b.mockups_at !== undefined) {
        fields.push('mockups_at = ?'); values.push(stamp(b.mockups_at));
      } else if (b.mockups_url) {
        // A url and no timestamp still means mockups exist, and that they
        // exist now. Storing the url alone would record half the fact.
        fields.push('mockups_at = ?'); values.push(nowStamp());
      }
      if (b.handoff_at !== undefined) {
        fields.push('handoff_at = ?'); values.push(stamp(b.handoff_at));
      }
      if (!fields.length) return err('mockups_url, mockups_at or handoff_at required');
      fields.push("updated_at = datetime('now')");
      values.push(key, stage);
      await env.DB.prepare(
        `UPDATE stage_sessions SET ${fields.join(', ')} WHERE issue_key = ? AND stage = ?`
      ).bind(...values).run();
      return json({ ok: true });
    }

    // DELETE /api/agent/session/:id
    if (method === 'DELETE' && path.startsWith('/api/agent/session/')) {
      const id = await resolveKey(env, path.slice('/api/agent/session/'.length));
      if (id) {
        // The sessions go with the card. They are the card's transient state
        // and nothing else refers to them; leaving them would be the orphaned
        // rows §11 already lists once, in a new place.
        await env.DB.prepare(`DELETE FROM stage_sessions WHERE issue_key = ?`).bind(id).run();
        await env.DB.prepare(`DELETE FROM cards WHERE issue_key = ?`).bind(id).run();
      }
      return json({ ok: true });
    }




    // GET /api/diagnostics — §14.1 and §14.2, on demand.
    //
    // Every dependency this Worker has, reported pass / fail / unknown with
    // the reason and the name of the variable involved. The point is that a
    // missing credential is answerable in one request instead of showing up
    // as a strange failure in the middle of a run three hours later.
    //
    // `?live=1` adds the network round trips — currently the Linear call.
    // Off by default so this is cheap enough to hit whenever you want, and so
    // that a check nobody asked for never spends anyone's API budget.
    //
    // Behind requireHuman like everything else. What it reports about how the
    // Hub is configured is exactly what you would not want served openly, and
    // when it says Access is off, that is the one moment it is served openly —
    // which is the reason the answer is a `fail` rather than a note.
    if (method === 'GET' && path === '/api/diagnostics') {
      const live = url.searchParams.get('live') === '1';
      const report = await diagnose(env, { live });
      // 200 either way. This endpoint answering is the diagnostic; a non-200
      // would be indistinguishable from the Worker itself being broken, which
      // is the thing it exists to rule out.
      return json(report);
    }

    // GET /api/brands — the board's only structural read.
    //
    // Keeping brand identity in D1 means a colour change is an UPDATE and not
    // a deploy, which is worth having. Where it was kept was not: this read
    // was `SELECT ... FROM projects WHERE section_id = 'brands'`, and
    // `projects` is the sidebar hierarchy of the retired chat organiser
    // (§13). The board's only structural read pointed at an otherwise dead
    // table, and found its rows by a magic string you had to know the history
    // to recognise. piece10-schema.sql gives it a table named for what it
    // holds.
    if (method === 'GET' && path === '/api/brands') {
      const { results } = await env.DB.prepare(
        `SELECT id, name, color FROM brands ORDER BY sort_order`
      ).all();
      if (results && results.length) return json(results);

      // Transitional, and deliberately not a silent default: an empty read
      // means this Worker is deployed and piece10 has not been applied yet.
      // The board losing every brand bucket over a deploy-ordering mistake is
      // not worth the purity — same reasoning as readerTeams.
      //
      // DELETE THIS once piece10-schema.sql is applied and the board has been
      // confirmed to render its brands. At that point `projects` has no reader
      // left and §13 step 4 is unblocked.
      return json(await legacyBrands(env));
    }

    // ---- Figma paths --------------------------------------------------
    //
    // Where a team's work lands in Figma. This used to be a checked-in file in
    // the sibling Design AI repo, which was fine while the only way to change
    // it was to edit the repo; it stopped being fine once it is edited from
    // the board, because a browser cannot commit to git. See piece13-schema.sql.
    //
    // Two levels, and the runner reads them in this order:
    //   1. the card's own override, if it has one
    //   2. the default for its (team, brand)
    //   3. routing.json in the Design AI repo, if the Hub is unreachable

    // GET /api/figma-paths — both levels in one read, because the editor shows
    // both and two round trips could show you a half-updated picture.
    if (method === 'GET' && path === '/api/figma-paths') {
      const [defaults, overrides] = await Promise.all([
        env.DB.prepare(
          `SELECT team, brand, file, file_key AS fileKey, page, updated_at AS updatedAt
             FROM figma_paths ORDER BY team, brand`
        ).all(),
        // Only cards that actually carry one. An override list that included
        // every card would be a card list.
        env.DB.prepare(
          `SELECT issue_key AS id, title, brand, team,
                  figma_file_key AS fileKey, figma_page AS page
             FROM cards
            WHERE linear_uuid IS NOT NULL
              AND (figma_file_key IS NOT NULL OR figma_page IS NOT NULL)
            ORDER BY issue_key`
        ).all(),
      ]);
      return json({ defaults: defaults.results || [], overrides: overrides.results || [] });
    }

    // PUT /api/figma-paths — upsert one (team, brand) default.
    //
    // One row per call rather than a whole-list replace. The editor saves a row
    // at a time, and a replace would mean a stale tab wiping a pair somebody
    // else added — `reader_teams` can be replaced wholesale because the board
    // sends back exactly the set it is showing; this is not that.
    if (method === 'PUT' && path === '/api/figma-paths') {
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      const team = String(b.team || '').trim();
      const brand = String(b.brand || '').trim();
      if (!team || !brand) return err('team and brand are both required');
      if (team.length > 200 || brand.length > 200) return err('team or brand too long');

      // The file key is what actually resolves a Figma file; the name beside it
      // is for reading. Rejecting a URL here rather than storing it is
      // deliberate — pasting the whole Figma URL is the obvious mistake, and
      // silently storing it would fail much later, in a design run.
      const fileKey = String(b.fileKey || '').trim();
      if (/^https?:/i.test(fileKey)) {
        return err('fileKey is the key from the Figma URL, not the whole URL');
      }
      if (fileKey.length > 100) return err('fileKey too long');

      await env.DB.prepare(
        `INSERT INTO figma_paths (team, brand, file, file_key, page, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(team, brand) DO UPDATE SET
           file = excluded.file,
           file_key = excluded.file_key,
           page = excluded.page,
           updated_at = excluded.updated_at`
      ).bind(team, brand, String(b.file || '').trim() || null,
             fileKey || null, String(b.page || '').trim() || null).run();

      return json({ ok: true, team, brand });
    }

    // DELETE /api/figma-paths?team=X&brand=Y — remove a default.
    //
    // A pair with no row is not an error: route() in the runner treats an
    // unmapped pair as blocking and says so on the card, which is the correct
    // behaviour and better than guessing a destination.
    if (method === 'DELETE' && path === '/api/figma-paths') {
      const team = (url.searchParams.get('team') || '').trim();
      const brand = (url.searchParams.get('brand') || '').trim();
      if (!team || !brand) return err('team and brand are both required');
      const res = await env.DB.prepare(
        `DELETE FROM figma_paths WHERE team = ? AND brand = ?`
      ).bind(team, brand).run();
      return json({ ok: true, removed: res.meta ? res.meta.changes : null });
    }

    // PATCH /api/agent/session/:id/figma — the per-card override.
    //
    // Sending null or an empty string for both clears it, which is how a card
    // goes back to following its team's default. There is no separate "clear"
    // route, because a control that only ever does one thing is how the board
    // grew its ad-hoc buttons.
    if (method === 'PATCH' && path.startsWith('/api/agent/session/') && path.endsWith('/figma')) {
      // resolveKey is async, takes the env, and decodes the segment itself —
      // it also answers null for a card that is not there, which is what makes
      // the 404 below the honest answer rather than a silent no-op.
      const key = await resolveKey(env,
        path.slice('/api/agent/session/'.length, -'/figma'.length));
      if (!key) return err('No such card', 404);

      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      const fileKey = String(b.fileKey || '').trim();
      if (/^https?:/i.test(fileKey)) {
        return err('fileKey is the key from the Figma URL, not the whole URL');
      }
      if (fileKey.length > 100) return err('fileKey too long');
      const page = String(b.page || '').trim();
      if (page.length > 200) return err('page too long');

      const res = await env.DB.prepare(
        `UPDATE cards SET figma_file_key = ?, figma_page = ? WHERE issue_key = ?`
      ).bind(fileKey || null, page || null, key).run();
      if (!res.meta || !res.meta.changes) return err('No such card', 404);

      return json({ ok: true, id: key, fileKey: fileKey || null, page: page || null });
    }

    // POST /api/read-linear — run the Linear Reader on demand
  if (method === 'POST' && path === '/api/read-linear') {
    const result = await readLinear(env);
    return json(result);
  }

  // GET /api/sessions — cards with a session waiting on a human, newest first.
  //
  // This used to be every card the reader had ever seen, because the reader
  // wrote status='waiting' onto all of them. It now means what it says: a
  // session exists and it is waiting. §3's "Not started" is the absence of a
  // session, so a card nothing has run on is not waiting for anything.
  if (method === 'GET' && path === '/api/sessions') {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT c.issue_key, c.created_at FROM cards c
         JOIN stage_sessions s ON s.issue_key = c.issue_key
        WHERE s.status = 'waiting'
        ORDER BY c.created_at DESC`
    ).all();
    const out = [];
    for (const c of results || []) out.push(await cardWire(env, c.issue_key));
    return json(out.filter(Boolean));
  }

  return err('not found', 404);
}
