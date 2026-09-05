// Endpoint smoke tests against production.
//
//   node --test test/
//
// Read-only by design. The one non-GET case sends a deliberately invalid
// action, which the Worker rejects before it reads the database and long
// before it touches Linear — so no real issue can ever be triggered from here.
//
// Env:
//   HUB_WORKER               override the Worker origin
//   HUB_PAGES                override the Pages origin
//   CF_ACCESS_CLIENT_ID      service token, once Access is enforcing
//   CF_ACCESS_CLIENT_SECRET

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const WORKER = process.env.HUB_WORKER || 'https://design-hub-worker.d-bell.workers.dev';
const PAGES = process.env.HUB_PAGES || 'https://design-hub-7y2.pages.dev';

const authHeaders = {};
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  authHeaders['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  authHeaders['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}

async function call(base, path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    redirect: 'manual',
    headers: { ...authHeaders, ...(init.headers || {}) },
  });
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* HTML login page, or empty */ }
  return {
    status: res.status,
    body,
    json: parsed,
    location: res.headers.get('location') || '',
  };
}

// A redirect to cloudflareaccess.com means Access is in front and we have no
// service token. That is a configuration state, not a broken endpoint — say so
// rather than reporting a failure that sends someone debugging the Worker.
// The Location header is the reliable signal: with redirect:'manual' the body
// is usually empty.
function blockedByAccess(res) {
  // Access itself, in front of the hostname: a redirect to the login page.
  if ((res.status === 301 || res.status === 302) &&
      /cloudflareaccess\.com/.test(res.location + res.body)) return true;
  // The Worker's own gate, once ACCESS_AUD and ACCESS_TEAM are set. Matched on
  // the specific message rather than on 403 alone, so a genuine authorization
  // failure somewhere else still fails the test instead of skipping it.
  return res.status === 403 && /no valid Access identity/.test(res.body);
}

const NEED_TOKEN =
  'blocked by Access — set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to test through it';

describe('GET /api/brands', () => {
  let res;
  before(async () => { res = await call(WORKER, '/api/brands'); });

  test('returns 200 with four brands', (t) => {
    if (blockedByAccess(res)) return t.skip(NEED_TOKEN);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json), 'body should be an array');
    assert.equal(res.json.length, 4);
  });

  test('every brand has id, name and colour', (t) => {
    if (blockedByAccess(res)) return t.skip(NEED_TOKEN);
    for (const b of res.json) {
      assert.ok(b.id, 'missing id');
      assert.ok(b.name, `missing name on ${b.id}`);
      assert.match(b.color, /^#[0-9A-Fa-f]{6}$/, `bad colour on ${b.id}`);
    }
  });

  test('the four expected brands are present', (t) => {
    if (blockedByAccess(res)) return t.skip(NEED_TOKEN);
    const ids = res.json.map(b => b.id).sort();
    assert.deepEqual(ids, ['conduit', 'forge', 'psiphon', 'ryve']);
  });
});

describe('GET /api/agent/sessions', () => {
  let res;
  before(async () => { res = await call(WORKER, '/api/agent/sessions'); });

  test('returns 200 and an array', (t) => {
    if (blockedByAccess(res)) return t.skip(NEED_TOKEN);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
  });

  test('every row carries the fields the board reads', (t) => {
    if (blockedByAccess(res)) return t.skip(NEED_TOKEN);
    for (const r of res.json) {
      assert.ok(r.id, 'row without id');
      assert.ok(r.system, `row ${r.id} has no system`);
      assert.ok(['active', 'waiting', 'done', 'error'].includes(r.status),
        `row ${r.id} has status ${r.status}`);
      // Present as columns even when null — a missing key means a schema drift.
      for (const field of ['project', 'track', 'phase', 'triggered_at', 'url']) {
        assert.ok(field in r, `row ${r.id} is missing the ${field} column`);
      }
    }
  });

  test('reader-written rows can actually be triggered', (t) => {
    if (blockedByAccess(res)) return t.skip(NEED_TOKEN);
    // The "8 dead rows" regression: rows written before the Piece 4 columns
    // existed had no linear_uuid, so every Trigger button was a no-op, and no
    // linear_state, so Queued and Backlog could not be told apart.
    const fromReader = res.json.filter(r => r.linear_id);
    assert.ok(fromReader.length > 0, 'no reader-written rows to check');
    for (const r of fromReader) {
      assert.ok(r.linear_uuid, `${r.linear_id} has no linear_uuid — Trigger would fail`);
      assert.ok(r.title, `${r.linear_id} has no title — the card would render blank`);
      assert.ok(['backlog', 'unstarted'].includes(r.linear_state),
        `${r.linear_id} has linear_state ${r.linear_state} — bucketing would guess`);
    }
  });
});

describe('POST /api/agent/session/:id/trigger', () => {
  test('an invalid action is rejected with 400', async (t) => {
    // Safe: the Worker validates `action` before the DB lookup and before any
    // Linear mutation, and __smoke__ is not a real session id.
    const res = await call(WORKER, '/api/agent/session/__smoke__/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'definitely-not-valid' }),
    });
    if (blockedByAccess(res)) return t.skip(NEED_TOKEN);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /action must be/);
  });
});

describe('removed hierarchy routes are gone', () => {
  const removed = [
    '/api/sidebar',
    '/api/projects/conduit',
    '/api/chats',
    '/api/capabilities',
    '/api/resources',
  ];

  for (const path of removed) {
    test(`${path} returns 404`, async (t) => {
      const res = await call(WORKER, path);
      if (blockedByAccess(res)) return t.skip(NEED_TOKEN);
      assert.equal(res.status, 404, `${path} answered ${res.status}`);
    });
  }
});

describe('the Pages origin', () => {
  test('serves the board or redirects to Access', async () => {
    const res = await call(PAGES, '/');
    assert.ok(res.status === 200 || blockedByAccess(res),
      `unexpected status ${res.status} from the Pages origin`);
  });

  test('proxies /api/* to the Worker', async (t) => {
    const res = await call(PAGES, '/api/brands');
    if (blockedByAccess(res)) return t.skip(NEED_TOKEN);
    assert.equal(res.status, 200);
    assert.equal(res.json.length, 4, 'proxy did not return the brands');
  });
});
