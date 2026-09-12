import type { RefObject } from "react";
import type { AuthUser } from "../lib/auth-client";
import { useHideOnScroll } from "../lib/use-hide-on-scroll";
import { ComposeIcon, SidebarIcon } from "./Icons";
import { Button } from "./ui/button";
import { UserMenu } from "./UserMenu";

type Props = {
	scrollRoot: RefObject<HTMLElement | null>;
	onOpenSidebar: () => void;
	onNewChat: () => void;
	user: AuthUser;
	onLogOut: () => void;
};

/**
 * Conversation chrome: sidebar, new chat, account. Mounted only while the
 * sidebar is away, so hide-on-scroll starts fresh each time it appears.
 */
export function MainHeader({ scrollRoot, onOpenSidebar, onNewChat, user, onLogOut }: Props) {
	const hidden = useHideOnScroll(scrollRoot);
	return (
		<header
			className={`main__header${hidden ? " main__header--hidden" : ""}`}
			inert={hidden}
		>
			<Button
				variant="secondary"
				size="icon-lg"
				className="rounded-full shadow-sm transition-transform duration-150 active:scale-95 max-[768px]:size-12"
				aria-label="Open sidebar"
				title="Open sidebar"
				onClick={onOpenSidebar}
			>
				<SidebarIcon className="size-5" />
			</Button>
			<Button
				variant="secondary"
				size="icon-lg"
				className="rounded-[14px] shadow-sm transition-transform duration-150 active:scale-95 max-[768px]:size-12 max-[768px]:order-2"
				aria-label="New chat"
				title="New chat"
				onClick={onNewChat}
			>
				<ComposeIcon className="size-5" />
			</Button>
			<div className="main__header-spacer" />
			<UserMenu user={user} placement="down" compact onLogOut={onLogOut} />
		</header>
	);
}
