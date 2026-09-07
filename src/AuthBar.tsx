import { useState } from "react";
import { authClient } from "./auth-client";

export function AuthBar() {
	const { data: session, isPending, refetch } = authClient.useSession();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function run(
		action: () => Promise<{ error?: { message?: string } | null }>,
		fallback: string,
	) {
		setError(null);
		setBusy(true);
		try {
			const { error: nextError } = await action();
			if (nextError) {
				setError(nextError.message ?? fallback);
				return;
			}
			await refetch();
		} catch {
			setError(fallback);
		} finally {
			setBusy(false);
		}
	}

	if (isPending) {
		return (
			<section>
				<p>Checking session…</p>
			</section>
		);
	}

	if (session) {
		return (
			<section>
				<p>
					Signed in as {session.user.email}
					{" · "}
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void run(() => authClient.passkey.addPasskey(), "Could not add a passkey")
						}
					>
						Add passkey
					</button>{" "}
					<button
						type="button"
						disabled={busy}
						onClick={() => void run(() => authClient.signOut(), "Sign out failed")}
					>
						Sign out
					</button>
				</p>
				{error ? <p>{error}</p> : null}
			</section>
		);
	}

	return (
		<section>
			<p>
				<button
					type="button"
					disabled={busy}
					onClick={() =>
						void run(
							() =>
								authClient.signIn.social({
									provider: "github",
									callbackURL: "/",
								}),
							"GitHub sign-in failed",
						)
					}
				>
					Sign in with GitHub
				</button>{" "}
				<button
					type="button"
					disabled={busy}
					onClick={() =>
						void run(() => authClient.signIn.passkey(), "Passkey sign-in failed")
					}
				>
					Use passkey
				</button>
			</p>
			{error ? <p>{error}</p> : null}
		</section>
	);
}
