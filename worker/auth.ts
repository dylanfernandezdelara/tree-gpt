import { betterAuth } from "better-auth";

export function createAuth(env: Env, request: Request) {
	const url = new URL(request.url);
	const origin = url.origin;

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
