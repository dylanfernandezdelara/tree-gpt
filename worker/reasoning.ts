export type ReasoningDetails = readonly Record<string, unknown>[];

export const MAX_REASONING_DETAILS_CHARS = 100_000;

export function parseReasoningDetails(
	raw: unknown,
): { ok: true; value?: ReasoningDetails } | { ok: false; error: string } {
	if (raw === undefined || raw === null) {
		return { ok: true };
	}
	if (!Array.isArray(raw)) {
		return { ok: false, error: "reasoningDetails must be an array" };
	}
	if (raw.length === 0) {
		return { ok: true };
	}

	const details: Record<string, unknown>[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return { ok: false, error: "reasoningDetails items must be objects" };
		}
		details.push({ ...item });
	}

	if (JSON.stringify(details).length > MAX_REASONING_DETAILS_CHARS) {
		return { ok: false, error: "reasoningDetails is too large" };
	}

	return { ok: true, value: details };
}

/** Upstream/D1 load: drop malformed blobs instead of failing the reply. */
export function asReasoningDetails(raw: unknown): ReasoningDetails | undefined {
	const parsed = parseReasoningDetails(raw);
	return parsed.ok ? parsed.value : undefined;
}

export function reasoningDetailsSize(details: ReasoningDetails | undefined): number {
	return details ? JSON.stringify(details).length : 0;
}

export function optionalReasoning(
	role: "user" | "assistant",
	details: ReasoningDetails | undefined,
): { reasoningDetails: ReasoningDetails } | Record<string, never> {
	if (role !== "assistant" || !details || details.length === 0) {
		return {};
	}
	return { reasoningDetails: details };
}

export function parseStoredReasoning(raw: string): ReasoningDetails | undefined {
	try {
		return asReasoningDetails(JSON.parse(raw));
	} catch {
		return undefined;
	}
}
