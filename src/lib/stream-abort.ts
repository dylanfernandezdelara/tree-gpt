/** Why a generate AbortController was aborted. Other aborts stay distinguishable. */
export const STREAM_ABORT = {
	stop: "stop",
	superseded: "superseded",
	leave: "leave",
} as const;

export type StreamFailureAction =
	| { type: "ignore" }
	| { type: "drop" }
	| { type: "error"; message: string };

/**
 * What the UI should do when sendChatStream throws.
 * Stop drops the placeholder; a newer request or leaving the chat is a no-op;
 * anything else is an error on the placeholder.
 */
export function streamFailureAction(
	signal: AbortSignal,
	stillOwner: boolean,
): StreamFailureAction {
	if (
		!stillOwner ||
		signal.reason === STREAM_ABORT.leave ||
		signal.reason === STREAM_ABORT.superseded
	) {
		return { type: "ignore" };
	}
	if (signal.reason === STREAM_ABORT.stop) {
		return { type: "drop" };
	}
	return {
		type: "error",
		message: signal.aborted
			? "The reply was interrupted. Try again."
			: "Couldn't reach the server. Check your connection and try again.",
	};
}
