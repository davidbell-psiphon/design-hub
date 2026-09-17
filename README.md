# Design Hub

A session board for agent work. It shows what design work exists, grouped by
brand, and gives each item a button that starts an agent run.

**Live:** https://design-hub-7y2.pages.dev
**API:** https://design-hub-worker.d-bell.workers.dev

---

## What it is

Three rules shape everything here:

1. **Nothing is automatic.** A scheduled job gathers Linear issues so that
   finding design work never means opening Linear. It does not start anything.
   Every agent run begins because a human pressed a button.
2. **The Hub stays generic.** It knows sessions, brands, states and prompts. It
   does not know what a "gate" or a "QA agent" is. Another agent system plugs
   into the same surface by posting the same shape with a different `system`.
3. **Brand is the container.** Everything is organized by brand. The Design AI
   is not a top-level thing — it is what does the work inside every brand.

## What it is not

Not a chat organizer, not a project tracker, not a place to file links. It had
all of that once; that layer was removed and its data preserved in
[`legacy-hierarchy-export.json`](./legacy-hierarchy-export.json).

Design rendering lives in Figma and agent configuration lives in the design-ai
repo. The Hub links out to both and owns neither.

---

## The board

One scrolling surface. Every brand, stacked, always — that is the point. Within
each brand, three columns, in the order work moves through them:

| Column | What is in it | The card's button |
|---|---|---|
| **Backlog** | Nothing has been run yet | **Run Research** |
| **Researched** | The research agent has finished | **Run Design** |
| **AI-designed** | The design agent has finished | — |

There was a fourth, **QA'd**, fed by a **Run QA** button. Nothing implemented
the stage. Pressing it queued a run that failed with *"the qa stage is not
implemented yet"*, and because `requested_stage` is cleared only by
`POST /api/agent/stage-done` — which a failed run never reaches — the card was
left holding a queue entry for ever, reading as **Working…** on a stage that
does not exist. A stage the Hub will queue has to be one something runs, so QA
is out of `STAGES`, out of the ladder and out of the columns until something
does it. An issue still carrying `AI-QA done` from before renders as
AI-designed, which is the last stage that actually ran on it.

**Which column a card is in comes from what the agent finished, never from when
you clicked.** It is read from the Linear labels the system writes at the end of
each stage — see [The trigger](#the-trigger). That was the old board's central
mistake: it bucketed on `triggered_at`, which is set the instant you press a
button, so a card that finished two days ago looked identical to one requested
ten seconds ago.

Each card carries its brand colour on the card itself, and shows the Linear ID
and title, the stage, the track (app or website), links out to Linear and Figma,
and exactly one button — the next stage to run. **Every open card short of the
last stage has one.** A card that renders no action at all was the old board's
other failure: actions were picked by a chain of conditions on `status`, and a
row whose status matched no branch fell through to nothing.

### What a card says it is doing

One derivation — `runState` in `board-logic.js` — decides this, and the pill,
the card's outline, the stage button's text and the console all read it.
They are the same fact rendered four ways, so they cannot contradict each other.

| Pill | Comes from | What it means |
|---|---|---|
| **Error** | `status = 'error'` | the run stopped, and the card says why |
| **Stalled** | queued, and still queued 30 minutes later | the run never came back, or was never picked up |
| **Working…** | queued, and the runner has started it | a run is in flight |
| **2nd of 4** | queued, waiting its turn | the runner is busy with an earlier one |
| **Needs you** | a gate is open — options posted, nothing chosen | it is waiting on a decision |
| **Done** | `status = 'done'` | the last stage finished |
| *(none)* | anything else | quiet; the card shows just its stage |

**Error outranks a queue entry, and that ordering is the point.** It used to be
the other way round: the pill asked `isWorking` first, and `requested_stage` is
cleared in exactly one place — `stage-done`, which a run that failed never
reaches. So a session that had already reported `status: "error"` kept its queue
row and the board kept painting it **Working…** indefinitely. RYV-84, FOR-47 and
RYV-86 all sat like that. A queued run is still queued while it is errored, so
the stage button stays disabled — but it reads **Error** rather than claiming
progress, and the card carries **Reset** beside it.

**Stalled** is the other half: nothing reports a process dying, so a run that
never comes back would otherwise stay **Working…** for ever. It is derived, not
observed — threshold `STALL_AFTER_MIN`, 30 minutes — and there is no heartbeat
and nothing new is written.

**The clock runs on `requested_at`, not `updated_at`, and that distinction is
load-bearing.** `requested_at` is written once by the trigger route and cleared
in exactly one place, `stage-done`; nothing else touches it. `updated_at` looks
like the better field and is not, because the reader's upsert sets
`updated_at = datetime('now')` on every row it refreshes — so a cron read, or
anyone pressing **Read Linear**, would reset the stall clock on a run that died
hours ago and hide it again for another half hour. The control meant to surface
a dead run would have been the thing concealing it.

A row whose timestamp will not parse is deliberately *not* stalled: flagging on
missing data would flag the whole board the first time a column came back null.

### Mark done

The board could say what a card is *not* — No design, Dismissed — and had no
way to say it was finished. That meant opening Linear, which is the trip this
board exists to save. **Mark done** sets the issue to its team's finished state.

It does not name a state, because every team calls it something different —
Done, Design Done, Posted, Shipped. Linear gives every workflow state a
`type`, and `completed` is the one that renders with the checkmark; that is
the thing that is the same everywhere, so it is what the Worker resolves on.
Where a team has more than one completed state the earliest by position wins:
Linear orders a team's states left to right, and the first completed one is
what its board's first checkmark column maps onto. The response says which
state it used, and the toast repeats it.

Linear first, the local row second — the same ordering the dismiss route
follows and for the same reason. A card filed under Completed here but not
there is put back by the next reconciliation pass and flickers on and off the
board with every read. An issue that is already finished reports `already` and
writes nothing.

The queue entry goes with it. A finished issue is not work to hand the runner,
and an entry left behind would sit on a card in the Completed drawer reading as
**Working…**.

### Dismissing a whole team

With a team filter on, the topbar offers **Dismiss all _n_** — every open card
in that team, set aside in one call. It is offered only while a filter is on:
"Dismiss all 57" with no filter is not a button anybody wants within reach, and
the count is in the label so it can never be a surprise.

The ids are collected on the board and sent to
`POST /api/agent/sessions/setaside`, rather than sending the team name for the
Worker to filter on again. A second copy of the filter could drift out of step
with the one in front of you, and then what went away would not be what you
asked to go away. Ids the Hub does not recognise are skipped rather than
failing the call, and the response says how many of how many moved.

It is the only control on this board that asks first. Everything else is one
card and one Undo; this is thirty-three of them.

**It is a one-time action, not a rule.** The reader takes every issue assigned
to Dave on every pass, so new Marketing issues keep arriving and keep needing
dismissing. Nothing auto-dismisses on read: a card that silently never appears
is exactly the failure the board was built to end.

### Stop, and Reset

They are one operation — clearing the queue entry — named for what it means
where you press it. A run still believed to be going says **Stop**; one that has
already failed or gone quiet has nothing left to stop, so it says **Reset**. A
card with no run behind it carries neither, an open gate included: a question is
not a run.

It exists because `requested_stage` is written by the trigger and cleared in
exactly one other place, `stage-done`, which a run that failed never reaches. So
a run that errored, or was never picked up, held its queue entry for ever: the
stage button stayed disabled and pressing it again answered `409 already
queued`. There was no way out of that state from the board. Four issues sat in
it for a day, because the runner takes two issues per dispatch and nothing
re-dispatches.

`DELETE /api/agent/session/:id/trigger` is the exact inverse of the POST. It
clears `requested_stage` and `requested_at`, and an `error` status with them —
a row you have just reset is not still failing, and leaving the error behind
would leave the card shouting about a run you have already dealt with. The
failure prose goes with the status that made it worth showing; a `waiting` row's
prompt is its gate question and survives untouched.

It is deliberately not destructive. Nothing in Linear moves, no label changes,
and the row, its stage, its brand, its gate and its history are all left alone.
The worst it can do is let you press the stage button again, which is the point.

**What Stop can and cannot do.** Clearing the queue entry is only half of it;
the other half is the runner honouring it. The runner re-reads
`GET /api/agent/queue` **before each issue** rather than once at the start, so a
card called off after a run began is skipped instead of researched. It cannot
interrupt the issue being worked at that moment — that one finishes, and the
job's own 60-minute timeout is the only thing above it.

A hard stop would mean cancelling the GitHub run, and since the Hub began
sending `max_issues` a run covers several issues — so a per-issue Stop would
take its siblings down with it. Skipping is the honest version, and the toast
says as much rather than claiming the run died.

That check **fails open**: an unreadable queue means the Hub is unreachable, not
that every card was stopped. Reading an outage as a stop would silently cancel a
run's remaining work with nothing to say why.

**Needs you is an open gate, not `status = 'waiting'`.** The reader writes that
status on every row it inserts, so a pill for it would be on all of them and
would mean nothing. What actually needs a human is a question with no answer.

**The card shows no agent prose.** No prompt, no detail, no answer. The agent's
research is a comment on the Linear issue and is read there; the Hub is a
launcher and a status board, not a place to have a conversation. Pressing the
next stage's button *is* how you say "proceed" — there is no typed reply.

There are exactly two exceptions, and they are the same exception twice: a
**gate's options**, and an **errored card's one-line reason**, taken from the
row's own `prompt`. A question you cannot see from the board is a card that
just sits there; so is a card that has stopped and will not say why. Both are
the difference between a board you can read and a board that sends you
somewhere else to find out what happened.

**One Linear issue is one card.** Whatever the agent is doing to it shows as
state on that card; a new phase never adds a row. See
[One card per issue](#one-card-per-issue).

Brand colours:

| Brand | Colour |
|---|---|
| Conduit | `#7E67A4` |
| Psiphon VPN | `#D54028` |
| Ryve | `#206CCC` |
| Forge | `#BE5135` |

A session whose brand could not be derived lands in an **Unassigned** section
rather than disappearing; the "Move to…" select on the card is how it gets home.

Three collapsed sections sit at the foot of the board, each showing a count and
expanding on one click. All are collapsed on every load, and rows in any of
them leave the brand buckets, the brand counts, the topbar total, the running
badges and the console.

| Section | What is in it |
|---|---|
| **Dismissed** | Set aside from the agents. Hub-only — nothing is written to Linear |
| **No design** | Cards carrying the `no-design` label. Un-dismissable from there |
| **Completed** | Issues whose Linear state is completed or canceled |

**Dismissed and No design are two different statements, and the difference is
who they are about.** `no-design` is about the *issue*: this is not design
work at all. It is written into Linear, everyone can see it, and it rebuilds
itself from a single read if the database is ever lost. **Dismissed** is about
*these agents*: this is design work, but the research and design agents should
not run on it. That is nobody else's business, so it writes nothing to Linear
and no label carries it — keeping control labels out of Dave's Linear workflow
is the whole reason [the trigger](#the-trigger) moved into the Hub's own queue.

The trade is that a dismissal does not survive losing the database, where a
`no-design` one does. Setting a card aside also clears any queued run with it:
a card you have just told the agents to leave alone must not still be sitting
in the queue they read, and `/api/agent/queue` filters the column.

Where a card lands when it qualifies for more than one is fixed, most final
fact first: **Completed**, then **No design**, then **Dismissed** — a preference
about our own tooling loses to a fact about the issue, which loses to the issue
being closed.

`no-research` cards stay on the main board: that label means "skip research, go
straight to mockup", and a Backlog card carrying it offers **Run Design**
instead of Run Research.

### "Move to…" moves the card, not the work

The reassign select corrects which brand section a card sits in. That is all it
does, and the control says so.

The runner derives a brand from the Linear issue with `deriveBrand` — the same
function the reader uses, vendored into the design-ai repo so the two agree —
and never reads the Hub row's `project`. So moving a card here changes the
board and changes nothing about where its work would land in Figma.

That is worth knowing rather than worth fixing, at least today: every open card
on the board derives its brand correctly, so the control has no victim. Making
it reach the runner would mean recording that a brand was set by hand (the Hub
derives one on every read, so the column alone cannot say), exposing that on
`/api/agent/queue`, and teaching the runner to prefer it — a schema piece and a
change in both repos, for a correction nothing currently needs.

If a card ever does derive the wrong brand, the fix that actually works is in
Linear: a brand word in the issue's title, its project name, or a label, which
is where `detectBrand` looks.

### The sidebar filters by team

Brand is still the container the board is built from — every brand, stacked,
always. The sidebar narrows *what appears inside those sections*, and it
narrows by **team**.

It used to filter by brand, which was the same axis the board was already
organised on. That was fine when the reader took only design teams and there
were a dozen cards. Since it stopped filtering by team there are 57 open cards
across seven teams, most of them Marketing work, and the team is the context an
issue actually arrives with.

The list is built from the rows rather than from a fixed set, so a Linear team
appears the first time an issue on it is assigned to Dave, and a team with
nothing open does not appear at all. Alphabetical, because the counts move and a
list that reorders itself under you is one you cannot learn. The badge is total
open, and it turns amber when something in that team is live — errored, stalled,
needing an answer or running.

A row is grouped by its team, falling back to its **Linear project** where it
has no team: a session an agent posted with no Linear issue behind it has
neither a team nor a brand, and without the fallback it would be reachable only
by scrolling. Team first and project second, never both — one row is in exactly
one group, or the sidebar's counts stop adding up to the board's.

With a filter on, brands with nothing left in them are not rendered. Without
one, every brand renders whether or not it has work: an empty CONDUIT is
information, but four empty brand headings around the one you asked for is not.

"All teams" is the default on every load and the filter is never persisted — the
Hub always opens showing everything. On narrow screens the sidebar is a
hamburger drawer, the console moves to the top of the page, and every control is
a 44px tap target.

**The card names its Linear project** where its brand section is not
self-evident — that is, on any team that does not imply a brand by itself
(Marketing, Websites, Insights). On a Conduit App card it would only repeat the
heading above it. It is also the cue for whether "Move to…" is worth reaching
for.

### The console

The right-hand panel used to be **In flight**: the rows with a stage queued,
split App / Website. That answers "what did I press", not "what is going on" —
a run that had errored or quietly died was either in that list looking healthy
or not in it at all.

It is a **console** now, and it is always there: a fixed rail on the right at
any width that can hold two columns, and a sticky bar at the top of the page
below that. Monospace and column-aligned, because it is read by scanning down
one column rather than across a card.

```
ACTIVITY                    4 live / 6 open
20:32 ● RYV-84    design     ERROR
       The qa stage is not implemented yet
20:31 ● CON-120   research   STALLED
       no activity for 1h
20:30 ● RYV-187   design     NEEDS YOU
20:44 ● CON-118   research   WORKING
20:43 ● CON-116   design     DONE
2 quiet                              20:44
```

The time is when that row last moved, in local wall-clock. The dot is the
brand's colour, and clicking a line filters the board to that brand. Errored
and stalled lines carry their reason underneath, clamped to two lines — the
whole of it is on the card.

**It is not an event log, and does not pretend to be one.** Nothing in the Hub
records transitions, so every line is a row's *current* state rather than a
thing that happened. What makes it read like a log is that the rows carry the
time they last moved, which is the closest true thing the database holds. A
real append-only log is a schema change and a set of Worker writes; it is worth
doing, and it is not what this is.

Ordering is `consoleRows` in `board-logic.js` — pure, so it is tested without a
DOM. Most urgent first; within a state, whatever moved longest ago comes first,
because a run stuck for three hours wants attention before one stuck for ten
minutes. Finished runs are the one exception and sort newest first, since
"longest stuck" says nothing about something no longer running.

Idle rows are not lines. Finished ones are, for **24 hours** (`RECENT_DONE_H`) —
a row keeps `status = 'done'` until something runs on it again, so without that
window the console would carry every stage that has ever finished, for ever,
which is a list and not a console. The head counts what is live and the foot
counts what is not, so the two together always account for every open card.

#### Where a card is in the queue

Runs are serialised — GitHub's `concurrency` group lets exactly one happen at a
time — so of everything carrying a queue entry, at most one is being worked.
They all said **Working…**, which was true of one of them and a guess about the
rest.

The Hub can tell them apart without anything new being sent. The runner posts
`status: 'active'` as it picks an issue up, and that post moves `updated_at`.
So a row whose `updated_at` is later than its `requested_at` has been started;
one where they are still equal has only been asked for. Comparing the two
rather than trusting `status` alone is what makes it safe — a row left `active`
by a previous run and then re-triggered would otherwise claim to be running the
instant you pressed the button.

So the one being worked says **Working…** and the rest say **2nd of 4**,
**3rd of 4**, ordered by `requested_at` — the same order and the same
exclusions as `GET /api/agent/queue`, because a position shown on a card has to
be the position the runner will actually work in. The console says `QUEUED 2/4`
in its state column, and the disabled stage button says the same thing the pill
does. Alone in the queue a card just says **Queued**, since *1st of 1* tells you
nothing.

**Waiting your turn is not stalling.** A queue of four ten-minute runs leaves
the last one waiting forty minutes entirely correctly, and flagging that as a
dead process is the board crying wolf about its own design. So a queued card
goes **Stalled** once it is past the threshold *and* nothing in the queue is
running — which is the case the flag exists for: the runner took what it would
take, deferred the rest, and nothing re-dispatched. The card actually being
worked is still judged on its own silence.

#### A clock that moves

A run reports in **twice**: the runner posts `active` before it starts and
`done` or `error` when it finishes, and the Claude call between them is a
blocking `spawnSync` that takes minutes. So the Hub genuinely has no new
information during a run, and a card was identical at second one and at minute
nine. **Working…** was a claim with nothing behind it.

**A queued card and a running one count different things.** A queued card
counts from the press — how long you have been waiting is the only thing there
is to say about a run that has not started. A running card counts from when the
runner picked it up, its `active` post. Counting a running card from the press
would fold a forty-minute queue wait into a two-minute run and report it as
forty.

The stall clock deliberately does not follow this. It stays on `requested_at`,
because the reader bumps `updated_at` on every row it refreshes and a read must
not be able to clear a stall. The same bump can reset a running card's
*displayed* clock, which is cosmetic, rare, and worth it.

So a working or stalled card carries an elapsed clock — `4m12s` — counting up
every second, on the card and on its console line. It is honest about what it
is: elapsed time, not progress. But it moves, which is the difference between
a board that looks alive and one you have to refresh to trust.

It ticks on its own 1-second interval that rewrites only the `[data-since]`
spans. A full re-render at 1Hz would be wasteful and would fight anything being
typed into the board.

**And the console links to `log ↗`** — the runner's GitHub Actions workflow,
from `GET /api/runner`. That log is the only truly live view of a job, because
it is the only place the work is actually narrating itself. The Hub does not
pretend to know more than it does; it points at what does.

#### It keeps itself current

The board re-reads `/api/agent/sessions` every 30 seconds and re-renders. A
console that is only ever as fresh as your last click is not showing what is
going on.

This does not touch rule 1. Nothing here starts anything — it is a GET and a
re-render, and every run still begins because a human pressed a button.

Two things hold the timer back, and both exist because re-rendering replaces the
board's `innerHTML` outright:

- **A hidden tab polls nothing**, so a window left open overnight does not
  quietly ask the Worker for the board 2,880 times. Coming back to the tab
  refreshes immediately rather than waiting out the interval.
- **A refresh is skipped while anything on the board is focused or has been
  typed into.** Wiping a half-written gate note out from under someone is a far
  worse bug than a console that is thirty seconds stale.

---

## The trigger

Pressing a stage button does two things, in this order:

1. **Writes the request into the Hub's own database** — `requested_stage` on
   that row. No Linear label is applied. This is the durable part: once it is
   written, the work will happen.
2. **Starts the runner**, by firing a `workflow_dispatch` at the design-ai
   GitHub Actions workflow. This is the part that decides whether the work
   happens in seconds or waits.

The runner then asks the Hub what has been requested
(`GET /api/agent/queue`), does the work, and reports back
(`POST /api/agent/stage-done`). The Hub writes the record label and clears the
queue entry.

Step 2 is deliberately advisory, and deliberately second. If GitHub is
unreachable or `GITHUB_TOKEN` has expired, the press is still recorded and the
board still shows the request — the response says `started: false` with the
reason, and the board's toast repeats it, so a press that queued but did not
start never looks like one that did. That is also why nothing runs on a
schedule: there is no cron on either side, and no run happens that a person did
not ask for.

The dispatch passes **one input: `max_issues`, set to the depth of the queue**
including the row just written. It names no issue — the runner picks its work by
reading the queue, and naming one here would strand the others.

It used to pass no inputs at all, on the belief that the runner drained the
whole queue by itself. It does not. Its workflow declares `max_issues` with a
default of `'2'`, GitHub applies that default to an API dispatch that names no
inputs, and the runner then logs `DEFERRED reason=max-issues=2` for everything
past the second — where a *blocked* issue burns one of the two slots exactly as
a successful one does. Nothing re-dispatches, so the remainder sat in the queue
until the next press, which took two more.

On 16 September that stranded four issues for a day: RYV-84 and FOR-47 took both
slots and failed, and FOR-48, FOR-49, FOR-26 and MAR-978 were never looked at.
Passing the depth is what makes "a press picks up anything else already sitting
there" true rather than aspirational.

The count is capped by `RUNNER_MAX_ISSUES` (10, overridable as a Worker
variable), because the runner's own spend guard is **per issue** —
`--max-budget-usd`, $5 by default — so the number of issues is what bounds a
run's total cost. It uses the same `WHERE` clause as `/api/agent/queue`: if the
two disagreed, the Hub would be telling the runner to take a number of issues it
is not going to be shown.

This used to work the other way round: the button applied a `design-ai:go`
label and the runner polled Linear looking for it. Linear was the message bus
between the button and the agent, which is why board state was scattered across
two systems and why control labels kept appearing in Dave's own workflow.

### The labels

Two kinds, and the difference is the whole point.

**Written by the system, read by the board.** These are the record of what has
been done. Dave never applies one and nothing triggers off them:

| Label | Written when |
|---|---|
| `AI-research done` | the research agent finishes |
| `AI-design done` | the design agent finishes |

Keeping the stage in Linear rather than in a Hub-only column means the board
cannot drift out of sync with the issue, and rebuilds itself correctly from a
single read if the database is ever lost.

**Applied by Dave, read by the board.** These are decisions only he can make:

| Label | Meaning |
|---|---|
| `no-research` | Skip research — the card advances to Researched, marked skipped |
| `no-design` | Not design work at all — collapses the card into No design |

All of them are workspace-level in Linear, so one name resolves to one id.

**A stage has three states, not two.** Absence of `AI-research done` used to
mean both "has not run" and "was deliberately passed over", so a card marked
`no-research` was indistinguishable from one whose research silently failed.
The skip labels already recorded the difference; the board now reads it:

| State | Comes from | On the card |
|---|---|---|
| not started | neither label | the previous column, plain pill |
| done | `AI-research done` / `AI-design done` | that column, plain pill |
| skipped | `no-research` / `no-design` | that column, **dashed pill saying "Research skipped"** |

Skipped counts as complete for grouping — the card advances a column and
becomes eligible for the next stage, exactly as a completed one does — but it
never renders as done. Done outranks skipped where a card carries both: the run
happened in the end, whatever was intended earlier.

This is read-side derivation only (`stageState` / `stageReached` in
`board-logic.js`). Nothing new is written, and no column was added. `actionFor`
reads the column rather than special-casing `no-research`, so the stage button
and the column a card sits in can no longer disagree.

`design-ai:go` and `design-ai:qa` are retired. Nothing writes them and nothing
reads them.

---

## The scheduled job

Runs Wednesday and Friday at 8am Toronto (`0 13 * * 3,5`), because design issues
get created Tuesdays and Thursdays. It pulls **every Linear issue assigned to
Dave Bell, in any open state** — triage, backlog, todo or in progress —
**from the teams the board is set to read**, and upserts one `agent_sessions`
row per issue. No label filter: gathering is still not triggering.

### Where issues are read from

The team filter has been a constant in `worker/index.js` twice: first "design
teams only", then, when that hid design work filed on the wrong team, nothing at
all. Removing it put 57 cards on the board, 33 of them Marketing work the Design
AI cannot place. Putting it back would mean guessing today which teams matter
next quarter. Neither is a decision that belongs in a deploy, so it is a table —
`reader_teams`, [`piece9-schema.sql`](./piece9-schema.sql) — and the board
edits it.

**The console's foot says what it is reading**, in one quiet line:

```
from Conduit App · Forge · Psiphon App · Ryve App · Websites
```

It sits there because "why is that not on my board" is a question always asked
while looking at the board, and the answer used to be invisible — a constant in
the Worker that only a deploy could change.

**It is a statement, not a control.** The set changes rarely and on purpose, so
it is edited through `PUT /api/reader/teams` rather than by clicking around a
status panel: a console you can misclick into reading the wrong half of Linear
is worse than one you have to go and change deliberately.

**Nothing selected means every team.** That is the setting and not a fallback,
so applying the schema changes nothing on its own, and the line says "every
team" in words rather than rendering blank.

`GET /api/reader/teams` also reports every team in the workspace, so whatever
edits the set can offer the full list. If Linear cannot be reached it falls back
to the teams the Hub has actually seen.

Configured teams narrow the **query**, not the rows it returns. Filtering after
the fact would let teams nobody reads eat the `first: 100` budget, which is the
trap the two-pass reader exists to avoid.

Changing the list does not run a read — where issues come from and going to get
them are two decisions, and **Read Linear** is the second one. A read reports
which teams it was scoped to, or `all`.

Turning a team off stops it being *discovered*. Cards already on the board stay:
reconciliation still tracks them, and nothing is deleted. Dismiss or No design is
how a card leaves.

The live set is the five teams that have a track in
[`lib/derive.mjs`](./lib/derive.mjs) — Conduit App, Forge, Psiphon App, Ryve App
and Websites. Every other team blocks the runner on `unresolved-track` before it
reaches a destination, so reading them only ever filled the board with cards
nothing could act on: 33 Marketing ones, at the point this was set.

Both halves of that used to be narrower, and both cost work its place on the
board.

There was a **team filter** — Conduit App, Ryve App, Psiphon App, Forge and
Websites — meant to keep Marketing campaign work off a design board. But a
brand is derived from the issue itself, by `deriveBrand`, and the board's own
brand filter is what provides the context of where work lives. Gating on the
team it happened to be filed under only meant design work filed somewhere
unexpected was invisible. The assignee is now the only filter.

There was also a **state filter** of `["backlog", "unstarted"]`. An issue you
had actually started was therefore invisible unless the board read it before
you moved it — nine were, RYV-189 and PSI2-278 among them. It is now every open
state.

Widening the states does not touch the budget invariant below, because that
invariant is about *closed* issues: there are around 66 of those against around
60 open. Open work is the work the board is for, and all of it fits.

It refreshes only Linear-owned fields, so a re-read never resets an in-flight
session or undoes a manual brand reassignment.

**Read Linear** in the topbar runs it now. The route always existed, but with
no control for it the only way to pull in an issue assigned to you on a Tuesday
was to wait until Wednesday. The button reaches `POST /api/read-linear` through
the Pages proxy on your own Access session, so it needs no secret; the agent
and any script still call the same route with `X-Agent-Secret`. It gathers and
starts nothing, exactly as the cron does.

The reader runs **two passes**:

1. **Discovery** — every open issue: triage, backlog, unstarted, started.
   Inserts and updates.
2. **Reconciliation** — the issues already tracked, looked up by their Linear
   ids; update-only, never inserts. This is what fills in completed and
   canceled states, and it picks up `no-design` labels applied directly in
   Linear.

The second pass exists because the discovery query has a fixed `first: 100`
budget. Widening it to include closed issues would let them consume that
budget and silently starve the board of real work.

**A dismissal can never be undone by a cron run.** `dismissed_at` is written
with `COALESCE(agent_sessions.dismissed_at, excluded.dismissed_at)`, so a read
can only ever add a dismissal. The deliberate consequence: removing the
`no-design` label in Linear does **not** put the card back — the Hub's Undo
control is the only way, and it removes the label before clearing the column.

---

## One card per issue

Two writers share `agent_sessions` and each brought its own id convention. The
reader keys its rows `linear/RYV-84`. The agent posts the session id it owns,
`ryve/ryv-84/research`. Neither collided with the other on `ON CONFLICT(id)`,
so one Linear issue grew two rows — the Linear card, and a sibling agent card
for the same work — and triggering research added a row beside the card you
pressed instead of moving it.

They are reconciled on the Linear issue key, not by changing what the agent
sends:

- [`lib/session-id.mjs`](./lib/session-id.mjs) pulls the issue key back out of
  a session id, matching a **whole path segment** so `conduit/wallet-flow/design`
  cannot look like a key.
- A write from either side lands on whichever row already owns that key. The
  agent's state — phase, status, prompt, detail, Figma link — goes onto the
  card; `linear_id`, `linear_uuid`, `title`, `url`, the brand and the
  `triggered_at` / `dismissed_at` history stay as they are.
- `agent_session_id` remembers the id the agent used, and every `:id` route
  resolves it. So `GET /api/agent/session/ryve%2Fryv-84%2Fresearch` still
  answers, and a `respond` or `trigger` through either id reaches the one row.
- It works in both directions: the agent can post before the Wednesday read
  has ever seen the issue, and the read merges onto that row rather than
  inserting a second one.

**The agent's contract does not change.** It posts and polls exactly the ids it
always did — that is the reason the join lives in the Worker rather than in a
new field design-ai would have to send.

A session with no Linear issue behind it (`conduit/wallet-flow/design`, or
anything from another `system`) has no key to join on and behaves exactly as it
did before: its own row, its own id, agent-owned fields written straight
through.

[`piece6-schema.sql`](./piece6-schema.sql) adds the column and merges the pairs
that were already in the table — newest twin wins where an issue had more than
one, and the Linear row keeps its identity and its history.

---

## Gates

A gate is a question the agent stops on, and it now carries the answers with
it. The agent posts `options` — a JSON array of `{id, label, summary}` — and
the answer has to name one of those ids. A note can ride alongside the choice;
it can never stand in for it.

This exists because of one recorded answer. A three-option question was
answered `"Yes"`. "Yes" names none of the three, the client reported the gate
as decided, and the agent — following its own documentation — chose a direction
itself. Direction choice is exactly what a gate is for, so a free-text answer
against a prose question is structurally wrong, not badly worded.

```jsonc
// POST /api/agent/session
{ "session_id": "ryve/ryv-84/design", "system": "design-ai", "status": "waiting",
  "prompt": "Which direction proceeds?",
  "options": [
    { "id": "d1", "label": "Icon-only corner button", "summary": "48x48 circular +." },
    { "id": "d2", "label": "Labelled corner control", "summary": "Costs card width." }
  ] }

// PATCH /api/agent/session/:id/respond
{ "response_option_id": "d2", "response_note": "but tighten the label copy" }
```

Rejected with 400 when `options` is present and the answer names nothing on the
list. Reads carry `response_kind` and `response_label` beside the id, so a run
log says what was decided rather than printing `d2`.

Ids are opaque tokens — letters, digits and `. _ : -` — and are stable for the
life of a round. Reusing `d1` to mean something different later corrupts the
history, so the Hub treats a changed set of options as a new round: the
decision it supersedes is archived to `gate_decisions` and cleared, rather than
left sitting on a question it never answered. The same set re-posted is the
agent repeating its state and changes nothing.

`PATCH /api/agent/session/:id/reopen` does the same thing deliberately —
archives the round, increments `gate_round`, clears the decision and sets the
card back to `waiting`, with `{"note": "…"}` recorded against the round that is
ending. The agent posts fresh options for the new round.

**A reopen always leaves a trail**, so the note is required exactly when there
is no decision to archive. Taking a decision back records the decision;
rejecting the options outright records nothing but the reason, and a gate that
reopens with no reason tells the agent only that it reopened — so it re-asks
the same question. That case is refused with 400.

### Answering with a design you already made

The agent enumerates the choices, so the agent bounds what can be decided —
and sometimes the right answer is something already drawn. The card takes a
Figma section name and an Enter button beside it:

```json
{ "response_section": "Wallet header v3" }
```

That **decides** the gate: `status` returns to `active` and the agent iterates
on that section instead of asking again. `response_option_id` stays null,
because a section name was never one of the ids on the list and that column
only ever holds something that was. No reserved id either — reads carry
`response_kind` (`option` | `own` | `free` | `null`) and `response_label`, so
nothing has to infer what kind of decision it is looking at.

The section arrives under its own field name and never as a bare
`response_note`. A note that decides a gate is the "Yes" bug whatever words
are in it.

### Rejecting every option

A gate can be wrong in a way none of its answers can express, so the board
offers a third action beside choosing and leaving it open: **None of these**,
with a required reason.

It is deliberately *not* a fourth option. Nothing was chosen, so nothing is
recorded as chosen — `response_option_id` stays null, and there is no reserved
id that consumers have to special-case. Mechanically it is the reopen path: the
round closes with the reason on its `gate_decisions` row, `gate_round`
increments, the card returns to `waiting`, and the agent posts a fresh set.

So the things you can do with an open gate are: choose one of the options, name
the Figma section of a design you already made, reject all of them with a
reason, or leave it open. The first two decide it; the third starts a new round;
the fourth leaves the agent waiting.

`PATCH /api/agent/session/:id/state` carries the two completion levels that had
nowhere to live: `mockups_url` / `mockups_at` for when something was actually
drawn, and `handoff_at` for when a developer can pick it up. `"now"` is
accepted in place of a timestamp. `AI-design done` still only means a spec
exists.

**Sessions with no `options` are untouched by all of this** — free text, no
constraint, the quiet card. There was no backfill and none is needed.

On the board a waiting gate renders its options as buttons, one click each,
with a separate optional note field. An answered one shows the chosen label —
never the id — and offers Reopen.

---

## API

Written by the agent:

| Route | Purpose |
|---|---|
| `POST /api/agent/session` | Upsert session state, onto the card for its Linear issue. Requires `X-Agent-Secret`. |
| `GET /api/agent/session/:id` | Poll for the human's decision — `response_option_id`, `response_label`, `response_note`, `gate_round`. `:id` may be the agent's own session id or the row's. |
| `PATCH /api/agent/session/:id/state` | Record `mockups_url` / `mockups_at` / `handoff_at` |

Used by the board:

| Route | Purpose |
|---|---|
| `GET /api/brands` | Brand id, name, colour |
| `GET /api/agent/sessions` | Every session, waiting first |
| `POST /api/agent/session/:id/trigger` | Queue a stage for the runner (`{"stage":"research"\|"design"}`) |
| `DELETE /api/agent/session/:id/trigger` | Reset — take the request back out of the queue, and clear an error with it |
| `GET /api/agent/queue` | What the runner reads — every row with a stage requested |
| `POST /api/agent/stage-done` | The runner reports a finished stage (`{"linear_id","stage"}`) |
| `POST /api/agent/session/:id/dismiss` | Apply `no-design`, file the card away |
| `DELETE /api/agent/session/:id/dismiss` | Remove `no-design`, put it back |
| `POST /api/agent/session/:id/setaside` | Dismiss — design work, but not for the agents. Writes nothing to Linear |
| `DELETE /api/agent/session/:id/setaside` | Put it back on the board |
| `POST /api/agent/sessions/setaside` | Dismiss a list of cards at once (`{"ids":[…]}`) |
| `POST /api/agent/session/:id/complete` | Mark done — set the Linear issue to its team's finished state |
| `GET /api/reader/teams` | What the reader reads, and every team it could read |
| `PUT /api/reader/teams` | Replace that set (`{"teams":[…]}`; `[]` means every team) |
| `PATCH /api/agent/session/:id/reassign` | Correct brand or track **on the board only** — see below |
| `PATCH /api/agent/session/:id/respond` | Answer a waiting prompt — `{"response_option_id"}` or `{"response_section"}` where the gate has options, free text where it does not |
| `PATCH /api/agent/session/:id/reopen` | Send a gate back for a new round — taking a decision back, or rejecting every option with `{"note"}` |
| `DELETE /api/agent/session/:id` | Drop a session |
| `POST /api/read-linear` | Run the reader now |
| `GET /api/sessions` | Waiting sessions only (legacy shape, kept for the agent) |

The `system` field on a session is what keeps this generic: a social-media agent
posts the same shape with `"system": "social-ai"` and the Hub groups it without
knowing anything about social media.

## How requests reach the API

The board never calls the Worker directly. It calls `/api/*` on its own origin,
and a Pages Function ([`functions/api/[[path]].js`](./functions/api/%5B%5Bpath%5D%5D.js))
forwards to the Worker.

```
browser ──/api/*──> Pages (Access) ──> Pages Function ──> Worker
```

That exists because of Cloudflare Access. A cross-origin call from the board to
`workers.dev` cannot be authenticated by Access from a browser: the
`CF-Authorization` cookie is set per hostname, the browser never sends cookies
on a CORS preflight so Access blocks the `OPTIONS`, and cross-origin the cookie
is a third-party cookie that Safari drops. Same-origin has none of those
problems.

The Function forwards the caller's `Cf-Access-Jwt-Assertion` header so the
Worker verifies the human itself rather than trusting the proxy. It does not
forward browser cookies, and never sends `X-Agent-Secret`.

## Authentication

| Caller | How it authenticates |
|---|---|
| The board (browser) | Access session, JWT forwarded by the Pages Function |
| The design-ai agent | `X-Agent-Secret` (see below), plus an Access service token |
| The Wednesday/Friday cron | Neither — scheduled runs never traverse the HTTP edge |

The Worker verifies the Access JWT itself: signature against
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, then `aud`, `iss`
and `exp`. Written against WebCrypto rather than `jose` because this repo has
no package.json and no build step.

**Enforcement is off until `ACCESS_AUD` and `ACCESS_TEAM` are set** as Worker
secrets. Unset, every route behaves as it always has — which is how this could
ship before the dashboard configuration existed. Setting both turns the gate on
for every route except `POST /api/agent/session`, which checks its own secret.
See DEPLOY.md for the remaining dashboard steps.

**Enforcement is live.** Both secrets are set, so an anonymous request to any
board route returns `403 Forbidden — no valid Access identity`. The board reaches
the API through the Pages proxy, which forwards the Access JWT.

### When you wire the agent to write session state back

Today the design-ai agent makes no HTTP call to the Hub at all — it reads Linear
over MCP and reads the repo directly. That is why turning enforcement on broke
nothing, and why `GET /api/agent/session/:id` returning 403 to an anonymous
caller is harmless right now.

When the agent does start posting state, it needs **`X-Agent-Secret`** on every
call:

```
POST /api/agent/session      exempt from the Access gate, checks the secret itself
GET  /api/agent/session/:id  goes through the gate — accepts a valid Access JWT
                             OR X-Agent-Secret, so send the header here too
```

The poll route is the easy one to miss: it works today for a browser and will
return 403 to the agent unless the header is sent. If the Worker is also put
behind its own Access application, the agent additionally needs the service
token headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).

---

## Tests

```bash
node --test                      # everything: unit + production smoke
node --test test/unit.test.mjs   # unit only, no network
```

No dependencies and no install — `node:test` and `node:assert`, run from the
repo root. (`node --test test/` fails on some Node versions; bare `node --test`
auto-discovers.)

**`test/unit.test.mjs`** covers the logic that has already broken something:
brand derivation in both layers (`deriveBrand`'s team map and `detectBrand`'s
keyword fallback, including `Websites` and `Marketing` falling through to
Unassigned), track derivation, bucketing with a null `linear_state`, the
waiting-AND-triggered predicate, the element-id hash on em dashes and
non-Latin1 input, and Access JWT verification against tokens the test signs
itself — valid, expired, wrong `aud`, wrong issuer, unknown key, `alg:none`,
tampered payload, cookie fallback, unreachable certs endpoint.

**`test/render.test.mjs`** runs the board's own JS against a stub DOM and
fabricated rows, covering what pure functions cannot: that a dismissed or
closed card actually leaves the brand buckets, the counts and the badges, and
that a card carrying paragraphs of agent prose renders none of it outside the
disclosure while still keeping every word inside it.

**`test/session.test.mjs`** runs the Worker itself — no network, no
dependencies. `node:sqlite` stands in for D1 behind the same
`prepare/bind/first/all/run` shape, Linear is a stubbed `fetch`, and the schema
comes from the `*-schema.sql` files in the order the live database got them. So
it exercises the SQL that ships: that a read then an agent post is one row and
not two, that the reverse order is too, that a later read does not wipe what
the agent wrote, that the agent still reaches the card by its own session id,
and that `piece6-schema.sql` merges the pairs already in the table without
losing the Linear identity or the dismissal history. It also runs the gate
contract end to end: a note alone and an unknown id are both refused, a valid
id is accepted and comes back as its label, reopening archives the round and
clears the decision, a changed set of options supersedes an answer while the
same set re-posted leaves it alone, and a session with no options still answers
in free text.

**`test/helpers.mjs`** is the harness the Worker-level suites share: `node:sqlite`
behind D1's binding surface, the schema pieces in the order the live database
got them, and a stubbed Linear. It defines no tests of its own. Adding a
`pieceN-schema.sql` is one edit here rather than one per suite. Its Linear stub
honours the state filter the discovery query actually declares, so a widened
filter changes what the stub returns rather than being invisible to it.

**`test/dismiss.test.mjs`** holds down the first of the three invariants —
`dismissed_at = COALESCE(…)`. All three COALESCE sites are covered separately:
the discovery upsert's, the reconciliation pass's, and the dismiss route's own.
Remove any one and a named test fails. It also covers the route's ordering
contract in both directions: a Linear failure must leave the card on the board
rather than half-dismissed, and a failed label removal must leave it dismissed
rather than flickering back on and off with each cron read.

**`test/reader.test.mjs`** holds down the second — the two-pass reader. It
asserts that discovery asks for `backlog` and `unstarted` and nothing closed,
that the `first: 100` budget is still bounded, that reconciliation is
update-only and inserts nothing even when Linear volunteers an id the board
does not track, and that a failed reconciliation does not take the whole read
down with it. Widening the discovery filter fails two of these.

**`test/proxy.test.mjs`** holds down the third — the same-origin proxy — by
running `functions/api/[[path]].js` against a stubbed `fetch`. The headers are
the point: the Access JWT is forwarded, the browser's cookies are not, and
`X-Agent-Secret` is never sent from a path meant for humans. The last two fail
silently in production, so they fail loudly here. Also the Access-login-page
and unreachable-Worker branches, which exist so the board reports a cause
rather than a parse error.

**`test/access.test.mjs`** covers enforcement at the route level, which is a
different question from whether `accessIdentity` judges a token correctly.
Every route the board calls is walked as an anonymous caller and has to answer
403; `POST /api/agent/session` is exempt from the gate and refused by its own
secret check instead, with a different error string so the two cannot be
confused. It also pins the shipped-before-configured property: with either
`ACCESS_AUD` or `ACCESS_TEAM` unset, every route runs open.

**`test/routes.test.mjs`** covers what was left — `DELETE`, the legacy
`GET /api/sessions` shape the agent still reads, `/api/brands`, and the CORS
preflight. One test there is a deliberate record of a known gap: the delete
route drops the session row and leaves its `gate_decisions` rows behind, and
that test is written to fail if the cascade is ever added, so whoever adds it
sees the assertion to flip.

**The run-state suites** hold down the fix this board most recently needed: a
card that says what it is actually doing. In `test/unit.test.mjs`, `runState`
is walked through all five states plus idle, the precedence is asserted the way
round it should always have been — *"an error outranks a queue entry, because
nothing will ever clear it"*, which is the inverse of the test that used to be
there — and `isStalled` is pinned against a fixed clock, including the two
cases that must *not* flag: nothing queued, and a timestamp that will not parse.
In `test/render.test.mjs` a fixture of one row per state is mounted and read
back, so the pill, the card's outline, the disabled button's text and the
console are each checked to be saying the same thing about the same row.
`consoleRows` is covered separately and without a DOM: the ordering, the
24-hour window on finished runs, and the two rows that must sort last rather
than first — the one with no usable timestamp, and the finished run with none.
`mount()` exists for that: a suite renders its own rows rather than adding them
to the shared fixture, whose counts three other suites assert on.

QA's removal is pinned at both ends — `POST .../trigger` and
`POST /api/agent/stage-done` each answer 400 for `{"stage":"qa"}` and neither
touches the row — and on the board, where the column and the button are asserted
gone and `AI-QA done` is asserted to be no rung on the ladder.

**`test/smoke.test.mjs`** hits production and is read-only. Its one non-GET
case sends a deliberately invalid `action`, which the Worker rejects before it
reads the database and long before it calls Linear, against a session id that
does not exist. It also asserts that every reader-written row has
`linear_uuid`, `linear_state` and `title` — the "dead rows" regression, where
rows written before those columns existed left every Trigger button a no-op.

Once Access is enforcing, the smoke tests need a service token:

```bash
CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... node --test
```

Without one they skip the blocked cases with a message rather than failing, so
a green run never hides an Access misconfiguration as a broken endpoint.

## Layout

```
frontend/index.html            the board — one file, no build step
functions/api/[[path]].js      Pages Function: same-origin /api/* -> Worker
worker/index.js                the API and the Linear reader
schema.sql                     original v2 schema (includes the removed layer)
agent-schema.sql               agent_sessions
reader-schema.sql              linear_id, team
track-schema.sql               track
piece4-schema.sql              linear_uuid, linear_state, triggered_at, figma_url, title
piece5-schema.sql              dismissed_at (no-design)
piece6-schema.sql              agent_session_id + the duplicate-row merge
piece7-schema.sql              requested_stage / requested_at (the queue) + labels
piece8-schema.sql              set_aside_at (Dismissed) + linear_project
piece9-schema.sql              reader_teams — where Linear issues are read from
migration-001-gates.sql        options, the constrained decision, gate_round,
                               mockups/handoff, and the gate_decisions table
legacy-hierarchy-export.json   every row of the removed layer, with its DDL
lib/derive.mjs                 brand + track derivation, shared and testable
lib/access.mjs                 Access JWT verification
lib/session-id.mjs             the Linear key inside an agent session id
frontend/board-logic.js        pure board logic (stages, the card's action, hashing)
test/                          node:test suites — see Tests above
DEPLOY.md                      how to deploy
```

The `sections`, `projects`, `capabilities`, `resources` and `chats` tables still
exist in D1. Only `projects` is still read, and only for the four brand rows.
Dropping the rest is irreversible and costs nothing to defer.
