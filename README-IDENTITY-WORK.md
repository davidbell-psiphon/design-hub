# §2 — identity, and where data lives

Done 18 September 2026, in two steps on the same evening. This is the record of
what changed and why, for whoever reads the code next.

---

## The short version

`agent_sessions` held three different kinds of fact in one row, under a name
that two different writers spelled two different ways. Both halves of that are
now fixed:

- **Identity.** `cards.issue_key` is the primary key. A second card for one
  Linear issue cannot be written — not reconciled away afterwards, not merged
  by a migration. Written.
- **Grain.** A session is `(issue_key, stage)`, in its own table, so research
  and design each carry their own status, gate, error and history.

The board did not change. Not one line of `frontend/`.

---

## Part 1 — identity

### What it was

The Linear Reader keyed its rows `linear/RYV-84`. The design-ai agent posted
`ryve/ryv-84/research`. Neither collided with the other on the primary key, so
one issue grew two rows and triggering research added a sibling instead of
moving the card. `piece6-schema.sql` merged the duplicates and remembered the
agent's id in `agent_session_id`, and three lookups grew up around it.

That is reconciliation, and reconciliation is a thing you have to keep being
right about. §2's objection is exact: *"A bridge implies two identities, and two
identities is how one issue becomes two cards."*

### What it is

**The issue key is the primary key.** First as a unique index
(`migration-003-identity.sql`), then outright as `cards.issue_key`
(`piece11-schema.sql`). Two rows for one issue is not a bug to be caught; it is
a statement the database refuses.

Everything else followed:

- Rows are named by their issue — `RYV-84`. `linear/…` is gone as a convention.
- Nothing writes `agent_session_id`; the new tables have no such column.
- Brand left the key. It is derived from the Linear team, so a session id naming
  the wrong brand lands on the right card and does not change its brand.
- A record with no Linear issue behind it is not a card. It still exists and
  still works on its own routes — the runner's reachability probe is one.

**The agent's contract never changed.** It posts `ryve/ryv-84/design` and always
can: `lib/session-id.mjs` parses the key and the stage back out at the boundary.
**Parsing an id is not storing a second one**, and that distinction is what the
whole change rests on.

---

## Part 2 — where data lives

### The three facts that were sharing a row

| Kind | Owner | Was | Is |
|---|---|---|---|
| The issue | Linear | mixed into the row | `cards`, replaced on every read, with `linear_read_at` |
| The card | You | mixed into the row | `cards`, never touched by a read |
| The session | The Manager, per stage | **one per issue** | `stage_sessions`, one per `(issue_key, stage)` |

### Why the grain mattered, given nothing was visibly broken

It wasn't visibly broken because runs are serialised — GitHub's concurrency
group allows one at a time — so only ever one stage was in flight and one set of
gate columns was enough.

It breaks the moment two stages have something to say at once, which is what
§3, §4 and §8 each ask for:

- research is `Drift` while design is `Unverified` — §3 has six states per
  stage, and the row could hold one
- research failed while design waits on a gate — §4 keeps the last error per
  stage, and the row kept one
- a design gate is reopened without disturbing research history — §8 numbers
  rounds, and the row numbered them once

`test/grain.test.mjs` asserts each of those now works. Every one of them would
have silently done the wrong thing before.

### Three things that got simpler rather than more complex

**The guard that is gone.** `cards.description` is the Linear description;
`stage_sessions.detail` is the agent's context. They shared a column, so the reader
needed a CASE to avoid wiping the agent's — first keyed off the bridge column,
then off `agent_posted_at`. Separate columns mean no guard, and both facts
survive, which the old shape could not manage at all.

**`requested_stage` is gone.** The stage *is* the row, so queuing is
`stage_sessions.requested_at`. A column saying which stage was queued could disagree
with the stage that was actually queued; now there is nothing to disagree with.

**The reader writes no sessions.** It used to stamp `status='waiting'` and
`prompt='Run design research on RYV-84?'` onto every row it discovered — a gate
on every card that was not a gate. §3's "Not started" is the absence of a
session now, which is what that state always meant.

### The wire did not move

`lib/card.mjs` flattens a card and its sessions into exactly the shape the board
has always been sent — **computed per request, never stored**. That is the whole
difference between it and the row it replaced: a stored flattening is a third
copy of two facts, and a computed one has no facts of its own to drift.

It adds `stages: { research: {…}, design: {…} }` alongside, which is what to
read when a card needs to say two things at once.

`test/grain.test.mjs` asserts every field the board reads is still served, by
listing them — so removing one from the projection fails a test rather than a
card.

---

## §15, answered

**Does the Manager advance Linear status?** It does, through
`POST /api/agent/session/:id/complete`, and §6 says it never should.

**The document moves, not the code.** §6 exists to stop the Manager *inventing*
a fact it does not own — deciding by itself that work is finished. A human
pressing Complete is not that; it is the press being carried to Linear instead
of you opening Linear to do the same thing by hand.

What keeps the exception honest is that nothing else can reach that mutation.
The cron read, the agent post, stage-done, dismiss and set-aside are each
asserted never to write issue status. That assertion is the justification —
if a future change makes any other path complete an issue, the exception stops
being defensible. `CLAUDE.md` says so where someone will see it.

---

## What was verified, and how

536 tests, 0 failing. Every invariant was proved to bite: break it deliberately,
confirm the named test fails, restore, confirm green.

- 10 breaks for §3/§5/§6/§8/§12/§14 (`test/invariants.test.mjs`)
- 9 breaks for §2 identity (`test/identity.test.mjs`)
- 12 breaks for the grain split and the projection (`test/grain.test.mjs`)

One break did **not** bite, and that was the right answer: swapping the order of
the two lookups in the agent post route changes no behaviour, because once a row
carrying an issue is named by it, the two cannot disagree. The comment there
says so rather than claiming the order matters.

`design-ai` is unaffected — 113 client checks and 114 runner tests, unchanged.

---

## Deploying it

**Order matters, and it is in DEPLOY.md.** In short:

```bash
npx wrangler d1 execute design-hub --remote --file=./migration-003-identity.sql
npx wrangler d1 execute design-hub --remote --file=./piece10-schema.sql
npx wrangler d1 execute design-hub --remote --file=./piece11-schema.sql
npx wrangler d1 execute design-hub --remote --file=./migration-004-grain.sql
npx wrangler deploy
```

Migrations first, deploy immediately after, in one sitting. The currently
deployed Worker reads `agent_sessions` and is unaffected by any of the files, so
there is no moment where the board is broken — but anything it writes between
the copy and the deploy lands in the old table and is not carried across. If the
cron fires in that window, press Read Linear afterwards.

**Nothing is dropped.** `agent_sessions` is frozen at migration time and is the
rollback: revert the Worker and it is still there, still correct.

---

## What went wrong on the first deploy

Worth keeping, because the failure was not in the SQL — it was in the test
database being a different shape from the real one.

`piece11-schema.sql` originally called its table `sessions`. The live database
already has a `sessions` table: the password-auth one the retired chat organiser
left behind, dead since Access took over, still present because §13 step 4 has
not been run. So `CREATE TABLE IF NOT EXISTS sessions` did nothing at all,
silently, and the next statement failed with `no such column: requested_at`.

The whole suite was green through all of it. `freshDb` built a database with the
four live tables and a stub `projects`, so the name was free — the test database
had none of the legacy tables the real one still carries.

Three things changed as a result:

- The table is `stage_sessions`.
- **`freshDb` creates the legacy tables.** That is the actual fix: the test
  database is now the shape of the real one, and re-introducing the collision
  fails 20 tests locally with the exact production error.
- `test/sql.test.mjs` parses `schema.sql` for every name the old product used
  and fails any piece that reuses one. `IF NOT EXISTS` turning a collision into
  a silent no-op is the worst combination there is, so it gets its own test.

The §13 audit had already flagged this, under a heading called "The name
collision worth knowing about". Writing it down was not the same as checking it.

---

## Still open

**§3's evidence layer needs two integrations that do not exist.** Linear
comments the Hub already has. GitHub file reads and Figma structure reads are
new clients with no credentials. `GET /api/diagnostics` already reports both as
`unknown` rather than absent, which is §14.1's rule for them — so a missing
Figma token can never read as "the design stage did not run".

**§4's states are expressible now and not yet written.** `blocked` is in the
`sessions.status` CHECK and nothing writes it; `last_error` and `last_error_at`
are columns nothing fills. The grain that made them possible is in place, which
is what was blocking them.
