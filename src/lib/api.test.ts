import { describe, expect, it } from "vitest";
import { parseChatResponse } from "./api";

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
