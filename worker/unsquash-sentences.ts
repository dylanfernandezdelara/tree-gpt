/**
 * OpenRouter / Muse text often arrives with a broken sentence boundary:
 *
 * - smash: "games.Tomorrow" (no space after `.` / `!` / `?`)
 * - a single newline instead of a space: "games.\nTomorrow"
 * - a literal two-character `\n` after punct (JSON-ish model output)
 *
 * A single newline after a period is still a newline — remark-breaks then
 * paints `<br>`, so the UI shows the next sentence glued to the period.
 * Collapse that one break to a space. Blank lines (`\n\n`) stay paragraphs.
 * `**Title**\nBody` has no sentence punct before the break, so it stays
 * (see Message.tsx / remark-breaks).
 *
 * Only fire on a prose word smash: 2+ letters after a boundary, then punct,
 * then a sentence start (`Tomorrow`, `I `, `I'd`, `A `). Leaves `U.S.`,
 * `Ph.D`, `user.ID`, `foo.Bar()`, and query URLs alone.
 *
 * Inserts/collapses only at the punct — already-emitted prefixes stay a
 * prefix of the repaired string so the stream can slice deltas safely.
 */

const AFTER_PROSE = String.raw`(?<=(?:^|[\s"'“”])[A-Za-z]{2,})`;
const SENTENCE_START = String.raw`(?=[A-Z][a-z]+(?:[\s']|$)|I(?:[\s']|$)|A\s)`;

const LITERAL_NL = /(?<=[.!?])\\n/g;
const SENTENCE_NL = new RegExp(
	`${AFTER_PROSE}([.!?])\\r?\\n(?!\\r?\\n)${SENTENCE_START}`,
	"g",
);
const SMASH = new RegExp(`${AFTER_PROSE}([.!?])${SENTENCE_START}`, "g");

function repairProse(text: string): string {
	return text.replace(LITERAL_NL, "\n").replace(SENTENCE_NL, "$1 ").replace(SMASH, "$1 ");
}

export function unsquashSentences(text: string): string {
	// Leave fenced code alone — `games.\nTomorrow` and `foo.Bar` are real there.
	return text
		.split(/(```[\s\S]*?```)/g)
		.map((segment, index) => (index % 2 === 1 ? segment : repairProse(segment)))
		.join("");
}

/**
 * Stream assembler: hold a trailing newline after sentence punct (and a
 * trailing `\`) until the next chunk says whether it is a smash, a
 * paragraph, or a real line break. Concatenating push() + flush() equals
 * unsquashSentences of the raw text.
 */
export function createContentAssembler(): {
	push: (chunk: string) => string;
	flush: () => string;
} {
	let emitted = "";
	let held = "";

	function holdBackIndex(text: string): number {
		if (text.endsWith("\\")) {
			return text.length - 1;
		}
		const trailing = text.match(/[.!?](?:\r\n|\n|\r)+$/);
		if (trailing) {
			return text.length - trailing[0].length + 1;
		}
		return text.length;
	}

	return {
		push(chunk: string): string {
			const assembled = unsquashSentences(emitted + held + chunk);
			const holdFrom = holdBackIndex(assembled);
			const text = assembled.slice(emitted.length, holdFrom);
			held = assembled.slice(holdFrom);
			emitted = assembled.slice(0, holdFrom);
			return text;
		},
		flush(): string {
			const assembled = unsquashSentences(emitted + held);
			const text = assembled.slice(emitted.length);
			emitted = assembled;
			held = "";
			return text;
		},
	};
}
