/**
 * The Better Auth session cookie is HttpOnly, so the first paint cannot tell
 * signed-in from signed-out. This is a non-secret localStorage flag so only
 * people who should already have a cookie wait on get-session.
 *
 * `oauthRedirect` stays in memory: it must reset on a full load so a cancelled
 * OAuth can still clear the hint. Do not persist it.
 */

const KEY = "fork.signed-in";

/** True while social sign-in may still navigate away; do not clear the hint. */
let oauthRedirect = false;
/** True after logout starts; do not rewrite the hint from a stale session. */
let signingOut = false;

function read(): boolean {
	try {
		return globalThis.localStorage.getItem(KEY) === "1";
	} catch {
		return false;
	}
}

function write(on: boolean): void {
	try {
		if (on) {
			globalThis.localStorage.setItem(KEY, "1");
		} else {
			globalThis.localStorage.removeItem(KEY);
		}
	} catch {
		// Private mode / quota.
	}
}

export function hasSessionHint(): boolean {
	return read();
}

export function markOAuthRedirect(): void {
	oauthRedirect = true;
	signingOut = false;
	write(true);
}

export function clearSessionHint(): void {
	oauthRedirect = false;
	write(false);
}

export function beginSignOut(): void {
	signingOut = true;
	clearSessionHint();
}

export function cancelSignOut(): void {
	signingOut = false;
}

/** Persist the resolved session. Skips a clear that would race an OAuth redirect. */
export function syncSessionHint(signedIn: boolean): void {
	if (signedIn) {
		if (signingOut) {
			return;
		}
		oauthRedirect = false;
		write(true);
		return;
	}
	signingOut = false;
	if (oauthRedirect) {
		return;
	}
	write(false);
}
