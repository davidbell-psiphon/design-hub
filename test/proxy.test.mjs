// The same-origin proxy: browser -> Pages (/api/*) -> Worker.
//
//   node --test test/proxy.test.mjs
//
// CLAUDE.md calls this one of the three things that look like cruft and are
// load-bearing. Until now the only thing exercising it was the production
// smoke test, which can say "/api/* reaches the Worker" and nothing about what
// the hop does to the headers — and the headers are the entire point:
//
//   - the caller's Access JWT must be forwarded, or the Worker cannot verify
//     the human and every board route answers 403;
//   - the browser's cookies must NOT be, because the Worker has no use for
//     them and no business seeing them;
//   - X-Agent-Secret must never be sent from here, because this path is for
//     humans and the agent's secret would grant the browser the agent's rights.
//
// None of those three fail loudly if broken. The first shows up as a board
// that stopped working; the other two show up as nothing at all, which is why
// they get tests.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

// The Function is ESM with a .js extension and this repo has no package.json
// to say so. It imports nothing, so it loads as a data: URL unmodified —
// the same source Pages runs.
const src = fs.readFileSync(path.join(ROOT, 'functions/api/[[path]].js'), 'utf8');
const { onRequest } = await import('data:text/javascript,' + encodeURIComponent(src));

const WORKER = 'https://design-hub-worker.d-bell.workers.dev';

let sent;        // what the proxy asked fetch for
let upstream;    // what fetch answers with
let realFetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  sent = null;
  upstream = () => new Response(JSON.stringify({ ok: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, init) => {
    sent = { url, init, headers: new Headers(init.headers) };
    return upstream();
  };
});

afterEach(() => { globalThis.fetch = realFetch; });

// A browser request arriving at the Pages origin.
function inbound(pathname, { method = 'GET', headers = {}, body, search = '' } = {}) {
  return new Request('https://design-hub-7y2.pages.dev' + pathname + search, {
    method, headers, body,
  });
}

const ctx = (request, env = {}) => ({
  request,
  env,
  // Pages splits the wildcard into segments; the Function joins them back.
  params: { path: request.url.split('/api/')[1]?.split('?')[0].split('/') ?? [] },
});

const go = (request, env) => onRequest(ctx(request, env));

describe('what the proxy forwards', () => {
  test('the Access identity is passed through for the Worker to verify itself', async () => {
    await go(inbound('/api/agent/sessions', {
      headers: { 'Cf-Access-Jwt-Assertion': 'the.jwt.here' },
    }));
    assert.equal(sent.headers.get('Cf-Access-Jwt-Assertion'), 'the.jwt.here');
  });

  test('the browser cookies are not', async () => {
    await go(inbound('/api/agent/sessions', {
      headers: { Cookie: 'CF_Authorization=secret-session; other=1' },
    }));
    assert.equal(sent.headers.get('Cookie'), null,
                 'the proxy carried the browser cookie jar to the Worker');
  });

  test('the agent secret is never sent from here, even if a caller supplies one', async () => {
    await go(inbound('/api/agent/sessions', {
      headers: { 'X-Agent-Secret': 'not-yours' },
    }));
    assert.equal(sent.headers.get('X-Agent-Secret'), null,
                 'a browser caller was handed the agent identity');
  });

  test('no Access header means none is invented', async () => {
    await go(inbound('/api/agent/sessions'));
    assert.equal(sent.headers.get('Cf-Access-Jwt-Assertion'), null);
  });

  test('Content-Type survives, so the Worker can parse the body', async () => {
    await go(inbound('/api/agent/session/x/respond', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_option_id: 'd2' }),
    }));
    assert.equal(sent.headers.get('Content-Type'), 'application/json');
    assert.equal(sent.init.body, '{"response_option_id":"d2"}');
  });

  test('a GET carries no body', async () => {
    await go(inbound('/api/agent/sessions'));
    assert.equal(sent.init.body, undefined);
  });
});

describe('where the proxy sends it', () => {
  test('the path is rebuilt against the Worker', async () => {
    await go(inbound('/api/agent/queue'));
    assert.equal(sent.url, WORKER + '/api/agent/queue');
  });

  test('a nested path keeps every segment', async () => {
    await go(inbound('/api/agent/session/linear%2FRYV-84/trigger', { method: 'POST' }));
    assert.equal(sent.url, WORKER + '/api/agent/session/linear%2FRYV-84/trigger');
  });

  test('the query string rides along', async () => {
    await go(inbound('/api/agent/sessions', { search: '?brand=ryve&limit=10' }));
    assert.equal(sent.url, WORKER + '/api/agent/sessions?brand=ryve&limit=10');
  });
});

describe('the service token', () => {
  test('is sent when both halves are configured', async () => {
    await go(inbound('/api/agent/sessions'),
             { CF_ACCESS_CLIENT_ID: 'id-1', CF_ACCESS_CLIENT_SECRET: 'sec-1' });
    assert.equal(sent.headers.get('CF-Access-Client-Id'), 'id-1');
    assert.equal(sent.headers.get('CF-Access-Client-Secret'), 'sec-1');
  });

  test('half a token is no token — neither header goes', async () => {
    await go(inbound('/api/agent/sessions'), { CF_ACCESS_CLIENT_ID: 'id-1' });
    assert.equal(sent.headers.get('CF-Access-Client-Id'), null);
    assert.equal(sent.headers.get('CF-Access-Client-Secret'), null);
  });

  test('unconfigured, the call goes through unauthenticated', async () => {
    await go(inbound('/api/agent/sessions'));
    assert.equal(sent.headers.get('CF-Access-Client-Id'), null);
  });
});

describe('what comes back', () => {
  test('the status and body are passed through untouched', async () => {
    upstream = () => new Response(JSON.stringify({ error: 'not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } });
    const res = await go(inbound('/api/agent/session/nope'));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });

  test('nothing from this proxy is cached', async () => {
    const res = await go(inbound('/api/agent/sessions'));
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  // An Access login page is HTML, and the board's fetch would die on a parse
  // error it cannot explain. Saying so plainly is the whole reason this branch
  // exists.
  test('an Access login page becomes a 502 that names the fix', async () => {
    upstream = () => new Response('<html>sign in</html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    const res = await go(inbound('/api/agent/sessions'));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /Blocked by Access/i);
    assert.match(body.error, /CF_ACCESS_CLIENT_ID/);
  });

  test('a redirect to the login page is caught the same way', async () => {
    upstream = () => new Response(null, { status: 302, headers: { Location: '/cdn-cgi/access' } });
    const res = await go(inbound('/api/agent/sessions'));
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Blocked by Access/i);
  });

  test('an unreachable Worker is a 502, not an unhandled throw', async () => {
    globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
    const res = await go(inbound('/api/agent/sessions'));
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Upstream unreachable/i);
  });
});

describe('the method allowlist', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    test(method + ' is allowed through', async () => {
      const res = await go(inbound('/api/agent/sessions',
        { method, body: method === 'GET' ? undefined : '{}' }));
      assert.notEqual(res.status, 405);
      assert.ok(sent, method + ' never reached the Worker');
    });
  }

  test('anything else is refused before it reaches the Worker', async () => {
    for (const method of ['OPTIONS']) {
      sent = null;
      const res = await go(inbound('/api/agent/sessions', { method }));
      assert.equal(res.status, 405, method + ' was not refused');
      assert.equal(sent, null, method + ' was forwarded anyway');
    }
  });
});
