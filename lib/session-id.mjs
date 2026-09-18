// §2 — identity. The Linear issue key is the only one.
//
// There used to be two. The Linear Reader keyed its rows `linear/RYV-84`; the
// design-ai agent posted `ryve/ryv-84/research`. Neither collided with the
// other on the primary key, so one Linear issue grew two rows and triggering
// research added a sibling instead of moving the card. piece6 merged the
// duplicates and remembered the agent's id in an `agent_session_id` column, so
// the two conventions could be reconciled after the fact.
//
// §2 is explicit that this is the wrong shape: "No second identity scheme, and
// no bridging column between a Linear-derived row and an agent-derived row. A
// bridge implies two identities, and two identities is how one issue becomes
// two cards."
//
// So the bridge is gone and this module is what replaces it. **A stored
// identity and a parsed one are different things.** What is stored is the
// issue key, in `linear_id`, unique — which is what makes a second card for
// one issue impossible rather than merely reconciled. What is parsed is
// whatever string a caller happens to use, at the boundary, on the way in.
// Understanding an old id is not the same as keeping a second one.
//
// That is also what makes the agent's contract free to stay as it is. It can
// keep posting `ryve/ryv-84/design` for as long as it likes; the brand segment
// is read and discarded, because brand is a Linear fact derived from the team
// (§1) and encoding it in a key means the key can contradict Linear — move the
// issue and `ryve/ryv-84/design` becomes a lie nothing detects.
//
// .mjs for the same reason as derive.mjs: no package.json, Node reads it as
// ESM, esbuild resolves the import when wrangler bundles the Worker.

// One path segment that is a Linear issue key: a short team prefix, a dash,
// digits, and nothing else. Matching per segment rather than anywhere in the
// string is what keeps `conduit/wallet-flow/design` from looking like a key.
const KEY_SEGMENT = /^([a-z][a-z0-9]{0,9})-(\d{1,7})$/i;

// The stages the Hub knows. Kept in step with STAGES in worker/index.js by
// hand — there is no build step to share a constant through, and the Worker's
// copy is the one that validates a trigger.
export const STAGES = ['research', 'design'];

// The Linear identifier an id refers to, uppercased to match what Linear
// returns and what the reader stores — or null if there is none.
//
// Null is a real answer and not a failure. A session with no Linear issue
// behind it still works everywhere it always did; what it cannot do is appear
// on the board, because §2 says a record with no issue key is not a card.
export function linearKeyFromSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  for (const segment of sessionId.split('/')) {
    const m = segment.trim().match(KEY_SEGMENT);
    if (m) return (m[1] + '-' + m[2]).toUpperCase();
  }
  return null;
}

// The stage an id names, or null. Read from the segments rather than assumed
// to be the last one, so `RYV-84/design` and `ryve/ryv-84/design` answer the
// same thing and a trailing segment that is not a stage answers nothing.
export function stageFromSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  for (const segment of sessionId.split('/')) {
    const s = segment.trim().toLowerCase();
    if (STAGES.includes(s)) return s;
  }
  return null;
}

// Any id anyone uses, as the two things it actually names. This is the one
// place that has to understand the old shapes, and it understands all of them:
//
//   linear/RYV-84          the reader's old key      -> RYV-84, no stage
//   ryve/ryv-84/design     the agent's contract      -> RYV-84, design
//   RYV-84/design          canonical (§2)            -> RYV-84, design
//   RYV-84                 the card                  -> RYV-84, no stage
//   conduit/wallet-flow/x  no Linear issue at all    -> null, no stage
export function parseSessionId(sessionId) {
  return {
    issueKey: linearKeyFromSessionId(sessionId),
    stage: stageFromSessionId(sessionId),
  };
}

// The canonical id of the card for an issue. §2: "The Linear issue key is the
// only identity. RYV-84." The row is the card, and the card is the issue.
export function cardId(issueKey) {
  return issueKey ? String(issueKey).toUpperCase() : null;
}

// The canonical id of one session — `RYV-84/design`. §2's "(issue_key, stage)".
//
// Nothing is keyed by this yet: a card today holds one gate, because runs are
// serialised and only one stage is ever in flight. It is here because it is
// the identity §3, §4 and §8 need the moment research and design have to carry
// their own state at the same time, and because writing it down is what stops
// a third convention being invented when that day comes.
export function sessionKey(issueKey, stage) {
  const key = cardId(issueKey);
  if (!key) return null;
  return stage ? key + '/' + String(stage).toLowerCase() : key;
}
