/**
 * The Better Auth session cookie is HttpOnly, so the first paint cannot tell
 * signed-in from signed-out. Waiting on /api/auth/get-session hid the login
 * form behind "Checking…" for every visitor. This hint is a non-secret flag
 * we write after a real session result (or when OAuth is about to redirect)
 * so only people who should already have a cookie wait on that round trip.
 */

const KEY = "fork.signed-in";

/** True while social sign-in may still navigate away; do not clear the hint. */
let oauthRedirect = false;

type StorageLike = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

function storage(): StorageLike | null {
	try {
		const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
		return candidate ?? null;
	} catch {
		return null;
	}
}

export function hasSessionHint(): boolean {
	const store = storage();
	if (!store) {
		return false;
	}
	try {
		return store.getItem(KEY) === "1";
	} catch {
		return false;
	}
}

export function writeSessionHint(signedIn: boolean): void {
	const store = storage();
	if (!store) {
		return;
	}
	try {
		if (signedIn) {
			store.setItem(KEY, "1");
		} else {
			store.removeItem(KEY);
		}
	} catch {
		// Private mode can throw on write.
	}
}

/** First paint of a signed-out screen: wait only when a session is expected. */
export function showSessionPending(isPending: boolean, expectSession: boolean): boolean {
	return isPending && expectSession;
}

export function markOAuthRedirect(): void {
	oauthRedirect = true;
	writeSessionHint(true);
}

export function clearSessionHint(): void {
	oauthRedirect = false;
	writeSessionHint(false);
}

/** Persist the resolved session. Skips a clear that would race an OAuth redirect. */
export function syncSessionHint(signedIn: boolean): void {
	if (signedIn) {
		oauthRedirect = false;
		writeSessionHint(true);
		return;
	}
	if (oauthRedirect) {
		return;
	}
	writeSessionHint(false);
}
