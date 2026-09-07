import { handleAuthRequest } from "./auth.js";
import { handleChatsRequest } from "./chats.js";
import { handleOpenRouterRequest } from "./openrouter.js";

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/auth")) {
			return handleAuthRequest(request, env);
		}

		if (url.pathname === "/api/openrouter") {
			return handleOpenRouterRequest(request, env);
		}

		if (url.pathname === "/api/chats" || url.pathname.startsWith("/api/chats/")) {
			return handleChatsRequest(request, env);
		}

		if (url.pathname.startsWith("/api/")) {
			return Response.json({ ok: true });
		}

		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
