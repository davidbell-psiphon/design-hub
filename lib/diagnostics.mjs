// §14.1 and §14.2 — does this Worker have what it needs, and can it reach it.
//
// The rule §14.1 sets: fail at startup with a named variable, never at first
// use in the middle of a run. A Worker has no startup, so the nearest true
// thing is a check cheap enough to run whenever you want, which names the
// variable rather than the symptom. That is what this is.
//
// Two properties it has to have, both learned the hard way elsewhere here:
//
//   Absent is not the same as broken. §14.1 is explicit about it for the
//   evidence credentials — "reporting absence when you cannot look is worse
//   than reporting nothing" — so a check for something unconfigured reports
//   `unknown`, and only a thing that is configured and not working is a
//   `fail`.
//
//   Open must be asserted. With ACCESS_AUD and ACCESS_TEAM unset every route
//   runs open, which is correct for a Hub not yet put behind Access and a
//   silent catastrophe for one that was supposed to be. The difference
//   between those two is whether anybody said so — so saying so is a setting:
//   ACCESS_MODE=open.
//
// .mjs and free of any binding, so it can be tested directly. Same reason as
// derive.mjs and access.mjs.

// Matches HEARTBEAT_STALE_MIN in frontend/board-logic.js by hand — there is no
// build step to share a constant through. The runner checks in every 10
// minutes when it is running at all, so a day is the line past "probably
// asleep" and into "this machine has stopped checking in".
export const HEARTBEAT_STALE_MIN = 24 * 60;

// pass | fail | unknown. `unknown` is a real outcome rather than a soft
// failure: it means the check could not be made, which is different
// information from the check being made and going badly.
const pass = (name, detail, extra = {}) => ({ name, state: 'pass', detail, ...extra });
const fail = (name, detail, extra = {}) => ({ name, state: 'fail', detail, ...extra });
const unknown = (name, detail, extra = {}) => ({ name, state: 'unknown', detail, ...extra });

// How this Worker authenticates humans, as one of three deliberate states.
//
// `open-asserted` and `open-default` behave identically at the door. They are
// different facts about whether anyone chose it, and that is the entire point:
// the second is the one that should be showing up red.
export function accessState(env) {
  if (env.ACCESS_AUD && env.ACCESS_TEAM) {
    return { mode: 'enforced', team: env.ACCESS_TEAM };
  }
  if (String(env.ACCESS_MODE || '').toLowerCase() === 'open') {
    return { mode: 'open-asserted' };
  }
  return {
    mode: 'open-default',
    missing: [
      !env.ACCESS_AUD ? 'ACCESS_AUD' : null,
      !env.ACCESS_TEAM ? 'ACCESS_TEAM' : null,
    ].filter(Boolean),
  };
}

function accessCheck(env) {
  const st = accessState(env);
  if (st.mode === 'enforced') {
    return pass('access', 'Cloudflare Access enforced for team "' + st.team + '"',
                { mode: st.mode });
  }
  if (st.mode === 'open-asserted') {
    return pass('access', 'every route is open, deliberately (ACCESS_MODE=open)',
                { mode: st.mode });
  }
  return fail('access',
    'every route is open and nothing says that was intended — ' +
    st.missing.join(' and ') + ' unset. Set both to enforce Access, or ' +
    'ACCESS_MODE=open to assert this state on purpose',
    { mode: st.mode });
}

// The Linear read credential. §14.1: "a read fails loudly when it is absent" —
// so absent is a fail rather than an unknown, because everything the board
// shows comes through it.
async function linearCheck(env, live) {
  if (!env.LINEAR_API_KEY) {
    return fail('linear', 'LINEAR_API_KEY is not set — the reader cannot see any issue');
  }
  if (!live) {
    return pass('linear', 'LINEAR_API_KEY is set (add ?live=1 to check that it works)');
  }
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      // Linear uses a raw API key with NO "Bearer" prefix.
      headers: { 'Authorization': env.LINEAR_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query Diagnostics { viewer { name } }' }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json();
    if (!res.ok) return fail('linear', 'Linear answered HTTP ' + res.status);
    if (body.errors) {
      return fail('linear',
        'LINEAR_API_KEY rejected: ' + JSON.stringify(body.errors).slice(0, 200));
    }
    const who = body.data && body.data.viewer && body.data.viewer.name;
    return pass('linear', 'Linear answered as "' + (who || 'unknown user') + '"');
  } catch (e) {
    return fail('linear', 'could not reach Linear — ' +
      (e.name === 'TimeoutError' ? 'no response in 10s' : e.message));
  }
}

// D1. Not "is the binding there" but "does a query come back", because a
// binding pointing at a database that is not there looks identical until you
// use it.
async function d1Check(env) {
  if (!env.DB) return fail('d1', 'no DB binding on this Worker — check wrangler.toml');
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM cards').first();
    return pass('d1', 'D1 answered — ' + ((row && row.n) || 0) + ' cards');
  } catch (e) {
    return fail('d1', 'D1 query failed: ' + String((e && e.message) || e).slice(0, 200));
  }
}

// The shared secret the agent writes with. Absent means POST
// /api/agent/session answers 403 to everything, so the runner can read the
// queue and never report a result — which looks like the runner being broken.
function agentSecretCheck(env) {
  if (!env.AGENT_SECRET || !String(env.AGENT_SECRET).trim()) {
    return fail('agent_secret',
      'AGENT_SECRET is not set — every agent write is rejected 403, including stage-done');
  }
  return pass('agent_secret', 'AGENT_SECRET is set');
}

// Dispatching the runner is advisory: the queue row is the durable request and
// is written first. So a missing token is a degraded state rather than a
// failure, and saying which is the point.
function runnerCheck(env) {
  if (!env.GITHUB_TOKEN) {
    return unknown('runner_dispatch',
      'GITHUB_TOKEN is not set — presses are queued but nothing starts them; ' +
      'work waits for a run someone starts by hand',
      { required: false });
  }
  return pass('runner_dispatch', 'GITHUB_TOKEN is set', { required: false });
}

// §14.2's "the connectivity test that matters": whether a machine is alive out
// there. The Hub cannot reach the runner, so this is the only direction the
// question can be asked from.
async function heartbeatCheck(env, now) {
  if (!env.DB) return unknown('runner_heartbeat', 'no DB binding to read heartbeats from');
  let row;
  try {
    row = await env.DB.prepare(
      'SELECT machine, last_seen FROM agent_heartbeats ORDER BY last_seen DESC LIMIT 1'
    ).first();
  } catch (e) {
    return unknown('runner_heartbeat',
      'could not read agent_heartbeats: ' + String((e && e.message) || e).slice(0, 120));
  }
  if (!row) {
    return fail('runner_heartbeat',
      'no machine has ever checked in — local-only work (Figma, Mobbin) will queue and sit there');
  }
  const seen = Date.parse(String(row.last_seen).replace(' ', 'T') + 'Z');
  if (Number.isNaN(seen)) {
    return unknown('runner_heartbeat', 'last_seen on "' + row.machine + '" will not parse');
  }
  const mins = Math.floor(((now === undefined ? Date.now() : now) - seen) / 60000);
  if (mins > HEARTBEAT_STALE_MIN) {
    return fail('runner_heartbeat',
      '"' + row.machine + '" last checked in ' + Math.floor(mins / 60) +
      'h ago — presumed offline',
      { machine: row.machine, mins_ago: mins });
  }
  return pass('runner_heartbeat', '"' + row.machine + '" checked in ' + mins + 'm ago',
              { machine: row.machine, mins_ago: mins });
}

// §3's evidence reads, which do not exist yet. Reported rather than omitted,
// because §14.1's rule about them is the interesting part: with no credential
// the evidence read must degrade to "unknown" rather than report "no evidence
// found". A stage that ran and cannot be seen is not a stage that did not run.
function evidenceCheck(env, name, variable) {
  if (!env[variable]) {
    return unknown(name,
      variable + ' is not set — §3 evidence reads for this source report ' +
      '"unknown", never "none"',
      { required: false });
  }
  return pass(name, variable + ' is set', { required: false });
}

// Everything, in one answer. `live` opts into the network round trips; without
// it this touches only configuration and D1, so it is cheap enough to hit
// whenever you like.
export async function diagnose(env, { live = false, now } = {}) {
  const checks = [
    await d1Check(env),
    await linearCheck(env, live),
    accessCheck(env),
    agentSecretCheck(env),
    runnerCheck(env),
    await heartbeatCheck(env, now),
    evidenceCheck(env, 'evidence_figma', 'FIGMA_TOKEN'),
    evidenceCheck(env, 'evidence_github', 'GITHUB_TOKEN'),
  ];

  // `unknown` never fails the overall verdict. It is the answer for something
  // nobody has configured, and a Hub that was never given a Figma token is not
  // a broken Hub — it is one that cannot answer a question §3 has not started
  // asking yet.
  const failed = checks.filter((c) => c.state === 'fail' && c.required !== false);
  return {
    ok: failed.length === 0,
    failing: failed.map((c) => c.name),
    live,
    checks,
  };
}
