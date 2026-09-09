import { useState, type ReactNode } from "react";

import { ForkMarkGrid } from "@/components/ForkMarkGrid";
import { TreeIcon } from "@/components/Icons";
import { SocialLoginButton } from "@/components/SocialLoginButton";
import { authClient } from "./auth-client";

type LoginProvider = "github" | "google";

export function LoginPage() {
	return (
		<LoginChrome>
			<LoginForm />
		</LoginChrome>
	);
}

export function LoginPending() {
	return (
		<LoginChrome>
			<p className="text-center text-sm text-muted-foreground">Checking…</p>
		</LoginChrome>
	);
}

function LoginChrome({ children }: { children: ReactNode }) {
	return (
		<div className="grid min-h-full grid-rows-[minmax(0,1fr)_min(36svh,280px)] lg:grid-cols-2 lg:grid-rows-none">
			<div className="flex min-h-0 flex-col gap-4 p-6 md:p-10">
				<div className="flex justify-center md:justify-start">
					<a
						href="/"
						className="flex items-center gap-2 rounded-md text-base font-semibold tracking-tight text-foreground outline-none focus-visible:ring-2 focus-visible:ring-[#3a83f7] focus-visible:ring-offset-2"
					>
						<TreeIcon size={22} className="text-[#3a83f7]" />
						Fork
					</a>
				</div>
				<div className="flex flex-1 items-center justify-center">
					<div className="w-full max-w-xs">{children}</div>
				</div>
			</div>
			<div className="relative min-h-0 overflow-hidden">
				<ForkMarkGrid />
			</div>
		</div>
	);
}

const buttonClassName = "login-provider w-full text-foreground focus-visible:ring-[#3a83f7]";

function LoginForm() {
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<LoginProvider | null>(null);

	async function signIn(provider: LoginProvider) {
		setError(null);
		setBusy(provider);
		try {
			const { error: nextError } = await authClient.signIn.social({
				provider,
				callbackURL: "/",
			});
			if (nextError) {
				setError(nextError.message ?? `${provider} sign-in failed`);
			}
		} catch {
			setError(`${provider} sign-in failed`);
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col items-center gap-2 text-center">
				<h1 className="text-[28px] leading-none font-medium tracking-[-0.02em]">
					Log in
				</h1>
				<p className="text-sm text-muted-foreground">A chat you can fork.</p>
			</div>
			<div className="grid gap-3">
				<SocialLoginButton
					provider="github"
					label="GitHub"
					className={buttonClassName}
					loading={busy === "github"}
					disabled={busy !== null}
					onClick={() => void signIn("github")}
				/>
				<SocialLoginButton
					provider="google"
					label="Google"
					className={buttonClassName}
					loading={busy === "google"}
					disabled={busy !== null}
					onClick={() => void signIn("google")}
				/>
			</div>
			{error ? (
				<p role="alert" className="text-center text-sm text-destructive">
					{error}
				</p>
			) : null}
		</div>
	);
}
