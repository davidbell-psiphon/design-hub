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
npx wrangler secret put GITHUB_TOKEN     # starts the runner when a button is pressed
```

`LINEAR_API_KEY` is required — the reader and every trigger call go through it.
`AGENT_SECRET` guards `POST /api/agent/session`, the route the agent writes to.

`GITHUB_TOKEN` is optional, and what it buys is *when* the work happens. Without
it a stage button still queues the request; the runner just does not learn about
it until someone starts a run. With it, pressing a button fires a
`workflow_dispatch` at the runner's GitHub Actions workflow and the work begins
in seconds.

Make it a **fine-grained personal access token** on
`davidbell-psiphon/design-ai`, with one permission: **Actions: Read and write**.
Nothing else — it never reads code, issues, or secrets. GitHub → Settings →
Developer settings → Personal access tokens → Fine-grained tokens.

Fine-grained tokens expire. When this one does, the board says so on the next
press — the toast reads "queued, but the run did not start" and names the
reason — rather than failing silently. Two optional vars override the target if
the repo is ever renamed: `RUNNER_REPO`, `RUNNER_WORKFLOW`.

## Database

D1, `design-hub` (`b785c9c7-15fb-4234-bf62-58f038b90775`), bound as `DB` in
`wrangler.toml`. The schema arrived in pieces; apply any not yet applied:

```bash
npx wrangler d1 execute design-hub --remote --file=./agent-schema.sql
npx wrangler d1 execute design-hub --remote --file=./reader-schema.sql
npx wrangler d1 execute design-hub --remote --file=./track-schema.sql
npx wrangler d1 execute design-hub --remote --file=./piece4-schema.sql
npx wrangler d1 execute design-hub --remote --file=./piece5-schema.sql
npx wrangler d1 execute design-hub --remote --file=./piece6-schema.sql
npx wrangler d1 execute design-hub --remote --file=./piece7-schema.sql
npx wrangler d1 execute design-hub --remote --file=./piece8-schema.sql
```

**If `--file` answers `Authentication error [code: 10000]`,** run the piece one
statement at a time with `--command` instead. `--file` posts to D1's `/import`
endpoint and `--command` posts to `/query`; the two are authorised separately,
and an OAuth token that can run statements is not necessarily one that can
import a file. piece8 was applied that way.

```bash
```

Every piece up to and including `piece5-schema.sql` is already applied to the
live database. They are additive (`ALTER TABLE` / `CREATE INDEX IF NOT
EXISTS`), so re-running one fails on the duplicate column rather than
destroying anything.

**`piece7-schema.sql` goes first, before `npx wrangler deploy`.** It adds
`requested_stage`, `requested_at` and `labels`. The new Worker writes all three
on every read and every trigger, and the board reads `labels` to decide which
column a card is in — deploy against a database without them and the reader
throws and the board renders every card under Backlog.

**`piece6-schema.sql` goes first, before `npx wrangler deploy`.** It adds
`agent_session_id`, which the new Worker reads on every session route — deploy
the Worker against a database without that column and every one of those routes
throws. It also merges the duplicate rows that are in the table now (see
[One card per issue](./README.md#one-card-per-issue)), so it is worth reading
the row counts before and after:

```bash
npx wrangler d1 execute design-hub --remote \
  --command="SELECT count(*) AS rows, count(linear_id) AS linear FROM agent_sessions"
```

**Do not run `schema.sql` against the live database.** It opens with
`DROP TABLE` and recreates the old hierarchy with seed data. It is kept for
history, not for deploys.

## Schedule

`wrangler.toml` sets `crons = ["0 13 * * 3,5"]` — Wednesday and Friday, 13:00
UTC, which is 8am Toronto during EDT. It shifts to 9am when EST starts; change
the hour to `0 14` if that matters. `npx wrangler deploy` applies cron changes.

## Linear labels

Labels are applied by name, taking the first match, so each must exist exactly
once at **workspace level** — a team-scoped duplicate would hand the mutation an
id from the wrong team.

Three of them are written by `POST /api/agent/stage-done` when a stage
completes, and must exist before the first run reports back:

| Label | Written when |
|---|---|
| `AI-research done` | the research agent finishes |
| `AI-design done` | the design agent finishes |
| `AI-QA done` | QA finishes |

Two are Dave's own, and already exist:

| Label | Id |
|---|---|
| `no-research` | `d058267a-a646-4069-850c-1e146de837a7` |
| `no-design` | applied by the dismiss route |

`design-ai:go` (`fb951ac2-96c5-4006-af3b-c20392cd115e`) and `design-ai:qa`
(`a6b89043-5824-4ad5-83b8-4192878d9e82`) are retired. Nothing writes or reads
them any more; strip them off the issues that carry them and archive both once
the runner has stopped polling for `design-ai:go`.

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
