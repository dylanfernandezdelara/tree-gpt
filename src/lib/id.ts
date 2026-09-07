/**
 * Shared ID generation for chats, messages, and panes.
 *
 * Single implementation so `src/lib/layout.ts` and `src/lib/storage.ts`
 * cannot drift apart. Behavior is unchanged: `crypto.randomUUID()` when
 * available, otherwise a timestamp + random fallback.
 */
export function newId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
