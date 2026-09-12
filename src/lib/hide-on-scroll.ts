/** Must match `@media (max-width: 768px)` in `src/index.css`. */
export const MOBILE_CHROME_QUERY = "(max-width: 768px)";
/** Ignore tiny jitter from finger noise. */
const DELTA = 8;
/** Always show chrome when the reader is at the top. */
const TOP = 16;
/** Same band ChatThread uses for "still at the bottom". */
const BOTTOM = 24;
/** Jumps this large are open-chat / jump-to-quote, not a swipe or a new bubble. */
const PROGRAMMATIC = 400;

export function isScrollSurface(target: EventTarget | null): target is HTMLElement {
	return (
		target instanceof HTMLElement &&
		(target.classList.contains("thread") || target.classList.contains("bookmarks__list"))
	);
}

export function nextChromeHidden(args: {
	hidden: boolean;
	y: number;
	lastY: number;
	/** scrollHeight - clientHeight; stick-to-bottom lands here. */
	maxY: number;
	mobile: boolean;
}): boolean {
	if (!args.mobile) {
		return false;
	}
	if (args.y <= TOP) {
		return false;
	}
	const dy = args.y - args.lastY;
	if (Math.abs(dy) > PROGRAMMATIC) {
		return args.hidden;
	}
	if (dy < -DELTA) {
		return false;
	}
	if (dy > DELTA) {
		// A new bubble (or composer resize) sticks to the bottom with a small
		// downward jump. That is not a swipe; leave chrome as it is.
		if (args.y >= args.maxY - BOTTOM) {
			return args.hidden;
		}
		return true;
	}
	return args.hidden;
}
