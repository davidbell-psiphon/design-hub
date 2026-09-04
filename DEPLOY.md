# Design Hub — deploy

Two pieces: a Worker (API + scheduled Linear reader) and a Pages site (the
board). See [README.md](./README.md) for what the app actually does.

| Piece | Command | Lives at |
|---|---|---|
| Worker | `npx wrangler deploy` | https://design-hub-worker.d-bell.workers.dev |
| Board | `npx wrangler pages deploy frontend --project-name=design-hub` | https://design-hub-7y2.pages.dev |

The board is a single static `frontend/index.html` — no build step. It calls the
Worker by absolute URL (the `API` constant at the top of its `<script>`), so the
two deploy independently.

---

## Secrets

```bash
npx wrangler secret put LINEAR_API_KEY   # raw Linear key, no "Bearer" prefix
npx wrangler secret put AGENT_SECRET     # shared with the design-ai agent
```

`LINEAR_API_KEY` is required — the reader and every trigger call go through it.
`AGENT_SECRET` guards `POST /api/agent/session`, the route the agent writes to.

## Database

D1, `design-hub` (`b785c9c7-15fb-4234-bf62-58f038b90775`), bound as `DB` in
`wrangler.toml`. The schema arrived in pieces; apply any not yet applied:

```bash
npx wrangler d1 execute design-hub --remote --file=./agent-schema.sql
npx wrangler d1 execute design-hub --remote --file=./reader-schema.sql
npx wrangler d1 execute design-hub --remote --file=./track-schema.sql
npx wrangler d1 execute design-hub --remote --file=./piece4-schema.sql
```

All four are already applied to the live database. They are additive
(`ALTER TABLE` / `CREATE INDEX IF NOT EXISTS`), so re-running one fails on the
duplicate column rather than destroying anything.

**Do not run `schema.sql` against the live database.** It opens with
`DROP TABLE` and recreates the old hierarchy with seed data. It is kept for
history, not for deploys.

## Schedule

`wrangler.toml` sets `crons = ["0 13 * * 3,5"]` — Wednesday and Friday, 13:00
UTC, which is 8am Toronto during EDT. It shifts to 9am when EST starts; change
the hour to `0 14` if that matters. `npx wrangler deploy` applies cron changes.

## Linear labels

The trigger applies labels by name, taking the first match, so each must exist
exactly once at **workspace level** — a team-scoped duplicate would hand the
mutation an id from the wrong team.

| Label | Id |
|---|---|
| `design-ai:go` | `fb951ac2-96c5-4006-af3b-c20392cd115e` |
| `design-ai:qa` | `a6b89043-5824-4ad5-83b8-4192878d9e82` |
| `no-research` | `d058267a-a646-4069-850c-1e146de837a7` |

---

## Checking a deploy

```bash
curl https://design-hub-worker.d-bell.workers.dev/api/brands
curl https://design-hub-worker.d-bell.workers.dev/api/agent/sessions
curl -X POST https://design-hub-worker.d-bell.workers.dev/api/read-linear
```

`/api/brands` should return the four brands with their colours. The reader
returns `{inserted, updated, skipped}`.

A Worker deploy takes a few seconds to propagate — if a just-added route still
404s, call it again before debugging it.

## Gotchas

- `wrangler pages deploy` warns that `wrangler.toml` has no
  `pages_build_output_dir` and ignores the config file. Harmless: Pages only
  needs the directory argument.
- `wrangler login` binds its OAuth callback to `localhost:8976` no matter what
  `--callback-port` says. If the port is busy, free it rather than moving it.
- Stale OAuth scopes show up as `7403 account not authorized` on D1 commands
  while `wrangler deploy` still works. `npx wrangler login` again to fix.
