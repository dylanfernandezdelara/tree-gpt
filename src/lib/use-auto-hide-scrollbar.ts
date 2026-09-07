import { useEffect, type RefObject } from "react";

/** How long the bar lingers after the last scroll. */
const LINGER_MS = 900;

/**
 * Show a scroll region's bar only while it is being scrolled, the way the
 * platform overlay bar does — but without its widen-on-hover behaviour, which
 * is why these bars are styled by hand in the first place.
 *
 * `focused` guards the bar against scrolls the reader did not ask for. A split,
 * or coming back from the bookmarks screen, sends every pane back to the bottom
 * of its conversation at once; only the focused pane should answer that. Direct
 * input still reveals the bar wherever the pointer is, so an unfocused pane
 * scrolled with the wheel is not left without one.
 */
export function useAutoHideScrollbar(
	ref: RefObject<HTMLElement | null>,
	focused = true,
): void {
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		let timer = 0;
		// An arrow const, so the null check above narrows inside it.
		const show = () => {
			element.classList.add("is-scrolling");
			window.clearTimeout(timer);
			timer = window.setTimeout(() => element.classList.remove("is-scrolling"), LINGER_MS);
		};
		const onScroll = () => {
			if (focused) {
				show();
			}
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		element.addEventListener("wheel", show, { passive: true });
		element.addEventListener("touchmove", show, { passive: true });
		return () => {
			element.removeEventListener("scroll", onScroll);
			element.removeEventListener("wheel", show);
			element.removeEventListener("touchmove", show);
			window.clearTimeout(timer);
			element.classList.remove("is-scrolling");
		};
	}, [ref, focused]);
}
