/**
 * The Better Auth session cookie is HttpOnly, so the first paint cannot tell
 * signed-in from signed-out. This is a non-secret local cache so returning
 * visitors can paint the app (and only they wait on get-session).
 *
 * `oauthRedirect` stays in memory: it must reset on a full load so a cancelled
 * OAuth can still clear the hint. Do not persist it.
 */

const HINT_KEY = "fork.signed-in";
const USER_KEY = "fork.session-user";

/** True while social sign-in may still navigate away; do not clear the hint. */
let oauthRedirect = false;
/** True after logout starts; do not rewrite the hint from a stale session. */
let signingOut = false;

export type SessionUserSnapshot = {
	id: string;
	name: string;
	email: string;
	image?: string | null;
};

function readHint(): boolean {
	try {
		return globalThis.localStorage.getItem(HINT_KEY) === "1";
	} catch {
		return false;
	}
}

function writeHint(on: boolean): void {
	try {
		if (on) {
			globalThis.localStorage.setItem(HINT_KEY, "1");
		} else {
			globalThis.localStorage.removeItem(HINT_KEY);
		}
	} catch {
		// Private mode / quota.
	}
}

function writeUser(user: SessionUserSnapshot | null): void {
	try {
		if (user) {
			globalThis.localStorage.setItem(
				USER_KEY,
				JSON.stringify({
					id: user.id,
					name: user.name,
					email: user.email,
					image: user.image ?? null,
				}),
			);
		} else {
			globalThis.localStorage.removeItem(USER_KEY);
		}
	} catch {
		// Private mode / quota.
	}
}

function parseUser(raw: unknown): SessionUserSnapshot | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const u = raw as Record<string, unknown>;
	if (typeof u.id !== "string" || typeof u.email !== "string") {
		return null;
	}
	if (!u.id || !u.email) {
		return null;
	}
	return {
		id: u.id,
		name: typeof u.name === "string" && u.name.trim() ? u.name : u.email,
		email: u.email,
		image: typeof u.image === "string" ? u.image : null,
	};
}

export function hasSessionHint(): boolean {
	return readHint();
}

/** Last signed-in profile. Ignored unless {@link hasSessionHint} is also set. */
export function readCachedUser(): SessionUserSnapshot | null {
	try {
		const raw = globalThis.localStorage.getItem(USER_KEY);
		if (!raw) {
			return null;
		}
		return parseUser(JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

export function markOAuthRedirect(): void {
	oauthRedirect = true;
	signingOut = false;
	writeHint(true);
}

export function clearSessionHint(): void {
	oauthRedirect = false;
	writeHint(false);
	writeUser(null);
}

export function beginSignOut(): void {
	signingOut = true;
	clearSessionHint();
}

export function cancelSignOut(): void {
	signingOut = false;
}

/** Persist the resolved session. Skips a clear that would race an OAuth redirect. */
export function syncSessionHint(user: SessionUserSnapshot | null): void {
	if (user) {
		if (signingOut) {
			return;
		}
		oauthRedirect = false;
		writeHint(true);
		writeUser(user);
		return;
	}
	signingOut = false;
	if (oauthRedirect) {
		return;
	}
	writeHint(false);
	writeUser(null);
}
