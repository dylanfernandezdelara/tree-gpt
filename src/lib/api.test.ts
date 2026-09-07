import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatResponse, sendChatStream, type StreamUpdate } from "./api";

describe("parseChatResponse", () => {
	it("ignores legacy reasoningDetails on success", () => {
		expect(
			parseChatResponse({
				ok: true,
				model: "meta/muse-spark-1.3-contributor",
				message: "hello",
				reasoningDetails: [{ type: "reasoning.text", text: "thinking" }],
			}),
		).toEqual({ ok: true, model: "meta/muse-spark-1.3-contributor", message: "hello" });
	});

	it("still surfaces server errors with details", () => {
		expect(parseChatResponse({ ok: false, error: "nope", details: "x" })).toEqual({
			ok: false,
			error: "nope",
			details: "x",
		});
	});
});

describe("sendChatStream", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	function sseResponse(body: string): Response {
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					// Deliberately split mid-frame to prove reassembly.
					const bytes = new TextEncoder().encode(body);
					controller.enqueue(bytes.slice(0, 11));
					controller.enqueue(bytes.slice(11));
					controller.close();
				},
			}),
			{ status: 200, headers: { "Content-Type": "text/event-stream" } },
		);
	}

	it("accumulates reasoning and content, then resolves with the model", async () => {
		fetchMock.mockResolvedValue(
			sseResponse(
				`data: {"type":"reasoning","text":"Considering"}\n\n` +
					`data: {"type":"content","text":"Hello"}\n\n` +
					`data: {"type":"content","text":" there"}\n\n` +
					`data: {"type":"done","model":"meta/muse-spark-1.3-contributor"}\n\n`,
			),
		);
		const updates: StreamUpdate[] = [];
		const result = await sendChatStream(
			[{ role: "user", content: "hi" }],
			new AbortController().signal,
			(update) => updates.push(update),
		);

		expect(result).toEqual({ ok: true, model: "meta/muse-spark-1.3-contributor" });
		expect(updates).toEqual([
			{ type: "reasoning", text: "Considering" },
			{ type: "content", text: "Hello" },
			{ type: "content", text: " there" },
		]);
		const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
			string,
			unknown
		>;
		expect(sent.stream).toBe(true);
	});

	it("surfaces mid-stream errors", async () => {
		fetchMock.mockResolvedValue(
			sseResponse(`data: {"type":"content","text":"Hello"}\n\n` + `data: {"type":"error","error":"boom"}\n\n`),
		);
		const updates: StreamUpdate[] = [];
		const result = await sendChatStream(
			[{ role: "user", content: "hi" }],
			new AbortController().signal,
			(update) => updates.push(update),
		);

		expect(result).toEqual({ ok: false, error: "boom" });
		expect(updates).toEqual([{ type: "content", text: "Hello" }]);
	});

	it("falls back to JSON errors when the stream never starts", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded, try again later" }), {
				status: 429,
				headers: { "Content-Type": "application/json", "Retry-After": "120" },
			}),
		);
		const result = await sendChatStream(
			[{ role: "user", content: "hi" }],
			new AbortController().signal,
			() => {},
		);

		expect(result.ok).toBe(false);
	});
});
