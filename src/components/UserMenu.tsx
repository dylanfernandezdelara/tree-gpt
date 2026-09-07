import { useEffect, useRef, useState } from "react";
import { authClient, avatarColor, initials, type AuthUser } from "../lib/auth-client";
import { LogOutIcon, PasskeyIcon } from "./Icons";

type Props = {
	user: AuthUser;
	/** Where the menu opens relative to the trigger. */
	placement: "up" | "down";
	/** Compact: avatar only (used in the header when the sidebar is closed). */
	compact?: boolean;
	onLogOut: () => void;
};

const passkeysSupported =
	typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";

export function UserMenu({ user, placement, compact = false, onLogOut }: Props) {
	const [open, setOpen] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		function onMouseDown(event: MouseEvent) {
			if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
				setOpen(false);
			}
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	async function addPasskey() {
		if (busy) {
			return;
		}
		setBusy(true);
		setNotice(null);
		try {
			const result = await authClient.passkey.addPasskey();
			setNotice(result?.error ? result.error.message || "Couldn't add a passkey." : "Passkey added.");
		} catch {
			setNotice("Couldn't add a passkey.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div ref={wrapRef} className="user-menu-wrap">
			<button
				type="button"
				className={`user-button${compact ? " user-button--compact" : ""}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={compact ? "Account menu" : undefined}
				title={compact ? user.name : undefined}
				onClick={() => {
					setNotice(null);
					setOpen((value) => !value);
				}}
			>
				<Avatar user={user} />
				{compact ? null : (
					<span className="user-button__text">
						<span className="user-button__name">{user.name}</span>
						<span className="user-button__plan">Free</span>
					</span>
				)}
			</button>
			{open ? (
				<div className={`user-menu user-menu--${placement}`} role="menu">
					<div className="user-menu__email">{user.email}</div>
					<div className="user-menu__divider" />
					{passkeysSupported ? (
						<button
							type="button"
							role="menuitem"
							className="user-menu__item"
							disabled={busy}
							onClick={addPasskey}
						>
							<PasskeyIcon />
							{busy ? "Adding passkey…" : "Add passkey"}
						</button>
					) : null}
					<button
						type="button"
						role="menuitem"
						className="user-menu__item"
						onClick={() => {
							setOpen(false);
							onLogOut();
						}}
					>
						<LogOutIcon />
						Log out
					</button>
					{notice ? <div className="user-menu__notice">{notice}</div> : null}
				</div>
			) : null}
		</div>
	);
}

function Avatar({ user }: { user: AuthUser }) {
	if (user.image) {
		return <img className="avatar" src={user.image} alt="" />;
	}
	return (
		<span className="avatar" style={{ background: avatarColor(user.email) }} aria-hidden="true">
			{initials(user.name)}
		</span>
	);
}
