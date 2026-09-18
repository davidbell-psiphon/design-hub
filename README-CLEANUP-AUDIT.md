# §13 cleanup — the audit

> Step 1 of §13: *"Audit first, delete nothing. Report every reference to each
> table and each endpoint, in the Worker, the Pages function, the board JS, and
> the tests. Say plainly which are dead and which are live."*

Done 18 September 2026. Nothing was deleted to produce it.

## The short version

**The chat organiser's code is already gone.** Every endpoint §13 lists was
removed in an earlier pass, and `test/smoke.test.mjs:144` already asserts that
each one answers 404 in production. Step 3 of §13 — "remove the code" — has
almost nothing left to do.

**One table is live, and it is the surprise §13 predicted.** The board's brand
list reads `projects`. Dropping that table takes the brand buckets, the brand
colours and the "Move to…" menu with it.

**One table on the list does not exist.** There is no `brands` table and there
never was. Brand identity lives in `projects` under `section_id = 'brands'`.

## Table by table

| Table | References in code | Verdict |
|---|---|---|
| `chats` | none | **Dead.** Endpoint already removed; smoke test holds it at 404 |
| `resources` | none | **Dead.** Same |
| `capabilities` | none | **Dead.** Same. The `capabilities` hits in the Worker are `agent_heartbeats.capabilities`, an unrelated column of the same name |
| `sections` | none | **Dead.** The "sections" in `board-logic.js` are the board's collapsed groups, not this table |
| `projects` | `worker/index.js:1505`, `test/helpers.mjs:50`, `test/routes.test.mjs:145` | **LIVE — see below** |
| `brands` | none | **Does not exist.** Not in `schema.sql`, not in any migration |
| `auth` | none | **Dead** |
| `sessions` | none | **Dead** — but read the name collision note below |
| `rate_limits` | none | **Dead** |

Searched: `worker/index.js`, `functions/api/[[path]].js`, `frontend/index.html`,
`frontend/board-logic.js`, `lib/*.mjs`, `test/*.mjs`.

Every table the Worker actually touches:

```
agent_sessions   agent_heartbeats   gate_decisions   reader_teams   projects
```

Four of those five are the current system. `projects` is the remnant.

## The live one: `projects`

```js
// worker/index.js:1503
if (method === 'GET' && path === '/api/brands') {
  const { results } = await env.DB.prepare(
    `SELECT id, name, color FROM projects WHERE section_id = 'brands' ORDER BY sort_order`
  ).all();
```

That is the board's only structural read. `frontend/index.html:676` turns the
result into `brands` and `brandsById`, which drive:

- the brand buckets the whole board is grouped into (`index.html:699`)
- each card's colour
- the "Move to…" reassignment menu (`index.html:451`)
- whether a card counts as placed or falls into Unassigned (`index.html:648`)

`piece4-schema.sql` also writes to it — the four brand colours are `UPDATE`
statements against `projects`. So `test/helpers.mjs:50` has to create the table
for the schema pieces to apply at all, which is why it appears in the harness.

**This is a fact living in a home that lies about what it is.** Brand identity
is current, Hub-owned configuration. It is stored in a table named after a
retired product, found by filtering on a magic `section_id` that only makes
sense if you know the history. Reading that line does not tell you it is the
board's brand list; a comment has to.

Fixed in `piece10-schema.sql` — see below.

## The name collision worth knowing about

`GET /api/sessions` is a live endpoint. The `sessions` **table** is dead. They
are unrelated: the endpoint reads `agent_sessions`.

The trap runs both ways. `DROP TABLE sessions` looks like it would break
`/api/sessions` and does not. And keeping the table because that endpoint exists
would be keeping it for no reason. Whoever eventually runs step 4 needs to know
this, because the names give exactly the wrong impression.

## What was done about it

Nothing was dropped — David's instruction, and §13 step 4 is a separate
migration anyway.

`piece10-schema.sql` adds a `brands` table that says what it holds, seeded from
the four rows `projects` currently carries. `/api/brands` reads it, and falls
back to the old query while the new table is empty, so the deploy and the
migration can happen in either order without the board losing its brands. The
fallback is marked in the code with the conditions for deleting it.

After that migration runs, `projects` has no reader. Every table on §13's list
is then genuinely unreferenced, and step 4 becomes a decision about data
retention rather than a change that could break something.

## What is left of §13

| Step | State |
|---|---|
| 1. Audit | **Done** — this document |
| 2. Export to JSON, committed | **Blocked.** `npx wrangler d1 execute --remote` returns `7403 not authorized`. `tools/export-legacy.sh` is written and ready; it needs a working `wrangler login` |
| 3. Remove the code | **Already done**, before this pass. What remained was the `projects` read, now moved |
| 4. Drop the tables | **Not done, by instruction.** Unblocked by the above whenever it is wanted |

## Scope note

§13's rule: *"fix what the task names. If you find something else, write it down
at the end and stop."*

Found and not fixed:

- `design_hub_update.md` still documents `design-ai:go` as the trigger
  mechanism. It describes a design that was replaced by the Hub's own queue
  (`worker/index.js:893`). It reads as current and is not. Not touched — it may
  be kept as history, like `schema.sql`.
- `test/helpers.mjs:50` creates `projects` by hand so `piece4-schema.sql` can
  apply verbatim. That stays correct and stays necessary as long as the pieces
  are replayed in order, which is half of what those suites check.
