import {
	MAX_CITATIONS,
	MAX_SEARCH_JSON,
	MAX_STORED_TOOL_CALLS,
	type Citation,
	type ToolCall,
	type ToolCallState,
} from "./tree-types.js";

const MAX_TITLE = 200;
const MAX_QUERY = 500;
const MAX_TOOL_ID = 128;

export type SearchAccumulator = {
	citations: Citation[];
	seenUrls: Set<string>;
	tools: Map<number, { id?: string; name?: string; args: string }>;
	webSearchRequests: number;
};

export type SearchMeta = {
	citations?: Citation[];
	toolCalls?: ToolCall[];
};

export function createSearchAccumulator(): SearchAccumulator {
	return {
		citations: [],
		seenUrls: new Set(),
		tools: new Map(),
		webSearchRequests: 0,
	};
}

/** Drop bad entries rather than reject the chat. https only, no credentials. */
export function sanitizeCitations(raw: unknown): Citation[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: Citation[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (out.length >= MAX_CITATIONS) {
			break;
		}
		const citation = sanitizeCitation(item);
		if (!citation || seen.has(citation.url)) {
			continue;
		}
		seen.add(citation.url);
		out.push(citation);
	}
	return fitJson(out, (entry) => ({ url: entry.url, ...(entry.title ? { title: entry.title } : {}) }));
}

export function sanitizeToolCalls(raw: unknown): ToolCall[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: ToolCall[] = [];
	for (const item of raw) {
		if (out.length >= MAX_STORED_TOOL_CALLS) {
			break;
		}
		const call = sanitizeToolCall(item);
		if (call) {
			out.push(call);
		}
	}
	return fitJson(out, (entry) => ({
		id: entry.id,
		name: entry.name,
		...(entry.query ? { query: entry.query } : {}),
		state: entry.state,
	}));
}

export function storedSearchJson(value: unknown[] | undefined): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value.length === 0) {
		return null;
	}
	const json = JSON.stringify(value);
	return json.length > MAX_SEARCH_JSON ? null : json;
}

export function parseStoredSearchJson<T>(
	raw: string | null | undefined,
	sanitize: (value: unknown) => T[],
): T[] | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		const value = sanitize(parsed);
		return value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read annotations, optional streamed tool_calls, and usage from one
 * Chat Completions payload (delta or final message).
 */
export function ingestOpenRouterPayload(acc: SearchAccumulator, payload: object): void {
	const usage = field(payload, "usage");
	const serverToolUse = usage ? field(usage, "server_tool_use") : null;
	const requests = serverToolUse ? field(serverToolUse, "web_search_requests") : null;
	if (typeof requests === "number" && Number.isFinite(requests) && requests > acc.webSearchRequests) {
		acc.webSearchRequests = requests;
	}

	const choice = firstChoice(payload);
	if (!choice) {
		return;
	}
	ingestAnnotations(acc, field(choice, "delta"));
	ingestAnnotations(acc, field(choice, "message"));
	ingestToolCallDeltas(acc, field(choice, "delta"));
	ingestToolCallDeltas(acc, field(choice, "message"));
}

export function finalizeSearchMeta(acc: SearchAccumulator): SearchMeta {
	const citations = sanitizeCitations(acc.citations);
	const parsedTools: ToolCall[] = [];
	for (const [index, partial] of [...acc.tools.entries()].sort((a, b) => a[0] - b[0])) {
		const call = sanitizeToolCall({
			id: partial.id ?? `web_search_${index}`,
			name: toolName(partial.name),
			query: queryFromArgs(partial.args),
			state: "output-available",
		});
		if (call) {
			parsedTools.push(call);
		}
	}
	let toolCalls = sanitizeToolCalls(parsedTools);
	const searched = acc.webSearchRequests > 0 || citations.length > 0 || toolCalls.length > 0;
	if (searched && toolCalls.length === 0) {
		toolCalls = [{ id: "web_search", name: "web_search", state: "output-available" }];
	}
	return {
		...(citations.length > 0 ? { citations } : {}),
		...(toolCalls.length > 0 ? { toolCalls } : {}),
	};
}

export function searchMetaFromPayload(payload: object): SearchMeta {
	const acc = createSearchAccumulator();
	ingestOpenRouterPayload(acc, payload);
	return finalizeSearchMeta(acc);
}

function sanitizeCitation(raw: unknown): Citation | null {
	const nested = citationFields(raw);
	if (!nested) {
		return null;
	}
	const parsed = safeHttpsUrl(nested.url);
	if (!parsed) {
		return null;
	}
	const title = citationTitle(parsed, nested.title);
	return title ? { url: parsed.href, title } : { url: parsed.href };
}

function citationFields(raw: unknown): { url: unknown; title?: unknown } | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	if ("url_citation" in raw && typeof raw.url_citation === "object" && raw.url_citation !== null) {
		const inner = raw.url_citation;
		return {
			url: "url" in inner ? inner.url : undefined,
			title: "title" in inner ? inner.title : undefined,
		};
	}
	if ("url" in raw) {
		return { url: raw.url, title: "title" in raw ? raw.title : undefined };
	}
	return null;
}

function sanitizeToolCall(raw: unknown): ToolCall | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const name = toolName("name" in raw ? raw.name : undefined);
	if (name !== "web_search") {
		return null;
	}
	const id = "id" in raw && typeof raw.id === "string" ? raw.id.trim().slice(0, MAX_TOOL_ID) : "";
	if (!id) {
		return null;
	}
	const state = toolState("state" in raw ? raw.state : "output-available");
	if (!state) {
		return null;
	}
	const query =
		"query" in raw && typeof raw.query === "string" ? raw.query.trim().slice(0, MAX_QUERY) : "";
	return query ? { id, name, query, state } : { id, name, state };
}

function toolName(value: unknown): "web_search" | null {
	return value === "web_search" ? "web_search" : null;
}

function toolState(value: unknown): ToolCallState | null {
	return value === "input-available" || value === "output-available" || value === "output-error"
		? value
		: null;
}

function citationTitle(url: URL, title: unknown): string | undefined {
	if (typeof title === "string" && title.trim()) {
		return title.trim().slice(0, MAX_TITLE);
	}
	return url.hostname || undefined;
}

function safeHttpsUrl(value: unknown): URL | null {
	if (typeof value !== "string") {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") {
		return null;
	}
	if (parsed.username || parsed.password) {
		return null;
	}
	return parsed;
}

function ingestAnnotations(acc: SearchAccumulator, container: object | null): void {
	if (!container || !("annotations" in container) || !Array.isArray(container.annotations)) {
		return;
	}
	for (const item of container.annotations) {
		const citation = sanitizeCitation(item);
		if (!citation || acc.seenUrls.has(citation.url) || acc.citations.length >= MAX_CITATIONS) {
			continue;
		}
		acc.seenUrls.add(citation.url);
		acc.citations.push(citation);
	}
}

function ingestToolCallDeltas(acc: SearchAccumulator, container: object | null): void {
	if (!container || !("tool_calls" in container) || !Array.isArray(container.tool_calls)) {
		return;
	}
	for (const raw of container.tool_calls) {
		if (typeof raw !== "object" || raw === null) {
			continue;
		}
		const index = "index" in raw && typeof raw.index === "number" ? raw.index : acc.tools.size;
		const prev = acc.tools.get(index) ?? { args: "" };
		if ("id" in raw && typeof raw.id === "string" && raw.id) {
			prev.id = raw.id;
		}
		const fn = field(raw, "function");
		if (fn) {
			if ("name" in fn && typeof fn.name === "string" && fn.name) {
				prev.name = fn.name;
			}
			if ("arguments" in fn && typeof fn.arguments === "string") {
				prev.args += fn.arguments;
			}
		}
		acc.tools.set(index, prev);
	}
}

function queryFromArgs(args: string): string | undefined {
	if (!args.trim()) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(args);
		if (typeof parsed === "string" && parsed.trim()) {
			return parsed.trim().slice(0, MAX_QUERY);
		}
		if (typeof parsed === "object" && parsed !== null) {
			for (const key of ["query", "q", "search"]) {
				if (key in parsed) {
					const value = (parsed as Record<string, unknown>)[key];
					if (typeof value === "string" && value.trim()) {
						return value.trim().slice(0, MAX_QUERY);
					}
				}
			}
		}
	} catch {
		const trimmed = args.trim();
		return trimmed ? trimmed.slice(0, MAX_QUERY) : undefined;
	}
	return undefined;
}

function firstChoice(payload: object): object | null {
	if (!("choices" in payload) || !Array.isArray(payload.choices)) {
		return null;
	}
	const first = payload.choices[0];
	return typeof first === "object" && first !== null ? first : null;
}

function field(value: object, key: string): object | null {
	if (!(key in value)) {
		return null;
	}
	const next = value[key as keyof typeof value];
	return typeof next === "object" && next !== null ? next : null;
}

function fitJson<T>(entries: T[], project: (entry: T) => T): T[] {
	const projected = entries.map(project);
	while (projected.length > 0 && JSON.stringify(projected).length > MAX_SEARCH_JSON) {
		projected.pop();
	}
	return projected;
}
