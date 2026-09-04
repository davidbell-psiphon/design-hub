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
each brand, three buckets in this order:

| Bucket | What is in it |
|---|---|
| **In flight** | Triggered; an agent is working, or it is waiting on a decision |
| **Queued** | In Linear Todo, not yet triggered |
| **Backlog** | Candidates |

Each card carries its brand colour on the card itself, and shows the Linear ID
and title, the stage, the track (app or website), links out to Linear and
Figma, and — the most important signal — whether it needs a decision.

Brand colours:

| Brand | Colour |
|---|---|
| Conduit | `#7E67A4` |
| Psiphon VPN | `#D54028` |
| Ryve | `#206CCC` |
| Forge | `#BE5135` |

A session whose brand could not be derived lands in an **Unassigned** section
rather than disappearing; the "Move to…" select on the card is how it gets home.

The sidebar filters the board to one brand. "All brands" is the default on every
load and the filter is never persisted — the Hub always opens showing
everything. On narrow screens the sidebar is a hamburger drawer, the in-flight
panel moves below the board, and every control is a 44px tap target.

---

## The trigger

Pressing **Trigger** applies the Linear label `design-ai:go` to that issue. That
is the whole mechanism — the agent watches for the label. The Hub makes it one
tap instead of a trip into Linear.

| Label | Meaning |
|---|---|
| `design-ai:go` | Start work — research, then design |
| `design-ai:qa` | Human gate passed, run QA |
| `no-research` | Skip research, mock up from the description only |

`no-research` is a toggle on the card, applied alongside `design-ai:go`. All
three labels are workspace-level in Linear, so one name resolves to one id.

---

## The scheduled job

Runs Wednesday and Friday at 8am Toronto (`0 13 * * 3,5`), because design issues
get created Tuesdays and Thursdays. It pulls every Linear issue assigned to Dave
Bell, across all teams, in Backlog or Todo, and upserts one `agent_sessions` row
per issue.

It refreshes only Linear-owned fields, so a re-read never resets an in-flight
session or undoes a manual brand reassignment. Run it on demand with
`POST /api/read-linear`.

---

## API

Written by the agent:

| Route | Purpose |
|---|---|
| `POST /api/agent/session` | Upsert session state. Requires `X-Agent-Secret`. |
| `GET /api/agent/session/:id` | Poll for the human's decision |

Used by the board:

| Route | Purpose |
|---|---|
| `GET /api/brands` | Brand id, name, colour |
| `GET /api/agent/sessions` | Every session, waiting first |
| `POST /api/agent/session/:id/trigger` | Apply `design-ai:go` or `design-ai:qa` (`{"action","noResearch"}`) |
| `PATCH /api/agent/session/:id/reassign` | Correct brand or track |
| `PATCH /api/agent/session/:id/respond` | Answer a waiting prompt |
| `DELETE /api/agent/session/:id` | Drop a session |
| `POST /api/read-linear` | Run the reader now |
| `GET /api/sessions` | Waiting sessions only (legacy shape, kept for the agent) |

The `system` field on a session is what keeps this generic: a social-media agent
posts the same shape with `"system": "social-ai"` and the Hub groups it without
knowing anything about social media.

**Known gap:** only `POST /api/agent/session` checks a secret. The trigger,
reassign and respond routes are unauthenticated — anyone with the Worker URL can
fire a Linear label. Worth closing.

---

## Layout

```
frontend/index.html            the board — one file, no build step
worker/index.js                the API and the Linear reader
schema.sql                     original v2 schema (includes the removed layer)
agent-schema.sql               agent_sessions
reader-schema.sql              linear_id, team
track-schema.sql               track
piece4-schema.sql              linear_uuid, linear_state, triggered_at, figma_url, title
legacy-hierarchy-export.json   every row of the removed layer, with its DDL
DEPLOY.md                      how to deploy
```

The `sections`, `projects`, `capabilities`, `resources` and `chats` tables still
exist in D1. Only `projects` is still read, and only for the four brand rows.
Dropping the rest is irreversible and costs nothing to defer.
