# Agent instructions

## Local development

Copy `.dev.vars.example` to `.dev.vars` and set `OPENROUTER_API_KEY`. Then run `npm run dev` — that starts the Vite frontend and the Cloudflare Worker together at http://localhost:5173.

## Models

Use **OpenRouter free models only**. Do not call paid models until we explicitly cut over.

- Default model: `openrouter/free` (OpenRouter's free-model router)
- If you pick a specific model, it must have a `:free` suffix (for example `minimax/minimax-m3:free`)
- Do not use paid slugs, latest aliases, or any model that would incur usage charges
