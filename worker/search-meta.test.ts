/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	finalizeSearchMeta,
	ingestOpenRouterPayload,
	createSearchAccumulator,
	snapshotSearchMeta,
	sanitizeCitations,
	sanitizeToolCalls,
	searchMetaFromPayload,
	storedSearchJson,
} from "./search-meta.js";

function fixture(name: string): object {
	return JSON.parse(readFileSync(join(import.meta.dirname, "testdata", name), "utf8")) as object;
}

describe("sanitizeCitations", () => {
	it("keeps https url+title, drops excerpts, and omits unsafe urls", () => {
		expect(
			sanitizeCitations([
				{
					type: "url_citation",
					url_citation: {
						url: "https://www.example.com/a",
						title: "Example",
						content: "secret excerpt",
						start_index: 0,
						end_index: 4,
					},
				},
				{ url: "http://insecure.example", title: "No" },
				{ url: "https://user:pass@evil.example/x", title: "Creds" },
				{ url: "https://www.example.com/b" },
				{ url: "not a url" },
			]),
		).toEqual([
			{ url: "https://www.example.com/a", title: "Example" },
			{ url: "https://www.example.com/b", title: "www.example.com" },
		]);
	});

	it("caps at eight unique urls", () => {
		const raw = Array.from({ length: 12 }, (_, i) => ({
			url: `https://www.example.com/${i}`,
			title: `T${i}`,
		}));
		expect(sanitizeCitations(raw)).toHaveLength(8);
		expect(sanitizeCitations([...raw, raw[0]])).toHaveLength(8);
	});
});

describe("sanitizeToolCalls", () => {
	it("keeps web_search chips and drops anything else", () => {
		expect(
			sanitizeToolCalls([
				{ id: "c1", name: "web_search", query: "us open", state: "output-available" },
				{ id: "c2", name: "shell", state: "output-available" },
				{ id: "c3", name: "web_search", state: "nope" },
			]),
		).toEqual([{ id: "c1", name: "web_search", query: "us open", state: "output-available" }]);
	});
});

describe("searchMetaFromPayload", () => {
	it("parses the Muse annotation fixture and synthesizes a completed tool", () => {
		expect(searchMetaFromPayload(fixture("search-muse.json"))).toEqual({
			citations: [{ url: "https://www.example.com/us-open", title: "US Open results" }],
			toolCalls: [{ id: "web_search_0", name: "web_search", state: "output-available" }],
		});
	});

	it("reads web_search_requests as a number, not an object field", () => {
		const acc = createSearchAccumulator();
		ingestOpenRouterPayload(acc, {
			usage: { server_tool_use: { web_search_requests: 2 } },
		});
		expect(acc.webSearchRequests).toBe(2);
		expect(snapshotSearchMeta(acc)).toEqual({
			toolCalls: [{ id: "web_search_0", name: "web_search", state: "output-available" }],
		});
	});

	it("exposes live tool_calls as input-available before citations arrive", () => {
		const acc = createSearchAccumulator();
		ingestOpenRouterPayload(acc, fixture("search-luna.json"));
		expect(snapshotSearchMeta(acc)).toEqual({
			toolCalls: [
				{
					id: "call_luna_1",
					name: "web_search",
					query: "US Open winner today",
					state: "input-available",
				},
			],
		});
		ingestOpenRouterPayload(acc, {
			choices: [{ delta: { annotations: [{ url: "https://www.example.com/luna", title: "Luna" }] } }],
		});
		expect(snapshotSearchMeta(acc)).toEqual({
			citations: [{ url: "https://www.example.com/luna", title: "Luna" }],
			toolCalls: [
				{
					id: "call_luna_1",
					name: "web_search",
					query: "US Open winner today",
					state: "output-available",
				},
			],
		});
	});

	it("extracts a query from partial streamed arguments", () => {
		const acc = createSearchAccumulator();
		ingestOpenRouterPayload(acc, {
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								function: { name: "web_search", arguments: '{"query":"us op' },
							},
						],
					},
				},
			],
		});
		expect(snapshotSearchMeta(acc)).toEqual({
			toolCalls: [
				{ id: "call_1", name: "web_search", query: "us op", state: "input-available" },
			],
		});
	});

	it("does not invent a live search from an empty accumulator", () => {
		expect(snapshotSearchMeta(createSearchAccumulator())).toBeUndefined();
	});

	it("namespaces the synthesized chip as web_search_0", () => {
		const acc = createSearchAccumulator();
		ingestOpenRouterPayload(acc, {
			usage: { server_tool_use: { web_search_requests: 1 } },
		});
		expect(finalizeSearchMeta(acc).toolCalls).toEqual([
			{ id: "web_search_0", name: "web_search", state: "output-available" },
		]);
		expect(finalizeSearchMeta(acc).toolCalls).toEqual(finalizeSearchMeta(acc).toolCalls);
	});

	it("merges index-less tool_calls into slot 0", () => {
		const acc = createSearchAccumulator();
		ingestOpenRouterPayload(acc, {
			choices: [
				{
					delta: {
						tool_calls: [{ id: "call_1", function: { name: "web_search", arguments: '{"query":"' } }],
					},
				},
			],
		});
		ingestOpenRouterPayload(acc, {
			choices: [
				{
					delta: {
						tool_calls: [{ function: { arguments: 'US Open"}' } }],
					},
				},
			],
		});
		expect(snapshotSearchMeta(acc)).toEqual({
			toolCalls: [
				{ id: "call_1", name: "web_search", query: "US Open", state: "input-available" },
			],
		});
	});

	it("parses streamed Luna tool_calls by index for the query", () => {
		const acc = createSearchAccumulator();
		ingestOpenRouterPayload(acc, fixture("search-luna.json"));
		ingestOpenRouterPayload(acc, {
			choices: [{ delta: { annotations: [{ url: "https://www.example.com/luna", title: "Luna" }] } }],
			usage: { server_tool_use: { web_search_requests: 1 } },
		});
		expect(finalizeSearchMeta(acc)).toEqual({
			citations: [{ url: "https://www.example.com/luna", title: "Luna" }],
			toolCalls: [
				{
					id: "call_luna_1",
					name: "web_search",
					query: "US Open winner today",
					state: "output-available",
				},
			],
		});
	});
});

describe("storedSearchJson", () => {
	it("treats missing as omit and empty as NULL", () => {
		expect(storedSearchJson(undefined)).toBeUndefined();
		expect(storedSearchJson([])).toBeNull();
		expect(storedSearchJson([{ url: "https://www.example.com" }])).toBe(
			'[{"url":"https://www.example.com"}]',
		);
	});
});
