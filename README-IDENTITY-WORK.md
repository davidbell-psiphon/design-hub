# §2 — what was done, and where data should live next

Written 18 September 2026, alongside the change that removed the second
identity scheme.

---

## What §2 actually was

Not a naming problem. The system had **two writers with two naming schemes and
no shared key**, and everything else followed from that.

The Linear Reader keyed its rows `linear/RYV-84`. The design-ai agent posted
`ryve/ryv-84/research`. Neither collided with the other on the primary key, so
one issue grew two rows. `piece6-schema.sql` merged the duplicates and added
`agent_session_id` to remember the agent's id, and three lookups grew up around
it to make the two conventions agree after the fact.

That is reconciliation, and reconciliation is a thing you have to keep being
right about. §2's objection is exact: *"A bridge implies two identities, and two
identities is how one issue becomes two cards."*

## What changed

**`linear_id` is the identity, and it is unique.**

```sql
CREATE UNIQUE INDEX idx_agent_linear_unique
  ON agent_sessions(linear_id) WHERE linear_id IS NOT NULL;
```

One statement, and the first bug in §11 stops being possible rather than
becoming well-handled. Whatever writes, whatever the id string says, two rows
cannot claim one issue. The index is partial, so the sessions that legitimately
have no issue are unaffected — there can be any number of those, and they are
not cards.

Everything else follows from that:

- **Rows are named by their issue.** `RYV-84`. `linear/…` is gone as a
  convention, and `migration-003-identity.sql` renames what is there, carrying
  `gate_decisions` with it in the same file so history is not orphaned.
- **The bridge is dead in code.** Nothing writes `agent_session_id`. The column
  stays on the table — dropping it was not wanted, and keeping it means this is
  reversible by reverting the Worker alone.
- **The parser replaced the bridge.** `lib/session-id.mjs` reads the issue key
  out of whatever string arrives. Six shapes resolve, including every one
  anything still sends. **Parsing an id is not storing a second one**, which is
  the distinction the whole change rests on.
- **Brand left the key.** It is derived from the Linear team. A session id
  naming the wrong brand now lands on the right card and does not change the
  card's brand — which is the point, because encoding it was what let the key
  contradict Linear.
- **A record with no issue key is not a card.** Filtered out of
  `GET /api/agent/sessions`. It still exists and still works on its own routes,
  because the runner's reachability probe is one of them.

### Why this is safe to deploy in either state

The key is parsed, not looked up in a bridge, so the Worker resolves a renamed
database and an unrenamed one identically.

**One exception, and it is the deploy order.** `agent_posted_at` is new and the
Worker writes it. Run the migration first. DEPLOY.md has the detail and the
check.

### What it cost

Eight invariant breaks were introduced deliberately and eight were caught by a
named test. The ninth — swapping the order of the two lookups in the agent post
route — changed no behaviour and no test, which is the correct result and is
now said in the comment there: once a row carrying an issue is named by it,
the two lookups cannot disagree. That is what was not true before.

495 local tests, 0 failing.

---

## Where data should live next

§2 says a session is `(issue_key, stage)` — `RYV-84/design`. That is **not**
what the table holds, and the difference is deliberate. It is worth being
precise about why, because it is the next piece of work.

### Three kinds of fact are still in one row

| Kind | Who owns it | Examples |
|---|---|---|
| **The issue** | Linear | `title`, `team`, `linear_state`, `labels`, `linear_project`, `url` |
| **The card** | You, in the Hub | `dismissed_at`, `set_aside_at`, `figma_url`, brand/track override |
| **The session** | The Manager, per stage | `status`, `prompt`, `options`, `gate_round`, `response*`, `requested_stage`, `last error` |

One row per issue holds all three. The identity fix made the row's *name*
right. It did not change its *grain*.

### What that costs today: nothing. What it costs the moment §3 lands: a lot

A card has **one gate**, not one per stage. That works right now for a reason
that is nothing to do with design: runs are serialised — GitHub's concurrency
group allows exactly one at a time — so only one stage is ever in flight, and
one set of gate columns is enough.

It stops working the moment any of these is wanted, and §3, §4 and §8 all want
them:

- Research is `Drift` and design is `Unverified` **at the same time** (§3 has
  six states per stage; the row can hold one)
- Research failed with one error and design is waiting on a gate (§4 keeps the
  last error per stage; the row keeps one)
- A design gate is reopened while research history stays intact (§8 numbers
  rounds; the row numbers them once)

### The shape, when it is wanted

Two tables, and the split follows ownership rather than convenience:

```
cards     PK issue_key                -- the issue cache + your overrides
sessions  PK (issue_key, stage)       -- everything transient, and the whole gate
```

Three things make it worth doing properly rather than approximately:

**1. The gate columns move, they do not copy.** `options`, `gate_round`,
`response*`, `responded_at`, `status`, `prompt` leave `cards` entirely. If they
exist in both places for even one release, the fact has two homes and this
document's one rule is broken — which is how every bug in §11 started.

**2. The wire format does not change on day one.** `/api/agent/sessions` keeps
returning what it returns: the card, flattened with the active session's fields
— **computed per request, never stored** — plus a new `stages: { research: {…},
design: {…} }`. `frontend/board-logic.js` needs no change to keep working, and
can adopt the per-stage detail when there is a reason to.

**3. The Linear cache gets a visible age.** §5 permits a cache on three
conditions, and the one currently missing is "it has a visible age". A
`linear_read_at` on `cards` costs one column and makes the honest statement the
board cannot currently make: *this is what Linear said, at this time.*

The test that proves the split is real: **`DELETE FROM` the Linear-owned
columns and nothing a human decided is lost.** If that is true, the cache is a
cache. If it is not, it is a second home.

### Why it was not done tonight

§0: *"Audit before deleting, tests before refactoring, refactor last."*

A grain change under a working gate mechanism, on the same night as an identity
change, with no way to deploy or to verify against production, is two
refactors stacked with the net still being built. The identity fix stands on
its own, is covered, and is reversible. This one should go in awake, on its
own, with the board in front of you.

---

## Two things found and not fixed

Per §13's scope rule: write it down at the end and stop.

### The Manager does advance Linear status, and §6 says it must not

§15 asks: *"Does the Manager advance Linear status? … Either the Manager moves
status — contradicting §6 — or the docs state plainly that it never will.
Currently neither is true."*

Currently the **first** one is true. `POST /api/agent/session/:id/complete`
(`worker/index.js`) resolves the team's earliest completed state and writes it:

```
mutation Complete($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}
```

§6 lists what the Manager writes, and says plainly: *"Never issue status,
title, assignee, cycle, or brand."* The code contradicts the architecture of
record, and the route is deliberate, documented and useful — it exists to save
the trip to Linear.

This is a decision, not a bug to fix quietly. Either §6 gains an exception for
an explicit human press, or the route goes. Untouched either way.

### §3's evidence layer needs two integrations that do not exist

§15 asks which new reads §3 requires. Scoped:

| Evidence | Source | State |
|---|---|---|
| Research report, user stories, design spec | Linear comments | **Have it.** `LINEAR_API_KEY` already reads the API; comments are one more query |
| BCC files written or updated | GitHub | **New.** No credential, no client |
| Sections named `[ISSUE-KEY] …`, variation counts, user flows | Figma | **New.** No credential, no client |

`GET /api/diagnostics` already reports both as `unknown` rather than absent,
which is §14.1's rule for them: *"Reporting absence when you cannot look is
worse than reporting nothing."* So the honest half of §3 is in place before §3
is — a missing Figma token can never read as "the design stage did not run".
