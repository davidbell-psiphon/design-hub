# Design Hub — working notes for Claude

Read [README.md](./README.md) before changing anything. It explains what the Hub
is and why each piece is shaped the way it is. This file does not repeat it —
it covers only what a session needs in order to avoid breaking something.

## Hard constraints

**No package.json, no dependencies, no build step.** This is deliberate, not an
oversight. `frontend/index.html` is served as-is, `frontend/board-logic.js` is a
classic script rather than a module so the inline `onclick` handlers keep
resolving against globals, and Access JWT verification is written against
WebCrypto rather than `jose` for exactly this reason. Do not add npm packages, a
bundler, or a framework. If something appears to need one, raise it first.

**Never run `schema.sql` against the live database.** It opens with `DROP TABLE`
and recreates the old hierarchy with seed data. It is kept for history, not for
deploys.

**Schema changes are new files, never edits to existing ones.** The live schema
arrived as additive pieces — `agent-schema.sql`, `reader-schema.sql`,
`track-schema.sql`, `piece4-schema.sql`, `piece5-schema.sql`, all already
applied. Add `pieceN-schema.sql` using `ALTER TABLE` / `CREATE INDEX IF NOT
EXISTS`, so re-running one fails on a duplicate column instead of destroying
data.

## Where data lives

**Read this before touching any query.** It is the thing most likely to be
assumed wrong, and the reason for most of the architecture document.

Three kinds of fact, three homes, split on who owns them:

| Table | Grain | Holds | Who writes it |
|---|---|---|---|
| `cards` | one per Linear issue | the Linear cache, and your overrides | the reader, and your presses |
| `stage_sessions` | one per **(issue_key, stage)** | the run and the whole gate | the agent, and the trigger |
| `gate_decisions` | one per round | decision history | `closeRound` only |

```
cards.issue_key ─┬─ stage_sessions (issue_key, stage)  research | design
                 └─ gate_decisions (session_id = issue_key, stage, gate_round)
```

**It is `stage_sessions`, not `sessions`.** The retired chat organiser left a
`sessions` table in the live database (password auth, dead since Access took
over, still there because §13 step 4 has not run). Naming the new one `sessions`
made `CREATE TABLE IF NOT EXISTS` a silent no-op against production, and the
next statement failed on a column that was never created — a failed deploy, with
the local suite green throughout.

**Check `schema.sql` before naming a new table.** `test/sql.test.mjs` enforces
it, and `freshDb` creates the legacy tables now, so the test database is the
shape of the real one.

### Identity: the Linear issue key, and nothing else

A card is named by its Linear issue. `RYV-84` — not `linear/RYV-84`, not
`ryve/ryv-84/design`. `cards.issue_key` **is** the primary key, so a second
card for one issue is not reconciled away: it cannot be written.

**The agent still posts whatever it likes.** `ryve/ryv-84/design` keeps working
and always will — `lib/session-id.mjs` parses the key and the stage back out of
it at the boundary. Parsing an id is not the same as storing a second one, and
that distinction is the whole of §2. If you find yourself adding a column so
two naming schemes can be matched up later, that is the bug the architecture
document is about.

**Brand is never part of the key.** It is derived from the Linear team. A
session id naming the wrong brand lands on the right card and does not change
the card's brand — there is a test for exactly that, because a brand in the key
is a key that can contradict Linear.

**A record with no Linear issue behind it is not a card.** It may exist — the
runner's reachability probe is one — and works on its own routes. The board
list filters on `linear_uuid IS NOT NULL`, because every control refuses a row
with no Linear issue, and drawing one offers buttons that cannot work.

### Which half a column is in

This is the question to ask before writing any UPDATE.

**Linear owns it** → `cards`, and **every reader pass replaces it**. Never
COALESCE one of these: a cache that merges can disagree with its source for
ever, and then it is not a cache, it is a second home.
`title`, `description`, `url`, `team`, `linear_state`, `labels`,
`linear_project`, `linear_uuid`, `linear_read_at`.

**You own it** → `cards`, and **a reader pass must not mention it**.
`brand`, `track`, `figma_url`, `dismissed_at`, `set_aside_at`.

**A run owns it** → `stage_sessions`, per stage.
`status`, `prompt`, `detail`, `options`, `gate_round`, `response*`,
`requested_at`, `started_at`, `last_error`, `mockups_*`, `handoff_at`.

Two traps worth naming:

- **`cards.description` is the Linear description. `sessions.detail` is the
  agent's context.** They shared a column once and needed a guard to stop a
  cron read wiping the agent's; separate columns mean there is no guard to get
  wrong.
- **There is no `requested_stage`.** The stage *is* the row, so queuing is
  `sessions.requested_at` on the row for that stage. The wire still carries
  `requested_stage` because the board and the runner read it — derived, in
  `lib/card.mjs`.

### The wire is a projection, never a stored row

`lib/card.mjs` flattens a card and its sessions into the shape the board has
always been sent, **computed per request and never stored**. A stored
flattening would be a third copy of two facts, which is how §11's bugs started.

It also serves `stages: { research: {…}, design: {…} }`, which is what to read
once a card has to say that research is Drift while design is Unverified.

Two names are translated there and nowhere else: `issue_key` → `id`, and
`brand` → `project` (the agent posts `project`, so one name on the wire beats
two). `/api/agent/session/:id/reassign` is the only other place `project`
means the brand.

### Dead tables, kept on purpose

`agent_sessions` (pre-split), `projects` (pre-`brands`), and the chat
organiser's tables. Nothing reads or writes any of them. They are the rollback,
and dropping them is §13 step 4 — a separate decision. Do not read them, and do
not "restore" a column from one.

## Invariants that look like cruft

Three things are load-bearing and read as redundant. Do not simplify them:

- **`dismissed_at = COALESCE(cards.dismissed_at, excluded.dismissed_at)`**
  in the reader's upsert — a cron read can only ever *add* a dismissal, never
  clear one. Drop the COALESCE and a Wednesday run silently un-dismisses every
  card whose `no-design` label was removed in Linear. It is the one Hub-owned
  column the reader touches at all, which is why it needs the guard and the
  others do not.
- **The two-pass reader.** Discovery carries a fixed `first: 100` budget;
  reconciliation is a separate update-only pass. Merging them lets closed issues
  eat the budget and starve the board of real work.
- **The same-origin proxy.** The board calls `/api/*` on its own origin
  (`frontend/index.html:218`, `const API = '/api'`) and
  `functions/api/[[path]].js` forwards to the Worker. A direct cross-origin call
  to `workers.dev` cannot be authenticated by Access from a browser — the
  `CF-Authorization` cookie is per-hostname, preflights carry no cookies, and
  Safari drops it as third-party. Do not cut out the middleman.

## What the Hub writes to Linear

Four things, and no more: stage labels (`AI-research done`, `AI-design done`)
when a stage reports finished, `no-design` when you dismiss a card, its removal
when you undo that, and **issue status — but only from `POST
/api/agent/session/:id/complete`.**

That last one is a deliberate exception to §6, which says "Never issue status".
§15 asked which of the code and the document should move, and the answer is the
document. The rule exists to stop the Manager *inventing* a fact it does not
own — deciding by itself that work is finished, from a label or a timer or an
evidence read. That is still forbidden and nothing does it. A human pressing
Complete is not that; it is the press being carried to Linear instead of you
opening Linear to do the same thing by hand.

**What keeps it honest is that nothing else can reach that mutation.** The
cron read, the agent post, stage-done, dismiss and set-aside are each asserted
never to write status in `test/invariants.test.mjs`. If you add a path that
completes an issue, you are removing the exception's only justification — do
not, without changing this section first.

## The Hub stays generic

The Hub knows sessions, brands, states and prompts. It does not know what a
"gate" or a "QA agent" is — that lives in the sibling `design-ai` repo. The
`system` field on a session is what keeps another agent system pluggable.
Resist adding Design-AI-specific concepts to Worker or board code.

## Running things

```bash
node --test                          # everything, including production smoke
node --test test/unit.test.mjs       # unit only, no network
node --test test/invariants.test.mjs # the rules of the architecture, by section
node --test test/identity.test.mjs   # §2, the one identity
node --test test/grain.test.mjs      # the card/session split, and the projection
```

**Tests here are proved to bite.** Break the invariant deliberately, confirm
the named test fails, restore, confirm green. A passing test that has never
failed proves nothing, and `test/invariants.test.mjs` exists precisely so a
violation reports which rule broke rather than which line.

`GET /api/diagnostics` answers what is configured and what is missing, by
variable name. `?live=1` adds the Linear round trip.

Run from the repo root — `node --test test/` fails on some Node versions.

`test/smoke.test.mjs` hits **production** and is read-only. Keep it that way.

Deploys are two independent commands, and secrets are set with
`wrangler secret put` and never committed. See [DEPLOY.md](./DEPLOY.md).

## Environment

Local development is on Windows; the bash snippets in the docs run under Git
Bash. `npx wrangler` is the entry point for everything Cloudflare.
