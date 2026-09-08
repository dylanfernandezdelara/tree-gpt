/**
 * Tripwire for the empty-reply hang: the Worker Response (and its first
 * heartbeat) must exist before OpenRouter answers. Awaiting that fetch in
 * the handler left the isolate with no body; the edge canceled it as hung.
 *
 * These helpers fail in STREAM_TTFB_BUDGET_MS instead of waiting for the
 * Vitest timeout, so a regression is a fast, named failure.
 */

export const STREAM_TTFB_BUDGET_MS = 100;

export class StreamTtfbTimeout extends Error {
	constructor(what: string) {
		super(
			`${what} did not resolve within ${STREAM_TTFB_BUDGET_MS}ms while OpenRouter was still unanswered. ` +
				"The Worker Response must exist (and emit a heartbeat) before the upstream fetch resolves.",
		);
		this.name = "StreamTtfbTimeout";
	}
}

/** Fetch that stays pending until `release` — the hang the tripwire watches for. */
export function holdOpenRouterFetch(): {
	impl: () => Promise<Response>;
	release: (response: Response) => void;
} {
	let resolveFetch: ((response: Response) => void) | undefined;
	return {
		impl: () =>
			new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			}),
		release(response: Response) {
			if (!resolveFetch) {
				throw new Error("release() called before fetch");
			}
			resolveFetch(response);
		},
	};
}

export async function assertWithinTtfbBudget<T>(promise: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new StreamTtfbTimeout(what)), STREAM_TTFB_BUDGET_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function readFirstChunkWithinBudget(
	body: ReadableStream<Uint8Array> | null,
	what: string,
): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
	if (!body) {
		throw new Error(`${what} has no body`);
	}
	const reader = body.getReader();
	const first = await assertWithinTtfbBudget(reader.read(), `${what} first SSE chunk`);
	if (first.done || !first.value) {
		throw new Error(`${what} closed before the first heartbeat`);
	}
	return { text: new TextDecoder().decode(first.value), reader };
}
