/**
 * OpenRouter often joins the next sentence without a gap: smash
 * (`games.Tomorrow`), a single newline (`games.\nTomorrow`), or a literal
 * two-character `\n`. remark-breaks then paints `<br>`, so the period
 * looks glued to the next word.
 *
 * Walk prose only. Insert a space when sentence punct meets a sentence
 * start with no real gap. Do not rewrite code, paths, or identifiers.
 */

const SENTENCE_PUNCT = /[.!?…。！？]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const OPEN_QUOTE = /["“”«»‘’']/;

function isLineBreak(ch: string | undefined): boolean {
	return ch === "\n" || ch === "\r" || ch === "\u2028";
}

function isParagraphBreak(ch: string | undefined): boolean {
	return ch === "\u2029";
}

/** 2+ letter word before punct, not a digit / URL / email. `U.` and `1.` stay. */
function looksLikeSentenceEnd(out: string): boolean {
	const before = out.slice(0, -1).replace(/[.]{2,}$/u, "");
	if (/(?:https?:\/\/|www\.)\S*$/i.test(before) || /\S+@\S*$/.test(before)) {
		return false;
	}
	if (/\d$/u.test(before)) {
		return false;
	}
	const word = before.match(/\p{L}+$/u);
	return word !== null && word[0].length >= 2;
}

/** Left word is lowercase prose (`games`), not `React` / `Math`. */
function leftWordIsProse(out: string): boolean {
	const word = leftWord(out);
	return word.length > 0 && !UPPER.test(word);
}

function leftWord(out: string): string {
	const before = out.slice(0, -1).replace(/[.]{2,}$/u, "");
	return before.match(/[\p{L}'’]+$/u)?.[0] ?? "";
}

function skipOpenQuotes(text: string): string {
	let i = 0;
	while (i < text.length && OPEN_QUOTE.test(text[i] ?? "")) {
		i += 1;
	}
	return text.slice(i);
}

function firstSentenceWord(rest: string): string {
	return skipOpenQuotes(rest).match(/^\p{L}+(?:['’]\p{L}+)?/u)?.[0] ?? "";
}

/**
 * After a 2–4 letter lowercase token, only these still count as a
 * sentence (`yes.The`). Other PascalCase is `std.String` / `user.Name`.
 */
const SHORT_LEFT_STARTERS = new Set([
	"A",
	"An",
	"I",
	"It",
	"That",
	"The",
	"There",
	"They",
	"This",
	"Today",
	"Tomorrow",
	"Tonight",
	"We",
	"Yes",
]);

/** `std.String` / `user.Name` — short left + PascalCase that is not a sentence starter. */
function isDottedIdentifier(out: string, rest: string): boolean {
	const left = leftWord(out);
	if (left.length >= 5) {
		return false;
	}
	const next = firstSentenceWord(rest);
	const head = next.split(/['’]/u)[0] ?? next;
	if (SHORT_LEFT_STARTERS.has(next) || SHORT_LEFT_STARTERS.has(head)) {
		return false;
	}
	return /^\p{Lu}\p{Ll}+/u.test(next);
}

function isMarkdownBlockStart(rest: string): boolean {
	return /^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\||```)/u.test(rest);
}

/**
 * Next token reads as a new sentence, not `ID`, `Bar()`, or `OpenAI.com`.
 * Opening quotes are skipped so `said."The` counts. A following period is
 * fine (`Yes.`) unless another identifier component follows (`OpenAI.com`).
 */
function looksLikeSentenceStart(rest: string): boolean {
	const start = skipOpenQuotes(rest);
	const first = start[0];
	if (!first || !UPPER.test(first)) {
		return false;
	}
	const after = start.slice(1);
	const next = after[0] ?? "";
	if (/['’]/u.test(next)) {
		return true;
	}
	if (LOWER.test(next)) {
		const word = after.match(/^[\p{Ll}\p{M}'’]*/u)?.[0] ?? "";
		const trail = after.slice(word.length)[0] ?? "";
		if (trail === "(" || trail === "@") {
			return false;
		}
		if (trail === ".") {
			const afterDot = after.slice(word.length + 1)[0] ?? "";
			return !/[\p{L}\p{N}]/u.test(afterDot);
		}
		return true;
	}
	return /[IAO]/u.test(first) && (next === "" || /\s/u.test(next));
}

/** First token only — a later `@alice` must not suppress an earlier smash. */
function isIdentifierOrUrl(rest: string): boolean {
	const token = (skipOpenQuotes(rest).match(/^[^\s]+/u)?.[0] ?? "").replace(/[.!?,;:]+$/u, "");
	if (!token) {
		return false;
	}
	if (/^[\p{L}\p{N}_$]*\(/u.test(token)) {
		return true;
	}
	if (/^\p{Lu}{2}/u.test(token)) {
		return true;
	}
	if (token.includes("@")) {
		return true;
	}
	return /[\p{L}\p{N}]+\.[\p{L}\p{N}]/u.test(token);
}

function readBreak(text: string, index: number): { length: number; paragraph: boolean } | null {
	const ch = text[index];
	if (isParagraphBreak(ch)) {
		return { length: 1, paragraph: true };
	}
	if (text.startsWith("\\r\\n", index)) {
		const after = index + 4;
		return { length: 4, paragraph: followsBreak(text, after) };
	}
	if (text.startsWith("\\n", index) || text.startsWith("\\r", index)) {
		const after = index + 2;
		return { length: 2, paragraph: followsBreak(text, after) };
	}
	if (text.startsWith("\r\n", index)) {
		return { length: 2, paragraph: followsBreak(text, index + 2) };
	}
	if (isLineBreak(ch)) {
		return { length: 1, paragraph: followsBreak(text, index + 1) };
	}
	return null;
}

function followsBreak(text: string, index: number): boolean {
	return (
		isLineBreak(text[index]) ||
		isParagraphBreak(text[index]) ||
		text.startsWith("\\r\\n", index) ||
		text.startsWith("\\n", index) ||
		text.startsWith("\\r", index)
	);
}

function repairProse(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i] ?? "";
		out += ch;
		i += 1;
		if (!SENTENCE_PUNCT.test(ch)) {
			continue;
		}
		if (ch === ".") {
			while (text[i] === ".") {
				out += ".";
				i += 1;
			}
		}
		if (!looksLikeSentenceEnd(out)) {
			continue;
		}
		const brk = readBreak(text, i);
		if (brk?.paragraph) {
			continue;
		}
		const rest = text.slice(i + (brk?.length ?? 0));
		if (isMarkdownBlockStart(rest) || !looksLikeSentenceStart(rest) || isIdentifierOrUrl(rest)) {
			continue;
		}
		// No-gap smash: only after lowercase prose so React.Component stays.
		// A newline gap is the Muse sentence-break and is always a candidate.
		if (!brk && (!leftWordIsProse(out) || isDottedIdentifier(out, rest))) {
			continue;
		}
		if (brk) {
			i += brk.length;
		}
		out += " ";
	}
	return out;
}

/** Repair prose; leave closed *and* still-open fences / inline code alone. */
export function unsquashSentences(text: string): string {
	let result = "";
	let i = 0;
	while (i < text.length) {
		if (text.startsWith("```", i)) {
			const end = text.indexOf("```", i + 3);
			if (end === -1) {
				return result + text.slice(i);
			}
			result += text.slice(i, end + 3);
			i = end + 3;
			continue;
		}
		if (text[i] === "`") {
			const end = text.indexOf("`", i + 1);
			if (end === -1) {
				return result + text.slice(i);
			}
			result += text.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		const nextTick = text.indexOf("`", i);
		const chunk = nextTick === -1 ? text.slice(i) : text.slice(i, nextTick);
		result += repairProse(chunk);
		i = nextTick === -1 ? text.length : nextTick;
	}
	return result;
}

/**
 * Hold a trailing sentence break, a dangling `\`, or a lone capital after
 * punct until the next chunk decides smash vs identifier vs markdown.
 * push()+flush() equals unsquashSentences of the raw text.
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
		const trailing = text.match(/[.!?…。！？](?:\\r\\n|\\n|\\r|\r\n|[\n\r\u2028])+$/u);
		if (trailing) {
			return text.length - trailing[0].length + 1;
		}
		const dangling = text.match(/[.!?…。！？]["“”«»‘’']?\p{Lu}$/u);
		if (dangling) {
			return text.length - dangling[0].length + 1;
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
