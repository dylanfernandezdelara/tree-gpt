# treeGPT

React + Vite frontend on Cloudflare Workers, with a Worker API.

## Setup

1. Copy `.dev.vars.example` to `.dev.vars` and set `OPENROUTER_API_KEY`, `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, and `BETTER_AUTH_SECRET` (random, ≥32 chars: `openssl rand -base64 32`).
2. Create a GitHub OAuth App (not a GitHub App): Homepage `http://localhost:5173`, callback `http://localhost:5173/api/auth/callback/github`.
3. Run migrations, then start the app (use `localhost`, not `127.0.0.1`):

```bash
npm run db:migrate:local
npm run dev # http://localhost:5173
```

Deploy with `npm run deploy` (it applies D1 migrations first, then deploys). In production set plaintext Worker var `APP_ORIGIN` to the app origin (unset locally).

## API

All `/api/openrouter` and `/api/chats` routes require the Better Auth session cookie (`401` without one).

- `POST /api/openrouter` — `{ message, messages: [{ role, content }], stream? }` → `{ ok, model, message }`, or with `stream: true` an SSE stream of `{ type: "reasoning" | "content", text }` / `{ type: "done", model }` / `{ type: "error", error }` events, or `{ ok: false, error }` (legacy `reasoningDetails` blobs are accepted and dropped; display-only `reasoning` text on messages is stored for rendering and never sent upstream)
- `GET /api/chats` → `{ chats }`, `PUT /api/chats/:id` (full replace), `DELETE /api/chats/:id`

Shapes mirror the types in `worker/openrouter.ts` (`CompletionMessage`) and `worker/chats.ts` (`ApiChat`/`ApiMessage`), which are the source of truth. Signed-in chats persist per user; guests keep chats in the browser.
