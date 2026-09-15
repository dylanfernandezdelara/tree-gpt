/**
 * A transcript's place in a pane. Fork splits the layout and remounts the
 * source pane; this is how that pane sits still instead of jumping to the
 * newest turn.
 */
export type ThreadViewSnapshot = {
	scrollTop: number;
	quote?: { messageId: string; quote: string };
};

const views = new Map<string, ThreadViewSnapshot>();

/** Merge a snapshot for `paneId`. Scroll and quote are remembered separately so a remount cannot drop one. */
export function rememberThreadView(paneId: string, patch: Partial<ThreadViewSnapshot>): void {
	const prev = views.get(paneId);
	views.set(paneId, {
		scrollTop: patch.scrollTop ?? prev?.scrollTop ?? 0,
		quote: patch.quote !== undefined ? patch.quote : prev?.quote,
	});
}

/** Take the snapshot so a new fork pane (different id) cannot inherit it. */
export function takeThreadView(paneId: string): ThreadViewSnapshot | undefined {
	const saved = views.get(paneId);
	if (saved) {
		views.delete(paneId);
	}
	return saved;
}

export function clampScrollTop(
	scrollTop: number,
	scrollHeight: number,
	clientHeight: number,
): number {
	const max = Math.max(0, scrollHeight - clientHeight);
	return Math.min(Math.max(0, scrollTop), max);
}

/**
 * Where a thread should sit after mount. A remembered source view wins so
 * Fork does not jump the original conversation to the bottom; a pane with
 * no snapshot still opens on the newest turn.
 */
export function scrollTopForMount(
	saved: ThreadViewSnapshot | undefined,
	scrollHeight: number,
	clientHeight: number,
): number {
	if (saved) {
		return clampScrollTop(saved.scrollTop, scrollHeight, clientHeight);
	}
	return scrollHeight;
}

/** Test helper: snapshots leak across cases otherwise. */
export function clearThreadViews(): void {
	views.clear();
}
