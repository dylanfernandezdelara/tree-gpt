import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MARK_PATHS = [
	"M4 4v9a2 2 0 0 0 2 2h3M4 8h5",
	"M11 6h5M11 15h5",
] as const;

describe("brand icons", () => {
	it("keeps the favicon and app icon on the TreeIcon mark", () => {
		const favicon = readFileSync(resolve(root, "public/favicon.svg"), "utf8");
		const appIcon = readFileSync(resolve(root, "public/icon.svg"), "utf8");
		const icons = readFileSync(resolve(root, "src/components/Icons.tsx"), "utf8");
		for (const d of MARK_PATHS) {
			expect(favicon).toContain(d);
			expect(appIcon).toContain(d);
			expect(icons).toContain(d);
		}
	});

	it("advertises the logo for tabs and the home screen", () => {
		const html = readFileSync(resolve(root, "index.html"), "utf8");
		expect(html).toContain('href="/favicon.svg"');
		expect(html).toContain('href="/favicon-32.png"');
		expect(html).toContain('rel="apple-touch-icon"');
		expect(html).toContain('href="/apple-touch-icon.png"');
		expect(html).toContain('href="/site.webmanifest"');
		expect(html).toContain('apple-mobile-web-app-title');

		const manifest: {
			name: string;
			icons: Array<{ src: string; sizes: string }>;
		} = JSON.parse(readFileSync(resolve(root, "public/site.webmanifest"), "utf8"));
		expect(manifest.name).toBe("Fork");
		expect(manifest.icons.some((icon) => icon.src === "/icon-192.png")).toBe(true);
		expect(manifest.icons.some((icon) => icon.src === "/icon-512.png" && icon.sizes === "512x512")).toBe(
			true,
		);
	});
});
