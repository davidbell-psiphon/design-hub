// Access enforcement at the route level.
//
//   node --test test/access.test.mjs
//
// unit.test.mjs already proves accessIdentity() judges a token correctly —
// expired, wrong aud, wrong issuer, alg:none, tampered, unreachable certs.
// What nothing covered is whether the Worker actually *asks*: which routes sit
// behind the gate, which one is exempt and why, and what happens to the whole
// API when the two secrets are unset.
//
// That distinction matters because the failure is silent in the dangerous
// direction. A gate that wrongly rejects shows up immediately as a board that
// stopped working. A gate that wrongly admits shows up as nothing at all.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { freshDb, env, call, issue, stubLinear, readLinear } from './helpers.mjs';
import { resetAccessKeyCache } from '../lib/access.mjs';

const TEAM = 'testteam';
const AUD = 'aud-tag-1234';

// Access configured. Both halves present is what turns enforcement on.
const GUARDED = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD };

let privateKey, jwk, realFetch;

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function sign(payload) {
  const head = b64({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' });
  const body = b64(payload);
  const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey,
    new TextEncoder().encode(head + '.' + body));
  return head + '.' + body + '.' + Buffer.from(sig).toString('base64url');
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({
  aud: [AUD],
  iss: 'https://' + TEAM + '.cloudflareaccess.com',
  exp: now() + 3600,
  iat: now(),
  email: 'd.bell@psiphon.ca',
});

// One stub for both outbound calls the Worker can make: the Access certs
// endpoint, and Linear. Which one answers is decided by the URL, so a route
// that needs both works exactly as it does in production.
function stubCertsAndLinear(issues = []) {
  stubLinear(issues);
  const linearFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('cloudflareaccess.com')) {
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    }
    return linearFetch(url, init);
  };
}

beforeEach(async () => {
  resetAccessKeyCache();
  realFetch = globalThis.fetch;
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  privateKey = pair.privateKey;
  jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'kid-1'; jwk.alg = 'RS256'; jwk.use = 'sig';
  stubCertsAndLinear();
});

afterEach(() => { if (realFetch) globalThis.fetch = realFetch; });

// A board with one card on it, guarded or not.
async function board(extra) {
  const db = freshDb();
  const e = env(db, extra);
  stubCertsAndLinear([issue({ identifier: 'RYV-84' })]);
  // The cron path never traverses the HTTP edge, so it seeds the row whether
  // or not enforcement is on.
  await readLinear(env(db));
  return { db, e };
}

const CARD = encodeURIComponent('linear/RYV-84');

// Every route the board itself calls. If the gate stops covering one of these,
// that route is open to the internet.
const BOARD_ROUTES = [
  ['GET',    '/api/brands'],
  ['GET',    '/api/agent/sessions'],
  ['GET',    '/api/agent/queue'],
  ['GET',    '/api/sessions'],
  ['GET',    '/api/agent/session/' + CARD],
  ['POST',   '/api/agent/session/' + CARD + '/trigger',  { stage: 'research' }],
  ['DELETE', '/api/agent/session/' + CARD + '/trigger'],
  ['PATCH',  '/api/agent/session/' + CARD + '/reassign', { project: 'forge' }],
  ['PATCH',  '/api/agent/session/' + CARD + '/respond',  { response: 'x' }],
  ['PATCH',  '/api/agent/session/' + CARD + '/reopen',   { note: 'x' }],
  ['PATCH',  '/api/agent/session/' + CARD + '/state',    { handoff_at: 'now' }],
  ['POST',   '/api/agent/session/' + CARD + '/dismiss'],
  ['DELETE', '/api/agent/session/' + CARD + '/dismiss'],
  ['DELETE', '/api/agent/session/' + CARD],
  ['POST',   '/api/read-linear'],
  ['POST',   '/api/agent/stage-done', { linear_id: 'RYV-84', stage: 'research' }],
];

describe('with Access configured, an anonymous caller gets nothing', () => {
  for (const [method, route, body] of BOARD_ROUTES) {
    test(method + ' ' + route.replace(CARD, ':id') + ' is refused', async () => {
      const { e } = await board(GUARDED);
      const res = await call(e, method, route, body);
      assert.equal(res.status, 403, 'this route is open to the internet');
      assert.match((await res.json()).error, /no valid Access identity/i);
    });
  }
});

describe('the ways in', () => {
  test('a valid Access token is let through', async () => {
    const { e } = await board(GUARDED);
    const res = await call(e, 'GET', '/api/agent/sessions', undefined,
                           { 'Cf-Access-Jwt-Assertion': await sign(goodClaims()) });
    assert.equal(res.status, 200);
  });

  test('an expired token is not', async () => {
    const { e } = await board(GUARDED);
    const res = await call(e, 'GET', '/api/agent/sessions', undefined,
      { 'Cf-Access-Jwt-Assertion': await sign({ ...goodClaims(), exp: now() - 10 }) });
    assert.equal(res.status, 403);
  });

  // README: the poll route is the easy one to miss — it goes through the gate,
  // so the agent has to send its secret here as well as on the post.
  test('the agent reaches the poll route with its secret instead', async () => {
    const { e } = await board(GUARDED);
    const res = await call(e, 'GET', '/api/agent/session/' + CARD, undefined,
                           { 'X-Agent-Secret': 's' });
    assert.equal(res.status, 200);
  });

  test('the wrong secret is no better than none', async () => {
    const { e } = await board(GUARDED);
    const res = await call(e, 'GET', '/api/agent/sessions', undefined,
                           { 'X-Agent-Secret': 'not-it' });
    assert.equal(res.status, 403);
  });

  test('a preflight is answered before the gate, or the browser never gets in', async () => {
    const { e } = await board(GUARDED);
    assert.equal((await call(e, 'OPTIONS', '/api/agent/sessions')).status, 204);
  });
});

describe('POST /api/agent/session is exempt, and checks its own secret', () => {
  const post = (e, headers) =>
    call(e, 'POST', '/api/agent/session',
         { session_id: 'ryve/ryv-84/research', system: 'design-ai' }, headers);

  test('the right secret is accepted even with no Access identity at all', async () => {
    const { e } = await board(GUARDED);
    assert.equal((await post(e, { 'X-Agent-Secret': 's' })).status, 200);
  });

  test('no secret is refused by the route, not by the gate', async () => {
    const { e } = await board(GUARDED);
    const res = await post(e, {});
    assert.equal(res.status, 403);
    // The route's own refusal, which is a different sentence from the gate's.
    // If this ever reads "no valid Access identity", the exemption is gone and
    // the agent cannot post at all.
    assert.equal((await res.json()).error, 'Forbidden');
  });

  test('a wrong secret is refused too', async () => {
    const { e } = await board(GUARDED);
    assert.equal((await post(e, { 'X-Agent-Secret': 'nope' })).status, 403);
  });
});

// "Enforcement is off until ACCESS_AUD and ACCESS_TEAM are set" — the property
// that let this ship before the dashboard configuration existed.
describe('unconfigured, every route behaves as it always has', () => {
  test('an anonymous read is answered', async () => {
    const { e } = await board();
    assert.equal((await call(e, 'GET', '/api/agent/sessions')).status, 200);
  });

  test('an anonymous write is answered', async () => {
    const { e } = await board();
    const res = await call(e, 'POST', '/api/agent/session/' + CARD + '/trigger',
                           { stage: 'research' });
    assert.notEqual(res.status, 403);
  });

  test('half the configuration is still off — both halves are required', async () => {
    for (const half of [{ ACCESS_AUD: AUD }, { ACCESS_TEAM: TEAM }]) {
      const { e } = await board(half);
      assert.equal((await call(e, 'GET', '/api/agent/sessions')).status, 200,
                   'a half-configured gate started rejecting: ' + JSON.stringify(half));
    }
  });
});
