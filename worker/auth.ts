import { betterAuth } from "better-auth";

/**
 * Cloudflare routes by Host, so the Worker only ever sees hostnames that are
 * attached to it (forkgpt.app, workers.dev, previews). Each one is its own
 * Better Auth origin; www is redirected to the apex at the zone edge.
 */
export function createAuth(env: Env, request: Request) {
	const origin = new URL(request.url).origin;

	return betterAuth({
		database: env.DB,
		secret: env.BETTER_AUTH_SECRET,
		baseURL: origin,
		trustedOrigins: [origin],
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
