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

Default model for all OpenRouter chat completions: `meta/muse-spark-1.3-contributor` (Muse Spark 1.3 contributor tier).

There is no separate instant/thinking slug. Instant-like replies use `reasoning: { effort: "minimal", exclude: true }` (shortest pass Muse supports; `none` returns HTTP 400). `exclude` only hides the reasoning trace from the response — the model still reasons. Keep `max_tokens` at 4096. Never store or echo `reasoning_details`: plain chat sends no `tools`, so there is no tool-use continuity to preserve, and replaying old thinking only slows later replies. Accept-and-drop legacy blobs from old clients instead of rejecting them.

Do not switch models unless we explicitly ask.
