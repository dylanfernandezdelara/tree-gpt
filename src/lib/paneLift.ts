/**
 * The imperative half of a pane move: lifting a section out of its slot is
 * plain DOM work (no renders per move), shared here so components stay
 * fast-refresh clean.
 *
 * Lifts are tracked in a registry, not by class: a re-render can rewrite a
 * section's className (a focus change does) while the inline geometry
 * survives, so the class alone cannot prove a pane landed.
 */
const lifted = new Set<HTMLElement>();
const settling = new WeakMap<HTMLElement, Animation>();

/** Mark a section lifted; call when a move passes its threshold. */
export function registerLift(section: HTMLElement) {
	lifted.add(section);
}

/** Land a move: a commit clears the lift at once, a cancel glides home first. */
export function settleMove(section: HTMLElement, commit: boolean) {
	if (commit) {
		clearLift(section);
		return;
	}
	const back = section.animate(
		[{ transform: section.style.transform }, { transform: "translate(0px, 0px)" }],
		{ duration: 180, easing: "ease-out" },
	);
	settling.set(section, back);
	back.onfinish = () => clearLift(section);
}

function clearLift(section: HTMLElement) {
	settling.get(section)?.cancel();
	settling.delete(section);
	lifted.delete(section);
	section.classList.remove("pane--moving");
	section.style.width = "";
	section.style.height = "";
	section.style.left = "";
	section.style.top = "";
	section.style.transform = "";
}

/**
 * Ground anything a previous gesture left lifted. Called when a move starts,
 * so one leaked session can never survive into the next drag.
 */
export function groundStrayPanes() {
	for (const section of lifted) {
		clearLift(section);
	}
	// Belt and suspenders: anything the registry missed that still reads lifted.
	for (const element of document.querySelectorAll(".pane--moving")) {
		clearLift(element as HTMLElement);
	}
}
