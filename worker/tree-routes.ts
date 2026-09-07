/**
 * Tree-native routes: summaries, single-chat path, rename, delete.
 *
 *   GET    /api/chats?summary=1   → { chats: ChatSummary[] }
 *   GET    /api/chats/:id         → { chat: ChatSummary, messages: ApiMessage[] }
 *   PATCH  /api/chats/:id         → { chat: ChatSummary }
 *   DELETE /api/chats/:id         → { ok: true }
 *
 * The compat GET list and PUT stay in chats.ts; /turns lives in turns.ts.
 */

/**
 * Invariant: every response is scoped to the session user; another user's
 * chat id is indistinguishable from a missing one (404).
 */
export async function handleTreeRequest(
	request: Request,
	env: Env,
	chatId: string | null,
): Promise<Response> {
	void request;
	void env;
	void chatId;
	throw new Error("not implemented");
}
