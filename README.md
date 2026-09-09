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

Deploy with `npm run deploy` (it applies D1 migrations first, then deploys). Production is `https://forkgpt.app`. Register `<origin>/api/auth/callback/github` on the GitHub OAuth App for each hostname you sign in on.

## API

All `/api/chats` and `/api/openrouter` routes require the Better Auth session cookie (`401 { "ok": false, "error": "Unauthorized" }` without one). Ids are client-minted (1–128 chars). Types live in `worker/tree-types.ts`. Messages are immutable tree nodes (`parentId` / `rootId` / `depth`); a chat is a named pointer to a leaf; the messages a pane shows are the root-to-leaf path. Fork = a second pointer into the same tree; redo = a sibling reply under the same user node. `leafId` is the chat's version (every turn moves it, rename does not) and is the CAS token for `/turns`. `generating` on a summary means the leaf is a pending reply younger than 120 s. Signed-in chats persist per user; guests keep chats in the browser. Any unexpected throw on `/api/` (except `/api/auth`) returns `500 { "ok": false, "error": "Internal error" }`; unknown `/api/` paths return `404`. Every `/api/` response is `Cache-Control: no-store` (streams keep `no-cache`) and `X-Content-Type-Options: nosniff`.

The OpenRouter key never leaves the Worker: the client only ever calls `/api/*`, every generate route requires a session, the per-user and account-wide quotas are checked before any upstream call, and upstream error bodies are logged rather than returned. Set a monthly credit limit on the key in the OpenRouter dashboard as the final backstop. Static assets ship a CSP and the other browser headers from `public/_headers`.

### Tree routes

#### `GET /api/chats?summary=1`

Sidebar list. No message bodies. Ordered by `updatedAt` desc, then `createdAt` desc.

```json
{ "chats": [{ "id": "t-c1", "title": "Turn test", "rootId": "t-u1", "leafId": "t-r1", "generating": false, "createdAt": 1788806300916, "updatedAt": 1788806301714 }] }
```

- `200` `{ chats: ChatSummary[] }` — `rootId` / `leafId` are `null` on an empty chat
- `401` `"Unauthorized"` · `405` `"Method not allowed"`

#### `GET /api/chats/:id`

Root-to-leaf path. A pending assistant leaf includes `pending: true` (and may have empty `content`).

```json
{
  "chat": { "id": "t-c1", "title": "Turn test", "rootId": "t-u1", "leafId": "t-r1", "generating": false, "createdAt": 1788806300916, "updatedAt": 1788806301714 },
  "messages": [
    { "id": "t-u1", "role": "user", "content": "...", "createdAt": 1788806300916 },
    { "id": "t-r1", "role": "assistant", "content": "alpha", "createdAt": 1788806300916 }
  ]
}
```

- `200` `{ chat: ChatSummary, messages: ApiMessage[] }`
- `401` `"Unauthorized"` · `404` `"Not found"` (unknown or another user's id) · `405` `"Method not allowed"`

#### `PATCH /api/chats/:id`

Rename. Last writer wins; does not move `leafId`.

Request: `{ "title": "Renamed fork" }` → `200 { "chat": ChatSummary }`.

- `400` `"Invalid JSON body"` · `"title must be a string"` · `"title must not be empty"` · `"title is too long"`
- `401` `"Unauthorized"` · `404` `"Not found"` · `405` `"Method not allowed"`

#### `DELETE /api/chats/:id`

Removes the pointer, then any nodes of that root no remaining chat reaches. A fork keeps the shared prefix.

→ `200 { "ok": true }`

- `401` `"Unauthorized"` · `404` `"Not found"` · `405` `"Method not allowed"` · `500` `"Could not delete chat"`

#### `POST /api/chats/:id/turns`

The write primitive. `stream: true` → SSE once reserve succeeds; omit `stream` for JSON. Failures before the stream opens are JSON (never SSE). Persistence runs on a tee inside `ctx.waitUntil`, so a reply that finishes within ~30 s of the disconnect is still committed; a longer one is left pending and abandoned by the next write (the user message survives, quota was spent).

Request (`TurnRequest`):

```ts
{
  parentId: string | null;           // attach under this node; null = new tree
  expectLeaf: string | null;         // client's chats.leaf_id (CAS)
  replyId: string;                   // idempotency key for the assistant row
  userMessage?: { id: string; content: string }; // omit = redo
  fork?: { chatId: string; title: string };      // land on a new pointer; :id untouched
  title?: string;                    // new chat only (`parentId: null` and `:id` absent)
  stream?: boolean;
  model?: ModelId;                   // allowlisted id; omitted = Muse Spark 1.3
  effort?: EffortId;                 // must be offered by model; omitted = model default
}
```

Allowlisted models (`ModelId` in `worker/tree-types.ts`; anything else → `400 "model is not supported"`):

- `meta/muse-spark-1.3-contributor` (default) — Muse Spark 1.3
- `openai/gpt-5.6-luna` — GPT-5.6 Luna

Reasoning effort (`EffortId` in `worker/tree-types.ts`; unknown → `400 "effort is not supported"`, valid id the model doesn't offer → `400 "effort is not supported by this model"`):

- Muse Spark 1.3: `minimal` (default), `low`, `medium`, `high`, `xhigh` (`max` is catalog-listed but Meta's provider rejects it)
- GPT-5.6 Luna: `none` = Off (default), `low`, `medium`, `high`, `xhigh`, `max`

**Send / create** — `parentId` is the current leaf (`null` to create; `:id` must not exist, or must be an empty chat). `title` is used only when creating a new chat (`parentId: null` and `:id` does not exist; whitespace-only becomes `"New chat"`). It is ignored on an existing empty chat, append, redo, and fork (use `fork.title`).

```json
{
  "parentId": null,
  "expectLeaf": null,
  "replyId": "t-r1",
  "userMessage": { "id": "t-u1", "content": "..." },
  "title": "Turn test"
}
```

```json
{
  "ok": true,
  "chat": { "id": "t-c1", "title": "Turn test", "rootId": "t-u1", "leafId": "t-r1", "generating": false, "createdAt": 1788806300916, "updatedAt": 1788806301714 },
  "messages": [
    { "id": "t-u1", "role": "user", "content": "...", "createdAt": 1788806300916 },
    { "id": "t-r1", "role": "assistant", "content": "alpha", "createdAt": 1788806300916 }
  ]
}
```

**Redo** — no `userMessage`; `parentId` must be a user node. The old reply stays as a sibling; the chat's leaf moves to the new one.

```json
{ "parentId": "t-u2", "expectLeaf": "t-r2", "replyId": "t-r2b" }
```

**Fork** — same as send (or redo) plus `fork`. Response `chat` is the **new** chat; the source `:id` is untouched (its `leafId` does not move). Prefix nodes are stored once.

```json
{
  "parentId": "t-r1",
  "expectLeaf": "t-r2b",
  "replyId": "t-f-r1",
  "userMessage": { "id": "t-f-u1", "content": "..." },
  "fork": { "chatId": "t-c2", "title": "Forked" }
}
```

**Idempotency (`replyId`).** Lookup runs before quota. A completed `replyId` returns the same `200` without calling OpenRouter or charging quota. A pending `replyId` younger than 120 s → `409` `"Reply is still generating"`; older → the pending row is abandoned, then `409` `"Reply timed out"`. Never regenerates. A reply that already completed can never be un-pointed by a late abandon. A completion that finds its row already abandoned (timed-out replay or a concurrent write) reports `409` `"Reply was abandoned before it finished"` instead of a false `done`.

**CAS (`expectLeaf`).** Must match the chat's current `leafId`. Stale value → `409`, nothing written or charged. Reload (`GET /api/chats/:id`) and retry from the returned `chat.leafId`.

```json
{ "ok": false, "error": "Chat changed, reload", "chat": { "id": "t-c1", "title": "Turn test", "rootId": "t-u1", "leafId": "t-r1", "generating": false, "createdAt": 1788806300916, "updatedAt": 1788806301714 } }
```

**Streaming** (`"stream": true`) — `200 text/event-stream` after reserve. Sequence:

- optional `:thinking` comment lines (keep-alive; **not** `data:` — ignore them)
- `data: {"type":"reasoning","text":"..."}` — zero or more
- `data: {"type":"content","text":"..."}` — one or more
- exactly one terminal: `data: {"type":"done","chat":{...ChatSummary},"messages":[...ApiMessage]}` or `data: {"type":"error","error":"...","details"?:"..."}`

The `done` event carries the committed chat and full path — replace local state with it. If the pending reply was abandoned (timed-out replay or a concurrent write) before generation finished, the terminal is `data: {"type":"error","error":"Reply was abandoned before it finished"}` (JSON path → `409` with that string).

```
:thinking

data: {"type":"reasoning","text":"..."}

data: {"type":"content","text":"beta"}

data: {"type":"done","chat":{"id":"t-c1","title":"Turn test","rootId":"t-u1","leafId":"t-r1","generating":false,"createdAt":1788806300916,"updatedAt":1788806301714},"messages":[{"id":"t-u1","role":"user","content":"...","createdAt":1788806300916},{"id":"t-r1","role":"assistant","content":"beta","createdAt":1788806300916}]}
```

Status codes (JSON unless the stream already opened):

- `400` `"Invalid JSON body"` · `"parentId is invalid"` · `"expectLeaf is invalid"` · `"replyId is invalid"` · `"fork is invalid"` · `"fork.chatId is invalid"` · `"fork.title must be a string"` · `"fork.title must not be empty"` · `"fork.title is too long"` · `"userMessage is invalid"` · `"userMessage.id is invalid"` · `"userMessage content must be a string"` · `"userMessage content must not be empty"` · `"userMessage content is too long"` · `"title must be a string"` · `"title is too long"` · `"stream must be a boolean"` · `"model is not supported"` · `"effort is not supported"` · `"effort is not supported by this model"` · `"parentId is required for redo"` · `"fork is not allowed when creating a chat"` · `"userMessage.id must differ from replyId"` · `"Parent is not in this chat"` · `"Redo requires a user message parent"` · `"Conversation is too deep"` · `"Tree is too large"` · `"Chat limit reached"`
- `401` `"Unauthorized"`
- `403` `"Cross-origin request refused"` (a write whose `Origin` header does not match the app origin; applies to every `/api/*` write except `/api/auth`)
- `404` `"Not found"` · `"Parent not found"`
- `405` `"Use POST"`
- `413` `"Request body is too large"` (`Content-Length` over 8 MiB, refused before parsing)
- `409` `"Chat changed, reload"` (includes `chat`) · `"Chat already exists"` (includes `chat`) · `"Fork target already exists"` (includes `chat` when owned) · `"Reply is still generating"` · `"Reply timed out"` · `"Parent reply is not finished"` · `"Reply was abandoned before it finished"`
- `429` `"Rate limit exceeded, try again later"` (`Retry-After` seconds)
- `500` `"Chat is not configured on this server"` (missing `OPENROUTER_API_KEY`; the cause is logged, not returned) · `"Reserved chat is missing"` · `"Internal error"`
- `502` `"OpenRouter returned <status>"` (the upstream body is logged server-side, never forwarded) · `"OpenRouter returned an empty reply"` · mid-stream `error` events: `"OpenRouter returned an error"` · `"Stream interrupted"` · `"OpenRouter returned an empty reply"` (JSON `502` when `stream` is absent)

### Frontend wiring notes

- Import `ChatSummary`, `ApiMessage`, `TurnRequest`, `TurnResponse`, `TurnStreamEvent`, `ModelId`, `EffortId`, `CHAT_MODELS`, `DEFAULT_MODEL` from `worker/tree-types.ts`.
- Hydrate: `GET /api/chats?summary=1`, then `GET /api/chats/:id` per open pane.
- Send: `POST /api/chats/:id/turns` with `parentId = leafId`, `expectLeaf = leafId`, mint `userMessage.id` and `replyId` client-side. Set `stream: true`. Include the selected `model` (`ModelId`) and `effort` (`EffortId`); omit for the Muse Spark 1.3 + minimal defaults.
- Redo: same route, `parentId` = the user node above the reply, no `userMessage`.
- Fork: same as send (or redo) plus `fork: { chatId, title }` when the same chat is open in another pane (or when redoing a reply that is not the leaf).
- On `409`, reload (`GET /api/chats/:id` or use the returned `chat`) and retry from the fresh `leafId`.
- On `502` / SSE `error` for a send: the pending reply is removed and the user message is kept as the chat's leaf, so the next send uses `parentId = expectLeaf = <that user message id>`. On `429` nothing was written.
- On SSE `done`, replace the pane's `chat` + `messages` with the payload.
- Stop: prefer keeping the fetch open and just stop rendering deltas (the invocation stays alive and the reply commits), or abort and accept that a slow reply may be lost; afterwards `GET /api/chats/:id`.
- An in-flight assistant row on `GET /api/chats/:id` has `pending: true`.
- SSE parsers must ignore `:thinking` comment frames (they are not `data:` lines).

### Compat routes (transitional)

Unchanged shapes, used by the current UI. Slated for removal once the UI is on `/turns`.

- `GET /api/chats` — full documents `{ chats: [{ id, title, createdAt, updatedAt, messages: [{ id, role, content, createdAt, reasoning? }] }] }` (pending rows omitted). Non-GET → `405` `"Use GET"`.
- `PUT /api/chats/:id` — full-document replace, reconciled onto the tree (append / truncate / diverge / in-place edit). Compare-and-swaps the chat's leaf on every reconcile statement: a concurrent `/turns` write returns `409` `"Chat changed, reload"` and writes nothing. `409` `"Chat is generating"` if the leaf is a fresh pending reply; `409` `"Message is shared with another chat and cannot be edited here"` when editing a node another chat shares. Array cap 80 (maps to depth < 80). Does not enforce the per-root 400 cap.
- `POST /api/openrouter` — `{ message, messages: [{ role, content }], stream?, model?, effort? }` → `{ ok, model, message }`, or SSE `{ type: "reasoning" | "content", text }` / `{ type: "search", citations?, toolCalls? }` / `{ type: "done", model, citations?, toolCalls? }` / `{ type: "error", error }`. `search` is a live snapshot of display-only web-search metadata (partial `tool_calls` stay `input-available` until citations or `web_search_requests` arrive). `done` repeats the finalized snapshot. `model` is an optional allowlisted `ModelId` (same two as `/turns`; omitted = Muse Spark 1.3); `effort` is an optional `EffortId` the model must offer. Anything else → `400 "model is not supported"` / `"effort is not supported"` / `"effort is not supported by this model"` before quota. Legacy `reasoningDetails` blobs are accepted and dropped. Display-only `reasoning` is never sent upstream. Search metadata is never sent upstream.

### Limits

From `worker/tree-types.ts` unless noted:

- `MAX_CHATS` 100 per user
- `MAX_DEPTH` 80 nodes on a path
- `MAX_MESSAGES_PER_ROOT` 400 (enforced by `/turns` only)
- `MAX_CONTENT` 8000 · `MAX_TITLE` 200 · `MAX_ID` 128
- `MAX_REASONING` 4000 (display-only; never sent upstream)
- `PENDING_TIMEOUT_MS` 120000
- Quota: 60 generations per user per hour, and 1000 across all users per hour → `429` with `Retry-After`. Both counters are atomic upserts, so concurrent bursts cannot overshoot.
- Upstream history window (OpenRouter): last 50 turns / 32k chars

### Fork lineage (proposed, needs agreement)

A chat created by forking carries an `origin`, which the frontend already sends on `PUT /api/chats/:id`:

```jsonc
"origin": {
  "parentChatId": "…",
  "kind": "branch" | "thread",   // duplicated pane typed in, or text highlighted
  "parentMessageId": "…",        // where it diverged, in the PARENT's id space
  "quote": "…"                   // "thread" only: the highlighted text
}
```

`parseChat` ignores unknown fields, so this is currently dropped and `GET /api/chats` does not return it. Until the Worker stores and returns `origin`, the frontend falls back to a local mirror (`treegpt.lineage.<ns>.v1`), so lineage does not survive on another device. The sidebar fork tree and the fork links under a conversation both read this field. Field names are open to change.

### Bookmarks (proposed, needs agreement)

Highlighting a passage and choosing **Bookmark** saves it. There is no bookmarks table yet, so these live only in the browser (`treegpt.bookmarks.<ns>.v1`) and do not follow the user to another device.

```jsonc
{ "id": "…", "chatId": "…", "messageId": "…", "quote": "…", "createdAt": 1730000000000 }
```

Routes that would carry it, scoped to the session user like `/api/chats`: `GET /api/bookmarks`, `PUT /api/bookmarks/:id`, `DELETE /api/bookmarks/:id`. Names are open to change.

Shapes mirror the types in `worker/openrouter.ts` (`CompletionMessage`) and `worker/chats.ts` (`ApiChat`/`ApiMessage`), which are the source of truth. Signed-in chats persist per user; guests keep chats in the browser.
