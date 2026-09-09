import { handleAuthRequest } from "./auth.js";
import { handleChatsRequest } from "./chats.js";
import { handleOpenRouterRequest } from "./openrouter.js";
import { fail } from "./tree.js";
import { handleTreeRequest } from "./tree-routes.js";
import { isId } from "./tree-types.js";
import { handleTurnRequest } from "./turns.js";

/**
 * Largest body any /api route legitimately needs. The compat PUT of a full
 * chat (80 messages of multi-byte content plus reasoning and capped search JSON) stays under 4 MiB;
 * anything bigger is rejected before a handler parses it.
 */
const MAX_API_BODY_BYTES = 8 * 1024 * 1024;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// Better Auth validates origins against its own trusted list and
		// returns its own error shapes, so it stays outside the /api wrapper.
		if (url.pathname.startsWith("/api/auth")) {
			return handleAuthRequest(request, env);
		}

		if (!url.pathname.startsWith("/api/")) {
			return new Response(null, { status: 404 });
		}

		const rejected = rejectUnsafeRequest(request, url);
		if (rejected) {
			return withApiHeaders(rejected);
		}

		try {
			return withApiHeaders(await routeApi(request, env, ctx, url));
		} catch (error) {
			console.error("Unhandled /api error", error);
			return withApiHeaders(fail(500, "Internal error"));
		}
	},
} satisfies ExportedHandler<Env>;

async function routeApi(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	url: URL,
): Promise<Response> {
	if (url.pathname === "/api/openrouter") {
		return handleOpenRouterRequest(request, env);
	}

	if (url.pathname === "/api/chats") {
		if (url.searchParams.get("summary") === "1") {
			return handleTreeRequest(request, env, null);
		}
		return handleChatsRequest(request, env, null);
	}

	if (url.pathname.startsWith("/api/chats/")) {
		const route = parseChatRoute(url.pathname);
		if (!route) {
			return fail(404, "Not found");
		}
		if (route.turns) {
			return handleTurnRequest(request, env, ctx, route.chatId);
		}
		if (request.method === "PUT") {
			return handleChatsRequest(request, env, route.chatId);
		}
		return handleTreeRequest(request, env, route.chatId);
	}

	return fail(404, "Not found");
}

/**
 * Request-shape guards that run before any handler touches the session or
 * the body. Cross-origin writes are refused even though the session cookie
 * is SameSite (defense in depth against a cookie-policy regression), and
 * oversized bodies are refused before JSON parsing can consume the isolate.
 */
export function rejectUnsafeRequest(request: Request, url: URL): Response | null {
	if (!MUTATING_METHODS.has(request.method)) {
		return null;
	}

	// Browsers always send Origin on cross-site and same-origin writes;
	// a missing header means a non-browser client, which the session
	// check still gates. "null" (sandboxed or redirected) is a mismatch.
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== url.origin) {
		return fail(403, "Cross-origin request refused");
	}

	const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_API_BODY_BYTES) {
		return fail(413, "Request body is too large");
	}

	return null;
}

/**
 * Every /api response carries per-user data or an error about it: never
 * cacheable by intermediaries, never content-sniffed. Streams keep their
 * own Cache-Control.
 */
export function withApiHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("X-Content-Type-Options", "nosniff");
	if (!headers.has("Cache-Control")) {
		headers.set("Cache-Control", "no-store");
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** `/api/chats/:id` or `/api/chats/:id/turns`; anything else is null. */
function parseChatRoute(pathname: string): { chatId: string; turns: boolean } | null {
	const rest = pathname.slice("/api/chats/".length).split("/");
	const [rawId, tail, ...more] = rest;
	if (rawId === undefined || more.length > 0) {
		return null;
	}
	let chatId: string;
	try {
		chatId = decodeURIComponent(rawId);
	} catch {
		return null;
	}
	if (!isId(chatId)) {
		return null;
	}
	if (tail === undefined) {
		return { chatId, turns: false };
	}
	if (tail === "turns") {
		return { chatId, turns: true };
	}
	return null;
}
