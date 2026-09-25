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
	const out: string[] = [];
	let fence: string | null = null;
	let prose: string[] = [];
	const flush = () => {
		if (prose.length > 0) {
			out.push(normalizeProse(prose.join("\n")));
			prose = [];
		}
	};
	for (const line of markdown.split("\n")) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			out.push(line);
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
				fence = null;
			}
		} else if (marker) {
			flush();
			fence = marker;
			out.push(line);
		} else {
			prose.push(line);
		}
	}
	flush();
	return out.join("\n");
}

/** Fence-free text: transform around inline code spans. */
function normalizeProse(text: string): string {
	return text
		.split(/(`+[^`]*?`+)/)
		.map((part, i) => (i % 2 === 1 ? part : normalizeText(part)))
		.join("");
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
