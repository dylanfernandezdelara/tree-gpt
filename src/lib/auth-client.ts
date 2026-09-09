import { useEffect } from "react";

import { authClient } from "../auth-client";
import { beginSignOut, cancelSignOut, hasSessionHint, syncSessionHint } from "./session-hint";

/**
 * Helpers around the shared Better Auth client (`src/auth-client.ts`).
 * It talks to /api/auth/* on the Worker.
 */
export { authClient };

export type AuthUser = {
	id: string;
	name: string;
	email: string;
	image?: string | null;
};

/**
 * Extract the signed-in user from a session response. Validates the shape at
 * runtime because the Worker's /api/* stub answers `{ ok: true }` for any
 * path until the auth handler exists; that must read as "signed out".
 */
export function sessionUser(session: unknown): AuthUser | null {
	if (typeof session !== "object" || session === null || !("user" in session)) {
		return null;
	}
	const user = session.user;
	if (typeof user !== "object" || user === null) {
		return null;
	}
	const u = user as Record<string, unknown>;
	if (typeof u.id !== "string" || typeof u.email !== "string") {
		return null;
	}
	return {
		id: u.id,
		name: typeof u.name === "string" && u.name.trim() ? u.name : u.email,
		email: u.email,
		image: typeof u.image === "string" ? u.image : null,
	};
}

/**
 * Session plus the signed-out first-paint gate. Wait only when a previous
 * visit recorded that a cookie should exist.
 */
export function useSignedInUser(): { user: AuthUser | null; waitForSession: boolean } {
	const session = authClient.useSession();
	const user = sessionUser(session.data);

	useEffect(() => {
		if (session.isPending) {
			return;
		}
		syncSessionHint(user !== null);
	}, [session.isPending, user]);

	return {
		user,
		waitForSession: !user && session.isPending && hasSessionHint(),
	};
}

export async function signOut(): Promise<void> {
	beginSignOut();
	try {
		await authClient.signOut();
	} catch (error) {
		cancelSignOut();
		throw error;
	}
}

const AVATAR_COLORS = ["#5fb3a1", "#7c8cf8", "#e6a23c", "#d47bb0", "#6bb1e6", "#8fbf60"];

export function avatarColor(seed: string): string {
	let hash = 0;
	for (const char of seed) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function initials(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) {
		return "?";
	}
	return trimmed.slice(0, 2).toUpperCase();
}
