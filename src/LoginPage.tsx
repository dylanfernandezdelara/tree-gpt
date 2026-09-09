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
		// Phones: a short mark-grid hero on top with the logo over it, then the
		// form. Desktop: logo + form in the left column, the tall grid on the
		// right. One grid, one logo; only the cell placement changes.
		<div className="grid min-h-full grid-cols-1 grid-rows-[9rem_minmax(0,1fr)] lg:grid-cols-2 lg:grid-rows-[auto_minmax(0,1fr)]">
			<div className="relative col-start-1 row-start-1 min-h-0 overflow-hidden lg:col-start-2 lg:row-span-2 lg:row-start-1">
				<div className="lg:hidden">
					<ForkMarkGrid variant="strip" />
				</div>
				<div className="hidden lg:block">
					<ForkMarkGrid variant="cover" />
				</div>
			</div>
			<div className="z-10 col-start-1 row-start-1 flex items-center justify-center self-stretch lg:items-start lg:justify-start lg:self-start lg:p-10 lg:pb-4">
				<a
					href="/"
					className="flex items-center gap-2 rounded-full bg-[#0c1626] px-4 py-2 text-base font-semibold tracking-tight text-white ring-1 ring-white/15 outline-none focus-visible:ring-2 focus-visible:ring-[#3a83f7] lg:rounded-md lg:bg-transparent lg:px-0 lg:py-0 lg:text-foreground lg:ring-0 lg:focus-visible:ring-2 lg:focus-visible:ring-offset-2"
				>
					<TreeIcon size={22} className="text-[#3a83f7]" />
					Fork
				</a>
			</div>
			<div className="col-start-1 row-start-2 flex min-h-0 items-center justify-center px-6 pt-6 pb-[12svh] md:px-10 md:pt-10 lg:pt-0 lg:pb-10">
				<div className="w-full max-w-xs">{children}</div>
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
