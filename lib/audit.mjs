// Audit cards — a Linear issue whose title has the word "Audit" in it.
//
// A design audit is a standing piece of work, not a one-off: "Design audit:
// Ryve" is pressed again and again over time, and each press produces a new
// report and a diff against the last one. So an audit card has one stage,
// `audit`, and that stage can be run again after it finishes — where research
// and design run once and move the card on.
//
// The rule is the title, and only the title: Dave names these issues, and the
// word is how he says what the issue is. Whole word, any case — "Design audit:
// Ryve" and "Audit the Conduit onboarding" are audits, "Auditorium seating" is
// not.
//
// Flagged, never triggered. What the flag does is put an audit button on the
// card instead of research and design; nothing runs until a person presses it,
// exactly as on every other card.
//
// One place, so the Worker (which refuses the wrong stage for the card) and
// the board (which reads `kind: 'audit'` off the wire, lib/card.mjs) cannot
// disagree about which issues are audits. A file of its own rather than a
// function in lib/derive.mjs, because derive.mjs is vendored into design-ai and
// hash-checked there.

export const AUDIT_STAGE = 'audit';
export const AUDIT_WORD = /\baudit\b/i;

export function isAuditTitle(title) {
  return AUDIT_WORD.test(String(title || ''));
}
