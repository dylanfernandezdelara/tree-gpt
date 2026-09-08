import { betterAuth } from "better-auth";

export function createAuth(env: Env, request: Request) {
	const url = new URL(request.url);
	const origin = canonicalOrigin(env, url.origin);

	return betterAuth({
		database: env.DB,
		secret: env.BETTER_AUTH_SECRET,
		baseURL: origin,
		trustedOrigins: trustedOriginsFor(origin),
		emailAndPassword: {
			enabled: false,
		},
		socialProviders: {
			github: {
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET,
				// Sign-in only. Better Auth defaults also include `read:user`.
				disableDefaultScope: true,
				scope: ["user:email"],
			},
		},
		databaseHooks: {
			user: {
				create: {
					after: async (user) => {
						await syncDomainUser(env.DB, user);
					},
				},
				update: {
					after: async (user) => {
						await syncDomainUser(env.DB, user);
					},
				},
			},
		},
	});
}

export async function handleAuthRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return createAuth(env, request).handler(request);
}

export async function getSessionUser(
	request: Request,
	env: Env,
): Promise<{ id: string; email: string } | null> {
	const session = await createAuth(env, request).api.getSession({
		headers: request.headers,
	});
	const user = session?.user;
	if (!user?.id || !user.email) {
		return null;
	}
	return { id: user.id, email: user.email };
}

/**
 * Canonical app origin for Better Auth's baseURL/trustedOrigins. When
 * APP_ORIGIN is configured (production), Host-derived trust is replaced
 * with an explicit allowlist of one, so a request arriving on any other
 * hostname cannot widen what the session layer trusts. Unset (local dev):
 * the request origin, preserving current behavior. An unparseable value
 * falls back to the request origin rather than breaking auth.
 */
function canonicalOrigin(env: Env, requestOrigin: string): string {
	// APP_ORIGIN is an optional plaintext Worker variable, so it is read
	// defensively instead of added to the generated Env type.
	const raw = (env as unknown as { APP_ORIGIN?: unknown }).APP_ORIGIN;
	const configured = typeof raw === "string" ? raw.trim() : "";
	if (!configured) {
		return requestOrigin;
	}
	try {
		return new URL(configured).origin;
	} catch {
		return requestOrigin;
	}
}

/** Apex plus www (or vice versa) so either hostname can start a session. */
function trustedOriginsFor(origin: string): string[] {
	try {
		const url = new URL(origin);
		const host = url.hostname;
		const alt = host.startsWith("www.")
			? host.slice("www.".length)
			: `www.${host}`;
		return [url.origin, `${url.protocol}//${alt}`];
	} catch {
		return [origin];
	}
}

export async function ensureDomainUser(
	db: D1Database,
	user: { id: string; email: string },
): Promise<void> {
	await syncDomainUser(db, user);
}

async function syncDomainUser(
	db: D1Database,
	user: { id: string; email: string },
): Promise<void> {
	if (!user.email) {
		return;
	}

	await db
		.prepare(
			`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET email = excluded.email`,
		)
		.bind(user.id, user.email, Date.now())
		.run();
}
