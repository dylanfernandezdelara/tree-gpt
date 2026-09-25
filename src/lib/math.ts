/**
 * Rewrites model LaTeX into the delimiters remark-math understands, before
 * markdown parsing. Models mix `\(…\)` / `\[…\]` (which CommonMark would read
 * as escaped brackets) with `$…$` / `$$…$$`, write one-line `$$…$$` blocks
 * that remark-math would set inline, and use bare `$5` for money. Pasted
 * `\begin{align}…\end{align}` blocks get the `$$` they lack. Code blocks and
 * code spans are left untouched.
 */
export function normalizeMath(markdown: string): string {
	if (!/[$\\]/.test(markdown)) {
		return markdown;
	}
	return splitCode(markdown)
		.map((part) => (part.code ? part.text : normalizeText(part.text)))
		.join("");
}

type Part = { code: boolean; text: string };

/**
 * The text cut into prose and code (fenced blocks, code spans, and the
 * newlines between blocks), so math is only ever looked for in prose.
 * Joining the parts gives back the input.
 */
function splitCode(markdown: string): Part[] {
	const blocks: Part[] = [];
	let fence: string | null = null;
	let prose: string[] = [];
	const flush = () => {
		if (prose.length > 0) {
			blocks.push({ code: false, text: prose.join("\n") });
			prose = [];
		}
	};
	for (const line of markdown.split("\n")) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			blocks.push({ code: true, text: line });
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
				fence = null;
			}
		} else if (marker) {
			flush();
			fence = marker;
			blocks.push({ code: true, text: line });
		} else {
			prose.push(line);
		}
	}
	flush();
	return blocks.flatMap((block, i) => [
		...(i > 0 ? [{ code: true, text: "\n" }] : []),
		...(block.code
			? [block]
			: block.text.split(/(`+[^`]*?`+)/).map((text, j) => ({ code: j % 2 === 1, text }))),
	]);
}

function normalizeText(text: string): string {
	return (
		escapeLoneDollars(text)
			// `\[ … \]` on its own lines → a `$$` display block.
			.replace(/^([ \t]*)\\\[[ \t]*\n([\s\S]*?)\n[ \t]*\\\][ \t]*$/gm, "$1$$$$\n$2\n$1$$$$")
			// A whole line of `\[…\]` or `$$…$$` → a display block, not inline math.
			.replace(
				/^([ \t]*)(?:\\\[(.+?)\\\]|\$\$(.+?)\$\$)[ \t]*$/gm,
				(_, indent: string, a?: string, b?: string) =>
					`${indent}$$\n${indent}${(a ?? b ?? "").trim()}\n${indent}$$`,
			)
			// Anything left mid-sentence.
			.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => `$$${tex}$$`)
			.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => `$${tex.trim()}$`)
			.replace(BARE_ENVIRONMENT, (block: string, indent: string, _name: string, offset: number, all: string) =>
				// Already inside a `$$` block: leave it to that block.
				(all.slice(0, offset).match(/\$\$/g)?.length ?? 0) % 2 === 1
					? block
					: `${indent}$$\n${block.replace(/\\label\{[^}]*\}/g, "")}\n${indent}$$`,
			)
	);
}

/**
 * A display environment pasted or written with no `$$` around it, from its
 * own `\begin{…}` line to the matching `\end{…}` line. Only environments
 * KaTeX can set; `multline`, `eqnarray` and friends stay text rather than
 * turning into a red error. `\label` is dropped, since KaTeX has no refs.
 */
const BARE_ENVIRONMENT =
	/^([ \t]*)\\begin\{((?:equation|align|alignat|gather|aligned|gathered|split|cases|[pbvBV]?matrix|array|CD)\*?)\}[\s\S]*?\\end\{\2\}[ \t]*$/gm;

/**
 * Pandoc's rule for single-dollar math, so money stays text: `$` opens only
 * before a non-space, and closes only after a non-space and not before a
 * digit ("$5 and $10" has no closer). Unpaired `$` are escaped; `$$` passes.
 */
function escapeLoneDollars(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			out += text.slice(i, i + 2);
			i += 2;
		} else if (ch !== "$") {
			out += ch;
			i += 1;
		} else if (text[i + 1] === "$") {
			out += "$$";
			i += 2;
		} else {
			const close = closingDollar(text, i);
			if (close < 0) {
				out += "\\$";
				i += 1;
			} else {
				out += text.slice(i, close + 1);
				i = close + 1;
			}
		}
	}
	return out;
}

function closingDollar(text: string, open: number): number {
	if (!/\S/.test(text[open + 1] ?? " ")) {
		return -1;
	}
	for (let j = open + 1; j < text.length; j++) {
		const ch = text[j];
		if (ch === "\\") {
			j += 1;
		} else if (ch === "\n" && text[j + 1] === "\n") {
			return -1;
		} else if (ch === "$") {
			if (text[j + 1] === "$") {
				return -1;
			}
			if (/\S/.test(text[j - 1]) && !/\d/.test(text[j + 1] ?? "")) {
				return j;
			}
		}
	}
	return -1;
}

export type MathSegment =
	| { kind: "text"; text: string }
	| { kind: "math"; tex: string; display: boolean };

/**
 * Plain text cut into literal text and math, for places that show text as
 * typed (user bubbles, quotes) rather than as markdown. Same rules as
 * `normalizeMath`: `$…$` by Pandoc's rule, `$$…$$`, `\(…\)`, `\[…\]` and bare
 * display environments are math; code and everything else stay verbatim.
 */
export function splitMath(text: string): MathSegment[] {
	if (!/[$\\]/.test(text)) {
		return [{ kind: "text", text }];
	}
	const segments: MathSegment[] = [];
	const addText = (value: string) => {
		const last = segments[segments.length - 1];
		if (last?.kind === "text") {
			last.text += value;
		} else if (value) {
			segments.push({ kind: "text", text: value });
		}
	};
	const addMath = (tex: string, display: boolean) => {
		const last = segments[segments.length - 1];
		if (display && last?.kind === "text") {
			// A display block is its own line; drop the break that led to it.
			last.text = last.text.replace(/[ \t]*\n[ \t]*$/, "");
		}
		segments.push({ kind: "math", tex: tex.trim(), display });
	};
	for (const part of splitCode(text)) {
		if (part.code) {
			addText(part.text);
		} else {
			scanMath(part.text, addText, addMath);
		}
	}
	// Likewise the break that followed a display block.
	for (let i = 1; i < segments.length; i++) {
		const prev = segments[i - 1];
		const seg = segments[i];
		if (prev.kind === "math" && prev.display && seg.kind === "text") {
			seg.text = seg.text.replace(/^[ \t]*\n/, "");
		}
	}
	return segments.filter((seg) => seg.kind === "math" || seg.text);
}

function scanMath(
	text: string,
	addText: (value: string) => void,
	addMath: (tex: string, display: boolean) => void,
): void {
	const environment = new RegExp(BARE_ENVIRONMENT.source, "my");
	let i = 0;
	let plain = "";
	const flush = () => {
		addText(plain);
		plain = "";
	};
	const enclosed = (open: string, close: string, display: boolean): boolean => {
		if (!text.startsWith(open, i)) {
			return false;
		}
		const end = text.indexOf(close, i + open.length);
		const tex = end < 0 ? "" : text.slice(i + open.length, end);
		if (!tex.trim()) {
			return false;
		}
		flush();
		addMath(tex, display);
		i = end + close.length;
		return true;
	};
	while (i < text.length) {
		if (text.startsWith("\\begin{", i)) {
			const lineStart = text.lastIndexOf("\n", i - 1) + 1;
			environment.lastIndex = lineStart;
			const match = /^[ \t]*$/.test(text.slice(lineStart, i)) ? environment.exec(text) : null;
			if (match) {
				plain = plain.slice(0, plain.length - (i - lineStart));
				flush();
				addMath(match[0].replace(/\\label\{[^}]*\}/g, ""), true);
				i = lineStart + match[0].length;
				continue;
			}
		}
		if (enclosed("$$", "$$", true) || enclosed("\\[", "\\]", true) || enclosed("\\(", "\\)", false)) {
			continue;
		}
		const ch = text[i];
		if (ch === "\\" || (ch === "$" && text[i + 1] === "$")) {
			// An escape, or a `$$` with no closer: literal, and never an opener.
			plain += text.slice(i, i + 2);
			i += 2;
		} else if (ch === "$") {
			const close = closingDollar(text, i);
			if (close < 0) {
				plain += ch;
				i += 1;
			} else {
				flush();
				addMath(text.slice(i + 1, close), false);
				i = close + 1;
			}
		} else {
			plain += ch;
			i += 1;
		}
	}
	flush();
}
