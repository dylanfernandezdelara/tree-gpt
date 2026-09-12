/**
 * The conversation up to and including one message.
 *
 * A fork from a highlighted passage continues from THAT point, so the replies
 * after it belong to the path the reader is leaving behind: they are dropped
 * from the new chat and from the context sent upstream. Passing `null` keeps
 * everything, which is what a plain branch wants.
 *
 * An id that is not present -- the message was regenerated or deleted between
 * the highlight and the send -- keeps the whole conversation rather than
 * returning an empty one: carrying too much is recoverable, losing the
 * conversation is not.
 */
export function messagesUpTo<T extends { id: string }>(
	messages: readonly T[],
	messageId: string | null,
): T[] {
	if (!messageId) {
		return [...messages];
	}
	const index = messages.findIndex((message) => message.id === messageId);
	return index === -1 ? [...messages] : messages.slice(0, index + 1);
}
