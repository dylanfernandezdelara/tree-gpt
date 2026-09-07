import { describe, expect, it } from "vitest";
import type { Chat, ForkOrigin } from "../types";
import { ancestorIds, buildForest, childrenByParent } from "./forest";

function chat(id: string, parentChatId?: string): Chat {
	const origin: ForkOrigin | undefined = parentChatId
		? { parentChatId, kind: "branch", parentMessageId: null }
		: undefined;
	return {
		id,
		title: id,
		messages: [],
		createdAt: 0,
		updatedAt: 0,
		...(origin ? { origin } : {}),
	};
}

describe("buildForest", () => {
	it("nests a fork under the chat it came from", () => {
		const forest = buildForest([chat("root"), chat("fork", "root")]);
		expect(forest).toHaveLength(1);
		expect(forest[0].chat.id).toBe("root");
		expect(forest[0].children.map((n) => n.chat.id)).toEqual(["fork"]);
	});

	it("promotes a fork whose parent was deleted", () => {
		const forest = buildForest([chat("fork", "gone")]);
		expect(forest.map((n) => n.chat.id)).toEqual(["fork"]);
	});

	it("keeps every chat reachable when lineage forms a cycle", () => {
		const a = chat("a", "b");
		const b = chat("b", "a");
		const forest = buildForest([a, b]);
		const ids = new Set<string>();
		const walk = (nodes: ReturnType<typeof buildForest>) => {
			for (const node of nodes) {
				ids.add(node.chat.id);
				walk(node.children);
			}
		};
		walk(forest);
		expect(ids).toEqual(new Set(["a", "b"]));
	});

	it("ignores a chat that claims itself as its parent", () => {
		const forest = buildForest([chat("self", "self")]);
		expect(forest.map((n) => n.chat.id)).toEqual(["self"]);
	});

	it("keeps sibling order as given", () => {
		const forest = buildForest([chat("root"), chat("second", "root"), chat("first", "root")]);
		expect(forest[0].children.map((n) => n.chat.id)).toEqual(["second", "first"]);
	});
});

describe("ancestorIds", () => {
	it("lists every parent up to the root, nearest first", () => {
		const chats = [chat("root"), chat("mid", "root"), chat("leaf", "mid")];
		expect(ancestorIds(chats, "leaf")).toEqual(["mid", "root"]);
	});

	it("is empty for a root", () => {
		expect(ancestorIds([chat("root")], "root")).toEqual([]);
	});
});

describe("childrenByParent", () => {
	it("groups forks under their parent", () => {
		const chats = [chat("root"), chat("a", "root"), chat("b", "root"), chat("c", "a")];
		const map = childrenByParent(chats);
		expect(map.get("root")?.map((c) => c.id)).toEqual(["a", "b"]);
		expect(map.get("a")?.map((c) => c.id)).toEqual(["c"]);
		expect(map.has("c")).toBe(false);
	});
});
