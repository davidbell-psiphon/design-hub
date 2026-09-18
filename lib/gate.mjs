// The gate, read-side and write-side, in one place.
//
// Lifted out of worker/index.js when the Worker stopped being the only thing
// that had to understand a gate: `lib/card.mjs` derives what the board sees
// from a session row, and it and the Worker reading a decision two different
// ways is precisely the §5 failure ("a button and a column reading different
// sources will drift, and the drift is invisible until someone presses the
// button"). One home.
//
// What a gate is, in one line: a question with a fixed set of answers. Free
// text still exists — it rides alongside the choice as a note, never instead
// of it. §8.
//
// .mjs for the same reason as derive.mjs: no package.json, Node reads it as
// ESM, esbuild resolves the import when wrangler bundles the Worker.

// Sessions posted without options are untouched by all of it: no options, no
// constraint, free text exactly as before. There is no backfill.

// Option ids are opaque tokens, not prose. They are compared for equality and
// nothing else, and they end up inside the board's onclick attributes — so
// holding them to this alphabet means an id can never carry a quote or markup.
export const OPTION_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

// The options stored on a row, as an array. Tolerant of null, of an array
// already parsed, and of malformed JSON, for the same reason labelsOf is on
// the board: one bad row must not take a whole read down with it.
export function parseOptions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Options as posted. Returns the normalised array, or a string saying what is
// wrong with them — the agent gets told at post time, rather than the Hub
// storing a gate that nobody can answer.
export function normaliseOptions(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return 'options must be a non-empty array of { id, label }';
  }
  const seen = new Set();
  const out = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') return 'each option must be an object with id and label';
    const id = String(o.id === undefined || o.id === null ? '' : o.id).trim();
    const label = String(o.label === undefined || o.label === null ? '' : o.label).trim();
    if (!OPTION_ID.test(id)) {
      return 'option id ' + JSON.stringify(o.id === undefined ? null : o.id) +
             ' is not usable — letters, digits and . _ : - only';
    }
    if (!label) return "option '" + id + "' needs a label";
    if (seen.has(id)) return "duplicate option id '" + id + "'";
    seen.add(id);
    out.push({ id, label, summary: o.summary ? String(o.summary) : null });
  }
  return out;
}

// Whether two option sets are the same question. Re-posting a gate unchanged
// is the agent repeating its state and must change nothing; posting a
// different set is a new question, and a new question cannot keep the old
// answer.
export function sameOptions(a, b) {
  const norm = (list) => JSON.stringify(list.map(o => [
    String(o && o.id), String(o && o.label), o && o.summary ? String(o.summary) : '',
  ]));
  return norm(a) === norm(b);
}

// What an option id resolves to, in words. Null when nothing was chosen, or
// when the id names nothing in the set currently stored.
export function labelFor(options, optionId) {
  if (!optionId) return null;
  const hit = options.find(o => o && o.id === optionId);
  return hit && hit.label ? hit.label : null;
}

// What kind of decision a row is carrying, and what it amounts to in words.
//
//   'option' — one of the ids the agent offered
//   'own'    — a design the human already drew, named by its Figma section
//   'free'   — a gate with no options at all, answered in prose
//   null     — nothing decided yet
//
// The discriminator is derived rather than stored, so no reserved id has to
// live in the data and `response_option_id` never holds anything that was not
// on the list. An own-design answer is a decision with no option id, which is
// exactly what distinguishes it from an open gate.
export function decisionOf(row, options) {
  if (!row.responded_at) return { kind: null, label: null };
  if (row.response_option_id) {
    return { kind: 'option', label: labelFor(options, row.response_option_id) };
  }
  if (options.length) {
    return row.response_note ? { kind: 'own', label: row.response_note }
                             : { kind: null, label: null };
  }
  return { kind: 'free', label: row.response || null };
}

// A row as anything reading it should see it: options as an array rather than
// a JSON blob, and the decision resolved into words alongside the id. A run log
// that says "d2" says nothing about what was decided, and no consumer should
// have to look that up itself.
export function withGate(row) {
  if (!row) return row;
  const options = parseOptions(row.options);
  const decision = decisionOf(row, options);
  return {
    ...row,
    options: options.length ? options : null,
    response_kind: decision.kind,
    response_label: decision.label,
  };
}
