# Agent instructions

## Local development

Copy `.dev.vars.example` to `.dev.vars` and set:

- `OPENROUTER_API_KEY`
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from a GitHub OAuth App (not a GitHub App)
- `BETTER_AUTH_SECRET` — random, at least 32 characters (`openssl rand -base64 32`)

GitHub OAuth callback for local: `http://localhost:5173/api/auth/callback/github`. Add the same path on each `workers.dev` or preview origin you use.

Apply D1 migrations, then start the Vite frontend and Cloudflare Worker together at http://localhost:5173:

```bash
npm run db:migrate:local
npm run dev
```

Use `localhost`, not `127.0.0.1`, so passkeys match the WebAuthn rpID.

## Models

Use **OpenRouter free models only**. Do not call paid models until we explicitly cut over.

- Default model: `openrouter/free` (OpenRouter's free-model router)
- If you pick a specific model, it must have a `:free` suffix (for example `minimax/minimax-m3:free`)
- Do not use paid slugs, latest aliases, or any model that would incur usage charges
