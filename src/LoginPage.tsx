import { useState } from "react";
import { authClient } from "./auth-client";
import { GitHubIcon } from "./components/Icons";

export function LoginPage() {
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function signInWithGitHub() {
		setError(null);
		setBusy(true);
		try {
			const { error: nextError } = await authClient.signIn.social({
				provider: "github",
				callbackURL: "/",
			});
			if (nextError) {
				setError(nextError.message ?? "GitHub sign-in failed");
			}
		} catch {
			setError("GitHub sign-in failed");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="login-page">
			<div className="auth-dialog">
				<div className="auth-dialog__brand">treeGPT</div>
				<h1 className="auth-dialog__title">Log in to treeGPT</h1>
				<p className="login-page__copy">
					Continue with your GitHub account to start chatting.
				</p>
				{error ? <p className="auth-error">{error}</p> : null}
				<button
					type="button"
					className="pill-button pill-button--secondary auth-provider"
					disabled={busy}
					onClick={() => void signInWithGitHub()}
				>
					<GitHubIcon />
					Continue with GitHub
				</button>
			</div>
		</div>
	);
}
