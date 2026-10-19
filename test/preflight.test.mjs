// Pre-flight: a press the runner would stop on is refused up front, with the
// fix attached, instead of sitting on "Queued" for ever.
//
//   node --test test/preflight.test.mjs
//
// WEB-325, 19 October: a Websites issue with no brand word, a free machine and
// an empty queue. The runner could not pick a Figma file and stopped; the card
// said Queued. These hold down both halves — the refusal and the one-click fix.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, env, call, readLinear, issue, stubLinear, one, session } from './helpers.mjs';

const TEAMS = { teams: ['Websites', 'Ryve App'] };

async function onBoard(o) {
  const db = freshDb();
  const e = env(db);
  const mutations = [];
  stubLinear([issue(o)], mutations, TEAMS);
  await readLinear(e);
  return { db, e, mutations };
}

const press = (e, key, stage) =>
  call(e, 'POST', `/api/agent/session/${key}/trigger`, { stage });

describe('a card with no brand is refused, not queued', () => {
  test('Websites issue with no brand word → 422 no-brand, nothing queued', async () => {
    const { db, e } = await onBoard({ identifier: 'WEB-325', team: 'Websites',
                                      title: 'Colour scales for the psix dashboard' });
    const res = await press(e, 'WEB-325', 'design');
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, 'no-brand');
    assert.deepEqual(body.fix.options, ['conduit', 'ryve', 'psiphon', 'forge']);
    const s = session(db, 'WEB-325', 'design');
    assert.ok(!s || !s.requested_at, 'a refused press still queued a run');
  });

  test('a brand word in the title is enough', async () => {
    const { e } = await onBoard({ identifier: 'WEB-326', team: 'Websites',
                                  title: 'Psiphon: colour scales' });
    const res = await press(e, 'WEB-326', 'design');
    assert.notEqual(res.status, 422);
  });

  test('a team that maps to one brand never needs a word', async () => {
    const { e } = await onBoard({ identifier: 'RYV-90', team: 'Ryve App', title: 'Nav' });
    const res = await press(e, 'RYV-90', 'research');
    assert.notEqual(res.status, 422);
  });
});

describe('fix-brand writes the brand into Linear and unblocks the press', () => {
  test('prepends the brand to the title, then the press goes through', async () => {
    const { db, e, mutations } = await onBoard({ identifier: 'WEB-325', team: 'Websites',
                                                 title: 'Colour scales for the psix dashboard' });
    const fix = await call(e, 'POST', '/api/agent/session/WEB-325/fix-brand', { brand: 'psiphon' });
    assert.equal(fix.status, 200);
    assert.equal((await fix.json()).title, 'Psiphon: Colour scales for the psix dashboard');
    assert.ok(mutations.some((m) => /SetTitle/.test(m)), 'the title was not written to Linear');
    assert.equal(one(db, 'WEB-325').brand, 'psiphon');
    const res = await press(e, 'WEB-325', 'design');
    assert.notEqual(res.status, 422);
  });

  test('refuses a brand that is not one of the four', async () => {
    const { e } = await onBoard({ identifier: 'WEB-325', team: 'Websites', title: 'x' });
    const res = await call(e, 'POST', '/api/agent/session/WEB-325/fix-brand', { brand: 'acme' });
    assert.equal(res.status, 400);
  });
});
