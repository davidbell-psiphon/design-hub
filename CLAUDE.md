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

## Identity: the Linear issue key, and nothing else

A card is named by its Linear issue. `RYV-84`, not `linear/RYV-84`, not
`ryve/ryv-84/design`. `agent_sessions.linear_id` holds it and carries a unique
index, so a second card for one issue is not reconciled away — it cannot be
written.

**The agent still posts whatever it likes.** `ryve/ryv-84/design` keeps working
and always will: `lib/session-id.mjs` parses the key back out of it at the
boundary. Parsing an id is not the same as storing a second one, and that
distinction is the whole of §2. If you find yourself adding a column so that
two naming schemes can be matched up later, that is the bug the architecture
document is about.

**Brand is never part of the key.** It is derived from the Linear team. A
session id naming the wrong brand still lands on the right card and does not
change the card's brand — there is a test for exactly that, because the reason
the brand segment went is that it let the key contradict Linear.

`agent_session_id` is the bridging column this replaced. It is still on the
table and is written by nothing; leave it alone rather than reading it.

**A record with no Linear issue key is not a card.** It may exist — the
runner's reachability probe is one — and it works on its own routes. It is
filtered out of `GET /api/agent/sessions`, because every control on a card
refuses a row with no Linear issue behind it, and drawing one offers a full set
of buttons that cannot work.

## Invariants that look like cruft

Three things are load-bearing and read as redundant. Do not simplify them:

- **`dismissed_at = COALESCE(agent_sessions.dismissed_at, excluded.dismissed_at)`**
  (`worker/index.js:148`) — a cron read can only ever *add* a dismissal, never
  clear one. Drop the COALESCE and a Wednesday run silently un-dismisses every
  card whose `no-design` label was removed in Linear.
- **The two-pass reader.** Discovery carries a fixed `first: 100` budget;
  reconciliation is a separate update-only pass. Merging them lets closed issues
  eat the budget and starve the board of real work.
- **The same-origin proxy.** The board calls `/api/*` on its own origin
  (`frontend/index.html:218`, `const API = '/api'`) and
  `functions/api/[[path]].js` forwards to the Worker. A direct cross-origin call
  to `workers.dev` cannot be authenticated by Access from a browser — the
  `CF-Authorization` cookie is per-hostname, preflights carry no cookies, and
  Safari drops it as third-party. Do not cut out the middleman.

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
