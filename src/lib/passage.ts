/**
 * Passage text for messages that contain typeset math. A native selection over
 * KaTeX reads out its hidden MathML and its glyph spans one token per line
 * ("𝑎\n𝑥\n2\n+…ax \n2\n +bx"), which is what the model, the excerpt and the
 * bookmark would get, and which can never be found again in the DOM. Here each
 * formula reads as its TeX source instead ("$ax^2+bx$"), and the same reading
 * is used to find a quote again, so the two always agree.
 */

export type Piece =
	| { kind: "text"; node: Text; text: string }
	| { kind: "math"; el: Element; text: string }
	| { kind: "break"; text: "\n" };

const BLOCK = new Set(["DIV", "P","LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "BR"]);

/** The message read in order, one piece per text node, formula or line break. */
export function piecesOf(root: Element): Piece[] {
	const pieces: Piece[] = [];
	const lineBreak = () => {
		if (pieces.length > 0 && pieces[pieces.length - 1].kind !== "break") {
			pieces.push({ kind: "break", text: "\n" });
		}
	};
	const visit = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? "";
			if (text) {
				pieces.push({ kind: "text", node: node as Text, text });
			}
			return;
		}
		if (!(node instanceof Element)) {
			return;
		}
		if (node.classList.contains("katex")) {
			const display = node.parentElement?.classList.contains("katex-display") ?? false;
			const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? "";
			if (display) {
				lineBreak();
			}
			pieces.push({ kind: "math", el: node, text: display ? `$$${tex}$$` : `$${tex}$` });
			if (display) {
				lineBreak();
			}
			return;
		}
		const block = BLOCK.has(node.tagName);
		if (block) {
			lineBreak();
		}
		node.childNodes.forEach(visit);
		if (block) {
			lineBreak();
		}
	};
	root.childNodes.forEach(visit);
	return pieces;
}

/** The selected part of `pieces`: text clipped to the range, formulas whole. */
export function selectedText(
	pieces: Piece[],
	includes: (piece: Exclude<Piece, { kind: "break" }>) => boolean,
	clip: (piece: Extract<Piece, { kind: "text" }>) => [number, number],
): string {
	let out = "";
	for (const piece of pieces) {
		if (piece.kind === "break") {
			out += out && !out.endsWith("\n") ? "\n" : "";
		} else if (includes(piece)) {
			if (piece.kind === "text") {
				const [start, end] = clip(piece);
				out += piece.text.slice(start, end);
			} else {
				out += piece.text;
			}
		}
	}
	// react-markdown leaves "\n" text nodes between blocks; one break is enough.
	return out.replace(/\s*\n\s*/g, "\n").trim();
}

export type Bound = { piece: number; offset: number };

/**
 * Where `quote` starts and ends within the pieces, if it occurs. Offsets are
 * into a piece's text; whitespace around line breaks is loose, since that is
 * all `selectedText` normalizes. A trimmed quote never starts or ends on a
 * break, so both bounds land in text or math.
 */
export function locate(pieces: Piece[], quote: string): { start: Bound; end: Bound } | null {
	const escaped = quote
		.trim()
		.split(/\s*\n\s*/)
		.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("\\s*\\n\\s*");
	if (!escaped) {
		return null;
	}
	const starts: number[] = [];
	let text = "";
	for (const piece of pieces) {
		starts.push(text.length);
		text += piece.text;
	}
	const match = new RegExp(escaped).exec(text);
	if (!match) {
		return null;
	}
	const at = (index: number, isEnd: boolean): Bound => {
		for (let i = 0; i < pieces.length; i++) {
			const end = starts[i] + pieces[i].text.length;
			if (isEnd ? index <= end : index < end) {
				return { piece: i, offset: index - starts[i] };
			}
		}
		return { piece: pieces.length - 1, offset: pieces[pieces.length - 1].text.length };
	};
	return { start: at(match.index, false), end: at(match.index + match[0].length, true) };
}

/** True when the range touches typeset math, so the native text would be garbled. */
export function touchesMath(range: Range, message: Element): boolean {
	return [...message.querySelectorAll(".katex")].some((el) => range.intersectsNode(el));
}

/** The quote for a selection inside `message`, with formulas as TeX. */
export function passageText(range: Range, message: Element): string {
	return selectedText(
		piecesOf(message),
		(piece) => range.intersectsNode(piece.kind === "text" ? piece.node : piece.el),
		(piece) => [
			piece.node === range.startContainer ? range.startOffset : 0,
			piece.node === range.endContainer ? range.endOffset : piece.text.length,
		],
	);
}

/** A range over `quote` in a message with formulas, reading them as TeX. */
export function findPassage(message: Element, quote: string): Range | null {
	const pieces = piecesOf(message);
	const found = locate(pieces, quote);
	if (!found) {
		return null;
	}
	const range = document.createRange();
	const bound = ({ piece, offset }: Bound, isEnd: boolean) => {
		const p = pieces[piece];
		if (p.kind === "text") {
			(isEnd ? range.setEnd : range.setStart).call(range, p.node, offset);
		} else if (p.kind === "math") {
			// A formula is atomic: cover all of it.
			(isEnd ? range.setEndAfter : range.setStartBefore).call(range, p.el);
		}
	};
	bound(found.start, false);
	bound(found.end, true);
	return range;
}

/**
 * Cmd+C over typeset math copies glyphs and hidden MathML the same way a
 * selection reads them. When the selection touches a formula, put the
 * passage with TeX on the clipboard instead; anything else copies natively.
 */
export function copyWithTex(event: ClipboardEvent): void {
	const selection = document.getSelection();
	if (!event.clipboardData || !selection || selection.isCollapsed || selection.rangeCount === 0) {
		return;
	}
	const range = selection.getRangeAt(0);
	const common = range.commonAncestorContainer;
	const root = common instanceof Element ? common : common.parentElement;
	if (!root) {
		return;
	}
	// A selection wholly inside one formula has that formula as its root.
	const formula = root.closest(".katex");
	const scope = formula?.parentElement ?? root;
	if (!formula && !touchesMath(range, scope)) {
		return;
	}
	const text = passageText(range, scope);
	if (!text) {
		return;
	}
	event.clipboardData.setData("text/plain", text);
	event.preventDefault();
}
