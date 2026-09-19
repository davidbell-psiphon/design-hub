// Figma paths — where design work lands, and who decides.
//
//   node --test test/figma.test.mjs
//
// Two levels, read in this order by the runner:
//
//   1. the card's own override, if it has one
//   2. the default for its (team, brand) pair
//   3. routing.json in the Design AI repo, if the Hub cannot be reached
//
// This used to be only (3): a checked-in file with a (team, brand) map. That
// was fine while the only way to change it was to edit the repo. It stopped
// being fine when it became something you edit from the board, because a
// browser cannot commit to git — so the Hub owns it now and the file is the
// fallback.
//
// Most of these exist because the failure mode is quiet. A path that saves and
// does not take effect, or an override that silently widens to a whole team,
// shows up as design work appearing in the wrong Figma file days later.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  freshDb, env, call, issue, stubLinear, readLinear, one, PIECES,
} from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = { 'X-Agent-Secret': 's' };

async function hub(issues = [issue({ identifier: 'RYV-84' })]) {
  const db = freshDb();
  const e = env(db);
  stubLinear(issues);
  await readLinear(e);
  return { db, e };
}

const get = (e) => call(e, 'GET', '/api/figma-paths', undefined, SECRET);
const put = (e, body) => call(e, 'PUT', '/api/figma-paths', body, SECRET);
const del = (e, team, brand) => call(e, 'DELETE',
  `/api/figma-paths?team=${encodeURIComponent(team)}&brand=${encodeURIComponent(brand)}`,
  undefined, SECRET);
const override = (e, id, body) => call(e, 'PATCH',
  `/api/agent/session/${encodeURIComponent(id)}/figma`, body, SECRET);

describe('the defaults are seeded from routing.json and then owned here', () => {
  test('piece13 seeds the destinations that were already in use', async () => {
    const { e } = await hub();
    const body = await (await get(e)).json();
    const forge = body.defaults.find((d) => d.team === 'Forge' && d.brand === 'forge');
    assert.ok(forge, 'the Forge destination did not survive the seed');
    assert.equal(forge.fileKey, 'yAeyC9MEWstRdafKqHRwjA');
  });

  test('every pair routing.json knows about is seeded', async () => {
    // The seed is a copy, and a copy that is missing a pair means that pair
    // silently stops resolving the first time the Hub answers.
    const { e } = await hub();
    const body = await (await get(e)).json();
    const pairs = new Set(body.defaults.map((d) => `${d.team}|${d.brand}`));
    for (const pair of ['Conduit App|conduit', 'Ryve App|ryve', 'Forge|forge',
                        'Websites|conduit', 'Websites|psiphon', 'Websites|forge',
                        'Websites|ryve']) {
      assert.ok(pairs.has(pair), `${pair} is not seeded`);
    }
  });

  test('the pair is the key — one brand can live under two teams', async () => {
    // `forge` is under both Forge and Websites and they are different files.
    // Keying on either half alone answers the wrong question.
    const { e } = await hub();
    const body = await (await get(e)).json();
    const app = body.defaults.find((d) => d.team === 'Forge' && d.brand === 'forge');
    const site = body.defaults.find((d) => d.team === 'Websites' && d.brand === 'forge');
    assert.notEqual(app.fileKey, site.fileKey,
      'the Forge app and the Forge website resolved to one file');
  });

  test('a saved path comes back', async () => {
    const { e } = await hub();
    await put(e, { team: 'Forge', brand: 'forge', file: 'Forge App v2', fileKey: 'NEWKEY', page: '2026-09' });
    const body = await (await get(e)).json();
    const forge = body.defaults.find((d) => d.team === 'Forge' && d.brand === 'forge');
    assert.deepEqual([forge.file, forge.fileKey, forge.page], ['Forge App v2', 'NEWKEY', '2026-09']);
  });

  test('saving the same pair updates it rather than adding a second', async () => {
    const { e, db } = await hub();
    await put(e, { team: 'Forge', brand: 'forge', fileKey: 'A' });
    await put(e, { team: 'Forge', brand: 'forge', fileKey: 'B' });
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM figma_paths WHERE team = 'Forge' AND brand = 'forge'`).get().n;
    assert.equal(n, 1, 'two rows for one pair — the runner would pick whichever came first');
  });

  test('a new pair can be added', async () => {
    const { e } = await hub();
    await put(e, { team: 'Psiphon App', brand: 'psiphon', file: 'Psiphon App', fileKey: 'PSI', page: 'release-version' });
    const body = await (await get(e)).json();
    assert.ok(body.defaults.some((d) => d.team === 'Psiphon App' && d.fileKey === 'PSI'));
  });

  test('a pair can be removed, and an unmapped pair is not an error here', async () => {
    // route() treats an unmapped pair as blocking and says so on the card,
    // which is deliberate: better to stop than to land somewhere plausible.
    const { e } = await hub();
    const res = await del(e, 'Websites', 'ryve');
    assert.equal(res.status, 200);
    const body = await (await get(e)).json();
    assert.ok(!body.defaults.some((d) => d.team === 'Websites' && d.brand === 'ryve'));
  });

  test('team and brand are both required', async () => {
    const { e } = await hub();
    assert.equal((await put(e, { team: 'Forge', fileKey: 'X' })).status, 400);
    assert.equal((await put(e, { brand: 'forge', fileKey: 'X' })).status, 400);
  });

  test('a whole Figma URL pasted into the key is refused, not stored', async () => {
    // The obvious mistake, and storing it would fail much later — in a design
    // run, against a file key that is a URL.
    const { e } = await hub();
    const res = await put(e, {
      team: 'Forge', brand: 'forge',
      fileKey: 'https://www.figma.com/design/yAeyC9MEWstRdafKqHRwjA/Forge-App',
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /not the whole URL/);
  });
});

describe('a card can go somewhere other than its team default', () => {
  test('no card has an override to begin with', async () => {
    const { e } = await hub();
    const body = await (await get(e)).json();
    assert.deepEqual(body.overrides, [],
      'the override list is a card list, which is not what it is for');
  });

  test('an override is stored on the card and listed', async () => {
    const { e, db } = await hub();
    const res = await override(e, 'RYV-84', { fileKey: 'ONEOFF', page: '2026-12' });
    assert.equal(res.status, 200);

    assert.equal(one(db, 'RYV-84').figma_file_key, 'ONEOFF');
    assert.equal(one(db, 'RYV-84').figma_page, '2026-12');

    const body = await (await get(e)).json();
    assert.equal(body.overrides.length, 1);
    assert.equal(body.overrides[0].id, 'RYV-84');
  });

  test('the agent id form resolves to the same card', async () => {
    // §2: the issue key is the identity, and the agent posts whatever it
    // likes. A control that only worked for one spelling would be a second
    // identity in disguise.
    const { e, db } = await hub();
    const res = await override(e, 'ryve/ryv-84/design', { fileKey: 'ONEOFF' });
    assert.equal(res.status, 200);
    assert.equal(one(db, 'RYV-84').figma_file_key, 'ONEOFF');
  });

  test('clearing both fields puts the card back on its default', async () => {
    const { e, db } = await hub();
    await override(e, 'RYV-84', { fileKey: 'ONEOFF', page: '2026-12' });
    await override(e, 'RYV-84', { fileKey: '', page: '' });
    assert.equal(one(db, 'RYV-84').figma_file_key, null);
    assert.equal(one(db, 'RYV-84').figma_page, null);
    const body = await (await get(e)).json();
    assert.deepEqual(body.overrides, []);
  });

  test('a page-only override is kept — it means the same file, another page', async () => {
    const { e, db } = await hub();
    await override(e, 'RYV-84', { page: '2026-12' });
    assert.equal(one(db, 'RYV-84').figma_page, '2026-12');
    assert.equal(one(db, 'RYV-84').figma_file_key, null);
    const body = await (await get(e)).json();
    assert.equal(body.overrides.length, 1, 'a page-only override vanished');
  });

  test('a card that does not exist is a 404, not a silent success', async () => {
    const { e } = await hub();
    assert.equal((await override(e, 'ZZZ-999', { fileKey: 'X' })).status, 404);
  });

  test('a whole Figma URL is refused here too', async () => {
    const { e } = await hub();
    assert.equal((await override(e, 'RYV-84', {
      fileKey: 'https://www.figma.com/design/abc/Thing' })).status, 400);
  });
});

describe('the override columns stay in the half of `cards` you own', () => {
  test('a reader pass does not touch them', async () => {
    // CLAUDE.md: Linear owns some columns and a reader pass replaces them;
    // you own the others and a reader pass must not mention them. An override
    // wiped by the next cron read would look exactly like it never saved.
    const { e, db } = await hub();
    await override(e, 'RYV-84', { fileKey: 'ONEOFF', page: '2026-12' });

    stubLinear([issue({ identifier: 'RYV-84', title: 'Renamed in Linear' })]);
    await readLinear(e);

    assert.equal(one(db, 'RYV-84').title, 'Renamed in Linear', 'the read did not happen');
    assert.equal(one(db, 'RYV-84').figma_file_key, 'ONEOFF',
      'a cron read cleared the Figma override');
    assert.equal(one(db, 'RYV-84').figma_page, '2026-12');
  });

  test('the reader SQL never names them', async () => {
    // Stronger than the behavioural test above, and the one that survives a
    // rewrite of the upsert: the reader must not mention these columns at all.
    const src = fs.readFileSync(path.join(ROOT, 'worker/index.js'), 'utf8');
    const upsert = src.slice(src.indexOf('ON CONFLICT(issue_key) DO UPDATE'));
    const body = upsert.slice(0, upsert.indexOf('`'));
    assert.ok(!body.includes('figma_file_key'),
      'the reader upsert writes figma_file_key, so a cron read can clear an override');
    assert.ok(!body.includes('figma_page'));
  });

  test('they are separate from figma_url, which means something else', async () => {
    // piece11 calls figma_url "your destination override", which is what it
    // was meant to be and not what it became — the agent writes it when a
    // design run has drawn something, so it holds where the work ENDED UP.
    // Folding them together would let a finished design redirect the next one.
    const { e, db } = await hub();
    await override(e, 'RYV-84', { fileKey: 'WHERE-IT-GOES' });
    assert.equal(one(db, 'RYV-84').figma_url, null,
      'setting a destination wrote the "where it landed" column');
  });
});

describe('the board can reach all of it', () => {
  // The editor is the only way to change these now, so a handler that does not
  // exist is a setting that cannot be changed at all.
  const html = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');

  test('the sidebar section is there and opens the editor', () => {
    assert.match(html, /<div class="sb-label">Figma paths<\/div>/);
    assert.match(html, /onclick="openFigmaPaths\(\)"/);
  });

  test('every handler the editor calls is defined', () => {
    for (const fn of ['openFigmaPaths', 'closeFigmaPaths', 'renderFigmaPaths',
                      'refreshFigmaPaths', 'saveFigmaDefault', 'addFigmaDefault',
                      'removeFigmaDefault', 'saveFigmaOverride', 'addFigmaOverride',
                      'clearFigmaOverride']) {
      assert.ok(new RegExp(`function ${fn}\\(`).test(html),
        `${fn} is called from the markup and does not exist`);
    }
  });

  test('both sections the editor promises are rendered', () => {
    assert.match(html, /<h3>Default paths<\/h3>/);
    assert.match(html, /<h3>Individual changes<\/h3>/);
  });

  test('the body is passed as an object, because api() serialises it', () => {
    // Passing a string would send a JSON-encoded JSON string and the Worker
    // would read every field as undefined while answering 200 — a save that
    // looks like it worked and changes nothing.
    const bodies = [...html.matchAll(/api\((?:`|')\/figma-paths[^)]*?body:\s*([^,}]+)/g)]
      .map((m) => m[1].trim());
    for (const b of bodies) {
      assert.ok(!b.startsWith('JSON.stringify'),
        'a Figma paths call double-encodes its body');
    }
  });

  test('the editor closes on Escape before the menu does', () => {
    // Otherwise dismissing the modal also collapses the menu you opened it
    // from, and you land somewhere you did not ask to be.
    const handler = html.slice(html.indexOf("if (e.key !== 'Escape') return;"));
    assert.ok(handler.indexOf('closeFigmaPaths()') < handler.indexOf('closeMenu()'),
      'Escape closes the menu before the modal');
  });
});

describe('who may read and change a Figma path', () => {
  // Access configured. Both halves present is what turns enforcement on —
  // with neither, the Hub runs open, exactly as it did before Access existed.
  const GUARDED = { ACCESS_TEAM: 'testteam', ACCESS_AUD: 'aud-tag-1234' };

  async function guarded() {
    const db = freshDb();
    const e = env(db, GUARDED);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await call(e, 'POST', '/api/read-linear', undefined, SECRET);
    return { db, e };
  }

  test('the runner can read them with the agent secret', async () => {
    // hub.mjs sends X-Agent-Secret and has no Access session. If this route
    // stops accepting it, every run silently falls back to routing.json and
    // every edit made on the board stops taking effect.
    const { e } = await guarded();
    const res = await call(e, 'GET', '/api/figma-paths', undefined, SECRET);
    assert.equal(res.status, 200);
    assert.ok((await res.json()).defaults.length > 0);
  });

  test('an anonymous browser cannot read them', async () => {
    const { e } = await guarded();
    assert.equal((await call(e, 'GET', '/api/figma-paths')).status, 403);
  });

  test('nor write one', async () => {
    const { e } = await guarded();
    const res = await call(e, 'PUT', '/api/figma-paths',
      { team: 'Forge', brand: 'forge', fileKey: 'SNEAKY' });
    assert.equal(res.status, 403);
  });

  test('nor delete one', async () => {
    const { e } = await guarded();
    assert.equal((await call(e, 'DELETE', '/api/figma-paths?team=Forge&brand=forge')).status, 403);
  });

  test('nor set a per-card override', async () => {
    const { e } = await guarded();
    assert.equal((await call(e, 'PATCH', '/api/agent/session/RYV-84/figma',
      { fileKey: 'SNEAKY' })).status, 403);
  });

  test('a refused write changes nothing', async () => {
    // A 403 that still wrote would be the worst of both.
    const { e, db } = await guarded();
    await call(e, 'PUT', '/api/figma-paths', { team: 'Forge', brand: 'forge', fileKey: 'SNEAKY' });
    const row = db.prepare(`SELECT file_key FROM figma_paths WHERE team='Forge' AND brand='forge'`).get();
    assert.equal(row.file_key, 'yAeyC9MEWstRdafKqHRwjA');
  });

  test('a wrong secret is not a secret', async () => {
    const { e } = await guarded();
    const res = await call(e, 'GET', '/api/figma-paths', undefined, { 'X-Agent-Secret': 'not-it' });
    assert.equal(res.status, 403);
  });
});

describe('deploying the Worker before the schema', () => {
  // DEPLOY.md claims this costs you the editor and not the board. Unlike
  // piece12 it is not engineered to be order-free, so the claim is narrower —
  // and a claim in a deploy doc is worth checking rather than believing.
  const WITHOUT_13 = PIECES.filter((p) => p !== 'piece13-schema.sql');

  async function old() {
    const db = freshDb(WITHOUT_13);
    const e = env(db);
    stubLinear([issue({ identifier: 'RYV-84' })]);
    await call(e, 'POST', '/api/read-linear', undefined, SECRET);
    return { db, e };
  }

  test('the board still loads every route it needs', async () => {
    const { e } = await old();
    for (const path of ['/api/brands', '/api/agent/sessions', '/api/reader/teams',
                        '/api/agent/heartbeat']) {
      const res = await call(e, 'GET', path, undefined, SECRET);
      assert.equal(res.status, 200, `${path} broke without piece13`);
    }
  });

  test('the runner still gets its queue', async () => {
    // The one that matters most: a Worker deployed early must not stop work.
    const { e } = await old();
    assert.equal((await call(e, 'GET', '/api/agent/queue', undefined, SECRET)).status, 200);
  });

  test('and an agent can still post a session', async () => {
    const { e } = await old();
    const res = await call(e, 'POST', '/api/agent/session', {
      session_id: 'ryve/ryv-84/research', system: 'design-ai', status: 'active',
    }, SECRET);
    assert.equal(res.status, 200);
  });

  test('only the Figma routes fail, and they fail rather than lying', async () => {
    const { e } = await old();
    const res = await call(e, 'GET', '/api/figma-paths', undefined, SECRET);
    assert.equal(res.status, 500,
      'a missing table answered 200, so the board would show no paths and call that the truth');
  });
});
