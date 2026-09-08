import { handleAuthRequest } from "./auth.js";
import { handleChatsRequest } from "./chats.js";
import { handleOpenRouterRequest } from "./openrouter.js";
import { redirectToAppOrigin } from "./origins.js";
import { fail } from "./tree.js";
import { handleTreeRequest } from "./tree-routes.js";
import { isId } from "./tree-types.js";
import { handleTurnRequest } from "./turns.js";

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const apex = redirectToAppOrigin(url, env);
		if (apex) {
			return Response.redirect(apex.href, 301);
		}

		if (url.pathname.startsWith("/api/auth")) {
			return handleAuthRequest(request, env);
		}

		if (!url.pathname.startsWith("/api/")) {
			return new Response(null, { status: 404 });
		}

		try {
			if (url.pathname === "/api/openrouter") {
				return await handleOpenRouterRequest(request, env);
			}

			if (url.pathname === "/api/chats") {
				if (url.searchParams.get("summary") === "1") {
					return await handleTreeRequest(request, env, null);
				}
				return await handleChatsRequest(request, env, null);
			}

			if (url.pathname.startsWith("/api/chats/")) {
				const route = parseChatRoute(url.pathname);
				if (!route) {
					return fail(404, "Not found");
				}
				if (route.turns) {
					return await handleTurnRequest(request, env, ctx, route.chatId);
				}
				if (request.method === "PUT") {
					return await handleChatsRequest(request, env, route.chatId);
				}
				return await handleTreeRequest(request, env, route.chatId);
			}

			return Response.json({ ok: true });
		} catch {
			return fail(500, "Internal error");
		}
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
