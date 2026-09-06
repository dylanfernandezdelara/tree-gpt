const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const FREE_MODEL = "openrouter/free";

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/api/openrouter") {
			return chatOpenRouter(request, env);
		}

		if (url.pathname.startsWith("/api/")) {
			return Response.json({ ok: true });
		}

		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function chatOpenRouter(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ ok: false, error: "Use POST" }, { status: 405 });
	}

	if (!env.OPENROUTER_API_KEY) {
		return Response.json(
			{ ok: false, error: "OPENROUTER_API_KEY is not set in .dev.vars" },
			{ status: 500 },
		);
	}

	const message = await readUserMessage(request);
	if (message instanceof Response) {
		return message;
	}

	const upstream = await fetch(OPENROUTER_CHAT_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "http://localhost:5173",
			"X-Title": "treeGPT",
		},
		body: JSON.stringify({
			model: FREE_MODEL,
			messages: [{ role: "user", content: message }],
			max_tokens: 1024,
		}),
	});

	if (!upstream.ok) {
		const details = (await upstream.text()).slice(0, 500);
		return Response.json(
			{
				ok: false,
				error: `OpenRouter returned ${upstream.status}`,
				details,
			},
			{ status: 502 },
		);
	}

	const payload: unknown = await upstream.json();
	const parsed = parseCompletion(payload);
	if (!parsed) {
		return Response.json(
			{ ok: false, error: "Unexpected OpenRouter response shape" },
			{ status: 502 },
		);
	}

	return Response.json({
		ok: true,
		model: parsed.model,
		message: parsed.message,
	});
}

async function readUserMessage(request: Request): Promise<string | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
	}

	if (
		typeof body !== "object" ||
		body === null ||
		!("message" in body) ||
		typeof body.message !== "string"
	) {
		return Response.json(
			{ ok: false, error: "message must be a string" },
			{ status: 400 },
		);
	}

	const message = body.message.trim();
	if (!message) {
		return Response.json(
			{ ok: false, error: "message must not be empty" },
			{ status: 400 },
		);
	}

	return message;
}

function parseCompletion(
	payload: unknown,
): { model: string; message: string } | null {
	if (typeof payload !== "object" || payload === null) {
		return null;
	}

	if (!("model" in payload) || typeof payload.model !== "string") {
		return null;
	}

	if (!("choices" in payload) || !Array.isArray(payload.choices)) {
		return null;
	}

	const first = payload.choices[0];
	if (typeof first !== "object" || first === null || !("message" in first)) {
		return null;
	}

	const message = first.message;
	if (typeof message !== "object" || message === null) {
		return null;
	}

	if (!("content" in message) || typeof message.content !== "string") {
		return null;
	}

	return { model: payload.model, message: message.content };
}
