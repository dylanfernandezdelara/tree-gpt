/**
 * How many visual pixels one CSS pixel covers, for an element under the root
 * zoom (`--ui-scale`).
 *
 * `getBoundingClientRect`, `clientX` and friends report VISUAL pixels, which
 * the zoom has already scaled. Inline `left`/`top`/`width` are plain CSS
 * pixels, which it has not. Anything that measures with the first and writes
 * the second has to divide by this, or it lands short by the zoom factor.
 *
 * Measured rather than read from the token, so it stays correct if the scale
 * changes or a subtree is zoomed on its own.
 */
export function visualScale(element: HTMLElement): number {
	const css = element.offsetWidth;
	if (css <= 0) {
		return 1;
	}
	const visual = element.getBoundingClientRect().width;
	return visual > 0 ? visual / css : 1;
}
