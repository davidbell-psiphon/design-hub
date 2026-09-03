# DAD-AI — Deploy to Cloudflare

Four steps. Takes about 10 minutes.

## 1. Create the D1 database

In your terminal, inside this folder:

```bash
npx wrangler d1 create dad-ai
```

Wrangler will print something like:
```
database_id = "abc123-def456-..."
```

Copy that ID and paste it into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_ID`.

## 2. Run the database schema

```bash
npx wrangler d1 execute dad-ai --file=./schema.sql
```

This creates your tables and seeds your brands + starter projects.

## 3. Deploy the Worker

```bash
npx wrangler deploy
```

This deploys your API Worker. It will give you a URL like:
`https://dad-ai-worker.YOUR-SUBDOMAIN.workers.dev`

## 4. Deploy the Frontend to Pages

In your Cloudflare dashboard:
- Go to Pages → Create a project → Upload assets
- Upload the `frontend/` folder
- Set the project name to `dad-ai`

Or via CLI if you have Pages wrangler set up:
```bash
npx wrangler pages deploy frontend --project-name=dad-ai
```

## 5. Connect frontend to your Worker

Open `frontend/index.html` and find this line near the top of the script:

```js
const API = '/api';
```

Change it to your Worker URL:

```js
const API = 'https://dad-ai-worker.YOUR-SUBDOMAIN.workers.dev/api';
```

Then redeploy the frontend.

---

## That's it

Your dashboard will be live at:
`https://dad-ai.pages.dev`

Accessible from home, work, phone — anywhere.

## Adding your existing chats

For each Claude chat you want to track:
1. Open the dashboard
2. Click the right brand in the sidebar
3. Hit "+ chat" on the project it belongs to
4. Paste the `claude.ai/chat/...` URL
5. Done — it's filed

---

## File reference

```
dad-ai/
├── frontend/index.html   ← the dashboard UI
├── worker/index.js       ← the API (runs on Cloudflare Workers)
├── schema.sql            ← database setup + seed data
├── wrangler.toml         ← deployment config
└── DEPLOY.md             ← this file
```
