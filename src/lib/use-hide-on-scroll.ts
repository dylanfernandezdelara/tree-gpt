import { useEffect, useState, type RefObject } from "react";
import { isScrollSurface, mobileChromeQuery, nextChromeHidden } from "./hide-on-scroll";

/**
 * Hide mobile header chrome while the conversation (or bookmarks list)
 * scrolls down; show it again on scroll up. Desktop never hides.
 */
export function useHideOnScroll(root: RefObject<HTMLElement | null>, resetKey = false): boolean {
	const [hidden, setHidden] = useState(false);
	const [seenKey, setSeenKey] = useState(resetKey);
	if (seenKey !== resetKey) {
		setSeenKey(resetKey);
		setHidden(false);
	}

	useEffect(() => {
		const element = root.current;
		if (!element) {
			return;
		}
		const mq = window.matchMedia(mobileChromeQuery());
		let lastTarget: EventTarget | null = null;
		let lastY = 0;
		let hiddenNow = false;

		function apply(next: boolean) {
			if (next === hiddenNow) {
				return;
			}
			hiddenNow = next;
			setHidden(next);
		}

		function onScroll(event: Event) {
			if (!isScrollSurface(event.target)) {
				return;
			}
			const y = event.target.scrollTop;
			if (event.target !== lastTarget) {
				lastTarget = event.target;
				lastY = y;
				apply(false);
				return;
			}
			const next = nextChromeHidden({
				hidden: hiddenNow,
				y,
				lastY,
				mobile: mq.matches,
			});
			lastY = y;
			apply(next);
		}

		function onMq() {
			if (!mq.matches) {
				apply(false);
			}
		}

		element.addEventListener("scroll", onScroll, { capture: true, passive: true });
		mq.addEventListener("change", onMq);
		return () => {
			element.removeEventListener("scroll", onScroll, true);
			mq.removeEventListener("change", onMq);
		};
	}, [root, resetKey]);

	return hidden;
}
