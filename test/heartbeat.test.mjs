// The local-agent heartbeat: the one write that exists purely so the board
// can tell "queued and about to be picked up" from "queued, nobody's home".
//
//   node --test test/heartbeat.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, env, call } from './helpers.mjs';

const beat = (e, body, headers = { 'X-Agent-Secret': 's' }) =>
  call(e, 'POST', '/api/agent/heartbeat', body, headers);

const read = (e) => call(e, 'GET', '/api/agent/heartbeat');

describe('POST /api/agent/heartbeat', () => {
  // Same gate as every other agent write, via requireHuman — open until
  // Access is configured (env() leaves ACCESS_AUD/TEAM unset, same as every
  // other suite but access.test.mjs), and secret-or-Access once it is. Not
  // re-testing requireHuman itself here, just that this route actually goes
  // through it rather than skipping the check the way POST /api/agent/session
  // has to.
  test('once Access is configured, the agent secret is required', async () => {
    const e = env(freshDb(), { ACCESS_TEAM: 'psiphon', ACCESS_AUD: 'aud-1' });
    const res = await beat(e, { machine: 'dave-bell-jr' }, {});
    assert.equal(res.status, 403);
  });

  test('requires a machine name', async () => {
    const e = env(freshDb());
    const res = await beat(e, { capabilities: ['research'] });
    assert.equal(res.status, 400);
  });

  test('records a first check-in', async () => {
    const e = env(freshDb());
    const res = await beat(e, { machine: 'dave-bell-jr', capabilities: ['research', 'design', 'figma', 'mobbin'] });
    assert.equal(res.status, 200);
    const rows = await (await read(e)).json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].machine, 'dave-bell-jr');
    assert.deepEqual(rows[0].capabilities, ['research', 'design', 'figma', 'mobbin']);
    assert.ok(rows[0].last_seen, 'last_seen should be stamped');
  });

  test('a second check-in from the same machine updates it in place, not a second row', async () => {
    const e = env(freshDb());
    await beat(e, { machine: 'dave-bell-jr', capabilities: ['research'] });
    await beat(e, { machine: 'dave-bell-jr', capabilities: ['research', 'design', 'figma'] });
    const rows = await (await read(e)).json();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].capabilities, ['research', 'design', 'figma']);
  });

  test('two different machines are two rows', async () => {
    const e = env(freshDb());
    await beat(e, { machine: 'dave-bell-jr', capabilities: ['research'] });
    await beat(e, { machine: 'dave-laptop', capabilities: ['research', 'figma'] });
    const rows = await (await read(e)).json();
    assert.equal(rows.length, 2);
  });

  test('no capabilities sent is recorded as none, not a crash', async () => {
    const e = env(freshDb());
    await beat(e, { machine: 'dave-bell-jr' });
    const rows = await (await read(e)).json();
    assert.deepEqual(rows[0].capabilities, []);
  });
});

describe('GET /api/agent/heartbeat', () => {
  test('nothing has ever checked in — an empty array, not an error', async () => {
    const e = env(freshDb());
    const res = await read(e);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  test('needs no agent secret — the board reads this as a browser, not the runner', async () => {
    const e = env(freshDb());
    await beat(e, { machine: 'dave-bell-jr' });
    const res = await call(e, 'GET', '/api/agent/heartbeat', undefined, {});
    assert.equal(res.status, 200);
  });
});
