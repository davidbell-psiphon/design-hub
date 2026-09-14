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
import { linearKeyFromSessionId } from '../lib/session-id.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── board-logic.js in a bare context ──────────────────────────────────
// It is a classic script defining globals, so running it in a vm context
// hands back the functions with no DOM stub at all.
const board = vm.createContext({ Date, Math, isNaN, String });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend/board-logic.js'), 'utf8'), board);
const { stageOf, stageName, hasLabel, isWorking, actionFor, statusPill,
        sectionOf, isOpen, key, timeAgo,
        optionsOf, isGateOpen, isGateAnswered, chosenLabel, ownSection,
        stageState, stageReached, stageLabel, isSkipped } = board;

// A row as the reader writes it. `labels` is the JSON array the board reads to
// decide a card's column.
const rowWith = (...names) => ({ labels: JSON.stringify(names) });

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

describe('stageOf — which column a card is in', () => {
  test('no labels means Backlog', () => {
    assert.equal(stageOf(rowWith()), 'backlog');
    assert.equal(stageOf({}), 'backlog');
    assert.equal(stageOf({ labels: null }), 'backlog');
  });

  test('each done-label moves the card on', () => {
    assert.equal(stageOf(rowWith('AI-research done')), 'researched');
    assert.equal(stageOf(rowWith('AI-design done')), 'designed');
    assert.equal(stageOf(rowWith('AI-QA done')), 'qa');
  });

  test('the most advanced label wins', () => {
    // An issue that has been all the way through carries all three.
    assert.equal(
      stageOf(rowWith('AI-research done', 'AI-design done', 'AI-QA done')), 'qa');
    assert.equal(stageOf(rowWith('AI-research done', 'AI-design done')), 'designed');
  });

  test('a skipped stage advances the card, same as a completed one', () => {
    // Skipping is a decision. Leaving the card in Backlog hid it, and made a
    // card you marked no-research look like one whose research failed.
    assert.equal(stageOf(rowWith('no-research')), 'researched');
    assert.equal(stageOf(rowWith('Design', 'no-design')), 'designed');
  });

  test('malformed labels render as Backlog rather than throwing', () => {
    // One bad row must not take the whole board down with it.
    assert.equal(stageOf({ labels: 'not json' }), 'backlog');
    assert.equal(stageOf({ labels: '{"a":1}' }), 'backlog');
  });

  test('an already-parsed array works too', () => {
    assert.equal(stageOf({ labels: ['AI-design done'] }), 'designed');
  });

  test('stageName is what the column heading says', () => {
    assert.equal(stageName('backlog'), 'Backlog');
    assert.equal(stageName('researched'), 'Researched');
    assert.equal(stageName('designed'), 'AI-designed');
    assert.equal(stageName('qa'), "QA'd");
  });

  test('hasLabel', () => {
    assert.equal(hasLabel(rowWith('no-research'), 'no-research'), true);
    assert.equal(hasLabel(rowWith('no-research'), 'no-design'), false);
    assert.equal(hasLabel({}, 'no-research'), false);
  });
});

describe('stage completion — done, skipped, or not started', () => {
  // The three states the board could not tell apart. Absence of the done-label
  // used to mean both "has not run" and "was deliberately passed over".
  test('each stage reads back its own three states', () => {
    assert.equal(stageState(rowWith(), 'research'), null);
    assert.equal(stageState(rowWith('AI-research done'), 'research'), 'done');
    assert.equal(stageState(rowWith('no-research'), 'research'), 'skipped');

    assert.equal(stageState(rowWith(), 'design'), null);
    assert.equal(stageState(rowWith('AI-design done'), 'design'), 'done');
    assert.equal(stageState(rowWith('no-design'), 'design'), 'skipped');
  });

  test('nothing skips QA', () => {
    assert.equal(stageState(rowWith('AI-QA done'), 'qa'), 'done');
    assert.equal(stageState(rowWith('no-research', 'no-design'), 'qa'), null);
  });

  test('done outranks skipped — the run happened in the end', () => {
    assert.equal(stageState(rowWith('no-research', 'AI-research done'), 'research'), 'done');
    assert.equal(stageLabel(rowWith('no-research', 'AI-research done')), 'Researched');
  });

  test('the pill says skipped where the column cannot', () => {
    assert.equal(stageLabel(rowWith()), 'Backlog');
    assert.equal(stageLabel(rowWith('AI-research done')), 'Researched');
    assert.equal(stageLabel(rowWith('no-research')), 'Research skipped');
    assert.equal(stageLabel(rowWith('no-design')), 'Design skipped');
    assert.equal(stageLabel(rowWith('AI-QA done')), "QA'd");
  });

  test('isSkipped tracks the stage that put the card where it is', () => {
    assert.equal(isSkipped(rowWith('no-research')), true);
    assert.equal(isSkipped(rowWith('AI-research done')), false);
    assert.equal(isSkipped(rowWith()), false);
    // Research was skipped, but design actually ran — the card's level is
    // design, and that level was earned.
    assert.equal(isSkipped(rowWith('no-research', 'AI-design done')), false);
    assert.equal(stageLabel(rowWith('no-research', 'AI-design done')), 'AI-designed');
  });

  test('a skipped stage is eligible for the next one', () => {
    // The whole point of counting it as complete: the button and the column
    // agree, because the button now reads the column.
    const act = (r) => { const a = actionFor(r); return a && a.stage + '/' + a.label; };
    assert.equal(stageOf(rowWith('no-research')), 'researched');
    assert.equal(act(rowWith('no-research')), 'design/Run Design');
    assert.equal(act(rowWith('no-design')), 'qa/Run QA');
  });
});

describe('actionFor — the one button a card offers', () => {
  // Field by field, not deepEqual: these objects are built inside the vm
  // context, so they are structurally right but never reference-equal.
  const act = (r) => { const a = actionFor(r); return a && a.stage + '/' + a.label; };

  test('backlog offers Research', () => {
    assert.equal(act(rowWith()), 'research/Run Research');
  });

  test('no-research skips it straight to Design', () => {
    // Dave applies this label in Linear himself: "this one needs no research".
    // The card now sits under Researched too, so the button and the column say
    // the same thing rather than disagreeing.
    assert.equal(act(rowWith('no-research')), 'design/Run Design');
    assert.equal(stageOf(rowWith('no-research')), 'researched');
  });

  test('researched offers Design', () => {
    assert.equal(act(rowWith('AI-research done')), 'design/Run Design');
  });

  test('designed offers QA', () => {
    assert.equal(act(rowWith('AI-design done')), 'qa/Run QA');
  });

  test('the final stage offers nothing', () => {
    assert.equal(actionFor(rowWith('AI-QA done')), null);
  });

  test('every stage short of the last offers a button — no card renders empty', () => {
    // This is the bug the four-column board replaced: a card whose status did
    // not match any branch fell through and rendered with no actions at all.
    for (const r of [rowWith(), rowWith('no-research'), rowWith('AI-research done'),
                     rowWith('AI-design done')]) {
      assert.ok(actionFor(r), 'expected an action for ' + r.labels);
    }
  });
});

describe('isWorking and statusPill', () => {
  test('a queued request is working', () => {
    assert.equal(isWorking({ requested_stage: 'research' }), true);
  });

  test('nothing queued is not working', () => {
    assert.equal(isWorking({ requested_stage: null }), false);
    assert.equal(isWorking({}), false);
  });

  test('the pill shows a run in progress', () => {
    assert.equal(statusPill({ requested_stage: 'design' }).kind, 'working');
  });

  test('the pill shows an error', () => {
    assert.equal(statusPill({ status: 'error' }).kind, 'error');
  });

  test('a quiet card gets no pill at all', () => {
    // The stage is already on the card; repeating "Waiting" on every row was
    // noise, and untriggered rows are all written 'waiting' by the reader.
    assert.equal(statusPill({ status: 'waiting' }), null);
    assert.equal(statusPill({ status: 'done' }), null);
    assert.equal(statusPill({}), null);
  });

  test('working outranks a stale error', () => {
    assert.equal(statusPill({ status: 'error', requested_stage: 'qa' }).kind, 'working');
  });
});

describe('sectionOf — board vs the collapsed sections', () => {
  test('an ordinary row belongs on the board', () => {
    assert.equal(sectionOf({ linear_state: 'backlog' }), 'board');
    assert.equal(sectionOf({ linear_state: 'unstarted', triggered_at: '2026-09-05 01:00:00' }), 'board');
    assert.equal(sectionOf({}), 'board');
  });

  test('a dismissed row goes to No design', () => {
    assert.equal(sectionOf({ dismissed_at: '2026-09-05 01:00:00', linear_state: 'backlog' }), 'nodesign');
  });

  test('completed and canceled both go to Completed', () => {
    assert.equal(sectionOf({ linear_state: 'completed' }), 'completed');
    assert.equal(sectionOf({ linear_state: 'canceled' }), 'completed');
  });

  test('closed beats dismissed — the more final fact wins', () => {
    assert.equal(
      sectionOf({ linear_state: 'completed', dismissed_at: '2026-09-05 01:00:00' }),
      'completed');
  });

  test('dismissed beats in flight', () => {
    // Dismissing something already triggered should still file it away.
    assert.equal(
      sectionOf({ dismissed_at: '2026-09-05 01:00:00', triggered_at: '2026-09-05 00:00:00' }),
      'nodesign');
  });

  test('isOpen is true only for board rows', () => {
    assert.equal(isOpen({ linear_state: 'backlog' }), true);
    assert.equal(isOpen({ dismissed_at: '2026-09-05 01:00:00' }), false);
    assert.equal(isOpen({ linear_state: 'completed' }), false);
    assert.equal(isOpen({ linear_state: 'canceled' }), false);
  });
});

describe('linearKeyFromSessionId — the join between the two id conventions', () => {
  test('the agent session id shape', () => {
    assert.equal(linearKeyFromSessionId('ryve/ryv-84/research'), 'RYV-84');
    assert.equal(linearKeyFromSessionId('conduit/CON-116/design'), 'CON-116');
  });

  test('a bare key, and the reader\'s own id', () => {
    assert.equal(linearKeyFromSessionId('RYV-84'), 'RYV-84');
    assert.equal(linearKeyFromSessionId('linear/CON-116'), 'CON-116');
  });

  test('a session id with no issue behind it stays unmatched', () => {
    // This is the case that must not produce a false positive: matching a
    // whole path segment is what keeps 'wallet-flow' from reading as a key.
    assert.equal(linearKeyFromSessionId('conduit/wallet-flow/design'), null);
    assert.equal(linearKeyFromSessionId('social-ai/october-campaign'), null);
  });

  test('bad input does not throw', () => {
    for (const v of [null, undefined, '', 42, {}]) {
      assert.equal(linearKeyFromSessionId(v), null);
    }
  });
});

describe('the gate helpers — options, open, answered, chosen', () => {
  const OPTS = [
    { id: 'd1', label: 'Icon-only corner button', summary: '48x48 circular +.' },
    { id: 'd2', label: 'Labelled corner control', summary: 'Costs card width.' },
  ];
  // The Hub sends options as an array; the column holds JSON. Both arrive.
  const asJson = (o) => ({ ...o, options: JSON.stringify(OPTS) });
  const asArray = (o) => ({ ...o, options: OPTS });

  test('options parse from JSON, from an array, and from neither', () => {
    assert.equal(optionsOf(asJson({})).length, 2);
    assert.equal(optionsOf(asArray({})).length, 2);
    assert.equal(optionsOf({}).length, 0);
    assert.equal(optionsOf({ options: null }).length, 0);
    assert.equal(optionsOf(null).length, 0);
  });

  test('a malformed options column is empty, not an exception', () => {
    assert.equal(optionsOf({ options: '{not json' }).length, 0);
    assert.equal(optionsOf({ options: '{"id":"d1"}' }).length, 0);
  });

  test('a gate is open only while it is waiting and unanswered', () => {
    assert.equal(isGateOpen(asJson({ status: 'waiting' })), true);
    assert.equal(isGateOpen(asJson({ status: 'active' })), false);
    assert.equal(isGateOpen(asJson({ status: 'waiting', response_option_id: 'd2' })), false);
    // No options, no gate — the free-text sessions are untouched.
    assert.equal(isGateOpen({ status: 'waiting', prompt: 'Which?' }), false);
  });

  test('a gate stays answered after the agent carries on working', () => {
    assert.equal(isGateAnswered(asJson({ status: 'active', response_option_id: 'd2' })), true);
    assert.equal(isGateAnswered(asJson({ status: 'waiting' })), false);
    // A free-text answer is not a gate decision and offers nothing to reopen.
    assert.equal(isGateAnswered({ response: 'Direction B' }), false);
  });

  test('the chosen option resolves to its label, never the bare id', () => {
    assert.equal(chosenLabel(asJson({ response_option_id: 'd2' })), 'Labelled corner control');
    assert.equal(chosenLabel(asJson({})), '');
  });

  test('a design of your own is a decision with no option id', () => {
    // The shape that identifies it: answered, options present, nothing named.
    const own = asJson({ status: 'active', responded_at: '2026-09-13 10:00:00',
                         response_note: 'Wallet header v3' });
    assert.equal(ownSection(own), 'Wallet header v3');
    assert.equal(isGateAnswered(own), true);
    assert.equal(isGateOpen(own), false);
    assert.equal(chosenLabel(own), 'Wallet header v3');
  });

  test('a note on an unanswered gate is not a decision', () => {
    // Nothing has been responded to, so a note is just a note — which is the
    // whole reason a section arrives under its own field.
    const noted = asJson({ status: 'waiting', response_note: 'Wallet header v3' });
    assert.equal(ownSection(noted), '');
    assert.equal(isGateAnswered(noted), false);
    assert.equal(isGateOpen(noted), true);
  });

  test('a note beside a chosen option is not a section', () => {
    const withNote = asJson({ status: 'active', responded_at: '2026-09-13 10:00:00',
                              response_option_id: 'd2', response_note: 'tighten the copy' });
    assert.equal(ownSection(withNote), '');
    assert.equal(chosenLabel(withNote), 'Labelled corner control');
  });

  test('a free-text session has no section either', () => {
    // No options at all: the old behaviour, and nothing here applies to it.
    assert.equal(ownSection({ status: 'active', responded_at: '2026-09-13 10:00:00',
                              response_note: 'Direction B' }), '');
  });

  test('an id the options no longer carry falls back rather than blanking', () => {
    // A round that dropped an option, read back from history.
    assert.equal(
      chosenLabel({ ...asJson({}), response_option_id: 'd9', response_label: 'Something else' }),
      'Something else');
    assert.equal(chosenLabel({ ...asJson({}), response_option_id: 'd9' }), 'd9');
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
