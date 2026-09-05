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

Two collapsed sections sit at the foot of the board, each showing a count and
expanding on one click. Both are collapsed on every load, and rows in either
one leave the brand buckets, the brand counts, the topbar total, the waiting
badges and the in-flight panel.

| Section | What is in it |
|---|---|
| **No design** | Cards carrying the `no-design` label. Un-dismissable from there. |
| **Completed** | Issues whose Linear state is completed or canceled |

`no-research` cards stay on the main board: that label means "skip research, go
straight to mockup", which is active work still heading for the human gate.

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
| `no-design` | Not design work at all — collapses the card into No design |

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
`POST /api/read-linear` (which now needs `X-Agent-Secret`, since Access is on).

The reader runs **two passes**:

1. **Discovery** — backlog and unstarted issues; inserts and updates.
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
| `POST /api/agent/session/:id/dismiss` | Apply `no-design`, file the card away |
| `DELETE /api/agent/session/:id/dismiss` | Remove `no-design`, put it back |
| `PATCH /api/agent/session/:id/reassign` | Correct brand or track |
| `PATCH /api/agent/session/:id/respond` | Answer a waiting prompt |
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
closed card actually leaves the brand buckets, the counts and the badges.

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
legacy-hierarchy-export.json   every row of the removed layer, with its DDL
lib/derive.mjs                 brand + track derivation, shared and testable
lib/access.mjs                 Access JWT verification
frontend/board-logic.js        pure board logic (bucketing, staging, hashing)
test/                          node:test suites — see Tests above
DEPLOY.md                      how to deploy
```

The `sections`, `projects`, `capabilities`, `resources` and `chats` tables still
exist in D1. Only `projects` is still read, and only for the four brand rows.
Dropping the rest is irreversible and costs nothing to defer.
