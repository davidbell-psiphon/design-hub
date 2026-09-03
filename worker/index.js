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
function uid() { return crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,''); }

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 310000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function generateSalt() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function getSessionCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

async function validateSession(env, request) {
  const token = getSessionCookie(request);
  if (!token) return false;
  const session = await env.DB.prepare(
    `SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return !!session;
}

function sessionCookieHeader(token, clear = false) {
  if (clear) return 'session=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0';
  return `session=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=86400`;
}

async function checkRateLimit(env, ip) {
  const key = `ratelimit:${ip}`;
  const row = await env.DB.prepare(`SELECT attempts, locked_until FROM rate_limits WHERE key = ?`).bind(key).first();
  if (row && row.locked_until) {
    const lockedUntil = new Date(row.locked_until + 'Z');
    if (lockedUntil > new Date()) {
      const mins = Math.ceil((lockedUntil - new Date()) / 60000);
      return { blocked: true, message: `Too many attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.` };
    }
  }
  return { blocked: false };
}

async function recordFailedAttempt(env, ip) {
  const key = `ratelimit:${ip}`;
  const row = await env.DB.prepare(`SELECT attempts FROM rate_limits WHERE key = ?`).bind(key).first();
  const attempts = (row ? row.attempts : 0) + 1;
  const lockedUntil = attempts >= 5
    ? new Date(Date.now() + 15 * 60 * 1000).toISOString().replace('T',' ').split('.')[0]
    : null;
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, attempts, locked_until) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET attempts = ?, locked_until = ?`
  ).bind(key, attempts, lockedUntil, attempts, lockedUntil).run();
}

async function clearRateLimit(env, ip) {
  await env.DB.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(`ratelimit:${ip}`).run();
}

export default {
  async fetch(request, env) {
    _req = request;
    try {
      return await route(request, env);
    } catch (e) {
      return err('Server error: ' + (e && e.message ? e.message : String(e)), 500);
    }
  },
};

async function route(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
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
      await env.DB.prepare(
        `INSERT INTO agent_sessions (id, system, project, phase, status, prompt, detail, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           system=excluded.system, project=excluded.project, phase=excluded.phase,
           status=excluded.status, prompt=excluded.prompt, detail=excluded.detail,
           url=excluded.url, updated_at=datetime('now')`
      ).bind(
        b.session_id, b.system, b.project || null, b.phase || null,
        status, b.prompt || null, b.detail || null, b.url || null
      ).run();
      return json({ ok: true, session_id: b.session_id, status });
    }

    // GET /api/agent/session/:id — agent polls for the human's response
    if (method === 'GET' && path.startsWith('/api/agent/session/')) {
      const id = decodeURIComponent(path.slice('/api/agent/session/'.length));
      if (!id) return err('session_id required');
      const row = await env.DB.prepare(
        `SELECT id, system, project, phase, status, prompt, response, responded_at, updated_at
         FROM agent_sessions WHERE id = ?`
      ).bind(id).first();
      if (!row) return err('not found', 404);
      return json(row);
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

    // GET /api/sidebar
    if (method === 'GET' && path === '/api/sidebar') {
      const sections = await env.DB.prepare(`SELECT * FROM sections ORDER BY sort_order`).all();
      const result = [];
      for (const section of sections.results) {
        const projects = await env.DB.prepare(
          `SELECT p.*, (SELECT COUNT(*) FROM chats c WHERE c.project_id = p.id AND c.status != 'done') as active_count
           FROM projects p WHERE p.section_id = ? ORDER BY p.sort_order`
        ).bind(section.id).all();
        result.push({ ...section, projects: projects.results });
      }
      return json(result);
    }

    // GET /api/projects/:id
    if (method === 'GET' && path.match(/^\/api\/projects\/[\w-]+$/)) {
      const projectId = path.split('/')[3];
      const project = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?`).bind(projectId).first();
      if (!project) return err('not found', 404);
      const capabilities = await env.DB.prepare(`SELECT * FROM capabilities WHERE project_id = ? ORDER BY sort_order`).bind(projectId).all();
      const resources = await env.DB.prepare(`SELECT * FROM resources WHERE project_id = ? ORDER BY sort_order`).bind(projectId).all();
      const chats = await env.DB.prepare(`SELECT * FROM chats WHERE project_id = ? ORDER BY created_at DESC`).bind(projectId).all();
      return json({ ...project, capabilities: capabilities.results, resources: resources.results, chats: chats.results });
    }

    // POST /api/capabilities
    if (method === 'POST' && path === '/api/capabilities') {
      const body = await request.json();
      if (!body.project_id || !body.label) return err('project_id and label required');
      const id = uid();
      await env.DB.prepare(`INSERT INTO capabilities (id, project_id, label) VALUES (?, ?, ?)`).bind(id, body.project_id, body.label).run();
      return json({ id, ...body }, 201);
    }

    // DELETE /api/capabilities/:id
    if (method === 'DELETE' && path.match(/^\/api\/capabilities\/[\w-]+$/)) {
      await env.DB.prepare(`DELETE FROM capabilities WHERE id = ?`).bind(path.split('/')[3]).run();
      return json({ ok: true });
    }

    // POST /api/resources
    if (method === 'POST' && path === '/api/resources') {
      const body = await request.json();
      if (!body.project_id || !body.label || !body.url || !body.type) return err('project_id, label, url, type required');
      const id = uid();
      await env.DB.prepare(`INSERT INTO resources (id, project_id, label, url, type) VALUES (?, ?, ?, ?, ?)`).bind(id, body.project_id, body.label, body.url, body.type).run();
      return json({ id, ...body }, 201);
    }

    // DELETE /api/resources/:id
    if (method === 'DELETE' && path.match(/^\/api\/resources\/[\w-]+$/)) {
      await env.DB.prepare(`DELETE FROM resources WHERE id = ?`).bind(path.split('/')[3]).run();
      return json({ ok: true });
    }

    // POST /api/chats
    if (method === 'POST' && path === '/api/chats') {
      const body = await request.json();
      if (!body.project_id || !body.title || !body.type) return err('project_id, title, type required');
      const id = uid();
      await env.DB.prepare(
        `INSERT INTO chats (id, project_id, title, notes, type, status, url) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, body.project_id, body.title, body.notes||null, body.type, body.status||'active', body.url||null).run();
      return json({ id, ...body }, 201);
    }

    // PATCH /api/chats/:id
    if (method === 'PATCH' && path.match(/^\/api\/chats\/[\w-]+$/)) {
      const id = path.split('/')[3];
      const body = await request.json();
      const fields = []; const values = [];
      if (body.status !== undefined) { fields.push('status = ?'); values.push(body.status); }
      if (body.title  !== undefined) { fields.push('title = ?');  values.push(body.title); }
      if (body.notes  !== undefined) { fields.push('notes = ?');  values.push(body.notes); }
      if (body.url    !== undefined) { fields.push('url = ?');    values.push(body.url); }
      if (!fields.length) return err('nothing to update');
      fields.push("updated_at = datetime('now')");
      values.push(id);
      await env.DB.prepare(`UPDATE chats SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
      return json({ ok: true });
    }

    // DELETE /api/chats/:id
    if (method === 'DELETE' && path.match(/^\/api\/chats\/[\w-]+$/)) {
      await env.DB.prepare(`DELETE FROM chats WHERE id = ?`).bind(path.split('/')[3]).run();
      return json({ ok: true });
    }

    // POST /api/projects
    if (method === 'POST' && path === '/api/projects') {
      const body = await request.json();
      if (!body.section_id || !body.name) return err('section_id and name required');
      const id = body.name.toLowerCase().replace(/\s+/g,'-') + '-' + uid().slice(0,4);
      await env.DB.prepare(
        `INSERT INTO projects (id, section_id, name, color, description) VALUES (?, ?, ?, ?, ?)`
      ).bind(id, body.section_id, body.name, body.color||'#888780', body.description||null).run();
      return json({ id, ...body }, 201);
    }

    return err('not found', 404);
}
