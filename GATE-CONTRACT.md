# Gate contract v2 — constrained decisions

Replaces free-text `response` as the decision mechanism. Free text still
exists, but alongside the choice rather than instead of it.

**The bug this closes:** a three-option question was answered "Yes". The
client reported `GATE: DECIDED` and told the agent to continue, so an agent
following its own documentation would pick a direction itself — the exact
thing the gate model exists to prevent.

---

## Posting a gate

`POST /api/agent/session` — unchanged except for `options`.

```json
{
  "system": "design-ai",
  "session_id": "ryve/ryv-84/design",
  "status": "waiting",
  "prompt": "Which direction proceeds?",
  "options": [
    { "id": "d1", "label": "Icon-only corner button",
      "summary": "48x48 circular + at the card's top-trailing corner." },
    { "id": "d2", "label": "Labelled corner control",
      "summary": "Same target, short label. Costs card width; +30-40% in German." },
    { "id": "d3", "label": "Collection-level add row",
      "summary": "Full-width row beneath the card. Leaves the corner empty." }
  ],
  "url": "https://figma.com/..."
}
```

`options` is optional. A gate without it behaves as today — free text, no
constraint. Use it whenever the question enumerates choices, which is most
of the time.

Ids must be stable for the life of the round. Reusing `d1` to mean something
different in a later round corrupts the decision history.

## Answering

`PATCH /api/agent/session/{id}/respond`

```json
{ "response_option_id": "d2", "response_note": "but tighten the label copy" }
```

**Rejected with 400 when `options` is present and:**
- `response_option_id` is missing
- `response_option_id` matches no id in `options`

A note alone is never a decision. This is the whole point — it is what stops
"Yes" from reading as approval.

## Reading — what the agent sees

```json
{
  "status": "active",
  "gate_round": 1,
  "response_option_id": "d2",
  "response_label": "Labelled corner control",
  "response_note": "but tighten the label copy",
  "options": [ ... ]
}
```

The client prints the chosen **label**, not a bare id, so a run log says
what was actually decided.

**`GATE: DECIDED` must require `response_option_id` when `options` is
present.** A note without a choice is `GATE: OPEN`.

## Re-opening for a revision

`PATCH /api/agent/session/{id}/reopen`

```json
{ "note": "Both directions collide with the Wallet Connect pill — revise." }
```

Writes the current round to `gate_decisions`, increments `gate_round`,
clears `response_option_id` and `response_note`, sets `status: waiting`.

The agent posts a fresh `options` array for the new round. History survives.

## Mockups and handoff

`PATCH /api/agent/session/{id}/state`

```json
{ "mockups_url": "https://figma.com/file/.../page", "mockups_at": "now" }
```

```json
{ "handoff_at": "now" }
```

Two completion levels that previously had nowhere to live. `AI-design done`
means a spec exists; `mockups_at` means something was drawn; `handoff_at`
means it is ready for a developer.

---

## Migration note

Sessions created before this are unaffected — `options` is null, so they
keep the old free-text behaviour. No backfill needed.
