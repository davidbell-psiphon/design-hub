// Unit tests for the Hub's pure logic. No network, no DOM, no dependencies.
//
//   node --test test/
//
// Everything here is either imported from lib/*.mjs or run in node:vm, so the
// tests exercise the same source the Worker and the board ship.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

import { detectBrand, deriveBrand, deriveTrack } from '../lib/derive.mjs';
import { accessIdentity, resetAccessKeyCache } from '../lib/access.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── board-logic.js in a bare context ──────────────────────────────────
// It is a classic script defining globals, so running it in a vm context
// hands back the functions with no DOM stub at all.
const board = vm.createContext({ Date, Math, isNaN, String });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), board);
const { bucketOf, needsDecision, stageLabel, key, timeAgo } = board;

// Shorthand for a Linear issue as the reader sees it.
const issue = (team, extra = {}) => ({ team: team ? { name: team } : null, ...extra });

describe('deriveTrack — app vs website', () => {
  test('app teams', () => {
    assert.equal(deriveTrack('Conduit App'), 'app');
    assert.equal(deriveTrack('Ryve App'), 'app');
    assert.equal(deriveTrack('Psiphon App'), 'app');
  });

  test('website teams', () => {
    assert.equal(deriveTrack('Forge'), 'website');
    assert.equal(deriveTrack('Websites'), 'website');
  });

  test('unmapped team has no track', () => {
    assert.equal(deriveTrack('Marketing'), null);
  });

  test('missing team does not throw', () => {
    assert.equal(deriveTrack(undefined), null);
    assert.equal(deriveTrack(null), null);
    assert.equal(deriveTrack(''), null);
  });
});

describe('detectBrand — the keyword fallback layer', () => {
  test('matches on Linear project name', () => {
    assert.equal(detectBrand({ project: { name: 'Conduit Website' } }), 'conduit');
  });

  test('matches on a label', () => {
    assert.equal(detectBrand({ labels: { nodes: [{ name: 'Ryve' }] } }), 'ryve');
  });

  test('matches on title', () => {
    assert.equal(detectBrand({ title: 'Psiphon VPN download page' }), 'psiphon');
  });

  test('is case-insensitive', () => {
    assert.equal(detectBrand({ title: 'FORGE homepage refresh' }), 'forge');
  });

  test('project name wins over title', () => {
    assert.equal(
      detectBrand({ project: { name: 'Forge site' }, title: 'Conduit banner' }),
      'forge');
  });

  test('no brand word anywhere returns null', () => {
    assert.equal(detectBrand({ title: 'Update the pricing table', labels: { nodes: [] } }), null);
  });

  test('empty issue returns null rather than throwing', () => {
    assert.equal(detectBrand({}), null);
  });
});

describe('deriveBrand — team map first, keywords second', () => {
  test('mapped teams', () => {
    assert.equal(deriveBrand(issue('Conduit App')), 'conduit');
    assert.equal(deriveBrand(issue('Ryve App')), 'ryve');
    assert.equal(deriveBrand(issue('Psiphon App')), 'psiphon');
    assert.equal(deriveBrand(issue('Forge')), 'forge');
  });

  test('Websites has no mapping and falls through to keywords', () => {
    // This fallback is why WEB-248 is filed under psiphon.
    assert.equal(
      deriveBrand(issue('Websites', { title: 'Psiphon copy review' })),
      'psiphon');
  });

  test('Websites with no brand word is unplaced', () => {
    assert.equal(deriveBrand(issue('Websites', { title: 'Fix the footer' })), null);
  });

  test('Marketing is unmapped — this is the Unassigned path', () => {
    assert.equal(deriveBrand(issue('Marketing', { title: 'Q3 campaign brief' })), null);
  });

  test('Marketing can still be rescued by a keyword', () => {
    assert.equal(deriveBrand(issue('Marketing', { title: 'Conduit launch assets' })), 'conduit');
  });

  test('team mapping beats a conflicting keyword', () => {
    assert.equal(deriveBrand(issue('Forge', { title: 'Conduit cross-post' })), 'forge');
  });
});

describe('bucketOf — In flight / Queued / Backlog', () => {
  test('backlog state goes to Backlog', () => {
    assert.equal(bucketOf({ linear_state: 'backlog' }), 'backlog');
  });

  test('unstarted (Todo) goes to Queued', () => {
    assert.equal(bucketOf({ linear_state: 'unstarted' }), 'queued');
  });

  test('null linear_state goes to Queued, not nowhere', () => {
    // The state the 8 pre-Piece-4 rows were in. They must still render.
    assert.equal(bucketOf({ linear_state: null }), 'queued');
    assert.equal(bucketOf({}), 'queued');
  });

  test('triggered_at wins over any Linear state', () => {
    assert.equal(bucketOf({ triggered_at: '2026-09-04 22:00:00', linear_state: 'backlog' }), 'inflight');
    assert.equal(bucketOf({ triggered_at: '2026-09-04 22:00:00', linear_state: null }), 'inflight');
  });
});

describe('needsDecision — waiting AND triggered', () => {
  test('waiting and triggered counts', () => {
    assert.equal(needsDecision({ status: 'waiting', triggered_at: '2026-09-04 22:00:00' }), true);
  });

  test('waiting but never triggered does NOT count', () => {
    // The bug: the reader writes every new row as 'waiting', so status alone
    // lit up all 8 untriggered cards as decisions waiting on a human.
    assert.equal(needsDecision({ status: 'waiting', triggered_at: null }), false);
  });

  test('triggered but not waiting does not count', () => {
    assert.equal(needsDecision({ status: 'active', triggered_at: '2026-09-04 22:00:00' }), false);
  });

  test('done never counts', () => {
    assert.equal(needsDecision({ status: 'done', triggered_at: '2026-09-04 22:00:00' }), false);
  });
});

describe('stageLabel', () => {
  test('waiting outranks the phase', () => {
    assert.equal(stageLabel({ status: 'waiting', phase: 'design' }), 'Waiting on me');
  });

  test('qa is upper-cased as a unit', () => {
    assert.equal(stageLabel({ status: 'active', phase: 'qa' }), 'QA');
  });

  test('other phases are capitalised', () => {
    assert.equal(stageLabel({ status: 'active', phase: 'research' }), 'Research');
  });

  test('no phase renders an em dash', () => {
    assert.equal(stageLabel({ status: 'active', phase: null }), '—');
  });
});

describe('key — the element-id hash that replaced btoa()', () => {
  test('handles an em dash', () => {
    // btoa() threw on exactly this: issue titles and ids with non-Latin1.
    assert.doesNotThrow(() => key('linear/CON-142 — wallet flow'));
  });

  test('handles characters far outside Latin1', () => {
    assert.doesNotThrow(() => key('日本語'));
    assert.doesNotThrow(() => key('🚀 emoji id'));
    assert.doesNotThrow(() => key('العربية'));
  });

  test('output is hex and id-safe', () => {
    for (const id of ['linear/CON-118', 'linear/WEB-265 — blog', '日本語']) {
      assert.match(key(id), /^[0-9a-f]+$/);
    }
  });

  test('stable for the same input', () => {
    assert.equal(key('linear/CON-118'), key('linear/CON-118'));
  });

  test('distinguishes the real session ids on the board', () => {
    const ids = ['linear/CON-116', 'linear/CON-118', 'linear/CON-119', 'linear/CON-120',
                 'linear/CON-122', 'linear/RYV-187', 'linear/WEB-248', 'linear/WEB-265'];
    assert.equal(new Set(ids.map(key)).size, ids.length);
  });

  test('empty string does not throw', () => {
    assert.doesNotThrow(() => key(''));
  });
});

describe('timeAgo', () => {
  test('renders minutes, hours and days', () => {
    const ago = mins => new Date(Date.now() - mins * 60000)
      .toISOString().replace('T', ' ').slice(0, 19);
    assert.equal(timeAgo(ago(0)), 'now');
    assert.equal(timeAgo(ago(5)), '5m');
    assert.equal(timeAgo(ago(120)), '2h');
    assert.equal(timeAgo(ago(60 * 24 * 3)), '3d');
  });

  test('null and garbage are empty, not NaN', () => {
    assert.equal(timeAgo(null), '');
    assert.equal(timeAgo('not a date'), '');
  });
});

// ── Access JWT verification ───────────────────────────────────────────

describe('accessIdentity — Access JWT verification', () => {
  const TEAM = 'testteam';
  const AUD = 'aud-tag-1234';
  const env = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD };

  let privateKey, jwk, realFetch;

  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const req = token => ({ headers: { get: h => (h === 'Cf-Access-Jwt-Assertion' ? token : null) } });

  async function sign(payload, { kid = 'kid-1', alg = 'RS256' } = {}) {
    const head = b64({ alg, kid, typ: 'JWT' });
    const body = b64(payload);
    const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey,
      new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
  }

  const now = () => Math.floor(Date.now() / 1000);
  const good = () => ({
    aud: [AUD],
    iss: `https://${TEAM}.cloudflareaccess.com`,
    exp: now() + 3600,
    iat: now(),
    email: 'd.bell@psiphon.ca',
  });

  beforeEach(async () => {
    // Fresh keys and a cleared cache per case, so one case's key set can never
    // validate the next one's token.
    resetAccessKeyCache();
    const pair = await webcrypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']);
    privateKey = pair.privateKey;
    jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    jwk.kid = 'kid-1'; jwk.alg = 'RS256'; jwk.use = 'sig';
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  });

  test.after(() => { if (realFetch) globalThis.fetch = realFetch; });

  test('a valid token is accepted and its claims returned', async () => {
    const payload = await accessIdentity(req(await sign(good())), env);
    assert.ok(payload);
    assert.equal(payload.email, 'd.bell@psiphon.ca');
  });

  test('expired is rejected', async () => {
    assert.equal(await accessIdentity(req(await sign({ ...good(), exp: now() - 10 })), env), null);
  });

  test('wrong audience is rejected', async () => {
    assert.equal(await accessIdentity(req(await sign({ ...good(), aud: ['another-app'] })), env), null);
  });

  test('wrong issuer is rejected', async () => {
    assert.equal(await accessIdentity(
      req(await sign({ ...good(), iss: 'https://evil.cloudflareaccess.com' })), env), null);
  });

  test('unknown signing key is rejected', async () => {
    assert.equal(await accessIdentity(req(await sign(good(), { kid: 'kid-nope' })), env), null);
  });

  test('alg:none is rejected', async () => {
    assert.equal(await accessIdentity(req(await sign(good(), { alg: 'none' })), env), null);
  });

  test('a tampered payload is rejected', async () => {
    const parts = (await sign(good())).split('.');
    parts[1] = b64({ ...good(), email: 'attacker@example.com' });
    assert.equal(await accessIdentity(req(parts.join('.')), env), null);
  });

  test('missing and malformed tokens are rejected', async () => {
    assert.equal(await accessIdentity(req(null), env), null);
    assert.equal(await accessIdentity(req('not.a.jwt'), env), null);
    assert.equal(await accessIdentity(req('onlyonepart'), env), null);
  });

  test('the CF_Authorization cookie is accepted as a fallback', async () => {
    const token = await sign(good());
    const request = {
      headers: { get: h => (h === 'Cookie' ? `CF_Authorization=${token}; other=1` : null) },
    };
    assert.ok(await accessIdentity(request, env));
  });

  test('an unreachable certs endpoint fails closed', async () => {
    const token = await sign(good());
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    resetAccessKeyCache();
    assert.equal(await accessIdentity(req(token), env), null);
  });
});
