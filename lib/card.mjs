// What the board reads, derived from what is stored.
//
// piece11 split one row into two tables — `cards` (the issue, and what you
// decided about it) and `sessions` (one per stage, holding the run and the
// gate). The board did not move, and it did not have to: this is the one place
// that flattens the two back into the shape it has always been sent.
//
// **This is a projection, computed per request, and it is never stored.** That
// is the whole difference between it and the row it replaced. A stored
// flattening is a copy of two facts in a third place, which is how §11's bugs
// started; a computed one cannot disagree with its sources because it has none
// of its own.
//
// §5: "Derive, don't denormalise… Which buttons show comes from *the same*
// completion the board drew the card with — so they cannot disagree."
//
// .mjs and free of any binding, so it can be tested directly.

import { withGate, parseOptions } from './gate.mjs';
import { isScreenshotWork } from './derive.mjs';

// The stages the Hub runs. `qa` was offered by the board and implemented by
// nothing; §12 retired its label, and it is not a stage a session can be at.
export const STAGES = ['research', 'design'];

// A SQLite `datetime('now')` stamp as milliseconds. NaN for anything that will
// not parse, which every caller treats as "cannot tell" rather than as a value.
function ms(ts) {
  if (!ts) return NaN;
  const s = String(ts).replace(' ', 'T');
  return Date.parse(/[Zz]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
}

// Is this session sitting at a question nobody has answered?
function gateIsOpen(session) {
  if (!session || session.status !== 'waiting') return false;
  return parseOptions(session.options).length > 0 && !session.responded_at;
}

// Which session the flattened card speaks for.
//
// A card can now hold one per stage, and the board draws one card with one
// pill. So one session has to be the one it is about, and the order is from
// the most immediate thing to the least:
//
//   queued      something is happening, or is about to. Oldest request first,
//               which is the order the runner will actually work in.
//   open gate   nothing is running, but something is waiting on you.
//   newest      nothing needs anything; show the last thing that happened.
//
// Null for a card with no sessions at all, which is §3's "Not started" — the
// absence of a row rather than a status that has to mean two things.
export function activeSession(sessions) {
  const all = (sessions || []).filter(Boolean);
  if (!all.length) return null;

  const queued = all.filter((s) => s.requested_at);
  if (queued.length) {
    return queued.slice().sort((a, b) => {
      const ta = ms(a.requested_at), tb = ms(b.requested_at);
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return ta - tb;
    })[0];
  }

  const waiting = all.filter(gateIsOpen);
  if (waiting.length) return waiting[0];

  return all.slice().sort((a, b) => {
    const ta = ms(a.updated_at), tb = ms(b.updated_at);
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  })[0];
}

// One session, as anything reading it should see it: options as an array
// rather than a JSON blob, the decision resolved into words alongside its id,
// and the stage it belongs to.
export function sessionWire(session) {
  if (!session) return null;
  const g = withGate(session);
  return {
    stage: g.stage,
    system: g.system,
    status: g.status,
    prompt: g.prompt,
    detail: g.detail,
    options: g.options,
    gate_round: g.gate_round,
    response: g.response,
    response_option_id: g.response_option_id,
    response_note: g.response_note,
    response_kind: g.response_kind,
    response_label: g.response_label,
    responded_at: g.responded_at,
    requested_at: g.requested_at,
    started_at: g.started_at,
    last_error: g.last_error,
    last_error_at: g.last_error_at,
    mockups_url: g.mockups_url,
    mockups_at: g.mockups_at,
    handoff_at: g.handoff_at,
    updated_at: g.updated_at,
    created_at: g.created_at,
  };
}

// A card and its sessions, in the shape the board has always been sent.
//
// The card's own fields, plus the active session flattened on top of them,
// plus every session under `stages` for anything that wants the detail. The
// flattening exists so `frontend/board-logic.js` needs no change; `stages` is
// what §3 and §4 will read when a card has to say that research is Drift while
// design is Unverified.
//
// Two names are translated here and nowhere else:
//
//   issue_key -> id        the board's row key. §2 made the issue key the
//                          identity, and `id` is what the board calls it.
//   brand     -> project   the column was called `project` and held the brand,
//                          which needed a comment to explain every time. The
//                          storage is honest now; the wire keeps the old name
//                          because the agent posts `project` too, and one name
//                          on the wire beats two.
export function toWire(card, sessions = []) {
  if (!card) return null;
  const list = (sessions || []).filter(Boolean);
  const active = activeSession(list);

  const stages = {};
  for (const s of list) stages[s.stage] = sessionWire(s);

  return {
    // ── identity (§2) ──
    id: card.issue_key,
    linear_id: card.issue_key,

    // ── Linear-owned, a cache with a visible age (§5) ──
    linear_uuid: card.linear_uuid,
    title: card.title,
    url: card.url,
    team: card.team,
    linear_state: card.linear_state,
    labels: card.labels,
    linear_project: card.linear_project,
    linear_read_at: card.linear_read_at,
    // What kind of work this is, derived from the two Linear fields above and
    // never stored: 'screenshots' for store-listing screenshot work — the
    // `store-screenshots` label, or the word in the title (lib/derive.mjs) —
    // and null for everything else. The board styles the card and names its
    // buttons from this; the runner makes the same call from the same
    // vendored function, so the two cannot disagree about which issues it is.
    kind: isScreenshotWork(card.labels, card.title) ? 'screenshots' : null,

    // ── Hub-owned: what you decided about the issue ──
    project: card.brand,
    track: card.track,
    figma_url: card.figma_url,
    dismissed_at: card.dismissed_at,
    set_aside_at: card.set_aside_at,

    // ── the active session, flattened ──
    // `detail` is the agent's context where there is a session carrying one,
    // and the Linear description otherwise. They are separate columns now and
    // this is the only place they meet — the board shows one line and does not
    // care which it got.
    system: active ? active.system : null,
    phase: active ? active.stage : null,
    status: active ? active.status : null,
    prompt: active ? active.prompt : null,
    detail: (active && active.detail) || card.description || null,

    // `requested_stage` is what the board reads to know a run was asked for.
    // There is no such column now — the stage is the row — so it is derived
    // from which session is queued.
    requested_stage: active && active.requested_at ? active.stage : null,
    requested_at: active ? active.requested_at : null,

    ...gateFields(active),

    mockups_url: active ? active.mockups_url : null,
    mockups_at: active ? active.mockups_at : null,
    handoff_at: active ? active.handoff_at : null,
    last_error: active ? active.last_error : null,
    last_error_at: active ? active.last_error_at : null,

    // The session's clock, not the card's. A reader pass moves the card's
    // `updated_at` and must not look like activity on a run — the board
    // compares this against `requested_at` to tell a started run from a queued
    // one, and a Wednesday cron read used to reset that.
    updated_at: (active && active.updated_at) || card.updated_at,
    created_at: card.created_at,

    // ── every stage, for what reads per-stage state (§3, §4) ──
    stages,
  };
}

// The gate, flattened off the active session. Split out so the null case is
// written once: a card with no session has no gate, and every one of these
// has to be present and null rather than absent, or a consumer has to test for
// two different kinds of nothing.
function gateFields(active) {
  if (!active) {
    return {
      options: null, gate_round: null, response: null, response_option_id: null,
      response_note: null, response_kind: null, response_label: null,
      responded_at: null,
    };
  }
  const g = withGate(active);
  return {
    options: g.options,
    gate_round: g.gate_round,
    response: g.response,
    response_option_id: g.response_option_id,
    response_note: g.response_note,
    response_kind: g.response_kind,
    response_label: g.response_label,
    responded_at: g.responded_at,
  };
}
