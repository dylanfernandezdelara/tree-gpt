import type { ReactNode } from "react";
import { blurbFor } from "../lib/blurbs";

/** `paneId` fixes which blurb this window shows; see `blurbFor`. */
export function EmptyState({ paneId, children }: { paneId: string; children: ReactNode }) {
	const blurb = blurbFor(paneId);
	return (
		<div className="empty">
			<div className="empty__inner">
				<h1 className="empty__title">
					<blurb.Icon className="empty__icon" />
					{blurb.title}
				</h1>
				<p className="empty__blurb">{blurb.body}</p>
				{children}
			</div>
		</div>
	);
}
