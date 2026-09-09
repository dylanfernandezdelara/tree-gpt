/**
 * OpenRouter often joins the next sentence without a gap: smash
 * (`games.Tomorrow`), a single newline (`games.\nTomorrow`), or a literal
 * two-character `\n`. remark-breaks then paints `<br>`, so the period
 * looks glued to the next word.
 *
 * Earlier repairs listed specific word shapes and kept missing the next
 * one. This walks prose (not fenced/inline code) and inserts a space when
 * sentence punct meets a sentence start with no real gap — any language
 * that uses uppercase, any quote, any of `.?!…。！？`.
 */

const SENTENCE_PUNCT = /[.!?…。！？]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const OPEN_QUOTE = /["“”«»‘’']/;
const CODE_SPLIT = /(```[\s\S]*?```|`[^`]+`)/g;
const LITERAL_NL = /\\r\\n|\\n|\\r/g;

function isLineBreak(ch: string | undefined): boolean {
	return ch === "\n" || ch === "\r" || ch === "\u2028";
}

function isParagraphBreak(ch: string | undefined): boolean {
	return ch === "\u2029";
}

function unescapeLiteralNewlines(text: string): string {
	return text.replace(LITERAL_NL, "\n");
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

/** `#`, `- `, `1. ` after a newline — keep the break for markdown. */
function isMarkdownBlockStart(rest: string): boolean {
	return /^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\||```)/u.test(rest);
}

/**
 * Next token reads as a new sentence, not `ID`, `Bar()`, or `OpenAI.com`.
 * Opening quotes are skipped so `said."The` counts.
 */
function looksLikeSentenceStart(rest: string): boolean {
	let i = 0;
	while (i < rest.length && OPEN_QUOTE.test(rest[i] ?? "")) {
		i += 1;
	}
	const start = rest.slice(i);
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
		return trail !== "(" && trail !== "." && trail !== "@";
	}
	// Single-letter sentence (`I `, `A `, `O `) — not `ID` / `Ph.D`.
	return /[IAO]/u.test(first) && (next === "" || /\s/u.test(next));
}

function isIdentifierOrUrl(rest: string): boolean {
	if (/^[\p{L}\p{N}_$]*\(/u.test(rest)) {
		return true;
	}
	if (/^\p{Lu}{2}/u.test(rest)) {
		return true;
	}
	if (rest.includes("@")) {
		return true;
	}
	return /^[\p{L}\p{N}]*\./u.test(rest);
}

function readBreak(text: string, index: number): { length: number; paragraph: boolean } | null {
	const ch = text[index];
	if (isParagraphBreak(ch)) {
		return { length: 1, paragraph: true };
	}
	if (text.startsWith("\r\n", index)) {
		const next = text[index + 2];
		return { length: 2, paragraph: isLineBreak(next) || isParagraphBreak(next) };
	}
	if (isLineBreak(ch)) {
		const next = text[index + 1];
		return { length: 1, paragraph: isLineBreak(next) || isParagraphBreak(next) };
	}
	return null;
}

function repairProse(text: string): string {
	const src = unescapeLiteralNewlines(text);
	let out = "";
	let i = 0;
	while (i < src.length) {
		const ch = src[i] ?? "";
		out += ch;
		i += 1;
		if (!SENTENCE_PUNCT.test(ch)) {
			continue;
		}
		if (ch === ".") {
			while (src[i] === ".") {
				out += ".";
				i += 1;
			}
		}
		if (!looksLikeSentenceEnd(out)) {
			continue;
		}
		const brk = readBreak(src, i);
		if (brk?.paragraph) {
			continue;
		}
		const rest = src.slice(i + (brk?.length ?? 0));
		if (isMarkdownBlockStart(rest) || !looksLikeSentenceStart(rest) || isIdentifierOrUrl(rest)) {
			continue;
		}
		if (brk) {
			i += brk.length;
		}
		out += " ";
	}
	return out;
}

export function unsquashSentences(text: string): string {
	return text
		.split(CODE_SPLIT)
		.map((segment, index) => (index % 2 === 1 ? segment : repairProse(segment)))
		.join("");
}

/**
 * Hold a trailing sentence break (and a dangling `\`) until the next chunk
 * says smash vs paragraph vs markdown. push()+flush() equals
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
		const trailing = text.match(/[.!?…。！？](?:\r\n|[\n\r\u2028])+$/u);
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
