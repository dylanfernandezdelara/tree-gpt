import { useEffect, useState, type FormEvent } from "react";
import { authClient } from "../lib/auth-client";
import { IconButton } from "./IconButton";
import { CloseIcon, GitHubIcon, PasskeyIcon } from "./Icons";

export type AuthMode = "login" | "signup";

type Props = {
	mode: AuthMode;
	onModeChange: (mode: AuthMode) => void;
	onClose: () => void;
	onSuccess: () => void;
};

const MIN_PASSWORD = 8;
const GENERIC_ERROR = "Something went wrong. Please try again.";
const NETWORK_ERROR = "Couldn't reach the server. Please try again.";
const UNAVAILABLE_ERROR = "Sign-in isn't available yet: the auth server isn't set up.";

const passkeysSupported =
	typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";

export function AuthDialog({ mode, onModeChange, onClose, onSuccess }: Props) {
	const { refetch } = authClient.useSession();
	const [step, setStep] = useState<"email" | "password">("email");
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				onClose();
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	function switchMode(next: AuthMode) {
		setError(null);
		setPassword("");
		setStep("email");
		onModeChange(next);
	}

	/** Run an auth call, surface its error, and report whether it succeeded. */
	async function attempt(
		action: () => Promise<{ error?: { message?: string } | null } | undefined>,
		fallback: string,
	): Promise<boolean> {
		if (busy) {
			return false;
		}
		setError(null);
		setBusy(true);
		try {
			const result = await action();
			if (result?.error) {
				setError(result.error.message || fallback);
				return false;
			}
			return true;
		} catch {
			setError(NETWORK_ERROR);
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function finishSignIn() {
		await refetch();
		onSuccess();
	}

	async function continueWithGitHub() {
		// On success the browser leaves for GitHub and comes back signed in.
		await attempt(
			() => authClient.signIn.social({ provider: "github", callbackURL: "/" }),
			"GitHub sign-in failed.",
		);
	}

	async function signInWithPasskey() {
		const ok = await attempt(() => authClient.signIn.passkey(), "Passkey sign-in failed.");
		if (ok) {
			await finishSignIn();
		}
	}

	function submitEmail(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = email.trim();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
			setError("Enter a valid email address.");
			return;
		}
		setEmail(value);
		setError(null);
		setStep("password");
	}

	async function submitPassword(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (mode === "signup" && !name.trim()) {
			setError("Enter your name.");
			return;
		}
		if (password.length < MIN_PASSWORD) {
			setError(`Password must be at least ${MIN_PASSWORD} characters.`);
			return;
		}
		let signedIn = false;
		const ok = await attempt(async () => {
			const result =
				mode === "login"
					? await authClient.signIn.email({ email, password })
					: await authClient.signUp.email({ email, password, name: name.trim() });
			signedIn = Boolean(result.data?.user);
			return result;
		}, GENERIC_ERROR);
		if (!ok) {
			return;
		}
		if (!signedIn) {
			setError(UNAVAILABLE_ERROR);
			return;
		}
		await finishSignIn();
	}

	const title =
		step === "email"
			? mode === "login"
				? "Welcome back"
				: "Create an account"
			: mode === "login"
				? "Enter your password"
				: "Set up your account";

	return (
		<div
			className="auth-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) {
					onClose();
				}
			}}
		>
			<div className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
				<IconButton label="Close" className="auth-dialog__close" onClick={onClose}>
					<CloseIcon />
				</IconButton>
				<div className="auth-dialog__brand">treeGPT</div>
				<h2 id="auth-title" className="auth-dialog__title">
					{title}
				</h2>

				{step === "email" ? (
					<>
						<form className="auth-form" onSubmit={submitEmail} noValidate>
							<label className="visually-hidden" htmlFor="auth-email">
								Email address
							</label>
							<input
								id="auth-email"
								className="auth-field"
								type="email"
								autoComplete="email"
								placeholder="Email address"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								autoFocus
							/>
							{error ? <p className="auth-error">{error}</p> : null}
							<button
								type="submit"
								className="pill-button pill-button--primary auth-submit"
								disabled={busy}
							>
								Continue
							</button>
						</form>
						<div className="auth-divider">
							<span>OR</span>
						</div>
						<div className="auth-providers">
							<button
								type="button"
								className="pill-button pill-button--secondary auth-provider"
								disabled={busy}
								onClick={continueWithGitHub}
							>
								<GitHubIcon />
								Continue with GitHub
							</button>
							{mode === "login" && passkeysSupported ? (
								<button
									type="button"
									className="pill-button pill-button--secondary auth-provider"
									disabled={busy}
									onClick={signInWithPasskey}
								>
									<PasskeyIcon />
									Sign in with a passkey
								</button>
							) : null}
						</div>
					</>
				) : (
					<form className="auth-form" onSubmit={submitPassword} noValidate>
						<div className="auth-email">
							<span className="auth-email__value">{email}</span>
							<button
								type="button"
								className="auth-link"
								onClick={() => {
									setError(null);
									setStep("email");
								}}
							>
								Edit
							</button>
						</div>
						{mode === "signup" ? (
							<>
								<label className="visually-hidden" htmlFor="auth-name">
									Full name
								</label>
								<input
									id="auth-name"
									className="auth-field"
									type="text"
									autoComplete="name"
									placeholder="Full name"
									value={name}
									onChange={(event) => setName(event.target.value)}
									autoFocus
								/>
							</>
						) : null}
						<label className="visually-hidden" htmlFor="auth-password">
							Password
						</label>
						<input
							id="auth-password"
							className="auth-field"
							type="password"
							autoComplete={mode === "login" ? "current-password" : "new-password"}
							placeholder="Password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							autoFocus={mode === "login"}
						/>
						{mode === "signup" ? (
							<p className="auth-hint">Use at least {MIN_PASSWORD} characters.</p>
						) : null}
						{error ? <p className="auth-error">{error}</p> : null}
						<button
							type="submit"
							className="pill-button pill-button--primary auth-submit"
							disabled={busy}
						>
							{busy ? "Continuing…" : "Continue"}
						</button>
					</form>
				)}

				<p className="auth-switch">
					{mode === "login" ? (
						<>
							Don't have an account?{" "}
							<button type="button" className="auth-link" onClick={() => switchMode("signup")}>
								Sign up
							</button>
						</>
					) : (
						<>
							Already have an account?{" "}
							<button type="button" className="auth-link" onClick={() => switchMode("login")}>
								Log in
							</button>
						</>
					)}
				</p>
			</div>
		</div>
	);
}
