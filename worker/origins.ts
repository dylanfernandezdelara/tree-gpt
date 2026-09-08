export type AuthOrigins = {
	baseURL: string;
	trustedOrigins: string[];
};

/**
 * Better Auth baseURL + trustedOrigins.
 *
 * `APP_ORIGIN` pins production (`https://forkgpt.app` in wrangler.jsonc).
 * Loopback and any other host (workers.dev, preview URLs) keep the request
 * origin so local `npm run dev` and branch previews still work.
 */
export function resolveAuthOrigins(env: Env, requestOrigin: string): AuthOrigins {
	const configured = parseOrigin(env.APP_ORIGIN);
	if (
		!configured ||
		isLoopbackOrigin(requestOrigin) ||
		requestOrigin !== configured
	) {
		return { baseURL: requestOrigin, trustedOrigins: [requestOrigin] };
	}
	return { baseURL: configured, trustedOrigins: [configured] };
}

/** `www.<apex>` → apex. Null if this request is already on the canonical host. */
export function redirectToAppOrigin(url: URL, env: Env): URL | null {
	const configured = parseOrigin(env.APP_ORIGIN);
	if (!configured) {
		return null;
	}
	const apex = new URL(configured);
	if (url.hostname !== `www.${apex.hostname}`) {
		return null;
	}
	const next = new URL(url.href);
	next.protocol = apex.protocol;
	next.host = apex.host;
	return next;
}

function parseOrigin(raw: string | undefined): string | null {
	const configured = raw?.trim() ?? "";
	if (!configured) {
		return null;
	}
	try {
		return new URL(configured).origin;
	} catch {
		return null;
	}
}

function isLoopbackOrigin(origin: string): boolean {
	try {
		const host = new URL(origin).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
	} catch {
		return false;
	}
}
