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
`brand`, `track`, `figma_url`, `dismissed_at`, `set_aside_at`,
`figma_file_key`, `figma_page`.

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
- **`figma_url` is where the work ENDED UP. `figma_file_key` and `figma_page`
  are where the next run SHOULD GO.** piece11 labels `figma_url` "your
  destination override", which is what it was meant to be and not what it
  became — the agent writes it through the session post once a design run has
  drawn something. Folding the three together would let a finished design
  silently redirect the next one.

### Where Figma work lands

`figma_paths` (team, brand) → file, file_key, page, plus the per-card override
above. The runner reads them in that order and falls back to
`.design-ai/config/routing.json` only when the Hub is unreachable — an
unreachable Hub must not stop every issue for having no destination when the
destination has been in the repo all along.

**This used to live only in `routing.json`.** It moved because it is edited
from the board now, and a browser cannot commit to a git repository. The file
is still there, is still the fallback, and was what piece13 seeded these rows
from.

Two things to keep straight:

- **The key is the pair, never the team.** `Websites` carries four brands and
  they are four different files; `forge` appears under both `Forge` and
  `Websites` pointing at two more. Either half alone answers a different
  question.
- **A row with no `file_key` is not a destination.** It is a half-filled form,
  and treating it as one aims a design run at a file that does not exist. The
  runner skips it and falls through, and an unmapped pair blocking the card is
  better than either.

It is on the right side of "the Hub stays generic": a destination is not a
stage, a gate or an agent role. It is the same kind of fact as `figma_url`,
which the Hub has held all along, and another agent system would want the same
answer.

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

## Which machine you are at

The Hub **cannot see it**. It never reaches out to anything — runners poll it —
and a browser cannot read its own hostname. Anything that claims otherwise is
guessing. So the machine says so, two ways:

- **Automatic.** Running `design-local.bat` claims the machine, because that is
  what the command is for: the local tiers are OAuth sign-ins that only exist
  where somebody signed in. The runner sends `--claim` and the Hub points the
  queue there.
- **By hand.** The board lists every machine that has checked in and you pick
  one. Pressing the chosen one again clears it.

**A scheduled run never claims.** `runner.bat` on a Task Scheduler entry fires
on a laptop you may be nowhere near, and a machine checking in is not the same
as you sitting in front of it — which is exactly why "most recent heartbeat"
was the wrong answer.

`agent_heartbeats.selected_at` holds it, on the machine rather than in a
settings table, so there is no second place it can disagree. At most one row
carries it; `selectMachine` clears the others in the same breath.

### What the queue does with it

`GET /api/agent/queue?machine=X` applies two filters, both about the asker
rather than the work:

- **capability** — a runner is only offered a stage it declared. Generic: the
  Hub matches the stage name against the names the runner sent and knows what
  neither means. It is what stops GitHub Actions, which declares research only,
  being handed design work it would fail.
- **selection** — when you have chosen a machine, the other machines you sit at
  get nothing. **CI is never filtered this way**, because starving Actions of
  research is not what anyone means by "run this here".

Asking with **no** `machine` returns everything, exactly as before. The runner
is fed entirely by this route, so a runner that has not been updated has to
keep working.

### A press says whether anything will come

The queue is pull-only, so a press cannot make a run happen. It records the
request and fires a `workflow_dispatch` at GitHub Actions — and that dispatch
used to be the whole of `started: true`, whatever stage had been queued.
Actions declares research only, so a design press said "run started", the
cloud runner was shown an empty queue and left, and the card sat under
"Stalled — never came back" with nothing dead anywhere. WEB-279, 21 Sep 2026.

`whoWillCome` in the Worker asks the queue's own capability rule in advance:
would any cloud runner that has checked in be shown this stage? If not, no
dispatch, `started: false`, and the detail names the machine the work waits
on and how long since it checked in. `nobodyComing` on the board does the
same for a stalled card, so the note says "nothing that can run design has
checked in since" rather than blaming a runner that was never sent. Both
return to the old behaviour when they have nothing to go on — no cloud runner
ever seen, or one that declared nothing.

**What actually takes design work is a scheduled `design-local.bat --no-claim`
on the machine you design at** — registered on DaveBellJrII as "Design AI
local", every fifteen minutes on weekdays. See design-ai's
`headless-runner.md`. The flag matters: a schedule is not you sitting there,
and without it every wake would re-claim the machine and undo a choice made on
the board.

### A run in progress is seen as one

The runner runs `claude -p` with `spawnSync`, so for the length of a stage it
cannot speak: it posted `active` once and then nothing for up to forty
minutes. Two misreadings followed, both on WEB-279 the same afternoon. The
machine went stale twenty minutes into a healthy run, because its only
heartbeat was the one at wake. And a Stop then a Run nine minutes in rewrote
`requested_at` and `updated_at` to the same second, so the board's one signal
for "the runner has spoken since the press" was gone: the card read Queued
while Claude drew frames in Figma, and the second press was accepted as if
nothing were running.

Three things, and they must agree:

- **design-ai's `keepalive.mjs`** repeats the runner's heartbeat and its
  `active` post every two minutes from a separate process while the runner is
  blocked. It exits when its parent dies or after a hard maximum, so it can
  never paint a dead run as a live one.
- **`stage_sessions.agent_seen_at`** (piece14) is the agent's LAST post,
  moved by every post and by nothing else. `agent_posted_at` is the FIRST and
  never moves; `updated_at` is moved by a press and a Stop too. Neither can
  stand in for it.
- **`RUN_QUIET_MIN = 6`**, in both `worker/index.js` and `board-logic.js`.
  A fresh `agent_seen_at` on an `active` row is a run in progress: the board
  reads it as Working whatever the press stamps say, judges a running card
  stalled by its own silence rather than the age of the press, and the
  trigger route answers a press on it with 409 "already running" instead of
  queuing a second one. Past the window, silence on an `active` row means
  the run stopped, and everything behaves as it did before.

Stop still cannot interrupt a Claude call. It clears the queue entry, and the
runner reports when it finishes regardless — the 409 says so.

### Staying connected

Two separate problems, and they were both being solved by accident:

**Being visible.** The heartbeat fires when the RUNNER runs, so a machine goes
quiet the moment its work finishes and the board stops believing in it. That is
what "it keeps disconnecting" was. `hub.mjs here` (and `here.bat`) is the same
check-in with none of the work — double-click it, or put it on a logon task.

The board can now say it too: **“I’m at this computer”** in the Activity panel
posts the same check-in from the browser sitting on the machine, and claims it
in the same press. `machineToCheckIn` decides which machine that is — the one
this browser was told it is on, or the only one on the list, and otherwise
nothing, because the press would be guessing which computer you are at.

It is a **press**, deliberately, and not something the board does on load. A
load-time check-in would refresh a desktop's freshness from the phone in your
pocket — the phone's browser remembers the same machine name — and the board
would report a machine as alive because a tab was open somewhere else.

What it cannot do, and what no button on a web page could: **start the runner.**
The Hub never reaches out to anything. Checking in makes "where am I working"
true; a queued stage still starts when the runner next wakes on that machine, or
when you run `design-local` there. Anything that made the board claim otherwise
would be re-introducing the exact lie the heartbeat exists to remove.

**Being chosen.** The browser remembers which machine it is on
(`localStorage`, key `design-hub:working-from`) and re-asserts it on page load
and on window focus. A browser only ever runs on one machine, so this is the
closest a page can get to knowing where it is — and focus is the strongest
signal available for "the computer somebody is actually using".

`machineToAssert` is the whole rule and it is pure, so it is tested rather than
reasoned about. It returns null when the Hub already agrees, which is what
stops a page load becoming an assert loop, and when the remembered machine has
never checked in, which is what stops work being routed at nothing.

## What the Hub writes to Linear

Four things, and no more: stage labels (`AI-research done`, `AI-design done`)
when a stage reports finished, `no-design` when you dismiss a card, its removal
when you undo that, and **issue status — but only from
`/api/agent/session/:id/complete`, POST to mark it done and DELETE to take
that back.**

That last one is a deliberate exception to §6, which says "Never issue status".
§15 asked which of the code and the document should move, and the answer is the
document. The rule exists to stop the Manager *inventing* a fact it does not
own — deciding by itself that work is finished, from a label or a timer or an
evidence read. That is still forbidden and nothing does it. A human pressing
Complete is not that; it is the press being carried to Linear instead of you
opening Linear to do the same thing by hand.

**Undo is the same exception, not a second one.** Mark done remembers the
state the issue left in `cards.done_from` (piece15, Hub-owned, never touched
by the reader), and Undo puts it back there. When nothing was remembered — the
issue was closed in Linear by hand — it goes to the team's earliest
`unstarted` state, then `started`, then `backlog`, by type and never by
name, because every team names its states differently.

**What keeps it honest is that nothing else can reach that mutation.** The
cron read, the agent post, stage-done, dismiss and set-aside are each asserted
never to write status in `test/invariants.test.mjs`. If you add a path that
completes or reopens an issue, you are removing the exception's only
justification — do not, without changing this section first.

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
node --test test/machine.test.mjs    # which machine you are at, and queue routing
node --test test/handlers.test.mjs   # the board's own handlers (§14.5)
node --test test/figma.test.mjs      # Figma paths: defaults, overrides, ownership
node --test test/a11y.test.mjs       # tokens, contrast, focus, the editor dialog
node --test test/sql.test.mjs        # the pieces, against a production-shaped database
```

**§14.5 is closed.** `render.test.mjs` mounts the board and asserts what it
DREW; `handlers.test.mjs` mounts it and asserts what it DOES — which request
went out, with what body, what it said afterwards, what state it left a button
in when the call failed, and what it wrote to browser storage. It found a real
bug on its first run: `chooseMachine` called `render()`, which does not exist.

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
