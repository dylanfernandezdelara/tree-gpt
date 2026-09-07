import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleOpenRouterRequest, requestCompletion } from "./openrouter.js";

vi.mock("./auth.js", () => ({
	getSessionUser: vi.fn(async () => ({ id: "user-1", email: "user@example.com" })),
	ensureDomainUser: vi.fn(async () => {}),
}));

function upstreamOk(payload: unknown): Response {
	return new Response(JSON.stringify(payload), { status: 200 });
}

function chatPayload(content: unknown, extraMessage: Record<string, unknown> = {}) {
	return {
		model: "meta/muse-spark-1.3-contributor",
		choices: [{ message: { role: "assistant", content, ...extraMessage } }],
	};
}

/** Minimal D1 stub: first() reports no existing rate-limit window. */
function rateLimitDb() {
	const run = vi.fn(async () => ({}));
	const first = vi.fn(async () => undefined);
	const db = {
		prepare: vi.fn(() => ({ bind: (..._args: unknown[]) => ({ first, run }) })),
	};
	return { db: db as unknown as D1Database, run };
}

const env = (overrides: Record<string, unknown> = {}) =>
	({
		OPENROUTER_API_KEY: "test-key",
		DB: rateLimitDb().db,
		...overrides,
	}) as unknown as Env;

describe("requestCompletion", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	it("asks for minimal reasoning with the trace excluded", async () => {
		fetchMock.mockResolvedValue(upstreamOk(chatPayload("hello")));
		const result = await requestCompletion(env(), [{ role: "user", content: "hi" }]);

		expect(result.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
			string,
			unknown
		>;
		expect(body.model).toBe("meta/muse-spark-1.3-contributor");
		expect(body.max_tokens).toBe(4096);
		expect(body.reasoning).toEqual({ effort: "minimal", exclude: true });
	});

	it("never forwards legacy reasoningDetails blobs upstream", async () => {
		fetchMock.mockResolvedValue(upstreamOk(chatPayload("hello")));
		const legacy = {
			role: "assistant",
			content: "old reply",
			reasoningDetails: [{ type: "reasoning.text", text: "x".repeat(8000) }],
		};
		const result = await requestCompletion(env(), [
			legacy as unknown as { role: "user"; content: string },
			{ role: "user", content: "follow-up" },
		]);

		expect(result.ok).toBe(true);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			messages: Record<string, unknown>[];
		};
		expect(JSON.stringify(body).includes("reasoning")).toBe(true); // the reasoning param only
		for (const message of body.messages) {
			expect(message).toEqual({ role: message.role, content: message.content });
			expect("reasoning_details" in message).toBe(false);
		}
		// The 8k legacy blob must not inflate the wire payload.
		expect(JSON.stringify(body).length).toBeLessThan(1000);
	});

	it("drops reasoning_details returned upstream instead of storing them", async () => {
		fetchMock.mockResolvedValue(
			upstreamOk(
				chatPayload("hello", {
					reasoning_details: [{ type: "reasoning.text", text: "thinking..." }],
				}),
			),
		);
		const result = await requestCompletion(env(), [{ role: "user", content: "hi" }]);

		expect(result).toEqual({ ok: true, value: { model: expect.any(String), content: "hello" } });
		expect("reasoningDetails" in (result as { value: object }).value).toBe(false);
	});

	it("caps long histories to the most recent turns", async () => {
		fetchMock.mockResolvedValue(upstreamOk(chatPayload("hello")));
		// 60 turns x ~1k chars each: over the 32k history budget, so the
		// worker must trim to a recent suffix (capping lives in the HTTP
		// handler's parseMessages, not in requestCompletion).
		const messages = Array.from({ length: 60 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `message ${i} ` + "y".repeat(1000),
		}));
		const request = new Request("http://localhost:5173/api/openrouter", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: messages[59]?.content, messages }),
		});
		const response = await handleOpenRouterRequest(request, env());

		expect(response.status).toBe(200);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			messages: { content: string }[];
		};
		expect(body.messages.length).toBeLessThanOrEqual(50);
		expect(body.messages.length).toBeGreaterThan(0);
		expect(body.messages[body.messages.length - 1]?.content).toBe(messages[59]?.content);
		expect(body.messages[0]?.content).not.toBe(messages[0]?.content);
	});

	it("fails closed on upstream errors and empty replies", async () => {
		fetchMock.mockResolvedValue(new Response("bad gateway", { status: 502 }));
		const failed = await requestCompletion(env(), [{ role: "user", content: "hi" }]);
		expect(failed.ok).toBe(false);
		if (!failed.ok) {
			expect(failed.error.status).toBe(502);
		}

		fetchMock.mockResolvedValue(upstreamOk(chatPayload("   ", { reasoning_details: [] })));
		const empty = await requestCompletion(env(), [{ role: "user", content: "hi" }]);
		expect(empty.ok).toBe(false);

		const noKey = await requestCompletion(env({ OPENROUTER_API_KEY: "" }), [
			{ role: "user", content: "hi" },
		]);
		expect(noKey.ok).toBe(false);
	});
});

describe("handleOpenRouterRequest", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	it("accepts (and drops) legacy reasoningDetails instead of rejecting them", async () => {
		fetchMock.mockResolvedValue(upstreamOk(chatPayload("fresh reply")));
		const request = new Request("http://localhost:5173/api/openrouter", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "follow-up",
				messages: [
					{
						role: "assistant",
						content: "old reply",
						reasoningDetails: [{ type: "reasoning.text", text: "old thinking" }],
					},
					{ role: "user", content: "follow-up" },
				],
			}),
		});

		const response = await handleOpenRouterRequest(request, env());
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({
			ok: true,
			model: "meta/muse-spark-1.3-contributor",
			message: "fresh reply",
		});
	});
});
