// Reconciling the two id conventions that write to agent_sessions.
//
// The Linear Reader keys its rows `linear/<IDENTIFIER>` and fills in
// `linear_id`. The design-ai agent posts its own `session_id`, shaped
// `<brand>/<issue-key>/<phase>` — e.g. `ryve/ryv-84/research`. Those two never
// collided on the primary key, so one Linear issue grew two rows: the
// Linear-derived card and a sibling agent card for the same work.
//
// The agent's contract is fixed — it keeps posting the id it always posted —
// so reconciliation happens here: pull the Linear issue key back out of the
// agent's session id, and let the Worker merge onto the row that key already
// owns. `agent_session_id` on that row remembers the alias, so the agent can
// still poll by the id it knows.
//
// .mjs for the same reason as derive.mjs: no package.json, Node reads it as
// ESM, esbuild resolves the import when wrangler bundles the Worker.

// One path segment that is a Linear issue key: a short team prefix, a dash,
// digits, and nothing else. Matching per segment rather than anywhere in the
// string is what keeps `conduit/wallet-flow/design` from looking like a key.
const KEY_SEGMENT = /^([a-z][a-z0-9]{0,9})-(\d{1,7})$/i;

// The Linear identifier an agent session id refers to, uppercased to match
// what Linear returns and what the reader stores — or null if there is none,
// which is how a genuinely Hub-only session (no Linear issue behind it) keeps
// working exactly as it did before.
export function linearKeyFromSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  for (const segment of sessionId.split('/')) {
    const m = segment.trim().match(KEY_SEGMENT);
    if (m) return (m[1] + '-' + m[2]).toUpperCase();
  }
  return null;
}
