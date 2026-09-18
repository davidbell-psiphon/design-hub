import { deriveBrand, deriveTrack, TEAM_TRACK } from '../lib/derive.mjs';
import { accessIdentity } from '../lib/access.mjs';
import { linearKeyFromSessionId } from '../lib/session-id.mjs';

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
// A gate is a question with a fixed set of answers. Free text still exists —
// it rides alongside the choice as a note, never instead of it.
//
// What this closes: a three-option question was answered "Yes". "Yes" names
// none of the three, the client still reported a decision, and an agent
// following its own documentation then picked a direction itself — the one
// thing the gate model exists to prevent. Prose answered against prose will
// keep producing that, so the answer is constrained to what was offered.
//
// Sessions posted without options are untouched by all of it: no options, no
// constraint, free text exactly as before. There is no backfill.

// Option ids are opaque tokens, not prose. They are compared for equality and
// nothing else, and they end up inside the board's onclick attributes — so
// holding them to this alphabet means an id can never carry a quote or markup.
const OPTION_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

// The options stored on a row, as an array. Tolerant of null, of an array
// already parsed, and of malformed JSON, for the same reason labelsOf is on
// the board: one bad row must not take a whole read down with it.
function parseOptions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Options as posted. Returns the normalised array, or a string saying what is
// wrong with them — the agent gets told at post time, rather than the Hub
// storing a gate that nobody can answer.
function normaliseOptions(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return 'options must be a non-empty array of { id, label }';
  }
  const seen = new Set();
  const out = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') return 'each option must be an object with id and label';
    const id = String(o.id === undefined || o.id === null ? '' : o.id).trim();
    const label = String(o.label === undefined || o.label === null ? '' : o.label).trim();
    if (!OPTION_ID.test(id)) {
      return 'option id ' + JSON.stringify(o.id === undefined ? null : o.id) +
             ' is not usable — letters, digits and . _ : - only';
    }
    if (!label) return "option '" + id + "' needs a label";
    if (seen.has(id)) return "duplicate option id '" + id + "'";
    seen.add(id);
    out.push({ id, label, summary: o.summary ? String(o.summary) : null });
  }
  return out;
}

// Whether two option sets are the same question. Re-posting a gate unchanged
// is the agent repeating its state and must change nothing; posting a
// different set is a new question, and a new question cannot keep the old
// answer.
function sameOptions(a, b) {
  const norm = (list) => JSON.stringify(list.map(o => [
    String(o && o.id), String(o && o.label), o && o.summary ? String(o.summary) : '',
  ]));
  return norm(a) === norm(b);
}

// What an option id resolves to, in words. Null when nothing was chosen, or
// when the id names nothing in the set currently stored.
function labelFor(options, optionId) {
  if (!optionId) return null;
  const hit = options.find(o => o && o.id === optionId);
  return hit && hit.label ? hit.label : null;
}

// What kind of decision a row is carrying, and what it amounts to in words.
//
//   'option' — one of the ids the agent offered
//   'own'    — a design the human already drew, named by its Figma section
//   'free'   — a gate with no options at all, answered in prose
//   null     — nothing decided yet
//
// The discriminator is derived rather than stored, so no reserved id has to
// live in the data and `response_option_id` never holds anything that was not
// on the list. An own-design answer is a decision with no option id, which is
// exactly what distinguishes it from an open gate.
function decisionOf(row, options) {
  if (!row.responded_at) return { kind: null, label: null };
  if (row.response_option_id) {
    return { kind: 'option', label: labelFor(options, row.response_option_id) };
  }
  if (options.length) {
    return row.response_note ? { kind: 'own', label: row.response_note }
                             : { kind: null, label: null };
  }
  return { kind: 'free', label: row.response || null };
}

// A row as anything reading it should see it: options as an array rather than
// a JSON blob, and the decision resolved into words alongside the id. A run log
// that says "d2" says nothing about what was decided, and no consumer should
// have to look that up itself.
function withGate(row) {
  if (!row) return row;
  const options = parseOptions(row.options);
  const decision = decisionOf(row, options);
  return {
    ...row,
    options: options.length ? options : null,
    response_kind: decision.kind,
    response_label: decision.label,
  };
}

// Close the round a session is on: the decision goes to gate_decisions, the
// round number moves on, and the session's own answer fields clear. Two paths
// arrive here — the reopen route, and an agent posting a different set of
// options — because they are the same event. The question changed, and the
// previous answer must neither survive onto the new one nor disappear.
// Returns the new round number. The caller owns `status`.
async function closeRound(env, id, row, note) {
  const round = row.gate_round || 1;
  const decided = row.response_option_id || row.response || row.response_note;
  if (decided || note) {
    // The reopen note is the last thing said about the round that is ending,
    // so it is kept with that round. The contract clears the session's own
    // note on reopen and there is no column for a reopen reason, so this row
    // is the only place it survives.
    const trail = [row.response_note, note ? 'Reopened: ' + note : null]
      .filter(Boolean).join('\n\n') || null;
    await env.DB.prepare(
      `INSERT INTO gate_decisions
         (session_id, gate_round, options_snapshot, response_option_id, response_note)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(id, round, row.options || null, row.response_option_id || null, trail).run();
  }
  await env.DB.prepare(
    `UPDATE agent_sessions
        SET gate_round = COALESCE(gate_round, 1) + 1,
            response = NULL, response_option_id = NULL, response_note = NULL,
            responded_at = NULL, updated_at = datetime('now')
      WHERE id = ?`
  ).bind(id).run();
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

// ─── ONE CARD PER LINEAR ISSUE ─────────────────────
// Two writers share agent_sessions and used to disagree about the primary key.
// The reader keys rows `linear/RYV-84`; the agent posts `ryve/ryv-84/research`.
// Neither collided with the other on ON CONFLICT(id), so one Linear issue grew
// two rows and triggering research added a sibling instead of moving the card.
//
// The agent's contract is untouched — it still posts and polls the id it always
// used. These two lookups are what make that id land on the existing card:
// `agent_session_id` remembers the alias, and the Linear issue key extracted
// from it (lib/session-id.mjs) is what joins the two conventions together.

// The row an id names outright: its own primary key, or the agent alias
// recorded on it. Null when neither matches. Primary keys win, so a row whose
// id happens to equal another row's alias is never shadowed.
async function aliasId(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM agent_sessions
      WHERE id = ? OR agent_session_id = ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
      LIMIT 1`
  ).bind(id, id, id).first();
  return row ? row.id : null;
}

// The row an id refers to, however it is written. Falls back to the Linear
// issue the id names, so a session id the Hub has never been posted under —
// a later phase running as its own session, `ryve/ryv-84/design` after
// `ryve/ryv-84/research` — still reaches the card for that issue instead of
// a 404. Null when nothing matches.
async function canonicalId(env, id) {
  return (await aliasId(env, id)) ||
         (await rowIdForLinearKey(env, linearKeyFromSessionId(id)));
}

// A path segment as a row id: decoded, then resolved through the aliases.
// Falls back to the id as asked for, so a miss still reaches the route's own
// "not found" check rather than turning into a different error here.
async function resolveId(env, segment) {
  const asked = decodeURIComponent(segment || '');
  return (await canonicalId(env, asked)) || asked;
}

// The row that already owns a Linear issue key, whichever writer created it:
// the reader (`linear_id`) or the agent (a session id with the key in it).
// This is the join the two id conventions share.
async function rowIdForLinearKey(env, key) {
  if (!key) return null;
  const row = await env.DB.prepare(
    `SELECT id FROM agent_sessions
      WHERE linear_id = ?
         OR '/' || lower(COALESCE(agent_session_id, id)) || '/'
            LIKE '%/' || lower(?) || '/%'
      ORDER BY CASE WHEN linear_id = ? THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`
  ).bind(key, key, key).first();
  return row ? row.id : null;
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
    `SELECT DISTINCT team AS name FROM agent_sessions WHERE team IS NOT NULL ORDER BY team`
  ).all();
  return { teams: (results || []).map((r) => r.name).filter(Boolean), from: 'seen' };
}

// ─── LINEAR READER ─────────────────────────────────
// Pulls every issue assigned to Dave Bell, across all teams, in any open
// state. No label filter — gathering is not triggering.
// Writes one agent_sessions row per new issue with status = 'waiting'.
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
    // the card to show where its brand section is not self-evident. Note the
    // prefix: the column called `project` holds the *brand* id, because brands
    // are rows in the `projects` table and predate the reader by a layer.
    const linearProject = (issue.project && issue.project.name) || null;
    // An issue can arrive already labelled no-design, dismissed in Linear
    // before the Hub ever saw it.
    const dismissedAt = hasNoDesign(issue) ? nowStamp() : null;

    // Upsert rather than skip. Rows written before the Piece 4 columns existed
    // have no linear_uuid, and without it the trigger button has nothing to
    // apply a label to. Refreshing on every read also keeps linear_state
    // current, which is what sorts a card into Queued vs Backlog.
    //
    // Only Linear-owned facts get overwritten. Anything the human or the agent
    // owns — status, phase, prompt, response, triggered_at, figma_url — is left
    // alone, and a manual brand/track reassignment survives because those two
    // are only filled in when still null.
    //
    // The row id is whatever row already owns this issue — including one the
    // agent created first under its own session id — and only falls back to
    // `linear/<KEY>` for an issue nothing has seen yet. Without that, an
    // agent-first row and a reader row are two cards for one issue.
    const existingId = await rowIdForLinearKey(env, issue.identifier);

    await env.DB.prepare(
      `INSERT INTO agent_sessions
         (id, system, project, track, phase, status, prompt, detail, url,
          linear_id, team, linear_uuid, linear_state, title, dismissed_at, labels,
          linear_project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project      = COALESCE(agent_sessions.project, excluded.project),
         track        = COALESCE(agent_sessions.track, excluded.track),
         -- The Linear description, unless the agent has posted to this row:
         -- once it has, detail carries the context behind its decision
         -- prompt, and a Wednesday read must not wipe that.
         detail       = CASE WHEN agent_sessions.agent_session_id IS NULL
                             THEN excluded.detail ELSE agent_sessions.detail END,
         url          = excluded.url,
         team         = excluded.team,
         -- An agent-first row arrives with no linear_id; this is what links it
         -- to its issue, so the next read finds it instead of inserting again.
         linear_id    = excluded.linear_id,
         linear_uuid  = excluded.linear_uuid,
         linear_state = excluded.linear_state,
         title        = excluded.title,
         -- COALESCE, so a read can only ever ADD a dismissal, never clear one.
         -- A dismissed card cannot be resurrected onto the board by the cron
         -- if the label mutation has not propagated yet. Un-dismissing is the
         -- Hub's Undo control, which removes the label first.
         dismissed_at = COALESCE(agent_sessions.dismissed_at, excluded.dismissed_at),
         -- Linear owns the label set outright. stage-done writes here too, so
         -- a card moves the moment a stage finishes; this read reconciles it
         -- with whatever Linear actually has.
         labels       = excluded.labels,
         -- Linear-owned like the rest of these, so it refreshes every pass.
         linear_project = excluded.linear_project,
         updated_at   = datetime('now')`
    ).bind(
      existingId || ('linear/' + issue.identifier),
      'design-ai',
      brand,
      track,
      'research',
      'waiting',
      'Run design research on ' + issue.identifier + '?',
      detail,
      issue.url,
      issue.identifier,
      teamName,
      issue.id,
      linearState || null,
      issue.title,
      dismissedAt,
      labelNames,
      linearProject
    ).run();
    if (existingId) { updated++; } else { inserted++; }
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
    `SELECT id, linear_uuid FROM agent_sessions WHERE linear_uuid IS NOT NULL`
  ).all();
  const rows = results || [];
  if (!rows.length) return 0;

  const byUuid = new Map(rows.map(r => [r.linear_uuid, r.id]));
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
      `UPDATE agent_sessions
       SET linear_state = COALESCE(?, linear_state),
           dismissed_at = COALESCE(dismissed_at, ?),
           updated_at = datetime('now')
       WHERE id = ?`
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

    // POST /api/agent/session — agent writes or updates its state (upsert by id)
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
      const project = b.project || b.brand || null;
      const track = b.track || null;
      const phase = b.phase || b.stage || null;
      const url = b.url || null;
      const title = b.title || null;

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

      // Which row this post belongs to. The agent's own session id first —
      // that is the row it has been writing to all along — then the Linear
      // issue its session id names, which is how `ryve/ryv-84/research` lands
      // on the card the reader already made for RYV-84 instead of beside it.
      // `linear_id` in the body is honoured if sent, but nothing has to send
      // it: the key is derivable from the session id the agent already posts.
      const key = String(b.linear_id || linearKeyFromSessionId(b.session_id) || '')
        .toUpperCase() || null;
      const target = (await aliasId(env, b.session_id)) ||
                     (key ? await rowIdForLinearKey(env, key) : null);

      if (target) {
        // A different set of options supersedes a decision that has already
        // been made, so that decision is archived and cleared rather than left
        // sitting on the new question: a round-1 `d1` answering a round-2 gate
        // is the "Yes" bug wearing an id.
        //
        // Two things deliberately do not move the round on. The same set
        // re-posted is the agent repeating its state as it works, and must not
        // wipe an answer given a second earlier. A new set replacing a gate
        // nobody has answered yet is just the question being rewritten — there
        // is no decision to supersede, and no round to archive.
        const prev = await env.DB.prepare(
          `SELECT id, options, gate_round, response, response_option_id, response_note
             FROM agent_sessions WHERE id = ?`
        ).bind(target).first();
        if (options && prev && (prev.response_option_id || prev.response) &&
            !sameOptions(parseOptions(prev.options), parseOptions(options))) {
          await closeRound(env, target, prev, null);
        }

        // Agent-owned columns are written straight through, exactly as the
        // upsert did. The four Linear-owned ones — project, track, url,
        // title — are only filled in where they are still empty, so merging
        // onto a Linear card cannot rename it, relink it, or undo a manual
        // brand reassignment. On a Hub-only session (no Linear issue behind
        // it) there is nothing to protect and the agent still owns them.
        await env.DB.prepare(
          `UPDATE agent_sessions SET
             agent_session_id = ?,
             system    = ?,
             phase     = ?,
             status    = ?,
             prompt    = ?,
             detail    = COALESCE(?, detail),
             figma_url = COALESCE(?, figma_url),
             options   = COALESCE(?, options),
             project   = CASE WHEN linear_id IS NULL
                              THEN COALESCE(?, project) ELSE COALESCE(project, ?) END,
             track     = CASE WHEN linear_id IS NULL
                              THEN COALESCE(?, track) ELSE COALESCE(track, ?) END,
             url       = CASE WHEN linear_id IS NULL
                              THEN COALESCE(?, url) ELSE COALESCE(url, ?) END,
             title     = CASE WHEN linear_id IS NULL
                              THEN COALESCE(?, title) ELSE COALESCE(title, ?) END,
             updated_at = datetime('now')
           WHERE id = ?`
        ).bind(
          b.session_id, b.system, phase, status, b.prompt || null, b.detail || null,
          b.figma_url || null, options,
          project, project, track, track, url, url, title, title,
          target
        ).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO agent_sessions
             (id, agent_session_id, system, project, track, phase, status,
              prompt, detail, url, figma_url, title, linear_id, options)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           -- Unreachable unless two posts for a brand-new session race each
           -- other, but this route was an upsert before and stays one.
           ON CONFLICT(id) DO UPDATE SET
             agent_session_id=excluded.agent_session_id, system=excluded.system,
             project=excluded.project, track=excluded.track, phase=excluded.phase,
             status=excluded.status, prompt=excluded.prompt, detail=excluded.detail,
             url=excluded.url, figma_url=excluded.figma_url, title=excluded.title,
             options=COALESCE(excluded.options, options),
             updated_at=datetime('now')`
        ).bind(
          b.session_id, b.session_id, b.system, project, track, phase, status,
          b.prompt || null, b.detail || null, url, b.figma_url || null, title, key,
          options
        ).run();
      }
      return json({ ok: true, session_id: b.session_id, status });
    }

    // GET /api/agent/session/:id — agent polls for the human's response
    if (method === 'GET' && path.startsWith('/api/agent/session/') && !path.includes('/trigger') && !path.includes('/reassign') && !path.includes('/respond') && !path.includes('/dismiss')) {
      const asked = decodeURIComponent(path.slice('/api/agent/session/'.length));
      if (!asked) return err('session_id required');
      // The agent polls by the session id it posted; after a merge that id is
      // an alias for the card's row, so resolve it before reading.
      const id = (await canonicalId(env, asked)) || asked;
      const row = await env.DB.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).bind(id).first();
      if (!row) return err('not found', 404);
      return json(withGate(row));
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
      const id = await resolveId(env, path.split('/')[4]);
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!STAGES.includes(b.stage)) {
        return err(`stage must be one of: ${STAGES.join(', ')}`);
      }
      const row = await env.DB.prepare(
        `SELECT linear_uuid, requested_stage FROM agent_sessions WHERE id = ?`
      ).bind(id).first();
      if (!row) return err('not found', 404);
      // The runner works from the Linear issue, so a row with nothing behind it
      // in Linear has nothing to run against.
      if (!row.linear_uuid) return err('session has no linked Linear issue');
      if (row.requested_stage) {
        return err(`already queued for ${row.requested_stage}`, 409);
      }

      await env.DB.prepare(
        `UPDATE agent_sessions
         SET requested_stage = ?, requested_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ?`
      ).bind(b.stage, id).run();

      // What the runner will find when it reads the queue, including the row
      // just written. Deliberately the same WHERE clause as /api/agent/queue:
      // if the two ever disagreed, the Hub would be telling the runner to take
      // a number of issues it is not going to be shown.
      const queued = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM agent_sessions
           WHERE requested_stage IS NOT NULL
             AND dismissed_at IS NULL
             AND set_aside_at IS NULL`
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
      const id = await resolveId(env, path.split('/')[4]);
      const row = await env.DB.prepare(
        `SELECT requested_stage, status FROM agent_sessions WHERE id = ?`
      ).bind(id).first();
      if (!row) return err('not found', 404);

      // Both CASEs read the row as it was, so clearing the prompt keys off the
      // old status rather than the one being written in the same statement.
      await env.DB.prepare(
        `UPDATE agent_sessions
            SET requested_stage = NULL,
                requested_at    = NULL,
                status = CASE WHEN status = 'error' THEN 'waiting' ELSE status END,
                prompt = CASE WHEN status = 'error' THEN NULL ELSE prompt END,
                updated_at = datetime('now')
          WHERE id = ?`
      ).bind(id).run();

      return json({ ok: true, cleared: row.requested_stage || null,
                    was: row.status || null });
    }

    // GET /api/agent/queue — what the runner asks for instead of polling
    // Linear. Oldest request first, so a button pressed on Monday is not
    // starved by one pressed this morning.
    if (method === 'GET' && path === '/api/agent/queue') {
      const { results } = await env.DB.prepare(
        `SELECT id, linear_id, linear_uuid, title, project, track, team,
                requested_stage, requested_at
           FROM agent_sessions
          WHERE requested_stage IS NOT NULL
            AND dismissed_at IS NULL
            AND set_aside_at IS NULL
          ORDER BY requested_at ASC`
      ).all();
      return json(results || []);
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
      const id = await rowIdForLinearKey(env, String(b.linear_id).toUpperCase());
      if (!id) return err(`no row for Linear issue ${b.linear_id}`, 404);
      const row = await env.DB.prepare(
        `SELECT linear_uuid, labels FROM agent_sessions WHERE id = ?`
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

      await env.DB.prepare(
        `UPDATE agent_sessions
         SET labels = ?, requested_stage = NULL, requested_at = NULL,
             status = 'done', updated_at = datetime('now')
         WHERE id = ?`
      ).bind(JSON.stringify(labels), id).run();
      return json({ ok: true, label: name, stage: b.stage });
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
      const id = await resolveId(env, path.split('/')[4]);
      const row = await env.DB.prepare(
        `SELECT linear_uuid FROM agent_sessions WHERE id = ?`
      ).bind(id).first();
      if (!row) return err('not found', 404);
      if (!row.linear_uuid) return err('session has no linked Linear issue');

      const labelId = await getLabelId(env, 'no-design');
      if (!labelId) return err('Linear label "no-design" not found', 502);

      if (method === 'POST') {
        const res = await addLabelToIssue(env, row.linear_uuid, labelId);
        if (res.error) return err('Linear mutation failed: ' + JSON.stringify(res.error), 502);
        await env.DB.prepare(
          `UPDATE agent_sessions
           SET dismissed_at = COALESCE(dismissed_at, datetime('now')),
               updated_at = datetime('now')
           WHERE id = ?`
        ).bind(id).run();
        return json({ ok: true, dismissed: true });
      }

      const res = await removeLabelFromIssue(env, row.linear_uuid, labelId);
      if (res.error) return err('Linear mutation failed: ' + JSON.stringify(res.error), 502);
      await env.DB.prepare(
        `UPDATE agent_sessions SET dismissed_at = NULL, updated_at = datetime('now')
         WHERE id = ?`
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
      const id = await resolveId(env, path.split('/')[4]);
      const row = await env.DB.prepare(
        `SELECT requested_stage FROM agent_sessions WHERE id = ?`
      ).bind(id).first();
      if (!row) return err('not found', 404);

      if (method === 'POST') {
        // Setting aside clears any queued run with it. A card you have just
        // told the agents to leave alone must not still be sitting in the
        // queue they read — and /api/agent/queue filters this column now, so
        // leaving the entry would strand a row nothing will ever come back to.
        //
        // COALESCE so a second press does not move the timestamp: when it was
        // set aside is a fact worth keeping.
        await env.DB.prepare(
          `UPDATE agent_sessions
              SET set_aside_at = COALESCE(set_aside_at, datetime('now')),
                  requested_stage = NULL,
                  requested_at = NULL,
                  updated_at = datetime('now')
            WHERE id = ?`
        ).bind(id).run();
        return json({ ok: true, set_aside: true, cleared: row.requested_stage || null });
      }

      await env.DB.prepare(
        `UPDATE agent_sessions SET set_aside_at = NULL, updated_at = datetime('now')
          WHERE id = ?`
      ).bind(id).run();
      return json({ ok: true, set_aside: false });
    }

    // POST /api/agent/session/:id/complete — mark the issue done in Linear.
    //
    // The board could put a card aside and it could file it under No design,
    // but the one thing it could not say was "this is finished" — that meant
    // opening Linear, which is the trip the Hub exists to save.
    //
    // It resolves the state rather than naming one: see completedStateFor.
    // Linear first and the local row second, which is the same ordering the
    // dismiss route follows and for the same reason — a card moved to Completed
    // here but not there is put back by the next reconciliation pass, and
    // flickers on and off the board with every read.
    if (method === 'POST' && path.match(/^\/api\/agent\/session\/[^/]+\/complete$/)) {
      const id = await resolveId(env, path.split('/')[4]);
      const row = await env.DB.prepare(
        `SELECT linear_uuid FROM agent_sessions WHERE id = ?`
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
        `UPDATE agent_sessions
            SET linear_state = 'completed',
                requested_stage = NULL,
                requested_at = NULL,
                updated_at = datetime('now')
          WHERE id = ?`
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
      await env.DB.prepare(
        `INSERT INTO agent_heartbeats (machine, capabilities, last_seen, first_seen)
           VALUES (?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(machine) DO UPDATE SET
           capabilities = excluded.capabilities,
           last_seen    = excluded.last_seen`
      ).bind(b.machine, capabilities).run();
      return json({ ok: true });
    }

    // GET /api/agent/heartbeat — every machine that has ever checked in, most
    // recent first. What the board reads to say whether a press that queues
    // local-only work will actually be picked up, or is sitting there with
    // nobody listening.
    if (method === 'GET' && path === '/api/agent/heartbeat') {
      const { results } = await env.DB.prepare(
        `SELECT machine, capabilities, last_seen, first_seen
           FROM agent_heartbeats ORDER BY last_seen DESC`
      ).all();
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
        const id = (await canonicalId(env, String(asked))) || String(asked);
        const row = await env.DB.prepare(
          `SELECT id FROM agent_sessions WHERE id = ?`
        ).bind(id).first();
        if (!row) continue;
        await env.DB.prepare(
          `UPDATE agent_sessions
              SET set_aside_at = COALESCE(set_aside_at, datetime('now')),
                  requested_stage = NULL,
                  requested_at = NULL,
                  updated_at = datetime('now')
            WHERE id = ?`
        ).bind(id).run();
        n++;
      }
      return json({ ok: true, set_aside: n, asked: ids.length });
    }

    // PATCH /api/agent/session/:id/reassign — manual brand/track correction
    // for when the Linear Reader's auto-detected brand is wrong.
    if (method === 'PATCH' && path.match(/^\/api\/agent\/session\/[^/]+\/reassign$/)) {
      const id = await resolveId(env, path.split('/')[4]);
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      const fields = []; const values = [];
      if (b.project !== undefined) { fields.push('project = ?'); values.push(b.project); }
      if (b.track !== undefined) { fields.push('track = ?'); values.push(b.track); }
      if (!fields.length) return err('project or track required');
      fields.push("updated_at = datetime('now')");
      values.push(id);
      await env.DB.prepare(`UPDATE agent_sessions SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
      return json({ ok: true });
    }

    // GET /api/agent/sessions — dashboard list, newest first
    if (method === 'GET' && path === '/api/agent/sessions') {
      const rows = await env.DB.prepare(
        `SELECT * FROM agent_sessions
         ORDER BY CASE status WHEN 'waiting' THEN 0 WHEN 'error' THEN 1
                              WHEN 'active' THEN 2 ELSE 3 END,
                  updated_at DESC`
      ).all();
      return json((rows.results || []).map(withGate));
    }

    // PATCH /api/agent/session/:id/respond — human answers the prompt.
    //
    // When the gate offers options the answer has to name one of them. A note
    // on its own is never a decision: that is the whole point, and it is what
    // stops "Yes" from reading as a direction. A gate with no options is
    // answered in free text exactly as it always was.
    if (method === 'PATCH' && path.match(/\/respond$/)) {
      const id = await resolveId(
        env, path.slice('/api/agent/session/'.length, path.length - '/respond'.length)
      );
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      const existing = await env.DB.prepare(
        `SELECT id, options FROM agent_sessions WHERE id = ?`
      ).bind(id).first();
      if (!existing) return err('not found', 404);

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
            `UPDATE agent_sessions
                SET response_option_id = NULL, response_note = ?, response = ?,
                    responded_at = datetime('now'),
                    status = 'active', updated_at = datetime('now')
              WHERE id = ?`
          ).bind(section, section, id).run();
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
          `UPDATE agent_sessions
              SET response_option_id = ?, response_note = ?, response = ?,
                  responded_at = datetime('now'),
                  status = 'active', updated_at = datetime('now')
            WHERE id = ?`
        ).bind(chosen.id, b.response_note || null, chosen.label, id).run();
        return json({ ok: true, response_kind: 'option',
                      response_option_id: chosen.id, response_label: chosen.label });
      }

      if (!b.response) return err('response required');
      await env.DB.prepare(
        `UPDATE agent_sessions
         SET response = ?, response_note = ?, responded_at = datetime('now'),
             status = 'active', updated_at = datetime('now')
         WHERE id = ?`
      ).bind(b.response, b.response_note || null, id).run();
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
      const id = await resolveId(
        env, path.slice('/api/agent/session/'.length, path.length - '/reopen'.length)
      );
      // The note is optional, and so is the body that would carry it.
      let b = {};
      try { b = (await request.json()) || {}; } catch { b = {}; }
      const row = await env.DB.prepare(
        `SELECT id, options, gate_round, response, response_option_id, response_note
           FROM agent_sessions WHERE id = ?`
      ).bind(id).first();
      if (!row) return err('not found', 404);

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
      const round = await closeRound(env, id, row, note || null);
      await env.DB.prepare(
        `UPDATE agent_sessions SET status = 'waiting', updated_at = datetime('now')
          WHERE id = ?`
      ).bind(id).run();
      return json({ ok: true, gate_round: round, status: 'waiting' });
    }

    // PATCH /api/agent/session/:id/state — the two completion levels that had
    // nowhere to live. "AI-design done" means a spec was written; mockups_at
    // means something was actually drawn; handoff_at means a developer can
    // pick it up. The Hub stores all three and interprets none of them.
    if (method === 'PATCH' && path.startsWith('/api/agent/session/') && path.endsWith('/state')) {
      const id = await resolveId(
        env, path.slice('/api/agent/session/'.length, path.length - '/state'.length)
      );
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      const existing = await env.DB.prepare(
        `SELECT id FROM agent_sessions WHERE id = ?`
      ).bind(id).first();
      if (!existing) return err('not found', 404);

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
      values.push(id);
      await env.DB.prepare(
        `UPDATE agent_sessions SET ${fields.join(', ')} WHERE id = ?`
      ).bind(...values).run();
      return json({ ok: true });
    }

    // DELETE /api/agent/session/:id
    if (method === 'DELETE' && path.startsWith('/api/agent/session/')) {
      const id = await resolveId(env, path.slice('/api/agent/session/'.length));
      await env.DB.prepare(`DELETE FROM agent_sessions WHERE id = ?`).bind(id).run();
      return json({ ok: true });
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

    // POST /api/read-linear — run the Linear Reader on demand
  if (method === 'POST' && path === '/api/read-linear') {
    const result = await readLinear(env);
    return json(result);
  }

  // GET /api/sessions — waiting agent_sessions rows, newest first
  if (method === 'GET' && path === '/api/sessions') {
    const { results } = await env.DB.prepare(
      `SELECT * FROM agent_sessions WHERE status = 'waiting' ORDER BY created_at DESC`
    ).all();
    return json((results || []).map(withGate));
  }

  return err('not found', 404);
}
