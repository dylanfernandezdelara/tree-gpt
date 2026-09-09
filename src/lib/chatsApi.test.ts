import { beforeEach, describe, expect, it, vi } from "vitest";
import { listChats } from "./chatsApi";

describe("listChats", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	it("returns null on a 500 so the UI can show a load error", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
		const chats = await listChats(new AbortController().signal);
		expect(chats).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/chats",
			expect.objectContaining({ credentials: "same-origin" }),
		);
	});

	it("keeps a 200 with an empty list distinct from a failure", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ chats: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		await expect(listChats(new AbortController().signal)).resolves.toEqual([]);
	});
});
