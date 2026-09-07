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

Use `localhost`, not `127.0.0.1`.

## Agent worktrees

- This is an AI-native codebase: always push to remote `main`. Merging locally into `main` and pushing is the expected flow.
- In-session subagents: use built-in worktree isolation; never run `git worktree` manually.
- Separate sessions: `git worktree add ../treeGPT-<slug> -b agent/<slug> main`, merge to `main`, then `git push origin main`. Open a PR only when explicitly asked.
- Cleanup only after prod deploy is green: `git worktree remove ../treeGPT-<slug>`, `git branch -d agent/<slug>`, `git worktree prune`.

## Models

Allowlisted chat models (`ModelId` in `worker/tree-types.ts`; the Worker rejects anything else with 400 before quota):

- `meta/muse-spark-1.3-contributor` — Muse Spark, the default for omitted/legacy requests.
- `openai/gpt-5.6-luna` — GPT-5.6 Luna.
- `qwen/qwen3.7-flash` — Qwen3.7 Flash.

Per-model low-cost reasoning (`reasoningFor` in `worker/openrouter.ts`; live catalog, Sep 2026): Muse reasoning is mandatory with `minimal` in `supported_efforts`, so `reasoning: { effort: "minimal" }` is the fastest legal setting (`none` returns HTTP 400). Luna lists `none` in `supported_efforts` with reasoning optional, so it sends `reasoning: { effort: "none" }`. Qwen exposes no effort levels but supports `max_tokens`, so it sends `reasoning: { max_tokens: 512 }`. Keep `max_tokens` at 4096. The non-streaming path adds `exclude: true`; the streaming path omits it so the UI can show thinking live. `POST /api/chats/:id/turns` streams the same reasoning/content deltas but replaces upstream's terminal frame with its own `done` (committed `chat` + root-to-leaf path) after the reply is persisted; persistence runs on a tee inside `ctx.waitUntil`, so a reply that finishes within ~30 s of the disconnect is still committed; a longer one is left pending and abandoned by the next write (the user message survives, quota was spent). Never store or echo `reasoning_details`: plain chat sends no `tools`, so there is no tool-use continuity to preserve, and replaying old thinking only slows later replies. The UI keeps a small display-only `reasoning` string per assistant message (persisted, truncated to 4k, never sent upstream). Accept-and-drop legacy blobs from old clients instead of rejecting them.

Do not add or switch models unless we explicitly ask.
