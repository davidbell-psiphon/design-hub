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

// ─── LINEAR READER ─────────────────────────────────
// Pulls every issue assigned to Dave Bell, across all teams, sitting in
// Backlog or Todo. No label filter — gathering is not triggering.
// Writes one agent_sessions row per new issue with status = 'waiting'.
// Idempotent: skips issues whose linear_id already has a row.
//
// Team names that map to exactly one brand go straight into TEAM_BRAND.
// 'Websites' (and any other unmapped team) covers multiple brands, so its
// brand is guessed from the issue's Linear project name, then labels, then
// title — e.g. project "Conduit Website" -> brand "conduit". A guess of
// null just means the card needs a manual brand assignment in the Hub.
const TEAM_BRAND = {
  'Conduit App': 'conduit',
  'Ryve App': 'ryve',
  'Psiphon App': 'psiphon',
  'Forge': 'forge',
};
const TEAM_TRACK = {
  'Conduit App': 'app',
  'Ryve App': 'app',
  'Psiphon App': 'app',
  'Forge': 'website',
  'Websites': 'website',
};
const BRAND_KEYWORDS = ['conduit', 'ryve', 'psiphon', 'forge'];

function detectBrand(issue) {
  const haystacks = [
    issue.project && issue.project.name,
    ...((issue.labels && issue.labels.nodes) || []).map(l => l.name),
    issue.title,
  ].filter(Boolean).map(s => s.toLowerCase());
  for (const text of haystacks) {
    const hit = BRAND_KEYWORDS.find(brand => text.includes(brand));
    if (hit) return hit;
  }
  return null;
}

async function readLinear(env) {
  const query = `
    query DesignReaderIssues {
      issues(
        first: 100
        filter: {
          state: { type: { in: ["backlog", "unstarted"] } }
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
    const track = TEAM_TRACK[teamName] || null;
    const brand = TEAM_BRAND[teamName] || detectBrand(issue);

    const detail = (issue.description || '').slice(0, 300) || null;
    const linearState = issue.state && issue.state.type; // 'backlog' | 'unstarted'

    // Upsert rather than skip. Rows written before the Piece 4 columns existed
    // have no linear_uuid, and without it the trigger button has nothing to
    // apply a label to. Refreshing on every read also keeps linear_state
    // current, which is what sorts a card into Queued vs Backlog.
    //
    // Only Linear-owned facts get overwritten. Anything the human or the agent
    // owns — status, phase, prompt, response, triggered_at, figma_url — is left
    // alone, and a manual brand/track reassignment survives because those two
    // are only filled in when still null.
    const existing = await env.DB.prepare(
      `SELECT id FROM agent_sessions WHERE linear_id = ?`
    ).bind(issue.identifier).first();

    await env.DB.prepare(
      `INSERT INTO agent_sessions
         (id, system, project, track, phase, status, prompt, detail, url,
          linear_id, team, linear_uuid, linear_state, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project      = COALESCE(agent_sessions.project, excluded.project),
         track        = COALESCE(agent_sessions.track, excluded.track),
         detail       = excluded.detail,
         url          = excluded.url,
         team         = excluded.team,
         linear_uuid  = excluded.linear_uuid,
         linear_state = excluded.linear_state,
         title        = excluded.title,
         updated_at   = datetime('now')`
    ).bind(
      'linear/' + issue.identifier,
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
      issue.title
    ).run();
    if (existing) { updated++; } else { inserted++; }
  }

  return { inserted, updated, skipped };
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

// ─── ACCESS IDENTITY ──────────────────────────────────
// Verifies the JWT Cloudflare Access injects as Cf-Access-Jwt-Assertion, which
// the Pages proxy forwards on. Hand-rolled against WebCrypto rather than
// pulling in `jose`: this repo has no package.json and no build step, and a
// dependency here would mean an npm install on every deploy.
//
// Enforcement is off until ACCESS_AUD and ACCESS_TEAM are set as secrets, so
// this ships without breaking anything; setting them is what turns it on.

let _keys = null;
let _keysAt = 0;

async function accessKeys(env) {
  const now = Date.now();
  if (_keys && now - _keysAt < 3600_000) return _keys;
  const res = await fetch(`https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) return null;
  const body = await res.json();
  _keys = body.keys || null;
  _keysAt = now;
  return _keys;
}

function b64url(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(str) {
  return JSON.parse(new TextDecoder().decode(b64url(str)));
}

// Returns the token payload, or null. Null means "not a valid human request",
// never "probably fine".
async function accessIdentity(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion') ||
    (request.headers.get('Cookie') || '').match(/CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch { return null; }
  if (header.alg !== 'RS256') return null;

  const keys = await accessKeys(env);
  const jwk = keys && keys.find(k => k.kid === header.kid);
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch { return null; }
  if (!ok) return null;

  // Signature is good; the claims still have to be ours and current.
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return null;
  if (!payload.exp || payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now + 60) return null;

  return payload;
}

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
      await env.DB.prepare(
        `INSERT INTO agent_sessions (id, system, project, track, phase, status, prompt, detail, url, figma_url, title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           system=excluded.system, project=excluded.project, track=excluded.track,
           phase=excluded.phase, status=excluded.status, prompt=excluded.prompt,
           detail=excluded.detail, url=excluded.url, figma_url=excluded.figma_url,
           title=excluded.title, updated_at=datetime('now')`
      ).bind(
        b.session_id, b.system, b.project || b.brand || null, b.track || null,
        b.phase || b.stage || null, status, b.prompt || null, b.detail || null,
        b.url || null, b.figma_url || null, b.title || null
      ).run();
      return json({ ok: true, session_id: b.session_id, status });
    }

    // GET /api/agent/session/:id — agent polls for the human's response
    if (method === 'GET' && path.startsWith('/api/agent/session/') && !path.includes('/trigger') && !path.includes('/reassign') && !path.includes('/respond')) {
      const id = decodeURIComponent(path.slice('/api/agent/session/'.length));
      if (!id) return err('session_id required');
      const row = await env.DB.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).bind(id).first();
      if (!row) return err('not found', 404);
      return json(row);
    }

    // POST /api/agent/session/:id/trigger — human presses a card button.
    // Applies a Linear label; that label is the entire trigger mechanism.
    if (method === 'POST' && path.match(/^\/api\/agent\/session\/[^/]+\/trigger$/)) {
      const id = decodeURIComponent(path.split('/')[4]);
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!['go', 'qa'].includes(b.action)) return err('action must be "go" or "qa"');
      const row = await env.DB.prepare(`SELECT linear_uuid FROM agent_sessions WHERE id = ?`).bind(id).first();
      if (!row) return err('not found', 404);
      if (!row.linear_uuid) return err('session has no linked Linear issue');

      const labelNames = b.action === 'go'
        ? ['design-ai:go', ...(b.noResearch ? ['no-research'] : [])]
        : ['design-ai:qa'];

      for (const name of labelNames) {
        const labelId = await getLabelId(env, name);
        if (!labelId) return err(`Linear label "${name}" not found`, 502);
        const res = await addLabelToIssue(env, row.linear_uuid, labelId);
        if (res.error) return err('Linear mutation failed: ' + JSON.stringify(res.error), 502);
      }

      await env.DB.prepare(
        `UPDATE agent_sessions
         SET triggered_at = COALESCE(triggered_at, datetime('now')), updated_at = datetime('now')
         WHERE id = ?`
      ).bind(id).run();
      return json({ ok: true, labels: labelNames });
    }

    // PATCH /api/agent/session/:id/reassign — manual brand/track correction
    // for when the Linear Reader's auto-detected brand is wrong.
    if (method === 'PATCH' && path.match(/^\/api\/agent\/session\/[^/]+\/reassign$/)) {
      const id = decodeURIComponent(path.split('/')[4]);
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
      return json(rows.results);
    }

    // PATCH /api/agent/session/:id/respond — human answers the prompt
    if (method === 'PATCH' && path.match(/\/respond$/)) {
      const id = decodeURIComponent(
        path.slice('/api/agent/session/'.length, path.length - '/respond'.length)
      );
      let b;
      try { b = await request.json(); } catch { return err('Invalid JSON'); }
      if (!b.response) return err('response required');
      const existing = await env.DB.prepare(`SELECT id FROM agent_sessions WHERE id = ?`).bind(id).first();
      if (!existing) return err('not found', 404);
      await env.DB.prepare(
        `UPDATE agent_sessions
         SET response = ?, responded_at = datetime('now'),
             status = 'active', updated_at = datetime('now')
         WHERE id = ?`
      ).bind(b.response, id).run();
      return json({ ok: true });
    }

    // DELETE /api/agent/session/:id
    if (method === 'DELETE' && path.startsWith('/api/agent/session/')) {
      const id = decodeURIComponent(path.slice('/api/agent/session/'.length));
      await env.DB.prepare(`DELETE FROM agent_sessions WHERE id = ?`).bind(id).run();
      return json({ ok: true });
    }




    // GET /api/brands — the board's only structural read.
    // Brand identity still lives in `projects` rows under the 'brands'
    // section: that is where the current brand colours are, and keeping them
    // in D1 means a colour change is an UPDATE, not a deploy. The rest of
    // that table's UI is gone; these three columns are all the board reads.
    if (method === 'GET' && path === '/api/brands') {
      const { results } = await env.DB.prepare(
        `SELECT id, name, color FROM projects WHERE section_id = 'brands' ORDER BY sort_order`
      ).all();
      return json(results || []);
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
    return json(results || []);
  }

  return err('not found', 404);
}
