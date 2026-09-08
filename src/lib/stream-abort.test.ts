import { describe, expect, it } from "vitest";
import { STREAM_ABORT, streamFailureAction } from "./stream-abort";

function aborted(reason?: unknown): AbortSignal {
	const controller = new AbortController();
	controller.abort(reason);
	return controller.signal;
}

describe("streamFailureAction", () => {
	it("ignores a throw once another request owns the chat", () => {
		expect(streamFailureAction(aborted(STREAM_ABORT.stop), false)).toEqual({ type: "ignore" });
		expect(streamFailureAction(new AbortController().signal, false)).toEqual({ type: "ignore" });
	});

	it("drops the placeholder only for an explicit Stop", () => {
		expect(streamFailureAction(aborted(STREAM_ABORT.stop), true)).toEqual({ type: "drop" });
	});

	it("ignores leave and superseded even while still listed as owner", () => {
		expect(streamFailureAction(aborted(STREAM_ABORT.leave), true)).toEqual({ type: "ignore" });
		expect(streamFailureAction(aborted(STREAM_ABORT.superseded), true)).toEqual({
			type: "ignore",
		});
	});

	it("reports interrupted vs network from the signal", () => {
		expect(streamFailureAction(aborted(), true)).toEqual({
			type: "error",
			message: "The reply was interrupted. Try again.",
		});
		expect(streamFailureAction(new AbortController().signal, true)).toEqual({
			type: "error",
			message: "Couldn't reach the server. Check your connection and try again.",
		});
	});
});
