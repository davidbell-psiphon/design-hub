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
- neither `response_option_id` nor `response_section` is given
- `response_option_id` matches no id in `options`
- both are given at once

A note alone is never a decision. This is the whole point — it is what stops
"Yes" from reading as approval.

## Answering with a design that already exists

The agent enumerates the choices, so the agent bounds what can be decided. When
none of the offered directions is the right one and the design already exists
in Figma, name the section it lives in:

```json
{ "response_section": "Wallet header v3" }
```

That decides the gate. `status` returns to `active` and the agent iterates on
that section rather than asking again.

**`response_option_id` stays null.** A section name was never one of the ids on
the list, and that column only ever holds something that was. There is no
reserved id to special-case either — reads carry an explicit `response_kind`
instead:

| `response_kind` | Means | `response_label` |
|---|---|---|
| `option` | one of the offered ids | the option's label |
| `own` | a design named by its Figma section | the section name |
| `free` | a gate with no `options`, answered in prose | the prose |
| `null` | nothing decided yet | `null` |

**`GATE: DECIDED` requires `response_kind` to be non-null**, not
`response_option_id` specifically. An own-design decision has no option id and
is still a decision. The section arrives under its own field name and never as
a bare `response_note`, because a note that decides a gate is the "Yes" bug
whatever words are in it.

## Reading — what the agent sees

```json
{
  "status": "active",
  "gate_round": 1,
  "response_kind": "option",
  "response_option_id": "d2",
  "response_label": "Labelled corner control",
  "response_note": "but tighten the label copy",
  "options": [ ... ]
}
```

An own-design answer reads back as:

```json
{
  "status": "active",
  "gate_round": 1,
  "response_kind": "own",
  "response_option_id": null,
  "response_label": "Wallet header v3",
  "response_note": "Wallet header v3",
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
