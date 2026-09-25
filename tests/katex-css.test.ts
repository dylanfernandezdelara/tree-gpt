import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("KaTeX CSS", () => {
	// Message.tsx imports katex's CSS from the top-level package, but the
	// markup comes from the katex rehype-katex resolves. KaTeX 0.18 renamed
	// its layout classes, so a mismatch silently breaks \neq and superscripts.
	it("comes from the same katex that rehype-katex renders with", () => {
		const fromApp = createRequire(resolve(root, "package.json")).resolve("katex/package.json");
		const fromRehype = createRequire(resolve(root, "node_modules/rehype-katex/package.json")).resolve(
			"katex/package.json",
		);
		expect(fromRehype).toBe(fromApp);
	});
});
