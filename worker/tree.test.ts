import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatRow, makeDb, messageRow } from "./testing/d1.js";
import { GC_ROOT_SQL, PATH_SQL, gcRoot, loadPath, summaryFor } from "./tree.js";
import { PENDING_TIMEOUT_MS } from "./tree-types.js";

describe("loadPath", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns [] when leaf_id is null and does not query", async () => {
		const { db, statements } = makeDb({});
		const messages = await loadPath(db, chatRow({ leaf_id: null, root_id: null }));
		expect(messages).toEqual([]);
		expect(statements).toHaveLength(0);
	});

	it("orders by depth and sets pending only on pending rows", async () => {
		const { db, statements } = makeDb({
			all: async () => ({
				results: [
					messageRow({ id: "m1", depth: 0, role: "user", status: "done", content: "hi" }),
					messageRow({
						id: "m2",
						parent_id: "m1",
						depth: 1,
						role: "assistant",
						status: "pending",
						content: "",
						created_at: 2,
						reasoning: "thinking",
					}),
					messageRow({
						id: "m3",
						parent_id: "m1",
						depth: 2,
						role: "assistant",
						status: "done",
						content: "hello",
						created_at: 3,
						reasoning: "",
					}),
				],
			}),
		});

		const messages = await loadPath(db, chatRow({ leaf_id: "m2" }));
		expect(statements).toHaveLength(1);
		expect(statements[0]?.sql).toBe(PATH_SQL);
		expect(statements[0]?.sql).toMatch(/ORDER BY depth ASC/);
		expect(statements[0]?.params).toEqual(["m2", "user-1"]);
		expect(messages).toEqual([
			{ id: "m1", role: "user", content: "hi", createdAt: 1 },
			{
				id: "m2",
				role: "assistant",
				content: "",
				createdAt: 2,
				reasoning: "thinking",
				pending: true,
			},
			{ id: "m3", role: "assistant", content: "hello", createdAt: 3 },
		]);
		expect(messages[0]?.pending).toBeUndefined();
		expect(messages[2]?.pending).toBeUndefined();
	});
});

describe("summaryFor", () => {
	const chat = chatRow();
	const pendingLeaf = messageRow({
		id: "m2",
		role: "assistant",
		status: "pending",
		created_at: 1_000,
	});

	it("is generating when the pending leaf is younger than 120s", () => {
		expect(summaryFor(chat, pendingLeaf, 1_000 + PENDING_TIMEOUT_MS - 1).generating).toBe(true);
	});

	it("is not generating at the 120s boundary", () => {
		expect(summaryFor(chat, pendingLeaf, 1_000 + PENDING_TIMEOUT_MS).generating).toBe(false);
	});

	it("is not generating when the pending leaf is older than 120s", () => {
		expect(summaryFor(chat, pendingLeaf, 1_000 + PENDING_TIMEOUT_MS + 1).generating).toBe(false);
	});

	it("is not generating when the leaf is done or missing", () => {
		expect(summaryFor(chat, messageRow({ status: "done", created_at: 1_000 }), 2_000).generating).toBe(
			false,
		);
		expect(summaryFor(chat, null, 2_000).generating).toBe(false);
	});
});

describe("gcRoot", () => {
	it("returns a reachability delete that excludes reachable ids", () => {
		const { db, statements } = makeDb({});
		const prepared = gcRoot(db, "user-1", "root-1");
		expect(prepared).toHaveLength(1);
		expect(statements).toHaveLength(1);
		expect(statements[0]?.sql).toBe(GC_ROOT_SQL);
		expect(statements[0]?.sql).toMatch(/WITH RECURSIVE reach/);
		expect(statements[0]?.sql).toMatch(/id NOT IN/);
		expect(statements[0]?.params).toEqual(["user-1", "root-1", "user-1", "root-1"]);
	});
});
