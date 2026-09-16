# Work order — constrained gate decisions

**Status:** schema applied, application code not yet written
**Spec:** `GATE-CONTRACT.md` (same folder)
**Touches two repos:** `design-hub` first, then `design-ai`

---

## The bug

The design agent asked a three-option question. The recorded answer was
`"Yes"`. The client printed:

```
GATE: DECIDED
response: Yes
Use this decision and continue.
```

"Yes" names none of the three directions. An agent following its own
documentation would pick one itself — which is the exact thing the gate model
exists to prevent, since direction choice belongs to Dave.

This is structural, not editorial. A free-text `response` against a prose
`detail` blob will keep producing it. The fix is to constrain the answer to
the options that were offered.

---

## Already done — do not redo

Migration `001-gates` has been applied to the `design-hub` D1 database.
These columns exist on `agent_sessions`:

| Column | Holds |
|---|---|
| `options` | JSON array of `{id, label, summary}` |
| `response_option_id` | the chosen option's id |
| `response_note` | free text *alongside* the choice, never instead of it |
| `gate_round` | increments when a gate reopens |
| `mockups_url`, `mockups_at` | set when mockups exist |
| `handoff_at` | set when ready for a developer |

Table `gate_decisions` exists for decision history.

**Do not alter the schema.** If something seems missing, say so rather than
adding columns.

---

## Part 1 — `design-hub` repo

### API

1. **Accept `options`** on `POST /api/agent/session`. Optional. Store as JSON.

2. **Constrain the response** on `PATCH /api/agent/session/{id}/respond`.
   When the session has `options`, reject with 400 if `response_option_id`
   is missing or matches no id in the array. A `response_note` alone is
   never a decision.

3. **Add `PATCH /api/agent/session/{id}/reopen`** — writes the current round
   to `gate_decisions`, increments `gate_round`, clears the response, sets
   `status: waiting`.

4. **Add `PATCH /api/agent/session/{id}/state`** — sets `mockups_url`,
   `mockups_at`, `handoff_at`.

5. **Return `response_label`** alongside `response_option_id` on reads, so
   consumers can show what was chosen without resolving the id themselves.

### UI

6. **Render options as selectable** on a waiting card — one click per option,
   not a free-text box. Keep a separate optional note field.

7. **Show the chosen label** on an answered card, not the id.

8. **Add a reopen affordance** on an answered card.

Sessions with no `options` keep the existing free-text behaviour. No backfill.

---

## Part 2 — `design-ai` repo

In `.design-ai/bin/hub.mjs`:

9. **`GATE: DECIDED` must require `response_option_id`** when the session has
   `options`. A note without a choice is `GATE: OPEN`. This is the line that
   caused the bug.

10. **Print the chosen label**, not the id, so run logs are readable.

11. **Post `options`** when a gate enumerates choices. Ids stable for the
    round — never reuse an id to mean something different later.

---

## Do not touch

These work and are in active use:

- the trigger loop
- the Linear queue integration and `/api/agent/queue`
- `no-research` / `no-design` label handling
- QUEUED / IN FLIGHT grouping on the board
- the research stage
- authentication

If any of these appear to need changing to complete the work above, stop and
explain why rather than changing them.

---

## Verify

Post a gate with three options, then:

- answering with a note only → rejected
- answering with an unknown id → rejected
- answering with a valid id → accepted, client prints the label
- reopening → back to waiting, previous round in `gate_decisions`

---

## Scope

Fix what is listed here. If you find other problems, note them at the end and
stop — do not fix them in the same pass.
