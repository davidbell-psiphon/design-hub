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

## Zero Trust Access

The code side is done and deployed; what remains is dashboard work. The board
already calls `/api/*` on its own origin through a Pages Function, so there is
no cross-origin call left for Access to break.

**Order matters.** Do these in sequence, testing between each.

1. **Access application for the board.** Zero Trust → Access → Applications →
   Add an application → Self-hosted → domain `design-hub-7y2.pages.dev`. Use the
   same identity rule as the Design Portal, but a separate application: its own
   AUD, its own session, its own audit log. Copy the **AUD tag** from the
   application's Overview tab.
2. **Preview deployments.** Workers & Pages → design-hub → Settings → General →
   **Enable access policy**. This is a *separate* switch: protecting the
   production hostname leaves `<hash>.design-hub-7y2.pages.dev` public, and
   every deploy makes one.
3. **Service token for the agent.** Zero Trust → Access → Service Auth →
   Service Tokens → Create. The secret is shown once. Add a second policy on the
   Hub application with action **Service Auth** selecting that token — with any
   other action Access will prompt for an IdP login and the agent will receive
   an HTML page instead of JSON.
4. **Turn on Worker enforcement:**
   ```bash
   npx wrangler secret put ACCESS_AUD    # AUD tag from step 1
   npx wrangler secret put ACCESS_TEAM   # team name, without .cloudflareaccess.com
   ```
   Until both are set the Worker runs open. Setting them closes every route
   except `POST /api/agent/session`, which authenticates with `X-Agent-Secret`.
5. **Protect the Worker itself.** Workers & Pages → design-hub-worker → Access →
   Protect this Worker behind Access. Then give the proxy a service token so it
   can still get through:
   ```bash
   npx wrangler pages secret put CF_ACCESS_CLIENT_ID --project-name=design-hub
   npx wrangler pages secret put CF_ACCESS_CLIENT_SECRET --project-name=design-hub
   ```
   The Function returns a clear "Blocked by Access" JSON error if these are
   missing, rather than letting the board fail on an HTML parse error.

**What breaks if you skip a step:** the agent stops writing at its next run
while the cron reader keeps filling the board (different code path, no HTTP
edge), which reads like an agent bug and is not one. Create the service token
in the same sitting as step 5.

Do not test in a private window — Access's own docs warn that `CF-Authorization`
gets dropped as a third-party cookie and you will chase a phantom. A bad policy
cannot lock you out permanently: `dash.cloudflare.com` is not behind your
Access policy.

## Checking a deploy

```bash
curl https://design-hub-7y2.pages.dev/api/brands          # through the proxy
curl https://design-hub-7y2.pages.dev/api/agent/sessions
curl -X POST https://design-hub-worker.d-bell.workers.dev/api/read-linear
```

Once Access is on, these need service-token headers:

```bash
curl https://design-hub-7y2.pages.dev/api/brands \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
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
