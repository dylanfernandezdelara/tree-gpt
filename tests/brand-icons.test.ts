import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function treeIconPathData(iconsSource: string): string[] {
	const start = iconsSource.indexOf("export function TreeIcon");
	if (start < 0) {
		throw new Error("TreeIcon is missing");
	}
	const next = iconsSource.indexOf("\nexport function", start + 1);
	const block = iconsSource.slice(start, next === -1 ? undefined : next);
	const paths = [...block.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]);
	if (paths.length === 0) {
		throw new Error("TreeIcon has no path data");
	}
	return paths;
}

describe("brand icons", () => {
	it("ships a favicon.ico for Chrome's default probe", () => {
		expect(existsSync(resolve(root, "public/favicon.ico"))).toBe(true);
	});

	it("keeps the favicon and app icon on the TreeIcon mark", () => {
		const favicon = readFileSync(resolve(root, "public/favicon.svg"), "utf8");
		const appIcon = readFileSync(resolve(root, "public/icon.svg"), "utf8");
		const icons = readFileSync(resolve(root, "src/components/Icons.tsx"), "utf8");
		for (const d of treeIconPathData(icons)) {
			expect(favicon).toContain(d);
			expect(appIcon).toContain(d);
		}
	});

	it("advertises the logo for tabs and the home screen", () => {
		const html = readFileSync(resolve(root, "index.html"), "utf8");
		expect(html).toContain('href="/favicon.ico?v=2"');
		expect(html).toContain('href="/favicon.svg?v=2"');
		expect(html).toContain('href="/favicon-32.png?v=2"');
		expect(html).toContain('rel="apple-touch-icon"');
		expect(html).toContain('href="/apple-touch-icon.png?v=2"');
		expect(html).toContain('href="/site.webmanifest?v=2"');
		expect(html).toContain('apple-mobile-web-app-title');

		const manifest: {
			name: string;
			icons: Array<{ src: string; sizes: string }>;
		} = JSON.parse(readFileSync(resolve(root, "public/site.webmanifest"), "utf8"));
		expect(manifest.name).toBe("Fork");
		expect(manifest.icons.some((icon) => icon.src === "/icon-192.png?v=2")).toBe(true);
		expect(
			manifest.icons.some((icon) => icon.src === "/icon-512.png?v=2" && icon.sizes === "512x512"),
		).toBe(true);
	});
});
