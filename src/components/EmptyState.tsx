import type { ReactNode } from "react";

export function EmptyState({ children }: { children: ReactNode }) {
	return (
		<div className="empty">
			<div className="empty__inner">
				<h1 className="empty__title">What’s on your mind today?</h1>
				{children}
			</div>
		</div>
	);
}
