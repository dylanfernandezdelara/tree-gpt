/** Must match `@media (max-width: 768px)` in `src/index.css`. */
export const MOBILE_CHROME_QUERY = "(max-width: 768px)";
/** Ignore tiny jitter from finger noise. */
const DELTA = 8;
/** Always show chrome when the reader is at the top. */
const TOP = 16;
/** Jumps this large are programmatic (open chat, stick-to-bottom), not a swipe. */
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
	mobile: boolean;
}): boolean {
	if (!args.mobile) {
		return false;
	}
	const dy = args.y - args.lastY;
	if (Math.abs(dy) > PROGRAMMATIC) {
		return args.hidden;
	}
	if (args.y <= TOP) {
		return false;
	}
	if (dy > DELTA) {
		return true;
	}
	if (dy < -DELTA) {
		return false;
	}
	return args.hidden;
}
