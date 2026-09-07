import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: the Cloudflare Vite plugin is incompatible
// with Vitest's server, and worker unit tests need plain Node resolution.
export default defineConfig({
	test: {
		include: ["worker/**/*.test.ts", "src/**/*.test.ts"],
		environment: "node",
	},
});
