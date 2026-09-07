import { handleAuthRequest } from "./auth.js";
import { handleChatsRequest } from "./chats.js";
import { handleOpenRouterRequest } from "./openrouter.js";
import { handleTreeRequest } from "./tree-routes.js";
import { isId } from "./tree-types.js";
import { handleTurnRequest } from "./turns.js";

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/auth")) {
			return handleAuthRequest(request, env);
		}

		if (url.pathname === "/api/openrouter") {
			return handleOpenRouterRequest(request, env);
		}

		if (url.pathname === "/api/chats") {
			if (request.method === "GET" && url.searchParams.get("summary") === "1") {
				return handleTreeRequest(request, env, null);
			}
			return handleChatsRequest(request, env);
		}

		if (url.pathname.startsWith("/api/chats/")) {
			const route = parseChatRoute(url.pathname);
			if (!route) {
				return Response.json({ ok: false, error: "Not found" }, { status: 404 });
			}
			if (route.turns) {
				return handleTurnRequest(request, env, ctx, route.chatId);
			}
			switch (request.method) {
				case "GET":
				case "PATCH":
				case "DELETE":
					return handleTreeRequest(request, env, route.chatId);
				default:
					return handleChatsRequest(request, env);
			}
		}

		if (url.pathname.startsWith("/api/")) {
			return Response.json({ ok: true });
		}

		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

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
