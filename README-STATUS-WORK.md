# Work order — a card that says what it is actually doing

**Status:** implemented in this pass
**Touches one repo:** `design-hub` only. The agent's contract does not change.

---

## The bug

The board paints a card's label from the database row at `GET /api/agent/sessions`,
not from any live process — which is right, and is not the problem. The problem
is which field it reads first:

```js
function statusPill(r) {
  if (isWorking(r)) return { text: 'Working…', kind: 'working' };
  if (r && r.status === 'error') return { text: 'Error', kind: 'error' };
  return null;
}
```

`isWorking` is `requested_stage IS NOT NULL`, and `requested_stage` is cleared
in exactly one place — `POST /api/agent/stage-done`, which a run that failed
never reaches. So a session that has already reported `status: "error"` keeps
its queue row forever, and the board keeps painting it **Working…** forever.
There was a unit test asserting this on purpose: *"working outranks a stale
error"*. It had the precedence backwards.

Three live rows were mislabelled this way:

| Issue | Recorded | Shown |
|---|---|---|
| RYV-84 | `phase: qa`, `status: error` — "The qa stage is not implemented yet" | Working… |
| FOR-47 | `unmapped-destination` — no Figma mapping for Forge+forge | Working… |
| RYV-86 | research blocked — the Ryve BCC documents do not exist yet | Error |

RYV-84 is the one that shows why this matters: it errored because **the QA
stage does not exist**. The board offered a button for a stage nothing
implements, the run died on it, and the card then claimed to be working on it.

There was also no notion of activity at all. Nothing compares `updated_at`
against the clock, so a run whose process died without ever reporting anything
is indistinguishable from one that started ten seconds ago.

## What this is not

Not a heartbeat, not a live process check, and not a poll. Everything below is
read-side derivation from fields the API already returns — `status`, `phase`,
`requested_stage`, `updated_at`, `prompt`. Nothing new is written and no column
was added, which is the same shape the skipped-stage work took.

---

## The stories

**1. An errored task shows as errored, with the reason.**
> As a design lead, I want a task that has stopped to say so and to say why, so
> that I can tell at a glance it has stopped rather than progressing.

`status: 'error'` now outranks everything. The card carries a short error line
taken from the row's own `prompt`, which is where the agent puts the failure.

**2. Each card's label matches its record.**
> As a design lead, I want every card to reflect its real state — working,
> stalled, needs-you, errored, done — sourced from the session record.

One function, `runState`, is the only place a card's state is decided. The pill,
the card's tint, the stage button's text and the activity panel all read it, so
they cannot disagree with each other the way the button and the column once did.

**3. A stalled task cannot hide inside "working".**
> As a design lead, I want a task with no activity for 30 minutes to be flagged,
> so that an eternally-working card can't conceal a dead process.

`isStalled` — queued, and `updated_at` older than `STALL_AFTER_MIN`. A row whose
timestamp will not parse is **not** stalled: a missing column must not flag the
whole board.

**4. One place to watch the whole pipeline.**
> As a design lead, I want a panel showing what every task is doing and when it
> last moved, so I have one place to monitor everything.

The right-hand panel was "In flight", and listed only queued rows, grouped by
App / Website. It is now **Activity**: every card that is doing something, in
severity order, with how long since it last moved. The severity ordering is why
the App / Website split went — it cannot group by two things at once, so the
track rides along on each row instead.

**5. The QA stage is gone.**
> As a design lead, I want the QA stage off the board so that nothing can be
> pushed into a stage nothing implements.

End to end: out of the Worker's `STAGES`, out of the stage ladder, out of the
columns. `AI-designed` is the final column and a card there offers no button.
`AI-QA done` is no longer read, so a card carrying it renders as AI-designed.

---

## The five run states

`runState(r)` returns the first that matches. The order is the fix.

| State | Comes from | Pill |
|---|---|---|
| `error` | `status === 'error'` | **Error**, red |
| `stalled` | queued, and `updated_at` older than 30 minutes | **Stalled**, red-dim |
| `working` | `requested_stage` is set | **Working…**, amber |
| `waiting` | a gate is open — options posted, nothing chosen | **Needs you**, amber |
| `done` | `status === 'done'` | **Done**, green |
| `idle` | none of the above | no pill |

`done` is safe to render only because it is written in one place —
`stage-done` — and is never a default. `waiting` is **not** `status === 'waiting'`:
the reader writes that on every quiet row it inserts, so a pill for it would
appear on the whole board. The state that actually needs a human is an open
gate, and that is what `waiting` means here.

---

## The gap this pass left, and how it closed

**An errored run that still holds its queue row could not be retried from the
board.** `requested_stage` stayed set, so the stage button stayed disabled, and
`POST /api/agent/session/:id/trigger` answered `409 already queued`. It was
written down here rather than bolted onto a rendering change.

It stopped being hypothetical the same day. Four issues — FOR-48, FOR-49,
FOR-26, MAR-978 — were queued, never picked up, and had no way back: the runner
takes two issues per dispatch (`DEFAULT_MAX_ISSUES = 2` in the design-ai repo's
`runner.mjs`, and a blocked issue burns a slot), the Hub dispatches with no
inputs believing the runner drains the whole queue, and nothing re-dispatches.

Closed by `DELETE /api/agent/session/:id/trigger` and a **Reset** control on
errored and stalled cards. See **Reset** in the README.

## The two that were not in this repo, and now are fixed

- **`routing.json` had no `Forge` team.** Its destinations were `Conduit App`,
  `Ryve App` and `Websites` (conduit / psiphon / forge / ryve), so FOR-47
  blocked on `unmapped-destination` and FOR-26/48/49 would have blocked
  identically. `Forge + forge` now routes to the **Forge App** file
  (`yAeyC9MEWstRdafKqHRwjA`), which is where the Forge Self-Serve product's
  designs live. Forge's marketing site is a different destination and stays
  under `Websites + forge`. The runner test that asserted Forge was unmapped is
  replaced by two that assert where it goes, and that the two Forge
  destinations are not the same file.
- **The two repos disagreed about the queue.** The Hub now passes `max_issues`
  on dispatch, set to the queue depth and capped at `RUNNER_MAX_ISSUES`. See
  **The trigger** in the README.

## Still open, and not a code problem

**MAR-978 is not design work.** It is "BCC — Forge": write brand documents into
`design-ai-repo/documents/forge/` and push them. It produces no Figma output, so
there is no destination to map and adding one would send a writing task to a
design file. It wants **Reset**, then **No design** — which is exactly what that
label is for.
