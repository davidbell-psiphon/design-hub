# Will the button work?

19 September 2026. A second pass over both repos, with one question instead of
"is the code clean": **when Run Research or Run Design is pressed, does the
work start, finish, and report — every time?** The path a press takes was traced
end to end and every step checked against the live database, the live Worker,
the live Linear workspace and this machine.

The short answer: research is sound end to end; design has one structural
dependency on you that nothing automates; and four things could stall or
mis-report a run. Those four are fixed. The dependency is yours to decide.

---

## The path a press takes

```
board button ─► POST /trigger ─► stage_sessions.requested_at ─► GitHub dispatch
                                                                      │
   GET /queue?machine=X ◄── runner (CI or local) ◄─────────────────────┘
        │ capability + selection filter
        ▼
   handleIssue ─► planStage ─► route (Hub Figma paths → routing.json) ─► claude
        │                                                                  │
        ▼                                                                  ▼
   hubPost 'active' ─► research/design stage ─► commit+push ─► Linear comment
                                                                     │
                                            POST /stage-done ◄───────┘
                                            (label, requested_at = NULL, status done)
```

Every arrow was exercised. Where a step could fail, what it leaves behind on
the card was checked, because a stall is a failure that leaves the card looking
busy.

---

## What was verified as sound

- **Schema.** Every column the Worker, the board and the runner read exists in
  the live database. Both override columns, `figma_paths` with 7 rows,
  `agent_heartbeats.kind`/`selected_at`, and the `(issue_key, stage)` primary
  key on `stage_sessions`. Indexes cover the queue query.
- **Integrity.** No session without a card. No card with a missing team. No
  half-filled Figma path. Every live, queueable `(team, brand)` pair has a
  destination. The 24 brand-less cards are all set aside — they cannot reach
  the queue.
- **Secrets.** `GITHUB_TOKEN`, `AGENT_SECRET`, `LINEAR_API_KEY`, `ACCESS_*` on
  the Worker. `.env` complete locally. `--smoke` 13/13 against the live Hub,
  Linear, git and `claude`.
- **Labels.** All five that the system writes exist in Linear — the three
  stage labels and, now checked by `--smoke` too, `no-research` and
  `no-design`, without which Skip to Design and Dismiss answer 502 mid-press.
- **Ordering.** `stage-done` is the last thing a stage does, so any earlier
  failure leaves the request queued and the next run resumes rather than
  repeating. The ledger's `RESUMABLE_STEPS` and `resumeStep()` honour that.
- **Cancellation.** Stop clears the queue entry; the runner re-reads the queue
  before each issue and skips anything called off. Fails open on a Hub outage,
  deliberately.
- **Push.** Credentials are cached on this machine (`credential.helper =
  manager`); a headless `git push --dry-run` succeeds.

---

## What was wrong, and is fixed

### 1. Stop left a phantom `active` session — FOR-48 had one

The trigger creates the session row with `ensureSession()`, and the table's
default status is `'active'`. Stop cleared `requested_at` and left that status
standing. So press-then-stop produced a row that said `'active'` for ever with
nothing behind it: no agent post, no gate, nothing running.

FOR-48's design stage sat exactly like that in production (`status = active,
requested_at = null, agent_posted_at = null`). The board read it as idle, so it
was invisible — but `hub get`, the runner's decision reads and the wire all
carried a run that never was.

**Fix:** Stop deletes a row that nothing ever wrote to — default status, no agent
post, no gate answer. Per §3 not-started is the *absence* of a row, so that is
what Stop restores. Anything an agent or a person has touched keeps its history,
exactly as before. The FOR-48 row was removed by hand; the route now does it.

### 2. Two issues could not fit in one CI job, and the second was killed silently

The job timeout was 60 minutes; the per-issue research timeout is 45. They were
independent. A second issue that started at minute 30 was killed at minute 60,
twenty minutes into its own call — and a killed process reports nothing. Its
card had been posted `'active'` and stayed that way with the queue entry set:
**Working…**, then **Stalled**, until somebody pressed Stop.

**Fix:** the workflow now tells the runner when the job ends
(`RUNNER_DEADLINE_MS`), the runner will not start an issue whose own timeout
would not fit, and the job timeout is 180 minutes. `pastDeadline()` is pure and
tested at the boundary.

### 3. Nothing re-dispatched for deferred work

The runner said so itself, in three places, as the reason four issues once sat
queued for a day: it took its cap, deferred the rest, and no run ever came back.
The deadline guard above would have made that *more* common.

**Fix:** a run that leaves work it was offered writes the count to a marker; a
final workflow step fires one follow-up dispatch for exactly that many. The
queue is already filtered to stages the runner declared, so CI cannot loop on a
design row it will never take, and the concurrency group serialises the
follow-up.

### 4. The design agent was told to obey a routing table that was wrong

`designPrompt()` said `figma-map.json` was "the single source of truth for where
things go", and that file said: *no mapping for a team → stop*. Its table had
**no Forge at all**, and named teams `Conduit` and `Ryve` where Linear says
`Conduit App` and `Ryve App`. Meanwhile the runner had already resolved the
destination from the Hub's Figma paths and handed it to the same prompt. Two
authorities, one of them stale and telling the agent to block.

**Fix:** the prompt now states the destination is decided — file and page, by
name — and that `figma-map.json` is consulted for naming conventions only. The
file's own preamble says the same, and its table is renamed
`legacy_mappings_not_authoritative`.

### Smaller, same pass

- `git()` sets `GIT_TERMINAL_PROMPT=0`. A scheduled run has no terminal; a lost
  credential used to mean two minutes on a username prompt and then a timeout
  that hid the real reason.
- CI heartbeats as `github-actions`, not as the VM's hostname. A name per VM is
  a heartbeat row per run, for ever.

---

## The one thing that is not a bug: design needs your machine

Design runs only where Figma and Mobbin are signed in, so GitHub Actions
declares research only and never sees a design row. **Pressing Run Design
queues it and dispatches a CI run that cannot take it.** It then waits for a
local runner — and nothing local is scheduled. `schtasks` shows no task on this
machine. The last local check-in from `DaveBellJrII` (the selected machine, and
the one this was written on) was ten hours before this audit.

That is not a defect in the code. It is a decision the code is waiting for:

**Option A — keep it manual.** Run `design-local` when you have pressed the
button. The board says *"reserved for DaveBellJrII"* while it waits.

**Option B — schedule it on the selected machine.** `DaveBellJrII` is already
the chosen machine, so a scheduled `design-local` here re-claims a machine that
is already claimed — the concern in the docs about a laptop you are not at does
not apply. Every 15 minutes, weekday daytime:

```
schtasks /Create /TN "Design AI local" /F ^
  /TR "\"C:\Users\Admin\Documents\design-ai\design-ai-repo\.design-ai\bin\design-local.bat\"" ^
  /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:00 /RI 15 /DU 12:00
```

Run it once as `design-local --smoke` from the task first: Task Scheduler's
reduced environment is where `claude` auth and MCP connectivity break while
working fine at a terminal. An empty queue costs nothing — the runner exits in
seconds.

Either way, `here.bat` on a logon task keeps the board believing in this machine
between runs; that command is in `here.bat`'s own header.

---

## Not done, on purpose

- **Reassigning a card sets its brand and not its track.** Every live card this
  affects is set aside, so nothing can reach the queue with it today. When one
  is un-set-aside, `route()` will stop it with "no track mapping" and say so on
  the card. The reassign control should offer track as well; noted, not built.
- **`route()` is still 1,313 lines.** Unchanged from the previous audit.

## Checks

| | before | after |
|---|---|---|
| design-hub | 767 | **774** |
| design-ai runner | 181 | **197** |

Each new guard was reverted once to confirm it fails: the phantom-row delete
disabled fails three Stop tests; the deadline arithmetic weakened fails two.
`hub.test.mjs`, the live suite, is 167 passing, 0 failing.
