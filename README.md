# treeGPT

React + Vite frontend on Cloudflare Workers, with a Worker API.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and set:

- `OPENROUTER_API_KEY`
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a GitHub OAuth App
- `BETTER_AUTH_SECRET` — random, at least 32 characters (`openssl rand -base64 32`)

Create a GitHub OAuth App (not a GitHub App) with:

- Homepage: `http://localhost:5173`
- Callback: `http://localhost:5173/api/auth/callback/github`

Apply D1 migrations, then start the app:

```bash
npm run db:migrate:local
npm run dev
```

Open http://localhost:5173. Use `localhost`, not `127.0.0.1`, so passkeys work.

```bash
npm run db:migrate:remote   # production D1, before or with deploy
npm run deploy              # workers.dev
```
